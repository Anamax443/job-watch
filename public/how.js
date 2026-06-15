
const scenes = [...document.querySelectorAll('.scene')];
const durations = [4200, 6000, 5200, 4600, 5200, 6400, 5200, 5600, 4600];
const stepEl = document.getElementById('step');
const narrEl = document.getElementById('narr');
const dotsEl = document.getElementById('dots');
const bar = document.getElementById('bar');
const pp = document.getElementById('playpause');

scenes.forEach((_, i) => {
  const d = document.createElement('i');
  d.onclick = () => go(i, true);
  dotsEl.appendChild(d);
});
const dots = [...dotsEl.children];

let cur = -1, timer = null, barAnim = null, playing = true;

function go(i, fromClick){
  cur = (i + scenes.length) % scenes.length;
  scenes.forEach((s, k) => s.classList.toggle('active', k === cur));
  dots.forEach((d, k) => d.classList.toggle('on', k === cur));
  const s = scenes[cur];
  stepEl.textContent = s.dataset.step || '';
  narrEl.textContent = s.dataset.narr || '';
  // progress bar
  if (barAnim) barAnim.cancel();
  bar.style.width = '0';
  if (playing){
    barAnim = bar.animate([{width:'0%'},{width:'100%'}], {duration:durations[cur], easing:'linear'});
  }
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => go(cur + 1), durations[cur]);
  if (fromClick && !playing){ bar.style.width='0'; }
}

pp.onclick = () => {
  playing = !playing;
  pp.textContent = playing ? '⏸ Pauza' : '▶ Přehrát';
  if (playing) go(cur); else { clearTimeout(timer); if (barAnim) barAnim.pause(); }
};

// živé hodinky — důkaz, že stránka neběží zamrzlá
const clockEl = document.getElementById('clock');
(function ck(){ clockEl.textContent = new Date().toLocaleTimeString('cs-CZ'); setTimeout(ck, 1000); })();
// verze (commit) — z /api/version když je nasazeno, jinak lokální náhled
const verEl = document.getElementById('ver');
fetch('/api/version').then(r => r.ok ? r.json() : Promise.reject()).then(v => {
  if (v && v.commit) verEl.innerHTML = 'verze <code>' + v.commit + '</code>' + (v.builtAt ? ' · ' + v.builtAt : '');
}).catch(() => { verEl.textContent = 'lokální náhled'; });

go(0);
