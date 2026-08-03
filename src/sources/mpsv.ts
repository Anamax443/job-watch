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

// RÚIAN VÚSC kódy krajů → název. MPSV adresy jsou kódované ("Kraj/124"), člověk ani model z čísla
// region nepozná. adresaText bývá null (~99 %), takže lokalitu skládáme ze strukturované adresy.
const KRAJ_NAZVY: Record<string, string> = {
  '19': 'Hlavní město Praha',
  '27': 'Středočeský kraj',
  '35': 'Jihočeský kraj',
  '43': 'Plzeňský kraj',
  '51': 'Karlovarský kraj',
  '60': 'Ústecký kraj',
  '78': 'Liberecký kraj',
  '86': 'Královéhradecký kraj',
  '94': 'Pardubický kraj',
  '108': 'Kraj Vysočina',
  '116': 'Jihomoravský kraj',
  '124': 'Olomoucký kraj',
  '132': 'Moravskoslezský kraj',
  '141': 'Zlínský kraj',
};

function krajName(kraj: any): string | undefined {
  const id = typeof kraj?.id === 'string' ? kraj.id : undefined;
  if (!id) return undefined;
  const code = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return KRAJ_NAZVY[code.trim()];
}

function fmtPsc(psc: unknown): string | undefined {
  const s = typeof psc === 'string' ? psc.replace(/\s/g, '') : psc != null ? String(psc) : '';
  if (/^\d{5}$/.test(s)) return `${s.slice(0, 3)} ${s.slice(3)}`;
  return s || undefined;
}

/**
 * Lokalita + kraj (region) z MPSV. `adresaText` je skoro vždy null → skládáme ze strukturované
 * adresy `pracoviste[].adresa` (kraj, PSČ, ulice, dodatek). `kraj` = region pro filtr; obec MPSV
 * uvádí jen kódem (Obec/…), takže město bereme z dodatekAdresy / názvu části obce, když je vyplněné.
 * Typ „celaCR" = práce po celé ČR (fakticky remote) → region nechÁme prázdný (neutrální).
 */
function placeOf(rec: any): { location?: string; region?: string } {
  const m = rec?.mistoVykonuPrace;
  if (!m) return {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const typ = String(m?.typMistaVykonuPrace?.id ?? '');
  const p = Array.isArray(m.pracoviste) ? m.pracoviste[0] : undefined;
  const a = p?.adresa;
  const region = krajName(a?.kraj);

  if (typ.endsWith('celaCR')) return { location: 'Celá ČR (remote)', region: undefined };
  if (str(m.adresaText)) return { location: str(m.adresaText), region };

  // Pozor: `p.nazev` je název provozovny (ne obec) → do lokality nepatří. Obec MPSV inline nedává
  // (jen kód), takže město bereme jen z nazevCastiObce / dodatekAdresy; jinak stačí PSČ + kraj.
  const town = str(a?.nazevCastiObce) ?? str(a?.dodatekAdresy);
  const street = str(a?.ulice?.nazev)
    ? `${str(a?.ulice?.nazev)}${a?.cisloDomovni ? ` ${a.cisloDomovni}` : ''}${a?.cisloOrientacni ? `/${a.cisloOrientacni}` : ''}`
    : undefined;
  const psc = fmtPsc(a?.psc);
  const cityLine = [psc, town].filter(Boolean).join(' ') || undefined;
  const parts = [street, cityLine, region].filter(Boolean);
  const location = parts.length ? parts.join(', ') : region;
  return { location: location || undefined, region };
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
  const place = placeOf(rec);
  return {
    id: `mpsv:${sid}`,
    source: 'mpsv',
    title: String(title).trim(),
    employer: String(employer).trim(),
    employerIco: rec?.zamestnavatel?.ico ? String(rec.zamestnavatel.ico) : undefined,
    location: place.location,
    region: place.region,
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
export async function fetchMpsv(env: Env, log?: (msg: string) => void): Promise<JobPosting[]> {
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
  const probes: string[] = []; // komunikační stopa: co se z data.mpsv.cz dotazovalo a s jakým výsledkem
  let lastCovered: string | null = null;
  for (let d = new Date(start); ymd(d) <= todayStr; d = addDays(d, 1)) {
    const ds = ymd(d);
    const inc = await fetchIncrement(ds);
    const tag =
      inc.status === 'ok' ? `200(${inc.items.length})` : inc.status === 'absent' ? '404' : 'chyba';
    probes.push(`${ds.slice(5)}→${tag}`); // MM-DD→stav(počet)
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
  const trail = probes.length ? probes.join(', ') : 'nic k dotazu (kurzor už na dnešku)';
  const cursorNote = lastCovered ? `kurzor → ${lastCovered}` : `kurzor ${cursor ?? '—'} (beze změny)`;
  // Komunikační identifikátor do historie: doloží, že MPSV opravdu odpovědělo (200/404) — 0 = nic nového, ne výpadek.
  log?.(`📡 data.mpsv.cz: ${trail}; ${cursorNote}`);
  console.log(`MPSV: ${out.length} záznamů (${trail}; ${cursorNote})`);
  return out;
}
