import type { Env } from './types';

// Ověření živosti inzerátu. U portálů s detailní URL (jobs.cz /rpd/<id>, prace.cz
// /nabidka/<uuid>) vrací zrušený inzerát HTTP 404 (ověřeno živě), aktivní 200.
// Signál bereme ze stavového kódu, ne z textu stránky (v aktivní stránce se slova
// jako „ukončen"/„404" vyskytují v JS chrome → false positive).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Detailní URL, u nichž expirace = 404 (deterministické, umíme ověřit). */
export function isCheckableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /jobs\.cz\/rpd\//.test(url) || /prace\.cz\/nabidka\//.test(url);
}

export type Liveness = 'active' | 'gone' | 'unknown';

export async function checkUrl(url: string): Promise<Liveness> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'cs', Accept: 'text/html' },
    });
    // Tělo nepotřebujeme (rozhoduje status) → zavři stream, ať neblokuje.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.status === 404 || res.status === 410) return 'gone';
    if (res.status >= 200 && res.status < 300) return 'active';
    return 'unknown'; // 403/5xx/redirect na jinou doménu → nejistota, stav neměníme
  } catch {
    return 'unknown';
  }
}

export interface LivenessResult {
  checked: number;
  gone: number;
  active: number;
}

/**
 * Znovu ověří živost dávky zobrazovaných inzerátů. Prioritu mají dosud neověřené
 * a nejdéle neověřené (ty, co vypadly z listovky = podezřelé na expiraci). Už
 * potvrzené zrušené (active=0) se běžně nepřečítají (mrtvý inzerát neožije).
 */
export async function recheckLiveness(
  env: Env,
  log: (m: string) => void,
  deadline: number,
  limit: number,
): Promise<LivenessResult> {
  const rows = await env.DB.prepare(
    `SELECT id, url FROM seen_jobs
     WHERE duplicate_of IS NULL
       AND (active IS NULL OR active = 1)
       AND url IS NOT NULL
       AND (url LIKE '%jobs.cz/rpd/%' OR url LIKE '%prace.cz/nabidka/%')
     ORDER BY (active_checked_at IS NULL) DESC, active_checked_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; url: string }>();

  const list = rows.results ?? [];
  const out: LivenessResult = { checked: 0, gone: 0, active: 0 };
  const BATCH = 6;
  for (let b = 0; b < list.length; b += BATCH) {
    if (Date.now() > deadline) break;
    await Promise.all(
      list.slice(b, b + BATCH).map(async (r) => {
        const state = await checkUrl(r.url);
        out.checked++;
        if (state === 'gone') out.gone++;
        else if (state === 'active') out.active++;
        // 'unknown' → stav nesaháme, jen posuneme active_checked_at, ať se necyklí.
        if (state === 'gone') {
          await env.DB.prepare(
            "UPDATE seen_jobs SET active = 0, active_checked_at = datetime('now') WHERE id = ?",
          )
            .bind(r.id)
            .run();
          log(`  🚫 zrušeno: ${r.url}`);
        } else if (state === 'active') {
          await env.DB.prepare(
            "UPDATE seen_jobs SET active = 1, active_checked_at = datetime('now') WHERE id = ?",
          )
            .bind(r.id)
            .run();
        } else {
          await env.DB.prepare(
            "UPDATE seen_jobs SET active_checked_at = datetime('now') WHERE id = ?",
          )
            .bind(r.id)
            .run();
        }
      }),
    );
  }
  return out;
}
