import type { Env, JobPosting } from './types';
import { loadSettings } from './config';
import { fetchMpsv } from './sources/mpsv';
import { fetchAts } from './sources/ats';
import { fetchWeb } from './sources/web';
import { loadAgencyIcos, applyAgencyFlag } from './sources/agencies';
import { prefilter } from './prefilter';
import { scoreJob } from './score';
import { enrichOriginator } from './enrich';
import { discoverSources, type SourceCandidate } from './discover';
import { notify } from './notify';
import {
  contentHash,
  dedupKey,
  loadExisting,
  touchSeen,
  findDuplicate,
  saveJob,
  setNotified,
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

export async function runPipeline(env: Env, trigger: 'cron' | 'manual' = 'manual'): Promise<RunStats> {
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
    // 1) fetch — MPSV (celý trh) + ATS z D1 + OTEVŘENÉ hledání napříč webem
    run.log('🔎 Hledám ve zdrojích: MPSV (celá ČR), ATS firem, celý web…');
    await run.flush(stats);
    const [mpsv, ats, web] = await Promise.all([
      fetchMpsv(env).catch((e) => {
        run.log(`⚠️ MPSV: ${e}`);
        return [] as JobPosting[];
      }),
      fetchAts(env).catch((e) => {
        run.log(`⚠️ ATS: ${e}`);
        return [] as JobPosting[];
      }),
      (env.WEB_SEARCH === 'false'
        ? Promise.resolve([] as JobPosting[])
        : fetchWeb(env, settings)
      ).catch((e) => {
        run.log(`⚠️ Web: ${e}`);
        return [] as JobPosting[];
      }),
    ]);
    const jobs = [...mpsv, ...ats, ...web];
    stats.fetched = jobs.length;
    run.log(`📥 Staženo: MPSV ${mpsv.length} · ATS ${ats.length} · web ${web.length} → celkem ${jobs.length}`);

    // 2) klasifikace agentur
    const icoSet = await loadAgencyIcos(env);
    applyAgencyFlag(jobs, icoSet);
    run.log(`🏷️ Agentur označeno: ${jobs.filter((j) => j.isAgency).length}`);

    // 3) prefilter
    const candidates = prefilter(jobs, settings);
    stats.candidates = candidates.length;
    run.log(`🧹 Po prefilteru: ${candidates.length} kandidátů (práh skóre ${settings.notifyThreshold})`);
    await run.flush(stats);

    // 4) zpracování
    const companyCandidates: SourceCandidate[] = [];
    let i = 0;
    for (const job of candidates) {
      const id = job.id;
      const hash = await contentHash(job);
      const existing = await loadExisting(env, id);
      if (existing && existing.hash === hash) {
        await touchSeen(env, id);
        continue;
      }

      const score = await scoreJob(env, job);
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
      const dup = await findDuplicate(env, dk, id);
      const duplicateOf = dup?.id ?? null;
      await saveJob(env, { job, hash, dedupKey: dk, score, enrich, duplicateOf });

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
      if (++i % 5 === 0) await run.flush(stats);
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
    const limit = parseInt(env.MAX_DISCOVERY_PER_RUN ?? '5', 10) || 5;
    const toDiscover = [...agencyCandidates, ...companyCandidates];
    if (toDiscover.length) run.log(`🌐 Screening nových zdrojů (max ${limit})…`);
    stats.discovered = await discoverSources(env, toDiscover, limit);
    if (stats.discovered) run.log(`💾 Nové zdroje uložené: ${stats.discovered}`);

    run.log(`✅ Hotovo — ${JSON.stringify(stats)}`);
    await run.flush(stats, true);
  } catch (e: any) {
    run.log(`❌ Chyba: ${e?.message ?? e}`);
    await run.flush(stats, true);
    throw e;
  }

  return stats;
}
