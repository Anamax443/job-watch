// Stránka /tests — vykreslí výsledek sebekontroly z GET /api/selftest.
// Nic nepočítá sama: jediná definice kontrol je v src/selftest.ts (tutéž spouští i CI).
const $ = (s) => document.querySelector(s);

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderVerdict(r) {
  const v = $('#verdict');
  v.className = 'verdict ' + (r.ok ? 'pass' : 'fail');
  v.innerHTML =
    `<span class="big ${r.ok ? 'ok' : 'no'}">${r.ok ? '✅' : '❌'} ${r.proslo}/${r.celkem}</span>` +
    `<span class="meta">${r.ok
      ? 'Všechny invarianty na nasazené verzi platí.'
      : `<b style="color:var(--bad)">${r.selhalo} kontrol selhalo</b> — nasazená verze se chová jinak, než má.`}</span>` +
    `<span class="meta" style="margin-left:auto">za ${r.ms} ms · verze <code>${esc(
      /^[0-9a-f]{12,}$/i.test(r.commit || '') ? r.commit.slice(0, 7) : (r.commit || 'dev'))}</code>${
      r.builtAt ? ' · ' + esc(r.builtAt) : ''}</span>`;
}

function renderGroups(r) {
  const box = $('#groups');
  box.innerHTML = '';
  const skupiny = [];
  for (const k of r.kontroly) if (!skupiny.includes(k.skupina)) skupiny.push(k.skupina);
  for (const g of skupiny) {
    const items = r.kontroly.filter((k) => k.skupina === g);
    const bad = items.filter((k) => !k.ok).length;
    const h = document.createElement('h2');
    h.innerHTML = esc(g) + ` <span style="color:${bad ? 'var(--bad)' : 'var(--good)'}">${items.length - bad}/${items.length}</span>`;
    box.appendChild(h);
    for (const k of items) {
      const d = document.createElement('div');
      d.className = 'chk' + (k.ok ? '' : ' bad');
      d.innerHTML =
        `<div class="mark">${k.ok ? '✅' : '❌'}</div>` +
        `<div><div class="name">${esc(k.nazev)}</div><div class="why">${esc(k.proc)}</div>` +
        (k.ok ? '' : `<div class="diff">čekáno: ${esc(k.ocekavano)}<br>dostal: ${esc(k.dostal)}</div>`) +
        `</div>`;
      box.appendChild(d);
    }
  }
}

async function run() {
  $('#run').disabled = true;
  $('#meta').textContent = 'Spouštím…';
  try {
    // Sebekontrola vrací 500, když něco selže — tělo je v obou případech stejné.
    const res = await fetch('/api/selftest');
    const r = await res.json();
    renderVerdict(r);
    renderGroups(r);
    $('#meta').textContent = 'Naposledy ' + new Date().toLocaleTimeString('cs-CZ');
  } catch (e) {
    $('#verdict').className = 'verdict fail';
    $('#verdict').innerHTML = '<span class="big no">❌</span><span class="meta">Sebekontrolu se nepodařilo spustit — API neodpovídá.</span>';
    $('#meta').textContent = '';
  }
  $('#run').disabled = false;
}

$('#run').onclick = run;
run();
