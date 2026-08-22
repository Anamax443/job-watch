import type { Env, JobPosting, AtsTarget } from '../types.ts';
import { loadAtsTargets, markSourceChecked } from '../store.ts';
import { stripHtml, truncate } from '../util.ts';

// Generický adaptér nad veřejnými JSON API náborových systémů (ATS).
// Cíle se NEberou ze statické konfigurace — čtou se z D1 `sources` (dynamicky objevené
// přes discover.ts). Bez auth, bez bot ochrany; fetchery jsou defenzivní a při chybě cíl
// přeskočí (a označí zdroj jako nefunkční).

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`ATS ${url}: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`ATS ${url}: ${e}`);
    return null;
  }
}

function base(t: AtsTarget) {
  return {
    source: `ats:${t.platform}:${t.company}`,
    employer: t.label ?? t.company,
    isAgency: !!t.isAgency,
  };
}

// https://{company}.recruitee.com/api/offers/
async function fromRecruitee(t: AtsTarget): Promise<JobPosting[]> {
  const data = await getJson(`https://${t.company}.recruitee.com/api/offers/`);
  const offers: any[] = data?.offers ?? [];
  const b = base(t);
  return offers.map((o) => ({
    id: `${b.source}:${o.id}`,
    source: b.source,
    title: String(o.title ?? '').trim(),
    employer: b.employer,
    location: [o.city, o.country_code].filter(Boolean).join(', ') || o.location || undefined,
    url: o.careers_url ?? o.url,
    description: truncate(stripHtml(o.description), 8000),
    datePosted: o.published_at ?? o.created_at,
    isAgency: b.isAgency,
  }));
}

// https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true
async function fromGreenhouse(t: AtsTarget): Promise<JobPosting[]> {
  const data = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${t.company}/jobs?content=true`,
  );
  const jobs: any[] = data?.jobs ?? [];
  const b = base(t);
  return jobs.map((j) => ({
    id: `${b.source}:${j.id}`,
    source: b.source,
    title: String(j.title ?? '').trim(),
    employer: b.employer,
    location: j.location?.name,
    url: j.absolute_url,
    description: truncate(stripHtml(j.content), 8000),
    datePosted: j.updated_at,
    isAgency: b.isAgency,
  }));
}

// https://api.lever.co/v0/postings/{company}?mode=json
async function fromLever(t: AtsTarget): Promise<JobPosting[]> {
  const data = await getJson(`https://api.lever.co/v0/postings/${t.company}?mode=json`);
  const posts: any[] = Array.isArray(data) ? data : [];
  const b = base(t);
  return posts.map((p) => ({
    id: `${b.source}:${p.id}`,
    source: b.source,
    title: String(p.text ?? '').trim(),
    employer: b.employer,
    location: p.categories?.location,
    url: p.hostedUrl,
    description: truncate(p.descriptionPlain ?? stripHtml(p.description), 8000),
    isAgency: b.isAgency,
  }));
}

// https://api.ashbyhq.com/posting-api/job-board/{company}
async function fromAshby(t: AtsTarget): Promise<JobPosting[]> {
  const data = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${t.company}?includeCompensation=true`,
  );
  const jobs: any[] = data?.jobs ?? [];
  const b = base(t);
  return jobs.map((j) => ({
    id: `${b.source}:${j.id}`,
    source: b.source,
    title: String(j.title ?? '').trim(),
    employer: b.employer,
    location: j.location ?? j.locationName,
    url: j.jobUrl ?? j.applyUrl,
    description: truncate(j.descriptionPlain ?? stripHtml(j.descriptionHtml), 8000),
    isAgency: b.isAgency,
  }));
}

// https://api.smartrecruiters.com/v1/companies/{company}/postings
async function fromSmartRecruiters(t: AtsTarget): Promise<JobPosting[]> {
  const data = await getJson(
    `https://api.smartrecruiters.com/v1/companies/${t.company}/postings?limit=100`,
  );
  const content: any[] = data?.content ?? [];
  const b = base(t);
  // Popis vyžaduje detailní volání per-inzerát → vynecháno (TODO, kvůli rate limitu).
  return content.map((p) => ({
    id: `${b.source}:${p.id}`,
    source: b.source,
    title: String(p.name ?? '').trim(),
    employer: b.employer,
    location: [p.location?.city, p.location?.country].filter(Boolean).join(', ') || undefined,
    url: `https://jobs.smartrecruiters.com/${t.company}/${p.id}`,
    datePosted: p.releasedDate,
    isAgency: b.isAgency,
  }));
}

async function fetchTarget(t: AtsTarget): Promise<JobPosting[]> {
  switch (t.platform) {
    case 'recruitee':
      return fromRecruitee(t);
    case 'greenhouse':
      return fromGreenhouse(t);
    case 'lever':
      return fromLever(t);
    case 'ashby':
      return fromAshby(t);
    case 'smartrecruiters':
      return fromSmartRecruiters(t);
    default:
      return [];
  }
}

export async function fetchAts(env: Env, log?: (msg: string) => void): Promise<JobPosting[]> {
  const targets = await loadAtsTargets(env);
  if (!targets.length) {
    // Komunikační identifikátor: prázdný registr ≠ výpadek. Cíle (Greenhouse/Lever/Recruitee/
    // Ashby/SmartRecruiters) plní jen screening přes Claude (discover.ts) — ve free/off režimu vypnutý.
    log?.('📡 ATS: 0 cílů v registru sources — nic k obvolání (firmy objevuje jen screening přes Claude, teď vypnuto)');
    return [];
  }
  const out: JobPosting[] = [];
  const probes: string[] = []; // komunikační stopa per cíl (platforma:firma → počet / chyba)
  await Promise.all(
    targets.map(async (t) => {
      try {
        const jobs = await fetchTarget(t);
        let n = 0;
        for (const job of jobs)
          if (job.title) {
            out.push(job);
            n++;
          }
        probes.push(`${t.platform}:${t.company}→${n}`);
        if (t.sourceId) await markSourceChecked(env, t.sourceId, true);
      } catch (e) {
        console.warn(`ATS ${t.platform}:${t.company}:`, e);
        probes.push(`${t.platform}:${t.company}→chyba`);
        if (t.sourceId) await markSourceChecked(env, t.sourceId, false);
      }
    }),
  );
  log?.(`📡 ATS: obvoláno ${targets.length} cílů — ${probes.join(', ')}`);
  console.log(`ATS: ${out.length} záznamů z ${targets.length} cílů (z D1)`);
  return out;
}
