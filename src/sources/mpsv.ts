import type { Env, JobPosting } from '../types';
import { getMeta, setMeta } from '../config';
import { num, truncate } from '../util';

// Zdroj: otevřená data ÚP ČR / MPSV — denní přírůstky volných míst.
// Soubor: volna-mista-prirustek-YYYY-MM-DD.json (publikováno v pracovní dny).
// Pole potvrzena proti volna-mista-prirustek.schema.json.

const BASE = 'https://data.mpsv.cz/od/soubory/volna-mista-prirustek';
const CURSOR_KEY = 'mpsv_last_date';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Z různých možných obalů JSONu vytáhne pole položek (klíč ověřit při prvním běhu). */
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

function locationOf(rec: any): string | undefined {
  const m = rec?.mistoVykonuPrace;
  if (!m) return undefined;
  if (typeof m.adresaText === 'string' && m.adresaText.trim()) return m.adresaText.trim();
  const p = Array.isArray(m.pracoviste) ? m.pracoviste[0] : undefined;
  const addr = p?.adresa?.adresaText ?? p?.adresaText;
  return typeof addr === 'string' ? addr.trim() : undefined;
}

function mapRecord(rec: any): JobPosting | null {
  const sid = rec?.id ?? rec?.portalId;
  if (sid == null) return null;
  const title = rec?.pozadovanaProfese?.cs ?? rec?.pozadovanaProfese ?? '';
  const employer = rec?.zamestnavatel?.nazev ?? '';
  return {
    id: `mpsv:${sid}`,
    source: 'mpsv',
    title: String(title).trim(),
    employer: String(employer).trim(),
    employerIco: rec?.zamestnavatel?.ico ? String(rec.zamestnavatel.ico) : undefined,
    location: locationOf(rec),
    czIsco: rec?.profeseCzIsco?.id ? String(rec.profeseCzIsco.id) : undefined,
    salaryFrom: num(rec?.mesicniMzdaOd),
    salaryTo: num(rec?.mesicniMzdaDo),
    // urlAdresa = "URL adresa zaměstnavatele". TODO: ověřit veřejný detail inzerátu na portálu JPŘ/PSV.
    url: typeof rec?.urlAdresa === 'string' && rec.urlAdresa ? rec.urlAdresa : undefined,
    description: truncate(rec?.upresnujiciInformace?.cs ?? rec?.upresnujiciInformace ?? '', 8000),
    datePosted: rec?.datumVlozeni ?? undefined,
    dateChanged: rec?.datumZmeny ?? undefined,
    isAgency: false, // doplní agencies.ts dle IČO/názvu
  };
}

async function fetchIncrement(date: string): Promise<any[]> {
  const url = `${BASE}/volna-mista-prirustek-${date}.json`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return [];
  if (!res.ok) {
    console.warn(`MPSV ${date}: HTTP ${res.status}`);
    return [];
  }
  try {
    return extractItems(await res.json());
  } catch (e) {
    console.warn(`MPSV ${date}: parse error`, e);
    return [];
  }
}

/**
 * Stáhne přírůstky od posledního zpracovaného data (kurzor v meta) do dneška,
 * omezeno na MAX_INCREMENT_BACKFILL_DAYS. Dedup řeší store.ts.
 */
export async function fetchMpsv(env: Env): Promise<JobPosting[]> {
  const maxBackfill = parseInt(env.MAX_INCREMENT_BACKFILL_DAYS ?? '7', 10) || 7;
  const today = new Date();
  const todayStr = ymd(today);

  const cursor = await getMeta(env, CURSOR_KEY);
  let start = cursor ? addDays(new Date(`${cursor}T00:00:00Z`), 1) : addDays(today, -1);
  const minStart = addDays(today, -maxBackfill);
  if (start < minStart) start = minStart;

  const out: JobPosting[] = [];
  for (let d = new Date(start); ymd(d) <= todayStr; d = addDays(d, 1)) {
    const items = await fetchIncrement(ymd(d));
    for (const rec of items) {
      const job = mapRecord(rec);
      if (job && job.title) out.push(job);
    }
  }

  await setMeta(env, CURSOR_KEY, todayStr);
  console.log(`MPSV: ${out.length} záznamů (od ${ymd(start)} do ${todayStr})`);
  return out;
}
