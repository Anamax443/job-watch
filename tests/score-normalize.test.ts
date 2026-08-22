// Normalizace odpovědi modelu — src/score.ts. Nejsnáz testovatelné místo celé AI vrstvy:
// čistá funkce nad tím, co přišlo z backendu. Free model (Llama) vrací tvary, které Claude nevrací.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScore } from '../src/score.ts';

test('Workers AI vrací čísla jako string — musí se převést, ne zahodit', () => {
  assert.deepEqual(normalizeScore({ relevance: '85', seniority: 'lead', reason: 'sedí' }), {
    relevance: 85,
    seniority: 'lead',
    reason: 'sedí',
  });
});

test('neznámá seniorita spadne na "other" — model si občas vymyslí hodnotu mimo enum', () => {
  assert.equal(normalizeScore({ relevance: 50, seniority: 'manager' })?.seniority, 'other');
  assert.equal(normalizeScore({ relevance: 50 })?.seniority, 'other');
});

test('skóre se ořízne do 0–100 — model umí vrátit 120 i -5', () => {
  assert.equal(normalizeScore({ relevance: 120 })?.relevance, 100);
  assert.equal(normalizeScore({ relevance: -5 })?.relevance, 0);
});

test('desetinné skóre se zaokrouhlí — do DB patří celé číslo', () => {
  assert.equal(normalizeScore({ relevance: 72.6 })?.relevance, 73);
});

test('bez použitelné relevance vrací null — NESMÍ vyrobit 0', () => {
  // 0 by smyčka brala jako hotové skóre a inzerát by se už nikdy nepřeskóroval (uvízl by).
  // Number(null)/Number('')/Number(false)/Number([]) je 0 — všechny tyhle tvary musí dát null.
  const bads = [{}, null, undefined, 'text', { relevance: 'nevím' }, { relevance: null },
    { relevance: '' }, { relevance: '   ' }, { relevance: false }, { relevance: [] },
    { relevance: {} }, { relevance: NaN }];
  for (const bad of bads) {
    assert.equal(normalizeScore(bad), null, `${JSON.stringify(bad)} musí dát null`);
  }
});

test('chybějící reason nesmí shodit zápis — vrací prázdný string', () => {
  assert.equal(normalizeScore({ relevance: 10 })?.reason, '');
});

test('relevance 0 od modelu je platné skóre, ne chyba', () => {
  assert.equal(normalizeScore({ relevance: 0 })?.relevance, 0);
});
