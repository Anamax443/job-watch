import type { Env, JobPosting, Settings } from './types';

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

function buildText(j: NotifyJob): string {
  const lines = [`🔔 ${j.title}`, `🏢 ${j.employer}${j.isAgency ? ' (agentura)' : ''}`];
  if (j.realEmployer)
    lines.push(`🎯 Původce: ${j.realEmployer}${j.realEmployerUrl ? ` — ${j.realEmployerUrl}` : ''}`);
  if (j.location) lines.push(`📍 ${j.location}`);
  const sal = fmtSalary(j);
  if (sal) lines.push(`💰 ${sal}`);
  lines.push(`⭐ Skóre ${j.relevance}/100 — ${j.reason}`);
  lines.push(`🔗 ${j.url ?? '(bez odkazu)'}`);
  lines.push(`zdroj: ${j.source}`);
  return lines.join('\n');
}

async function sendTelegram(env: Env, chatId: string, text: string): Promise<boolean> {
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

// E-mail přes Cloudflare Email Sending (binding EMAIL) — bez SMTP a bez klíčů.
// Odesílatel = env.EMAIL_FROM; jeho doména musí být onboardovaná na Email Sending
// (Dashboard → Email Service → Email Sending → Onboard Domain), jinak send() hodí
// E_SENDER_NOT_VERIFIED. HTML i text kvůli doručitelnosti.
async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL) {
    console.warn('Email: binding EMAIL chybí — Email Sending není nakonfigurováno');
    return false;
  }
  const from = { email: env.EMAIL_FROM || 'jobwatch@maxferit.cz', name: 'JobWatch' };
  try {
    await env.EMAIL.send({
      to,
      from,
      subject,
      text,
      html: `<pre style="font:inherit;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>`,
    });
    return true;
  } catch (e: any) {
    // .code např. E_SENDER_NOT_VERIFIED (doména neonboardovaná), E_RECIPIENT_SUPPRESSED.
    console.warn(`Email send: ${e?.code ?? ''} ${e?.message ?? e}`);
    return false;
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

export async function notify(
  env: Env,
  settings: Settings,
  job: NotifyJob,
): Promise<{ telegram: boolean; email: boolean; slack: boolean }> {
  const text = buildText(job);
  let telegram = false;
  let email = false;
  let slack = false;
  if (settings.notifyTelegram && settings.telegramChatId)
    telegram = await sendTelegram(env, settings.telegramChatId, text);
  if (settings.notifyEmail && settings.emailTo)
    email = await sendEmail(env, settings.emailTo, `JobWatch: ${job.title}`, text);
  if (settings.notifySlack && env.SLACK_WEBHOOK_URL)
    slack = await sendSlack(env.SLACK_WEBHOOK_URL, text);
  return { telegram, email, slack };
}
