# JobWatch — Handoff

Append-only deník stavu. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače
/ po pauze. Věcné „jak to funguje" je v [README.md](README.md), tady je jen **stav**.

> **🟢 NASAZENO A BĚŽÍ:** [jobwatch.maxferit.cz](https://jobwatch.maxferit.cz) za Cloudflare
> Access, denní cron 07:00 SEČ. Repo **`Anamax443/job-watch`** (PUBLIC), větev `main`.
> Deploy jede z CI při pushi do `main` — **push = nasazení**.
> Provoz je nezávislý na lokálním PC (Worker + D1 + Cron + GitHub Actions).

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
