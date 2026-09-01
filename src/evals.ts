// Evaluační sada nad ŽIVÝM backendem — běží uvnitř nasazeného Workeru.
//
// Proč tady a ne v CI: skórování jede přes `providerChain` (placený Claude → free Workers AI).
// Free příčka je **binding** `env.AI` — z Node ani z CI ji zavolat nejde. Sada v `scripts/evals.ts`
// to obcházela vlastním voláním Anthropicu, jenže tím měřila příčku, která v produkci dnes
// vůbec nerozhoduje. Měřicí přístroj namířený vedle je horší než žádný: vyrábí falešnou jistotu.
//
// Tady se volá `scoreJob` — tentýž kód, tentýž prompt, tentýž žebřík jako v ostrém běhu.
// Výsledek proto platí o tom, co skutečně rozhoduje, včetně toho, KTERÁ příčka odpověděla.
//
// Cena: jedno volání modelu na případ. Sada má 23 hodnocených případů, takže jeden průchod
// je zhruba jako čtvrtina denního běhu. Proto se spouští na vyžádání, ne automaticky.

import type { Env, JobPosting, Settings } from './types.ts';
import { scoreJob } from './score.ts';
import { PROMPT_VERSION } from './prompts.ts';
import { PRIPADY } from '../evals/skorovani.ts';

export interface EvalCase {
  why: string;
  title: string;
  expected: 'high' | 'low';
  got: 'high' | 'low' | null;
  relevance: number | null;
  provider: string | null;
  ok: boolean;
  reason: string | null;
}

export interface EvalResult {
  promptVersion: string;
  prah: number;
  celkem: number;
  ok: number;
  /** Nevrácené skóre — model neodpověděl použitelně. Není to ani úspěch, ani chyba modelu. */
  bezOdpovedi: number;
  /** Kolik případů ohodnotila která příčka žebříku. */
  providers: Record<string, number>;
  presnost: { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null };
  pripady: EvalCase[];
}

/**
 * Precision a recall nad prahem notifikace.
 *
 * Zajímá nás, jestli agent posílá to, co má (precision), a neztrácí to, co má poslat (recall).
 * Prostý podíl „kolik uhádl" obojí schová: sada, kde je většina případů záporná, vypadá skvěle
 * i s modelem, který neposílá nic. Proto obě čísla zvlášť, a `null` když se nedá spočítat.
 */
export function spoctiPresnost(pripady: EvalCase[]): EvalResult['presnost'] {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pripady) {
    if (p.got == null) continue; // model neodpověděl → do přesnosti se nepočítá
    if (p.expected === 'high' && p.got === 'high') tp++;
    else if (p.expected === 'low' && p.got === 'high') fp++;
    else if (p.expected === 'high' && p.got === 'low') fn++;
    else tn++;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

/** Pustí sadu proti živému backendu. Nezapisuje nic do dat — jen čte a volá model. */
export async function runEvals(env: Env, settings: Settings): Promise<EvalResult> {
  const prah = settings.notifyThreshold ?? 70;
  const hodnocene = PRIPADY.filter((p) => p.scoreBand);
  const pripady: EvalCase[] = [];
  const providers: Record<string, number> = {};

  for (const p of hodnocene) {
    const job = { isAgency: false, id: 'eval', ...p.job } as JobPosting;
    let provider: string | null = null;
    let duvod: string | null = null;
    const sc = await scoreJob(env, job, settings.profile, {
      region: settings.regionPriority,
      threshold: prah,
      onProvider: (x) => {
        provider = x;
        providers[x] = (providers[x] ?? 0) + 1;
      },
      onFail: (m) => {
        duvod = m;
      },
    });
    const got = sc ? (sc.relevance >= prah ? 'high' : 'low') : null;
    pripady.push({
      why: p.why,
      title: p.job.title,
      expected: p.scoreBand as 'high' | 'low',
      got,
      relevance: sc?.relevance ?? null,
      provider,
      ok: got === p.scoreBand,
      reason: sc?.reason ?? duvod,
    });
  }

  return {
    promptVersion: PROMPT_VERSION,
    prah,
    celkem: pripady.length,
    ok: pripady.filter((p) => p.ok).length,
    bezOdpovedi: pripady.filter((p) => p.got == null).length,
    providers,
    presnost: spoctiPresnost(pripady),
    pripady,
  };
}
