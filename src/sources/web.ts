import type { Env, JobPosting, Settings } from '../types';
import { num, truncate } from '../util';

// Otevřený web zdroj přes Adzuna Job API (https://developer.adzuna.com) — vrací KONKRÉTNÍ
// jednotlivé inzeráty jako data (firma, lokalita, mzda, přímý odkaz), ne seznamy.
// Paralelní dotazy. Vyžaduje secrety ADZUNA_APP_ID + ADZUNA_APP_KEY (free). Bez nich se přeskočí.

function buildQueries(settings: Settings): Array<{ what: string; where: string }> {
  const where =
    settings.regionPriority && settings.regionPriority.trim() ? settings.regionPriority.trim() : '';
  const kw = settings.keywords.filter(Boolean);
  const pick = (i: number, fb: string) => kw[i] ?? fb;
  return [
    { what: pick(0, 'vedoucí IT'), where },
    { what: pick(1, 'Head of IT'), where: '' },
    { what: pick(2, 'IT manažer'), where },
  ];
}

async function adzunaSearch(
  id: string,
  key: string,
  what: string,
  where: string,
): Promise<any[]> {
  const params = new URLSearchParams({
    app_id: id,
    app_key: key,
    results_per_page: '20',
    what,
    'content-type': 'application/json',
  });
  if (where) params.set('where', where);
  try {
    const res = await fetch(`https://api.adzuna.com/v1/api/jobs/cz/search/1?${params.toString()}`);
    if (!res.ok) {
      console.warn(`Adzuna ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const data: any = await res.json();
    return data?.results ?? [];
  } catch (e) {
    console.warn('Adzuna:', e);
    return [];
  }
}

const strip = (s: unknown) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export async function fetchWeb(env: Env, settings: Settings): Promise<JobPosting[]> {
  const e = env as unknown as Record<string, string>;
  const id = e.ADZUNA_APP_ID;
  const key = e.ADZUNA_APP_KEY;
  if (!id || !key) {
    console.warn('Web: ADZUNA_APP_ID/KEY nenastaveny — přeskakuji');
    return [];
  }

  const queries = buildQueries(settings);
  const results = await Promise.all(queries.map((q) => adzunaSearch(id, key, q.what, q.where)));

  const seen = new Set<string>();
  const out: JobPosting[] = [];
  for (const r of results.flat()) {
    const rid = r?.id ?? r?.redirect_url;
    if (!rid || !r?.title) continue;
    const skey = String(rid);
    if (seen.has(skey)) continue;
    seen.add(skey);
    out.push({
      id: `web:adzuna:${skey}`.slice(0, 180),
      source: 'web:adzuna',
      title: strip(r.title) || 'inzerát',
      employer: r.company?.display_name ?? 'web',
      location: r.location?.display_name,
      salaryFrom: num(r.salary_min),
      salaryTo: num(r.salary_max),
      url: r.redirect_url,
      description: truncate(strip(r.description), 2000),
      datePosted: r.created,
      isAgency: false,
    });
  }
  console.log(`Web (Adzuna): ${out.length} konkrétních inzerátů z ${queries.length} dotazů`);
  return out;
}
