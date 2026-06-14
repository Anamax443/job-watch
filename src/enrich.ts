import type { Env, JobPosting, EnrichResult } from './types';
import { messagesCreate, allText, extractJson } from './anthropic';
import { truncate } from './util';

// Deanonymizace: u agenturního inzerátu najdi PŮVODCE.
// Sonnet 4.6 + web_search/web_fetch — vybere distinktivní věty, vyhledá je,
// preferuje first-party stránky firmy (ty prozradí skutečného zaměstnavatele).

const SYSTEM =
  'Jsi rešeršér. Agentura inzerát anonymizuje a skrývá skutečného zaměstnavatele. Najdi PŮVODCE ' +
  'inzerátu metodou OTISKU VĚTY:\n' +
  '1) Vyber 1–3 KOMPLIKOVANÉ, dlouhé a konkrétní věty z popisu — ideálně ze sekcí „nabízíme" / ' +
  '„požadujeme" / náplň práce (mají specifické formulace). Vyhni se obecným frázím („dynamický kolektiv").\n' +
  '2) Hledej každou jako CELOU větu v uvozovkách = PŘESNÁ, 100% doslovná shoda. Taková věta funguje ' +
  'jako unikátní otisk a vyhledávač ji najde i na stránkách skutečného zadavatele.\n' +
  '3) web_fetch ověř doslovný výskyt. PREFERUJ first-party stránky firmy (vlastní kariérní web / vlastní ' +
  'ATS *.recruitee.com / boards.greenhouse.io / jobs.lever.co) před jobboardy — ty prozradí původce.\n' +
  'Vrať POUZE jeden JSON objekt: {"realEmployer": string|null, "realEmployerUrl": string|null, ' +
  '"confidence": 0-100, "duplicateUrls": string[]}. confidence = jistota původce (0 když nenalezeno). ' +
  'duplicateUrls = další místa s týmž inzerátem (včetně opakování v čase).';

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function enrichOriginator(env: Env, job: JobPosting): Promise<EnrichResult> {
  const user = [
    `Agentura: ${job.employer}`,
    job.title ? `Titul: ${job.title}` : '',
    job.location ? `Lokalita: ${job.location}` : '',
    `Popis inzerátu:\n${truncate(job.description, 4000)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: user },
  ];

  try {
    let resp = await messagesCreate(env, {
      model: env.ENRICH_MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    // Server-side tool smyčka: při pause_turn znovu pošli s připojenou odpovědí.
    let guard = 0;
    while (resp?.stop_reason === 'pause_turn' && guard++ < 6) {
      messages.push({ role: 'assistant', content: resp.content });
      resp = await messagesCreate(env, {
        model: env.ENRICH_MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
    }

    const parsed = extractJson<EnrichResult>(allText(resp));
    if (parsed) {
      return {
        realEmployer: parsed.realEmployer || undefined,
        realEmployerUrl: parsed.realEmployerUrl || undefined,
        confidence: clamp(Number(parsed.confidence) || 0),
        duplicateUrls: Array.isArray(parsed.duplicateUrls) ? parsed.duplicateUrls.slice(0, 10) : [],
      };
    }
  } catch (e) {
    console.warn(`enrich ${job.id}: ${e}`);
  }
  return { confidence: 0, duplicateUrls: [] };
}
