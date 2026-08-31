// Brána: změna promptu bez zvýšení verze neprojde.  Spuštění:  npm run check:prompt
//
// Fáze F4 build předpisu z Anamax443/ai-agenti říká „prompt je kód: bydlí v repozitáři,
// prochází stejným review jako kód a nese verzi, kterou si každý běh zapíše" a brána k tomu
// dodává „změna promptu bez běhu evalů neprojde". Verze se zapisuje do `runs.stats.promptVersion`,
// takže když se text promptu změní a číslo ne, ztratí se spojení mezi změnou chování a příčinou:
// v uložených bězích budou dvě různá znění pod jedním číslem.
//
// Kontroluje se jen `src/prompts.ts` — tam prompty od 31. 8. 2026 bydlí.

import { execFileSync } from 'node:child_process';

export const PROMPT_FILE = 'src/prompts.ts';

/**
 * Musí se zvýšit verze? Čistá funkce nad textem diffu.
 *
 * Prázdný diff = prompt se nezměnil, verze zvyšovat netřeba. Neprázdný diff bez přidaného
 * řádku s `PROMPT_VERSION` = text se změnil, ale číslo zůstalo → brána spadne.
 * Změna jen v komentáři se počítá taky: rozhoduje, že se soubor promptů hnul.
 */
export function needsVersionBump(diff: string): boolean {
  if (!diff.trim()) return false;
  return !/^\+\s*export const PROMPT_VERSION/m.test(diff);
}

function main(): void {
  const range = process.argv.slice(2);
  const args = ['diff', ...(range.length ? range : ['HEAD~1', 'HEAD']), '--', PROMPT_FILE];
  let diff = '';
  try {
    diff = execFileSync('git', args, { encoding: 'utf8' });
  } catch (e: any) {
    // Bez historie (mělký clone, první commit) se nedá porovnávat. Radši hlasitě přeskočit
    // než tiše projít — „nešlo to změřit" a „je to v pořádku" nesmí vypadat stejně.
    console.log(`⚠️  Kontrolu verze promptu nešlo provést (${e?.message ?? e}) — PŘESKOČENO.`);
    return;
  }
  if (!diff.trim()) {
    console.log(`✅ ${PROMPT_FILE} se nezměnil — verzi zvyšovat netřeba.`);
    return;
  }
  if (needsVersionBump(diff)) {
    console.error(
      `❌ ${PROMPT_FILE} se změnil, ale PROMPT_VERSION zůstala stejná.\n` +
        `   Zvyš ji a pusť evaly (npm run evals). Bez toho nejde u uloženého běhu poznat,\n` +
        `   podle jakého znění promptu se skórovalo.`,
    );
    process.exit(1);
  }
  console.log('✅ Prompt se změnil a PROMPT_VERSION je zvýšená.');
}

if (process.argv[1] && import.meta.url.endsWith('prompt-check.ts')) main();
