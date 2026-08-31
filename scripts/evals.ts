// Evaluační sada — spuštění:  npm run evals
//
// Vyžaduje ji fáze F4 build předpisu z Anamax443/ai-agenti („evaly běží v CI a jsou nad
// prahem; změna promptu bez běhu evalů neprojde"). Sada je v `evals/skorovani.json`
// a stojí na reálných inzerátech z produkční D1 s ručně dopsanou pravdou.
//
// Dvě části, schválně oddělené:
//
//   1. DETERMINISTICKÁ — prefiltr a filtr kraje. Běží vždy, nepotřebuje síť ani klíč,
//      takže je to plnohodnotná brána v CI. Práh je 100 %: jsou to invarianty, ne odhady.
//   2. MODELOVÁ — skutečné skórování promptem z `src/prompts.ts`. Potřebuje klíč, takže
//      v CI většinou neběží. Když neběží, MUSÍ to být hlasitě vidět: „přeskočeno" se
//      nesmí tvářit jako „prošlo". Práh 90 %.
//
// Chyba, kterou tahle sada existuje chytat: 31. 8. 2026 jsem zpřísnil prefiltr na základě
// špatně spočítaného SQL agregátu a vyhodilo by to 16 reálných brněnských leadů. Průchod
// skutečnou funkcí nad skutečnými daty by to odhalil hned.

import { readFileSync } from 'node:fs';
import { prefilter } from '../src/prefilter.ts';
import { buildSystem, PROMPT_VERSION } from '../src/prompts.ts';
import type { JobPosting, Settings } from '../src/types.ts';

interface Pripad {
  why: string;
  job: Partial<JobPosting> & { source: string; title: string; employer: string };
  prefilter: 'in' | 'out';
  scoreBand: 'high' | 'low' | null;
}

interface Sada {
  nastaveni: Settings & { notifyThreshold: number };
  pripady: Pripad[];
}

const sada: Sada = JSON.parse(readFileSync('evals/skorovani.json', 'utf8'));
const settings = sada.nastaveni;
const prah = settings.notifyThreshold ?? 70;

function job(p: Pripad): JobPosting {
  return { isAgency: false, ...p.job } as JobPosting;
}

// --- 1) deterministická část ------------------------------------------------

let chyb = 0;
console.log(`\n▶ Deterministická část — prefiltr a kraj (${sada.pripady.length} případů)\n`);
for (const p of sada.pripady) {
  const projde = prefilter([job(p)], settings).length === 1;
  const chteno = p.prefilter === 'in';
  const ok = projde === chteno;
  if (!ok) chyb++;
  console.log(
    `${ok ? '✔' : '✘'} [${projde ? 'in ' : 'out'}] ${p.job.title.slice(0, 60)}${ok ? '' : `  ← čekáno ${p.prefilter}`}`,
  );
  if (!ok) console.log(`    proč tam ten případ je: ${p.why}`);
}
const det = sada.pripady.length - chyb;
console.log(`\nDeterministická část: ${det}/${sada.pripady.length}${chyb ? ` — ${chyb} SELHALO` : ' ✅'}`);

// --- 2) modelová část -------------------------------------------------------

const key = process.env.ANTHROPIC_API_KEY;
const sBandem = sada.pripady.filter((p) => p.scoreBand);
let modelChyb = 0;
let modelBezelo = 0;

if (!key) {
  console.log(
    `\n⚠️  MODELOVÁ ČÁST PŘESKOČENA — chybí ANTHROPIC_API_KEY.` +
      `\n    Neproběhlo ${sBandem.length} případů. Tohle NENÍ zelená: o kvalitě hodnocení to neříká nic.` +
      `\n    Lokálně:  $env:ANTHROPIC_API_KEY = "..."; npm run evals`,
  );
} else {
  console.log(`\n▶ Modelová část — prompt ${PROMPT_VERSION} (${sBandem.length} případů)\n`);
  const system = buildSystem('', settings.regionPriority, prah);
  for (const p of sBandem) {
    const j = job(p);
    const user = [
      `Titul: ${j.title}`,
      `Zaměstnavatel: ${j.employer}`,
      j.location ? `Lokalita: ${j.location}` : 'Lokalita: neuvedena',
      j.region ? `Region (kraj): ${j.region}` : '',
      j.czIsco ? `CZ-ISCO: ${j.czIsco}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.SCORE_MODEL ?? 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const body: any = await res.json();
      const text = (body?.content ?? []).map((c: any) => c?.text ?? '').join('');
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      const rel = Number(parsed?.relevance);
      if (!Number.isFinite(rel)) throw new Error(`model nevrátil skóre: ${text.slice(0, 120)}`);
      modelBezelo++;
      const band = rel >= prah ? 'high' : 'low';
      const ok = band === p.scoreBand;
      if (!ok) modelChyb++;
      console.log(
        `${ok ? '✔' : '✘'} ${rel}/100 (${band}) ${p.job.title.slice(0, 55)}${ok ? '' : `  ← čekáno ${p.scoreBand}`}`,
      );
    } catch (e: any) {
      modelChyb++;
      console.log(`✘ CHYBA ${p.job.title.slice(0, 55)} — ${e?.message ?? e}`);
    }
  }
  const uspech = modelBezelo ? ((modelBezelo - modelChyb) / sBandem.length) * 100 : 0;
  console.log(`\nModelová část: ${sBandem.length - modelChyb}/${sBandem.length} = ${uspech.toFixed(0)} % (práh 90 %)`);
  if (uspech < 90) chyb++;
}

if (chyb) {
  console.log(`\n❌ Evaly neprošly.`);
  process.exit(1);
}
console.log(`\n✅ Evaly prošly. Verze promptu: ${PROMPT_VERSION}`);
