import type { Env, Settings } from './types.ts';

/**
 * Přepínatelný AI backend „dle úhrady" — stejný princip jako FIO-import.
 *
 *   - `workers-ai`  — Cloudflare Workers AI, Llama 3.1 8B (ZDARMA, nativní binding,
 *                     data neopustí Cloudflare; free 10k neuronů/den). Výchozí.
 *   - `anthropic`   — Claude Haiku/Sonnet (placený, přesnější + jediný umí web-výzkum).
 *
 * Výběr řídí efektivní provider (Nastavení → `settings.aiProvider`, jinak `env.AI_PROVIDER`):
 *   ''/auto      → ZDARMA (Workers AI) primárně, placený jen jako fallback (default „co má Cloudflare").
 *   'workers-ai' → jen zdarma (žádné placené volání).
 *   'anthropic'  → placený primárně, zdarma jako fallback.
 *   'off'        → AI vypnutá úplně.
 *
 * POZOR: deanonymizace agentur (enrich.ts) a screening zdrojů (discover.ts) běží přes
 * Anthropic serverové nástroje `web_search`/`web_fetch` — ty Workers AI NEUMÍ. Proto tyto
 * dvě funkce řídí zvlášť `webResearchEnabled()` a při free/off režimu se přeskočí.
 */

export type AiProvider = 'anthropic' | 'workers-ai';

/**
 * Free backend — malý instruct model, JSON přes prompt (ověřeno u FIO-import na stejném
 * účtu). `-fp8` je jediná dostupná varianta 3.1-8B v katalogu; 8B je levné na neurony,
 * takže i plná dávka skórování zůstane ve free 10k/den.
 */
export const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/** Povolené hodnoty přepínače (UI i sanitizace). '' = podle serveru (auto). */
export const AI_PROVIDER_VALUES = ['', 'workers-ai', 'anthropic', 'off'] as const;

/** Kontext pro rozhodování — z env + nastavení. */
export interface AiCtx {
  /** Efektivní `AI_PROVIDER`: '' | 'workers-ai' | 'anthropic' | 'off'. */
  provider?: string;
  /** `ANTHROPIC_API_KEY` — placený backend. */
  anthropicKey?: string;
  /** Workers AI binding (`env.AI`) — free backend. */
  ai?: Ai;
}

/** Efektivní provider: volba v Nastavení (D1) přebíjí env default. */
export function effectiveProvider(env: Env, settings?: Settings): string {
  const fromSettings = (settings?.aiProvider ?? '').trim();
  if (fromSettings) return fromSettings.toLowerCase();
  return (env.AI_PROVIDER ?? '').trim().toLowerCase();
}

/** Kontext z env + settings (jedno místo, ať health i pipeline počítají stejně). */
export function ctxFrom(env: Env, settings?: Settings): AiCtx {
  return { provider: effectiveProvider(env, settings), anthropicKey: env.ANTHROPIC_API_KEY, ai: env.AI };
}

/**
 * Pořadí backendů pro SKÓROVÁNÍ. Default „co má Cloudflare" = zdarma primárně,
 * placený jen jako záchrana, když free binding chybí / spadne.
 */
export function providerChain(ctx: AiCtx): AiProvider[] {
  const pref = (ctx.provider ?? '').trim().toLowerCase();
  const hasAnthropic = Boolean(ctx.anthropicKey);
  const hasWorkers = Boolean(ctx.ai);

  const paidThenFree: AiProvider[] = [
    ...(hasAnthropic ? (['anthropic'] as const) : []),
    ...(hasWorkers ? (['workers-ai'] as const) : []),
  ];

  if (pref === 'off') return [];
  if (pref === 'workers-ai') return hasWorkers ? ['workers-ai'] : [];
  if (pref === 'anthropic') return paidThenFree; // placený, s free fallbackem (resilience)
  // auto = ZDARMA a nikdy sám neutrácej: Workers AI, a jen když binding chybí, spadni na Claude.
  return hasWorkers ? ['workers-ai'] : hasAnthropic ? ['anthropic'] : [];
}

/**
 * Smí běžet web-výzkum (deanonymizace agentur + screening zdrojů)? Umí ho jen Anthropic
 * (`web_search`/`web_fetch`) a je PLACENÝ i POMALÝ (multi-turn, klidně desítky sekund).
 * Proto ho spouštíme JEN když uživatel výslovně zvolí placený backend ('anthropic').
 * Default (auto/free/off) ho nespouští — ušetří čas běhu i peníze a nezdržuje smyčku
 * zbytečnými (u účtu bez kreditu stejně selhávajícími) voláními.
 */
export function webResearchEnabled(ctx: AiCtx): boolean {
  const pref = (ctx.provider ?? '').trim().toLowerCase();
  if (pref === 'anthropic') return Boolean(ctx.anthropicKey);
  return false;
}

/** Vytáhne první úplný {...} JSON objekt z textu (Workers AI ho občas obalí prózou/```). */
export function extractFirstJson<T = any>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Zavolá Workers AI a vrátí naparsovaný JSON objekt. Free backend nemá structured
 * outputs, takže JSON vynucujeme promptem + temperature 0 a jsme tolerantní při parsování.
 */
export async function runWorkersJson<T = any>(
  ai: Ai,
  system: string,
  user: string,
  maxTokens = 512,
): Promise<T> {
  const sys = `${system}\n\nOdpověz VÝHRADNĚ jedním JSON objektem dle popisu — bez markdownu, bez uvozovacího textu, bez komentáře.`;
  const res = (await ai.run(WORKERS_AI_MODEL, {
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  })) as { response?: string };
  const obj = extractFirstJson<T>(res.response ?? '');
  if (obj == null) throw new Error('Workers AI nevrátila JSON');
  return obj;
}

/** Lidský štítek backendu do hlavičky/logu. */
export function providerLabel(p: AiProvider | null): string {
  if (p === 'workers-ai') return '⚡ Cloudflare Workers AI (zdarma)';
  if (p === 'anthropic') return 'Claude (placené)';
  return 'AI vypnutá';
}
