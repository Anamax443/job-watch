# JobWatch — Handoff

Append-only deník stavu. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače
/ po pauze. Věcné „jak to funguje" je v [README.md](README.md), tady je jen **stav**.

> **🟢 NASAZENO A BĚŽÍ:** [jobwatch.maxferit.cz](https://jobwatch.maxferit.cz) za Cloudflare
> Access, denní cron 07:00 SEČ. Repo **`Anamax443/job-watch`** (PUBLIC), větev `main`.
> Deploy jede z CI při pushi do `main` — **push = nasazení**; CI od 22. 8. 2026 hlásí pravdu
> (brána `typecheck` → `test` → deploy).
> Provoz je nezávislý na lokálním PC (Worker + D1 + Cron + GitHub Actions).

---

## 2026-08-23 — profil v Nastavení přepsán na zadání; fronta řadí podle dřívějšího zájmu

**Profil místo životopisu.** V Nastavení byl dosud nalepený životopis **plus průvodní dopis
pro Mejzlík** — tedy dopis jedné konkrétní firmě, podle kterého se hodnotily všechny ostatní
inzeráty. Chybělo v něm, **co uživatel hledá** a hlavně **co nechce**. Nahrazeno zadáním:
cílová role, vylučovací kritéria, silné stránky, přiznané mezery, podmínky.

**Změřený dopad.** Před změnou mělo **12 ze 13** inzerátů nad prahem přesně 100 — model
neuměl odstupňovat. Po změně (z 59 přeskórovaných): **ani jedna stovka**, jediný nad prahem
dostal **80** se zdůvodněním „*menší nedostatky v oblasti zkušeností s Linuxem a mezinárodními
korporacemi*". Zamítnutí nově citují zadání: „*není vedoucí IT, projektový manažer bez vedení
IT týmu*", „*jedná se o junior roli*".

> **Důsledek pro plán: filtr role v kódu se odkládá.** Nález z 22. 8. („skórování nerozlišuje")
> vedl k úvaze postavit obdobu `region.ts` nad titulem. Ukázalo se, že příčina nebyla jen ve
> slabém modelu — **profil neříkal, co uživatel nechce**. Levnější oprava zabrala. Rozhodnout
> o filtru v kódu **až po dojetí fronty**, podle čísel, ne podle dojmu.

**Fronta se řadí podle dřívějšího zájmu** (`loadUnscored` v `src/store.ts`). Bylo
`ORDER BY first_seen DESC`, je `ORDER BY (notified_at IS NOT NULL) DESC, first_seen DESC`.

Proč: v běžném dni je „od nejnovějších" správně. Ale změna profilu vynuluje **všechna** skóre
a přeskórovává se celá historie — a tam tohle řazení odsune dozadu přesně ty inzeráty, kvůli
kterým se profil měnil. Ověřeno na živých datech: inzerát z 23. 7., který měl předtím 100/100
(Vedoucí IT oddělení, Skupina ČEZ / OSC, Brno-Ponava), byl ve frontě **170.** — s novým řazením
je **8.** Ze 223 čekajících jde dopředu 42 dřív notifikovaných.

**Bez testu, vědomě.** Řadí SQL, takže to nejde ověřit čistou funkcí bez databáze — a testy
s běžící infrastrukturou si tenhle projekt zakázal ([METODIKA § 6](https://github.com/Anamax443/sebeanalyza)).
Ověření proto proběhlo dotazem nad produkční D1 (read-only) **před** zápisem změny; čísla výše
jsou z něj. Patří to do stejné kategorie jako „švy mezi moduly", které testy nehlídají.

**Nový otevřený bod: skupiny se nedeanonymizují.** Inzerát je na jobs.cz vedený pod
„Skupina ČEZ", skutečný zaměstnavatel (OSC, a.s.) je až v textu. Deanonymizace se dnes spouští
jen podle `is_agency`, takže u holdingů se nepoužije, přestože jde o tentýž problém.

---

## 2026-08-22 (3) — nález z produkčních dat: skórování nerozlišuje

Při kontrole živé D1 (read-only dotazy přes `wrangler d1 execute --remote`) vyšlo najevo, že
**AI skóre nemá škálu**. Rozložení napříč 422 nezduplikovanými inzeráty:

| Pásmo | Počet |
|---|---:|
| 0 | 148 |
| 40 (strop regionu) | 86 |
| 1–39 | 37 |
| 41–69 | 27 |
| **70–89** | **1** |
| **100** | **12** |
| ve frontě (bez skóre) | 111 |

Nad prahem notifikace (70) je 13 inzerátů a **12 z nich má přesně 100**. Model tedy nehodnotí
míru shody, jen hlasuje ano/ne — a „ano" dává i tomu, co je mimo zadání:

- `Vedoucí IT oddělení` — Skupina ČEZ, Brno → 100 ✅ správně
- `IT projektový/á manažer/ka` — RegioJet → 100
- `Product Owner - Treasury Applications` — Atlas Copco → 100
- `Product Quality Assurance Engineer – Hardware or Software (Electron Microscopy)` — Akkodis (agentura) → **100** ❌

Poslední je testerská role a dostala stejnou známku jako vedoucí IT v ČEZ. Odesláno bylo
**62 notifikací**, takže tenhle šum chodí uživateli do schránky a **pořadí ve Výsledcích
nenese informaci** — nedá se podle něj vybírat, co si přečíst první.

**Je to tentýž vzorec jako incident s Prahou.** Slabý free model (Llama 8B) neumí odstupňovaný
úsudek, umí hrubé ano/ne. U regionu se to vyřešilo přesunem rozhodnutí do kódu (`src/region.ts`);
u role se nabízí totéž.

**Možnosti (nerozhodnuto):**

1. **Deterministický filtr role** — obdoba `region.ts` nad titulem: `tester`, `technik`, `support`,
   `helpdesk`, `junior`, `vývojář`/`developer`, `QA`, `obchodník`, `konzultant` → tvrdý strop.
   Levné, vysvětlitelné, testovatelné bez Workeru, zapadá do už zavedeného vzoru.
2. **Přepnout skórování na placeného `claude-haiku-4-5`** (Nastavení → AI backend). Ten škálu
   drží. Provozní náklad je malý (krátké prompty, strop 150 skóre/běh), ale je to závislost
   na placeném backendu tam, kde dnes stačí zdarma.
3. **Obojí** — kód řeší tvrdá kritéria, model odstupňování uvnitř toho, co projde.

**Pozor na past, do které jsem málem spadl:** 148 nul vypadalo jako důsledek chyby
`Number(null)` → 0 opravené týž den. Není. **Všechny nuly mají smysluplné zdůvodnění**
(„Lokalita není v preferovaném regionu (Brno)…"), tedy jde o správná zamítnutí.
Hromadné `UPDATE seen_jobs SET relevance = NULL WHERE relevance = 0` by vrátilo do fronty
148 správně vyřízených inzerátů. **Nedělat.**

**Další čísla k témuž dni:** 481 záznamů celkem (59 duplicit), 166 označených jako zrušené
(liveness funguje), 111 čeká ve frontě na doskórování.

---

## 2026-08-22 (2) — identita v hlavičce, min. skóre do Nastavení, stránka /tests

Tři drobnosti z provozu, jedna z nich koncepční.

- ✅ **Kdo je přihlášený + Odhlásit** (`GET /api/me`, `public/footer.js`) — v hlavičce je účet
  z Accessu a odkaz na odhlášení. Session drží **Access, ne aplikace**, proto se odhlašuje na
  `/cdn-cgi/access/logout` (`ACCESS_LOGOUT_PATH`). U účtu svítí ⚠, když není nastavený
  `ACCESS_ALLOWED_EMAILS` — ať se na nedodělek nezapomene. Bez Accessu (lokální `DEV_OPEN=1`)
  se ukáže „lokální vývoj".
- ✅ **Min. skóre v přehledu do Nastavení** (`settings.minScore`, default 0) — dřív to byla
  hodnota v `localStorage`, tedy per-prohlížeč; na druhém zařízení se musela nastavovat znovu.
  Teď je v D1. **Není to totéž co `notifyThreshold`**: ten řídí, co se *pošle*, `minScore` řídí,
  co se *zobrazí*. V přehledu jde hodnotu dočasně přenastavit, ale neukládá se; filtry
  Agentury/Stav zůstaly per-prohlížeč („Uložit filtry"), protože to jsou krátkodobé pohledy.
- ✅ **Stránka `/tests` + `GET /api/selftest`** — viz níže, tohle je ta koncepční část.
- ✅ **`sanitizeSettings` přesunuta z `index.ts` do `config.ts`** — bydlí u nastavení, hlavně ale
  jde teď otestovat bez Workeru (`tests/settings-sanitize.test.ts`). Je to jediná obrana mezi
  cizím JSONem z API a hodnotami, které řídí pipeline.

### Proč `/tests`, když už je brána v CI

Zelené CI dokazuje, že prošel **commit**. Nedokazuje, že se stejně chová **to, co právě běží** —
build, bindingy, vars. Proto `src/selftest.ts`: **jedna definice invariantů, dva spouštěče** —
CI (`tests/selftest.test.ts`) a nasazený Worker (`/api/selftest`, vrací 500, když něco selže).
Žádná druhá kopie testů nevzniká.

Podmínka, která to drží použitelné: kontroly se **nesmí dotknout D1, sítě ani AI**. Proto projdou
i na rozbité databázi a smí běžet na každý dotaz. Každá kontrola nese `proc` — dvě z nich jsou
přímo ty chyby nalezené dnes (prefiltr propouštěl vše; skóre `null` se ukládalo jako 0), takže
se jako regrese už neprojdou tiše.

**Stav kontrol:** 57 testů v CI + 14 kontrol regionu; sebekontrola má **38** invariantů.

**Doladěno po prvním použití naživo:** tlačítko „Spustit znovu" nedávalo poznat, že se něco
stalo — server sadu spočítá za 0 ms, takže se stránka překreslila neviditelně. Průběh se teď
odkrývá po kontrolách (stav, progress, počítadlo, propadlá kontrola se na půl vteřiny zvýrazní).
Aby to nemátlo: krokování je **vykreslování**, skutečný čas výpočtu hlásí server a je vypsaný
zvlášť („výpočet na serveru X ms · odpověď za Y ms").

---

## 2026-08-22 — identitu ověřuje aplikace, ne jen perimetr + testovací vrstva

**Podnět.** Externí posudek repa (ChatGPT, 8,2/10) uložený doslovně v repu
[`sebeanalyza`](https://github.com/Anamax443/sebeanalyza) → `externi/2026-08-22-chatgpt-3-job-watch.md`.
Ověření jeho tvrzení proti kódu a dossier: `hodnoceni/job-watch.md` tamtéž. Všechna jeho
konkrétní tvrzení obstála; dvě jeho známky jsou naopak mírnější, než by měly být.

### Hotové (commit `8823231`)

- ✅ **`src/access.ts`** — autorizaci dělá **aplikace**, ne jen perimetr:
  - chráněné je **celé `/api` včetně čtení** (`isProtectedPath`); ven zůstává jen
    `/.well-known/security.txt` a statické UI,
  - ověřuje se **hodnota** hlavičky `Cf-Access-Authenticated-User-Email` proti allowlistu
    `ACCESS_ALLOWED_EMAILS` (var ve `wrangler.toml`), ne jen její přítomnost,
  - prázdný allowlist pustí přihlášeného, ale `/api/health` to hlásí
    (`access.allowlistConfigured`) — aby chybějící var neuzamkl vlastníka venku,
  - `DEV_OPEN=1` v `.dev.vars` pro `wrangler dev` (musí být přesně `"1"`).
  - Modul je **záměrně bez importů** (jako `src/region.ts`) → testovatelný mimo Worker.
- ✅ **Testovací vrstva** — 45 testů vestavěným `node --test`, **žádná nová závislost**:
  `tests/access.test.ts`, `dedup.test.ts`, `prefilter.test.ts`, `score-normalize.test.ts`,
  `util.test.ts`. `scripts/region-check.ts` (14 kontrol) zůstal a spouští se z `npm test`.
- ✅ **Brána v CI** — `deploy.yml`: `typecheck` → **`test`** → deploy. Když testy spadnou,
  nenasadí se nic.
- ✅ **Relativní importy v `src/` mají příponu `.ts`** (`allowImportingTsExtensions`) — bez toho
  plain `node` moduly nespustí a testy by šly psát jen s bundlerem. Bundle ověřen
  `wrangler deploy --dry-run`.
- ✅ **`ACCESS_ALLOWED_EMAILS = "bass443@gmail.com"`** — účet z politiky Cloudflare Access.
- ✅ Dokumentace: README (sekce *Testy* + *Autorizaci dělá i aplikace*), `docs.html`,
  tenhle `HANDOFF.md` a `STATUS.html`.

### Dvě tiché chyby, které testy odhalily (obě opravené)

Ani jedna by nespadla a ani jedna nejde vidět při čtení kódu — první vypadá jako správný
guard, druhá jako správná konverze:

1. **`prefilter.ts`** — klíčové slovo ze samých mezer prošlo testem `k &&`, ale `norm(k)` je
   `""` a `hay.includes("")` je **vždy true** → na AI skórování šlo úplně všechno a spálilo
   denní rozpočet backendu. Rozhoduje teď délka po normalizaci.
2. **`score.ts`** — `Number(null)` je `0` (stejně `''`, `false`, `[]`), takže odpověď modelu
   **bez** skóre se uložila jako `relevance 0`. Nulu smyčka bere jako hotovo → inzerát by se
   už nikdy nepřeskóroval. Proti přesně tomuhle se `scoreJob` o pár řádků níž vědomě brání.

### ✅ Nález při nasazení: CI hlásilo selhání, i když nasadilo — VYŘEŠENO týž den

Deploy workflow skončil **červeně**, přitom Worker se nasadil. Rozpad kroků:

| Krok | Výsledek |
|---|---|
| `npm ci`, `typecheck`, **`npm test`** | ✅ prošlo (brána s testy jela poprvé a funguje) |
| `wrangler deploy` — upload skriptu | ✅ „Uploaded job-watch (6.03 sec)" |
| `wrangler deploy` — srovnání rout na zóně | ❌ `A request to the Cloudflare API (/zones/…/workers/routes) failed. Authentication error [code: 10000]` |

**Ověřeno, že nová verze opravdu běží:** `wrangler deployments list` ukazuje deployment
z `2026-08-22T11:56:01Z` na **100 %**. Perimetr drží — `GET /api/version` bez přihlášení
vrací 302 na Access login, stejně tak požadavek s ručně podvrženou hlavičkou.

**Není to nová vada, je pre-existující.** Předchozí běh (`31005784540`, 5. 8. 12:30, commit
`17b8962` — fronta) selhal **úplně stejně** a taky se přitom nasadil (deployment 12:31:03).
Poslední zeleně dokončený CI deploy je `2cb3240` z 5. 8. 11:28 — tedy ten, který vypnul
`workers_dev`. Od té chvíle wrangler při každém nasazení srovnává routy na zóně a token na to
nemá právo.

**Příčina:** GitHub secret `CLOUDFLARE_API_TOKEN` nemá oprávnění **Zone → Workers Routes → Edit**
pro zónu `maxferit.cz`. Lokální OAuth token ho má (`workers_routes (write)`), proto lokální
`wrangler deploy` projde a CI ne.

**Náprava — hotovo 22. 8. 2026.** Token `job-watch-ci-deploy` měl jen `D1 Write` +
`Workers Scripts Write`. Doplněna třetí policy: rozsah **Specified Domains → `maxferit.cz`**,
oprávnění **Workers Routes → Write**. Token se **needitoval rollem**, takže si zachoval hodnotu
a GitHub secret `CLOUDFLARE_API_TOKEN` zůstal platný — nic se nepřepisovalo.

Ověřeno `gh run rerun`: běh `32571766264` doběhl **zeleně** včetně kroku
`cloudflare/wrangler-action@v3`. Od téhle chvíle platí normální pravidlo:
**červené CI = opravdu nenasazeno.**

> Ponecháno v deníku i po opravě, protože to je poučení, ne jen porucha: mezi 5. a 22. 8.
> hlásilo CI dvakrát selhání, přitom obakrát nasadilo. Kdyby se v té době objevila skutečná
> chyba, zapadla by do šumu. **Zelená, které se nedá věřit, je horší než žádná.**

### Zbývá / vědomě odloženo

- ⏳ **Klíče plaintextem v D1** (`src/secrets.ts`) — a D1 hodnota **přebíjí** Worker secret.
  Rozhodnout: buď zrušit správu klíčů z UI, nebo přesunout do Cloudflare Secret Store.
- ⏳ **`pipeline.ts` má 514 řádků** a sbíhá se v něm všechno. Dělit ho **až budou testy na
  švech** — dělit orchestrátor držící stav běhu dřív je způsob, jak si tiše rozbít frontu.
- ⏳ **Atomicita zápisu** — neověřeno, jestli job + skóre + dedup vazba + notifikace běží
  v jedné transakci a co zůstane, když to spadne mezi kroky.
- ⏳ **Staré nuly v datech** — inzeráty, které dostaly `relevance 0` kvůli chybě č. 2, zůstávají
  nulové a samy se nepřeskórují. `UPDATE seen_jobs SET relevance = NULL WHERE relevance = 0`
  by je vrátil do fronty, ale smázlo by to i legitimní nuly → napřed se podívat, kolik jich je.
- ⏳ **Filtr role v kódu — rozhodnout až po dojetí fronty.** Nález z 22. 8. („skórování
  nerozlišuje") z velké části vyřešila oprava profilu 23. 8.; stovky zmizely. Až se přeskóruje
  celá fronta, porovnat rozložení a teprve pak rozhodnout, jestli je kódový filtr ještě potřeba.
- ⏳ **Deanonymizace i pro holdingy**, nejen pro agentury — „Skupina ČEZ" místo „OSC, a.s.".
  Stejný mechanismus, jiný spouštěč než `is_agency`.
- ⏳ Otevřené body na konci README (wrapper přírůstkového JSONu MPSV, tvary ATS odpovědí,
  registr agentur, detailní URL MPSV).

---

## 2026-08-05 — stav před tímhle (rekonstruováno z git historie)

Zpětný záznam, aby deník nezačínal uprostřed. Zdroj: `git log`, ne paměť.

- **Nasazeno naživo** na `jobwatch.maxferit.cz` za Cloudflare Access; `workers_dev = false`
  (commit `2cb3240`) — dokud bylo workers.dev zapnuté, existovala **druhá, Accessem nechráněná**
  adresa téhož Workeru a přes ni šlo bez přihlášení stáhnout `/api/settings` (profil/CV),
  `/api/jobs` (kontaktní osoby), `/api/runs` i `/api/sources`. Ověřeno živě, vypnuto týž den.
- **Region rozhoduje kód, ne model** (`552956c`) — slabý free model ignoroval instrukci
  v promptu a pražský inzerát dostal 80/100 při nastavení „brno". Vznikl `src/region.ts`
  + `scripts/region-check.ts`.
- **Fronta** (`17b8962`, `2cb3240`) — nezpracovaní kandidáti se ukládají bez skóre a dohánějí se;
  předtím denní běh reálně ohodnotil 3 z 91 kandidátů a 88 zahodil. Vadný řádek frontu nezasekne.
- **E-mail přes Cloudflare Email Sending** místo MS Graph (`e827e85`).
- **Lokalita/kraj z MPSV** ze strukturované adresy (`a2343be`, `a576ae6`) — `adresaText` je null
  u ~99 % záznamů, takže filtr regionu byl předtím fakticky vypnutý.

**Stav dokumentace tehdy:** jen README (projekt neměl `HANDOFF.md` ani `STATUS.html`).

---

## Redeploy / nová verze

```powershell
cd D:\git\job-watch
npm run typecheck; npm test      # brána — stejná jako v CI
git push                         # push do main = auto-deploy (deploy.yml)
```

Ruční deploy mimo CI (vyžaduje přihlášený wrangler na účtu **bass443**):

```powershell
npx wrangler deploy --var "GIT_COMMIT:$(git rev-parse --short HEAD)" --var "BUILT_AT:$(Get-Date -Format yyyy-MM-dd)"
```

**Kontrola po nasazení:** patička UI ukazuje nasazený commit; `/api/health` vrací mj.
`access.allowlistConfigured` — musí být `true`, jinak kontrola identity fakticky neplatí.
