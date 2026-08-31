import type { Env, JobPosting, Settings } from './types.ts';
import { stripHtml, truncate } from './util.ts';

// Notifikace přes Telegram + Microsoft Graph (e-mail). Každý kanál vypínatelný v settings.

export interface NotifyJob extends JobPosting {
  relevance: number;
  reason: string;
  realEmployer?: string;
  realEmployerUrl?: string;
}

function fmtSalary(j: JobPosting): string {
  if (!j.salaryFrom && !j.salaryTo) return '';
  return `${j.salaryFrom ?? '?'}–${j.salaryTo ?? '?'} Kč`;
}

/** Text inzerátu (bez HTML, zkrácený) — ať jde v notifikaci odlišit od hodnocení AI. */
function fmtDescription(j: JobPosting, max: number): string | null {
  const d = stripHtml(j.description).replace(/\n{3,}/g, '\n\n').trim();
  return d ? truncate(d, max) : null;
}

// `descLimit` = kolik znaků textu inzerátu vzít (e-mail unese víc, Telegram/Slack krátký výcuc).
function buildText(j: NotifyJob, descLimit = 700): string {
  const lines = [`🔔 ${j.title}`, `🏢 ${j.employer}${j.isAgency ? ' (agentura)' : ''}`];
  if (j.realEmployer)
    lines.push(`🎯 Původce: ${j.realEmployer}${j.realEmployerUrl ? ` — ${j.realEmployerUrl}` : ''}`);
  // Lokalitu ukazuj VŽDY — „neuvedena" je taky informace (region nešel ověřit, ber s rezervou).
  lines.push(j.location ? `📍 ${j.location}` : '📍 lokalita neuvedena (region nelze ověřit)');
  const sal = fmtSalary(j);
  if (sal) lines.push(`💰 ${sal}`);
  // Hodnocení AI vs. samotný inzerát jsou dvě různé věci → jasně je odděl a pojmenuj.
  lines.push(`⭐ Hodnocení AI ${j.relevance}/100 — ${j.reason}`);
  const desc = fmtDescription(j, descLimit);
  if (desc) lines.push(`📄 Text inzerátu:\n${desc}`);
  else lines.push('📄 Text inzerátu: zdroj neuvedl žádný popis');
  lines.push(`🔗 ${j.url ?? '(bez odkazu)'}`);
  lines.push(`zdroj: ${j.source}`);
  return lines.join('\n');
}

export async function sendTelegram(env: Env, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
    if (!res.ok) console.warn(`Telegram: HTTP ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.warn('Telegram:', e);
    return false;
  }
}

async function sendSlack(webhookUrl: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.warn(`Slack: HTTP ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.warn('Slack:', e);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface EmailSendResult {
  ok: boolean;
  messageId?: string;
  code?: string;
  message?: string;
}

// E-mail přes Cloudflare Email Sending (binding EMAIL) — bez SMTP a bez klíčů.
// Odesílatel = env.EMAIL_FROM; jeho doména musí být onboardovaná na Email Sending
// (Dashboard → Email Service → Email Sending → Onboard Domain), jinak send() hodí
// E_SENDER_NOT_VERIFIED. Vrací konkrétní výsledek (messageId / kód chyby), ať je v konzoli
// vidět, co se stalo. Pozn.: úspěch = Cloudflare PŘIJAL k odeslání, ne že už je v doručené poště.
async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<EmailSendResult> {
  if (!env.EMAIL) return { ok: false, code: 'NO_BINDING', message: 'binding EMAIL chybí (Email Sending nenakonfigurováno)' };
  const from = { email: env.EMAIL_FROM || 'jobwatch@maxferit.cz', name: 'JobWatch' };
  try {
    const r = await env.EMAIL.send({
      to,
      from,
      subject,
      text,
      html: `<pre style="font:inherit;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>`,
    });
    return { ok: true, messageId: (r as { messageId?: string })?.messageId };
  } catch (e: any) {
    // .code např. E_SENDER_NOT_VERIFIED (doména neonboardovaná), E_RECIPIENT_SUPPRESSED.
    const code = e?.code as string | undefined;
    const message = (e?.message as string) ?? String(e);
    console.warn(`Email send: ${code ?? ''} ${message}`);
    return { ok: false, code, message };
  }
}

/** Živá kontrola Telegram bota (getMe — ověří platnost tokenu). */
export async function checkTelegram(
  env: Env,
): Promise<{ configured: boolean; ok: boolean | null; status: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { configured: false, ok: null, status: 0 };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    return { configured: true, ok: r.ok, status: r.status };
  } catch {
    return { configured: true, ok: false, status: 0 };
  }
}

/** Stav e-mailového kanálu (Cloudflare Email Sending). Reálné doručení nejde ověřit bez
 *  odeslání (ok = binding je nasazený, „kanál zapojen"); deliverability prověří test/ostrý mail. */
export function checkEmail(env: Env): { configured: boolean; ok: boolean | null; from: string | null } {
  const configured = !!env.EMAIL;
  return {
    configured,
    ok: configured ? true : null,
    from: configured ? env.EMAIL_FROM || 'jobwatch@maxferit.cz' : null,
  };
}

export interface NotifyResult {
  telegram: boolean;
  email: boolean;
  slack: boolean;
  lines: string[]; // lidsky čitelná komunikace per kanál (pro konzoli i test)
}

// `log` (volitelné) streamuje řádky komunikace živě do konzole běhu; zároveň se vrací v `lines`.
export async function notify(
  env: Env,
  settings: Settings,
  job: NotifyJob,
  log?: (msg: string) => void,
  textOverride?: string, // pro test doručení — vlastní text místo formátu inzerátu
): Promise<NotifyResult> {
  const text = textOverride ?? buildText(job); // Telegram/Slack — krátký výcuc inzerátu
  const emailText = textOverride ?? buildText(job, 3000); // e-mail unese delší text (a často není odkaz)
  const lines: string[] = [];
  const say = (m: string) => {
    lines.push(m);
    log?.(m);
  };
  let telegram = false;
  let email = false;
  let slack = false;

  if (settings.notifyTelegram && settings.telegramChatId) {
    telegram = await sendTelegram(env, settings.telegramChatId, text);
    say(`📨 Telegram → ${settings.telegramChatId}: ${telegram ? '✓ odesláno' : '✗ selhalo (viz Worker log)'}`);
  } else if (settings.notifyTelegram) {
    say('📨 Telegram: ✗ zapnutý, ale chybí chat_id v Nastavení');
  }

  if (settings.notifyEmail && settings.emailTo) {
    const from = env.EMAIL_FROM || 'jobwatch@maxferit.cz';
    say(`📧 E-mail ${from} → ${settings.emailTo}: odesílám přes Cloudflare Email Sending…`);
    const res = await sendEmail(env, settings.emailTo, `JobWatch: ${job.title}`, emailText);
    email = res.ok;
    say(
      res.ok
        ? `📧 E-mail: ✓ přijato Cloudflarem k odeslání${res.messageId ? ` (id ${res.messageId})` : ''} — doručení může chvíli trvat, zkontroluj i spam`
        : `📧 E-mail: ✗ ${res.code ?? 'chyba'}${res.message ? ` — ${res.message}` : ''}`,
    );
  } else if (settings.notifyEmail) {
    say('📧 E-mail: ✗ zapnutý, ale chybí cílová adresa (emailTo v Nastavení)');
  }

  if (settings.notifySlack && env.SLACK_WEBHOOK_URL) {
    slack = await sendSlack(env.SLACK_WEBHOOK_URL, text);
    say(`💬 Slack: ${slack ? '✓ odesláno' : '✗ selhalo (viz Worker log)'}`);
  } else if (settings.notifySlack) {
    say('💬 Slack: ✗ zapnutý, ale chybí SLACK_WEBHOOK_URL (secret)');
  }

  return { telegram, email, slack, lines };
}
