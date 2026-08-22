// Deduplikace a otisk inzerátu — src/store.ts. Čisté funkce nad JobPosting: bez D1, bez sítě.
// Proč zrovna tohle: stejná nabídka chodí přes MPSV, ATS i agregátor a několikrát v čase.
// Když se dedup rozbije, projeví se to jako lavina duplicitních notifikací — tiše.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobPosting } from '../src/types.ts';
import { contentHash, dedupKey, fingerprintHash, fingerprintText } from '../src/store.ts';

function job(p: Partial<JobPosting>): JobPosting {
  return { id: 'x:1', source: 'x', title: '', employer: '', isAgency: false, ...p };
}

test('stejná nabídka ze dvou zdrojů dá stejný dedup klíč — liší se jen zápis', () => {
  const mpsv = job({ employer: 'AXIMA, spol. s r.o.', title: 'Vedoucí IT', location: 'Brno' });
  const ats = job({ employer: 'axima,  SPOL. S R.O.', title: 'VEDOUCI  IT', location: 'brno' });
  assert.equal(dedupKey(mpsv), dedupKey(ats));
});

test('dedup klíč bere jen první část lokality — MPSV posílá plnou adresu, ATS jen město', () => {
  const a = job({ employer: 'Firma', title: 'Head of IT', location: 'Brno-střed, Jihomoravský kraj' });
  const b = job({ employer: 'Firma', title: 'Head of IT', location: 'Brno-střed' });
  assert.equal(dedupKey(a), dedupKey(b));
});

test('jiný zaměstnavatel = jiný klíč — dvě firmy hledající totéž nesmí splynout', () => {
  const a = job({ employer: 'Firma A', title: 'IT manažer', location: 'Brno' });
  const b = job({ employer: 'Firma B', title: 'IT manažer', location: 'Brno' });
  assert.notEqual(dedupKey(a), dedupKey(b));
});

test('chybějící lokalita klíč nerozbije (u ATS je běžná)', () => {
  assert.equal(dedupKey(job({ employer: 'Firma', title: 'CIO' })), 'firma|cio|');
});

test('contentHash se změní se mzdou — jinak by úprava inzerátu prošla bez povšimnutí', async () => {
  const base = job({ title: 'IT manažer', description: 'Popis', salaryFrom: 60000 });
  const raised = job({ title: 'IT manažer', description: 'Popis', salaryFrom: 90000 });
  assert.notEqual(await contentHash(base), await contentHash(raised));
});

test('contentHash je pro shodný obsah stabilní — jinak by se inzerát „měnil" každý běh', async () => {
  const a = job({ title: 'IT manažer', description: 'Popis', location: 'Brno' });
  const b = job({ title: 'IT manažer', description: 'Popis', location: 'Brno' });
  assert.equal(await contentHash(a), await contentHash(b));
});

const DLOUHY_POPIS = [
  'Hledáme zkušeného vedoucího IT oddělení, který převezme odpovědnost za provoz i rozvoj celé infrastruktury.',
  'Očekáváme praxi se správou ERP systému, serverovou infrastrukturou a řízením externích dodavatelů.',
  'Krátká věta.',
].join(' ');

test('otisk potřebuje dost textu — krátký popis dá null místo falešné shody', () => {
  assert.equal(fingerprintText(job({ description: 'Hledáme IT manažera.' })), null);
  assert.equal(fingerprintText(job({})), null);
});

test('otisk je stejný napříč zdroji, i když se liší diakritika a mezery', () => {
  const a = fingerprintText(job({ description: DLOUHY_POPIS }));
  const b = fingerprintText(job({ description: DLOUHY_POPIS.replace(/\s+/g, '  ').toUpperCase() }));
  assert.notEqual(a, null);
  assert.equal(a, b);
});

test('otisk ignoruje krátké věty — berou se jen ty distinktivní', () => {
  const t = fingerprintText(job({ description: DLOUHY_POPIS })) ?? '';
  assert.equal(t.includes('kratka veta'), false);
  assert.equal(t.split(' | ').length, 2);
});

test('dva různé inzeráty nemají stejný otisk', async () => {
  const a = await fingerprintHash(job({ description: DLOUHY_POPIS }));
  const b = await fingerprintHash(
    job({ description: DLOUHY_POPIS.replace('vedoucího IT oddělení', 'skladníka do provozu') }),
  );
  assert.notEqual(a, null);
  assert.notEqual(a, b);
});

test('fingerprintHash vrací null tam, kde otisk nevznikl — nesmí hashovat prázdno', async () => {
  assert.equal(await fingerprintHash(job({ description: 'krátké' })), null);
});
