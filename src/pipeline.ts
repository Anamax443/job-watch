import type { Env, JobPosting, ScoreResult } from './types.ts';
import { loadSettings } from './config.ts';
import { resolveEnv } from './secrets.ts';
import { fetchMpsv } from './sources/mpsv.ts';
import { fetchAts } from './sources/ats.ts';
import { fetchWeb } from './sources/web.ts';
import { fetchJobsCz } from './sources/jobscz.ts';
import { fetchPraceCz } from './sources/pracecz.ts';
import { loadAgencyIcos, applyAgencyFlag } from './sources/agencies.ts';
import { prefilter, roleMatch, regionRejected } from './prefilter.ts';
import { clearStop, stopRequested, bulkUpdateScores } from './store.ts';
import { PROMPT_VERSION } from './prompts.ts';
import { createCounter, wrapDb, formatBudget, type RunBudget } from './metrics.ts';
import { sendTelegram, AI_DISCLOSURE } from './notify.ts';
import { scoreJob } from './score.ts';
import { enrichOriginator } from './enrich.ts';
import { discoverSources, type SourceCandidate } from './discover.ts';
import { effectiveProvider, providerChain, providerLabel, webResearchEnabled } from './ai.ts';
import { recheckLiveness, isCheckableUrl } from './liveness.ts';
import { notify } from './notify.ts';
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
  loadScoredAbove,
  updateRelevance,
  parkJobs,
  countUnscored,
  markDuplicate,
} from './store.ts';
import { applyRegionGate, checkRegion } from './region.ts';

export interface RunStats {
  fetched: number;
  candidates: number;
  scored: number;
  enriched: number;
  notified: number;
  discovered: number;
  livenessGone?: number; // kolik inzerátů se v tomto běhu ověřilo jako zrušené (404)
  budget?: RunBudget & { celkem: number }; // spotřeba podřízených požadavků Workeru (viz src/metrics.ts)
  promptVersion?: string; // podle jakého znění promptu se v tomhle běhu skórovalo (F4)
  prefiltered?: number; // kolik jich z fronty vyřadil kód (mimo obor/kraj) bez jediného dotazu na AI
  // Kolik kandidátů z tohoto stažení ještě NENÍ ohodnoceno (nedojely kvůli časovému stropu).
  // UI podle toho spouští další dávky, dokud není 0 (viz index.js — „doskórování").
  candidatesPending?: number;
  queued?: number; // kolik kandidátů se uložilo do fronty (dřív se zahazovali)
  queueDepth?: number; // kolik inzerátů celkem čeká ve frontě na skóre
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

export async function runPipeline(
  env: Env,
  trigger: 'cron' | 'manual' | 'telegram' = 'manual',
): Promise<RunStats> {
  const runStart = Date.now(); // pro absolutní strop celého běhu (viz deadline níže)
  env = await resolveEnv(env); // klíče přednostně z D1 (UI), jinak Worker secrets
  const settings = await loadSettings(env);
  // Měřák rozpočtu: od téhle chvíle jde každé volání D1 přes počítadlo. Obaluje se až tady,
  // aby se do čísla nepočítalo načtení nastavení, které proběhne i mimo běh.
  const budget = createCounter();
  env = { ...env, DB: wrapDb(env.DB, budget) } as Env;
  // Starý požadavek na zastavení nesmí zabít ten příští běh.
  await clearStop(env);
  let stopped = false;
  const stats: RunStats = {
    promptVersion: PROMPT_VERSION,
    fetched: 0,
    candidates: 0,
    scored: 0,
    enriched: 0,
    notified: 0,
    discovered: 0,
  };
  const run = new RunLog(env, trigger);
  await run.start();

  // AI backend „dle úhrady" (viz src/ai.ts): default zdarma Workers AI, přepínatelné v Nastavení.
  // Deanonymizace + screening zdrojů umí jen placený Anthropic (web_search/web_fetch) → gate zvlášť.
  const provider = effectiveProvider(env, settings);
  const aiCtx = { provider, anthropicKey: env.ANTHROPIC_API_KEY, ai: env.AI };
  const scoreProvider = providerChain(aiCtx)[0] ?? null;
  const webResearch = webResearchEnabled(aiCtx);

  try {
    run.log(
      `🧠 AI backend (skórování): ${providerLabel(scoreProvider)}` +
        ` · deanonymizace/screening: ${webResearch ? 'Claude (web)' : 'vypnuto (běží free/off)'}`,
    );
    // 1) fetch — MPSV + ATS z D1 + OTEVŘENÉ hledání napříč webem.
    //    Každý zdroj má limit a loguje se hned jak doběhne → běh se vždy dokončí.
    run.log('🔎 Spouštím zdroje: MPSV (celá ČR), ATS firem, celý web…');
    await run.flush(stats);
    const mpsvP = timed('MPSV', fetchMpsv(env, (m) => run.log(m)).catch((e) => { run.log(`⚠️ MPSV: ${e}`); return [] as JobPosting[]; }), 20000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 MPSV: ${r.length}`); await run.flush(stats); return r; });
    const atsP = timed('ATS', fetchAts(env, (m) => run.log(m)).catch((e) => { run.log(`⚠️ ATS: ${e}`); return [] as JobPosting[]; }), 20000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 ATS: ${r.length}`); await run.flush(stats); return r; });
    const webP = timed('Web', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchWeb(env, settings, (m) => run.log(m))).catch((e) => { run.log(`⚠️ Web: ${e}`); return [] as JobPosting[]; }), 25000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 Web (Adzuna): ${r.length}`); await run.flush(stats); return r; });
    // jobs.cz (LMC) — konkrétní inzeráty z listovky; Adzuna ho v ČR neindexuje.
    // Deterministický fetch (bez LLM) → rychlý, fit do rozpočtu běhu (waitUntil).
    const jobsczP = timed('jobs.cz', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchJobsCz(env, settings, (m) => run.log(m))).catch((e) => { run.log(`⚠️ jobs.cz: ${e}`); return [] as JobPosting[]; }), 12000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 jobs.cz: ${r.length}`); await run.flush(stats); return r; });
    // prace.cz (LMC) — volné hledání → projde prefilterem (šum se odřízne), dedup řeší překryv s jobs.cz.
    const pracesczP = timed('prace.cz', (env.WEB_SEARCH === 'false' ? Promise.resolve([] as JobPosting[]) : fetchPraceCz(env, settings, (m) => run.log(m))).catch((e) => { run.log(`⚠️ prace.cz: ${e}`); return [] as JobPosting[]; }), 12000, [] as JobPosting[], run)
      .then(async (r) => { run.log(`📥 prace.cz: ${r.length}`); await run.flush(stats); return r; });
    const [mpsv, ats, web, jobscz, pracecz] = await Promise.all([mpsvP, atsP, webP, jobsczP, pracesczP]);
    const jobs = [...mpsv, ...ats, ...web, ...jobscz, ...pracecz];
    stats.fetched = jobs.length;
    run.log(`✔ Zdroje hotové → celkem ${jobs.length}`);
    // Strop na zpracování (scoring/notify/fronta) — jiný pro cron a pro ruční běh:
    //
    //  • CRON má na běh minuty. Limit Workeru 30 s je CPU čas, ne wall-clock, a čekání na
    //    HTTP/AI se do CPU nepočítá. Se starým stropem 26 s (společným pro oba spouštěče)
    //    sežral fetch zdrojů ~20 s a na skórování zbyla jedna dávka: běh ohodnotil 3 z 91
    //    kandidátů a zbytek zahodil. Proto cron dostává vlastní, mnohem větší rozpočet.
    //  • RUČNÍ běh jede přes fetch + ctx.waitUntil (kratší životnost) a UI ho stejně dávkuje
    //    ve smyčce → drží se krátce, ať se vždy stihne zapsat finished_at.
    // 120 s bylo příliš. Běh 132 (1. 9. 2026, 129 ve frontě) platforma při dojíždění
    // fronty ZABILA — bez výjimky, bez `catch`, bez `finished_at`: v tabulce zůstal viset
    // otevřený záznam a nikdo se nic nedozvěděl. Zabitý běh nezapíše nic, kdežto krátký
    // běh zapíše, co stihl, a zbytek dožene další. Víc krátkých je proto lepší než jeden
    // dlouhý, který nepřežije. Hlídač nedoběhlých běhů je v src/index.ts.
    const CRON_BUDGET_MS = 60000;
    const MANUAL_BUDGET_MS = 26000;
    // Telegram má rozpočet jako cron, ne jako ruční běh. Krátký rozpočet ručního běhu
    // dává smysl JEN proto, že ho stránka v prohlížeči volá znovu ve smyčce. Příkaz /beh
    // nikdo nesmyčkuje, takže by udělal jednu 26sekundovou porci a skončil — změřeno
    // 1. 9. 2026 během 131: z fronty 145 jich odbavil 16 a doběhl za 23 s.
    const deadline =
      trigger === 'cron' || trigger === 'telegram'
        ? runStart + CRON_BUDGET_MS
        : Math.min(Date.now() + 18000, runStart + MANUAL_BUDGET_MS);

    // 2) klasifikace agentur
    const icoSet = await loadAgencyIcos(env);
    applyAgencyFlag(jobs, icoSet);
    run.log(`🏷️ Agentur označeno: ${jobs.filter((j) => j.isAgency).length}`);

    // 3) prefilter — hrubě odřízne šum (hlavně široké hledání prace.cz) PŘED AI skórováním.
    //    Zprůhledníme, kam se poděl rozdíl staženo → kandidáti (per zdroj).
    const candidates = prefilter(jobs, settings);
    stats.candidates = candidates.length;
    const keptIds = new Set(candidates.map((j) => j.id));
    const droppedBySource = new Map<string, number>();
    for (const j of jobs) {
      if (keptIds.has(j.id)) continue;
      const src = (j.source || '?').split(':')[0];
      droppedBySource.set(src, (droppedBySource.get(src) ?? 0) + 1);
    }
    const dropped = jobs.length - candidates.length;
    const breakdown = [...droppedBySource.entries()].map(([s, n]) => `${s} ${n}`).join(', ');
    run.log(
      `🧹 Po prefilteru: ${candidates.length} kandidátů z ${jobs.length} staženo` +
        (dropped > 0 ? ` (odříznuto ${dropped} nerelevantních${breakdown ? `: ${breakdown}` : ''})` : '') +
        ` · práh skóre ${settings.notifyThreshold}`,
    );
    await run.flush(stats);

    // 4) zpracování — v PARALELNÍCH dávkách (sekvenčně stihlo jen ~11/běh a běh
    //    se nestihl dokončit). Každý kandidát je nezávislý; deadline mezi dávkami.
    // Strop počtu AI hodnocení na běh. Dokud běh stíhal jen 3 skóre, řešil to čas; s reálným
    // rozpočtem jich je ~100/den, a to už je měřitelná spotřeba (Workers AI má zdarma 10 000
    // neuronů/den). Strop drží počet volání předvídatelný — co se nevejde, zůstane ve frontě
    // a dožene ho další běh. Uplatnění stropu se VŽDY zaloguje, ať není tiché.
    const maxScores = parseInt(env.MAX_SCORES_PER_RUN ?? '150', 10) || 150;
    let aiCalls = 0;

    // Proč skóre nevzniklo — do konzole běhu, ne jen do Worker logu. Bez toho se nedá poznat
    // vyčerpaný free limit od spadlého backendu nebo od modelu, co vrátil nesmysl.
    let lastFail = '';
    let failLogged = 0;
    const onScoreFail = (id: string) => (msg: string) => {
      lastFail = msg;
      if (failLogged < 3) {
        failLogged++;
        run.log(`  ⚠️ ${id}: skóre nevzniklo — ${msg}`);
      }
    };

    const companyCandidates: SourceCandidate[] = [];
    let unchanged = 0;
    // Kandidáti, co mají hotovo (ohodnocené teď / beze změny). Co v setu není, na to nezbyl
    // čas (nebo selhalo skórování) → uloží se do fronty, ať se neztratí (viz parkJobs).
    const processed = new Set<string>();
    const BATCH = 3;
    const processJob = async (job: JobPosting): Promise<void> => {
      const id = job.id;
      const hash = await contentHash(job);
      const fp = await fingerprintHash(job);
      const existing = await loadExisting(env, id);
      // Přeskoč jen když je beze změny A UŽ OHODNOCENÝ. Vynulované skóre (relevance
      // NULL po resetu) se musí přeskórovat, i když se obsah inzerátu nezměnil.
      if (existing && existing.hash === hash && existing.relevance != null) {
        // U ověřitelných URL (jobs.cz/prace.cz) nech `active` na liveness (404), listovka ho nevzkřísí.
        await touchSeen(env, id, !isCheckableUrl(job.url));
        unchanged++;
        processed.add(id);
        return;
      }

      if (aiCalls >= maxScores) return; // strop hodnocení → kandidát spadne do fronty
      aiCalls++;
      budget.add('model');
      const score = await scoreJob(env, job, settings.profile, {
        region: settings.regionPriority,
        threshold: settings.notifyThreshold,
        provider,
        onFail: onScoreFail(id),
      });
      // Scoring selhal (rate-limit/parse) → nech kandidáta neoznačeného: níž se uloží do
      // fronty bez skóre a příští běh ho zkusí znovu (dřív takový inzerát propadl úplně).
      if (!score) return;
      stats.scored++;
      processed.add(id);
      const relevant = score.relevance >= settings.notifyThreshold;

      // Deanonymizace jen když je povolený web-výzkum (placený Anthropic); jinak přeskoč.
      const enrich = job.isAgency && relevant && webResearch ? await enrichOriginator(env, job) : null;
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

      // Veškerá notifikační komunikace pro inzeráty nad prahem → vždy zaloguj výsledek
      // (odesláno ✓/✗ / přeskočeno, protože už odesláno / duplikát), ať je vidět v Konzoli.
      if (relevant) {
        const head = `${score.relevance} | ${job.title} — ${job.employer}`;
        if (duplicateOf) {
          run.log(`  🔕 ${head} → neodesláno (duplikát již sledovaného inzerátu)`);
        } else if (existing?.notified_at) {
          run.log(`  🔕 ${head} → neodesláno (už odesláno ${existing.notified_at})`);
        } else {
          run.log(`  🔔 ${head} → odesílám na zapnuté kanály…`);
          // log callback → komunikace každého kanálu (vč. výsledku e-mailu) teče živě do konzole
          const r = await notify(
            env,
            settings,
            {
              ...job,
              relevance: score.relevance,
              reason: score.reason,
              realEmployer: enrich?.realEmployer,
              realEmployerUrl: enrich?.realEmployerUrl,
            },
            (m) => run.log(`    ${m}`),
          );
          const okAny = r.telegram || r.email || r.slack;
          if (okAny) {
            await setNotified(env, id);
            stats.notified++;
          } else {
            run.log(`  ⚠️ ${head} → neodesláno žádným kanálem`);
          }
        }
      } else {
        // Zamítnuté (pod prahem) — taky do logu, ať je v Konzoli VEŠKERÁ komunikace.
        const loc = job.location ? ` (${job.location})` : '';
        const why = score.reason ? ` — ${score.reason.slice(0, 100)}` : '';
        run.log(`  ❌ ${score.relevance} | ${job.title} — ${job.employer}${loc} → zamítnuto (pod prahem ${settings.notifyThreshold})${why}`);
      }
    };
    for (let b = 0; b < candidates.length; b += BATCH) {
      if (await stopRequested(env)) {
        stopped = true;
        run.log('⏹️ Zastaveno na žádost (tlačítko Stop) — rozpracované se neztrácí, dožene to další běh.');
        break;
      }
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
    if (unchanged) run.log(`⏭ ${unchanged} beze změny — přeskočeno (už ohodnocené, viz historie/Výsledky)`);

    // Na co v běhu nezbyl čas, ULOŽ bez skóre do fronty. Bez tohohle kroku kandidát nikde
    // neskončil a — protože se přírůstek MPSV pro dané datum stahuje jen jednou — byl navždy
    // pryč. Fronta se dohání níž (krok 6) i v dalších bězích, takže „dožene se to" platí.
    const leftovers = candidates.filter((j) => !processed.has(j.id));
    stats.candidatesPending = leftovers.length;
    if (leftovers.length) {
      const prepared = await Promise.all(
        leftovers.map(async (job) => ({
          job,
          hash: await contentHash(job),
          dedupKey: dedupKey(job),
          fingerprint: await fingerprintHash(job),
        })),
      );
      try {
        stats.queued = await parkJobs(env, prepared);
        run.log(`💾 Do fronty uloženo ${stats.queued} kandidátů, na které nezbyl čas — ohodnotí je další běh (nic se nezahazuje).`);
      } catch (e) {
        run.log(`⚠️ Frontu se nepodařilo uložit (${e}) — ${leftovers.length} kandidátů z tohoto stažení propadlo.`);
      }
    }
    run.log(`🧠 Ohodnoceno ${stats.scored} · deanonymizováno ${stats.enriched} · notifikováno ${stats.notified}`);
    await run.flush(stats);

    // 4b) živost inzerátů — u jobs.cz/prace.cz detail 404 = inzerát stažen z portálu (VŘ může
    //     běžet dál, jen zmizel placený inzerát). Přednost mají
    //     nejdéle neověřené (vypadlé z listovky). Levné HTTP → dávkově, do deadline.
    if (!stopped && Date.now() < deadline) {
      // Hromadné ověření dělá GitHub Action portal-liveness — v CI není strop podřízených
      // požadavků, takže projde všechny aktivní portálové inzeráty každý den. V běhu zůstává
      // malá dávka na čerstvé nálezy: recheckLiveness řadí dosud neověřené první, takže
      // inzerát nalezený dnes se dnes i ověří, místo aby čekal na ranní Action.
      const rawLimit = env.MAX_LIVENESS_CHECKS_PER_RUN;
      const parsedLimit = rawLimit == null ? 60 : parseInt(rawLimit, 10);
      // 0 = vypnuto. Dřív tu byl fallback "|| 60", takže nula tiše spadla na default a vypnout to nešlo.
      const liveLimit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 60;
      if (liveLimit === 0) {
        run.log('🔓 Živost: v běhu vypnuta (MAX_LIVENESS_CHECKS_PER_RUN=0) — ověřuje ji GitHub Action portal-liveness');
      } else {
        const lv = await recheckLiveness(env, (m) => run.log(m), deadline, liveLimit);
        stats.livenessGone = lv.gone;
        budget.add('liveness', lv.checked);
        // Logovat i nulu: „nebylo co ověřit" a „ověřování se vůbec nespustilo" musí jít rozeznat.
        run.log(
          lv.checked
            ? `🔓 Živost: ověřeno ${lv.checked} · na portálu ${lv.active} · nově staženo z portálu ${lv.gone} (hromadně ověřuje GitHub Action portal-liveness)`
            : '🔓 Živost: v běhu nebylo co ověřit — o stálý stav se stará GitHub Action portal-liveness',
        );
        await run.flush(stats);
      }
    }

    // 4c) revize regionu u dřívějších skóre — dokud o lokalitě rozhodoval jen model,
    //     protlačil nad práh i pozice z cizích krajů (např. Praha při nastavení „brno").
    //     Deterministická oprava (bez AI, bez notifikací): mimo region → strop pod prahem.
    if (settings.regionPriority?.trim()) {
      const stale = await loadScoredAbove(env, settings.notifyThreshold, 300);
      let fixed = 0;
      for (const r of stale) {
        const g = applyRegionGate(
          { relevance: r.relevance, reason: r.reason ?? '' },
          { title: r.title, location: r.location ?? undefined, region: r.region ?? undefined },
          settings.regionPriority,
          settings.notifyThreshold,
        );
        // Jen prokazatelně cizí kraj — neurčitelnou lokalitu zpětně nepřehodnocujeme.
        if (!g.capped || g.check.verdict !== 'out') continue;
        await updateRelevance(env, r.id, g.relevance, g.reason);
        fixed++;
        if (fixed <= 5) run.log(`  🧭 mimo region: ${r.title} — ${r.employer} (${r.location ?? '?'}) → ${r.relevance} → ${g.relevance}`);
      }
      if (fixed) {
        run.log(`🧭 Region „${settings.regionPriority}": opraveno ${fixed} dřívějších skóre mimo region${fixed > 5 ? ' (prvních 5 vypsáno)' : ''}.`);
        await run.flush(stats);
      }
    }

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
    if (!webResearch) {
      if (toDiscover.length) run.log('🌐 Screening zdrojů přeskočen (běží free/off — web-nástroje umí jen Claude).');
    } else if (Date.now() >= deadline) {
      if (toDiscover.length) run.log('🌐 Screening zdrojů přeskočen (došel čas) — příště.');
    } else {
      if (toDiscover.length) run.log(`🌐 Screening nových zdrojů (max ${limit})…`);
      stats.discovered = await discoverSources(env, toDiscover, limit);
      if (stats.discovered) run.log(`💾 Nové zdroje uložené: ${stats.discovered}`);
    }

    // 6) doskórování fronty (zaparkovaní kandidáti + seed) — v rámci času.
    //    Z fronty se NOTIFIKUJE taky: lead, který se nevešel do dávky, by jinak sice dostal
    //    skóre, ale uživatel by se o něm nikdy nedozvěděl. Aby se při doháněné historii
    //    nespustila lavina zpráv, je na běh strop — a když se strop uplatní, řekne se to.
    const notifyCap = parseInt(env.MAX_NOTIFY_FROM_QUEUE_PER_RUN ?? '10', 10) || 10;
    let backlog = 0;
    let queueNotified = 0;
    let queueHeld = 0;
    let queueOffset = 0; // o kolik zaseknutých řádků je potřeba se ve frontě posunout
    let dryBatches = 0; // dávky po sobě bez jediného skóre
    while (!stopped && Date.now() < deadline && aiCalls < maxScores) {
      if (await stopRequested(env)) {
        stopped = true;
        run.log('⏹️ Zastaveno na žádost (tlačítko Stop) — fronta zůstává, dožene ji další běh.');
        break;
      }
      // Dávka 8 místo 3: jedno čtení fronty obslouží víc inzerátů, takže se strop
      // podřízených požadavků nespotřebuje na režii.
      const batch = await loadUnscored(env, 8, queueOffset);
      if (!batch.length) break;
      let progressed = 0; // řádky, které opustily frontu (pro řízení smyčky)
      let ohodnoceno = 0; // z toho těch, které opravdu ohodnotil model

      // Deterministické vyřazení PŘED AI. Ve frontě leží i to, co tam napadalo, dokud byl
      // prefiltr děravý (klíčové slovo „CIO" chytalo „stacionář", jobs.cz mělo propustku
      // a region se řešil až stropem skóre po ohodnocení). Takové inzeráty nemá cenu posílat
      // modelu: rozhodne o nich kód. Dostanou skóre 0 s důvodem — ne NULL, aby z fronty
      // opravdu odešly, a ne smazání, aby zůstala historie.
      const rejected = batch.filter((j) => !roleMatch(j, settings) || regionRejected(j, settings));
      if (rejected.length) {
        // JEDNÍM zápisem, ne po jednom: volání D1 se počítají do stropu podřízených
        // požadavků Workeru a vyřazení by jinak snědlo rozpočet, který má patřit skórování.
        await bulkUpdateScores(
          env,
          rejected.map((j) => ({
            id: j.id,
            score: {
              relevance: 0,
              seniority: 'other' as const,
              reason: `⛔ Vyřazeno filtrem bez AI: ${
                !roleMatch(j, settings)
                  ? 'mimo hledanou roli'
                  : `mimo kraj (${checkRegion(j, settings.regionPriority).note})`
              }.`,
            },
          })),
        );
        // Do `progressed` ano (řádky frontu opustily, takže to je postup a nesmí to
        // spustit „tři dávky bez výsledku"), do `ohodnoceno` NE — model se jich nedotkl.
        progressed += rejected.length;
        stats.prefiltered = (stats.prefiltered ?? 0) + rejected.length;
      }
      const toScore = batch.filter((j) => !rejected.includes(j));
      if (!toScore.length) {
        // Dávka byla celá k vyřazení — pokračuj hned další, tohle nestálo ani jeden dotaz na AI.
        dryBatches = 0;
        continue;
      }
      aiCalls += toScore.length;
      budget.add('model', toScore.length);
      const zapsat: { id: string; score: ScoreResult }[] = [];
      await Promise.all(
        toScore.map(async (job) => {
          try {
            const sc = await scoreJob(env, job, settings.profile, {
              region: settings.regionPriority,
              threshold: settings.notifyThreshold,
              provider,
              onFail: onScoreFail(job.id),
            });
            if (!sc) return;
            // Zápis se odloží a udělá se jednou za dávku (viz bulkUpdateScores níže).
            zapsat.push({ id: job.id, score: sc });
            progressed++;
            ohodnoceno++;
            if (sc.relevance < settings.notifyThreshold || job.notifiedAt) return;
            const head = `${sc.relevance} | ${job.title} — ${job.employer}`;
            // Ve frontě můžou ležet tytéž inzeráty z jobs.cz i prace.cz — bez téhle kontroly
            // by z fronty odešly dvě zprávy o jedné pozici (hlavní cesta dedup má).
            // Vítěz dvojice je ten už notifikovaný, jinak rozhodne id: kdyby se potlačily
            // navzájem (obě běží v jedné dávce naráz), lead by neodešel vůbec.
            const qdup = await findDuplicate(env, dedupKey(job), await fingerprintHash(job), job.id);
            if (qdup && (qdup.notified_at || qdup.id < job.id)) {
              await markDuplicate(env, job.id, qdup.id);
              await bumpSeen(env, qdup.id);
              run.log(`  🔕 z fronty: ${head} → neodesláno (duplikát již sledovaného inzerátu)`);
              return;
            }
            if (queueNotified >= notifyCap) {
              queueHeld++;
              return;
            }
            queueNotified++;
            run.log(`  🔔 z fronty: ${head} → odesílám na zapnuté kanály…`);
            const r = await notify(
              env,
              settings,
              { ...job, relevance: sc.relevance, reason: sc.reason },
              (m) => run.log(`    ${m}`),
            );
            if (r.telegram || r.email || r.slack) {
              await setNotified(env, job.id);
              stats.notified++;
            } else {
              run.log(`  ⚠️ ${head} → neodesláno žádným kanálem`);
            }
          } catch (e) {
            run.log(`⚠️ skóre ${job.id}: ${e}`);
          }
        }),
      );
      // Do součtu „doskórováno" patří jen práce modelu. Běh 131 hlásil „Doskórováno 8",
      // ale model se dotkl JEDNOHO inzerátu — zbylých 7 vyřadil kód. Takový součet mate
      // přesně tam, kde má být vidět, co stálo peníze a čas.
      backlog += ohodnoceno;
      // Co se ohodnotit nepodařilo, zůstává ve frontě na stejném místě → posuň se za to,
      // jinak by pár vadných řádků v čele blokovalo frontu napořád (pořadí je deterministické,
      // příští běh by narazil na tytéž). Tři dávky po sobě bez výsledku = backend nefunguje,
      // pak už nemá smysl utrácet čas ani volání.
      queueOffset += batch.length - progressed;
      dryBatches = progressed ? 0 : dryBatches + 1;
      if (dryBatches >= 3) {
        run.log(`⏸ Fronta: tři dávky po sobě bez výsledku${lastFail ? ` (${lastFail})` : ''} — zbytek dožene další běh.`);
        break;
      }
      await bulkUpdateScores(env, zapsat);
      if (backlog % 18 === 0) await run.flush(stats);
    }
    if (queueOffset && dryBatches < 3) {
      run.log(`↷ Fronta: ${queueOffset} inzerátů se ohodnotit nepodařilo, přeskočeny — zkusí je další běh.`);
    }
    if (backlog) {
      stats.scored += backlog;
      run.log(`📊 Doskórováno z fronty: ${backlog}${queueNotified ? ` · z toho ${queueNotified} nových leadů odesláno` : ''}`);
    }
    // Vyřazení kódem se loguje zvlášť: nestálo ani jeden dotaz na AI a je to jiná událost
    // než „ohodnoceno". Bez toho by se ve statistice tvářilo jako práce modelu.
    if (stats.prefiltered) {
      run.log(
        `🧹 Z fronty vyřazeno filtrem (bez AI): ${stats.prefiltered} — mimo hledanou roli nebo mimo kraj. Zůstávají v databázi se skóre 0 a důvodem.`,
      );
    }
    if (queueHeld) {
      run.log(`🔕 Fronta: ${queueHeld} leadů nad prahem čeká na odeslání (strop ${notifyCap} zpráv na běh) — pošle je další běh.`);
    }
    if (aiCalls >= maxScores) {
      run.log(`🧮 Strop ${maxScores} AI hodnocení na běh vyčerpán — zbytek čeká ve frontě na další běh (nic se nezahazuje).`);
    }
    stats.queueDepth = await countUnscored(env);

    // Souhrn v běžné češtině — ať i někdo, kdo nezná vnitřnosti, na první pohled pozná,
    // co se (ne)děje. Strojová podoba čísel je ve sloupci `stats`; do logu patří lidská.
    const perSource = `jobs.cz ${jobscz.length} · prace.cz ${pracecz.length} · MPSV ${mpsv.length} · ATS ${ats.length} · web ${web.length}`;
    const leads = stats.notified === 0 ? 'žádný nový lead' : `${stats.notified} nových leadů`;
    const pending = stats.queueDepth
      ? ` · ve frontě čeká ${stats.queueDepth} inzerátů na ohodnocení (uložené, dožene je další běh)`
      : '';
    run.log(
      `📋 Souhrn: staženo ${stats.fetched} inzerátů (${perSource}), po filtru ${stats.candidates} relevantních · ` +
        `ohodnoceno ${stats.scored} · ${leads}${pending}`,
    );
    const b = budget.snapshot();
    stats.budget = b;
    // Zpracované = co frontou i hlavní cestou reálně prošlo, tedy i to, co vyřadil kód.
    run.log(formatBudget(b, stats.scored, stats.scored + (stats.prefiltered ?? 0)));
    run.log(
      stopped
        ? '⏹️ Běh ukončen na žádost. Co se nestihlo, čeká ve frontě — nic se nezahodilo.'
        : '✅ Hotovo — běh proběhl v pořádku (detaily po zdrojích viz 📡 řádky výše).',
    );
    await run.flush(stats, true);
  } catch (e: any) {
    run.log(`❌ Chyba: ${e?.message ?? e}`);
    await run.flush(stats, true);
    // Pád musí dojít ČLOVĚKU, ne jen do logu. Do 31. 8. 2026 se notifikace posílala jen na
    // leady, takže „dnes nic nenašel" a „dnes to spadlo" vypadaly zvenčí identicky — agent
    // mohl být týden mrtvý a nikdo by to nepoznal. Podmínka brány F6 build předpisu.
    try {
      const chatId = settings.telegramChatId;
      if (chatId && env.TELEGRAM_BOT_TOKEN) {
        await sendTelegram(
          env,
          chatId,
          `❌ JobWatch: běh (${trigger}) spadl.

${e?.message ?? e}

` +
            `Stihl: staženo ${stats.fetched} · ohodnoceno ${stats.scored} · notifikováno ${stats.notified}.
` +
            `Podrobnosti v Běhy na jobwatch.maxferit.cz.

${AI_DISCLOSURE}`,
        );
      }
    } catch (notifyErr) {
      // Selhání hlášení nesmí přebít původní chybu — ta je ta důležitá.
      console.warn('Hlášení pádu se nepodařilo odeslat:', notifyErr);
    }
    throw e;
  }

  return stats;
}
