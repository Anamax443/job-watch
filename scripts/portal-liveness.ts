// Denní ověření živosti portálových inzerátů (jobs.cz, prace.cz) — MIMO Worker.
//
// Proč mimo: každá kontrola je jeden podřízený požadavek a Worker jich má na jedno
// vyvolání strop. Běh 23. 8. 2026 utratil 60 na živost a doskórování fronty pak spadlo
// na „Too many subrequests" (viz komentář u MAX_LIVENESS_CHECKS_PER_RUN ve wrangler.toml).
// Strop se tehdy snížil na 15 — jenže aktivních portálových inzerátů je ~142, takže
// jeden okruh trval ~9,5 dne a stažený inzerát se u nás tvářil živě i týden.
// V CI žádný takový rozpočet není: projdou se všechny, každý den.
//
// Řetězec (viz .github/workflows/portal-liveness.yml):
//   1) wrangler d1 execute --json "SELECT id, url … " > portal_ids.json
//   2) npm run portal:liveness          (tento skript: čte portal_ids.json → píše portal_liveness.sql)
//   3) wrangler d1 execute --file=portal_liveness.sql
//
// O stavu rozhoduje `classifyStatus` ze src/liveness.ts — schválně tatáž funkce, jakou
// používá pipeline. Dvě kopie téhle logiky by znamenaly dva různé názory na to,
// co je zrušený inzerát.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkUrl, type Liveness } from '../src/liveness.ts';

const IN = 'portal_ids.json';
const OUT = 'portal_liveness.sql';
const BATCH = 6; // souběžně; stejná dávka jako v pipeline
const PAUSE_MS = 250; // mezi dávkami — ať to na portál nevypadá jako nálet

export interface Row {
  id: string;
  url: string;
}

export interface Verdict {
  id: string;
  state: Liveness;
}

/** Výstup `wrangler d1 execute --json` → řádky. Tvar se liší podle verze wranglera. */
export function parseRows(raw: unknown): Row[] {
  const first: any = Array.isArray(raw) ? raw[0] : raw;
  const results: any[] = first?.results ?? [];
  return results
    .map((r) => ({ id: String(r?.id ?? ''), url: String(r?.url ?? '') }))
    .filter((r) => r.id && r.url);
}

/**
 * Verdikty → dávkové UPDATE. `unknown` mění JEN `active_checked_at`: nevíme, jestli
 * inzerát žije, a tichý zápis `active=0` by z blokace udělal „zrušeno".
 * Posun razítka tam přesto patří, jinak se stejný nejistý inzerát vybírá pořád dokola.
 */
export function buildSql(verdicts: Verdict[]): string[] {
  const q = (id: string) => `'${id.replace(/'/g, "''")}'`;
  const pick = (s: Liveness) => verdicts.filter((v) => v.state === s).map((v) => v.id);
  const chunk = <T,>(a: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
    return out;
  };

  const lines: string[] = [];
  const write = (ids: string[], set: string) => {
    for (const b of chunk(ids, 200))
      lines.push(`UPDATE seen_jobs SET ${set} WHERE id IN (${b.map(q).join(',')});`);
  };
  write(pick('gone'), "active=0, active_checked_at=datetime('now')");
  write(pick('active'), "active=1, active_checked_at=datetime('now')");
  write(pick('unknown'), "active_checked_at=datetime('now')");

  // vždy neprázdný soubor (prázdný --file wrangler odmítne)
  if (!lines.length) lines.push('SELECT 1;');
  return lines;
}

/**
 * Kontrola, že jsme opravdu měřili živost a ne blokaci.
 *
 * Runner GitHubu leze na portál z datacentra. Když nás jobs.cz odstřihne, vrátí 403 na
 * všechno → samé `unknown` → skript by dopsal „nic se nemění" a tvářil se zeleně.
 * Ticho po blokaci a ticho po „všechno žije" musí jít rozeznat, proto se to shodí.
 */
export function looksBlocked(v: { checked: number; unknown: number }): boolean {
  return v.checked >= 10 && v.unknown / v.checked > 0.5;
}

async function main(): Promise<void> {
  const rows = parseRows(JSON.parse(readFileSync(IN, 'utf8')));
  console.log(`Portálových inzerátů k ověření: ${rows.length}`);

  const verdicts: Verdict[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const done = await Promise.all(
      slice.map(async (r) => ({ id: r.id, url: r.url, state: await checkUrl(r.url) })),
    );
    for (const d of done) {
      verdicts.push({ id: d.id, state: d.state });
      if (d.state === 'gone') console.log(`  staženo z portálu: ${d.url}`);
    }
    if (i + BATCH < rows.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  const tally = {
    checked: verdicts.length,
    gone: verdicts.filter((v) => v.state === 'gone').length,
    active: verdicts.filter((v) => v.state === 'active').length,
    unknown: verdicts.filter((v) => v.state === 'unknown').length,
  };
  console.log(
    `Ověřeno ${tally.checked} · na portálu ${tally.active} · staženo ${tally.gone} · nejistých ${tally.unknown}`,
  );

  if (looksBlocked(tally)) {
    throw new Error(
      `Nejistých odpovědí ${tally.unknown} z ${tally.checked} — tohle není výsledek měření, ` +
        'ale nejspíš blokace runneru portálem. Stav v D1 se nemá podle čeho měnit.',
    );
  }

  const lines = buildSql(verdicts);
  writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`Hotovo → ${OUT} (${lines.length} statementů).`);
}

// Spouštět jen jako program; při importu z testu ne.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
