
const $ = (s) => document.querySelector(s);
let runs = [];
let selectedId = null;     // id zvoleného běhu; null = sleduj nejnovější
let timer = null;

function fmtStats(s){
  if(!s) return '';
  try{ const o = typeof s==='string'?JSON.parse(s):s;
    return `staženo ${o.fetched} · kandidáti ${o.candidates} · skóre ${o.scored} · deanon ${o.enriched} · notif ${o.notified} · zdroje +${o.discovered}`;
  }catch(e){ return ''; }
}
function isStale(r){
  if(!r || r.finished_at) return false;
  try{ const t=new Date(r.started_at.replace(' ','T')+'Z').getTime(); return (Date.now()-t)>150000; }catch(e){ return false; }
}
function state(r){
  if(!r.finished_at) return isStale(r) ? {t:'⚠️ neodpovídá', cls:''} : {t:'⏳ probíhá', cls:'live'};
  return r.ok ? {t:'✅ hotovo', cls:''} : {t:'⚠️ skončeno', cls:''};
}

function fillSelector(){
  const sel = $('#runsel');
  sel.innerHTML = '';
  for(const r of runs){
    const st = state(r);
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `#${r.id} · ${r.started_at} · ${r.trigger} · ${st.t}`;
    sel.appendChild(opt);
  }
  const target = selectedId ?? (runs[0]?.id ?? null);
  if(target != null) sel.value = String(target);
}

function render(){
  const id = selectedId ?? runs[0]?.id;
  const r = runs.find((x) => String(x.id) === String(id));
  const term = $('#term');
  if(!r){ term.textContent = 'Zatím žádné běhy. Spusť běh na stránce Výsledky („Spustit teď").'; $('#meta').textContent=''; $('#live').textContent=''; return; }
  const st = state(r);
  const running = !r.finished_at && !isStale(r);
  $('#meta').textContent = `běh #${r.id} · ${st.t} · ${r.trigger} · ${r.started_at}${r.finished_at?' → '+r.finished_at:''} · ${fmtStats(r.stats)}`;
  $('#live').className = 'pill ' + st.cls;
  $('#live').textContent = running ? '● živě' : '';
  // zachovej pozici scrollu, pokud uživatel odscrolloval nahoru u běžícího běhu
  const atBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 24;
  term.textContent = r.log || '(prázdný log)';
  if(running && atBottom) term.scrollTop = term.scrollHeight;
}

function esc(s){ return String(s??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function loadNotifs(){
  let list = [];
  try{ list = (await (await fetch('/api/notifications')).json()).notifications || []; }
  catch(e){ $('#notifs').textContent = '✗ nepodařilo se načíst /api/notifications'; return; }
  $('#notifcount').textContent = list.length ? `(${list.length})` : '';
  if(!list.length){ $('#notifs').textContent = 'Zatím nic neodesláno.'; return; }
  $('#notifs').innerHTML = list.map((n) => {
    const loc = n.location ? ` · ${esc(n.location)}` : '';
    const src = esc((n.source || '').split(':')[0]);
    // Klikací rovnou název → velký tap-cíl na mobilu, otevře zdroj inzerátu v novém okně.
    const title = n.url
      ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)} ↗</a>`
      : esc(n.title);
    return `<div class="nrow"><span class="when">🔔 ${esc(n.notified_at)}</span>`
      + `<span class="sc">${n.relevance ?? '—'}</span>`
      + `<span>${title} <span class="emp">— ${esc(n.employer)}${loc}</span> <span class="pill">[${src}]</span></span></div>`;
  }).join('');
}

async function load(){
  try{
    const res = await fetch('/api/runs');
    runs = (await res.json()).runs || [];
  }catch(e){ $('#term').textContent = '✗ nepodařilo se načíst /api/runs'; return; }
  fillSelector();
  render();
  loadNotifs();
}

$('#runsel').onchange = (e) => {
  // ruční volba: pokud je to nejnovější, vrať se k „sleduj nejnovější"
  const v = e.target.value;
  selectedId = (runs[0] && String(runs[0].id) === v) ? null : v;
  render();
};
$('#refresh').onclick = load;
$('#auto').onchange = (e) => { setupTimer(e.target.checked); };

function setupTimer(on){
  if(timer){ clearInterval(timer); timer=null; }
  if(on) timer = setInterval(load, 3000);
}

load();
setupTimer(true);
