// Filtr výpisu Výsledků — src/store.ts. Čistá funkce: bez D1, bez sítě.
// Proč zrovna tohle: chyba tady se neprojeví jako pád, ale jako tiše chybějící řádky.
// Živý případ 31. 8. 2026: Min. skóre 70 (z Nastavení) ukázalo 3 pozice z 458 a vypadalo to,
// že agent nic nenašel. Zbytek nebyl pod prahem — 299 inzerátů nemá skóre vůbec (NULL)
// a na NULL neplatí žádné porovnání, takže je vyhodil i práh 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BULK_MAX, buildJobsFilter, sanitizeIds } from '../src/store.ts';

const F = { minScore: 0, agencyOnly: false, active: 'all', history: false };

test('bez filtrů projde všechno kromě duplicit', () => {
  const r = buildJobsFilter(F);
  assert.equal(r.where, 'duplicate_of IS NULL');
  assert.deepEqual(r.binds, []);
});

test('min. skóre bez historie zahodí i nehodnocené — to je ta past', () => {
  const r = buildJobsFilter({ ...F, minScore: 70 });
  assert.equal(r.where, 'duplicate_of IS NULL AND relevance >= ?');
  assert.deepEqual(r.binds, [70]);
});

test('„i historie" pustí nehodnocené vedle těch nad prahem', () => {
  const r = buildJobsFilter({ ...F, minScore: 70, history: true });
  assert.equal(r.where, 'duplicate_of IS NULL AND (relevance >= ? OR relevance IS NULL)');
  assert.deepEqual(r.binds, [70]);
});

test('„i historie" při prahu 0 nic nepřidává — jinak by podmínka byla dvakrát nadarmo', () => {
  assert.equal(buildJobsFilter({ ...F, history: true }).where, 'duplicate_of IS NULL');
});

test('jen agentury se přidá jako další podmínka, ne místo prahu', () => {
  const r = buildJobsFilter({ ...F, minScore: 50, agencyOnly: true });
  assert.equal(r.where, 'duplicate_of IS NULL AND relevance >= ? AND is_agency = 1');
});

test('stav „na portálu" bere i dosud neověřené — nic se nesmí tvářit mrtvě předčasně', () => {
  const r = buildJobsFilter({ ...F, active: 'active' });
  assert.equal(r.where, 'duplicate_of IS NULL AND (active IS NULL OR active = 1)');
});

test('stav „staženo z portálu" chce potvrzenou nulu, ne NULL', () => {
  const r = buildJobsFilter({ ...F, active: 'inactive' });
  assert.equal(r.where, 'duplicate_of IS NULL AND active = 0');
});

test('neznámý stav se ignoruje místo prázdného výsledku — hodnota chodí z URL', () => {
  assert.equal(buildJobsFilter({ ...F, active: 'nesmysl' }).where, 'duplicate_of IS NULL');
});

test('všechno naráz drží pořadí bindů shodné s pořadím otazníků', () => {
  const r = buildJobsFilter({ minScore: 60, agencyOnly: true, active: 'active', history: true });
  assert.equal(
    r.where,
    'duplicate_of IS NULL AND (relevance >= ? OR relevance IS NULL) AND is_agency = 1 AND (active IS NULL OR active = 1)',
  );
  assert.deepEqual(r.binds, [60]);
});

// --- Textové hledání + ruční hromadné skóre --------------------------------
// Proč: tohle je jediná cesta, jak do dat sáhne ručně člověk (vyfiltruj „dělník", zaškrtni,
// dej nulu). Chyba v sanitaci id nebo v podmínce znamená zápis jinam, než kam se uživatel díval.

test('hledaný text projde přes název, zaměstnavatele i lokalitu', () => {
  const r = buildJobsFilter({ ...F, q: 'Praha' });
  assert.match(r.where, /lower\(title\) LIKE \?/);
  assert.match(r.where, /lower\(COALESCE\(location,''\)\) LIKE \?/);
  assert.deepEqual(r.binds, ['%praha%', '%praha%', '%praha%', '%praha%']);
});

test('prázdné hledání a samé mezery podmínku nepřidají', () => {
  assert.equal(buildJobsFilter({ ...F, q: '' }).where, 'duplicate_of IS NULL');
  assert.equal(buildJobsFilter({ ...F, q: '   ' }).where, 'duplicate_of IS NULL');
});

test('hledání se skládá s prahem a pořadí bindů sedí na otazníky', () => {
  const r = buildJobsFilter({ ...F, minScore: 70, q: 'dělník' });
  assert.deepEqual(r.binds, [70, '%dělník%', '%dělník%', '%dělník%', '%dělník%']);
});

test('sanitizeIds propustí jen neprázdné řetězce', () => {
  assert.deepEqual(sanitizeIds(['a', '', '  ', 5, null, 'b']), ['a', 'b']);
});

test('duplicitní id se zahodí — jinak by se týž řádek zapsal dvakrát', () => {
  assert.deepEqual(sanitizeIds(['a', 'a', 'b']), ['a', 'b']);
});

test('co není pole, není výběr — tělo požadavku je cizí JSON', () => {
  assert.deepEqual(sanitizeIds(undefined), []);
  assert.deepEqual(sanitizeIds('a,b'), []);
  assert.deepEqual(sanitizeIds({ ids: ['a'] }), []);
});

test('strop hromadného zásahu platí — má to být výběr, ne celá databáze', () => {
  const many = Array.from({ length: BULK_MAX + 50 }, (_, i) => `id-${i}`);
  assert.equal(sanitizeIds(many).length, BULK_MAX);
});
