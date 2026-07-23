import type { Env } from './types';

// Tenký klient nad Anthropic Messages API (raw fetch — idiomatic pro Cloudflare Worker).
// Endpoint a hlavičky dle https://api.anthropic.com/v1/messages.

export interface AnthropicTool {
  type: string;
  name: string;
  [k: string]: unknown;
}

export interface MessagesBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools?: AnthropicTool[];
  output_config?: unknown;
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 429 (rate limit) a 5xx/529 (overloaded) jsou přechodné → krátký retry s backoffem.
// Bez něj paralelní scoring/doskórování spadne hromadně na 429 (relevance 0).
const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export async function messagesCreate(env: Env, body: MessagesBody): Promise<any> {
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      // Pojistka proti zaseknutí běhu — jeden dotaz (i pomalý web_search) nesmí viset donekonečna.
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) return res.json();

    const t = await res.text();
    lastErr = `Anthropic ${res.status}: ${t.slice(0, 400)}`;
    if (!RETRYABLE.has(res.status) || attempt === 3) break;
    // Respektuj Retry-After (s), jinak exponenciální backoff (0.5/1/2 s) — strop, ať
    // se to vejde do rozpočtu běhu.
    const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 500 * 2 ** attempt;
    await sleep(wait);
  }
  throw new Error(lastErr);
}

/** První textový blok z odpovědi (structured outputs garantují validní JSON v textu). */
export function firstText(resp: any): string {
  const blocks = resp?.content ?? [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return '';
}

/** Sloučí všechny textové bloky (užitečné u odpovědí s tool-use mezikroky). */
export function allText(resp: any): string {
  const blocks = resp?.content ?? [];
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

export interface AnthropicHealth {
  configured: boolean;
  ok: boolean | null;
  status: number;
  /** Příčina selhání: no_credit | auth | network | other. */
  reason?: 'no_credit' | 'auth' | 'network' | 'other';
  detail?: string;
}

/**
 * Živá kontrola, že AI reálně poběží.
 *
 * POZOR: `GET /v1/models` je zdarma a projde i s prázdným kreditem — takže by
 * hlásil „ok", i když skutečné skórování padá na „credit balance too low".
 * Proto se posílá minimální dotaz (max_tokens 1) přes stejnou billable cestu
 * jako scoring. Cena je zanedbatelná (~1 token Haiku na kontrolu).
 */
export async function checkAnthropic(env: Env): Promise<AnthropicHealth> {
  if (!env.ANTHROPIC_API_KEY) return { configured: false, ok: null, status: 0 };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.SCORE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    });
    if (r.ok) return { configured: true, ok: true, status: r.status };

    const body = await r.text();
    const reason: AnthropicHealth['reason'] = /credit balance/i.test(body)
      ? 'no_credit'
      : r.status === 401 || /authentication|x-api-key|invalid api key/i.test(body)
        ? 'auth'
        : 'other';
    return { configured: true, ok: false, status: r.status, reason, detail: body.slice(0, 300) };
  } catch {
    return { configured: true, ok: false, status: 0, reason: 'network' };
  }
}

/** Vytáhne poslední {...} JSON objekt z textu (fallback parser). */
export function extractJson<T = any>(text: string): T | null {
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
