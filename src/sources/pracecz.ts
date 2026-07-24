import type { Env, JobPosting, Settings } from '../types';
import { stripHtml } from '../util';

// Zdroj prace.cz (LMC, sesterský k jobs.cz): stáhne listovku hledání a vytáhne
// konkrétní inzeráty (/nabidka/<uuid>). POZOR: hledání na prace.cz je VOLNÉ
// (na "vedoucí IT" vrací i nesouvisející "vedoucí" role) a region filtr ignoruje
// — proto tenhle zdroj NEobchází prefilter (klíčová slova šum odříznou) a dedup
// (store.ts) řeší překryv s jobs.cz. Surový fetch funguje (200, server-rendered).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function buildListingUrls(settings: Settings): string[] {
  const kw = settings.keywords.filter(Boolean).slice(0, 4);
  const terms = kw.length ? kw : ['vedoucí IT', 'IT manažer', 'Head of IT'];
  return terms.map((t) => `https://www.prace.cz/nabidky/?q[]=${encodeURIComponent(t)}`);
}

/** Rozparsuje HTML listovky prace.cz na jednotlivé inzeráty (karty JobCard). */
export function parseListing(html: string): JobPosting[] {
  const out: JobPosting[] = [];
  const cards = html.split('data-testid="advert-link"').slice(1);
  for (const card of cards) {
    const href = /href="(\/nabidka\/[^"?]+)/.exec(card)?.[1];
    if (!href) continue;
    const id = /\/nabidka\/([^/?]+)/.exec(href)?.[1];
    if (!id) continue;
    const title = stripHtml(/^[^>]*>([^<]+)</.exec(card)?.[1] ?? '');
    if (!title) continue;
    const employer = stripHtml(/Název firmy<!-- -->:<\/span><span[^>]*>([^<]+)/.exec(card)?.[1] ?? '');
    const location = stripHtml(/Lokalita<!-- -->:<\/span><span[^>]*>([^<]+)/.exec(card)?.[1] ?? '') || undefined;
    out.push({
      id: `pracecz:${id}`,
      source: 'prace.cz',
      title,
      employer: employer || 'prace.cz',
      location,
      url: `https://www.prace.cz/nabidka/${id}/`,
      isAgency: false, // agencies.ts dorovná dle zaměstnavatele
    });
  }
  return out;
}

export async function fetchPraceCz(env: Env, settings: Settings, log?: (msg: string) => void): Promise<JobPosting[]> {
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
          console.warn(`prace.cz ${res.status}: ${u}`);
          return [] as JobPosting[];
        }
        return parseListing(await res.text());
      } catch (e) {
        console.warn('prace.cz:', e);
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
  log?.(`📡 www.prace.cz: ${urls.length} listovek → ${statuses.join(',')} → ${out.length} inzerátů (projdou prefilterem)`);
  console.log(`prace.cz: ${out.length} inzerátů z ${urls.length} dotazů (projdou prefilterem)`);
  return out;
}
