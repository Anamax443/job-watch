import type { JobPosting, Settings } from './types.ts';
import { norm } from './util.ts';

// Levný filtr před LLM: projde inzerát, když sedí CZ-ISCO prefix NEBO klíčové slovo.
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

function keywordMatch(job: JobPosting, keywords: string[]): boolean {
  const hay = norm(`${job.title} ${job.description ?? ''}`);
  return keywords.some((k) => {
    // Test `k &&` nestačil: klíčové slovo ze samých mezer je truthy, ale norm(k) je ""
    // a `hay.includes('')` je vždy true → filtr by tiše propustil ÚPLNĚ VŠECHNO na AI
    // skórování (a spálil denní rozpočet). Rozhoduje délka po normalizaci, ne surová hodnota.
    const needle = norm(k);
    return needle.length > 0 && hay.includes(needle);
  });
}

export function prefilter(jobs: JobPosting[], settings: Settings): JobPosting[] {
  return jobs.filter(
    (j) =>
      // cílené zdroje (web hledání + jobs.cz listovka dle dotazu) jsou už
      // předfiltrované samotným dotazem → rovnou na AI scoring
      j.source.startsWith('web:') ||
      j.source === 'jobs.cz' ||
      iscoMatch(j.czIsco, settings.czIscoPrefixes) ||
      keywordMatch(j, settings.keywords),
  );
}
