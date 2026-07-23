// Sdílený proužek: živé hodinky (důkaz, že stránka nezamrzla) + číslo commitu nasazené verze.
(function () {
  var css = document.createElement('style');
  css.textContent =
    '#jw-footer{position:fixed;right:12px;bottom:10px;display:flex;align-items:center;gap:7px;' +
    'font:12px/1.4 system-ui,Segoe UI,sans-serif;color:#8b97ad;background:rgba(20,25,37,.88);' +
    'border:1px solid #2a3346;padding:5px 10px;border-radius:9px;z-index:50}' +
    '#jw-footer code{color:#e9edf5;background:#1b2233;border:1px solid #2a3346;padding:0 5px;border-radius:5px}' +
    '#jw-live{width:7px;height:7px;border-radius:50%;background:#3ecf8e;animation:jwp 1.2s infinite}' +
    '@keyframes jwp{0%,100%{opacity:1}50%{opacity:.45}}';
  document.head.appendChild(css);

  var bar = document.createElement('div');
  bar.id = 'jw-footer';
  bar.innerHTML = '<span id="jw-live"></span><span id="jw-clock">--:--:--</span> · <span id="jw-ver">…</span> · <span id="jw-ai" title="AI backend…">AI …</span> · <span id="jw-health" title="kontrola spojení…">API …</span>';
  document.body.appendChild(bar);

  var clock = document.getElementById('jw-clock');
  (function tick() {
    clock.textContent = new Date().toLocaleTimeString('cs-CZ');
    setTimeout(tick, 1000);
  })();

  var ver = document.getElementById('jw-ver');
  fetch('/api/version')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (v) {
      if (v && v.commit) {
        // commit bývá plný 40znakový SHA (z CI) → zkrať na krátký hash; "dev" nech být
        var short = /^[0-9a-f]{12,}$/i.test(v.commit) ? v.commit.slice(0, 7) : v.commit;
        ver.innerHTML = 'verze <code>' + short + '</code>' + (v.builtAt ? ' · ' + v.builtAt : '');
      }
    })
    .catch(function () { ver.textContent = 'lokální náhled'; });

  // Indikátor aktivního AI backendu (skórování) — „dle úhrady": default zdarma Cloudflare.
  var aiEl = document.getElementById('jw-ai');
  function renderAi(ai) {
    ai = ai || {};
    if (!ai.configured) {
      aiEl.innerHTML = 'AI <span style="color:#8b97ad">●</span>';
      aiEl.title = 'AI je vypnutá (AI_PROVIDER=off nebo chybí backend).';
      return;
    }
    var free = ai.provider === 'workers-ai';
    var label = free ? '⚡ Cloudflare' : 'Claude';
    var col = ai.ok === true ? '#3ecf8e' : (ai.ok === false ? '#ef6b73' : '#8b97ad');
    var reasonTxt = { no_credit: 'chybí kredit', auth: 'neplatný klíč', network: 'bez spojení', other: 'chyba' };
    aiEl.innerHTML = 'AI ' + label + ' <span style="color:' + col + '">●</span>';
    aiEl.title =
      'Skórování: ' + (free ? 'Cloudflare Workers AI — zdarma' : 'Claude — placené') +
      (ai.model ? ' (' + ai.model + ')' : '') +
      (ai.ok === false ? ' ✗ ' + (reasonTxt[ai.reason] || ('HTTP ' + (ai.status || '?'))) : '') +
      (ai.fallback ? ' · záložní backend: ' + (ai.fallback === 'workers-ai' ? 'Cloudflare (zdarma)' : 'Claude') : '') +
      ' · deanonymizace/screening: ' + (ai.webResearch ? 'Claude (web)' : 'vypnuto') +
      '   (mění se v Nastavení)';
  }

  // Kontrola API spojení (DB + AI + kanály) — klikni pro re-check
  var health = document.getElementById('jw-health');
  function checkHealth() {
    health.innerHTML = 'API …';
    aiEl.innerHTML = 'AI …';
    fetch('/api/health')
      .then(function (r) { return r.json(); })
      .then(function (h) {
        renderAi(h.ai);
        var a = h.anthropic || {};
        var col = !a.configured ? '#8b97ad' : (a.ok ? '#3ecf8e' : '#ef6b73');
        function st(x) { return !x || !x.configured ? '–' : (x.ok === true ? '✓' : (x.ok === false ? '✗' : '?')); }
        var reasonTxt = { no_credit: 'chybí kredit', auth: 'neplatný klíč', network: 'bez spojení' };
        function anthropicStr() {
          if (!a.configured) return '–';
          if (a.ok) return '✓';
          return '✗ ' + (reasonTxt[a.reason] || ('HTTP ' + (a.status || '?')));
        }
        health.innerHTML = 'API <span style="color:' + col + '">●</span>';
        health.title =
          'DB ' + (h.db ? 'OK' : 'CHYBA') +
          ' · Anthropic ' + anthropicStr() +
          ' · Telegram ' + st(h.telegram) +
          ' · E-mail ' + st(h.graph) +
          ' · Slack ' + (h.slack && h.slack.configured ? 'nastaven' : '–') +
          '   (klikni pro re-check)';
      })
      .catch(function () {
        health.innerHTML = 'API <span style="color:#ef6b73">●</span>';
        health.title = 'spojení selhalo';
        aiEl.innerHTML = 'AI <span style="color:#ef6b73">●</span>';
        aiEl.title = 'stav AI se nepodařilo načíst';
      });
  }
  health.style.cursor = 'pointer';
  health.onclick = checkHealth;
  aiEl.style.cursor = 'pointer';
  aiEl.onclick = checkHealth;
  checkHealth();
})();
