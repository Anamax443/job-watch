import type { Env, JobPosting, ScoreResult } from './types';
import { messagesCreate, firstText, extractJson } from './anthropic';
import { providerChain, runWorkersJson } from './ai';
import { applyRegionGate } from './region';
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
 * dojezdem) NESMÍ přes práh — i kdyby jinak seděla skvěle.
 *
 * Tahle věta v promptu je jen NÁPOVĚDA pro model. O výsledku rozhoduje deterministický
 * strop v src/region.ts (applyRegionGate níže) — free model instrukci prokazatelně
 * ignoroval (pražský inzerát dostal 80/100 s odůvodněním „je v preferovaném regionu").
 */
function locationClause(region?: string, threshold?: number): string {
  const r = (region ?? '').trim();
  if (!r) return '';
  const t = threshold ?? 70;
  return (
    ` LOKALITA JE ZÁSADNÍ KRITÉRIUM: preferovaný region je „${r}". Pokud pozice NENÍ v tomto ` +
    `regionu a zároveň NENÍ remote/hybridní s reálným dojezdem, MUSÍŠ dát relevance POD ${t} ` +
    `(klidně 30–50), i kdyby role obsahově seděla perfektně. Pozici v regionu nebo plně remote ` +
    `lokalitou nepenalizuj. NIKDY si lokalitu nedomýšlej: hodnoť VÝHRADNĚ podle pole „Lokalita"/` +
    `„Region" ve vstupu. Když ve vstupu žádná lokalita není, do zdůvodnění napiš „lokalita neuvedena" ` +
    `a NETVRĎ, že je v preferovaném regionu — takový inzerát nesmí přes práh jen kvůli obsahu.`
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

/**
 * Tvrdý strop skóre podle lokality — poslední slovo má kód, ne model.
 * Mimo region → hluboko pod práh, neověřitelná lokalita → těsně pod práh; důvod jde do `reason`,
 * takže je vidět v appce i v notifikaci (viz outputs-legible-to-outsiders).
 */
function gateByRegion(
  out: ScoreResult,
  job: JobPosting,
  opts: { region?: string; threshold?: number },
): ScoreResult {
  const g = applyRegionGate(out, job, opts.region, opts.threshold);
  if (!g.capped) return out;
  console.log(`region gate ${job.id}: ${out.relevance} → ${g.relevance} (${g.check.note})`);
  return { ...out, relevance: g.relevance, reason: g.reason };
}

export async function scoreJob(
  env: Env,
  job: JobPosting,
  profile = '',
  // `onFail` = proč skóre nevzniklo. Bez něj zůstal důvod jen ve Worker logu (console.warn)
  // a v konzoli běhu svítilo holé „AI backend neodpovídá" — nikdo z toho nepoznal, jestli
  // je vyčerpaný free limit, spadlý backend, nebo model vrátil nesmysl.
  opts: {
    region?: string;
    threshold?: number;
    provider?: string;
    onFail?: (msg: string) => void;
  } = {},
): Promise<ScoreResult | null> {
  const system = buildSystem(profile, opts.region, opts.threshold);
  const user = [
    `Titul: ${job.title}`,
    `Zaměstnavatel: ${job.employer}${job.isAgency ? ' (personální agentura)' : ''}`,
    job.location ? `Lokalita: ${job.location}` : 'Lokalita: neuvedena',
    job.region ? `Region (kraj): ${job.region}` : '',
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
  if (!chain.length) {
    opts.onFail?.('žádný AI backend k dispozici (chybí binding Workers AI i klíč Claude, nebo je AI vypnutá)');
    return null;
  }
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
      // Region NEnechávej na modelu: zastropuj skóre podle skutečné lokality (src/region.ts).
      if (out) return gateByRegion(out, job, opts);
      // Odpověď dorazila, ale nedá se použít (chybí číselná relevance) — u free modelu se to
      // stává. Ukázka odpovědi do hlášky, ať je poznat rozdíl proti výpadku backendu.
      opts.onFail?.(`${provider}: model nevrátil použitelné skóre (${JSON.stringify(parsed ?? null).slice(0, 120)})`);
    } catch (e) {
      console.warn(`score ${job.id} [${provider}]: ${e}`);
      opts.onFail?.(`${provider}: ${(e as Error)?.message ?? e}`);
    }
  }
  // Selhání (rate-limit/parse) → null: NEzapisovat 0, ať se inzerát příště přeskóruje
  // (0 by smyčka brala jako hotové a uvízlo by to).
  return null;
}
