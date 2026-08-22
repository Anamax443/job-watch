import type { Env, JobPosting } from '../types.ts';
import { AGENCY_REGISTRY_URL, getMeta, isAgencyByName, setMeta } from '../config.ts';

// Klasifikace "personální agentura" napříč zdroji.
// Primárně: IČO zaměstnavatele je v registru agentur práce (MPSV).
// Fallback: shoda názvu (isAgencyByName), dokud není registr napojený.

const CACHE_KEY = 'agency_icos';
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // týden

interface IcoCache {
  fetchedAt: number;
  icos: string[];
}

/**
 * Načte množinu IČO agentur práce. Cachuje v meta na týden.
 * Dokud AGENCY_REGISTRY_URL není doplněn, vrací prázdnou množinu (klasifikace
 * pak běží jen podle názvu). Parser je defenzivní — ověřit formát zdroje při napojení.
 */
export async function loadAgencyIcos(env: Env): Promise<Set<string>> {
  if (!AGENCY_REGISTRY_URL) return new Set();

  const cached = await getMeta(env, CACHE_KEY);
  if (cached) {
    try {
      const c = JSON.parse(cached) as IcoCache;
      if (Date.now() - c.fetchedAt < REFRESH_MS) return new Set(c.icos);
    } catch {
      /* ignore, refetch */
    }
  }

  try {
    const res = await fetch(AGENCY_REGISTRY_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`Registr agentur: HTTP ${res.status}`);
      return new Set();
    }
    const data: any = await res.json();
    const icos = extractIcos(data);
    await setMeta(env, CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), icos } as IcoCache));
    console.log(`Registr agentur: ${icos.length} IČO`);
    return new Set(icos);
  } catch (e) {
    console.warn('Registr agentur: chyba načtení', e);
    return new Set();
  }
}

/** Vytáhne IČO z různých možných tvarů zdroje (ověřit při napojení). */
function extractIcos(data: any): string[] {
  const rows: any[] = Array.isArray(data)
    ? data
    : data?.polozky ?? data?.items ?? data?.data ?? [];
  const out = new Set<string>();
  for (const r of rows) {
    const ico = r?.ico ?? r?.ICO ?? r?.identifikacniCislo ?? r?.ic;
    if (ico != null) out.add(String(ico).padStart(8, '0'));
  }
  return [...out];
}

export function classifyAgency(job: JobPosting, icoSet: Set<string>): boolean {
  if (job.isAgency) return true;
  if (job.employerIco && icoSet.has(String(job.employerIco).padStart(8, '0'))) return true;
  return isAgencyByName(job.employer);
}

/** Nastaví is_agency na všech inzerátech (mutuje a vrací). */
export function applyAgencyFlag(jobs: JobPosting[], icoSet: Set<string>): JobPosting[] {
  for (const j of jobs) j.isAgency = classifyAgency(j, icoSet);
  return jobs;
}
