import type { Env, JobPosting, Settings } from '../types';
import { norm, truncate } from '../util';

// Otevřené hledání „jako na Googlu" přes Serper.dev (Google Search API).
// Rychlé (~1–2 s/dotaz), paralelně. Vrací reálné Google výsledky (titul, odkaz, úryvek);
// odkaz = přímý proklik. Relevanci pak posoudí AI skórování v pipeline.
// Vyžaduje secret SERPER_API_KEY (zdarma na serper.dev). Bez něj se přeskočí.

interface Organic {
  title?: string;
  link?: string;
  snippet?: string;
}

function buildQueries(settings: Settings): string[] {
  const region =
    settings.regionPriority && settings.regionPriority.trim() ? settings.regionPriority : 'Česko';
  const kw = settings.keywords.filter(Boolean);
  const pick = (i: number, fb: string) => kw[i] ?? fb;
  return [
    `${pick(0, 'vedoucí IT')} práce nabídka ${region}`,
    `${pick(1, 'Head of IT')} pracovní nabídka Česko`,
    `${pick(2, 'IT manažer')} práce ${region}`,
  ];
}

async function serperSearch(key: string, q: string): Promise<Organic[]> {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, gl: 'cz', hl: 'cs', num: 10 }),
    });
    if (!res.ok) {
      console.warn(`Serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const data: any = await res.json();
    return (data?.organic ?? []) as Organic[];
  } catch (e) {
    console.warn('Serper:', e);
    return [];
  }
}

export async function fetchWeb(env: Env, settings: Settings): Promise<JobPosting[]> {
  const key = (env as unknown as Record<string, string>).SERPER_API_KEY;
  if (!key) {
    console.warn('Web: SERPER_API_KEY nenastaven — přeskakuji');
    return [];
  }

  const queries = buildQueries(settings);
  const results = await Promise.all(queries.map((q) => serperSearch(key, q)));

  const seen = new Set<string>();
  const out: JobPosting[] = [];
  for (const r of results.flat()) {
    if (!r.title || !r.link) continue;
    let host = '';
    try {
      host = new URL(r.link).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const key2 = norm(r.title) + '|' + host;
    if (seen.has(key2)) continue;
    seen.add(key2);
    // employer = část titulu za pomlčkou/svislítkem, jinak doména
    const emp = (r.title.split(/[-–|]/)[1] ?? '').trim();
    out.push({
      id: `web:${host}:${norm(r.title)}`.slice(0, 180),
      source: `web:${host}`,
      title: r.title.split(/[-–|]/)[0].trim() || r.title.trim(),
      employer: emp || host,
      url: r.link,
      description: truncate(r.snippet, 1000),
      isAgency: false,
    });
  }
  console.log(`Web (Serper): ${out.length} výsledků z ${queries.length} dotazů`);
  return out;
}
