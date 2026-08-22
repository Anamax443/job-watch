// Stránka /tests — vykreslí výsledek sebekontroly z GET /api/selftest.
// Nic nepočítá sama: jediná definice kontrol je v src/selftest.ts (tutéž spouští i CI).
//
// Pozn. k průběhu: server sadu spočítá řádově v jednotkách ms (často 0), takže bez
// odkrývání po krocích by překreslení bylo neviditelné a nešlo by poznat, že se něco
// stalo. Krokování je tedy VYKRESLOVÁNÍ výsledků, ne měření — skutečný čas výpočtu
// hlásí server a je vypsaný zvlášť, ať to nemate.
const $ = (s) => document.querySelector(s);
const KROK_MS = 18; // prodleva mezi řádky při odkrývání

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const pauza = (ms) => new Promise((r) => setTimeout(r, ms));

function setRunning() {
  const v = $('#verdict');
  v.className = 'verdict run';
  v.innerHTML =
    '<span class="big" style="color:var(--acc)"><span class="spin">⟳</span></span>' +
    '<span class="meta" id="runstate">Spouštím sebekontrolu na nasazené verzi…</span>' +
    '<span class="bar-progress"><i id="runbar"></i></span>' +
    '<span class="meta" id="runcount" style="min-width:62px;text-align:right"></span>';
  $('#groups').innerHTML = '';
}

function radek(k) {
  const d = document.createElement('div');
  d.className = 'chk' + (k.ok ? '' : ' bad');
  d.innerHTML =
    `<div class="mark">${k.ok ? '✅' : '❌'}</div>` +
    `<div><div class="name">${esc(k.nazev)}</div><div class="why">${esc(k.proc)}</div>` +
    (k.ok ? '' : `<div class="diff">čekáno: ${esc(k.ocekavano)}<br>dostal: ${esc(k.dostal)}</div>`) +
    `</div>`;
  return d;
}

// Odkrývá kontroly po jedné, ať je vidět, že sada proběhla a co v ní je.
async function reveal(r) {
  const box = $('#groups');
  const stav = $('#runstate');
  const bar = $('#runbar');
  const cnt = $('#runcount');
  let posledniSkupina = null;
  let hotovo = 0;
  let predchozi = null;

  for (const k of r.kontroly) {
    if (k.skupina !== posledniSkupina) {
      posledniSkupina = k.skupina;
      const items = r.kontroly.filter((x) => x.skupina === k.skupina);
      const bad = items.filter((x) => !x.ok).length;
      const h = document.createElement('h2');
      h.innerHTML = esc(k.skupina) + ` <span style="color:${bad ? 'var(--bad)' : 'var(--good)'}">${items.length - bad}/${items.length}</span>`;
      box.appendChild(h);
      requestAnimationFrame(() => h.classList.add('in'));
      if (stav) stav.textContent = 'Kontroluji: ' + k.skupina;
      await pauza(KROK_MS * 3);
    }
    const d = radek(k);
    box.appendChild(d);
    requestAnimationFrame(() => d.classList.add('in', 'now'));
    if (predchozi) predchozi.classList.remove('now');
    predchozi = d;
    hotovo++;
    if (bar) bar.style.width = Math.round((hotovo / r.celkem) * 100) + '%';
    if (cnt) cnt.textContent = hotovo + '/' + r.celkem;
    // U propadlé kontroly se na chvíli zastav, ať ji jde postřehnout.
    await pauza(k.ok ? KROK_MS : 500);
  }
  if (predchozi) predchozi.classList.remove('now');
}

function renderVerdict(r, msKlient) {
  const v = $('#verdict');
  v.className = 'verdict ' + (r.ok ? 'pass' : 'fail');
  const commit = /^[0-9a-f]{12,}$/i.test(r.commit || '') ? r.commit.slice(0, 7) : (r.commit || 'dev');
  v.innerHTML =
    `<span class="big ${r.ok ? 'ok' : 'no'}">${r.ok ? '✅' : '❌'} ${r.proslo}/${r.celkem}</span>` +
    `<span class="meta">${r.ok
      ? 'Všechny invarianty na nasazené verzi platí.'
      : `<b style="color:var(--bad)">${r.selhalo} kontrol selhalo</b> — nasazená verze se chová jinak, než má.`}</span>` +
    `<span class="meta" style="margin-left:auto">výpočet na serveru <b>${r.ms} ms</b>` +
    ` · odpověď za ${msKlient} ms · verze <code>${esc(commit)}</code>${r.builtAt ? ' · ' + esc(r.builtAt) : ''}</span>`;
}

async function run() {
  const btn = $('#run');
  btn.disabled = true;
  btn.textContent = '⏳ Běží…';
  $('#meta').textContent = '';
  setRunning();
  const t0 = Date.now();
  try {
    // no-store: „Spustit znovu" musí opravdu sáhnout na server, ne vrátit cache.
    const res = await fetch('/api/selftest', { cache: 'no-store' });
    const r = await res.json(); // 500 při selhání — tělo je v obou případech stejné
    const msKlient = Date.now() - t0;
    await reveal(r);
    renderVerdict(r, msKlient);
    $('#meta').textContent = 'Naposledy ' + new Date().toLocaleTimeString('cs-CZ');
  } catch (e) {
    $('#verdict').className = 'verdict fail';
    $('#verdict').innerHTML =
      '<span class="big no">❌</span><span class="meta">Sebekontrolu se nepodařilo spustit — API neodpovídá.</span>';
  }
  btn.disabled = false;
  btn.textContent = '↻ Spustit znovu';
}

$('#run').onclick = run;
run();
