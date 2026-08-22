// Sebekontrola invariantů — JEDNA definice, DVA spouštěče.
//
// Proč to není další kopie testů: tyhle kontroly běží jak v CI (`tests/selftest.test.ts`),
// tak **uvnitř nasazeného Workeru** (`GET /api/selftest`, stránka `/tests`). Zelené CI dokazuje,
// že prošel commit; zelená stránka dokazuje, že invarianty platí i na tom, co právě běží
// v produkci — s reálnými bindingy a reálným buildem. To je rozdíl, který CI neumí ukázat.
//
// Co sem patří: invarianty nad **čistými funkcemi**, kde selhání znamená tiché špatné chování
// (ne pád) — region, autorizace, prefiltr, dedup, normalizace odpovědi modelu, očista nastavení.
// Co sem NEpatří: cokoli, co sahá na D1, síť nebo AI. Sebekontrola musí být rychlá, bez
// vedlejších účinků a musí jít spustit i na rozbité databázi.
//
// Podrobnější edge-case testy zůstávají v `tests/*.test.ts` — tenhle soubor je průřez
// invarianty, ne úplné pokrytí.

import { applyRegionGate, checkRegion } from './region.ts';
import { authorize, isProtectedPath, parseAllowlist } from './access.ts';
import { prefilter } from './prefilter.ts';
import { dedupKey, fingerprintText } from './store.ts';
import { normalizeScore } from './score.ts';
import { sanitizeSettings } from './config.ts';
import { norm, num, truncate } from './util.ts';
import type { JobPosting, Settings } from './types.ts';

export interface SelfCheck {
  /** Skupina pro seskupení ve výpisu. */
  skupina: string;
  /** Co se kontroluje. */
  nazev: string;
  /** PROČ ta kontrola existuje — bez toho nikdo neví, co hlídá. */
  proc: string;
  ok: boolean;
  ocekavano: string;
  dostal: string;
}

export interface SelfTestResult {
  ok: boolean;
  celkem: number;
  proslo: number;
  selhalo: number;
  ms: number;
  kontroly: SelfCheck[];
}

function job(p: Partial<JobPosting>): JobPosting {
  return { id: 'x:1', source: 'mpsv', title: '', employer: '', isAgency: false, ...p };
}

const NASTAVENI = {
  keywords: ['vedoucí IT', 'head of it'],
  czIscoPrefixes: ['133'],
} as unknown as Settings;

const DLOUHY_POPIS = [
  'Hledáme zkušeného vedoucího IT oddělení, který převezme odpovědnost za provoz i rozvoj celé infrastruktury.',
  'Očekáváme praxi se správou ERP systému, serverovou infrastrukturou a řízením externích dodavatelů.',
  'Krátká věta.',
].join(' ');

/** Spustí všechny kontroly. Bez vedlejších účinků — nedotýká se D1, sítě ani AI. */
export function runSelfTest(): SelfTestResult {
  const t0 = Date.now();
  const kontroly: SelfCheck[] = [];

  const check = (
    skupina: string,
    nazev: string,
    proc: string,
    ocekavano: unknown,
    dostal: unknown,
  ) => {
    const a = JSON.stringify(ocekavano);
    const b = JSON.stringify(dostal);
    kontroly.push({ skupina, nazev, proc, ok: a === b, ocekavano: a, dostal: b });
  };

  // --- Region: o lokalitě rozhoduje kód, ne model ---------------------------
  const R = 'Region';
  check(
    R,
    'Praha při nastavení „brno" = mimo region',
    'Živý incident 5. 8. 2026: free model dal pražskému inzerátu 80/100 se zdůvodněním „je v preferovaném regionu".',
    'out',
    checkRegion({ title: 'Vývojáři softwaru', location: 'Praha, Hlavní město Praha', region: 'Hlavní město Praha' }, 'brno').verdict,
  );
  check(R, 'Brno při „brno" projde', 'Nesmí penalizovat to, co hledám.', 'in', checkRegion({ location: 'Brno-střed' }, 'brno').verdict);
  check(
    R,
    'MPSV formát (PSČ + kraj) se rozpozná',
    'MPSV posílá plnou strukturovanou adresu, ne holý název města.',
    'in',
    checkRegion({ location: 'Kounicova 949/2, 602 00 Brno-střed, Jihomoravský kraj', region: 'Jihomoravský kraj' }, 'brno').verdict,
  );
  check(R, 'Remote / celá ČR se nepenalizuje', 'Práce na dálku je platná i mimo region.', 'remote', checkRegion({ location: 'Celá ČR (remote)' }, 'brno').verdict);
  check(R, 'Neurčitelná lokalita = „nevím"', 'Inzerát bez lokality nesmí projít jen kvůli obsahu.', 'unknown', checkRegion({ title: 'Head of IT' }, 'brno').verdict);
  check(R, 'Prázdný region v Nastavení = filtr vypnutý', 'Kdo region nezadá, nechce filtrovat.', 'off', checkRegion({ location: 'Praha' }, '').verdict);

  const gated = applyRegionGate(
    { relevance: 80, reason: 'Lokalita je v Praze, což je v preferovaném regionu.' },
    { title: 'Vývojáři softwaru', location: 'Praha, Hlavní město Praha', region: 'Hlavní město Praha' },
    'brno',
    70,
  );
  check(R, 'Skóre mimo region se zastropuje pod práh', 'Poslední slovo má kód: 80 → max 40, i když model tvrdí opak.', true, gated.capped && gated.relevance <= 40);
  check(R, 'Důvod zastropování je vidět', 'Musí to jít poznat v appce i v notifikaci, ne jen v logu.', true, gated.reason.startsWith('⛔'));
  const keep = applyRegionGate({ relevance: 82, reason: 'Sedí.' }, { location: 'Brno' }, 'brno', 70);
  check(R, 'Pozice v regionu se nezastropuje', 'Filtr nesmí srážet i to, co je správně.', 82, keep.relevance);

  // --- Autorizace ------------------------------------------------------------
  const A = 'Autorizace';
  check(A, 'Bez hlavičky Access = zamítnuto', 'Nepřihlášený nesmí dál ani na čtení.', false, authorize({ headerEmail: null, allowlistRaw: 'a@b.cz' }).ok);
  check(
    A,
    'Cizí účet s ručně poslanou hlavičkou neprojde',
    'Kdo se dostane na origin mimo Access, pošle si hlavičku sám — proto se ověřuje HODNOTA.',
    false,
    authorize({ headerEmail: 'utocnik@example.com', allowlistRaw: 'milan@example.cz' }).ok,
  );
  check(A, 'Účet na allowlistu projde', 'Kontrola nesmí zamykat i toho, kdo tam patří.', true, authorize({ headerEmail: 'milan@example.cz', allowlistRaw: 'milan@example.cz' }).ok);
  check(A, 'Porovnání ignoruje velikost písmen a mezery', 'IdP posílá adresu tak, jak ji má uloženou.', true, authorize({ headerEmail: '  Milan@Example.CZ ', allowlistRaw: 'milan@example.cz' }).ok);
  check(A, 'DEV_OPEN musí být přesně „1"', 'Překlep ve varu nesmí otevřít produkci.', false, authorize({ headerEmail: null, devOpen: 'true' }).ok);
  check(A, 'Chráněné je celé /api včetně čtení', 'Tam jsou profil/CV i kontaktní osoby z inzerátů.', true, ['/api/jobs', '/api/settings', '/api/health', '/api/runs'].every(isProtectedPath));
  check(A, 'security.txt zůstává veřejné', 'Vyžaduje to RFC 9116.', false, isProtectedPath('/.well-known/security.txt'));
  check(A, 'Allowlist snese čárku, středník i mezeru', 'Ať se nedá rozbít formátem zápisu.', ['a@x.cz', 'b@x.cz'], parseAllowlist('a@x.cz; b@x.cz  a@x.cz'));

  // --- Prefiltr: řídí spotřebu AI --------------------------------------------
  const P = 'Prefiltr';
  check(P, 'Shoda CZ-ISCO propustí', 'MPSV má klasifikaci i tam, kde titul klíčové slovo nenese.', 1, prefilter([job({ czIsco: '13301' })], NASTAVENI).length);
  check(P, 'Klíčové slovo bez diakritiky propustí', 'Zdroje píšou titulky různě.', 1, prefilter([job({ title: 'VEDOUCI IT oddeleni' })], NASTAVENI).length);
  check(P, 'Nesouvisející inzerát neprojde', 'To je celý smysl filtru.', 0, prefilter([job({ title: 'Skladník', czIsco: '9333' })], NASTAVENI).length);
  check(
    P,
    'Klíčové slovo ze samých mezer NEpropustí všechno',
    'Nalezená chyba 22. 8. 2026: `k &&` bylo pro "  " pravda, ale includes("") je vždy true → na AI šlo úplně všechno.',
    0,
    prefilter([job({ title: 'Skladník', czIsco: '9333' })], { keywords: ['  '], czIscoPrefixes: [''] } as unknown as Settings).length,
  );

  // --- Dedup -----------------------------------------------------------------
  const D = 'Deduplikace';
  check(
    D,
    'Stejná nabídka ze dvou zdrojů = stejný klíč',
    'Tatáž pozice chodí přes MPSV i ATS s jiným zápisem; jinak přijdou dvě notifikace.',
    true,
    dedupKey(job({ employer: 'AXIMA, spol. s r.o.', title: 'Vedoucí IT', location: 'Brno' })) ===
      dedupKey(job({ employer: 'axima,  SPOL. S R.O.', title: 'VEDOUCI  IT', location: 'brno' })),
  );
  check(
    D,
    'Plná adresa a holé město dají stejný klíč',
    'MPSV posílá „Brno-střed, Jihomoravský kraj", ATS jen „Brno-střed".',
    true,
    dedupKey(job({ employer: 'F', title: 'T', location: 'Brno-střed, Jihomoravský kraj' })) ===
      dedupKey(job({ employer: 'F', title: 'T', location: 'Brno-střed' })),
  );
  check(D, 'Jiný zaměstnavatel = jiný klíč', 'Dvě firmy hledající totéž nesmí splynout.', false, dedupKey(job({ employer: 'A', title: 'T' })) === dedupKey(job({ employer: 'B', title: 'T' })));
  check(D, 'Krátký popis nedá otisk', 'Otisk z pár slov by spojil nesouvisející inzeráty.', null, fingerprintText(job({ description: 'Hledáme IT manažera.' })));
  check(
    D,
    'Otisk je stabilní napříč zápisem',
    'Tentýž text v jiném formátování musí dát tentýž otisk.',
    true,
    fingerprintText(job({ description: DLOUHY_POPIS })) === fingerprintText(job({ description: DLOUHY_POPIS.replace(/\s+/g, '  ').toUpperCase() })),
  );

  // --- Odpověď modelu --------------------------------------------------------
  const S = 'Skóre';
  check(S, 'Číslo jako text se převede', 'Workers AI (Llama) vrací relevance občas jako string.', 85, normalizeScore({ relevance: '85', seniority: 'lead', reason: '' })?.relevance);
  check(S, 'Skóre se ořízne do 0–100', 'Model umí vrátit 120 i −5.', [100, 0], [normalizeScore({ relevance: 120 })?.relevance, normalizeScore({ relevance: -5 })?.relevance]);
  check(S, 'Neznámá seniorita spadne na „other"', 'Model si občas vymyslí hodnotu mimo výčet.', 'other', normalizeScore({ relevance: 50, seniority: 'manager' })?.seniority);
  check(
    S,
    'Odpověď bez skóre vrací null, NE nulu',
    'Nalezená chyba 22. 8. 2026: Number(null) je 0 → inzerát by se uložil s nulou a nikdy nepřeskóroval.',
    [null, null, null, null],
    [
      normalizeScore({ relevance: null }),
      normalizeScore({ relevance: '' }),
      normalizeScore({ relevance: false }),
      normalizeScore({}),
    ],
  );
  check(S, 'Nula od modelu je platné skóre', 'Skutečná nula se nesmí zaměnit za chybu.', 0, normalizeScore({ relevance: 0 })?.relevance);

  // --- Očista nastavení ------------------------------------------------------
  const N = 'Nastavení';
  check(N, 'Práh i min. skóre se zastropují na 0–100', 'Do pole jde napsat cokoli; procenta mimo rozsah by rozbila filtr.', [100, 0], [
    sanitizeSettings({ notifyThreshold: 900 }).notifyThreshold,
    sanitizeSettings({ minScore: -20 }).minScore,
  ]);
  check(N, 'Nesmysl v číselném poli dá 0, ne NaN', 'NaN v prahu by propustil/zahodil všechno.', 0, sanitizeSettings({ minScore: 'abc' }).minScore);
  check(N, 'Neznámý AI backend se zahodí', 'Jinak by šlo nastavit provider, který neexistuje.', undefined, sanitizeSettings({ aiProvider: 'gpt' }).aiProvider);
  check(N, 'Neznámá pole se do Nastavení nedostanou', 'Vstup z API je cizí JSON, ne důvěryhodný objekt.', undefined, (sanitizeSettings({ smyslNeexistuje: 1 }) as any).smyslNeexistuje);

  // --- Pomocné funkce --------------------------------------------------------
  const U = 'Pomocné';
  check(U, 'norm sjednotí diakritiku a mezery', 'Stojí na tom dedup i prefiltr.', 'vedouci it oddeleni', norm('  Vedoucí   IT ODDĚLENÍ '));
  check(U, 'truncate krátí jen když je potřeba', 'Zbytečná výpustka mate čtenáře notifikace.', ['abc…', 'abc'], [truncate('abcdef', 3), truncate('abc', 3)]);
  check(U, 'num propustí jen konečná čísla', 'Mzda ze zdroje bývá string nebo nesmysl.', [60000, undefined], [num('60000'), num('nedohodou')]);

  const selhalo = kontroly.filter((k) => !k.ok).length;
  return {
    ok: selhalo === 0,
    celkem: kontroly.length,
    proslo: kontroly.length - selhalo,
    selhalo,
    ms: Date.now() - t0,
    kontroly,
  };
}
