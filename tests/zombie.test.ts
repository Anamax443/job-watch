// Hlídač nedoběhlých běhů — src/store.ts. Zkouší se nad atrapou D1, bez sítě.
// Proč zrovna tohle: catch v pipeline chytá vyhozené výjimky, ale ne zabití zvenčí.
// Běh 132 (1. 9. 2026) platforma ukončila při dojíždění fronty — žádná chyba, žádné
// finished_at, v tabulce visel otevřený záznam a agent se tvářil, že pracuje.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uzavriZombie, ZOMBIE_PO_MINUTACH } from '../src/store.ts';

function db(results: unknown[]) {
  const dotazy: { sql: string; binds: unknown[] }[] = [];
  const mk = (sql: string): any => {
    let binds: unknown[] = [];
    const st: any = {
      bind: (...b: unknown[]) => { binds = b; return st; },
      all: async () => { dotazy.push({ sql, binds }); return { results }; },
      run: async () => { dotazy.push({ sql, binds }); return {}; },
    };
    return st;
  };
  return { dotazy, DB: { prepare: mk } } as any;
}

test('bez otevřených běhů se nic nezavírá a nic se neposílá', async () => {
  const env = db([]);
  assert.deepEqual(await uzavriZombie(env), []);
  // jen SELECT, žádný UPDATE — hlídač nemá šahat na data, když není proč
  assert.equal(env.dotazy.length, 1);
  assert.match(env.dotazy[0].sql, /SELECT/);
});

test('otevřený běh starší než hranice se vrátí i uzavře', async () => {
  const env = db([{ id: 132, started_at: '2026-09-01 05:20:44' }]);
  const z = await uzavriZombie(env);
  assert.deepEqual(z, [{ id: 132, started_at: '2026-09-01 05:20:44' }]);
  assert.equal(env.dotazy.length, 2);
  assert.match(env.dotazy[1].sql, /UPDATE runs/);
  assert.match(env.dotazy[1].sql, /finished_at = datetime/);
});

test('do logu běhu se napíše, že to uzavřel hlídač — ne že běh dopadl dobře', async () => {
  const env = db([{ id: 1, started_at: 'x' }]);
  await uzavriZombie(env);
  assert.match(env.dotazy[1].sql, /hlídač/);
  assert.match(env.dotazy[1].sql, /ok = 0/);
});

test('hranice se předává jako platný interval pro SQLite', async () => {
  const env = db([]);
  await uzavriZombie(env, 6);
  assert.deepEqual(env.dotazy[0].binds, ['-6 minutes']);
});

test('nesmyslná hranice se srovná na aspoň minutu — nula by uzavřela i právě běžící běh', async () => {
  const env = db([]);
  await uzavriZombie(env, 0);
  assert.deepEqual(env.dotazy[0].binds, ['-1 minutes']);
});

test('výchozí hranice je delší než rozpočet běhu, ať se nezabíjí živý běh', () => {
  // Rozpočet cronu je 60 s; hlídač čeká 6 minut.
  assert.ok(ZOMBIE_PO_MINUTACH * 60 > 60, 'hlídač by mohl uzavřít běh, který ještě žije');
});
