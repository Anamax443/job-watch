import type { Env, Settings } from './types.ts';
import { norm } from './util.ts';
import { AI_PROVIDER_VALUES } from './ai.ts';

// Výchozí nastavení. Editovatelné v UI /settings (ukládá se do D1, klíč 'settings').
export const DEFAULT_SETTINGS: Settings = {
  keywords: [
    'vedoucí IT',
    'vedoucí informatiky',
    'IT manažer',
    'IT manager',
    'Head of IT',
    'IT ředitel',
    'vedoucí oddělení IT',
    'Solution Architect',
    'IT lead',
    'IT architekt',
    'vedoucí vývoje',
  ],
  // 133 = Řídící pracovníci v oblasti ICT (hlavní cíl). Přidej '25' pro širší záběr (specialisté ICT).
  czIscoPrefixes: ['133'],
  regionPriority: 'Jihomoravský kraj',
  notifyThreshold: 70,
  minScore: 0,
  emailTo: '',
  telegramChatId: '',
  notifyEmail: true,
  notifyTelegram: true,
  notifySlack: false,
  profile: '',
  aiProvider: '', // '' = podle serveru (default zdarma Cloudflare Workers AI)
};


/**
 * Očista vstupu z API před uložením do Nastavení. Bydlí u nastavení (ne v routeru), aby
 * šla otestovat bez Workeru — je to jediná obrana mezi cizím JSONem a tím, co pak řídí
 * pipeline. Neznámá pole se zahazují, čísla se zastropují, prázdné hodnoty vyhazují.
 */
export function sanitizeSettings(input: any): Partial<Settings> {
  const out: Partial<Settings> = {};
  const arr = (v: any) =>
    Array.isArray(v) ? v.map((s: any) => String(s).trim()).filter(Boolean) : undefined;
  const pct = (v: any) => Math.max(0, Math.min(100, parseInt(v, 10) || 0));
  if (arr(input?.keywords)) out.keywords = arr(input.keywords);
  if (arr(input?.czIscoPrefixes)) out.czIscoPrefixes = arr(input.czIscoPrefixes);
  if (typeof input?.regionPriority === 'string') out.regionPriority = input.regionPriority.trim();
  if (input?.notifyThreshold != null) out.notifyThreshold = pct(input.notifyThreshold);
  if (input?.minScore != null) out.minScore = pct(input.minScore);
  if (typeof input?.emailTo === 'string') out.emailTo = input.emailTo.trim();
  if (typeof input?.telegramChatId === 'string') out.telegramChatId = input.telegramChatId.trim();
  if (typeof input?.notifyEmail === 'boolean') out.notifyEmail = input.notifyEmail;
  if (typeof input?.notifyTelegram === 'boolean') out.notifyTelegram = input.notifyTelegram;
  if (typeof input?.notifySlack === 'boolean') out.notifySlack = input.notifySlack;
  if (typeof input?.profile === 'string') out.profile = input.profile;
  if (typeof input?.aiProvider === 'string') {
    const v = input.aiProvider.trim().toLowerCase();
    if ((AI_PROVIDER_VALUES as readonly string[]).includes(v)) out.aiProvider = v;
  }
  return out;
}

// --- ATS watchlist -------------------------------------------------------
// ŽÁDNÉ statické adresy. Cíle ATS se objevují DYNAMICKY (src/discover.ts) a ukládají
// do D1 tabulky `sources`; ats.ts je odtud čte. AtsTarget je v src/types.ts.

// --- Klasifikace agentur -------------------------------------------------
// Fallback dle názvu zaměstnavatele, dokud se nenapojí registr agentur práce (IČO).
export const AGENCY_NAME_PATTERNS = [
  'hays',
  'grafton',
  'manpower',
  'robert half',
  'reed',
  'hofmann',
  'engage',
  'talentor',
  'predictive',
  'randstad',
  'adecco',
  'synergie',
  'advantage consulting',
  'trenkwalder',
  'axiom',
  'motiv p',
  'jobs contact',
  'teamleaders',
  'people place',
  'recruitment',
  'recruiting',
  'personální agentura',
  'personalni agentura',
  'staffing',
  'zprostredkovani zamestnani',
];

// TODO: zdroj strojových dat registru agentur práce MPSV (seznam IČO s povolením
// ke zprostředkování zaměstnání). Doplnit URL → src/sources/agencies.ts ho načte.
export const AGENCY_REGISTRY_URL = '';

export function isAgencyByName(employer: string | undefined): boolean {
  const n = norm(employer);
  if (!n) return false;
  return AGENCY_NAME_PATTERNS.some((p) => n.includes(norm(p)));
}

// --- Nastavení + meta v D1 ----------------------------------------------
const SETTINGS_KEY = 'settings';

export async function loadSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(SETTINGS_KEY)
    .first<{ value: string }>();
  if (!row?.value) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(env: Env, patch: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await loadSettings(env)), ...patch };
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  )
    .bind(SETTINGS_KEY, JSON.stringify(merged))
    .run();
  return merged;
}

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  )
    .bind(key, value)
    .run();
}
