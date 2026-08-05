// Kontrola filtru regionu na reálných případech — spuštění:  npm run check:region
// Nepotřebuje Worker ani D1; src/region.ts je schválně bez importů.

import { checkRegion, applyRegionGate } from '../src/region.ts';

type Case = {
  why: string;
  job: { title?: string; location?: string; region?: string };
  want: string;
  expect: string;
};

const CASES: Case[] = [
  {
    // Živý případ z 5. 8. 2026: e-mail „Vývojáři softwaru / MSD, Praha", AI dala 80/100
    // se zdůvodněním „Lokalita je v Praze, což je v preferovaném regionu" — a v Nastavení „brno".
    why: 'Praha při nastavení „brno" = mimo region',
    job: { title: 'Vývojáři softwaru', location: 'Praha, Hlavní město Praha', region: 'Hlavní město Praha' },
    want: 'brno',
    expect: 'out',
  },
  { why: 'Brno při „brno"', job: { location: 'Brno-střed' }, want: 'brno', expect: 'in' },
  {
    why: 'MPSV formát: PSČ + kraj',
    job: { location: 'Kounicova 949/2, 602 00 Brno-střed, Jihomoravský kraj', region: 'Jihomoravský kraj' },
    want: 'brno',
    expect: 'in',
  },
  {
    why: 'jiná obec téhož kraje projde',
    job: { location: 'Znojmo', region: 'Jihomoravský kraj' },
    want: 'Jihomoravský kraj',
    expect: 'in',
  },
  {
    why: 'Olomoucký kraj při „brno" = mimo',
    job: { location: '779 00 Olomouc, Olomoucký kraj', region: 'Olomoucký kraj' },
    want: 'brno',
    expect: 'out',
  },
  { why: 'celá ČR (remote) projde', job: { location: 'Celá ČR (remote)' }, want: 'brno', expect: 'remote' },
  { why: 'remote v titulu projde', job: { title: 'IT Manager (remote)', location: 'Praha' }, want: 'brno', expect: 'remote' },
  { why: 'prázdná lokalita = nevím', job: { title: 'Head of IT' }, want: 'brno', expect: 'unknown' },
  { why: 'neurčitelná lokalita = nevím', job: { location: 'sídlo společnosti' }, want: 'brno', expect: 'unknown' },
  { why: 'prázdný region v Nastavení = filtr vypnutý', job: { location: 'Praha' }, want: '', expect: 'off' },
  {
    why: 'zadání mimo číselník se porovná textem',
    job: { location: 'Bílovice nad Svitavou' },
    want: 'Bílovice nad Svitavou',
    expect: 'in',
  },
  { why: 'Ostrava při „Praha" = mimo', job: { location: 'Ostrava-Poruba' }, want: 'Praha', expect: 'out' },
];

let bad = 0;
for (const c of CASES) {
  const r = checkRegion(c.job, c.want);
  const ok = r.verdict === c.expect;
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✘'} ${c.why} → ${r.verdict}${ok ? '' : ` (čekáno ${c.expect})`} — ${r.note}`);
}

// Strop skóre na živém případu
const gated = applyRegionGate(
  { relevance: 80, reason: 'Lokalita je v Praze, což je v preferovaném regionu.' },
  { title: 'Vývojáři softwaru', location: 'Praha, Hlavní město Praha', region: 'Hlavní město Praha' },
  'brno',
  70,
);
const gateOk = gated.relevance < 70 && gated.capped;
if (!gateOk) bad++;
console.log(`${gateOk ? '✔' : '✘'} strop skóre: 80 → ${gated.relevance} — ${gated.reason}`);

const keep = applyRegionGate({ relevance: 82, reason: 'Sedí na profil.' }, { location: 'Brno' }, 'brno', 70);
const keepOk = keep.relevance === 82 && !keep.capped;
if (!keepOk) bad++;
console.log(`${keepOk ? '✔' : '✘'} Brno se nepenalizuje: 82 → ${keep.relevance}`);

console.log(bad ? `\n${bad} selhalo` : `\nVšech ${CASES.length + 2} kontrol prošlo`);
process.exit(bad ? 1 : 0);
