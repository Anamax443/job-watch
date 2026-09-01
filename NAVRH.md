# JobWatch — návrhový list

Doplněno zpětně 31. 8. 2026 podle [build předpisu](https://github.com/Anamax443/ai-agenti)
(fáze F0 a F1). Agent běžel od 14. 6. 2026, tenhle dokument tedy **nevznikl před stavbou**,
ale popisuje, co skutečně stojí v kódu — a čísla v něm jsou změřená na produkčních datech,
ne odhadnutá. Kde se něco změřit nedalo, je to napsané jako nezměřené, ne vynechané.

---

## Základ

| | |
|---|---|
| **Co agent dělá** | Denně hledá volná místa „vedoucí IT / IT manažer / Solution Architect" v Jihomoravském kraji, skóruje je proti profilu majitele a to, co projde prahem, pošle na Telegram / e-mail / Slack. |
| **Vlastník** | Milan Trnka |
| **Kdy je hotový** | Měřitelně: každý inzerát z hlídaných zdrojů, který sedí na profil, dorazí vlastníkovi **do 24 h od zveřejnění**, a to bez falešných poplachů nad ~10 %. Na evaluační sadě je to k 1. 9. 2026 **splněné** (precision 100 %, efektivní recall 100 %); v provozu na celém trhu to ověřené není. |
| **Kde běží** | Cloudflare Worker + D1 + Cron, nezávisle na lokálním PC. |

## Vstupy

| Zdroj | Co dává | Poznámka |
|---|---|---|
| MPSV (otevřená data) | strukturovaná pozice vč. CZ-ISCO, kraje a kontaktní osoby | přírůstky denně, plný export ~184 MB (mimo Worker) |
| jobs.cz | cílené hledání dle dotazu | bez CZ-ISCO → prochází bez testu klíčových slov |
| prace.cz (LMC) | volné hledání | širší, šum ořezává prefiltr |
| ATS firem | inzeráty přímo od zaměstnavatele | registr se buduje objevováním |
| Web (Serper/Adzuna) | doplněk | vypnutelné konfigurací |

## Scénáře

Uzavřený seznam. **Co v něm není, agent neumí a neimprovizuje.**

| # | Scénář | Spouští |
|---|---|---|
| S1 | Denní běh: stáhni → prefiltruj → oskóruj → notifikuj | cron 06:00 UTC |
| S2 | Doskórování fronty (co se nestihlo dřív) | součást S1 |
| S3 | Ověření živosti inzerátu (zmizel z portálu?) | CI, denně |
| S4 | Ruční běh z UI nebo z Telegramu (`/beh`) | člověk |
| S5 | Výpis aktuálních pozic do Telegramu (`/pozice`) | člověk |
| S6 | Stav posledního běhu (`/stav`) | člověk |
| S7 | Ruční hromadné přeřazení inzerátů (skóre 0) | člověk v UI |
| S8 | Zastavení běhu | člověk (Stop / `/api/run/stop`) |

**Jak uživatel pozná, co agent umí:** `/help` v Telegramu a odpověď nápovědou pokaždé,
když příkazu nerozumí. Textové rozhraní nemá tlačítka — musí to říct samo.

## Dělba práce: model × kód

Pravidlo předpisu: *když si u kroku nejsi jistý, je to kód.*

| Krok | Kdo | Proč |
|---|---|---|
| Výběr zdrojů, stahování, kurzory | **kód** | deterministické |
| Prefiltr (role, kraj) | **kód** | `src/prefilter.ts`; model by se nechal zmást titulkem |
| Rozhodnutí o kraji | **kód** | `src/region.ts` — free model instrukci prokazatelně ignoroval (Praha dostala 80/100 se zdůvodněním „je v preferovaném regionu") |
| Deduplikace | **kód** | tři úrovně, `src/store.ts` |
| **Skóre relevance** | **model** | jediná úloha, kterou kód neumí |
| Odmaskování agentury | **model** | s `web_search`, jen placený backend |
| Rozpoznání záměru z chatu | **kód** | `guessIntent`; model by o spuštění běhu rozhodoval bez evalů |
| Zápis, notifikace, vypínač | **kód** | nevratné akce |

**Model nemá přístup k žádné nevratné akci napřímo.** Vrací číslo a větu; co se s nimi
stane, rozhoduje kód.

## Brány (režim podle vratnosti chyby)

| Akce | Vratnost | Režim |
|---|---|---|
| Zápis skóre do D1 | vratná (přeskóruje se) | agent sám |
| Označení inzerátu za neživý | vratná | agent sám |
| **Odeslání notifikace** | **nevratná** | agent sám, ale jen nad prahem a se stropem 10 zpráv/běh |
| Ruční skóre 0 hromadně | vratná | **jen člověk** (výběr řádků v UI) |
| Změna profilu / nastavení | vratná | jen člověk |
| Spuštění běhu | vratná | člověk nebo cron |
| Zastavení běhu | — | člověk, jedním úkonem |

## Limity

| Co | Hodnota | Co se stane při překročení |
|---|---|---|
| AI hodnocení na běh | 150 | zbytek počká ve frontě, zaloguje se |
| Notifikace z fronty na běh | 10 | zbytek pošle další běh, zaloguje se |
| Kontroly živosti v běhu | 5 | zbytek řeší GitHub Action |
| Délka běhu | 120 s | běh se ukončí, fronta zůstane |
| Podřízené požadavky Workeru | strop platformy | **skutečný limit propustnosti** — viz F1 |

## Identita a přiznání AI

- Přístup do UI: Cloudflare Access **+ allowlist v aplikaci** (perimetr sám nestačí).
- Telegram: odpovídá se jen na `chat_id` z Nastavení; cizí zpráva se zahodí a zaloguje.
- Každá odchozí notifikace nese větu, že ji sestavil automat (AI Act).

---

# F1 — změřené jádro

Měřeno 31. 8. 2026 na **produkčních datech**: 458 nezduplikovaných inzerátů, 47 doběhlých
běhů od 1. 8. 2026. Ne na vzorku, ne na syntetice.

## Přesnost

| Část | Výsledek | Jak měřeno |
|---|---|---|
| **Deterministické jádro** (prefiltr role + kraj) | **26/26 = 100 %** | `npm run evals` nad `evals/skorovani.ts` — reálné inzeráty s ručně dopsanou pravdou |
| **Skórování modelem** | **23/23**; precision 100 %, recall 100 %, efektivní recall 100 %, coverage 100 % | tlačítko „Změřit kvalitu modelu" na `/tests` uvnitř nasazeného Workeru, 1. 9. 2026, backend `anthropic 23×`, prompt `skore-2026-09-01.2` |

**Brána F1 platí od 1. 9. 2026.** Do té doby nejrizikovější krok — jak dobře model pozná shodu
inzerátu s profilem — číslo neměl a bylo to tady napsané jako slepé místo. Měření to zaplnilo,
a rovnou ukázalo, proč na tom číslu záleží: **na téže sadě má free model recall 50 %, Claude
100 %**. Tři reálné leady, kterým free model dal nulu, jsou přesně ty, kvůli kterým agent existuje.

Dva z těch tří vyřešil placený model. Třetí („Head of IT" bez lokality) ne — ten padl až opravou
deterministického stropu regionu, který neurčitelnou lokalitu držel vždycky pod prahem. Kdyby se
sledovalo jen souhrnné číslo, vypadalo by to jako jedna zásluha modelu.

**Co číslo NEdokazuje:** záporná třída sady je slabá — 16 ze 17 negativů má `prefilter: "out"`,
takže se v produkci k modelu nedostanou. Precision 100 % je tedy z velké části vysvědčení pro
deterministický filtr. Doplnit případy, které filtrem projdou a přesto mají skončit nízko,
je otevřený bod.

## Cena

Vstupy měřené v produkci: systémový prompt **2 954 znaků** (s profilem 2 081 znaků),
popis inzerátu průměrně **855 znaků** (max 3 518), titulek 37 znaků.

| Backend | Cena za inzerát | Za měsíc (~1 950 inzerátů) |
|---|---|---|
| **Workers AI (výchozí)** | **0 Kč** | **0 Kč** — free tier 10 000 neuronů/den |
| Claude Haiku 4.5 (volitelný) | ~1 340 vstupních + ~120 výstupních tokenů → **≈ 0,0019 USD** | **≈ 3,7 USD / ~82 Kč** |

Ceník Haiku 4.5: 1,00 USD za milion vstupních a 5,00 USD za milion výstupních tokenů.
Tokeny odhadnuté z počtu znaků poměrem **3 znaky ≈ 1 token** (čeština s diakritikou);
je to odhad, ne měření přes `count_tokens`. Objem 1 950/měsíc = 65 kandidátů denně
po prefiltru × 30.

**Od 1. 9. 2026 agent platí** — po změření (free recall 50 %, Claude 100 %) se produkce přepnula na Claude, takže cena z tabulky je reálná, ne hypotetická. Do té doby platilo: **dnes agent neplatí nic** — běží na free backendu. Číslo za Claude je cena přepnutí.

## Čas

| Veličina | Hodnota |
|---|---|
| Průměrná délka běhu | **41,4 s** |
| Nejdelší běh | **120,0 s** — přesně nastavený strop |
| Nejkratší běh | 6 s |
| Doběhlo v pořádku | **47 / 47** |
| Ohodnoceno na běh | **10–15 inzerátů** (strop v konfiguraci je 150) |

**Nález, který stojí za celý F1:** strop 150 se nikdy nevyčerpá, protože dřív dojde
**rozpočet podřízených požadavků Workeru** — běh 31. 8. 06:00 spadl na
`Too many subrequests by single Worker invocation` po 15 ohodnocených. Skutečná
propustnost je tedy ~15/den, ne 150/den, a fronta 300 inzerátů se dohání týdny.
To je zásadní vstup pro každé plánování, které se dosud opíralo o špatné číslo.

---

## Co z předpisu chybí

| Fáze | Stav |
|---|---|
| F0 návrh | ✅ tento dokument (zpětně) |
| F1 změřené jádro | ✅ čas, cena i **přesnost modelu** změřené (1. 9. 2026) |
| F2 kostra a kontrakty | ⚠️ testovací prostředí bez odesílacích kanálů neexistuje |
| F3 deterministická páteř | ✅ |
| F4 model a evaly | ⚠️ verze promptu, sada, obrana proti nepřátelskému vstupu i metriky hotové; modelová část ale **v CI běžet nemůže** (free příčka je binding `env.AI`) — spouští se ručně na `/tests` |
| F5 brány, limity, identita | ✅ |
| F6 selhání, runbook, vypínač | ✅ |
| F7 nasazení | ⚠️ chybí souběžný běh nové verze naslepo vedle ostré |
| F8 provoz a růst | ⚠️ sada je plně zelená, a tím přestala rozlišovat — potřebuje těžší případy |

> **Nález do build předpisu, ne do projektu.** Brána F4 žádá „evaly běží v CI". U agenta, jehož
> výchozí backend existuje **jen za běhu** (Workers AI binding), je to nesplnitelné: v CI by se
> měřil jiný model, než který rozhoduje. Poctivá varianta zní „evaly na nasazené verzi, spouštěné
> ručně, s protokolem" — a přesně tak to tady je.
