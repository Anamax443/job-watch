
const $ = (s) => document.querySelector(s);
let current = {};

async function load(){
  const r = await fetch('/api/settings');
  current = await r.json();
  $('#profile').value = current.profile ?? '';
  $('#keywords').value = (current.keywords||[]).join('\n');
  $('#regionPriority').value = current.regionPriority ?? '';
  $('#czIscoPrefixes').value = (current.czIscoPrefixes||[]).join(', ');
  $('#notifyThreshold').value = current.notifyThreshold ?? 70;
  $('#emailTo').value = current.emailTo ?? '';
  $('#telegramChatId').value = current.telegramChatId ?? '';
  $('#notifyEmail').checked = !!current.notifyEmail;
  $('#notifyTelegram').checked = !!current.notifyTelegram;
  $('#notifySlack').checked = !!current.notifySlack;
}

$('#save').onclick = async () => {
  const payload = {
    profile: $('#profile').value,
    keywords: $('#keywords').value.split('\n').map(s=>s.trim()).filter(Boolean),
    regionPriority: $('#regionPriority').value.trim(),
    czIscoPrefixes: $('#czIscoPrefixes').value.split(',').map(s=>s.trim()).filter(Boolean),
    notifyThreshold: parseInt($('#notifyThreshold').value,10)||0,
    emailTo: $('#emailTo').value.trim(),
    telegramChatId: $('#telegramChatId').value.trim(),
    notifyEmail: $('#notifyEmail').checked,
    notifyTelegram: $('#notifyTelegram').checked,
    notifySlack: $('#notifySlack').checked,
  };
  $('#save').disabled = true;
  const r = await fetch('/api/settings', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  $('#save').disabled = false;
  $('#status').textContent = r.ok ? '✓ Uloženo' : '✗ Chyba ukládání';
  setTimeout(()=>{ $('#status').textContent=''; }, 2500);
};

$('#test').onclick = async () => {
  $('#test').disabled = true; $('#status').textContent = 'Posílám test…';
  try {
    const r = await fetch('/api/test-notify', { method:'POST' });
    const d = await r.json();
    $('#status').textContent = 'Test → Telegram '+(d.telegram?'✓':'–')+' · E-mail '+(d.email?'✓':'–')+' · Slack '+(d.slack?'✓':'–');
  } catch(e){ $('#status').textContent = '✗ chyba testu'; }
  $('#test').disabled = false;
};

$('#check').onclick = async () => {
  $('#checkres').textContent = 'Kontroluji…';
  try {
    const h = await (await fetch('/api/health')).json();
    const dot = (c) => `<span style="color:${c}">●</span>`;
    const line = (label, ok, extra) => {
      const c = ok===true ? '#3ecf8e' : (ok===false ? '#ef6b73' : '#8b97ad');
      const t = ok===true ? '✓ dostupné' : (ok===false ? '✗ nedostupné' : '– nenastaveno');
      return `<div>${dot(c)} ${label}: ${t}${extra||''}</div>`;
    };
    const a = h.anthropic||{}, tg = h.telegram||{}, g = h.graph||{}, sl = h.slack||{};
    const aReason = { no_credit: ' — účet nemá kredit, doplň v Plans & Billing', auth: ' — neplatný klíč', network: ' — bez spojení' };
    const aExtra = (a.configured && a.ok===false) ? (aReason[a.reason] || (a.status ? ` (HTTP ${a.status})` : '')) : '';
    $('#checkres').innerHTML =
      line('Databáze', h.db) +
      line('Anthropic (API klíč)', a.configured ? a.ok : null, aExtra) +
      line('Telegram (bot token)', tg.configured ? tg.ok : null) +
      line('E-mail (MS Graph)', g.configured ? g.ok : null) +
      `<div>${dot(sl.configured?'#3ecf8e':'#8b97ad')} Slack: ${sl.configured?'nastaven (ověř tlačítkem „Odeslat test")':'– nenastaveno'}</div>`;
  } catch(e) { $('#checkres').textContent = '✗ kontrola selhala'; }
};
load();
