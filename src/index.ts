import type { Env, Settings } from './types.ts';
import { runPipeline } from './pipeline.ts';
import { notify, checkTelegram, checkEmail, type NotifyJob } from './notify.ts';
import { checkAnthropic, messagesCreate, allText } from './anthropic.ts';
import {
  AI_PROVIDER_VALUES,
  WORKERS_AI_MODEL,
  ctxFrom,
  providerChain,
  webResearchEnabled,
} from './ai.ts';
import { loadSettings, saveSettings } from './config.ts';
import { resolveEnv, setSecret, secretStatus, SECRET_KEYS } from './secrets.ts';
import { fetchWeb } from './sources/web.ts';
import { isCheckableUrl } from './liveness.ts';
import { ACCESS_EMAIL_HEADER, accessStatus, authorize, isProtectedPath } from './access.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Bezpečnostní hlavičky na každou odpověď (CSP, HSTS, anti-clickjacking, …).
function secure(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
      "base-uri 'none'; form-action 'self'; upgrade-insecure-requests",
  );
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  h.set('X-XSS-Protection', '0');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// HTML → čitelný text (pro archiv inzerátu). Zachová odstavce/odrážky, zahodí značky.
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Vytáhne text inzerátu z detailové stránky — primárně ze strukturovaných dat JobPosting
// (JSON-LD, nejčistší), jinak prázdný. Vrací čitelný text (max 12k znaků).
function extractJobDescription(html: string): string {
  const scripts = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const s of scripts) {
    const jsonText = s.replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '').trim();
    let data: any;
    try {
      data = JSON.parse(jsonText);
    } catch {
      continue;
    }
    const graph = Array.isArray(data) ? data : data?.['@graph'] ?? [data];
    for (const n of Array.isArray(graph) ? graph : [graph]) {
      const type = n?.['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJob && typeof n.description === 'string' && n.description.trim()) {
        return htmlToText(n.description).slice(0, 12000);
      }
    }
  }
  return '';
}

function securityTxt(): Response {
  const body = [
    'Contact: mailto:bass443@gmail.com',
    'Expires: 2027-06-14T00:00:00.000Z',
    'Preferred-Languages: cs, en',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function handleJobs(env: Env, url: URL): Promise<Response> {
  const minScore = parseInt(url.searchParams.get('minScore') ?? '0', 10) || 0;
  const agencyOnly = url.searchParams.get('agency') === '1';
  // active: 'all' (default) | 'active' (aktivní/neověřené) | 'inactive' (zrušené)
  const active = url.searchParams.get('active') ?? 'all';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 500);

  const conds = ['duplicate_of IS NULL'];
  const binds: unknown[] = [];
  if (minScore > 0) {
    conds.push('relevance >= ?');
    binds.push(minScore);
  }
  if (agencyOnly) conds.push('is_agency = 1');
  // Zrušené = potvrzené 404 (active=0). Aktivní = vše, co není potvrzeně zrušené
  // (active=1 i dosud neověřené NULL) — ať se nic nezobrazí předčasně jako mrtvé.
  if (active === 'inactive') conds.push('active = 0');
  else if (active === 'active') conds.push('(active IS NULL OR active = 1)');

  const sql =
    `SELECT id, source, title, employer, employer_ico, location, cz_isco, salary_from, salary_to,
            url, description, is_agency, relevance, seniority, reason, real_employer, real_employer_url,
            notified_at, first_seen, seen_count, active, active_checked_at,
            contact_name, contact_email, contact_phone, contact_position
     FROM seen_jobs WHERE ${conds.join(' AND ')}
     ORDER BY (relevance IS NULL), relevance DESC, first_seen DESC LIMIT ?`;
  binds.push(limit);

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return json({ jobs: rows.results ?? [] });
}

// Kontrola spojení: DB + živé ověření Anthropic / Telegram / MS Graph + stav Slacku.
async function handleHealth(env: Env): Promise<Response> {
  env = await resolveEnv(env);
  let db = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    db = true;
  } catch {
    /* db nedostupná */
  }
  const s = await loadSettings(env);
  const [anthropic, telegram] = await Promise.all([
    checkAnthropic(env),
    checkTelegram(env),
  ]);
  const email = checkEmail(env);
  const slack = { configured: !!env.SLACK_WEBHOOK_URL };

  // Aktivní AI backend „dle úhrady" (skórování) — to jde do indikátoru v záhlaví.
  const ctx = ctxFrom(env, s);
  const chain = providerChain(ctx);
  const scoreProvider = chain[0] ?? null;
  const fallback = chain[1] ?? null;
  const webResearch = webResearchEnabled(ctx);
  const ai =
    scoreProvider === null
      ? { configured: false, ok: null as boolean | null, provider: null, webResearch }
      : scoreProvider === 'workers-ai'
        ? // Free/nativní backend billable probe nepotřebuje — hlásí se dostupnost.
          { configured: true, ok: true, provider: 'workers-ai', free: true, model: WORKERS_AI_MODEL, fallback, webResearch }
        : // Placený Claude → převezmi živý výsledek billable probe (odhalí i chybějící kredit).
          {
            configured: true,
            ok: anthropic.ok,
            provider: 'anthropic',
            free: false,
            model: env.SCORE_MODEL,
            reason: anthropic.reason,
            status: anthropic.status,
            fallback,
            webResearch,
          };

  return json({
    // ok = DB + reálně použitelný AI backend skórování (u free vždy true, u placeného dle probe).
    ok: db && ai.ok === true,
    db,
    ai,
    anthropic,
    telegram,
    email,
    slack,
    // Stav autorizace — ať je vidět, že allowlist chybí (viz src/access.ts). Adresy se nevrací.
    access: accessStatus(env.ACCESS_ALLOWED_EMAILS),
    enabled: { telegram: s.notifyTelegram, email: s.notifyEmail, slack: s.notifySlack },
  });
}

// Odešle testovací notifikaci do zapnutých kanálů (ověření spojení).
async function handleTestNotify(env: Env): Promise<Response> {
  env = await resolveEnv(env);
  const s = await loadSettings(env);
  const enabled: string[] = [];
  if (s.notifyEmail) enabled.push('E-mail');
  if (s.notifyTelegram) enabled.push('Telegram');
  if (s.notifySlack) enabled.push('Slack');
  const now = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  const testText = [
    '🔔 JobWatch — test doručení',
    'Když čteš tuhle zprávu, tenhle kanál funguje. ✅',
    `Zapnuté kanály: ${enabled.length ? enabled.join(', ') : '(žádný — zapni je v Nastavení)'}`,
    `Odesláno: ${now}`,
  ].join('\n');
  const testJob: NotifyJob = {
    id: 'test',
    source: 'test',
    title: 'test doručení',
    employer: '(test)',
    isAgency: false,
    relevance: 100,
    reason: 'test',
  };
  const r = await notify(env, s, testJob, undefined, testText);
  return json({ ok: r.telegram || r.email || r.slack, ...r });
}

function sanitizeSettings(input: any): Partial<Settings> {
  const out: Partial<Settings> = {};
  const arr = (v: any) =>
    Array.isArray(v) ? v.map((s: any) => String(s).trim()).filter(Boolean) : undefined;
  if (arr(input.keywords)) out.keywords = arr(input.keywords);
  if (arr(input.czIscoPrefixes)) out.czIscoPrefixes = arr(input.czIscoPrefixes);
  if (typeof input.regionPriority === 'string') out.regionPriority = input.regionPriority.trim();
  if (input.notifyThreshold != null)
    out.notifyThreshold = Math.max(0, Math.min(100, parseInt(input.notifyThreshold, 10) || 0));
  if (typeof input.emailTo === 'string') out.emailTo = input.emailTo.trim();
  if (typeof input.telegramChatId === 'string') out.telegramChatId = input.telegramChatId.trim();
  if (typeof input.notifyEmail === 'boolean') out.notifyEmail = input.notifyEmail;
  if (typeof input.notifyTelegram === 'boolean') out.notifyTelegram = input.notifyTelegram;
  if (typeof input.notifySlack === 'boolean') out.notifySlack = input.notifySlack;
  if (typeof input.profile === 'string') out.profile = input.profile;
  if (typeof input.aiProvider === 'string') {
    const v = input.aiProvider.trim().toLowerCase();
    if ((AI_PROVIDER_VALUES as readonly string[]).includes(v)) out.aiProvider = v;
  }
  return out;
}

export default {
  // Denní cron — viz [triggers] ve wrangler.toml.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env, 'cron'));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    return secure(await route(request, env, ctx, url));
  },
};

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const p = url.pathname;
  try {
    if (p === '/.well-known/security.txt') return securityTxt();

    // Celé API — ČTENÍ i ZÁPIS — vyžaduje ověřenou IDENTITU, ne jen přítomnost hlavičky.
    // Dřív byla chráněná jen hrstka zapisovacích cest a kontrolovalo se pouze to, že hlavička
    // existuje. Kdo se dostal na origin mimo Access, si ji poslal sám a stáhl si /api/settings
    // (profil/CV) i /api/jobs (kontaktní osoby vč. e-mailů a telefonů). Viz src/access.ts.
    if (isProtectedPath(p)) {
      const verdict = authorize({
        headerEmail: request.headers.get(ACCESS_EMAIL_HEADER),
        allowlistRaw: env.ACCESS_ALLOWED_EMAILS,
        devOpen: env.DEV_OPEN,
      });
      if (!verdict.ok) {
        console.warn(`access ${p}: ${verdict.reason} (${verdict.email ?? '—'})`);
        return json({ error: verdict.note }, verdict.status);
      }
    }

    if (p === '/api/keys' && request.method === 'GET') return json(await secretStatus(env));
    if (p === '/api/keys' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const name = String(body?.name ?? '');
      const value = String(body?.value ?? '');
      if (!(SECRET_KEYS as readonly string[]).includes(name)) return json({ error: 'neznámý klíč' }, 400);
      if (!value) return json({ error: 'prázdná hodnota' }, 400);
      await setSecret(env, name as (typeof SECRET_KEYS)[number], value);
      return json({ ok: true });
    }

    if (p === '/api/jobs' && request.method === 'GET') return await handleJobs(env, url);
    if (p === '/api/settings' && request.method === 'GET') return json(await loadSettings(env));
    if (p === '/api/settings' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const before = await loadSettings(env);
      const saved = await saveSettings(env, sanitizeSettings(body));
      // změna profilu znehodnotí stará skóre → příští běh přeskóruje proti novému profilu
      if (typeof body?.profile === 'string' && body.profile.trim() !== (before.profile ?? '').trim()) {
        await env.DB.prepare('UPDATE seen_jobs SET relevance = NULL').run();
      }
      return json(saved);
    }
    if (p === '/api/sources' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT name, ico, kind, platform, slug, careers_url, status, confidence, last_ok, discovered_at
         FROM sources ORDER BY (status = 'active') DESC, discovered_at DESC LIMIT 500`,
      ).all();
      return json({ sources: rows.results ?? [] });
    }
    if (p === '/api/version' && request.method === 'GET') {
      return json({ commit: env.GIT_COMMIT ?? 'dev', builtAt: env.BUILT_AT ?? null });
    }
    // Detail inzerátu (archiv): vrať uložený text; když chybí, stáhni ho ze zdroje a ulož
    // (od té chvíle přežije i stažení inzerátu z portálu). Zdroj bereme z DB, ne od uživatele.
    if (p === '/api/ad' && request.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const row = await env.DB.prepare('SELECT id, url, description FROM seen_jobs WHERE id = ?')
        .bind(id)
        .first<{ id: string; url: string | null; description: string | null }>();
      if (!row) return json({ error: 'inzerát nenalezen' }, 404);
      if (row.description && row.description.trim()) {
        return json({ id: row.id, description: row.description, cached: true });
      }
      const target = row.url ?? '';
      if (!isCheckableUrl(target)) return json({ id: row.id, description: '', note: 'zdroj bez načitatelného detailu' });
      try {
        const res = await fetch(target, {
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'cs',
            Accept: 'text/html',
          },
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return json({ id: row.id, description: '', withdrawn: res.status === 404, status: res.status });
        const html = await res.text();
        const desc = extractJobDescription(html);
        if (desc) {
          await env.DB.prepare('UPDATE seen_jobs SET description = ?2 WHERE id = ?1').bind(row.id, desc).run();
        }
        return json({ id: row.id, description: desc, fetched: true });
      } catch (e: any) {
        return json({ id: row.id, description: '', error: `${e?.name ?? 'err'}` });
      }
    }
    if (p === '/api/runs' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, started_at, finished_at, trigger, ok, stats, log FROM runs ORDER BY id DESC LIMIT 12',
      ).all();
      return json({ runs: rows.results ?? [] });
    }
    if (p === '/api/notifications' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT id, title, employer, location, relevance, source, url, notified_at
         FROM seen_jobs WHERE notified_at IS NOT NULL ORDER BY notified_at DESC LIMIT 100`,
      ).all();
      return json({ notifications: rows.results ?? [] });
    }
    if (p === '/api/health' && request.method === 'GET') return await handleHealth(env);
    if (p === '/api/test-web' && request.method === 'GET') {
      const renv = await resolveEnv(env);
      const s = await loadSettings(renv);
      const t0 = Date.now();
      try {
        const jobs = await fetchWeb(renv, s);
        return json({ ms: Date.now() - t0, count: jobs.length, sample: jobs.slice(0, 8) });
      } catch (e: any) {
        return json({ ms: Date.now() - t0, error: String(e?.message ?? e) }, 200);
      }
    }
    if (p === '/api/test-notify' && request.method === 'POST') return await handleTestNotify(env);
    if (p === '/api/run' && request.method === 'POST') {
      ctx.waitUntil(runPipeline(env, 'manual'));
      return json({ started: true });
    }
    if (p === '/api/run/stop' && request.method === 'POST') {
      // ?auto=1 = automatické ukončení dávky ze smyčky (časový limit), ne ruční Stop uživatele.
      const auto = url.searchParams.get('auto') === '1';
      const msg = auto
        ? '⏱ Dávka ukončena časovým limitem — normální u „Spustit teď": další dávka pokračuje tam, kde tato skončila, nic se neztrácí.'
        : '⏹ zastaveno uživatelem';
      await env.DB.prepare(
        "UPDATE runs SET finished_at = datetime('now'), ok = 0, " +
          'log = COALESCE(log,\'\') || char(10) || ?1 WHERE finished_at IS NULL',
      )
        .bind(msg)
        .run();
      return json({ stopped: true });
    }
    // vše ostatní → statické UI (public/)
    return env.ASSETS.fetch(request);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
}
