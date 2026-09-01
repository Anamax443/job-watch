// Evaluační sada — spuštění:  npm run evals
//
// Vyžaduje ji fáze F4 build předpisu z Anamax443/ai-agenti („evaly běží v CI a jsou nad
// prahem; změna promptu bez běhu evalů neprojde"). Sada je v `evals/skorovani.json`
// a stojí na reálných inzerátech z produkční D1 s ručně dopsanou pravdou.
//
// Dvě části, schválně oddělené:
//
//   1. DETERMINISTICKÁ — prefiltr a filtr kraje. Běží tady a je to plnohodnotná brána
//      v CI: nepotřebuje síť ani klíč. Práh 100 %, jsou to invarianty, ne odhady.
//   2. MODELOVÁ — skutečné skórování. Běží JINDE: uvnitř nasazené verze přes POST /api/evals,
//      protože free příčka žebříku je binding `env.AI`, který mimo Worker neexistuje.
//      Viz src/evals.ts. Že se tady neměří, se vypisuje nahlas — „nezměřeno" se nesmí
//      tvářit jako „prošlo".
//
// Chyba, kterou tahle sada existuje chytat: 31. 8. 2026 jsem zpřísnil prefiltr na základě
// špatně spočítaného SQL agregátu a vyhodilo by to 16 reálných brněnských leadů. Průchod
// skutečnou funkcí nad skutečnými daty by to odhalil hned.

import { prefilter } from '../src/prefilter.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import type { JobPosting } from '../src/types.ts';
import { NASTAVENI, PRIPADY, type EvalPripad } from '../evals/skorovani.ts';

const settings = NASTAVENI;
const prah = settings.notifyThreshold ?? 70;

function job(p: EvalPripad): JobPosting {
  return { isAgency: false, ...p.job } as JobPosting;
}

// --- 1) deterministická část ------------------------------------------------

let chyb = 0;
console.log(`\n▶ Deterministická část — prefiltr a kraj (${PRIPADY.length} případů)\n`);
for (const p of PRIPADY) {
  const projde = prefilter([job(p)], settings).length === 1;
  const chteno = p.prefilter === 'in';
  const ok = projde === chteno;
  if (!ok) chyb++;
  console.log(
    `${ok ? '✔' : '✘'} [${projde ? 'in ' : 'out'}] ${p.job.title.slice(0, 60)}${ok ? '' : `  ← čekáno ${p.prefilter}`}`,
  );
  if (!ok) console.log(`    proč tam ten případ je: ${p.why}`);
}
const det = PRIPADY.length - chyb;
console.log(`\nDeterministická část: ${det}/${PRIPADY.length}${chyb ? ` — ${chyb} SELHALO` : ' ✅'}`);

// --- 2) modelová část -------------------------------------------------------

// Tady NEBĚŽÍ a je to záměr. Skórování jde přes providerChain (placený Claude → free
// Workers AI) a free příčka je binding env.AI, který mimo Worker neexistuje. Do 1. 9. 2026
// tenhle skript volal Anthropic napřímo — tím ale měřil příčku, která v produkci dnes
// vůbec nerozhoduje. Zelená z takového měření je horší než žádná.
//
// Kvalitu modelu proto měří sada UVNITŘ nasazené verze: POST /api/evals (viz src/evals.ts),
// která volá tentýž scoreJob, tentýž prompt a tentýž žebřík jako ostrý běh, a vrací
// precision/recall i to, KTERÁ příčka odpověděla.
const sBandem = PRIPADY.filter((p) => p.scoreBand);
console.log(
  `
⚠️  MODELOVÁ ČÁST SE TADY NEMĚŘÍ — ${sBandem.length} případů.` +
    `
    Free backend je binding env.AI a mimo Worker neexistuje; měřit místo něj Claude` +
    `
    by znamenalo měřit jiný model, než který v produkci rozhoduje.` +
    `
    Spusť je na nasazené verzi: tlačítko na /tests, nebo POST /api/evals.`,
);

if (chyb) {
  console.log(`\n❌ Evaly neprošly.`);
  process.exit(1);
}
console.log(`\n✅ Evaly prošly. Verze promptu: ${PROMPT_VERSION}`);
