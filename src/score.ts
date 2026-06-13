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

const SYSTEM =
  'Jsi recruiter screener. Hodnotíš, jak moc inzerát odpovídá profilu VEDOUCÍ IT / ' +
  'IT manažer / Head of IT / IT ředitel / CIO / Solution Architect / IT architekt — tedy ' +
  'řídící nebo seniorní architektonické IT role. Odliš „vedoucí IT oddělení" (vysoká relevance) ' +
  'od „IT support / helpdesk / junior / operátor" (nízká). Vrať pouze JSON dle schématu: ' +
  'relevance 0–100, seniority lead|senior|other, reason krátké zdůvodnění česky.';

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function scoreJob(env: Env, job: JobPosting): Promise<ScoreResult> {
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
      system: SYSTEM,
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
