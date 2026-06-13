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

async function graphToken(env: Env): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetch(
      `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    );
    if (!res.ok) {
      console.warn(`Graph token: HTTP ${res.status}`);
      return null;
    }
    const j: any = await res.json();
    return j.access_token ?? null;
  } catch (e) {
    console.warn('Graph token:', e);
    return null;
  }
}

async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  const token = await graphToken(env);
  if (!token) return false;
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.GRAPH_MAILBOX)}/sendMail`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'Text', content: text },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: true,
        }),
      },
    );
    if (!res.ok) console.warn(`Graph sendMail: HTTP ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.warn('Graph sendMail:', e);
    return false;
  }
}

export async function notify(
  env: Env,
  settings: Settings,
  job: NotifyJob,
): Promise<{ telegram: boolean; email: boolean }> {
  const text = buildText(job);
  let telegram = false;
  let email = false;
  if (settings.notifyTelegram && settings.telegramChatId)
    telegram = await sendTelegram(env, settings.telegramChatId, text);
  if (settings.notifyEmail && settings.emailTo)
    email = await sendEmail(env, settings.emailTo, `JobWatch: ${job.title}`, text);
  return { telegram, email };
}
