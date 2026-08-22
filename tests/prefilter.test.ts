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

test('cílené zdroje jdou rovnou na AI — dotaz je předfiltroval sám', () => {
  assert.equal(prefilter([job({ source: 'web:adzuna', title: 'Skladník' })], S).length, 1);
  assert.equal(prefilter([job({ source: 'jobs.cz', title: 'Skladník' })], S).length, 1);
});

test('inzerát bez CZ-ISCO i bez klíčového slova neprojde ani omylem přes prázdné pole', () => {
  assert.equal(prefilter([job({ title: '', description: '' })], S).length, 0);
});

test('prázdné klíčové slovo v Nastavení nesmí propustit všechno', () => {
  const dirty = { keywords: ['', '  '], czIscoPrefixes: [''] } as unknown as Settings;
  assert.equal(prefilter([job({ title: 'Skladník', czIsco: '9333' })], dirty).length, 0);
});
