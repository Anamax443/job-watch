// Prompty na jednom místě, s verzí.
//
// Proč zvlášť: build předpis z `ai-agenti` (fáze F4) říká, že prompt je kód — bydlí
// v repozitáři, prochází stejným review jako kód a **nese verzi, kterou si každý běh
// zapíše**. Dokud byly prompty rozeseté v `score.ts`, `enrich.ts` a `discover.ts` bez
// čísla, nešlo z uloženého běhu poznat, proti jakému znění se hodnotilo — a změna promptu
// tak byla neměřitelná.
//
// Texty jsou převzaté beze změny; tenhle soubor je přestěhování, ne přepis.

/**
 * Verze promptů. **Zvyš ji při každé změně textu v tomhle souboru.**
 *
 * Zapisuje se do `runs.stats.promptVersion`, takže u každého běhu je vidět, podle jakého
 * znění se skórovalo. Hlídá to i CI (`npm run check:prompt`): když se soubor změní a číslo
 * ne, brána spadne. Bez toho by se dalo prompt tiše přepsat a nikdo by nespároval změnu
 * chování s příčinou.
 */
export const PROMPT_VERSION = 'skore-2026-08-31.1';

/** Skórování bez profilu — obecná definice hledané role. */
export const DEFAULT_SYSTEM =
  'Jsi recruiter screener. Hodnotíš, jak moc inzerát odpovídá profilu VEDOUCÍ IT / ' +
  'IT manažer / Head of IT / IT ředitel / CIO / Solution Architect / IT architekt — tedy ' +
  'řídící nebo seniorní architektonické IT role. Odliš „vedoucí IT oddělení" (vysoká relevance) ' +
  'od „IT support / helpdesk / junior / operátor" (nízká). Vrať pouze JSON dle schématu: ' +
  'relevance 0–100, seniority lead|senior|other, reason krátké zdůvodnění česky.';

/**
 * Lokalita jako tvrdý faktor: pozice mimo preferovaný region (a ne remote/hybrid s
 * dojezdem) NESMÍ přes práh — i kdyby jinak seděla skvěle.
 *
 * Tahle věta v promptu je jen NÁPOVĚDA pro model. O výsledku rozhoduje deterministický
 * strop v src/region.ts (applyRegionGate) — free model instrukci prokazatelně
 * ignoroval (pražský inzerát dostal 80/100 s odůvodněním „je v preferovaném regionu").
 */
export function locationClause(region?: string, threshold?: number): string {
  const r = (region ?? '').trim();
  if (!r) return '';
  const t = threshold ?? 70;
  return (
    ` LOKALITA JE ZÁSADNÍ KRITÉRIUM: preferovaný region je „${r}". Pokud pozice NENÍ v tomto ` +
    `regionu a zároveň NENÍ remote/hybridní s reálným dojezdem, MUSÍŠ dát relevance POD ${t} ` +
    `(klidně 30–50), i kdyby role obsahově seděla perfektně. Pozici v regionu nebo plně remote ` +
    `lokalitou nepenalizuj. NIKDY si lokalitu nedomýšlej: hodnoť VÝHRADNĚ podle pole „Lokalita"/` +
    `„Region" ve vstupu. Když ve vstupu žádná lokalita není, do zdůvodnění napiš „lokalita neuvedena" ` +
    `a NETVRĎ, že je v preferovaném regionu — takový inzerát nesmí přes práh jen kvůli obsahu.`
  );
}

/** Systémový prompt skórování. S profilem se hodnotí proti němu, bez něj obecně. */
export function buildSystem(profile: string, region?: string, threshold?: number): string {
  const loc = locationClause(region, threshold);
  const p = (profile ?? '').trim();
  if (!p) return DEFAULT_SYSTEM + loc;
  return (
    'Jsi recruiter screener. Hodnotíš, jak moc pracovní inzerát sedí na KONKRÉTNÍ profil tohoto ' +
    'kandidáta (zkušenosti, seniorita, zaměření, lokalita, preference):\n\n' +
    p.slice(0, 6000) +
    '\n\nVrať relevance 0–100 = míra shody pozice s TÍMTO profilem (ne obecně), ' +
    'seniority lead|senior|other, reason = krátké zdůvodnění česky vůči profilu.' +
    loc +
    ' Pouze JSON dle schématu.'
  );
}
