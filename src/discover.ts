import type { Env } from './types';
import { messagesCreate, allText, extractJson } from './anthropic';
import { sourceKnown, insertSource } from './store';

// Dynamický screening: pro nově viděnou agenturu/firmu najde na internetu, KDE
// zveřejňuje pracovní nabídky (ATS / kariérní stránka), detekuje platformu a uloží
// do D1 `sources`. Znalost se buduje v čase — žádné statické adresy.

export interface SourceCandidate {
  name: string;
  ico?: string;
  kind: 'agency' | 'company';
}

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

const SYSTEM =
  'Zjisti, kde daná firma/agentura v ČR zveřejňuje pracovní nabídky. Pomocí web_search a ' +
  'web_fetch najdi (1) oficiální kariérní stránku a (2) pokud existuje, veřejné API jejich ' +
  'náborového systému (ATS). Rozpoznej platformu podle URL: Recruitee (*.recruitee.com), ' +
  'Greenhouse (boards.greenhouse.io/{slug}), Lever (jobs.lever.co/{slug}), Ashby ' +
  '(jobs.ashbyhq.com/{slug}), SmartRecruiters (jobs.smartrecruiters.com/{slug}). ' +
  'Ověř, že stránka skutečně patří danému subjektu (sídlo/IČO/ČR). ' +
  'Vrať POUZE jeden JSON objekt: {"careersUrl":string|null,"atsUrl":string|null,' +
  '"platform":"recruitee|greenhouse|lever|ashby|smartrecruiters|unknown","slug":string|null,' +
  '"confidence":0-100}. Když nic spolehlivého nenajdeš, platform="unknown".';

interface Resolved {
  careersUrl?: string | null;
  atsUrl?: string | null;
  platform?: string | null;
  slug?: string | null;
  confidence?: number;
}

const PLATFORMS = ['recruitee', 'greenhouse', 'lever', 'ashby', 'smartrecruiters'];

/** Detekuje platformu + slug z URL (zdroj pravdy nad tím, co řekne model). */
export function detectPlatform(url?: string | null): { platform: string; slug: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    if (host.endsWith('.recruitee.com')) return { platform: 'recruitee', slug: host.split('.')[0] };
    if (host.includes('greenhouse.io')) {
      const forParam = u.searchParams.get('for');
      if (forParam) return { platform: 'greenhouse', slug: forParam };
      if (parts[0] && parts[0] !== 'embed') return { platform: 'greenhouse', slug: parts[0] };
    }
    if (host.includes('lever.co') && parts[0]) return { platform: 'lever', slug: parts[0] };
    if (host.includes('ashbyhq.com') && parts[0]) return { platform: 'ashby', slug: parts[0] };
    if (host.includes('smartrecruiters.com') && parts[0])
      return { platform: 'smartrecruiters', slug: parts[0] };
  } catch {
    /* ignore */
  }
  return null;
}

async function resolveOne(env: Env, c: SourceCandidate): Promise<Resolved | null> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: `Subjekt: ${c.name}${c.ico ? ` (IČO ${c.ico})` : ''}` },
  ];
  let resp = await messagesCreate(env, {
    model: env.ENRICH_MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    tools: TOOLS,
    messages,
  });
  let guard = 0;
  while (resp?.stop_reason === 'pause_turn' && guard++ < 6) {
    messages.push({ role: 'assistant', content: resp.content });
    resp = await messagesCreate(env, {
      model: env.ENRICH_MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
  }
  return extractJson<Resolved>(allText(resp));
}

/**
 * Pro nově neznámé kandidáty zjistí zdroj a uloží. Omezeno `limit` na běh (cost control) —
 * znalost se doplňuje postupně napříč dny.
 */
export async function discoverSources(
  env: Env,
  candidates: SourceCandidate[],
  limit: number,
): Promise<number> {
  let added = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    if (added >= limit) break;
    if (!c.name) continue;
    const key = (c.ico || c.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (await sourceKnown(env, c.name, c.ico)) continue;
      const r = await resolveOne(env, c);
      if (!r) continue;
      const det =
        detectPlatform(r.atsUrl) ??
        (r.platform && r.slug && PLATFORMS.includes(r.platform)
          ? { platform: r.platform, slug: r.slug }
          : null);
      await insertSource(env, {
        name: c.name,
        ico: c.ico,
        kind: c.kind,
        platform: det?.platform ?? 'unknown',
        slug: det?.slug,
        endpoint: r.atsUrl ?? undefined,
        careersUrl: r.careersUrl ?? undefined,
        status: det ? 'active' : 'unresolved',
        confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      });
      added++;
    } catch (e) {
      console.warn(`discover ${c.name}:`, e);
    }
  }
  if (added) console.log(`Discovery: +${added} zdrojů`);
  return added;
}
