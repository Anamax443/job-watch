import type { Env, JobPosting, Settings } from '../types';
import { num } from '../util';

// Deterministický zdroj jobs.cz (LMC): stáhne veřejnou listovací stránku hledání
// a vytáhne z ní KONKRÉTNÍ inzeráty (každý jako /rpd/<id> detail), ne seznam.
// Surový fetch funguje (jobs.cz nevrací bot-stěnu, vrací server-rendered HTML
// s kartami SearchResultCard). Žádný LLM → rychlé a levné, fit do rozpočtu běhu.
// Adzuna v ČR jobs.cz neindexuje a generické web hledání vrací jen kategorie/listy.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dotazy na listovku: top klíčová slova z Nastavení (jinak rozumný default),
 * filtrované na region z Nastavení (regionPriority → locality[label]+radius),
 * takže se hledá tam, kde má — ne po celé ČR.
 */
function buildListingUrls(settings: Settings): string[] {
  const kw = settings.keywords.filter(Boolean).slice(0, 4);
  const terms = kw.length ? kw : ['vedoucí IT', 'IT manažer', 'Head of IT'];
  // Region NEfiltrujeme na URL (jobs.cz `locality[label]` v query stejně ignoruje).
  // Lokalitu posuzuje AI ve scoringu — pozice mimo region drží pod prahem. Stahujeme
  // širší vzorek, ať nezahodíme remote/hybrid role mimo region. AI má poslední slovo.
  return terms.map((t) => `https://www.jobs.cz/prace/?q[]=${encodeURIComponent(t)}`);
}

/** Vytáhne mzdové rozpětí z textu typu "80 000 – 100 000 Kč" / "od 60 000 Kč". */
function parseSalary(text: string): { from?: number; to?: number } {
  const nums = (text.replace(/\s/g, '').match(/\d{4,7}/g) ?? []).map(Number);
  if (!nums.length) return {};
  if (nums.length === 1) return { from: nums[0] };
  return { from: Math.min(nums[0], nums[1]), to: Math.max(nums[0], nums[1]) };
}

/** Rozparsuje HTML listovky na jednotlivé inzeráty (karty SearchResultCard). */
export function parseListing(html: string): JobPosting[] {
  const out: JobPosting[] = [];
  const cards = html.split('<article').slice(1);
  for (const card of cards) {
    const id = /data-jobad-id="(\d+)"/.exec(card)?.[1];
    if (!id) continue;
    const title = stripTags(/data-test-ad-title="([^"]*)"/.exec(card)?.[1] ?? '');
    if (!title) continue;
    const employer = stripTags(/<span translate="no">([\s\S]*?)<\/span>/.exec(card)?.[1] ?? '');
    const location =
      stripTags(/data-test="serp-locality"[^>]*>([\s\S]*?)<\/li>/.exec(card)?.[1] ?? '') || undefined;
    const sal = parseSalary(stripTags(/data-test="serp-salary"[^>]*>([\s\S]*?)<\/li>/.exec(card)?.[1] ?? ''));
    out.push({
      id: `jobscz:${id}`,
      source: 'jobs.cz',
      title,
      employer: employer || 'jobs.cz',
      location,
      salaryFrom: num(sal.from),
      salaryTo: num(sal.to),
      url: `https://www.jobs.cz/rpd/${id}/`,
      isAgency: false, // agencies.ts dorovná podle zaměstnavatele
    });
  }
  return out;
}

export async function fetchJobsCz(env: Env, settings: Settings, log?: (msg: string) => void): Promise<JobPosting[]> {
  const urls = buildListingUrls(settings);
  const statuses: string[] = []; // komunikační stopa: HTTP stav každé listovky
  const pages = await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await fetch(u, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'cs', Accept: 'text/html' },
        });
        statuses.push(String(res.status));
        if (!res.ok) {
          console.warn(`jobs.cz ${res.status}: ${u}`);
          return [] as JobPosting[];
        }
        return parseListing(await res.text());
      } catch (e) {
        console.warn('jobs.cz:', e);
        statuses.push('chyba');
        return [] as JobPosting[];
      }
    }),
  );

  const seen = new Set<string>();
  const out: JobPosting[] = [];
  for (const j of pages.flat()) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  log?.(`📡 www.jobs.cz: ${urls.length} listovek → ${statuses.join(',')} → ${out.length} inzerátů`);
  console.log(`jobs.cz: ${out.length} konkrétních inzerátů z ${urls.length} dotazů`);
  return out;
}
