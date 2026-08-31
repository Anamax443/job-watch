// Sdílené pomocné funkce (bez závislostí na Workeru/DB).

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** lowercase + bez diakritiky + sjednocené mezery — pro porovnávání/dedup. */
export function norm(s: string | undefined | null): string {
  return stripDiacritics(String(s ?? ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsAny(haystack: string, needles: string[]): boolean {
  const h = norm(haystack);
  return needles.some((n) => n && h.includes(norm(n)));
}

/** Hrubé odstranění HTML + dekódování pár entit — ATS popisy bývají HTML. */
export function stripHtml(s: string | undefined | null): string {
  if (!s) return '';
  return String(s)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function sha256hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function truncate(s: string | undefined | null, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Stránkování seznamu výsledků (`/api/jobs`).
 *
 * Proč vzniklo: seznam měl natvrdo strop 200 bez offsetu. Starší inzeráty v D1 zůstávaly
 * (nic se nemaže), ale z UI se na ně nedalo dostat — a hlavička hlásila „200 pozic", tedy
 * useknutý seznam vypadal jako úplný. Strop 500 na jeden dotaz drží velikost odpovědi,
 * přes `offset` se dá dojít až na konec.
 *
 * Nesmysl (prázdno, text, záporné číslo) padá na default, ne na chybu — filtr v URL píše
 * i člověk a prázdný seznam by vypadal jako „nic nenalezeno".
 */
export function pageParams(
  limitRaw: string | null | undefined,
  offsetRaw: string | null | undefined,
): { limit: number; offset: number } {
  const l = parseInt(limitRaw ?? '', 10);
  const o = parseInt(offsetRaw ?? '', 10);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, 500) : 200,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}
