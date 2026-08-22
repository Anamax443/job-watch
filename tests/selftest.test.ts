// Sebekontrola invariantů — tady se ověřuje, že sada z src/selftest.ts prochází.
// TÁŽ sada běží i uvnitř nasazeného Workeru (GET /api/selftest, stránka /tests),
// takže tenhle test hlídá commit a stránka hlídá to, co reálně běží v produkci.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSelfTest } from '../src/selftest.ts';

test('celá sada invariantů projde', () => {
  const r = runSelfTest();
  const spadle = r.kontroly
    .filter((k) => !k.ok)
    .map((k) => `${k.skupina} / ${k.nazev}: čekáno ${k.ocekavano}, dostal ${k.dostal}`);
  assert.deepEqual(spadle, []);
  assert.equal(r.ok, true);
});

test('každá kontrola říká PROČ existuje — bez toho nikdo neví, co hlídá', () => {
  const r = runSelfTest();
  assert.ok(r.celkem >= 25, `čekal jsem aspoň 25 kontrol, je jich ${r.celkem}`);
  for (const k of r.kontroly) {
    assert.ok(k.skupina, 'kontrola bez skupiny');
    assert.ok(k.nazev, 'kontrola bez názvu');
    assert.ok(k.proc && k.proc.length > 20, `kontrola „${k.nazev}" nemá pořádné zdůvodnění`);
  }
});

test('sada je bez vedlejších účinků — smí běžet v Workeru na každý dotaz', () => {
  const a = runSelfTest();
  const b = runSelfTest();
  assert.equal(a.celkem, b.celkem);
  assert.equal(a.proslo, b.proslo);
  assert.equal(b.ok, true);
});

test('součty sedí — stránka /tests je ukazuje uživateli', () => {
  const r = runSelfTest();
  assert.equal(r.proslo + r.selhalo, r.celkem);
  assert.equal(r.ok, r.selhalo === 0);
});
