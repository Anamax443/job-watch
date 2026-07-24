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

/**
 * Kanonické MPSV id = číselné portalId. Přírůstky mají rec.id "VolneMistoPrirustek/<num>",
 * plný export/seed "VolneMisto/<num>" — týž inzerát by tak dostal různé id a NEzdedupoval by
 * se. Bereme proto vždy číslo za lomítkem (fallback portalId), takže id je stabilní napříč zdroji.
 */
function mpsvSid(rec: any): string | null {
  const raw = rec?.id ?? rec?.portalId;
  if (raw == null) return null;
  const s = String(raw);
  const num = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  return num.trim() || null;
}

function locationOf(rec: any): string | undefined {
  const m = rec?.mistoVykonuPrace;
  if (!m) return undefined;
  if (typeof m.adresaText === 'string' && m.adresaText.trim()) return m.adresaText.trim();
  const p = Array.isArray(m.pracoviste) ? m.pracoviste[0] : undefined;
  const addr = p?.adresa?.adresaText ?? p?.adresaText;
  return typeof addr === 'string' ? addr.trim() : undefined;
}

/** Kontaktní osoba z MPSV: prvniKontaktSeZamestnavatelem.komuSeHlasit (fallback kdeSeHlasit). */
function contactOf(rec: any): {
  name?: string;
  email?: string;
  phone?: string;
  position?: string;
} {
  const k = rec?.prvniKontaktSeZamestnavatelem;
  const who = k?.komuSeHlasit ?? {};
  const where = k?.kdeSeHlasit ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name =
    [who.titulPredJmenem, who.jmeno, who.prijmeni]
      .map((x) => str(x))
      .filter(Boolean)
      .join(' ') + (str(who.titulZaJmenem) ? `, ${str(who.titulZaJmenem)}` : '');
  return {
    name: name.trim() || undefined,
    email: str(who.email) ?? str(where.email),
    phone: str(who.telefon) ?? str(where.telefon),
    position: str(who.poziceVeSpolecnosti),
  };
}

function mapRecord(rec: any): JobPosting | null {
  const sid = mpsvSid(rec);
  if (sid == null) return null;
  const title = rec?.pozadovanaProfese?.cs ?? rec?.pozadovanaProfese ?? '';
  const employer = rec?.zamestnavatel?.nazev ?? '';
  const contact = contactOf(rec);
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
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    contactPosition: contact.position,
  };
}

// status: 'ok' = soubor publikován (200), 'absent' = ještě/vůbec není (404),
// 'error' = přechodná chyba (≠404 / parse) → příště zopakovat, kurzor neposouvat.
type IncrementResult = { status: 'ok' | 'absent' | 'error'; items: any[] };

async function fetchIncrement(date: string): Promise<IncrementResult> {
  const url = `${BASE}/volna-mista-prirustek-${date}.json`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return { status: 'absent', items: [] };
  if (!res.ok) {
    console.warn(`MPSV ${date}: HTTP ${res.status}`);
    return { status: 'error', items: [] };
  }
  try {
    return { status: 'ok', items: extractItems(await res.json()) };
  } catch (e) {
    console.warn(`MPSV ${date}: parse error`, e);
    return { status: 'error', items: [] };
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

  // Kurzor posouváme JEN na definitivně zpracovaná data — jinak se přeskočí přírůstky.
  // Den v minulosti je finální: 200 = ingesce, 404 = pracovní volno/bez přírůstku
  // (přeskoč, ale posuň se za něj, ať se cyklus nezasekne na víkendu). Dnešek započítáme
  // jen když je soubor už publikovaný (200); jinak kurzor zůstane na včerejšku a příští
  // běh dnešek zopakuje — soubor MPSV se pro dané datum publikuje až během dne, ne v 06:00.
  // Přechodná chyba (≠404) = nezapočítat → zopakovat příště (ochrana dat).
  const out: JobPosting[] = [];
  let lastCovered: string | null = null;
  for (let d = new Date(start); ymd(d) <= todayStr; d = addDays(d, 1)) {
    const ds = ymd(d);
    const inc = await fetchIncrement(ds);
    if (inc.status === 'ok') {
      for (const rec of inc.items) {
        const job = mapRecord(rec);
        if (job && job.title) out.push(job);
      }
    }
    const covered = inc.status === 'ok' || (inc.status === 'absent' && ds < todayStr);
    if (covered) lastCovered = ds;
  }

  if (lastCovered) await setMeta(env, CURSOR_KEY, lastCovered);
  console.log(
    `MPSV: ${out.length} záznamů (od ${ymd(start)} do ${todayStr}, kurzor → ${lastCovered ?? cursor ?? '—'})`,
  );
  return out;
}
