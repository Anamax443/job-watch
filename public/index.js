
const $ = (s) => document.querySelector(s);
function salary(j){ if(!j.salary_from && !j.salary_to) return '—'; return `${j.salary_from??'?'}–${j.salary_to??'?'} Kč`; }
function esc(s){ return String(s??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// Stav živosti: 1=inzerát na portálu, 0=stažen z portálu (detail 404), NULL=zatím neověřeno.
// POZOR: stažení inzerátu z portálu ≠ konec výběrového řízení — VŘ může běžet dál (firma
// jen sundala placený inzerát). Proto neutrální „staženo z portálu", ne „zrušeno".
function statusCell(j){
  if(j.active === 0) return '<span class="stat pulled" title="Inzerát už není na portálu, ale výběrové řízení může běžet dál — zkus oslovit zaměstnavatele přímo (uložený inzerát rozbalíš u pozice).">📄 Staženo z portálu</span>';
  if(j.active === 1) return '<span class="stat on" title="Inzerát je stále na portálu">✅ Na portálu</span>';
  return '<span class="stat unk" title="Živost zatím neověřena">⏳ neověřeno</span>';
}

// Detail inzerátu (archiv): plný uložený inzerát „jako bys na něj klikl na portálu" —
// funguje i po stažení z portálu (kdy odkaz dá 404). Otvírá se v modálním okně.
let jobsById = {};
// Stránkování. Seznam dřív bral natvrdo prvních 200 řádků a víc se na starší inzeráty
// nedalo dostat, i když v D1 jsou (nic se nemaže, historie sahá do 14. 6. 2026).
let shown = 0;
let total = 0;

function portalName(url){
  if(/jobs\.cz/.test(url||'')) return 'jobs.cz';
  if(/prace\.cz/.test(url||'')) return 'prace.cz';
  return '';
}

function detailHtml(j, bodyHtml){
  const emp = j.real_employer
    ? `${esc(j.employer)} <span class="badge agency">agentura</span> → <span class="orig">🎯 ${esc(j.real_employer)}</span>`
    : `${esc(j.employer)}${j.is_agency ? ' <span class="badge agency">agentura</span>' : ''}`;
  const src = esc((j.source||'').split(':')[0]);
  const portal = portalName(j.url) || src;
  const withdrawn = j.active === 0;
  return `
    <h2 class="dtitle">${esc(j.title)}</h2>
    <div class="dmeta">${emp} · 📍 ${esc(j.location||'—')} · 💰 ${salary(j)} · <span class="badge">${src}</span> ${statusCell(j)}</div>
    ${j.relevance!=null?`<div class="dscore">Skóre <b>${j.relevance}</b>${j.seniority?` · ${esc(j.seniority)}`:''}${j.reason?` — ${esc(j.reason)}`:''}</div>`:''}
    ${contactBlock(j)}
    ${reachOut(j)}
    <div class="dbody">${bodyHtml}</div>
    <div class="dlinks">
      ${j.url?`<a href="${esc(j.url)}" target="_blank" rel="noopener">Otevřít původní inzerát na ${esc(portal)} ↗</a>${withdrawn?' <span class="mut">(inzerát je stažený → odkaz dá 404; text máš výše z archivu)</span>':''}`:''}
    </div>`;
}

// Detail se dotáhne z /api/ad (archiv; když chybí, server ho stáhne ze zdroje a uloží).
async function openDetail(id){
  const j = jobsById[id];
  if(!j) return;
  const dlg = $('#detail');
  dlg.hidden = false;
  $('#detail .modal').scrollTop = 0;
  $('#detailBody').innerHTML = detailHtml(j, '<span class="mut">📄 Načítám inzerát…</span>');
  let bodyHtml;
  try {
    const d = await (await fetch(`/api/ad?id=${encodeURIComponent(id)}`)).json();
    const body = (d.description || '').trim();
    if(body) bodyHtml = esc(body);
    else if(d.withdrawn || d.status === 404) bodyHtml = '<span class="mut">Inzerát je stažený z portálu a jeho text nebyl dřív archivovaný, takže ho nelze zobrazit. Firmu ale můžeš oslovit napřímo (odkazy výše).</span>';
    else if(portalName(j.url) === 'jobs.cz') bodyHtml = '<span class="mut">jobs.cz zobrazuje text inzerátu až v prohlížeči (aplikace), takže ho nelze serverově archivovat. Otevři původní inzerát níže, nebo firmu oslov napřímo (odkazy výše). U prace.cz se text ukládá.</span>';
    else bodyHtml = `<span class="mut">Text inzerátu se nepodařilo získat${d.note?` (${esc(d.note)})`:''}. Zkus „Otevřít původní inzerát".</span>`;
  } catch(e){
    bodyHtml = '<span class="mut">Nepodařilo se načíst text inzerátu.</span>';
  }
  if(dlg.hidden) return;   // uživatel mezitím zavřel
  $('#detailBody').innerHTML = detailHtml(j, bodyHtml);
}
function closeDetail(){ $('#detail').hidden = true; }

// Oslovit firmu napřímo — hlavně u stažených inzerátů (portálová přihláška je zavřená,
// ale VŘ může běžet). Odkazy na firmu vč. odhaleného původce u agentur.
function reachOut(j){
  const name = (j.real_employer || j.employer || '').trim();
  if(!name) return '';
  const q = encodeURIComponent(name);
  const li = `https://www.linkedin.com/search/results/companies/?keywords=${q}`;
  const web = `https://www.google.com/search?q=${encodeURIComponent('"'+name+'" kariéra volná místa')}`;
  return `<div class="reach" title="Oslov firmu napřímo (portálová přihláška u staženého inzerátu už nefunguje)">🎯 <a href="${li}" target="_blank" rel="noopener">LinkedIn</a> · <a href="${web}" target="_blank" rel="noopener">web / kariéra</a></div>`;
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

// append = true → připojit další stránku pod už zobrazené (tlačítko „Načíst starší").
// Změna filtru nebo Obnovit stránkování vždy resetuje, jinak by se míchaly dva různé výběry.
async function load(append){
  const min = $('#minScore').value || 0;
  const ag = $('#agencyOnly').checked ? '1' : '0';
  const act = $('#activeFilter').value || 'all';
  if(!append) shown = 0;
  $('#status').textContent = 'Načítám…';
  $('#more').disabled = true;
  const r = await fetch(`/api/jobs?minScore=${min}&agency=${ag}&active=${act}&offset=${shown}`);
  const res = await r.json();
  const jobs = res.jobs || [];
  total = res.total ?? jobs.length;
  const tb = $('#rows');
  if(!append){ tb.innerHTML = ''; jobsById = {}; }
  for(const j of jobs){
    jobsById[j.id] = j;
    const tr = document.createElement('tr');
    // Stažený inzerát NEzešednujeme — VŘ může běžet dál, je to pořád lead.
    const emp = j.real_employer
      ? `${esc(j.employer)} <span class="badge agency">agentura</span><br><span class="orig">🎯 ${esc(j.real_employer)}</span>`
      : `${esc(j.employer)}${j.is_agency ? ' <span class="badge agency">agentura</span>' : ''}`;
    tr.innerHTML = `
      <td class="score">${j.relevance ?? '—'}</td>
      <td><a class="titlelink" data-id="${esc(j.id)}" title="Zobrazit uložený inzerát (jako na portálu)">${esc(j.title)}</a>${j.seen_count>1?` <span class="badge rep" title="objevilo se vícekrát v čase">↻ opakovaný ×${j.seen_count}</span>`:''}<div class="reason">${esc(j.reason ?? '')}</div><a class="showad" data-id="${esc(j.id)}">📄 zobrazit inzerát</a></td>
      <td>${emp}${contactBlock(j)}${reachOut(j)}</td>
      <td>${esc(j.location ?? '—')}</td>
      <td>${salary(j)}</td>
      <td><span class="badge">${esc((j.source||'').split(':')[0])}</span></td>
      <td>${statusCell(j)}</td>
      <td>${j.url ? `<a class="link" href="${esc(j.url)}" target="_blank" rel="noopener">otevřít ↗</a>` : ''}</td>`;
    tb.appendChild(tr);
  }
  shown += jobs.length;
  $('#empty').hidden = shown > 0;
  // Kolik z kolika — useknutý seznam se nesmí tvářit jako úplný.
  $('#status').textContent = shown >= total ? `${shown} pozic` : `${shown} z ${total} pozic`;
  const more = $('#more');
  more.hidden = shown >= total;
  more.disabled = false;
  more.textContent = `Načíst starší (zbývá ${total - shown})`;
}

// Pozor na obal: bez něj by se do load() dostal Event a vyhodnotil se jako append=true.
$('#refresh').onclick = () => load(false);
$('#minScore').onchange = () => load(false);
$('#agencyOnly').onchange = () => load(false);
$('#activeFilter').onchange = () => load(false);
$('#more').onclick = () => load(true);

// Klik na název pozice / „zobrazit inzerát" → detail inzerátu (archiv). Delegace přes tbody.
$('#rows').addEventListener('click', (e) => {
  const el = e.target.closest('a.titlelink, a.showad');
  if(!el) return;
  e.preventDefault();
  openDetail(el.getAttribute('data-id'));
});
$('#detailClose').onclick = closeDetail;
$('#detail').addEventListener('click', (e) => { if(e.target.id === 'detail') closeDetail(); }); // klik mimo kartu
document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !$('#detail').hidden) closeDetail(); });
let saveMsgTimer;
$('#saveFilters').onclick = () => {
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
    const gone = o.livenessGone ? ` · staženo z portálu ${o.livenessGone}` : '';
    // „fronta" = uložené inzeráty čekající na skóre. Nezahazují se, dožene je další běh.
    const pend = o.queueDepth ? ` · fronta ${o.queueDepth}`
      : (o.candidatesPending ? ` · zbývá ${o.candidatesPending}` : '');
    const noise = (o.fetched!=null && o.candidates!=null && o.fetched>o.candidates) ? ` (−${o.fetched-o.candidates} šum)` : '';
    return `staženo ${o.fetched} · kandidáti ${o.candidates}${noise} · skóre ${o.scored} · deanon ${o.enriched} · notif ${o.notified} · zdroje +${o.discovered}${gone}${pend}`;
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
// Spustí JEDEN běh a vyřeší se, až doběhne. Když viditelně visí (>45 s bez finished_at),
// sám ho ukončí. Vrací { latest, clean } — clean=false = běh nedoběhl čistě.
function runSingle(){
  return new Promise(async (resolve) => {
    try{ await fetch('/api/run', { method:'POST' }); }catch(e){}
    let latest = await loadRuns();
    const t0 = Date.now();
    const iv = setInterval(async () => {
      latest = await loadRuns();
      if(latest && latest.finished_at){ clearInterval(iv); resolve({ latest, clean:true }); return; }
      // Běh (fetch + skóre + až 60 liveness kontrol) doběhne do ~50 s; 90 s = evidentně visí.
      // auto=1 → do logu se napíše „časový limit dávky", ne „zastaveno uživatelem".
      if(Date.now()-t0 > 90000){
        clearInterval(iv);
        try{ await fetch('/api/run/stop?auto=1',{method:'POST'}); }catch(e){}
        resolve({ latest: latest||null, clean:false });
      }
    }, 1500);
  });
}
// Kolik kandidátů z tohoto stažení ještě zbývá. null = neznámo (běh nedoběhl / bez údaje).
function pendingOf(latest){
  try{ const o=typeof latest?.stats==='string'?JSON.parse(latest.stats):latest?.stats;
    return (o && o.candidatesPending!=null) ? o.candidatesPending : null; }
  catch(e){ return null; }
}
// Jeden klik = doskórování CELÉHO stažení: běh se opakuje po dávkách, dokud zbývají
// nezhodnocení kandidáti (jeden běh jich kvůli časovému stropu Workeru stihne jen část).
let loopStop = false;
const MAX_BATCHES = 25;
$('#run').onclick = async () => {
  loopStop = false;
  $('#run').disabled = true;
  $('#stop').style.display = '';      // Stop přeruší i smyčku
  let batch = 0, lastPending = null, stuck = 0;
  try {
    while(!loopStop && batch < MAX_BATCHES){
      batch++;
      $('#status').textContent = batch===1 ? 'Spouštím…'
        : `Doskórování — dávka ${batch}${lastPending!=null?` (zbývá ~${lastPending})`:''}…`;
      const { latest } = await runSingle();
      if(loopStop) break;
      const pending = pendingOf(latest);
      if(pending===0) break;                       // celé stažení ohodnoceno → hotovo
      if(pending==null){                           // běh nedoběhl čistě → neznámý zbytek
        if(++stuck>=3){ $('#status').textContent='Běhy nestíhají dokončit — zkus znovu za chvíli.'; return; }
      } else {                                      // pending > 0
        stuck = 0;
        if(lastPending!=null && pending>=lastPending){
          $('#status').textContent = `Doskórování zastaveno — beze změny, zbývá ${pending}.`;
          return;
        }
        lastPending = pending;
      }
      await new Promise(r=>setTimeout(r, 1500));   // krátká pauza mezi dávkami (nešrotovat Worker)
    }
    if(batch>=MAX_BATCHES && !loopStop){
      $('#status').textContent = `Přerušeno po ${batch} dávkách${lastPending!=null?` (zbývá ${lastPending})`:''}.`;
      return;
    }
    $('#status').textContent = loopStop ? 'Zastaveno.' : '✅ Hotovo — celé stažení ohodnoceno.';
  } finally {
    $('#run').disabled = false;
    await loadRuns();
    load();
    setTimeout(()=>{ const s=$('#status').textContent; if(s.startsWith('✅')||s==='Zastaveno.') $('#status').textContent=''; }, 4000);
  }
};
$('#stop').onclick = async () => {
  loopStop = true;                    // zastav i dávkovou smyčku
  $('#stop').disabled=true; $('#status').textContent='Zastavuji…';
  try{ await fetch('/api/run/stop',{method:'POST'}); }catch(e){}
  $('#stop').disabled=false; $('#status').textContent='';
  await loadRuns(); load();
};
const savedAgency = localStorage.getItem('jw.agencyOnly');
if (savedAgency !== null) $('#agencyOnly').checked = savedAgency === '1';
const savedActive = localStorage.getItem('jw.activeFilter');
if (savedActive !== null) $('#activeFilter').value = savedActive;

// Výchozí min. skóre vlastní Nastavení (uložené v D1), ne prohlížeč — aby se nemuselo
// přenastavovat na každém zařízení zvlášť. Filtry Agentury/Stav zůstávají per-prohlížeč
// („Uložit filtry"), protože to jsou krátkodobé pohledy, ne nastavení systému.
localStorage.removeItem('jw.minScore'); // úklid po dřívější per-prohlížečové verzi
(async () => {
  try {
    const s = await (await fetch('/api/settings')).json();
    if (s && s.minScore != null) $('#minScore').value = s.minScore;
  } catch (e) { /* nechá se výchozí 0 z HTML */ }
  load();
})();
loadRuns();
