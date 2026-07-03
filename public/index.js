
const $ = (s) => document.querySelector(s);
function salary(j){ if(!j.salary_from && !j.salary_to) return '—'; return `${j.salary_from??'?'}–${j.salary_to??'?'} Kč`; }
function esc(s){ return String(s??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// Stav živosti: 1=aktivní, 0=zrušené (detail 404), NULL=zatím neověřeno.
function statusCell(j){
  if(j.active === 0) return '<span class="stat off" title="Inzerát už není dostupný (ukončené výběrové řízení)">🚫 Zrušené</span>';
  if(j.active === 1) return '<span class="stat on" title="Inzerát je stále aktivní">✅ Aktivní</span>';
  return '<span class="stat unk" title="Živost zatím neověřena">⏳ neověřeno</span>';
}

// Kontaktní osoba (hl. z MPSV) — ať jde oslovit konkrétní člověk i po skončení VŘ.
function contactBlock(j){
  if(!j.contact_email && !j.contact_phone && !j.contact_name) return '';
  const parts = [];
  if(j.contact_name) parts.push(`👤 ${esc(j.contact_name)}${j.contact_position?` — ${esc(j.contact_position)}`:''}`);
  const line2 = [];
  if(j.contact_email) line2.push(`✉ <a href="mailto:${esc(j.contact_email)}">${esc(j.contact_email)}</a>`);
  if(j.contact_phone) line2.push(`☎ <a href="tel:${esc(String(j.contact_phone).replace(/\s+/g,''))}">${esc(j.contact_phone)}</a>`);
  if(line2.length) parts.push(line2.join(' · '));
  return `<div class="contact">${parts.join('<br>')}</div>`;
}

async function load(){
  const min = $('#minScore').value || 0;
  const ag = $('#agencyOnly').checked ? '1' : '0';
  const act = $('#activeFilter').value || 'all';
  $('#status').textContent = 'Načítám…';
  const r = await fetch(`/api/jobs?minScore=${min}&agency=${ag}&active=${act}`);
  const { jobs } = await r.json();
  const tb = $('#rows'); tb.innerHTML = '';
  $('#empty').hidden = jobs.length > 0;
  for(const j of jobs){
    const tr = document.createElement('tr');
    if(j.active === 0) tr.className = 'dead';
    const emp = j.real_employer
      ? `${esc(j.employer)} <span class="badge agency">agentura</span><br><span class="orig">🎯 ${esc(j.real_employer)}</span>`
      : `${esc(j.employer)}${j.is_agency ? ' <span class="badge agency">agentura</span>' : ''}`;
    tr.innerHTML = `
      <td class="score">${j.relevance ?? '—'}</td>
      <td>${esc(j.title)}${j.seen_count>1?` <span class="badge rep" title="objevilo se vícekrát v čase">↻ opakovaný ×${j.seen_count}</span>`:''}<div class="reason">${esc(j.reason ?? '')}</div></td>
      <td>${emp}${contactBlock(j)}</td>
      <td>${esc(j.location ?? '—')}</td>
      <td>${salary(j)}</td>
      <td><span class="badge">${esc((j.source||'').split(':')[0])}</span></td>
      <td>${statusCell(j)}</td>
      <td>${j.url ? `<a class="link" href="${esc(j.url)}" target="_blank" rel="noopener">otevřít ↗</a>` : ''}</td>`;
    tb.appendChild(tr);
  }
  $('#status').textContent = `${jobs.length} pozic`;
}

$('#refresh').onclick = load;
$('#minScore').onchange = load;
$('#agencyOnly').onchange = load;
$('#activeFilter').onchange = load;
let saveMsgTimer;
$('#saveFilters').onclick = () => {
  localStorage.setItem('jw.minScore', $('#minScore').value);
  localStorage.setItem('jw.agencyOnly', $('#agencyOnly').checked ? '1' : '0');
  localStorage.setItem('jw.activeFilter', $('#activeFilter').value);
  const msg = $('#saveMsg');
  msg.hidden = false;
  clearTimeout(saveMsgTimer);
  saveMsgTimer = setTimeout(() => { msg.hidden = true; }, 2000);
};
function fmtStats(s){
  if(!s) return '';
  try{ const o=typeof s==='string'?JSON.parse(s):s;
    const gone = o.livenessGone ? ` · zrušené ${o.livenessGone}` : '';
    return `staženo ${o.fetched} · kandidáti ${o.candidates} · skóre ${o.scored} · deanon ${o.enriched} · notif ${o.notified} · zdroje +${o.discovered}${gone}`;
  }catch(e){ return ''; }
}
function runStale(latest){
  if(!latest || latest.finished_at) return false;
  try{ const t=new Date(latest.started_at.replace(' ','T')+'Z').getTime(); return (Date.now()-t)>150000; }catch(e){ return false; }
}
async function loadRuns(){
  let runs=[];
  try{ const r=await fetch('/api/runs'); runs=(await r.json()).runs||[]; }catch(e){ return null; }
  const latest=runs[0];
  if(!latest){ $('#stop').style.display='none'; return null; }
  $('#runbox').classList.add('show');
  const stale=runStale(latest);
  const running=!latest.finished_at && !stale;
  $('#runhead').classList.toggle('running', running);
  $('#runst').className='st '+(running?'run':(latest.finished_at&&latest.ok?'ok':'err'));
  const state=running?'⏳ probíhá…':(!latest.finished_at?'⚠️ neodpovídá (limit) — klikni „Zastavit"':(latest.ok?'✅ hotovo':'⚠️ skončeno'));
  $('#runmeta').textContent=`${state} · ${latest.trigger} · ${latest.started_at}${latest.finished_at?' → '+latest.finished_at:''} · ${fmtStats(latest.stats)}`;
  const log=$('#runlog'); const atBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-24;
  log.textContent=latest.log||'';
  if(atBottom) log.scrollTop=log.scrollHeight;
  $('#stop').style.display = latest.finished_at ? 'none' : '';
  latest._stale=stale;
  return latest;
}
$('#run').onclick = async () => {
  $('#run').disabled = true; $('#status').textContent = 'Spouštím…';
  await fetch('/api/run', { method:'POST' });
  loadRuns();
  let tries=0;
  const iv=setInterval(async () => {
    const latest=await loadRuns(); tries++;
    if((latest && (latest.finished_at || latest._stale)) || tries>120){
      clearInterval(iv); $('#run').disabled=false; $('#status').textContent='';
      load();
    }
  }, 1500);
};
$('#stop').onclick = async () => {
  $('#stop').disabled=true; $('#status').textContent='Zastavuji…';
  try{ await fetch('/api/run/stop',{method:'POST'}); }catch(e){}
  $('#stop').disabled=false; $('#status').textContent='';
  await loadRuns(); load();
};
const savedMin = localStorage.getItem('jw.minScore');
if (savedMin !== null) $('#minScore').value = savedMin;
const savedAgency = localStorage.getItem('jw.agencyOnly');
if (savedAgency !== null) $('#agencyOnly').checked = savedAgency === '1';
const savedActive = localStorage.getItem('jw.activeFilter');
if (savedActive !== null) $('#activeFilter').value = savedActive;
load();
loadRuns();
