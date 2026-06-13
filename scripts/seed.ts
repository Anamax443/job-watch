// Jednorázový seed: stáhne plný export MPSV (.json.gz), vyfiltruje pozice vedoucí IT
// a vygeneruje seed.sql (baseline „už viděno", aby denní běh neoznámil celou historii).
// Spuštění mimo Worker (má dost RAM):  npm run seed
// Aplikace:  wrangler d1 execute job-watch --remote --file=seed.sql
//
// Pozn.: hash + dedup_key se počítají STEJNĚ jako v src/store.ts, aby se záznamy spárovaly.

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const FULL_EXPORT = 'https://data.mpsv.cz/od/soubory/volna-mista/volna-mista.json.gz';

// Drž v souladu s DEFAULT_SETTINGS v src/config.ts
const CZ_ISCO_PREFIXES = ['133'];
const KEYWORDS = [
  'vedoucí it', 'vedoucí informatiky', 'it manažer', 'it manager', 'head of it',
  'it ředitel', 'cio', 'vedoucí oddělení it', 'solution architect', 'it lead',
  'it architekt', 'vedoucí vývoje',
];
const AGENCY_PATTERNS = [
  'hays', 'grafton', 'manpower', 'robert half', 'reed', 'hofmann', 'engage', 'talentor',
  'predictive', 'randstad', 'adecco', 'synergie', 'advantage consulting', 'trenkwalder',
  'recruitment', 'recruiting', 'staffing', 'personalni agentura',
];

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function norm(s: unknown): string {
  return stripDiacritics(String(s ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
}
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function truncate(s: unknown, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function extractItems(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ['polozky', 'items', 'data', 'volnaMista', 'records', 'member', '@graph']) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as any[];
    }
  }
  return [];
}

interface Row {
  id: string; source: string; hash: string; dedup_key: string; title: string;
  employer: string; employer_ico?: string; location?: string; cz_isco?: string;
  salary_from?: number; salary_to?: number; url?: string; description?: string; is_agency: number;
}

function locationOf(rec: any): string | undefined {
  const m = rec?.mistoVykonuPrace;
  if (!m) return undefined;
  if (typeof m.adresaText === 'string' && m.adresaText.trim()) return m.adresaText.trim();
  const p = Array.isArray(m.pracoviste) ? m.pracoviste[0] : undefined;
  const addr = p?.adresa?.adresaText ?? p?.adresaText;
  return typeof addr === 'string' ? addr.trim() : undefined;
}

function map(rec: any): Row | null {
  const sid = rec?.id ?? rec?.portalId;
  if (sid == null) return null;
  const title = String(rec?.pozadovanaProfese?.cs ?? rec?.pozadovanaProfese ?? '').trim();
  if (!title) return null;
  const employer = String(rec?.zamestnavatel?.nazev ?? '').trim();
  const location = locationOf(rec);
  const czIsco = rec?.profeseCzIsco?.id ? String(rec.profeseCzIsco.id) : undefined;
  const salaryFrom = num(rec?.mesicniMzdaOd);
  const salaryTo = num(rec?.mesicniMzdaDo);
  const description = truncate(rec?.upresnujiciInformace?.cs ?? rec?.upresnujiciInformace ?? '', 8000);

  // Stejný hash jako src/store.ts: [title, desc, salFrom, salTo, location].join('')
  const hash = sha256hex([title, description, salaryFrom ?? '', salaryTo ?? '', location ?? ''].join(''));
  const dedup_key = [norm(employer), norm(title), norm(location).split(',')[0].trim()].join('|');
  const is_agency =
    AGENCY_PATTERNS.some((p) => norm(employer).includes(p)) ? 1 : 0;

  return {
    id: `mpsv:${sid}`, source: 'mpsv', hash, dedup_key, title, employer,
    employer_ico: rec?.zamestnavatel?.ico ? String(rec.zamestnavatel.ico) : undefined,
    location, cz_isco: czIsco, salary_from: salaryFrom, salary_to: salaryTo,
    url: typeof rec?.urlAdresa === 'string' && rec.urlAdresa ? rec.urlAdresa : undefined,
    description, is_agency,
  };
}

function keep(r: Row): boolean {
  const digits = (r.cz_isco?.match(/\d+/g) ?? []).join('');
  const iscoOk = digits && CZ_ISCO_PREFIXES.some((p) => digits.startsWith(p));
  if (iscoOk) return true;
  const hay = norm(`${r.title} ${r.description ?? ''}`);
  return KEYWORDS.some((k) => hay.includes(k));
}

function sql(v: unknown): string {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  console.log('Stahuji plný export…', FULL_EXPORT);
  const res = await fetch(FULL_EXPORT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  console.log(`Staženo ${(gz.length / 1e6).toFixed(1)} MB gz, rozbaluji…`);
  const data = JSON.parse(gunzipSync(gz).toString('utf8'));
  const items = extractItems(data);
  console.log(`Záznamů celkem: ${items.length}`);

  const rows: Row[] = [];
  for (const rec of items) {
    const r = map(rec);
    if (r && keep(r)) rows.push(r);
  }
  console.log(`Po filtru (vedoucí IT): ${rows.length}`);

  const cols =
    'id, source, hash, dedup_key, title, employer, employer_ico, location, cz_isco, salary_from, salary_to, url, description, is_agency, notified_at, first_seen, last_seen';
  const lines: string[] = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const values = batch
      .map(
        (r) =>
          `(${sql(r.id)},${sql(r.source)},${sql(r.hash)},${sql(r.dedup_key)},${sql(r.title)},` +
          `${sql(r.employer)},${sql(r.employer_ico)},${sql(r.location)},${sql(r.cz_isco)},` +
          `${sql(r.salary_from)},${sql(r.salary_to)},${sql(r.url)},${sql(r.description)},${r.is_agency},` +
          `datetime('now'),datetime('now'),datetime('now'))`,
      )
      .join(',\n');
    lines.push(`INSERT OR IGNORE INTO seen_jobs (${cols}) VALUES\n${values};`);
  }
  lines.push('COMMIT;');

  writeFileSync('seed.sql', lines.join('\n'), 'utf8');
  console.log(`Hotovo → seed.sql (${rows.length} řádků).`);
  console.log('Aplikuj:  wrangler d1 execute job-watch --remote --file=seed.sql');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
