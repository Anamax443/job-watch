import type { JobPosting, Settings } from './types.ts';
import { norm } from './util.ts';
import { checkRegion } from './region.ts';

// Levný filtr před LLM: projde inzerát, když sedí CZ-ISCO prefix NEBO klíčové slovo,
// a zároveň není prokazatelně mimo hledaný kraj.
// (ATS inzeráty nemají CZ-ISCO → projdou přes klíčová slova v titulu/popisu.)

function iscoMatch(czIsco: string | undefined, prefixes: string[]): boolean {
  if (!czIsco) return false;
  const digits = (czIsco.match(/\d+/g) ?? []).join('');
  if (!digits) return false;
  return prefixes.some((p) => {
    const pp = p.replace(/\D/g, '');
    return pp && digits.startsWith(pp);
  });
}

/**
 * Obsahuje text klíčové slovo jako SAMOSTATNÉ slovo (resp. celou frázi)?
 *
 * Dřív tu bylo prosté `hay.includes(needle)` a pouštělo to do fronty nesmysly: klíčové
 * slovo „CIO" se po normalizaci hledá jako „cio", a to sedí uprostřed slova sta-CIO-nář.
 * Prošli tak pracovníci v sociálních službách („denní stacionář") i obsluha STACIOnárních
 * strojů — 69 ze 139 nezpracovaných inzerátů MPSV mimo obor. Krátká klíčová slova jsou na
 * tohle nejcitlivější a zrovna ta jsou v oboru běžná (CIO, IT).
 *
 * `norm()` zahazuje diakritiku a sjednocuje mezery, takže hranicí slova je cokoli mimo [a-z0-9].
 */
export function keywordHit(hay: string, keyword: string): boolean {
  // Test `k &&` nestačil: klíčové slovo ze samých mezer je truthy, ale norm(k) je ""
  // a prázdný vzor by propustil ÚPLNĚ VŠECHNO na AI skórování. Rozhoduje délka po normalizaci.
  const needle = norm(keyword);
  if (!needle.length) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay);
}

function keywordMatch(job: JobPosting, keywords: string[]): boolean {
  const hay = norm(`${job.title} ${job.description ?? ''}`);
  return keywords.some((k) => keywordHit(hay, k));
}

/**
 * Sedí inzerát na hledanou roli? CZ-ISCO prefix NEBO klíčové slovo.
 *
 * Zdroje `web:` a `jobs.cz` jsou předfiltrované samotným dotazem (hledá se cíleně),
 * takže projdou na hodnocení bez testu klíčových slov.
 *
 * **Oprava 31. 8. 2026 (tentýž den odpoledne):** propustka pro `jobs.cz` byla na pár hodin
 * zrušena s odůvodněním „z listovky napadalo 139 inzerátů mimo obor". To číslo bylo špatně
 * spočítané — vzniklo dotazem na inzeráty bez `CzIsco/133`, jenže inzeráty z jobs.cz nemají
 * CZ-ISCO **vůbec**, takže se do něj vešly všechny. Měření na 458 reálných záznamech ukázalo,
 * co by to stálo: 16 relevantních brněnských inzerátů by vypadlo, mimo jiné „IT Specialista /
 * Architekt — Druhý muž IT" (ARKYS, Brno, skóre 80), „Manažer kybernetické bezpečnosti",
 * „Senior IT konzultant" nebo „Správce ICT" na Masarykově univerzitě. Titulky z portálu totiž
 * skoro nikdy neznějí jako klíčové slovo ze seznamu.
 *
 * Šum z MPSV, kvůli kterému se to zpřísňovalo, měl jinou příčinu — hledání klíčového slova
 * podřetězcem („CIO" v slově sta-CIO-nář), viz `keywordHit`. Ta oprava platí dál.
 */
export function roleMatch(job: JobPosting, settings: Settings): boolean {
  if (job.source.startsWith('web:') || job.source === 'jobs.cz') return true;
  return iscoMatch(job.czIsco, settings.czIscoPrefixes) || keywordMatch(job, settings.keywords);
}

/**
 * Je inzerát prokazatelně mimo hledaný kraj?
 *
 * Region byl doteď jen strop skóre (`applyRegionGate`), tedy až PO ohodnocení. Na co nezbyl
 * rozpočet, zůstalo ve frontě bez skóre — a v historii se pak ukazovala Praha i všechny
 * ostatní kraje. Tvrdá kritéria patří do kódu a patří na vstup. Zahazuje se jen prokazatelné
 * `out`; `unknown` a `remote` zůstávají, ať se nepřijde o inzerát jen proto, že neuvedl lokalitu.
 */
export function regionRejected(job: JobPosting, settings: Settings): boolean {
  return checkRegion(job, settings.regionPriority).verdict === 'out';
}

export function prefilter(jobs: JobPosting[], settings: Settings): JobPosting[] {
  return jobs.filter((j) => roleMatch(j, settings) && !regionRejected(j, settings));
}
