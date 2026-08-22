// Autorizace — src/access.ts. Testuje se čistá funkce nad hlavičkou a allowlistem:
// žádná DB, žádný Worker, žádná síť. Každý případ říká PROČ tam je.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessStatus,
  authorize,
  isProtectedPath,
  parseAllowlist,
} from '../src/access.ts';

test('bez hlavičky = 403 — nepřihlášený nesmí dál ani na čtení', () => {
  const v = authorize({ headerEmail: null, allowlistRaw: 'milan@example.cz' });
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
  assert.equal(v.reason, 'no-header');
});

test('prázdná hlavička je totéž co chybějící — Access ji nikdy neposílá prázdnou', () => {
  assert.equal(authorize({ headerEmail: '   ', allowlistRaw: 'a@b.cz' }).ok, false);
});

test('INCIDENT 5. 8. 2026: cizí účet s ručně poslanou hlavičkou neprojde', () => {
  // Tehdy existovala nechráněná workers.dev adresa vedle domény za Accessem a aplikace
  // kontrolovala jen PŘÍTOMNOST hlavičky. Kdo se dostane na origin mimo Access, pošle si ji sám.
  const v = authorize({ headerEmail: 'utocnik@example.com', allowlistRaw: 'milan@example.cz' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not-allowed');
  assert.match(v.note, /nemá k této aplikaci přístup/);
});

test('účet na allowlistu projde', () => {
  const v = authorize({ headerEmail: 'milan@example.cz', allowlistRaw: 'milan@example.cz' });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'ok');
});

test('porovnání ignoruje velikost písmen a mezery — IdP posílá adresu, jak ji má', () => {
  const v = authorize({ headerEmail: '  Milan@Example.CZ ', allowlistRaw: 'milan@example.cz' });
  assert.equal(v.ok, true);
});

test('nenastavený allowlist pustí přihlášeného, ale označí to — nesmí uzamknout vlastníka venku', () => {
  const v = authorize({ headerEmail: 'kdokoli@example.cz', allowlistRaw: '' });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'ok-no-allowlist');
});

test('"*" = kterýkoli účet ověřený Accessem, ale pořád jen ověřený', () => {
  assert.equal(authorize({ headerEmail: 'kdo@koli.cz', allowlistRaw: '*' }).ok, true);
  assert.equal(authorize({ headerEmail: null, allowlistRaw: '*' }).ok, false);
});

test('DEV_OPEN musí být přesně "1" — překlep nesmí otevřít produkci', () => {
  for (const v of ['', '0', 'false', 'true', 'yes', ' 1', undefined, null]) {
    assert.equal(
      authorize({ headerEmail: null, allowlistRaw: 'a@b.cz', devOpen: v as string }).ok,
      false,
      `devOpen=${JSON.stringify(v)} nesmí projít`,
    );
  }
  assert.equal(authorize({ headerEmail: null, devOpen: '1' }).ok, true);
});

test('chráněné je CELÉ /api včetně čtení — tam jsou profil/CV a kontaktní osoby', () => {
  for (const p of ['/api/jobs', '/api/settings', '/api/health', '/api/keys', '/api/runs', '/api/sources']) {
    assert.equal(isProtectedPath(p), true, `${p} musí být chráněná`);
  }
});

test('security.txt a statické UI zůstávají veřejné — RFC 9116 a stránka bez dat', () => {
  assert.equal(isProtectedPath('/.well-known/security.txt'), false);
  assert.equal(isProtectedPath('/'), false);
  assert.equal(isProtectedPath('/settings.html'), false);
});

test('cesta jen začínající na /api nesmí obejít filtr', () => {
  // /apixyz není API, ale /api/ prefix se nesmí dát obejít podřetězcem
  assert.equal(isProtectedPath('/apixyz'), false);
  assert.equal(isProtectedPath('/api'), true);
  assert.equal(isProtectedPath('/api/'), true);
});

test('parseAllowlist zvládne čárku, středník i mezeru a odstraní duplicity', () => {
  assert.deepEqual(parseAllowlist('a@x.cz, b@x.cz; a@x.cz  c@x.cz'), ['a@x.cz', 'b@x.cz', 'c@x.cz']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('accessStatus nikdy nevrací samotné adresy — /api/health je hlásit nesmí', () => {
  const s = accessStatus('milan@example.cz, sef@example.cz');
  assert.deepEqual(s, { allowlistConfigured: true, allowedCount: 2, wildcard: false });
  assert.equal(JSON.stringify(s).includes('example.cz'), false);
});
