// Příkazy z Telegramu — JobWatch se ptá sám, nikdo se nedovolává jemu.
//
// Proč dotazování (getUpdates) a ne webhook: celý jobwatch.maxferit.cz je za Cloudflare
// Access, takže Telegram by se na žádnou cestu nedovolal (i `/` vrací 302 na přihlášení).
// Webhook by znamenal Bypass politiku v Access, tedy vědomou díru v ochraně. Takhle
// nevzniká žádný veřejný endpoint: Worker si každých 5 minut sáhne na Telegram sám.
// Cena je latence — na odpověď se čeká do příštího cronu.

import type { Env, Settings } from './types.ts';
import { getMeta, setMeta } from './config.ts';
import { sendTelegram } from './notify.ts';
import { buildJobsFilter } from './store.ts';

/** Klíč kurzoru v `meta`: poslední zpracované update_id od Telegramu. */
export const CURSOR_KEY = 'telegram_update_id';

/**
 * Klíč tepu v `meta`: kdy naposledy dotazování proběhlo.
 *
 * Proč to tu je: bez zpráv nemá dotazování žádnou stopu — nezapisuje kurzor, nic nepošle.
 * „Nikdo nic nenapsal" a „cron se netočí" by pak vypadaly úplně stejně a chyba by se
 * poznala až tím, že bot mlčí. Tep se píše VŽDY, i před kontrolou nastavení, takže jeho
 * chybějící hodnota znamená právě jedno: rozvrh neběží.
 */
export const HEARTBEAT_KEY = 'telegram_poll_at';

/** Kolik pozic vypsat do jedné zprávy. Telegram má strop 4096 znaků na zprávu. */
export const MAX_ITEMS = 15;

export type Command =
  | { kind: 'positions'; minScore: number | null }
  | { kind: 'run' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

/**
 * Text zprávy → příkaz. Čistá funkce.
 *
 * Tvary, které musí projít: `/pozice`, `/pozice 60`, a ve skupině i `/pozice@JobWatchBot 60`
 * (Telegram tam jméno bota připojuje sám). Bez čísla se použije práh z Nastavení.
 */
export function parseCommand(raw: string | undefined | null): Command | null {
  const text = (raw ?? '').trim();
  if (!text.startsWith('/')) return null; // běžná věta, ne příkaz — neodpovídat
  const [head, ...rest] = text.split(/\s+/);
  const cmd = head.slice(1).split('@')[0].toLowerCase();

  if (cmd === 'pozice' || cmd === 'jobs') {
    const arg = rest[0];
    if (arg === undefined) return { kind: 'positions', minScore: null };
    const n = parseInt(arg, 10);
    // Nesmysl v argumentu vezme práh z Nastavení, místo aby příkaz spadl. Kdo píše
    // do mobilu, překlepne se — a prázdný výpis by vypadal jako „nic nenašel".
    if (!Number.isFinite(n)) return { kind: 'positions', minScore: null };
    return { kind: 'positions', minScore: Math.min(Math.max(n, 0), 100) };
  }
  if (cmd === 'beh' || cmd === 'run' || cmd === 'spustit') return { kind: 'run' };
  if (cmd === 'stav' || cmd === 'status') return { kind: 'status' };
  if (cmd === 'help' || cmd === 'napoveda') return { kind: 'help' };
  // /start posílá Telegram sám při prvním otevření chatu — nesmí spustit běh, jen nápovědu.
  if (cmd === 'start') return { kind: 'help' };
  return { kind: 'unknown', text: cmd };
}

/** Na jak starou zprávu se ještě odpovídá (sekundy). Cron chodí po 5 minutách. */
export const MAX_AGE_SEC = 600;

/**
 * Je zpráva dost čerstvá na odpověď? Čistá funkce.
 *
 * Proč: Telegram drží nedoručené zprávy až 24 h. Po výpadku Workeru (nebo při úplně prvním
 * spuštění) by se jinak naráz vysypaly odpovědi na příkazy staré půl dne — a odpověď na
 * dotaz „jaké jsou aktuální pozice" položený včera je stejně k ničemu.
 * Chybějící `date` se bere jako čerstvá: radši odpovědět navíc než mlčet.
 */
export function isFresh(dateSec: number | undefined, nowSec: number, maxAge = MAX_AGE_SEC): boolean {
  if (dateSec === undefined) return true;
  return nowSec - dateSec <= maxAge;
}

export interface PositionRow {
  title: string;
  employer: string;
  real_employer: string | null;
  location: string | null;
  relevance: number | null;
  source: string;
  url: string | null;
}

/**
 * Pozice → text zprávy. Čistá funkce.
 *
 * `total` je počet, kterému filtr odpovídá celkem — když je větší než počet vypsaných,
 * musí to být ve zprávě vidět. Mlčky useknutý seznam se čte jako „tohle je všechno".
 */
export function formatPositions(rows: PositionRow[], minScore: number, total: number): string {
  if (!rows.length) {
    return `📋 Žádná pozice se skóre ≥ ${minScore}, která je na portálu.\nZkus nižší práh: /pozice 50`;
  }
  const lines = [`📋 ${total} pozic se skóre ≥ ${minScore}, na portálu:`];
  for (const r of rows) {
    const zam = r.real_employer ? `${r.employer} → ${r.real_employer}` : r.employer;
    lines.push('');
    lines.push(`${r.relevance ?? '—'} · ${r.title}`);
    lines.push(`   ${zam}${r.location ? ` · ${r.location}` : ''}`);
    if (r.url) lines.push(`   ${r.url}`);
  }
  if (total > rows.length) {
    lines.push('');
    lines.push(`… a další ${total - rows.length}. Celý seznam je ve Výsledcích.`);
  }
  return lines.join('\n');
}

export interface RunRow {
  started_at: string;
  finished_at: string | null;
  trigger: string | null;
  ok: number;
  stats: string | null;
}

/**
 * Poslední běh → text zprávy. Čistá funkce.
 *
 * Nedoběhlý běh se nesmí tvářit jako úspěšný ani jako pád: `finished_at IS NULL` znamená
 * „běží", ne „selhal". Tohle je zrovna to místo, kde by tichá záměna zamlžila, že je agent mrtvý.
 */
export function formatRun(r: RunRow | null): string {
  if (!r) return '📭 Zatím neproběhl žádný běh.';
  if (!r.finished_at) return `⏳ Běh z ${r.started_at} ještě běží.`;
  let s = '';
  try {
    const st = JSON.parse(r.stats ?? '{}');
    s =
      `
staženo ${st.fetched ?? 0} · kandidátů ${st.candidates ?? 0} · ohodnoceno ${st.scored ?? 0}` +
      `
notifikováno ${st.notified ?? 0} · ve frontě ${st.queueDepth ?? 0}` +
      (st.prefiltered ? `
vyřazeno filtrem bez AI ${st.prefiltered}` : '');
  } catch {
    /* stats se nepovedlo přečíst — hlavička stačí */
  }
  return `${r.ok ? '✅' : '❌'} Běh ${r.started_at} → ${r.finished_at} (${r.trigger ?? '?'})${s}`;
}

export function helpText(defaultMin: number): string {
  return [
    '🔎 JobWatch — příkazy',
    '',
    `/pozice — pozice na portálu se skóre ≥ ${defaultMin} (práh z Nastavení)`,
    '/pozice 50 — totéž s vlastním prahem',
    '/beh — spustit běh agenta teď',
    '/stav — jak dopadl poslední běh',
    '/help — tenhle výpis',
    '',
    'Vypisují se jen inzeráty, které na portálu pořád jsou. Odpověď chodí do 5 minut —',
    'JobWatch se na Telegram ptá sám, protože aplikace je schovaná za Cloudflare Access.',
  ].join('\n');
}

// --- Vlastní dotazování ----------------------------------------------------

interface TgUpdate {
  update_id: number;
  message?: { text?: string; date?: number; chat?: { id?: number | string } };
}

async function loadPositions(
  env: Env,
  minScore: number,
): Promise<{ rows: PositionRow[]; total: number }> {
  // Stav „na portálu" = active=1 i dosud neověřené (NULL); potvrzeně stažené (0) ne.
  // `history: false` schválně: na dotaz „aktuální pozice" nemá smysl posílat inzeráty
  // bez skóre — o ty se žádá prahem, který na NULL stejně neplatí.
  const { where, binds } = buildJobsFilter({
    minScore,
    agencyOnly: false,
    active: 'active',
    history: false,
  });
  const rows = await env.DB.prepare(
    `SELECT title, employer, real_employer, location, relevance, source, url
     FROM seen_jobs WHERE ${where}
     ORDER BY relevance DESC, first_seen DESC LIMIT ?`,
  )
    .bind(...binds, MAX_ITEMS)
    .all<PositionRow>();
  const t = await env.DB.prepare(`SELECT COUNT(*) AS n FROM seen_jobs WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return { rows: rows.results ?? [], total: t?.n ?? 0 };
}

export interface PollResult {
  /** Kolik zpráv přišlo celkem (i cizích). */
  prislo: number;
  /** Kolik jich bylo od oprávněného chatu a vyřídilo se. */
  vyrizeno: number;
  /** Kolik se zahodilo, protože přišly z jiného chatu. */
  cizich: number;
  /** Kolik se zahodilo kvůli stáří (výpadek, backlog z Telegramu). */
  stare: number;
}

/**
 * Vybere čekající zprávy a odpoví na ně.
 *
 * Oprávnění: odpovídá se JEN na chat_id z Nastavení. Cizí zprávy se zahodí — odpověď
 * neznámému chatu by z bota udělala veřejné čtení výsledků (kontaktní osoby, zaměstnavatelé).
 * Že se něco zahodilo, jde do logu Workeru, ať to není úplně neviditelné.
 */
export interface PollDeps {
  /** Spustí běh agenta. Předává se zvenčí, aby telegram.ts nemusel znát pipeline. */
  startRun: () => void;
}

export async function pollTelegram(
  env: Env,
  settings: Settings,
  deps: PollDeps,
): Promise<PollResult> {
  const out: PollResult = { prislo: 0, vyrizeno: 0, cizich: 0, stare: 0 };
  await setMeta(env, HEARTBEAT_KEY, new Date().toISOString());
  const chatId = settings.telegramChatId;
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return out;

  const cursor = await getMeta(env, CURSOR_KEY);
  const params = new URLSearchParams({ timeout: '0', allowed_updates: '["message"]' });
  if (cursor) params.set('offset', String(parseInt(cursor, 10) + 1));

  let updates: TgUpdate[] = [];
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?${params}`,
    );
    if (!res.ok) {
      console.warn(`Telegram getUpdates: HTTP ${res.status} ${await res.text()}`);
      return out;
    }
    const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
    updates = body.result ?? [];
  } catch (e) {
    console.warn('Telegram getUpdates:', e);
    return out;
  }
  if (!updates.length) return out;
  out.prislo = updates.length;

  const lastId = Math.max(...updates.map((u) => u.update_id));
  const nowSec = Math.floor(Date.now() / 1000);

  for (const u of updates) {
    if (!isFresh(u.message?.date, nowSec)) {
      out.stare++;
      continue;
    }
    const from = String(u.message?.chat?.id ?? '');
    if (from !== String(chatId)) {
      out.cizich++;
      console.warn(`Telegram: zpráva z neoprávněného chatu ${from} zahozena`);
      continue;
    }
    const cmd = parseCommand(u.message?.text);
    if (!cmd) continue; // běžná věta, ne příkaz
    if (cmd.kind === 'positions') {
      const min = cmd.minScore ?? settings.minScore ?? 0;
      const { rows, total } = await loadPositions(env, min);
      await sendTelegram(env, chatId, formatPositions(rows, min, total));
    } else if (cmd.kind === 'run') {
      // Pojistka proti dvojímu spuštění: běh trvá minuty a dotazování chodí po pěti,
      // takže netrpělivé druhé /beh by rozjelo dva běhy proti téže databázi.
      const bezi = await env.DB.prepare(
        "SELECT started_at FROM runs WHERE finished_at IS NULL AND started_at > datetime('now','-15 minutes') ORDER BY id DESC LIMIT 1",
      ).first<{ started_at: string }>();
      if (bezi) {
        await sendTelegram(env, chatId, `⏳ Běh už jede od ${bezi.started_at}. Napiš /stav.`);
      } else {
        deps.startRun();
        await sendTelegram(env, chatId, '▶️ Běh spuštěn. Trvá pár minut — pak napiš /stav.');
      }
    } else if (cmd.kind === 'status') {
      const r = await env.DB.prepare(
        'SELECT started_at, finished_at, trigger, ok, stats FROM runs ORDER BY id DESC LIMIT 1',
      ).first<RunRow>();
      await sendTelegram(env, chatId, formatRun(r ?? null));
    } else if (cmd.kind === 'help') {
      await sendTelegram(env, chatId, helpText(settings.minScore ?? 0));
    } else {
      await sendTelegram(
        env,
        chatId,
        `Neznámý příkaz /${cmd.text}.\n\n${helpText(settings.minScore ?? 0)}`,
      );
    }
    out.vyrizeno++;
  }

  await setMeta(env, CURSOR_KEY, String(lastId));
  return out;
}
