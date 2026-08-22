// Autorizace přístupu — DETERMINISTICKY v aplikaci, ne jen na perimetru.
//
// Proč: citlivé akce kontrolovaly pouze PŘÍTOMNOST hlavičky Cf-Access-Authenticated-User-Email
// a čtecí API (/api/settings s profilem/CV, /api/jobs s kontaktními osobami a jejich e-maily
// a telefony) nekontrolovala nic. Celá obrana tak stála na perimetru — a ten v tomhle projektu
// už jednou prokazatelně selhal: 5. 8. 2026 běžela vedle chráněné domény nechráněná adresa
// *.workers.dev a přes ni šla ta data stáhnout bez přihlášení (viz README, wrangler.toml).
// Kdo se dostane na origin mimo Access, si tu hlavičku pošle sám — proto se ověřuje i HODNOTA:
// kdo to je, ne jen že „někdo je přihlášený".
//
// Pozn.: v datech jsou osobní údaje TŘETÍCH OSOB (kontaktní osoba z MPSV — jméno, e-mail,
// telefon). Nejde tedy jen o vlastní profil; proto je čtení chráněné stejně jako zápis.
//
// Soubor je ZÁMĚRNĚ bez importů (stejně jako src/region.ts) — jde spustit i mimo Worker:
//   npm test   →  node --test tests/access.test.ts

/** Hlavička, kterou na chráněné route nastavuje Cloudflare Access. */
export const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

/** Odhlášení řeší Access na svém endpointu — aplikace žádnou session nedrží. */
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

export type AccessReason =
  | 'ok' // e-mail je na allowlistu
  | 'ok-no-allowlist' // přihlášený, ale allowlist není nastavený (přechodný stav)
  | 'dev-open' // lokální vývoj (DEV_OPEN=1 v .dev.vars), na produkci nikdy
  | 'no-header' // nepřihlášený — hlavička chybí
  | 'not-allowed'; // přihlášený, ale tenhle účet sem nesmí

export interface AccessVerdict {
  ok: boolean;
  status: number; // 200 | 403
  reason: AccessReason;
  email: string | null;
  /** Lidsky čitelný důvod — jde rovnou do odpovědi i do logu. */
  note: string;
}

function normEmail(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Allowlist z varu ACCESS_ALLOWED_EMAILS — oddělovač čárka, středník nebo mezera.
 * Hodnota `*` znamená „kterýkoli účet ověřený Accessem".
 */
export function parseAllowlist(raw: string | null | undefined): string[] {
  return [
    ...new Set(
      String(raw ?? '')
        .split(/[,;\s]+/)
        .map((s) => normEmail(s))
        .filter(Boolean),
    ),
  ];
}

/**
 * Chráněné cesty = celé API, včetně čtení. Ven zůstává jen security.txt (musí být veřejné
 * dle RFC 9116) a statické UI, které samo o sobě žádná data nenese.
 */
export function isProtectedPath(pathname: string): boolean {
  if (pathname === '/.well-known/security.txt') return false;
  return pathname === '/api' || pathname.startsWith('/api/');
}

export interface AuthorizeInput {
  /** Hodnota hlavičky Cf-Access-Authenticated-User-Email (null = chybí). */
  headerEmail: string | null | undefined;
  /** Obsah varu ACCESS_ALLOWED_EMAILS. */
  allowlistRaw?: string | null;
  /** Obsah varu DEV_OPEN — bypass jen pro `wrangler dev`; musí být přesně "1". */
  devOpen?: string | null;
}

export function authorize(input: AuthorizeInput): AccessVerdict {
  // Bypass jen pro lokální vývoj. Záměrně striktní rovnost: prázdný string, "0", "false"
  // ani "true" bypass nezapnou, aby ho nešlo omylem aktivovat překlepem ve varu.
  if (input.devOpen === '1') {
    return { ok: true, status: 200, reason: 'dev-open', email: null, note: 'lokální vývoj (DEV_OPEN=1)' };
  }

  const email = normEmail(input.headerEmail);
  if (!email) {
    return {
      ok: false,
      status: 403,
      reason: 'no-header',
      email: null,
      note: 'Vyžaduje přihlášení (Cloudflare Access).',
    };
  }

  const allow = parseAllowlist(input.allowlistRaw);
  if (!allow.length) {
    // Allowlist nenastavený → pustíme přihlášeného, ale stav se hlásí v /api/health,
    // ať se na to nezapomene. Neblokujeme, aby chybějící var neuzamkl vlastníka venku.
    return {
      ok: true,
      status: 200,
      reason: 'ok-no-allowlist',
      email,
      note: 'ACCESS_ALLOWED_EMAILS není nastaven — projde kterýkoli účet ověřený Accessem',
    };
  }

  if (allow.includes('*') || allow.includes(email)) {
    return { ok: true, status: 200, reason: 'ok', email, note: 'účet je na allowlistu' };
  }

  return {
    ok: false,
    status: 403,
    reason: 'not-allowed',
    email,
    note: `Účet ${email} nemá k této aplikaci přístup.`,
  };
}

/** Stav autorizace pro /api/health — nikdy nevrací seznam adres, jen počet. */
export function accessStatus(allowlistRaw?: string | null): {
  allowlistConfigured: boolean;
  allowedCount: number;
  wildcard: boolean;
} {
  const allow = parseAllowlist(allowlistRaw);
  return {
    allowlistConfigured: allow.length > 0,
    allowedCount: allow.length,
    wildcard: allow.includes('*'),
  };
}
