import type { Env, JobPosting, ScoreResult, EnrichResult, AtsTarget } from './types';
import { norm, sha256hex } from './util';

// D1 perzistence + cross-source dedup.

/** Fuzzy klíč pro dedup napříč zdroji: zaměstnavatel | titul | první část lokality. */
export function dedupKey(j: JobPosting): string {
  const loc = (norm(j.location).split(',')[0] ?? '').trim();
  return [norm(j.employer), norm(j.title), loc].join('|');
}

/** Hash obsahu pro detekci změny inzerátu. */
export function contentHash(j: JobPosting): Promise<string> {
  return sha256hex(
    [j.title, j.description ?? '', j.salaryFrom ?? '', j.salaryTo ?? '', j.location ?? ''].join(''),
  );
}

/** Otisk inzerátu = hash nejdelších/nejdistinktivnějších vět (stabilní napříč zdroji i časem). */
export function fingerprintText(j: JobPosting): string | null {
  const desc = (j.description ?? '').trim();
  if (desc.length < 60) return null;
  const sentences = desc
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60);
  if (!sentences.length) return null;
  const top = sentences.sort((a, b) => b.length - a.length).slice(0, 2).map(norm);
  return top.join(' | ');
}

export function fingerprintHash(j: JobPosting): Promise<string | null> {
  const t = fingerprintText(j);
  return t ? sha256hex(t) : Promise.resolve(null);
}

export interface ExistingRow {
  hash: string;
  notified_at: string | null;
  relevance: number | null;
}

export async function loadExisting(env: Env, id: string): Promise<ExistingRow | null> {
  return await env.DB.prepare('SELECT hash, notified_at, relevance FROM seen_jobs WHERE id = ?')
    .bind(id)
    .first<ExistingRow>();
}

export async function touchSeen(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE seen_jobs SET last_seen = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

/** Najde jiný (ne-duplicitní) záznam se stejným dedup_key — preferuje již notifikovaný originál. */
export async function findDuplicate(
  env: Env,
  dk: string,
  fp: string | null,
  excludeId: string,
): Promise<{ id: string; notified_at: string | null } | null> {
  return await env.DB.prepare(
    `SELECT id, notified_at FROM seen_jobs
     WHERE id != ?1 AND duplicate_of IS NULL
       AND ((?3 IS NOT NULL AND fingerprint = ?3) OR dedup_key = ?2)
     ORDER BY (fingerprint IS NOT NULL AND fingerprint = ?3) DESC,
              (notified_at IS NOT NULL) DESC, first_seen ASC
     LIMIT 1`,
  )
    .bind(excludeId, dk, fp)
    .first<{ id: string; notified_at: string | null }>();
}

export interface SaveInput {
  job: JobPosting;
  hash: string;
  dedupKey: string;
  fingerprint?: string | null;
  score?: ScoreResult;
  enrich?: EnrichResult | null;
  duplicateOf?: string | null;
}

export async function saveJob(env: Env, x: SaveInput): Promise<void> {
  const j = x.job;
  await env.DB.prepare(
    `INSERT INTO seen_jobs
       (id, source, hash, dedup_key, title, employer, employer_ico, location, region, cz_isco,
        salary_from, salary_to, url, description, is_agency, relevance, seniority, reason,
        real_employer, real_employer_url, duplicate_of, fingerprint, first_seen, last_seen)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
             datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       hash=?3, dedup_key=?4, title=?5, employer=?6, employer_ico=?7, location=?8, region=?9, cz_isco=?10,
       salary_from=?11, salary_to=?12, url=?13, description=?14, is_agency=?15,
       relevance=?16, seniority=?17, reason=?18, real_employer=?19, real_employer_url=?20,
       duplicate_of=?21, fingerprint=?22, last_seen=datetime('now')`,
  )
    .bind(
      j.id,
      j.source,
      x.hash,
      x.dedupKey,
      j.title,
      j.employer,
      j.employerIco ?? null,
      j.location ?? null,
      j.region ?? null,
      j.czIsco ?? null,
      j.salaryFrom ?? null,
      j.salaryTo ?? null,
      j.url ?? null,
      j.description ?? null,
      j.isAgency ? 1 : 0,
      x.score?.relevance ?? null,
      x.score?.seniority ?? null,
      x.score?.reason ?? null,
      x.enrich?.realEmployer ?? null,
      x.enrich?.realEmployerUrl ?? null,
      x.duplicateOf ?? null,
      x.fingerprint ?? null,
    )
    .run();
}

export async function setNotified(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE seen_jobs SET notified_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

/** Inzerát se objevil znovu (opakování v čase) → zvýší počítadlo na originálu. */
export async function bumpSeen(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE seen_jobs SET seen_count = seen_count + 1, last_seen = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
}

/** Dávka dosud neohodnocených (seedovaných) pozic ke skórování. */
export async function loadUnscored(env: Env, limit: number): Promise<JobPosting[]> {
  const rows = await env.DB.prepare(
    `SELECT id, source, title, employer, employer_ico, location, cz_isco, salary_from, salary_to, url, description, is_agency
     FROM seen_jobs WHERE relevance IS NULL AND duplicate_of IS NULL LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string; source: string; title: string; employer: string; employer_ico: string | null;
      location: string | null; cz_isco: string | null; salary_from: number | null;
      salary_to: number | null; url: string | null; description: string | null; is_agency: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title ?? '',
    employer: r.employer ?? '',
    employerIco: r.employer_ico ?? undefined,
    location: r.location ?? undefined,
    czIsco: r.cz_isco ?? undefined,
    salaryFrom: r.salary_from ?? undefined,
    salaryTo: r.salary_to ?? undefined,
    url: r.url ?? undefined,
    description: r.description ?? undefined,
    isAgency: !!r.is_agency,
  }));
}

/** Zapíše jen skóre (doskórování fronty — bez změny ostatních polí / notifikace). */
export async function updateScore(env: Env, id: string, score: ScoreResult): Promise<void> {
  await env.DB.prepare('UPDATE seen_jobs SET relevance = ?2, seniority = ?3, reason = ?4 WHERE id = ?1')
    .bind(id, score.relevance, score.seniority, score.reason)
    .run();
}

// --- Dynamicky objevené zdroje (sources) --------------------------------

export async function sourceKnown(
  env: Env,
  name: string,
  ico?: string,
): Promise<boolean> {
  const r = await env.DB.prepare(
    'SELECT 1 FROM sources WHERE (?1 IS NOT NULL AND ico = ?1) OR lower(name) = lower(?2) LIMIT 1',
  )
    .bind(ico ?? null, name)
    .first();
  return !!r;
}

export interface SourceInsert {
  name: string;
  ico?: string;
  kind: 'agency' | 'company';
  platform: string;
  slug?: string;
  endpoint?: string;
  careersUrl?: string;
  status: string;
  confidence: number;
}

export async function insertSource(env: Env, s: SourceInsert): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sources (name, ico, kind, platform, slug, endpoint, careers_url, status, confidence, discovered_at, last_checked)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, datetime('now'), datetime('now'))
     ON CONFLICT(ico) WHERE ico IS NOT NULL DO UPDATE SET
       name=?1, kind=?3, platform=?4, slug=?5, endpoint=?6, careers_url=?7, status=?8, confidence=?9,
       last_checked=datetime('now')`,
  )
    .bind(
      s.name,
      s.ico ?? null,
      s.kind,
      s.platform,
      s.slug ?? null,
      s.endpoint ?? null,
      s.careersUrl ?? null,
      s.status,
      s.confidence,
    )
    .run();
}

export async function loadAtsTargets(env: Env): Promise<AtsTarget[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, kind, platform, slug FROM sources
     WHERE status = 'active'
       AND platform IN ('recruitee','greenhouse','lever','ashby','smartrecruiters')
       AND slug IS NOT NULL AND slug <> ''`,
  ).all<{ id: number; name: string; kind: string; platform: AtsTarget['platform']; slug: string }>();
  return (rows.results ?? []).map((r) => ({
    platform: r.platform,
    company: r.slug,
    label: r.name,
    isAgency: r.kind === 'agency',
    sourceId: r.id,
  }));
}

export async function markSourceChecked(env: Env, id: number, ok: boolean): Promise<void> {
  await env.DB.prepare(
    `UPDATE sources SET
       last_checked = datetime('now'),
       last_ok = CASE WHEN ?2 = 1 THEN datetime('now') ELSE last_ok END
     WHERE id = ?1`,
  )
    .bind(id, ok ? 1 : 0)
    .run();
}
