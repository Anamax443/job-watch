import type { JobPosting, Settings } from './types';
import { norm } from './util';

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
  return keywords.some((k) => k && hay.includes(norm(k)));
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
