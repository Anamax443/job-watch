// Živost inzerátu — src/liveness.ts + scripts/portal-liveness.ts. Čisté funkce: bez sítě, bez D1.
// Proč zrovna tohle: živost je jediné, co odděluje „nabídka platí" od „VŘ dávno skončilo",
// a plete se tiše. Špatně přečtený 403 buď pohřbí živé inzeráty, nebo drží v seznamu mrtvé —
// v obou případech to vypadá jako normální provoz a v UI se to nijak neprojeví.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus } from '../src/liveness.ts';
import { buildSql, looksBlocked, parseRows, type Verdict } from '../scripts/portal-liveness.ts';

test('404 i 410 = inzerát stažen z portálu', () => {
  assert.equal(classifyStatus(404), 'gone');
  assert.equal(classifyStatus(410), 'gone');
});

test('2xx = inzerát na portálu je', () => {
  assert.equal(classifyStatus(200), 'active');
  assert.equal(classifyStatus(204), 'active');
});

test('403 není „mrtvý" — je to ochrana proti robotům, o inzerátu neříká nic', () => {
  assert.equal(classifyStatus(403), 'unknown');
});

test('5xx není „mrtvý" — výpadek portálu by jinak zabil celý seznam naráz', () => {
  assert.equal(classifyStatus(500), 'unknown');
  assert.equal(classifyStatus(503), 'unknown');
});

test('nejistý stav posune jen razítko kontroly, na active nesahá', () => {
  const sql = buildSql([{ id: 'jobscz:2001304367', state: 'unknown' }]).join('\n');
  assert.match(sql, /SET active_checked_at=/);
  assert.doesNotMatch(sql, /active=0/);
  assert.doesNotMatch(sql, /active=1/);
});

test('stažený dostane active=0, živý active=1 — každý ve svém statementu', () => {
  const v: Verdict[] = [
    { id: 'jobscz:2001304367', state: 'gone' },
    { id: 'jobscz:2001272131', state: 'active' },
  ];
  const sql = buildSql(v);
  assert.equal(sql.length, 2);
  assert.match(sql[0], /active=0.*'jobscz:2001304367'/);
  assert.match(sql[1], /active=1.*'jobscz:2001272131'/);
});

test('apostrof v id se zdvojí — jinak by id rozbilo SQL', () => {
  const sql = buildSql([{ id: "jobscz:o'brien", state: 'gone' }]).join('\n');
  assert.match(sql, /'jobscz:o''brien'/);
});

test('žádné verdikty = neprázdný soubor, prázdný --file wrangler odmítne', () => {
  assert.deepEqual(buildSql([]), ['SELECT 1;']);
});

test('většina nejistých = blokace runneru, ne výsledek měření', () => {
  assert.equal(looksBlocked({ checked: 142, unknown: 140 }), true);
});

test('pár nejistých mezi stovkou je normální provoz, ne poplach', () => {
  assert.equal(looksBlocked({ checked: 142, unknown: 3 }), false);
});

test('malý vzorek se neshazuje — 2 ze 3 nejistých nic nedokazuje', () => {
  assert.equal(looksBlocked({ checked: 3, unknown: 2 }), false);
});

test('výstup wrangleru se přečte i zabalený v poli, řádky bez url se zahodí', () => {
  const raw = [{ results: [{ id: 'a', url: 'https://x' }, { id: 'b', url: null }], success: true }];
  assert.deepEqual(parseRows(raw), [{ id: 'a', url: 'https://x' }]);
});
