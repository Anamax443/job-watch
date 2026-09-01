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
import { effectiveProvider } from './ai.ts';
import { NASTAVENI, PRIPADY } from '../evals/skorovani.ts';

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
  presnost: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    /** Kolik případů model vůbec zodpověděl. */
    odpovedi: number;
    /** odpovedi / celkem. Bez tohohle čísla je recall pod ním nečitelný. */
    coverage: number | null;
    /**
     * Recall, kde NEODPOVĚĎ u očekávaného leadu je ztracený lead (FN), ne vyňatý případ.
     * Klasický recall počítá jen nad odpověďmi, takže model, který na šesti ze sedmi leadů
     * mlčí a sedmý trefí, vykáže 100 % — a agent přitom zpracoval jeden lead ze sedmi.
     */
    recallEfektivni: number | null;
  };
  /** Backend zvolený v Nastavení. Proti `providers` (kdo skutečně odpověděl) je vidět fallback. */
  zvolenyProvider: string;
  /** Region a práh, proti kterým jsou ruční štítky sady psané (evals/skorovani.ts). */
  konfigurace: { region: string; prah: number };
  /** Otisk profilu, proti kterému se měřilo — po změně profilu můžou štítky legitimně zastarat. */
  profilOtisk: { hash: string; delka: number };
  pripady: EvalCase[];
}

/** Krátký deterministický otisk (FNV-1a). Neslouží k bezpečnosti, jen k rozlišení verzí profilu. */
function otisk(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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
  const odpovedi = pripady.filter((p) => p.got != null).length;
  const vsechnyLeady = pripady.filter((p) => p.expected === 'high').length;
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
    odpovedi,
    coverage: pripady.length > 0 ? odpovedi / pripady.length : null,
    recallEfektivni: vsechnyLeady > 0 ? tp / vsechnyLeady : null,
  };
}

/** Pustí sadu proti živému backendu. Nezapisuje nic do dat — jen čte a volá model. */
export async function runEvals(env: Env, settings: Settings): Promise<EvalResult> {
  // Region a práh bere sada ZE SEBE (evals/skorovani.ts → NASTAVENI), ne z živého Nastavení.
  // Ruční štítky jsou na ně navázané: „Praha → low" platí jen dokud je preferovaný kraj Brno
  // a práh 70. Kdyby se četly živé hodnoty, stačilo by v appce přepnout kraj a sada by začala
  // měřit rozpor mezi novým nastavením a starými štítky — a hlásila by to jako chybu modelu.
  const prah = NASTAVENI.notifyThreshold ?? 70;
  const region = NASTAVENI.regionPriority;
  // Profil naopak zůstává živý: štítky vznikly proti němu a vlastní referenční profil sada
  // nemá. Proto se aspoň zapíše jeho otisk — po změně profilu je v protokolu vidět, že se
  // měřilo proti jinému zadání než při psaní štítků.
  const profil = settings.profile ?? '';
  // Stejná volba backendu jako v ostrém běhu (pipeline.ts: effectiveProvider + předání do
  // scoreJob). Bez tohohle řádku dostal scoreJob `provider: undefined`, providerChain to
  // vyhodnotil jako „auto" = JEN free Workers AI — a sada měřila free příčku i ve chvíli,
  // kdy v Nastavení byl zvolený placený Claude. Přesně ta vada, kvůli které sada vznikla:
  // měřicí přístroj mířil vedle a vyráběl falešnou jistotu.
  const zvoleny = effectiveProvider(env, settings);
  const hodnocene = PRIPADY.filter((p) => p.scoreBand);
  const pripady: EvalCase[] = [];
  const providers: Record<string, number> = {};

  for (const p of hodnocene) {
    const job = { isAgency: false, id: 'eval', ...p.job } as JobPosting;
    let provider: string | null = null;
    let duvod: string | null = null;
    const sc = await scoreJob(env, job, profil, {
      region,
      threshold: prah,
      provider: zvoleny,
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
    zvolenyProvider: zvoleny || 'auto',
    konfigurace: { region: region ?? '', prah },
    profilOtisk: { hash: otisk(profil), delka: profil.length },
    presnost: spoctiPresnost(pripady),
    pripady,
  };
}
