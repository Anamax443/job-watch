import type { Env, JobPosting } from './types';
import { loadSettings } from './config';
import { resolveEnv } from './secrets';
import { fetchMpsv } from './sources/mpsv';
import { fetchAts } from './sources/ats';
import { fetchWeb } from './sources/web';
import { fetchJobsCz } from './sources/jobscz';
import { fetchPraceCz } from './sources/pracecz';
import { loadAgencyIcos, applyAgencyFlag } from './sources/agencies';
import { prefilter } from './prefilter';
import { scoreJob } from './score';
import { enrichOriginator } from './enrich';
import { discoverSources, type SourceCandidate } from './discover';
import { notify } from './notify';
import {
  contentHash,
  fingerprintHash,
  dedupKey,
  loadExisting,
  touchSeen,
  findDuplicate,
  saveJob,
  setNotified,
  bumpSeen,
  loadUnscored,
  updateScore,
} from './store';

export interface RunStats {
  fetched: number;
  candidates: number;
  scored: number;
  enriched: number;
  notified: number;
  discovered: number;
}

// Záznam běhu do D1 (tabulka runs) → dashboard pak ukáže ŽIVĚ, co agent dělá.
class RunLog {
  private lines: string[] = [];
  private id: number | null = null;
  constructor(private env: Env, private trigger: string) {}

  async start(): Promise<void> {
    const res = await this.env.DB.prepare(
      "INSERT INTO runs (started_at, trigger, ok) VALUES (datetime('now'), ?, 0)",
    )
      .bind(this.trigger)
      .run();
    this.id = (res.meta?.last_row_id as number) ?? null;
    this.log(`▶ Start běhu (${this.trigger})`);
  }

  log(msg: string): void {
    this.lines.push(msg);
    console.log(msg);
  }

  async flush(stats: RunStats, finished = false): Promise<void> {
    if (this.id == null) return;
    try {
      await this.env.DB.prepare(
        `UPDATE runs SET log = ?1, stats = ?2, ok = ?3,
           finished_at = CASE WHEN ?4 = 1 THEN datetime('now') ELSE finished_at END
         WHERE id = ?5`,
      )
        .bind(this.lines.join('\n'), JSON.stringify(stats), finished ? 1 : 0, finished ? 1 : 0, this.id)
        .run();
    } catch (e) {
      console.warn('RunLog flush:', e);
    }
  }
}

// Časový limit na zdroj — zaručí, že běh se vždy dokončí (Worker má limit).
function timed<T>(label: string, p: Promise<T>, ms: number, fallback: T, run: RunLog): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const to = new Promise<T>((res) => {
    timer = setTimeout(() => {
      run.log(`⏱️ ${label}: vypršel limit ${Math.round(ms / 1000)} s — přeskakuji`);
      res(fallback);
    }, ms);
  });
  return Promise.race([p, to]).finally(() => clearTimeout(timer));
}

export async function runPipeline(env: Env, trigger: 'cron' | 'manual' = 'manual'): Promise<RunStats> {
  env = await resolveEnv(env); // klíče přednostně z D1 (UI), jinak Worker secrets
  const settings = await loadSettings(env);
  const stats: RunStats = {
    fetched: 0,
    candidates: 0,
    scored: 0,
    enriched: 0,
    notified: 0,
    discovered: 0,
  };
  const run = new RunLog(env, trigger);
  await run.start();

  try {
    // 1) fetch — MPSV + ATS z D1 + OTEVŘENÉ hledání napříč webem.
    //    Každý zdroj má limit a loguje se hned jak doběhne → běh se vždy dokončí.
    run.log('🔎 Spouštím zdroje: MPSV (celá ČR), ATS firem, celý web…');
    await run.flush(stats);
    const mpsvP = timed('MPSV', fetchMpsv(env).catch((e) => { run.log(`⚠️ MPSV: ${e}`); return [] as JobPosting[]; }), 20000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 MPSV: ${r.length}`); await run.flush(stats); return r; });
    const atsP = timed('ATS', fetchAts(env).catch((e) => { run.log(`⚠️ ATS: ${e}`); return [] as JobPosting[]; }), 20000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 ATS: ${r.length}`); await run.flush(stats); return r; });
    const webP = timed('Web', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchWeb(env, settings)).catch((e) => { run.log(`⚠️ Web: ${e}`); return [] as JobPosting[]; }), 25000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 Web (Adzuna): ${r.length}`); await run.flush(stats); return r; });
    // jobs.cz (LMC) — konkrétní inzeráty z listovky; Adzuna ho v ČR neindexuje.
    // Deterministický fetch (bez LLM) → rychlý, fit do rozpočtu běhu (waitUntil).
    const jobsczP = timed('jobs.cz', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchJobsCz(env, settings)).catch((e) => { run.log(`⚠️ jobs.cz: ${e}`); return [] as JobPosting[]; }), 12000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 jobs.cz: ${r.length}`); await run.flush(stats); return r; });
    // prace.cz (LMC) — volné hledání → projde prefilterem (šum se odřízne), dedup řeší překryv s jobs.cz.
    const pracesczP = timed('prace.cz', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchPraceCz(env, settings)).catch((e) => { run.log(`⚠️ prace.cz: ${e}`); return [] as JobPosting[]; }), 12000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 prace.cz: ${r.length}`); await run.flush(stats); return r; });
    const [mpsv, ats, web, jobscz, pracecz] = await Promise.all([mpsvP, atsP, webP, jobsczP, pracesczP]);
    const jobs = [...mpsv, ...ats, ...web, ...jobscz, ...pracecz];
    stats.fetched = jobs.length;
    run.log(`✔ Zdroje hotové → celkem ${jobs.length}`);
    // Strop na zpracování (scoring/notify/backlog) — počítá se až teď, aby ho delší
    // fetch (web_search) neukrojil. Drženo nízko, protože manuální běh jede přes
    // ctx.waitUntil s omezeným rozpočtem (delší celkový čas zabíjel celý běh).
    const deadline = Date.now() + 16000;

    // 2) klasifikace agentur
    const icoSet = await loadAgencyIcos(env);
    applyAgencyFlag(jobs, icoSet);
    run.log(`🏷️ Agentur označeno: ${jobs.filter((j) => j.isAgency).length}`);

    // 3) prefilter
    const candidates = prefilter(jobs, settings);
    stats.candidates = candidates.length;
    run.log(`🧹 Po prefilteru: ${candidates.length} kandidátů (práh skóre ${settings.notifyThreshold})`);
    await run.flush(stats);

    // 4) zpracování — v PARALELNÍCH dávkách (sekvenčně stihlo jen ~11/běh a běh
    //    se nestihl dokončit). Každý kandidát je nezávislý; deadline mezi dávkami.
    const companyCandidates: SourceCandidate[] = [];
    const BATCH = 6;
    const processJob = async (job: JobPosting): Promise<void> => {
      const id = job.id;
      const hash = await contentHash(job);
      const fp = await fingerprintHash(job);
      const existing = await loadExisting(env, id);
      // Přeskoč jen když je beze změny A UŽ OHODNOCENÝ. Vynulované skóre (relevance
      // NULL po resetu) se musí přeskórovat, i když se obsah inzerátu nezměnil.
      if (existing && existing.hash === hash && existing.relevance != null) {
        await touchSeen(env, id);
        return;
      }

      const score = await scoreJob(env, job, settings.profile, {
        region: settings.regionPriority,
        threshold: settings.notifyThreshold,
      });
      stats.scored++;
      const relevant = score.relevance >= settings.notifyThreshold;

      const enrich = job.isAgency && relevant ? await enrichOriginator(env, job) : null;
      if (enrich) {
        stats.enriched++;
        if (enrich.realEmployer) {
          companyCandidates.push({ name: enrich.realEmployer, kind: 'company' });
          run.log(`  🎯 ${job.employer} → původce: ${enrich.realEmployer}`);
        }
      }

      const dk = dedupKey(job);
      const dup = await findDuplicate(env, dk, fp, id);
      const duplicateOf = dup?.id ?? null;
      await saveJob(env, { job, hash, dedupKey: dk, fingerprint: fp, score, enrich, duplicateOf });
      if (duplicateOf) {
        await bumpSeen(env, duplicateOf);
        run.log(`  ↻ opakuje se: ${job.title} — ${job.employer}`);
      }

      if (relevant && !duplicateOf && !existing?.notified_at) {
        const r = await notify(env, settings, {
          ...job,
          relevance: score.relevance,
          reason: score.reason,
          realEmployer: enrich?.realEmployer,
          realEmployerUrl: enrich?.realEmployerUrl,
        });
        if (r.telegram || r.email || r.slack) {
          await setNotified(env, id);
          stats.notified++;
          run.log(`  🔔 ${score.relevance} | ${job.title} — ${job.employer}`);
        }
      }
    };
    for (let b = 0; b < candidates.length; b += BATCH) {
      if (Date.now() > deadline) {
        run.log(`⏱️ Časový limit běhu — zpracováno ${stats.scored}, zbytek doženu příště.`);
        break;
      }
      await Promise.all(
        candidates.slice(b, b + BATCH).map((job) =>
          processJob(job).catch((e) => run.log(`⚠️ ${job.id}: ${e}`)),
        ),
      );
      await run.flush(stats);
    }
    run.log(`🧠 Ohodnoceno ${stats.scored} · deanonymizováno ${stats.enriched} · notifikováno ${stats.notified}`);
    await run.flush(stats);

    // 5) dynamický screening zdrojů — pro nově viděné agentury + odhalené firmy
    const agencyCandidates: SourceCandidate[] = [];
    const seenAg = new Set<string>();
    for (const j of jobs) {
      if (!j.isAgency || !j.employer) continue;
      const key = (j.employerIco || j.employer).toLowerCase();
      if (seenAg.has(key)) continue;
      seenAg.add(key);
      agencyCandidates.push({ name: j.employer, ico: j.employerIco, kind: 'agency' });
    }
    // Discovery jede přes LLM web_search (pomalé) → jen když zbývá čas v rozpočtu,
    // jinak by ujelo přes limit a zabilo běh před dokončením (finished_at zůstalo null).
    const limit = parseInt(env.MAX_DISCOVERY_PER_RUN ?? '5', 10) || 5;
    const toDiscover = [...agencyCandidates, ...companyCandidates];
    if (Date.now() >= deadline) {
      if (toDiscover.length) run.log('🌐 Screening zdrojů přeskočen (došel čas) — příště.');
    } else {
      if (toDiscover.length) run.log(`🌐 Screening nových zdrojů (max ${limit})…`);
      stats.discovered = await discoverSources(env, toDiscover, limit);
      if (stats.discovered) run.log(`💾 Nové zdroje uložené: ${stats.discovered}`);
    }

    // 6) doskórování fronty (seedované/nezhodnocené) — v rámci času, bez notifikací
    let backlog = 0;
    while (Date.now() < deadline) {
      const batch = await loadUnscored(env, 6);
      if (!batch.length) break;
      await Promise.all(
        batch.map(async (job) => {
          try {
            const sc = await scoreJob(env, job, settings.profile, {
              region: settings.regionPriority,
              threshold: settings.notifyThreshold,
            });
            await updateScore(env, job.id, sc);
          } catch (e) {
            run.log(`⚠️ skóre ${job.id}: ${e}`);
          }
        }),
      );
      backlog += batch.length;
      if (backlog % 18 === 0) await run.flush(stats);
    }
    if (backlog) {
      stats.scored += backlog;
      run.log(`📊 Doskórováno z fronty: ${backlog} (zbytek příště)`);
    }

    run.log(`✅ Hotovo — ${JSON.stringify(stats)}`);
    await run.flush(stats, true);
  } catch (e: any) {
    run.log(`❌ Chyba: ${e?.message ?? e}`);
    await run.flush(stats, true);
    throw e;
  }

  return stats;
}
