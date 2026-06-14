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

export async function messagesCreate(env: Env, body: MessagesBody): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 800)}`);
  }
  return res.json();
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

/** Živá kontrola spojení na Anthropic (GET /v1/models — zdarma, ověří platnost klíče). */
export async function checkAnthropic(
  env: Env,
): Promise<{ configured: boolean; ok: boolean | null; status: number }> {
  if (!env.ANTHROPIC_API_KEY) return { configured: false, ok: null, status: 0 };
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    return { configured: true, ok: r.ok, status: r.status };
  } catch {
    return { configured: true, ok: false, status: 0 };
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
