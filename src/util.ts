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
