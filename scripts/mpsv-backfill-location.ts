// Jednorázový backfill lokality/kraje u už uložených MPSV inzerátů. Staré záznamy (seed i
// přírůstky) se ukládaly s prázdnou lokalitou, protože `locationOf` četlo jen `adresaText`,
// který je u MPSV null u ~99 % záznamů (viz oprava v src/sources/mpsv.ts → placeOf). Tenhle
// skript dotáhne lokalitu+kraj ze strukturované adresy v PLNÉM exportu MPSV a u opravených
// řádků vynuluje skóre (relevance/seniority/reason = NULL), aby je příští běh přeskóroval
// s korektním regionem (dřív si slabý model region domýšlel — Olomoucký kraj hlásil jako Brno).
//
// Řetězec (viz .github/workflows/mpsv-backfill-location.yml):
//   1) wrangler d1 execute --json "SELECT id, location, region FROM seen_jobs WHERE source='mpsv'" > mpsv_rows.json
//   2) npm run mpsv:backfill            (tento skript: čte mpsv_rows.json → píše mpsv_backfill.sql)
//   3) wrangler d1 execute --file=mpsv_backfill.sql
//
// placeOf/krajName/fmtPsc jsou ZÁMĚRNĚ zkopírované z src/sources/mpsv.ts (jednorázový skript
// mimo Worker — bez importu Worker-only závislostí; drž je v souladu při změně mapování).

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const FULL_EXPORT = 'https://data.mpsv.cz/od/soubory/volna-mista/volna-mista.json.gz';
const IN = 'mpsv_rows.json';
const OUT = 'mpsv_backfill.sql';

// --- kopie logiky z src/sources/mpsv.ts (placeOf) --------------------------
const KRAJ_NAZVY: Record<string, string> = {
  '19': 'Hlavní město Praha', '27': 'Středočeský kraj', '35': 'Jihočeský kraj',
  '43': 'Plzeňský kraj', '51': 'Karlovarský kraj', '60': 'Ústecký kraj',
  '78': 'Liberecký kraj', '86': 'Královéhradecký kraj', '94': 'Pardubický kraj',
  '108': 'Kraj Vysočina', '116': 'Jihomoravský kraj', '124': 'Olomoucký kraj',
  '132': 'Moravskoslezský kraj', '141': 'Zlínský kraj',
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
// ---------------------------------------------------------------------------

/** Číslo (portalId) z uloženého id — funguje pro "mpsv:123" i "mpsv:VolneMisto/123". */
function numOf(id: string): string {
  const s = id.replace(/^mpsv:/, '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}
/** Kanonické číslo z rec.id/portalId v exportu ("VolneMisto/123" → "123"). */
function recNum(rec: any): string | null {
  const raw = rec?.id ?? rec?.portalId;
  if (raw == null) return null;
  const s = String(raw);
  const n = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  return n.trim() || null;
}
function extractItems(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ['polozky', 'items', 'data', 'volnaMista', 'records', 'member', '@graph']) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}
function sqlStr(v: string | undefined): string {
  return v == null || v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

interface InRow { id: string; location: string | null; region: string | null }

function readRows(): InRow[] {
  const raw = JSON.parse(readFileSync(IN, 'utf8'));
  const results = Array.isArray(raw) ? raw[0]?.results ?? [] : raw?.results ?? [];
  return results.map((r: any) => ({
    id: String(r.id), location: r.location ?? null, region: r.region ?? null,
  })).filter((r: InRow) => r.id);
}

async function main(): Promise<void> {
  const rows = readRows();
  console.log(`MPSV řádků v DB: ${rows.length}`);

  const lines: string[] = [];
  if (rows.length) {
    console.log('Stahuji plný export…', FULL_EXPORT);
    const res = await fetch(FULL_EXPORT);
    if (!res.ok) throw new Error(`Export HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text =
      buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
        ? gunzipSync(buf).toString('utf8')
        : buf.toString('utf8');
    console.log(`Export ${(text.length / 1e6).toFixed(1)} MB`);

    const items = extractItems(JSON.parse(text));
    console.log(`Záznamů v exportu: ${items.length}`);
    const byNum = new Map<string, any>();
    for (const rec of items) {
      const n = recNum(rec);
      if (n) byNum.set(n, rec);
    }

    let updated = 0, unchanged = 0, unmatched = 0, noPlace = 0;
    for (const row of rows) {
      const rec = byNum.get(numOf(row.id));
      if (!rec) { unmatched++; continue; } // zavřená pozice už není v exportu → nelze dotáhnout
      const place = placeOf(rec);
      if (!place.location) { noPlace++; continue; }
      // Opravuj jen když se něco reálně mění (lokalita nebo kraj) — jinak zbytečné přeskórování.
      if (place.location === (row.location ?? '') && (place.region ?? '') === (row.region ?? '')) {
        unchanged++; continue;
      }
      lines.push(
        `UPDATE seen_jobs SET location=${sqlStr(place.location)}, region=${sqlStr(place.region)}, ` +
          `relevance=NULL, seniority=NULL, reason=NULL WHERE id=${sqlStr(row.id)};`,
      );
      updated++;
    }
    console.log(
      `Opraveno ${updated} · beze změny ${unchanged} · bez adresy v exportu ${noPlace} · ` +
        `nenalezeno v exportu (zavřené) ${unmatched}`,
    );
  }

  // wrangler odmítne prázdný --file
  if (!lines.length) lines.push('SELECT 1;');
  writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`Hotovo → ${OUT} (${lines.length} statementů).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
