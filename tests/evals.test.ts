// Přesnost evaluační sady — src/evals.ts. Čistá funkce nad hotovými výsledky.
// Proč zrovna tohle: prostý podíl „kolik uhádl" obojí schová. Sada, kde je většina případů
// záporná (a ta naše je: 16 z 23 čekáme low), vypadá skvěle i s modelem, který neposílá nic.
// Precision a recall říkají dvě různé věci a jen spolu dávají smysl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spoctiPresnost } from '../src/evals.ts';

const p = (expected: 'high' | 'low', got: 'high' | 'low' | null) =>
  ({ why: '', title: '', expected, got, relevance: null, provider: null, ok: expected === got, reason: null });

test('model, který neposílá nic, má recall 0 — i když „uhádne" většinu', () => {
  // 8 správných zamítnutí, 2 propásnuté leady. Podíl správných 8/10 = 80 %, ale agent je k ničemu.
  const r = spoctiPresnost([
    ...Array.from({ length: 8 }, () => p('low', 'low')),
    p('high', 'low'),
    p('high', 'low'),
  ]);
  assert.equal(r.recall, 0);
  assert.equal(r.precision, null); // nic neposlal → precision se nedá spočítat
});

test('model, který posílá všechno, má recall 1 a mizernou precision', () => {
  const r = spoctiPresnost([p('high', 'high'), p('low', 'high'), p('low', 'high'), p('low', 'high')]);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 0.25);
});

test('dokonalý výsledek dá obě jedničky', () => {
  const r = spoctiPresnost([p('high', 'high'), p('high', 'high'), p('low', 'low')]);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});

test('nezodpovězený případ se do přesnosti nepočítá — není to chyba modelu ani úspěch', () => {
  // Výpadek backendu by jinak vypadal jako špatné hodnocení a hnal by nás ladit prompt.
  const r = spoctiPresnost([p('high', 'high'), p('high', null), p('low', null)]);
  assert.deepEqual([r.tp, r.fp, r.fn, r.tn], [1, 0, 0, 0]);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});

test('bez jediné odpovědi se nedělí nulou', () => {
  const r = spoctiPresnost([p('high', null)]);
  assert.equal(r.precision, null);
  assert.equal(r.recall, null);
});
