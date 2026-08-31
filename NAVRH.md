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
| **Kdy je hotový** | Měřitelně: každý inzerát z hlídaných zdrojů, který sedí na profil, dorazí vlastníkovi **do 24 h od zveřejnění**, a to bez falešných poplachů nad ~10 %. Tenhle cíl **zatím není ověřený** (chybí měření modelové části, viz F1). |
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
| **Deterministické jádro** (prefiltr role + kraj) | **26/26 = 100 %** | `npm run evals` nad `evals/skorovani.json` — 26 reálných inzerátů s ručně dopsanou pravdou |
| **Skórování modelem** | **NEZMĚŘENO** | modelová část evalů potřebuje `ANTHROPIC_API_KEY`, který v CI není. 23 případů čeká. |

**Brána F1 tedy neplatí.** Nejrizikovější krok — jak dobře model pozná shodu inzerátu
s profilem — číslo nemá. Deterministická půlka je změřená a drží; ta druhá je slepé místo
a je poctivější to napsat než to zamlčet.

Co se přesto ví z provozu: ze 60 odeslaných notifikací nebyla ani jedna reklamována jako
očividně mimo obor **po** opravě regionu (23. 8.). Před ní procházely pražské inzeráty —
to byla chyba promptu, ne modelu, a vyřešil ji deterministický strop.

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

**Dnes agent neplatí nic** — běží na free backendu. Číslo za Claude je cena přepnutí.

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
| F1 změřené jádro | ⚠️ čas a cena změřené, **přesnost modelu ne** |
| F2 kostra a kontrakty | ⚠️ testovací prostředí bez odesílacích kanálů neexistuje |
| F3 deterministická páteř | ✅ |
| F4 model a evaly | ⚠️ verze promptu a sada jsou, modelová část evalů v CI neběží |
| F5 brány, limity, identita | ✅ |
| F6 selhání, runbook, vypínač | ✅ |
| F7 nasazení | ⚠️ chybí souběžný běh nové verze naslepo vedle ostré |
| F8 provoz a růst | ❌ evalů zatím nepřibývá, posun rozdělení se nesleduje |
