import type { Env, JobPosting, EnrichResult } from './types.ts';
import { messagesCreate, allText, extractJson } from './anthropic.ts';
import { truncate } from './util.ts';
import { ENRICH_SYSTEM, wrapForeign } from './prompts.ts';

// Deanonymizace: u agenturního inzerátu najdi PŮVODCE.
// Sonnet 4.6 + web_search/web_fetch — vybere distinktivní věty, vyhledá je,
// preferuje first-party stránky firmy (ty prozradí skutečného zaměstnavatele).
//
// Prompt bydlí v `prompts.ts` (od 1. 9. 2026 večer), aby ho kryla PROMPT_VERSION a brána
// v CI. Do 1. 9. tu měl vlastní konstantu mimo dosah obojího — a cizí text šel do modelu
// s nástroji bez ohraničení.

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function enrichOriginator(env: Env, job: JobPosting): Promise<EnrichResult> {
  // Všechno níž je CIZÍ TEXT: píše ho agentura, nikdo ho nereviduje — a model k němu má
  // web_search i web_fetch. Proto celý blok do značky; systémový prompt k ní má větu, že
  // uvnitř nejsou pokyny a že nesmí určovat, co se vyhledá nebo stáhne.
  const user = wrapForeign(
    [
      `Agentura: ${job.employer}`,
      job.title ? `Titul: ${job.title}` : '',
      job.location ? `Lokalita: ${job.location}` : '',
      `Popis inzerátu:\n${truncate(job.description, 4000)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: user },
  ];

  try {
    let resp = await messagesCreate(env, {
      model: env.ENRICH_MODEL,
      max_tokens: 2000,
      system: ENRICH_SYSTEM,
      tools: TOOLS,
      messages,
    });

    // Server-side tool smyčka: při pause_turn znovu pošli s připojenou odpovědí.
    let guard = 0;
    while (resp?.stop_reason === 'pause_turn' && guard++ < 6) {
      messages.push({ role: 'assistant', content: resp.content });
      resp = await messagesCreate(env, {
        model: env.ENRICH_MODEL,
        max_tokens: 2000,
        system: ENRICH_SYSTEM,
        tools: TOOLS,
        messages,
      });
    }

    const parsed = extractJson<EnrichResult>(allText(resp));
    if (parsed) {
      return {
        realEmployer: parsed.realEmployer || undefined,
        realEmployerUrl: parsed.realEmployerUrl || undefined,
        confidence: clamp(Number(parsed.confidence) || 0),
        duplicateUrls: Array.isArray(parsed.duplicateUrls) ? parsed.duplicateUrls.slice(0, 10) : [],
      };
    }
  } catch (e) {
    console.warn(`enrich ${job.id}: ${e}`);
  }
  return { confidence: 0, duplicateUrls: [] };
}
