
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
  $('#minScore').value = current.minScore ?? 0;
  $('#emailTo').value = current.emailTo ?? '';
  $('#telegramChatId').value = current.telegramChatId ?? '';
  $('#notifyEmail').checked = !!current.notifyEmail;
  $('#notifyTelegram').checked = !!current.notifyTelegram;
  $('#notifySlack').checked = !!current.notifySlack;
  $('#aiProvider').value = current.aiProvider ?? '';
}

$('#save').onclick = async () => {
  const payload = {
    profile: $('#profile').value,
    keywords: $('#keywords').value.split('\n').map(s=>s.trim()).filter(Boolean),
    regionPriority: $('#regionPriority').value.trim(),
    czIscoPrefixes: $('#czIscoPrefixes').value.split(',').map(s=>s.trim()).filter(Boolean),
    notifyThreshold: parseInt($('#notifyThreshold').value,10)||0,
    minScore: parseInt($('#minScore').value,10)||0,
    emailTo: $('#emailTo').value.trim(),
    telegramChatId: $('#telegramChatId').value.trim(),
    notifyEmail: $('#notifyEmail').checked,
    notifyTelegram: $('#notifyTelegram').checked,
    notifySlack: $('#notifySlack').checked,
    aiProvider: $('#aiProvider').value,
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
    var esc = function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    $('#status').innerHTML = (d.lines && d.lines.length)
      ? 'Test — komunikace:<br>' + d.lines.map(function(l){ return '· ' + esc(l); }).join('<br>')
      : 'Test → Telegram '+(d.telegram?'✓':'–')+' · E-mail '+(d.email?'✓':'–')+' · Slack '+(d.slack?'✓':'–');
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
    const a = h.anthropic||{}, tg = h.telegram||{}, g = h.email||{}, sl = h.slack||{}, ai = h.ai||{};
    const aReason = { no_credit: ' — účet nemá kredit, doplň v Plans & Billing', auth: ' — neplatný klíč', network: ' — bez spojení' };
    const aExtra = (a.configured && a.ok===false) ? (aReason[a.reason] || (a.status ? ` (HTTP ${a.status})` : '')) : '';
    const aiName = ai.provider === 'workers-ai' ? '⚡ Cloudflare Workers AI (zdarma)'
      : ai.provider === 'anthropic' ? 'Claude (placené)' : 'vypnuto';
    const aiExtra = ` — ${aiName}` + (ai.webResearch ? ' · deanonymizace zapnutá' : ' · deanonymizace vypnutá');
    $('#checkres').innerHTML =
      line('AI backend (skórování)', ai.configured ? ai.ok : null, aiExtra) +
      line('Databáze', h.db) +
      line('Anthropic (API klíč)', a.configured ? a.ok : null, aExtra) +
      line('Telegram (bot token)', tg.configured ? tg.ok : null) +
      line('E-mail (Cloudflare)', g.configured ? g.ok : null, g.from ? ` — odesílatel ${g.from} (doručení ověř „Odeslat test")` : '') +
      `<div>${dot(sl.configured?'#3ecf8e':'#8b97ad')} Slack: ${sl.configured?'nastaven (ověř tlačítkem „Odeslat test")':'– nenastaveno'}</div>`;
  } catch(e) { $('#checkres').textContent = '✗ kontrola selhala'; }
};
load();
