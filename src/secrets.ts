import type { Env } from './types';
import { getMeta, setMeta } from './config';

// Správa klíčů/přístupů editovatelná z UI (uloženo v D1 meta pod 'secret:NAME').
// Kód čte přednostně hodnotu z D1, jinak spadne na Worker secret (env). Tím jde
// klíč vyměnit přes stránku (např. po expiraci) bez redeploye.

export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'GRAPH_MAILBOX',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const PREFIX = 'secret:';

export async function loadD1Secrets(env: Env): Promise<Partial<Record<SecretKey, string>>> {
  const keys = SECRET_KEYS.map((k) => PREFIX + k);
  const placeholders = keys.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Partial<Record<SecretKey, string>> = {};
  for (const r of rows.results ?? []) {
    const name = r.key.slice(PREFIX.length) as SecretKey;
    if (r.value) out[name] = r.value;
  }
  return out;
}

/** Vrátí env s hodnotami klíčů přepsanými z D1 (kde existují). */
export async function resolveEnv(env: Env): Promise<Env> {
  const d1 = await loadD1Secrets(env);
  return { ...env, ...d1 } as Env;
}

export async function setSecret(env: Env, name: SecretKey, value: string): Promise<void> {
  await setMeta(env, PREFIX + name, value);
}

/** Stav každého klíče — nikdy nevrací hodnotu, jen jestli a odkud je nastavený. */
export async function secretStatus(
  env: Env,
): Promise<Record<string, { set: boolean; source: 'ui' | 'secret' | 'none' }>> {
  const d1 = await loadD1Secrets(env);
  const out: Record<string, { set: boolean; source: 'ui' | 'secret' | 'none' }> = {};
  for (const k of SECRET_KEYS) {
    if (d1[k]) out[k] = { set: true, source: 'ui' };
    else if ((env as unknown as Record<string, string>)[k]) out[k] = { set: true, source: 'secret' };
    else out[k] = { set: false, source: 'none' };
  }
  return out;
}
