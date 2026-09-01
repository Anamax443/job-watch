// Evaluační sada — reálné inzeráty z produkční D1, s ručně dopsanou pravdou.
//
// Vyžaduje ji fáze F4 build předpisu z Anamax443/ai-agenti: 20–40 reálných vstupů.
// Pravda NENÍ opsaná z toho, co model kdysi vrátil — to by měřilo samo sebe. U každého
// případu je napsané PROČ tam je; většina vznikla z konkrétního incidentu.
//
// Proč TypeScript a ne JSON: sadu čte jak skript v Node (npm run evals), tak nasazený
// Worker (POST /api/evals). Import JSONu vyžaduje v Node atribut `with { type: 'json' }`,
// který by se musel dostat i do bundlu Workeru. Modul funguje v obou bez výjimek a je to
// pořád jeden zdroj pravdy — dvě kopie sady by se rozešly a nikdo by si toho nevšiml.
//
// prefilter = projde inzerát levným filtrem před modelem? (deterministické, bez AI)
// scoreBand = jak by ho měl ohodnotit model: high >= prah, low < prah. null = neřeší se.

import type { JobPosting, Settings } from '../src/types.ts';

export interface EvalPripad {
  why: string;
  job: Partial<JobPosting> & { source: string; title: string; employer: string };
  prefilter: 'in' | 'out';
  scoreBand: 'high' | 'low' | null;
}

export const NASTAVENI = {
  "keywords": [
    "vedoucí IT",
    "vedoucí informatiky",
    "IT manažer",
    "IT manager",
    "Head of IT",
    "IT ředitel",
    "CIO",
    "vedoucí oddělení IT",
    "Solution Architect",
    "IT lead",
    "IT architekt",
    "vedoucí vývoje"
  ],
  "czIscoPrefixes": [
    "133"
  ],
  "regionPriority": "brno",
  "notifyThreshold": 70
} as unknown as Settings & { notifyThreshold: number };

export const PRIPADY: EvalPripad[] = [
  {
    "why": "Reálný lead se skóre 80. Kvůli němu se 31. 8. vracela propustka pro jobs.cz — titulek z portálu neobsahuje žádné klíčové slovo ze seznamu.",
    "job": {
      "source": "jobs.cz",
      "title": "IT Specialista / Architekt – Druhý muž IT (m/ž)",
      "employer": "ARKYS, s.r.o.",
      "location": "Brno – Slatina"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "Reálný lead se skóre 80, taky bez klíčového slova v titulku.",
    "job": {
      "source": "jobs.cz",
      "title": "IT, Data & Applications Manager",
      "employer": "KP2 Czech Republic s.r.o.",
      "location": "Brno – Slatina"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "Inzerát, o kterém 15. 6. 2026 přišla notifikace. Přesně ta role, kvůli které agent existuje.",
    "job": {
      "source": "jobs.cz",
      "title": "Vedoucí IT",
      "employer": "VARNET a.s.",
      "location": "Brno – Horní Heršpice"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "Řídící IT role v Brně, titulek mimo seznam klíčových slov.",
    "job": {
      "source": "jobs.cz",
      "title": "Manažer kybernetické bezpečnosti",
      "employer": "Státní zemědělská a potravinářská inspekce",
      "location": "Brno – Pisárky"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "Seniorní IT role v Brně.",
    "job": {
      "source": "jobs.cz",
      "title": "Senior IT konzultant",
      "employer": "bezva IT partner s.r.o.",
      "location": "Brno – Dolní Heršpice"
    },
    "prefilter": "in",
    "scoreBand": null
  },
  {
    "why": "Správa ICT na univerzitě — hraniční, ale filtr ji zahodit nesmí; o skóre rozhoduje model.",
    "job": {
      "source": "jobs.cz",
      "title": "Správce ICT",
      "employer": "Masarykova univerzita",
      "location": "Brno – Veveří"
    },
    "prefilter": "in",
    "scoreBand": null
  },
  {
    "why": "IT projektové řízení v Brně.",
    "job": {
      "source": "jobs.cz",
      "title": "IT projektový/á manažer/ka",
      "employer": "RegioJet a.s.",
      "location": "Brno – Brno-město"
    },
    "prefilter": "in",
    "scoreBand": null
  },
  {
    "why": "MPSV projde přes CZ-ISCO 133, i když titulek zní úředně.",
    "job": {
      "source": "mpsv",
      "title": "Řídící pracovníci v oblasti informačních technologií",
      "employer": "Firma",
      "location": "Brno-střed, Jihomoravský kraj",
      "region": "Jihomoravský kraj",
      "czIsco": "CzIsco/1330"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "ATS inzerát bez lokality. Neznámý kraj se NESMÍ zahazovat — o lead se nemá přijít kvůli prázdnému poli.",
    "job": {
      "source": "ats:recruitee:firma",
      "title": "Head of IT",
      "employer": "Firma"
    },
    "prefilter": "in",
    "scoreBand": "high"
  },
  {
    "why": "Živý incident 5. 8. 2026: free model dal pražskému inzerátu 80/100 se zdůvodněním „je v preferovaném regionu\". Musí padnout už na vstupu.",
    "job": {
      "source": "mpsv",
      "title": "Vývojáři softwaru",
      "employer": "MSD Czech Republic s.r.o.",
      "location": "Praha, Hlavní město Praha",
      "region": "Hlavní město Praha",
      "czIsco": "CzIsco/25120"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Řídící IT role, ale Praha. CZ-ISCO 133 sedí — o vyřazení musí rozhodnout kraj, ne role.",
    "job": {
      "source": "mpsv",
      "title": "Řídící pracovníci v oblasti informačních technologií (M/Ž)",
      "employer": "Veeam Software (Czech Republic) s.r.o.",
      "location": "Praha, Hlavní město Praha",
      "region": "Hlavní město Praha",
      "czIsco": "CzIsco/1330"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Praha z jobs.cz — propustka pro zdroj NEsmí obejít filtr kraje.",
    "job": {
      "source": "jobs.cz",
      "title": "Tech Lead Manager",
      "employer": "Semrush CZ s.r.o.",
      "location": "Praha, Hlavní město Praha",
      "region": "Hlavní město Praha"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Praha, IT manažerská role.",
    "job": {
      "source": "jobs.cz",
      "title": "IT Service Manager (M/Ž)",
      "employer": "Ditenso s.r.o.",
      "location": "Václavské náměstí 795/40, Hlavní město Praha",
      "region": "Hlavní město Praha"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Pardubický kraj — jiný kraj než hledaný.",
    "job": {
      "source": "mpsv",
      "title": "ERP director (m/ž)",
      "employer": "VINTECH Industries s.r.o.",
      "location": "Biskupická 781, Pardubický kraj",
      "region": "Pardubický kraj",
      "czIsco": "CzIsco/1330"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Olomoucký kraj.",
    "job": {
      "source": "jobs.cz",
      "title": "IT specialista/specialistka na integraci - Integration Specialist",
      "employer": "CONSTRUSOFT s.r.o.",
      "location": "Sadová 2374/2, 750 02, Olomoucký kraj",
      "region": "Olomoucký kraj"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Titulek slibuje „Praha/Brno\", ale lokalita je Praha - Nusle. Rozhoduje pole lokality, ne titulek.",
    "job": {
      "source": "mpsv",
      "title": "IT projektový manažer Praha/Brno – spisová služba a digitalizace",
      "employer": "Skupina ICZ",
      "location": "Praha - Nusle, Hlavní město Praha",
      "region": "Hlavní město Praha",
      "czIsco": "CzIsco/1330"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Živý nález 31. 8. 2026: klíčové slovo „CIO\" se hledalo podřetězcem a sedělo ve slově sta-CIO-nář. Takhle se do fronty dostali pracovníci v sociálních službách.",
    "job": {
      "source": "mpsv",
      "title": "Pracovník/ice v sociálních službách - přímá péče v denním stacionáři a sociálně terapeutických dílnách",
      "employer": "Oblastní charita Nové Hrady u Skutče",
      "czIsco": "CzIsco/53112"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Druhý případ téhož: STACIOnární stroje.",
    "job": {
      "source": "mpsv",
      "title": "Obsluha stacionárních strojů",
      "employer": "SmartStaff s.r.o.",
      "czIsco": "CzIsco/81420"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Přesně ten inzerát, kvůli kterému uživatel 31. 8. napsal, že se mu v historii ukazuje manipulační dělník.",
    "job": {
      "source": "mpsv",
      "title": "SKLADNÍK, MANIPULAČNÍ DĚLNÍK (M/Ž)",
      "employer": "Firma",
      "czIsco": "CzIsco/93331"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Dělnická profese, obor úplně mimo.",
    "job": {
      "source": "mpsv",
      "title": "Dělník/dělnice plastikářské výroby",
      "employer": "Firma",
      "czIsco": "CzIsco/8142"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Seřizovač lisů.",
    "job": {
      "source": "mpsv",
      "title": "SEŘIZOVAČ/KA LISŮ",
      "employer": "Firma",
      "czIsco": "CzIsco/72239"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Operátor výroby.",
    "job": {
      "source": "mpsv",
      "title": "OPERÁTOR/KA VÝROBY",
      "employer": "Firma",
      "czIsco": "CzIsco/93293"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Nádvorní dělníci.",
    "job": {
      "source": "mpsv",
      "title": "Dělníci nádvorní skupiny",
      "employer": "Firma",
      "czIsco": "CzIsco/96220"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Obsluha strojů — jiný obor.",
    "job": {
      "source": "mpsv",
      "title": "Obsluha strojů a zařízení na výrobu pryžových výrobků",
      "employer": "Firma",
      "czIsco": "CzIsco/81410"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Technická role v Brně, ale ne IT řízení. Kraj sedí, obor ne — vyřadit má role.",
    "job": {
      "source": "mpsv",
      "title": "Procesní inženýr/ka",
      "employer": "Firma",
      "location": "Brno-střed, Jihomoravský kraj",
      "region": "Jihomoravský kraj",
      "czIsco": "CzIsco/21411"
    },
    "prefilter": "out",
    "scoreBand": "low"
  },
  {
    "why": "Prázdné klíčové slovo v Nastavení nesmí propustit všechno — dřívější chyba, kdy hay.includes('') vracelo vždy true.",
    "job": {
      "source": "mpsv",
      "title": "Skladník",
      "employer": "Firma",
      "czIsco": "CzIsco/93331"
    },
    "prefilter": "out",
    "scoreBand": "low"
  }
];
