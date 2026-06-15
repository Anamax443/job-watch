import type { Env, JobPosting, ScoreResult } from './types';
import { messagesCreate, firstText, extractJson } from './anthropic';
import { truncate } from './util';

// Relevance scoring přes levný model (haiku) + structured outputs (JSON-only).

const SCHEMA = {
  type: 'object',
  properties: {
    relevance: { type: 'integer' },
    seniority: { type: 'string', enum: ['lead', 'senior', 'other'] },
    reason: { type: 'string' },
  },
  required: ['relevance', 'seniority', 'reason'],
  additionalProperties: false,
};

const DEFAULT_SYSTEM =
  'Jsi recruiter screener. Hodnotíš, jak moc inzerát odpovídá profilu VEDOUCÍ IT / ' +
  'IT manažer / Head of IT / IT ředitel / CIO / Solution Architect / IT architekt — tedy ' +
  'řídící nebo seniorní architektonické IT role. Odliš „vedoucí IT oddělení" (vysoká relevance) ' +
  'od „IT support / helpdesk / junior / operátor" (nízká). Vrať pouze JSON dle schématu: ' +
  'relevance 0–100, seniority lead|senior|other, reason krátké zdůvodnění česky.';

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Lokalita jako tvrdý faktor: pozice mimo preferovaný region (a ne remote/hybrid s
 * dojezdem) NESMÍ přes práh — i kdyby jinak seděla skvěle. AI má poslední slovo.
 */
function locationClause(region?: string, threshold?: number): string {
  const r = (region ?? '').trim();
  if (!r) return '';
  const t = threshold ?? 70;
  return (
    ` LOKALITA JE ZÁSADNÍ KRITÉRIUM: preferovaný region je „${r}". Pokud pozice NENÍ v tomto ` +
    `regionu a zároveň NENÍ remote/hybridní s reálným dojezdem, MUSÍŠ dát relevance POD ${t} ` +
    `(klidně 30–50), i kdyby role obsahově seděla perfektně. Pozici v regionu nebo plně remote ` +
    `lokalitou nepenalizuj. Když lokalita inzerátu chybí, ber to jako neutrální.`
  );
}

function buildSystem(profile: string, region?: string, threshold?: number): string {
  const loc = locationClause(region, threshold);
  const p = (profile ?? '').trim();
  if (!p) return DEFAULT_SYSTEM + loc;
  return (
    'Jsi recruiter screener. Hodnotíš, jak moc pracovní inzerát sedí na KONKRÉTNÍ profil tohoto ' +
    'kandidáta (zkušenosti, seniorita, zaměření, lokalita, preference):\n\n' +
    p.slice(0, 6000) +
    '\n\nVrať relevance 0–100 = míra shody pozice s TÍMTO profilem (ne obecně), ' +
    'seniority lead|senior|other, reason = krátké zdůvodnění česky vůči profilu.' +
    loc +
    ' Pouze JSON dle schématu.'
  );
}

export async function scoreJob(
  env: Env,
  job: JobPosting,
  profile = '',
  opts: { region?: string; threshold?: number } = {},
): Promise<ScoreResult> {
  const user = [
    `Titul: ${job.title}`,
    `Zaměstnavatel: ${job.employer}${job.isAgency ? ' (personální agentura)' : ''}`,
    job.location ? `Lokalita: ${job.location}` : '',
    job.czIsco ? `CZ-ISCO: ${job.czIsco}` : '',
    job.salaryFrom || job.salaryTo
      ? `Mzda: ${job.salaryFrom ?? '?'}–${job.salaryTo ?? '?'} Kč`
      : '',
    job.description ? `Popis: ${truncate(job.description, 3000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await messagesCreate(env, {
      model: env.SCORE_MODEL,
      max_tokens: 300,
      system: buildSystem(profile, opts.region, opts.threshold),
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    const parsed = extractJson<ScoreResult>(firstText(resp));
    if (parsed && typeof parsed.relevance === 'number') {
      return {
        relevance: clamp(parsed.relevance),
        seniority: parsed.seniority ?? 'other',
        reason: String(parsed.reason ?? ''),
      };
    }
  } catch (e) {
    console.warn(`score ${job.id}: ${e}`);
  }
  return { relevance: 0, seniority: 'other', reason: 'skóre se nepodařilo získat' };
}
