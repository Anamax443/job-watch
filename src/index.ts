import type { Env, Settings } from './types';
import { runPipeline } from './pipeline';
import { notify, checkTelegram, checkGraph, type NotifyJob } from './notify';
import { checkAnthropic, messagesCreate, allText } from './anthropic';
import { loadSettings, saveSettings } from './config';
import { resolveEnv, setSecret, secretStatus, SECRET_KEYS } from './secrets';
import { fetchWeb } from './sources/web';

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
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 500);

  const conds = ['duplicate_of IS NULL'];
  const binds: unknown[] = [];
  if (minScore > 0) {
    conds.push('relevance >= ?');
    binds.push(minScore);
  }
  if (agencyOnly) conds.push('is_agency = 1');

  const sql =
    `SELECT id, source, title, employer, employer_ico, location, cz_isco, salary_from, salary_to,
            url, is_agency, relevance, seniority, reason, real_employer, real_employer_url,
            notified_at, first_seen, seen_count
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
  const [anthropic, telegram, graph] = await Promise.all([
    checkAnthropic(env),
    checkTelegram(env),
    checkGraph(env),
  ]);
  const slack = { configured: !!env.SLACK_WEBHOOK_URL };
  return json({
    ok: db && anthropic.ok === true,
    db,
    anthropic,
    telegram,
    graph,
    slack,
    enabled: { telegram: s.notifyTelegram, email: s.notifyEmail, slack: s.notifySlack },
  });
}

// Odešle testovací notifikaci do zapnutých kanálů (ověření spojení).
async function handleTestNotify(env: Env): Promise<Response> {
  env = await resolveEnv(env);
  const s = await loadSettings(env);
  const testJob: NotifyJob = {
    id: 'test',
    source: 'test',
    title: 'JobWatch — testovací notifikace',
    employer: '(test)',
    location: '—',
    url: 'https://job-watch.bass443.workers.dev',
    isAgency: false,
    relevance: 100,
    reason: 'Ověření kanálů nastavených v JobWatch.',
  };
  const r = await notify(env, s, testJob);
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

    // Citlivé akce vyžadují přihlášení přes Cloudflare Access (header s e-mailem).
    const sensitive = ['/api/keys', '/api/run', '/api/run/stop', '/api/test-notify'];
    if (sensitive.includes(p) || (p === '/api/settings' && request.method === 'POST')) {
      if (!request.headers.get('Cf-Access-Authenticated-User-Email')) {
        return json({ error: 'Vyžaduje přihlášení (Cloudflare Access).' }, 403);
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
      await env.DB.prepare(
        "UPDATE runs SET finished_at = datetime('now'), ok = 0, " +
          "log = COALESCE(log,'') || char(10) || '⏹ zastaveno uživatelem' WHERE finished_at IS NULL",
      ).run();
      return json({ stopped: true });
    }
    // vše ostatní → statické UI (public/)
    return env.ASSETS.fetch(request);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
}
