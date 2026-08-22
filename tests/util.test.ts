// Sdílené funkce — src/util.ts. Stojí na nich dedup i prefiltr, takže tichá změna chování
// tady se projeví až jako duplicitní notifikace nebo prázdný výsledek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsAny, norm, num, stripHtml, truncate } from '../src/util.ts';

test('norm sjednotí diakritiku, velikost písmen i mezery — na tom stojí dedup klíč', () => {
  assert.equal(norm('  Vedoucí   IT ODDĚLENÍ '), 'vedouci it oddeleni');
});

test('norm zvládne null/undefined — zdroje pole vynechávají', () => {
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
});

test('containsAny ignoruje prázdné jehly', () => {
  assert.equal(containsAny('Vedoucí IT', ['', 'vedouci']), true);
  assert.equal(containsAny('Skladník', ['vedouci']), false);
});

test('stripHtml udělá z ATS popisu čitelný text — odstavce oddělí, značky zahodí', () => {
  const t = stripHtml('<p>První</p><p>Druhá</p>');
  // Přesné mezerování je záměrně nespecifikované („hrubé" odstranění HTML) — testuje se
  // invariant: odstavce se nesmí slepit na jeden řádek a ve výstupu nesmí zůstat značka.
  assert.match(t, /^První\s*\n\s*Druhá$/);
  assert.equal(t.includes('<'), false);
  assert.equal(stripHtml('a &amp; b'), 'a & b');
  assert.equal(stripHtml(null), '');
});

test('truncate přidá výpustku jen když opravdu krátí', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate(null, 5), '');
});

test('num propustí jen konečná čísla — mzda ze zdroje bývá string nebo nesmysl', () => {
  assert.equal(num('60000'), 60000);
  assert.equal(num(60000), 60000);
  assert.equal(num('nedohodou'), undefined);
  assert.equal(num(null), undefined);
  assert.equal(num(Infinity), undefined);
});
