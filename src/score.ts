import type { Env, JobPosting, ScoreResult } from './types';
import { messagesCreate, firstText, extractJson } from './anthropic';
import { providerChain, runWorkersJson } from './ai';
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

/** Sjednotí výstup obou backendů (Workers AI vrací čísla občas jako string). */
function normalize(parsed: any): ScoreResult | null {
  const rel = Number(parsed?.relevance);
  if (!Number.isFinite(rel)) return null;
  const sen: ScoreResult['seniority'] = ['lead', 'senior', 'other'].includes(parsed?.seniority)
    ? parsed.seniority
    : 'other';
  return { relevance: clamp(rel), seniority: sen, reason: String(parsed?.reason ?? '') };
}

export async function scoreJob(
  env: Env,
  job: JobPosting,
  profile = '',
  opts: { region?: string; threshold?: number; provider?: string } = {},
): Promise<ScoreResult | null> {
  const system = buildSystem(profile, opts.region, opts.threshold);
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

  // Backend „dle úhrady": zkoušej v pořadí dle providerChain (default zdarma Workers AI,
  // placený Claude jako fallback). Když jeden selže, spadni na další.
  const chain = providerChain({
    provider: opts.provider,
    anthropicKey: env.ANTHROPIC_API_KEY,
    ai: env.AI,
  });
  for (const provider of chain) {
    try {
      let parsed: any = null;
      if (provider === 'anthropic') {
        const resp = await messagesCreate(env, {
          model: env.SCORE_MODEL,
          max_tokens: 300,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        });
        parsed = extractJson<ScoreResult>(firstText(resp));
      } else {
        // Workers AI (Llama) — JSON přes prompt, viz src/ai.ts.
        parsed = await runWorkersJson(env.AI as Ai, system, user, 400);
      }
      const out = normalize(parsed);
      if (out) return out;
    } catch (e) {
      console.warn(`score ${job.id} [${provider}]: ${e}`);
    }
  }
  // Selhání (rate-limit/parse) → null: NEzapisovat 0, ať se inzerát příště přeskóruje
  // (0 by smyčka brala jako hotové a uvízlo by to).
  return null;
}
