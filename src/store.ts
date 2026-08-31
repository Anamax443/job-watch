import type { Env, JobPosting, ScoreResult, EnrichResult, AtsTarget } from './types.ts';
import { norm, sha256hex } from './util.ts';

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

export async function touchSeen(env: Env, id: string, setActive = true): Promise<void> {
  // U inzerátů s OVĚŘITELNÝM detailem (jobs.cz/prace.cz) o `active` rozhoduje výhradně liveness
  // (detail 404 = stažen). Listovka totiž stažený inzerát ještě chvíli zobrazuje, takže by ho
  // `active=1` mylně „vzkřísila". Proto pro ně jen last_seen; jinak (MPSV…) listovka = signál.
  const sql = setActive
    ? "UPDATE seen_jobs SET last_seen = datetime('now'), active = 1, active_checked_at = datetime('now') WHERE id = ?"
    : "UPDATE seen_jobs SET last_seen = datetime('now') WHERE id = ?";
  await env.DB.prepare(sql).bind(id).run();
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
        real_employer, real_employer_url, duplicate_of, fingerprint,
        contact_name, contact_email, contact_phone, contact_position,
        active, active_checked_at, first_seen, last_seen)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
             ?23,?24,?25,?26,
             1, datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       hash=?3, dedup_key=?4, title=?5, employer=?6, employer_ico=?7, location=?8, region=?9, cz_isco=?10,
       salary_from=?11, salary_to=?12, url=?13, description=?14, is_agency=?15,
       relevance=?16, seniority=?17, reason=?18, rescore=0, real_employer=?19, real_employer_url=?20,
       duplicate_of=?21, fingerprint=?22,
       contact_name=COALESCE(?23, contact_name), contact_email=COALESCE(?24, contact_email),
       contact_phone=COALESCE(?25, contact_phone), contact_position=COALESCE(?26, contact_position),
       active=1, active_checked_at=datetime('now'), last_seen=datetime('now')`,
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
      j.contactName ?? null,
      j.contactEmail ?? null,
      j.contactPhone ?? null,
      j.contactPosition ?? null,
    )
    .run();
}

export interface ParkInput {
  job: JobPosting;
  hash: string;
  dedupKey: string;
  fingerprint?: string | null;
}

/**
 * Uloží kandidáty BEZ skóre — „zaparkuje" je do fronty na příští běh.
 *
 * Proč: dřív se ukládal jen inzerát, který se stihl ohodnotit. Na co v běhu nezbyl čas,
 * to nikde neskončilo — a protože se přírůstek MPSV pro dané datum stahuje jen jednou
 * (kurzor se posune), byly ty inzeráty nenávratně pryč. Běh tak denně zahodil většinu
 * kandidátů, i když log sliboval „další dávka je dožene".
 *
 * Existující řádek NEPŘEPISUJE (jen `last_seen`): nesmí přijít o skóre, notifikaci ani
 * o stav živosti (`active`) — na rozdíl od `saveJob` tady nemáme čím je nahradit.
 */
export async function parkJobs(env: Env, items: ParkInput[]): Promise<number> {
  if (!items.length) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO seen_jobs
       (id, source, hash, dedup_key, title, employer, employer_ico, location, region, cz_isco,
        salary_from, salary_to, url, description, is_agency, fingerprint,
        contact_name, contact_email, contact_phone, contact_position, first_seen, last_seen)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
             datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now')`,
  );
  const CHUNK = 40; // D1 batch = jeden round-trip; po částech, ať se nenafoukne jeden dotaz
  let n = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((x) =>
      stmt.bind(
        x.job.id,
        x.job.source,
        x.hash,
        x.dedupKey,
        x.job.title,
        x.job.employer,
        x.job.employerIco ?? null,
        x.job.location ?? null,
        x.job.region ?? null,
        x.job.czIsco ?? null,
        x.job.salaryFrom ?? null,
        x.job.salaryTo ?? null,
        x.job.url ?? null,
        x.job.description ?? null,
        x.job.isAgency ? 1 : 0,
        x.fingerprint ?? null,
        x.job.contactName ?? null,
        x.job.contactEmail ?? null,
        x.job.contactPhone ?? null,
        x.job.contactPosition ?? null,
      ),
    );
    await env.DB.batch(chunk);
    n += chunk.length;
  }
  return n;
}

export async function setNotified(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE seen_jobs SET notified_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

/** Označí záznam jako duplikát jiného (fronta — hlavní cesta to řeší už při ukládání). */
export async function markDuplicate(env: Env, id: string, ofId: string): Promise<void> {
  await env.DB.prepare('UPDATE seen_jobs SET duplicate_of = ?2 WHERE id = ?1').bind(id, ofId).run();
}

/** Inzerát se objevil znovu (opakování v čase) → zvýší počítadlo na originálu. */
export async function bumpSeen(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE seen_jobs SET seen_count = seen_count + 1, last_seen = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
}

/** Položka fronty = inzerát bez skóre + údaj, jestli se o něm už notifikovalo. */
export interface QueuedJob extends JobPosting {
  notifiedAt: string | null;
}

/**
 * Dávka dosud neohodnocených pozic ke skórování (zaparkované z minulých běhů + seed).
 * Nejnovější první — čerstvý lead má přednost před historií. Potvrzeně zrušené (active=0)
 * se nescorují, škoda času.
 */
export async function loadUnscored(env: Env, limit: number, offset = 0): Promise<QueuedJob[]> {
  const rows = await env.DB.prepare(
    `SELECT id, source, title, employer, employer_ico, location, region, cz_isco, salary_from, salary_to,
            url, description, is_agency, notified_at
     FROM seen_jobs
     -- Do fronty patří jak nikdy nehodnocené (relevance NULL), tak ty, kterým změna
     -- profilu označila skóre za neaktuální (rescore = 1). Číslo jim zůstává, takže jsou
     -- mezitím pořád vidět a filtrovatelné — jen se čeká na přepočet.
     WHERE (relevance IS NULL OR rescore = 1) AND duplicate_of IS NULL AND (active IS NULL OR active = 1)
     -- Co UŽ JEDNOU prošlo prahem, se přeskóruje první; teprve pak zbytek od nejnovějších.
     -- Proč: v běžném dni je správné brát nejdřív čerstvé nálezy. Jenže změna profilu vynuluje
     -- VŠECHNA skóre a přeskórovává se celá historie — a tam řazení „od nejnovějších" odsune
     -- dozadu právě ty inzeráty, kvůli kterým se profil měnil. Ověřeno 23. 8. 2026 na živých
     -- datech: inzerát z 23. 7., který měl předtím 100/100, byl ve frontě 170. — s tímhle
     -- řazením je 8. (42 dřív notifikovaných z 223 čekajících jde dopředu).
     ORDER BY (notified_at IS NOT NULL) DESC, first_seen DESC
     LIMIT ?1 OFFSET ?2`,
  )
    .bind(limit, offset)
    .all<{
      id: string; source: string; title: string; employer: string; employer_ico: string | null;
      location: string | null; region: string | null; cz_isco: string | null; salary_from: number | null;
      salary_to: number | null; url: string | null; description: string | null; is_agency: number;
      notified_at: string | null;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title ?? '',
    employer: r.employer ?? '',
    employerIco: r.employer_ico ?? undefined,
    location: r.location ?? undefined,
    // region je pro filtr regionu (src/region.ts) — bez něj by doskórování z fronty
    // posuzovalo lokalitu jen z textu adresy.
    region: r.region ?? undefined,
    czIsco: r.cz_isco ?? undefined,
    salaryFrom: r.salary_from ?? undefined,
    salaryTo: r.salary_to ?? undefined,
    url: r.url ?? undefined,
    description: r.description ?? undefined,
    isAgency: !!r.is_agency,
    notifiedAt: r.notified_at,
  }));
}

/** Kolik inzerátů čeká ve frontě na ohodnocení (do souhrnu běhu — ať je vidět, že se nezahazují). */
export async function countUnscored(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM seen_jobs
     WHERE (relevance IS NULL OR rescore = 1) AND duplicate_of IS NULL AND (active IS NULL OR active = 1)`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Zapíše skóre VÍCE inzerátům jedním podřízeným požadavkem.
 *
 * Proč to existuje: Worker má strop na počet podřízených požadavků na jedno vyvolání
 * (na free plánu 50) a **volání D1 se do něj počítají**. Zápis po jednom stál 1 požadavek
 * za inzerát, takže se rozpočet utratil dřív, než se stihlo skórovat. Změřeno 31. 8. 2026:
 * fixní režie běhu ~15 požadavků, zbylých ~35 dělených 2,7 na inzerát = 13 ohodnocených —
 * přesně to, co běhy dlouhodobě dělaly. `DB.batch()` je jeden round-trip, takže dávka
 * čtyřiceti stojí jeden požadavek místo čtyřiceti.
 */
export async function bulkUpdateScores(
  env: Env,
  items: { id: string; score: ScoreResult }[],
): Promise<number> {
  if (!items.length) return 0;
  const stmt = env.DB.prepare(
    'UPDATE seen_jobs SET relevance = ?2, seniority = ?3, reason = ?4, rescore = 0 WHERE id = ?1',
  );
  const CHUNK = 40;
  let n = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const part = items
      .slice(i, i + CHUNK)
      .map((x) => stmt.bind(x.id, x.score.relevance, x.score.seniority, x.score.reason));
    await env.DB.batch(part);
    n += part.length;
  }
  return n;
}

/** Zapíše jen skóre (doskórování fronty — bez změny ostatních polí / notifikace). */
export async function updateScore(env: Env, id: string, score: ScoreResult): Promise<void> {
  // rescore = 0: čerstvé skóre je proti aktuálnímu profilu, značka „neaktuální" padá.
  await env.DB.prepare(
    'UPDATE seen_jobs SET relevance = ?2, seniority = ?3, reason = ?4, rescore = 0 WHERE id = ?1',
  )
    .bind(id, score.relevance, score.seniority, score.reason)
    .run();
}

// --- Revize regionu u už uložených inzerátů ------------------------------
// Skóre nad prahem vzniklá dřív (než byl filtr regionu deterministický) drží v seznamu
// pozice z cizích krajů. Běh je proto po každém stažení projde a zastropuje.

export interface ScoredRow {
  id: string;
  title: string;
  employer: string;
  location: string | null;
  region: string | null;
  relevance: number;
  reason: string | null;
}

export async function loadScoredAbove(env: Env, threshold: number, limit: number): Promise<ScoredRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, title, employer, location, region, relevance, reason
     FROM seen_jobs WHERE relevance >= ?1 AND duplicate_of IS NULL LIMIT ?2`,
  )
    .bind(threshold, limit)
    .all<ScoredRow>();
  return rows.results ?? [];
}

export async function updateRelevance(env: Env, id: string, relevance: number, reason: string): Promise<void> {
  await env.DB.prepare('UPDATE seen_jobs SET relevance = ?2, reason = ?3 WHERE id = ?1')
    .bind(id, relevance, reason)
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

// --- Filtr výpisu Výsledků -------------------------------------------------

export interface JobsFilter {
  /** Min. skóre z lišty filtrů (0 = neomezovat). */
  minScore: number;
  agencyOnly: boolean;
  /** 'all' | 'active' (na portálu / neověřené) | 'inactive' (staženo z portálu) */
  active: string;
  /** true = pustit i inzeráty BEZ skóre (fronta + historie po změně profilu). */
  history: boolean;
  /** Hledaný text v názvu, zaměstnavateli nebo lokalitě (prázdné = nehledat). */
  q?: string;
  /** Jen inzeráty nalezené za posledních N dní (null = neomezovat). */
  sinceDays?: number | null;
}

/**
 * Podmínky pro výpis Výsledků. Čistá funkce, ať jde otestovat bez D1.
 *
 * Podstatné je chování nehodnocených: skóre je NULL a na NULL neplatí žádné porovnání,
 * takže `relevance >= 1` je vyhodí stejně spolehlivě jako `relevance >= 100`. Přehled tím
 * tiše schovával 299 z 458 inzerátů — mezi nimi 12, o kterých už jednou přišla notifikace
 * a které se navíc samy nepřeskórují (jsou stažené z portálu a `loadUnscored` je nebere).
 * Proto je „i historie" vlastní podmínka, ne jen jiné číslo v poli Min. skóre.
 */
export function buildJobsFilter(f: JobsFilter): { where: string; binds: unknown[] } {
  const conds = ['duplicate_of IS NULL'];
  const binds: unknown[] = [];
  if (f.minScore > 0) {
    conds.push(f.history ? '(relevance >= ? OR relevance IS NULL)' : 'relevance >= ?');
    binds.push(f.minScore);
  }
  if (f.agencyOnly) conds.push('is_agency = 1');
  // Zrušené = potvrzené 404 (active=0). Aktivní = vše, co není potvrzeně zrušené
  // (active=1 i dosud neověřené NULL) — ať se nic nezobrazí předčasně jako mrtvé.
  if (f.active === 'inactive') conds.push('active = 0');
  else if (f.active === 'active') conds.push('(active IS NULL OR active = 1)');
  // Textové hledání přes to, co je v řádku vidět. LIKE v SQLite sjednocuje velikost písmen
  // jen u ASCII, takže „dělník" se hledá s diakritikou tak, jak se píše — na ruční třídění
  // (vyfiltruj si dělníky nebo Prahu a hromadně jim dej nulu) to stačí.
  const q = (f.q ?? '').trim().toLowerCase();
  if (q) {
    conds.push(
      "(lower(title) LIKE ? OR lower(employer) LIKE ? OR lower(COALESCE(real_employer,'')) LIKE ? OR lower(COALESCE(location,'')) LIKE ?)",
    );
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  // „Nové" se počítá od prvního nálezu, ne od data u zdroje: inzerát visící na portálu
  // půl roku je pro nás nový tehdy, když jsme ho poprvé uviděli.
  const dny = f.sinceDays;
  if (typeof dny === 'number' && Number.isFinite(dny) && dny > 0) {
    conds.push("first_seen >= datetime('now', ?)");
    binds.push(`-${Math.floor(dny)} days`);
  }
  return { where: conds.join(' AND '), binds };
}

// --- Ruční hromadné skóre --------------------------------------------------

/** Kolik řádků smí jeden hromadný zásah změnit. Strop je proti překlepu, ne proti zátěži. */
export const BULK_MAX = 500;

// --- Vypínač běhu ----------------------------------------------------------

/**
 * Klíč v `meta`: požadavek na zastavení běhu.
 *
 * Do 31. 8. 2026 tlačítko Stop provedlo jediné — `UPDATE runs SET finished_at`. Zavřelo
 * *záznam* o běhu, ne běh: pipeline žádný příznak nečetla a dál skórovala i odesílala
 * notifikace, jen o tom nebyl zápis. Tlačítko tedy lhalo. Build předpis z ai-agenti to má
 * jako podmínku brány F6: „Agent se zastaví jedním úkonem a ověřil jsi to."
 *
 * Schválně v `meta`, ne nový sloupec: vypínač nemá čekat na migraci ostré databáze.
 */
export const STOP_KEY = 'run_stop';

/** Požádá běh o zastavení. Hodnota je čas, ať je v databázi vidět kdy. */
export async function requestStop(env: Env): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
  )
    .bind(STOP_KEY, new Date().toISOString())
    .run();
}

/** Zruší požadavek. Volá se na začátku běhu, ať staré zmáčknutí nezabije ten příští. */
export async function clearStop(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM meta WHERE key = ?').bind(STOP_KEY).run();
}

/** Byl vypínač zmáčknutý? Čte se v každé dávce, proto jeden krátký dotaz. */
export async function stopRequested(env: Env): Promise<boolean> {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(STOP_KEY)
    .first<{ value: string }>();
  return !!r?.value;
}

/**
 * Očistí seznam id z požadavku. Čistá funkce.
 *
 * Tělo požadavku je cizí JSON, i když chodí z vlastního UI. Propouští se jen neprázdné
 * řetězce, duplicity padají (jinak by se tentýž řádek zapsal několikrát) a je strop:
 * hromadný zásah má být to, co člověk vybral, ne omylem celá databáze.
 */
export function sanitizeIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= BULK_MAX) break;
  }
  return out;
}

/**
 * Ručně nastaví skóre vybraným inzerátům.
 *
 * `rescore = 0` je tu podstatné: bez toho by řádek zůstal ve frontě a příští běh by ruční
 * verdikt přepsal modelem. Důvod se zapisuje s jasnou značkou, aby v přehledu šlo poznat
 * ruční nulu od nuly z filtru a od nuly, kterou dal model.
 */
export async function bulkSetScore(env: Env, ids: string[], relevance: number): Promise<number> {
  if (!ids.length) return 0;
  const reason = `✋ Ručně nastaveno v přehledu (${new Date().toISOString().slice(0, 10)}).`;
  const CHUNK = 50;
  let n = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `UPDATE seen_jobs SET relevance = ?, reason = ?, rescore = 0 WHERE id IN (${marks})`,
    )
      .bind(relevance, reason, ...part)
      .run();
    n += r.meta?.changes ?? part.length;
  }
  return n;
}
