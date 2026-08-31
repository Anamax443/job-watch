// Měřák rozpočtu běhu — src/metrics.ts. Bez sítě, bez D1: obal se zkouší nad atrapou.
// Proč zrovna tohle: strop podřízených požadavků Workeru je SKUTEČNÉ omezení propustnosti
// (na free plánu 50) a dosud se jen odhadoval ze statické analýzy kódu. Když bude měřák
// počítat špatně, opravíme podle něj něco, co není rozbité — nebo přehlédneme, co je.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCounter, formatBudget, wrapDb } from '../src/metrics.ts';

function atrapaDb() {
  const volani: string[] = [];
  const stmt: any = {
    bind: (..._a: unknown[]) => stmt,
    first: async () => { volani.push('first'); return null; },
    run: async () => { volani.push('run'); return {}; },
    all: async () => { volani.push('all'); return { results: [] }; },
  };
  return {
    volani,
    prijateDavky: [] as unknown[][],
    prepare(_sql: string) { return stmt; },
    async batch(st: unknown[]) { this.prijateDavky.push(st); return []; },
    async exec(_s: string) { return {}; },
    stmt,
  };
}

test('každé volání D1 se počítá', async () => {
  const m = createCounter();
  const db = atrapaDb();
  const w = wrapDb(db, m);
  await w.prepare('SELECT 1').bind(1).first();
  await w.prepare('UPDATE x').run();
  await w.prepare('SELECT 2').all();
  assert.equal(m.snapshot().d1, 3);
});

test('dávka se počítá jako JEDEN požadavek — v tom je celý smysl dávkování', async () => {
  const m = createCounter();
  const db = atrapaDb();
  const w = wrapDb(db, m);
  await w.batch([w.prepare('UPDATE a'), w.prepare('UPDATE b'), w.prepare('UPDATE c')]);
  assert.equal(m.snapshot().d1, 1);
});

test('do batch se předají SKUTEČNÉ statementy, ne obaly — jinak by je D1 nepřijala', async () => {
  const m = createCounter();
  const db = atrapaDb();
  const w = wrapDb(db, m);
  await w.batch([w.prepare('UPDATE a').bind(1), w.prepare('UPDATE b')]);
  const davka = db.prijateDavky[0];
  assert.equal(davka.length, 2);
  for (const s of davka) assert.equal(s, db.stmt, 'do D1 prolezl obal místo originálu');
});

test('model a živost se počítají zvlášť od D1', () => {
  const m = createCounter();
  m.add('model', 27);
  m.add('liveness', 5);
  m.add('d1');
  const b = m.snapshot();
  assert.deepEqual(b, { d1: 1, model: 27, liveness: 5, celkem: 33 });
});

test('řádek do logu přizná, že stahování zdrojů se neměří', () => {
  const t = formatBudget({ d1: 8, model: 27, liveness: 5, celkem: 40 }, 27);
  assert.match(t, /D1 8/);
  assert.match(t, /neměří/);
  assert.match(t, /1\.48/); // 40 / 27 na inzerát
});

test('bez ohodnocených se nedělí nulou', () => {
  assert.match(formatBudget({ d1: 3, model: 0, liveness: 0, celkem: 3 }, 0), /—/);
});
