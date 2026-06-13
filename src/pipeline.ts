import type { Env } from './types';
import { loadSettings } from './config';
import { fetchMpsv } from './sources/mpsv';
import { fetchAts } from './sources/ats';
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

export async function runPipeline(env: Env): Promise<RunStats> {
  const settings = await loadSettings(env);
  const stats: RunStats = {
    fetched: 0,
    candidates: 0,
    scored: 0,
    enriched: 0,
    notified: 0,
    discovered: 0,
  };

  // 1) fetch ze všech zdrojů (selhání jednoho neshodí celek).
  //    ATS cíle se čtou z D1 `sources` (dynamicky objevené v minulých bězích).
  const [mpsv, ats] = await Promise.all([
    fetchMpsv(env).catch((e) => {
      console.warn('MPSV fetch:', e);
      return [];
    }),
    fetchAts(env).catch((e) => {
      console.warn('ATS fetch:', e);
      return [];
    }),
  ]);
  const jobs = [...mpsv, ...ats];
  stats.fetched = jobs.length;

  // 2) klasifikace agentur (IČO z registru + fallback dle názvu)
  const icoSet = await loadAgencyIcos(env);
  applyAgencyFlag(jobs, icoSet);

  // 3) prefilter (CZ-ISCO + klíčová slova)
  const candidates = prefilter(jobs, settings);
  stats.candidates = candidates.length;

  // kandidáti na dynamický screening zdrojů (firmy odhalené deanonymizací)
  const companyCandidates: SourceCandidate[] = [];

  // 4) zpracování kandidátů
  for (const job of candidates) {
    const id = job.id;
    const hash = await contentHash(job);
    const existing = await loadExisting(env, id);

    // beze změny → jen aktualizuj last_seen
    if (existing && existing.hash === hash) {
      await touchSeen(env, id);
      continue;
    }

    // skóre (haiku)
    const score = await scoreJob(env, job);
    stats.scored++;
    const relevant = score.relevance >= settings.notifyThreshold;

    // deanonymizace jen u relevantních agenturních inzerátů (cost control)
    const enrich = job.isAgency && relevant ? await enrichOriginator(env, job) : null;
    if (enrich) {
      stats.enriched++;
      if (enrich.realEmployer) companyCandidates.push({ name: enrich.realEmployer, kind: 'company' });
    }

    // cross-source dedup
    const dk = dedupKey(job);
    const dup = await findDuplicate(env, dk, id);
    const duplicateOf = dup?.id ?? null;

    await saveJob(env, { job, hash, dedupKey: dk, score, enrich, duplicateOf });

    // notifikace: relevantní, není to duplikát a tento záznam ještě nebyl oznámen
    if (relevant && !duplicateOf && !existing?.notified_at) {
      const r = await notify(env, settings, {
        ...job,
        relevance: score.relevance,
        reason: score.reason,
        realEmployer: enrich?.realEmployer,
        realEmployerUrl: enrich?.realEmployerUrl,
      });
      if (r.telegram || r.email) {
        await setNotified(env, id);
        stats.notified++;
      }
    }
  }

  // 5) dynamický screening zdrojů — pro nově viděné agentury (a odhalené firmy)
  //    najdi, kde zveřejňují nabídky, a ulož do D1 (postupně, omezeno na běh).
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
  stats.discovered = await discoverSources(env, [...agencyCandidates, ...companyCandidates], limit);

  console.log('Pipeline hotová:', JSON.stringify(stats));
  return stats;
}
