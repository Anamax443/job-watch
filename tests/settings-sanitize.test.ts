// Očista vstupu do Nastavení — src/config.ts. Jediná obrana mezi cizím JSONem z API
// a hodnotami, které pak řídí pipeline (co se hledá, co se pustí na AI, kdy se notifikuje).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../src/config.ts';

test('procenta se zastropují do 0–100 — jinak by práh rozbil filtr', () => {
  assert.equal(sanitizeSettings({ notifyThreshold: 900 }).notifyThreshold, 100);
  assert.equal(sanitizeSettings({ notifyThreshold: -5 }).notifyThreshold, 0);
  assert.equal(sanitizeSettings({ minScore: 900 }).minScore, 100);
  assert.equal(sanitizeSettings({ minScore: -20 }).minScore, 0);
});

test('nesmysl v číselném poli dá 0, ne NaN — NaN by propustil nebo zahodil všechno', () => {
  assert.equal(sanitizeSettings({ minScore: 'abc' }).minScore, 0);
  assert.equal(sanitizeSettings({ notifyThreshold: {} }).notifyThreshold, 0);
});

test('nula je platná hodnota, ne „nezadáno"', () => {
  assert.equal(sanitizeSettings({ minScore: 0 }).minScore, 0);
});

test('chybějící pole se neukládá — částečný zápis nesmí přepsat zbytek nastavení', () => {
  const out = sanitizeSettings({ minScore: 10 });
  assert.equal('notifyThreshold' in out, false);
  assert.equal('keywords' in out, false);
});

test('neznámá pole se zahodí — vstup z API je cizí JSON', () => {
  const out: any = sanitizeSettings({ minScore: 10, smyslNeexistuje: 1, DB: 'drop' });
  assert.equal(out.smyslNeexistuje, undefined);
  assert.equal(out.DB, undefined);
});

test('neznámý AI backend se zahodí, známý projde', () => {
  assert.equal(sanitizeSettings({ aiProvider: 'gpt' }).aiProvider, undefined);
  assert.equal(sanitizeSettings({ aiProvider: ' Workers-AI ' }).aiProvider, 'workers-ai');
});

test('seznamy se ořežou a prázdné položky vypadnou — prázdné klíčové slovo propouštělo vše', () => {
  assert.deepEqual(sanitizeSettings({ keywords: [' vedoucí IT ', '', '   '] }).keywords, ['vedoucí IT']);
});

test('nevalidní typ seznamu se ignoruje, nespadne', () => {
  assert.equal('keywords' in sanitizeSettings({ keywords: 'vedoucí IT' }), false);
});
