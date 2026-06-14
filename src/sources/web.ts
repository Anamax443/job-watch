import type { Env, JobPosting, Settings } from '../types';
import { messagesCreate, allText, extractJson } from '../anthropic';
import { norm, truncate } from '../util';

// Otevřený zdroj: hledání inzerátů podle ROLE napříč celým webem (ne pevný seznam).
// Inzeráty mohou být kdekoliv → Sonnet + web_search/web_fetch hledá obecně (jako Google),
// vyhodnotí výsledky a vrátí reálné aktuální pozice. Ty pak jdou do stejné pipeline.

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

interface WebHit {
  title?: string;
  employer?: string;
  location?: string;
  url?: string;
  description?: string;
  source?: string;
}

export async function fetchWeb(env: Env, settings: Settings): Promise<JobPosting[]> {
  const kw = settings.keywords.slice(0, 10).join(', ');
  const region = settings.regionPriority ? ` Priorita region: ${settings.regionPriority}.` : '';

  const system =
    'Jsi vyhledávač pracovních inzerátů. Pomocí web_search a web_fetch najdi AKTUÁLNÍ veřejné ' +
    'inzeráty práce v ČR odpovídající profilu řídící / seniorní architektonické IT role. ' +
    'Hledej OBECNĚ kdekoliv na webu (jako Google) — jobboardy, agregátory, firemní kariérní ' +
    'stránky, LinkedIn, oborové weby… nespoléhej na předem daný seznam. Vyhodnoť výsledky a ' +
    'vrať jen reálné, momentálně otevřené pozice (ne staré/zrušené, ne duplicity). ' +
    'Vrať POUZE jeden JSON objekt: {"jobs":[{"title":string,"employer":string,"location":string,' +
    '"url":string,"description":string,"source":string}]} — source = doména zdroje. Max 25 položek.';

  const user = `Profil (klíčová slova): ${kw}.${region} Najdi co nejvíc relevantních aktuálních inzerátů kdekoliv na internetu.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: user },
  ];

  try {
    let resp = await messagesCreate(env, {
      model: env.ENRICH_MODEL,
      max_tokens: 4000,
      system,
      tools: TOOLS,
      messages,
    });
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

    const parsed = extractJson<{ jobs?: WebHit[] }>(allText(resp));
    const hits = parsed?.jobs ?? [];
    const out: JobPosting[] = [];
    for (const h of hits) {
      if (!h.title || !h.url) continue;
      let host = h.source ?? '';
      try {
        host = new URL(h.url).hostname.replace(/^www\./, '');
      } catch {
        /* ponech h.source */
      }
      out.push({
        id: `web:${host}:${norm(h.title)}:${norm(h.employer)}`.slice(0, 180),
        source: `web:${host || 'web'}`,
        title: String(h.title).trim(),
        employer: String(h.employer ?? '').trim() || host || 'web',
        location: h.location,
        url: h.url,
        description: truncate(h.description, 4000),
        isAgency: false,
      });
    }
    console.log(`Web search: ${out.length} inzerátů`);
    return out;
  } catch (e) {
    console.warn('Web search:', e);
    return [];
  }
}
