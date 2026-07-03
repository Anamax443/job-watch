// Denní obnova živosti MPSV inzerátů — MIMO Worker (plný export MPSV má ~184 MB,
// Worker to v běhu neunese). Zjistí, které uložené MPSV inzeráty už nejsou v aktuálním
// plném exportu = zrušené VŘ, a vygeneruje mpsv_liveness.sql (UPDATE active).
//
// Řetězec (viz .github/workflows/mpsv-liveness.yml):
//   1) wrangler d1 execute --json "SELECT id … source='mpsv' …" > mpsv_ids.json
//   2) npm run mpsv:liveness            (tento skript: čte mpsv_ids.json → píše mpsv_liveness.sql)
//   3) wrangler d1 execute --file=mpsv_liveness.sql
//
// Pozn.: plný export i seed používají rec.id = "VolneMisto/<num>" (shodné s uloženými
// id "mpsv:VolneMisto/<num>"). Denní přírůstky mají jiné id (VolneMistoPrirustek/…) —
// ty tu neřešíme, membership se testuje proti PLNÉMU exportu.

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const FULL_EXPORT = 'https://data.mpsv.cz/od/soubory/volna-mista/volna-mista.json.gz';
const IN = 'mpsv_ids.json';
const OUT = 'mpsv_liveness.sql';

function readIds(): string[] {
  const raw = JSON.parse(readFileSync(IN, 'utf8'));
  const results = Array.isArray(raw) ? raw[0]?.results ?? [] : raw?.results ?? [];
  return results.map((r: any) => String(r.id)).filter(Boolean);
}

/** Číslo (portalId) z uloženého id — funguje pro "mpsv:123" i "mpsv:VolneMisto/123". */
function numOf(id: string): string {
  const s = id.replace(/^mpsv:/, '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function main(): Promise<void> {
  const ids = readIds();
  console.log(`MPSV kandidátů k ověření: ${ids.length}`);

  const lines: string[] = [];
  if (ids.length) {
    console.log('Stahuji plný export…', FULL_EXPORT);
    const res = await fetch(FULL_EXPORT);
    if (!res.ok) throw new Error(`Export HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text =
      buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
        ? gunzipSync(buf).toString('utf8')
        : buf.toString('utf8');
    console.log(`Export ${(text.length / 1e6).toFixed(1)} MB`);

    // množina aktuálně nabízených portalId (číslo za "VolneMisto/")
    const present = new Set<string>();
    const re = /"VolneMisto\/(\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) present.add(m[1]);
    console.log(`Aktuálně nabízených VolneMisto id: ${present.size}`);

    const gone = ids.filter((id) => !present.has(numOf(id)));
    const alive = ids.filter((id) => present.has(numOf(id)));
    console.log(`Aktivní ${alive.length} · nově zrušené ${gone.length}`);
    if (gone.length) console.log('GONE:', gone.join(', '));

    const q = (id: string) => `'${id.replace(/'/g, "''")}'`;
    for (const b of chunk(gone, 200))
      lines.push(
        `UPDATE seen_jobs SET active=0, active_checked_at=datetime('now') WHERE id IN (${b.map(q).join(',')});`,
      );
    for (const b of chunk(alive, 200))
      lines.push(
        `UPDATE seen_jobs SET active=1, active_checked_at=datetime('now') WHERE id IN (${b.map(q).join(',')});`,
      );
  }

  // vždy neprázdný soubor (prázdný --file wrangler odmítne)
  if (!lines.length) lines.push('SELECT 1;');
  writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`Hotovo → ${OUT} (${lines.length} statementů).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
