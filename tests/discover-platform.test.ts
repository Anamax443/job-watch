// Rozpoznání ATS platformy z URL — src/discover.ts. Čistá funkce, žádná síť.
//
// Proč to má vlastní testy: URL sem chodí od modelu, který ji vzal z cizího webu. Je to
// nedůvěryhodný vstup a rozhoduje o tom, co se uloží do tabulky `sources` jako zdroj
// nabídek. Do 1. 9. 2026 se host porovnával přes `includes`, takže `lever.co.evil.example`
// prošlo jako Lever — útočníkova doména by se zapsala mezi důvěryhodné ATS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../src/discover.ts';

test('platné ATS adresy se rozpoznají i se slugem', () => {
  assert.deepEqual(detectPlatform('https://axima.recruitee.com/o/vedouci-it'), {
    platform: 'recruitee',
    slug: 'axima',
  });
  assert.deepEqual(detectPlatform('https://boards.greenhouse.io/acme/jobs/123'), {
    platform: 'greenhouse',
    slug: 'acme',
  });
  assert.deepEqual(detectPlatform('https://boards.greenhouse.io/embed/job_board?for=acme'), {
    platform: 'greenhouse',
    slug: 'acme',
  });
  assert.deepEqual(detectPlatform('https://jobs.lever.co/acme/abc-123'), {
    platform: 'lever',
    slug: 'acme',
  });
  assert.deepEqual(detectPlatform('https://jobs.ashbyhq.com/acme'), {
    platform: 'ashby',
    slug: 'acme',
  });
  assert.deepEqual(detectPlatform('https://jobs.smartrecruiters.com/acme'), {
    platform: 'smartrecruiters',
    slug: 'acme',
  });
});

test('doména se porovnává celá, ne podřetězcem — cizí host se za ATS nevydá', () => {
  // Tohle je ta vada: `host.includes('lever.co')` na obojím vracelo platform: 'lever'.
  for (const url of [
    'https://lever.co.evil.example/acme',
    'https://jobs.lever.co.evil.example/acme',
    'https://nelever.co/acme',
    'https://greenhouse.io.evil.example/acme',
    'https://ashbyhq.com.evil.example/acme',
    'https://smartrecruiters.com.evil.example/acme',
    'https://evil.example/jobs.lever.co/acme',
  ]) {
    assert.equal(detectPlatform(url), null, `${url} se nesmí vydávat za ATS`);
  }
});

test('doména bez subdomény projde, prázdná cesta ne', () => {
  assert.deepEqual(detectPlatform('https://lever.co/acme'), { platform: 'lever', slug: 'acme' });
  assert.equal(detectPlatform('https://jobs.lever.co/'), null, 'bez slugu se platforma neurčuje');
});

test('nesmysly nespadnou, vrátí null', () => {
  assert.equal(detectPlatform(null), null);
  assert.equal(detectPlatform(undefined), null);
  assert.equal(detectPlatform(''), null);
  assert.equal(detectPlatform('tohle není URL'), null);
  assert.equal(detectPlatform('https://kariera.axima.cz/pozice'), null, 'vlastní web není ATS');
});
