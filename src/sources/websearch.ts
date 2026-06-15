import type { Env, JobPosting, Settings } from '../types';
import { messagesCreate, allText } from '../anthropic';
import { num, truncate, stripHtml } from '../util';

// Otevřené hledání KONKRÉTNÍCH inzerátů přes Anthropic web_search + web_fetch.
// Pokrývá portály, které Adzuna v ČR neindexuje — především jobs.cz (LMC), ale i
// prace.cz, Indeed, LinkedIn, startupjobs. Model najde jednotlivé inzeráty (ne
// seznamy/stránkování) odpovídající profilu a vrátí je jako strukturovaná data.

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

// Hlavní cíle hledání — jobs.cz první, protože právě ten Adzuna míjí.
const PORTALS = ['jobs.cz', 'prace.cz', 'cz.indeed.com', 'linkedin.com/jobs', 'startupjobs.cz'];

interface RawJob {
  title?: string;
  employer?: string;
  location?: string;
  salary_from?: unknown;
  salary_to?: unknown;
  url?: string;
  description?: string;
  date_posted?: string;
  is_agency?: boolean;
}

/** Outermost JSON objekt z textu (od prvního „{" po poslední „}") — robustní i pro pole uvnitř. */
function parseJsonObject<T = any>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function buildSystem(): string {
  return (
    'Jsi vyhledávač pracovních inzerátů. Pomocí web_search (jako Google) a web_fetch najdi ' +
    'AKTUÁLNÍ KONKRÉTNÍ jednotlivé inzeráty volných míst v ČR odpovídající zadaným klíčovým slovům. ' +
    `Hledej zejména na: ${PORTALS.join(', ')}. Použij i cílené dotazy "site:jobs.cz <pozice>". ` +
    'DŮLEŽITÉ: vracej jen URL JEDNOTLIVÝCH inzerátů (detail nabídky), NE seznamy/výsledkové ' +
    'stránky, stránkování ani kategorie (žádné „Stránka 13", „Nabídky práce …"). U jobs.cz je ' +
    'detail typicky /rpd/<id>/. Když si nejsi jistý poli, ověř detail přes web_fetch. ' +
    'Vrať POUZE jeden JSON objekt ve tvaru: {"jobs":[{"title":string,"employer":string,' +
    '"location":string|null,"salary_from":number|null,"salary_to":number|null,"url":string,' +
    '"description":string|null,"date_posted":string|null,"is_agency":boolean}]}. ' +
    'Bez komentářů, bez markdownu. Když nic nenajdeš, vrať {"jobs":[]}.'
  );
}

function buildUserMessage(settings: Settings): string {
  const kw = settings.keywords.filter(Boolean).slice(0, 8);
  const region = settings.regionPriority?.trim();
  const parts = [
    `Klíčová slova / pozice: ${kw.length ? kw.join(', ') : 'vedoucí IT, Head of IT, IT manažer'}.`,
  ];
  if (region) parts.push(`Preferovaný region: ${region} (ale ber i celou ČR / remote).`);
  parts.push('Najdi co nejvíc relevantních konkrétních inzerátů (klidně 10–20).');
  return parts.join(' ');
}

export async function fetchWebSearch(env: Env, settings: Settings): Promise<JobPosting[]> {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn('WebSearch: ANTHROPIC_API_KEY nenastaven — přeskakuji');
    return [];
  }

  const system = buildSystem();
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: buildUserMessage(settings) },
  ];

  let resp = await messagesCreate(env, {
    model: env.ENRICH_MODEL,
    max_tokens: 4000,
    system,
    tools: TOOLS,
    messages,
  });
  // web_search/web_fetch běží jako server-side tooly → model se vrací s pause_turn,
  // dokud nedohledá. Stejný vzor jako discover.ts; strop kvůli ceně i času.
  let guard = 0;
  while (resp?.stop_reason === 'pause_turn' && guard++ < 8) {
    messages.push({ role: 'assistant', content: resp.content });
    resp = await messagesCreate(env, {
      model: env.ENRICH_MODEL,
      max_tokens: 4000,
      system,
      tools: TOOLS,
      messages,
    });
  }

  const parsed = parseJsonObject<{ jobs?: RawJob[] }>(allText(resp));
  const raw = parsed?.jobs ?? [];

  const seen = new Set<string>();
  const out: JobPosting[] = [];
  for (const r of raw) {
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    if (!url || !r?.title) continue;
    // jen reálné detaily inzerátů; vyhoď zjevné seznamy/stránkování
    if (/\/(hledat|search|nabidky-prace|jobs)\b/i.test(url) && !/\/rpd\//i.test(url)) continue;
    const skey = url.toLowerCase();
    if (seen.has(skey)) continue;
    seen.add(skey);
    let host = 'web';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* ponech 'web' */
    }
    out.push({
      id: `web:search:${skey}`.slice(0, 180),
      source: `web:search:${host}`,
      title: stripHtml(r.title) || 'inzerát',
      employer: stripHtml(r.employer) || host,
      location: r.location ? stripHtml(r.location) : undefined,
      salaryFrom: num(r.salary_from),
      salaryTo: num(r.salary_to),
      url,
      description: truncate(stripHtml(r.description), 2000),
      datePosted: r.date_posted || undefined,
      isAgency: r.is_agency === true,
    });
  }
  console.log(`WebSearch: ${out.length} konkrétních inzerátů (vč. jobs.cz)`);
  return out;
}
