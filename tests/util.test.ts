// Sdílené funkce — src/util.ts. Stojí na nich dedup i prefiltr, takže tichá změna chování
// tady se projeví až jako duplicitní notifikace nebo prázdný výsledek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsAny, norm, num, pageParams, stripHtml, truncate } from '../src/util.ts';

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

// Stránkování /api/jobs. Proč zrovna tohle: v D1 se nic nemaže, ale seznam měl natvrdo strop
// 200 bez offsetu — starší inzeráty existovaly a nedaly se zobrazit. Chyba tady se neprojeví
// jako pád, ale jako tiše chybějící kus historie.

test('bez parametrů první stránka po 200 — beze změny chování odkazu bez query', () => {
  assert.deepEqual(pageParams(null, null), { limit: 200, offset: 0 });
});

test('offset posune na další stránku — tudy se jde na starší inzeráty', () => {
  assert.deepEqual(pageParams('200', '400'), { limit: 200, offset: 400 });
});

test('limit se stropuje na 500 — jedna odpověď nesmí nafouknout celou D1 do JSONu', () => {
  assert.equal(pageParams('5000', null).limit, 500);
});

test('limit 0 padá na default, ne na prázdný seznam — jinak by to vypadalo jako „nic nenalezeno"', () => {
  assert.equal(pageParams('0', null).limit, 200);
});

test('nesmysl v URL padá na default místo chyby — query si upravuje i člověk', () => {
  assert.deepEqual(pageParams('abc', 'xyz'), { limit: 200, offset: 0 });
});

test('záporný offset se nebere — SQLite by na OFFSET -1 vrátil celý zbytek', () => {
  assert.equal(pageParams(null, '-5').offset, 0);
});
