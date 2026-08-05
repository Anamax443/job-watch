// Filtr regionu — DETERMINISTICKY v kódu, ne v promptu.
//
// Proč: pravidlo „hodnoť jen pozice v preferovaném regionu" bylo jen věta v systémovém promptu.
// Slabý free model (Llama 8B) ji ignoroval a inzerát z Prahy ohodnotil 80/100 se zdůvodněním
// „Lokalita je v Praze, což je v preferovaném regionu", i když v Nastavení bylo „brno".
// Model tady tedy nerozhoduje: kraj se určí z textu lokality a skóre se tvrdě zastropuje.
//
// Soubor je ZÁMĚRNĚ bez importů (ani ./util) — jde spustit i mimo Worker: node scripts/region-check.ts

export type RegionVerdict =
  | 'off' // filtr vypnutý (prázdný region v Nastavení) — vše projde
  | 'in' // lokalita je v preferovaném kraji
  | 'out' // lokalita je prokazatelně v jiném kraji
  | 'remote' // celá ČR / práce na dálku — region neřešíme
  | 'unknown'; // lokalitu nelze určit → nesmí projít jen kvůli obsahu

export interface RegionCheck {
  verdict: RegionVerdict;
  /** Krátké lidské zdůvodnění do logu / do reason (viz outputs-legible-to-outsiders). */
  note: string;
  /** Kraj zjištěný z inzerátu (název), když se povedlo určit. */
  jobRegion?: string;
  /** Kraj, na který se přeložil text z Nastavení. */
  wantRegion?: string;
}

function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Kraje + jejich obvyklá jména v lokalitách (kraj, okresní a větší města).
// Slouží k přeložení volného textu („brno", „Praha 4", „602 00 Brno-střed") na kraj.
const KRAJE: { name: string; aliases: string[] }[] = [
  {
    name: 'Hlavní město Praha',
    aliases: ['praha', 'prague', 'hl. m. praha', 'hlavni mesto praha', 'praha-zapad', 'praha-vychod'],
  },
  {
    name: 'Středočeský kraj',
    aliases: [
      'stredocesky', 'kladno', 'mlada boleslav', 'pribram', 'kolin', 'kutna hora', 'beroun',
      'benesov', 'melnik', 'nymburk', 'rakovnik', 'brandys nad labem', 'ricany', 'cesky brod',
      'neratovice', 'kralupy nad vltavou', 'slany', 'roztoky', 'celakovice', 'podebrady',
      'vlasim', 'sedlcany', 'horovice', 'rudna', 'jesenice', 'dobris', 'caslav', 'lysa nad labem',
    ],
  },
  {
    name: 'Jihočeský kraj',
    aliases: [
      'jihocesky', 'ceske budejovice', 'tabor', 'pisek', 'strakonice', 'jindrichuv hradec',
      'cesky krumlov', 'prachatice', 'vodnany', 'trebon', 'milevsko', 'sezimovo usti', 'dacice',
      'vimperk', 'kaplice', 'veseli nad luznici', 'blatna', 'soběslav', 'sobeslav',
    ],
  },
  {
    name: 'Plzeňský kraj',
    aliases: [
      'plzensky', 'plzen', 'klatovy', 'rokycany', 'tachov', 'domazlice', 'susice', 'stribro',
      'prestice', 'nyrany', 'horazdovice', 'kralovice', 'blovice', 'holysov', 'dobrany', 'nepomuk',
    ],
  },
  {
    name: 'Karlovarský kraj',
    aliases: [
      'karlovarsky', 'karlovy vary', 'sokolov', 'cheb', 'ostrov', 'chodov', 'marianske lazne',
      'kraslice', 'habartov', 'nejdek', 'frantiskovy lazne', 'horni slavkov', 'bochov',
    ],
  },
  {
    name: 'Ústecký kraj',
    aliases: [
      'ustecky', 'usti nad labem', 'most', 'decin', 'teplice', 'chomutov', 'litomerice', 'louny',
      'litvinov', 'kadan', 'zatec', 'roudnice nad labem', 'bilina', 'varnsdorf', 'rumburk',
      'jirkov', 'klasterec nad ohri', 'lovosice', 'duchcov', 'krupka', 'podborany', 'postoloprty',
    ],
  },
  {
    name: 'Liberecký kraj',
    aliases: [
      'liberecky', 'liberec', 'jablonec nad nisou', 'ceska lipa', 'turnov', 'novy bor', 'semily',
      'tanvald', 'frydlant', 'jilemnice', 'hradek nad nisou', 'zelezny brod', 'doksy', 'mimon',
      'lomnice nad popelkou',
    ],
  },
  {
    name: 'Královéhradecký kraj',
    aliases: [
      'kralovehradecky', 'hradec kralove', 'trutnov', 'nachod', 'jicin', 'rychnov nad kneznou',
      'dvur kralove', 'vrchlabi', 'jaromer', 'nove mesto nad metuji', 'hronov', 'broumov',
      'kostelec nad orlici', 'novy bydzov', 'dobruska', 'cerveny kostelec', 'upice', 'hostinne',
    ],
  },
  {
    name: 'Pardubický kraj',
    aliases: [
      'pardubicky', 'pardubice', 'chrudim', 'svitavy', 'usti nad orlici', 'ceska trebova',
      'vysoke myto', 'litomysl', 'moravska trebova', 'policka', 'lanskroun', 'holice', 'prelouc',
      'hlinsko', 'chrast', 'skutec', 'chocen',
    ],
  },
  {
    name: 'Kraj Vysočina',
    aliases: [
      'vysocina', 'jihlava', 'trebic', 'havlickuv brod', 'zdar nad sazavou', 'pelhrimov',
      'humpolec', 'velke mezirici', 'chotebor', 'nove mesto na morave', 'moravske budejovice',
      'bystrice nad pernstejnem', 'telc', 'svetla nad sazavou', 'ledec nad sazavou', 'namest nad oslavou',
    ],
  },
  {
    name: 'Jihomoravský kraj',
    aliases: [
      'jihomoravsky', 'brno', 'brno-mesto', 'brno-venkov', 'znojmo', 'breclav', 'hodonin',
      'vyskov', 'blansko', 'kyjov', 'veseli nad moravou', 'boskovice', 'moravsky krumlov',
      'ivancice', 'tisnov', 'slavkov u brna', 'bucovice', 'rosice', 'kurim', 'dubnany',
      'hustopece', 'mikulov', 'pohorelice', 'adamov', 'letovice', 'bilovice nad svitavou',
    ],
  },
  {
    name: 'Olomoucký kraj',
    aliases: [
      'olomoucky', 'olomouc', 'prerov', 'prostejov', 'sumperk', 'jesenik', 'hranice', 'zabreh',
      'unicov', 'mohelnice', 'litovel', 'sternberk', 'lipnik nad becvou', 'konice', 'uhersky ostroh',
    ],
  },
  {
    name: 'Moravskoslezský kraj',
    aliases: [
      'moravskoslezsky', 'ostrava', 'havirov', 'karvina', 'frydek-mistek', 'frydek mistek',
      'opava', 'trinec', 'novy jicin', 'cesky tesin', 'orlova', 'koprivnice', 'bohumin', 'krnov',
      'bruntal', 'studenka', 'odry', 'frydlant nad ostravici', 'vitkov', 'rychvald',
    ],
  },
  {
    name: 'Zlínský kraj',
    aliases: [
      'zlinsky', 'zlin', 'uherske hradiste', 'kromeriz', 'vsetin', 'valasske mezirici',
      'otrokovice', 'roznov pod radhostem', 'uhersky brod', 'holesov', 'bystrice pod hostynem',
      'luhacovice', 'napajedla', 'stare mesto', 'kunovice', 'vizovice', 'slavicin',
    ],
  },
];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// Jedna alternace na kraj, s hranicí slova (aby „most" nechytilo „Mostkovice" apod.).
const KRAJ_RE: { name: string; re: RegExp }[] = KRAJE.map((k) => ({
  name: k.name,
  re: new RegExp(`(^|[^a-z0-9])(${k.aliases.map(esc).join('|')})([^a-z0-9]|$)`),
}));

/** Kraje, na které ukazuje volný text (lokalita, region, hodnota z Nastavení). */
export function resolveKraje(text: string | undefined): string[] {
  const h = norm(text);
  if (!h) return [];
  return KRAJ_RE.filter((k) => k.re.test(h)).map((k) => k.name);
}

const REMOTE_RE =
  /(^|[^a-z0-9])(cela cr|cele cesko|cela ceska republika|remote|plne vzdalene|prace na dalku|odkudkoli|anywhere)([^a-z0-9]|$)/;

export interface RegionJob {
  title?: string;
  location?: string;
  region?: string;
}

/**
 * Porovná lokalitu inzerátu s preferovaným regionem z Nastavení.
 * Rozhoduje jen text lokality/kraje z inzerátu — nikdy popis (jinak by „pobočka v Brně"
 * v textu propašovala pražskou pozici) a nikdy model.
 */
export function checkRegion(job: RegionJob, preferred: string | undefined): RegionCheck {
  const want = norm(preferred);
  if (!want) return { verdict: 'off', note: 'filtr regionu vypnutý (v Nastavení je prázdný region)' };

  const place = `${job.location ?? ''} ${job.region ?? ''}`;
  const hay = norm(place);
  if (!hay) {
    return { verdict: 'unknown', note: 'lokalita neuvedena — region nelze ověřit' };
  }
  if (REMOTE_RE.test(hay) || REMOTE_RE.test(norm(job.title))) {
    return { verdict: 'remote', note: 'práce na dálku / celá ČR — region se neřeší' };
  }

  const wantKraje = resolveKraje(preferred);
  const jobKraje = resolveKraje(place);

  if (wantKraje.length && jobKraje.length) {
    const hit = jobKraje.find((k) => wantKraje.includes(k));
    if (hit) return { verdict: 'in', note: `lokalita v ${hit}`, jobRegion: hit, wantRegion: hit };
    return {
      verdict: 'out',
      note: `lokalita mimo preferovaný region (${jobKraje[0]} ≠ ${wantKraje[0]})`,
      jobRegion: jobKraje[0],
      wantRegion: wantKraje[0],
    };
  }

  // Nastavení nebo lokalitu se nepovedlo přeložit na kraj (obec mimo seznam, jen PSČ, …).
  // Pak platí prosté porovnání textu; když ani to nesedí, radši „nevím" než chybné zamítnutí.
  if (hay.includes(want)) {
    return { verdict: 'in', note: `lokalita odpovídá zadání „${String(preferred).trim()}"` };
  }
  if (wantKraje.length && !jobKraje.length) {
    return {
      verdict: 'unknown',
      note: `z lokality „${place.trim()}" nejde určit kraj — region nelze ověřit`,
      wantRegion: wantKraje[0],
    };
  }
  return { verdict: 'unknown', note: `lokalitu „${place.trim()}" nelze porovnat se zadáním` };
}

export interface GateInput {
  relevance: number;
  reason: string;
}

/**
 * Tvrdý strop skóre podle regionu. Vrací upravené skóre + poznámku (null = beze změny).
 * Pozice mimo region spadne hluboko pod práh, neověřitelná lokalita těsně pod práh —
 * v obou případech se do `reason` napíše proč, ať je to vidět v appce i v notifikaci.
 */
export function applyRegionGate(
  score: GateInput,
  job: RegionJob,
  preferred: string | undefined,
  threshold = 70,
): { relevance: number; reason: string; check: RegionCheck; capped: boolean } {
  const check = checkRegion(job, preferred);
  const t = Number.isFinite(threshold) ? threshold : 70;
  let cap: number | null = null;
  if (check.verdict === 'out') cap = Math.max(0, Math.min(40, t - 1));
  else if (check.verdict === 'unknown') cap = Math.max(0, t - 1);

  if (cap == null || score.relevance <= cap) {
    return { relevance: score.relevance, reason: score.reason, check, capped: false };
  }
  const mark = check.verdict === 'out' ? '⛔' : '⚠️';
  return {
    relevance: cap,
    reason: `${mark} ${check.note} (AI dala ${score.relevance}). ${score.reason}`.trim(),
    check,
    capped: true,
  };
}
