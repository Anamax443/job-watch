// Předfiltr před AI — src/prefilter.ts. Rozhoduje, co se vůbec dostane na (placené) skórování.
// Když propustí moc, hoří rozpočet AI; když propustí málo, inzerát se nikdy neobjeví.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobPosting, Settings } from '../src/types.ts';
import { prefilter } from '../src/prefilter.ts';

const S = { keywords: ['vedoucí IT', 'head of it'], czIscoPrefixes: ['1330'] } as unknown as Settings;

function job(p: Partial<JobPosting>): JobPosting {
  return { id: 'x:1', source: 'mpsv', title: '', employer: '', isAgency: false, ...p };
}

test('projde shoda CZ-ISCO prefixem — MPSV klasifikaci má, klíčová slova v titulu často ne', () => {
  const out = prefilter([job({ title: 'Řídící pracovník v IT', czIsco: '13301' })], S);
  assert.equal(out.length, 1);
});

test('CZ-ISCO se porovnává po číslicích — zdroje posílají i tvar s tečkami/mezerami', () => {
  assert.equal(prefilter([job({ czIsco: '1330.1' })], S).length, 1);
  assert.equal(prefilter([job({ czIsco: '2 5 1 1' })], S).length, 0);
});

test('projde klíčové slovo bez ohledu na diakritiku a velikost písmen', () => {
  assert.equal(prefilter([job({ title: 'VEDOUCI IT oddeleni' })], S).length, 1);
  assert.equal(prefilter([job({ title: 'Head of IT' })], S).length, 1);
});

test('klíčové slovo se hledá i v popisu — ATS titul bývá marketingový', () => {
  assert.equal(prefilter([job({ title: 'Nová výzva', description: 'Role: vedoucí IT' })], S).length, 1);
});

test('nesouvisející inzerát neprojde — to je smysl filtru', () => {
  assert.equal(prefilter([job({ title: 'Skladník', description: 'Práce ve skladu.', czIsco: '9333' })], S).length, 0);
});

test('web hledání jde rovnou na AI — dotaz je předfiltroval sám', () => {
  assert.equal(prefilter([job({ source: 'web:adzuna', title: 'Skladník' })], S).length, 1);
});

test('jobs.cz už výjimku nemá — listovka vracela i skladníky a seřizovače', () => {
  // Do 31. 8. 2026 platilo `j.source === 'jobs.cz'` jako propustka, na předpoklad
  // „listovka je předfiltrovaná dotazem". Nebyla: 139 nezpracovaných inzerátů z jobs.cz
  // bylo mimo obor. Posuzuje se tedy jako každý jiný zdroj.
  assert.equal(prefilter([job({ source: 'jobs.cz', title: 'Skladník' })], S).length, 0);
  assert.equal(prefilter([job({ source: 'jobs.cz', title: 'Vedoucí IT' })], S).length, 1);
});

test('klíčové slovo se hledá jako celé slovo — „CIO" nesmí chytit „stacionář"', () => {
  // Živý nález 31. 8. 2026: 69 ze 139 nezpracovaných inzerátů MPSV prošlo takhle.
  // Pracovník v sociálních službách v denním STACIOnáři jako IT ředitel.
  const socialni = job({
    source: 'mpsv',
    title: 'Pracovník/ice v sociálních službách - přímá péče v denním stacionáři',
    czIsco: 'CzIsco/53112',
  });
  assert.equal(prefilter([socialni], S).length, 0);
  assert.equal(prefilter([job({ source: 'mpsv', title: 'CIO', czIsco: 'CzIsco/1330' })], S).length, 1);
});

test('mimo kraj neprojde už na vstupu — dřív to řešil až strop skóre po ohodnocení', () => {
  const R = { ...S, regionPriority: 'brno' } as unknown as Settings;
  const praha = job({ source: 'mpsv', title: 'Vedoucí IT', location: 'Praha', region: 'Hlavní město Praha' });
  const brno = job({ source: 'mpsv', title: 'Vedoucí IT', location: 'Brno-střed', region: 'Jihomoravský kraj' });
  assert.equal(prefilter([praha], R).length, 0);
  assert.equal(prefilter([brno], R).length, 1);
});

test('neznámá lokalita se nezahazuje — ATS inzeráty ji často neuvádějí', () => {
  const R = { ...S, regionPriority: 'brno' } as unknown as Settings;
  assert.equal(prefilter([job({ source: 'ats:x', title: 'Vedoucí IT' })], R).length, 1);
});

test('inzerát bez CZ-ISCO i bez klíčového slova neprojde ani omylem přes prázdné pole', () => {
  assert.equal(prefilter([job({ title: '', description: '' })], S).length, 0);
});

test('prázdné klíčové slovo v Nastavení nesmí propustit všechno', () => {
  const dirty = { keywords: ['', '  '], czIscoPrefixes: [''] } as unknown as Settings;
  assert.equal(prefilter([job({ title: 'Skladník', czIsco: '9333' })], dirty).length, 0);
});
