import type { Env, JobPosting, ScoreResult } from './types.ts';
import { messagesCreate, firstText, extractJson } from './anthropic.ts';
import { providerChain, runWorkersJson } from './ai.ts';
import { applyRegionGate } from './region.ts';
import { truncate } from './util.ts';
import { buildSystem, wrapAd } from './prompts.ts';

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

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}


/**
 * Sjednotí výstup obou backendů (Workers AI vrací čísla občas jako string).
 * Exportované kvůli testům — je to čistá funkce nad odpovědí modelu, tedy to nejsnáz
 * testovatelné místo celé AI vrstvy (tests/score-normalize.test.ts).
 */
export function normalizeScore(parsed: any): ScoreResult | null {
  // POZOR na Number(): Number(null), Number(''), Number(false) i Number([]) je 0 — odpověď
  // BEZ skóre by se tak uložila jako relevance 0. To je přesně stav, kterému se scoreJob brání
  // (0 smyčka bere jako hotové → inzerát se už nikdy nepřeskóruje a uvízne). Bereme proto jen
  // skutečné číslo nebo neprázdný číselný string (Workers AI vrací '85').
  const raw = parsed?.relevance;
  const rel =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
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
    /**
     * Která příčka žebříku skóre nakonec dala. Volá se JEN při úspěchu.
     *
     * Proč: backend se přepíná sám (placený Claude → free Workers AI, viz providerChain),
     * což je záměr — provoz nespadne. Jenže osmdesátka od Claude a osmdesátka od Llamy 8B
     * vypadají v databázi identicky, takže „došel kredit a celý měsíc skóruje free model"
     * byla dosud tichá změna kvality. Bez tohohle háčku se nedá ani měřit, ani hlásit.
     */
    onProvider?: (p: string) => void;
  } = {},
): Promise<ScoreResult | null> {
  const system = buildSystem(profile, opts.region, opts.threshold);
  const pole = [
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
  // Všechna pole výše pocházejí z inzerátu, tedy od cizí strany → do značky jde celý blok.
  const user = wrapAd(pole);

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
      const out = normalizeScore(parsed);
      // Region NEnechávej na modelu: zastropuj skóre podle skutečné lokality (src/region.ts).
      if (out) {
        opts.onProvider?.(provider);
        return gateByRegion(out, job, opts);
      }
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
