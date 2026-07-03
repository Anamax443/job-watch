# JobWatch — monitor volných míst pro vedoucí IT

Cloudový agent (Cloudflare Worker), který každý den prohledá zdroje volných míst,
vybere pozice typu **vedoucí IT / IT manažer / Solution Architect**, nechá je AI
**ohodnotit podle TVÉHO profilu** (CV / o mně z Nastavení), u agenturních inzerátů
dohledá **původce**, ověří **živost inzerátu** (aktivní/zrušené), zachytí
**kontaktní osobu** (e-mail/telefon) a pošle nové nálezy na **Telegram / e-mail / Slack**.

- **Stack:** Cloudflare Worker + Cron + D1 + Anthropic API + statické UI (za Cloudflare Access)
- **Zdroje:** MPSV (celý trh ČR) · **Adzuna Job API** (konkrétní inzeráty z webu) · ATS firem
- **Modely:** `claude-haiku-4-5` (scoring) · `claude-sonnet-4-6` (deanonymizace)
- **Live:** https://jobwatch.maxferit.cz (Access) · **Licence:** MIT · **Autor:** Milan Trnka (maxferit)

---

## Architektura

```
Cloudflare Worker "job-watch"  (+ statické UI, + D1, + cron)
 ├─ Cron 07:00 → fetch (MPSV + ATS z D1 + Adzuna) → prefilter → dedup → score
 │               → enrich (deanonymizace) → notify → discover → doskórování fronty
 ├─ Web (za Cloudflare Access na jobwatch.maxferit.cz):
 │    GET  /              → Výsledky (dashboard, stavové okno běhu)
 │    GET  /settings      → Nastavení (profil, prahy, kanály, klíče)
 │    GET  /api/jobs|sources|runs|health|version  → data (JSON)
 │    POST /api/settings|run|run/stop|keys|test-notify  → akce (vyžadují Access)
 └─ Cloudflare Access: přihlášení e-mailem (jen povolený e-mail)
D1:
 ├─ seen_jobs   → výsledky napříč zdroji (vč. živosti active + kontaktní osoby)
 ├─ sources     → dynamicky objevené zdroje (personálky/firmy + kde inzerují)
 └─ meta        → nastavení (JSON) + kurzor přírůstků
```

### Zdroje (`src/sources/`)

| Adaptér | Co dělá |
|---|---|
| `mpsv.ts` | denní přírůstky ÚP ČR / MPSV (celý trh, bez bot ochrany) |
| `ats.ts` | veřejná JSON API ATS systémů (Recruitee, Greenhouse, Lever, Ashby, SmartRecruiters); **cíle se čtou z D1 `sources`** — dynamicky objevené, žádné statické adresy |
| `web.ts` | **konkrétní inzeráty z webu přes Adzuna Job API** (firma, lokalita, mzda, přímý odkaz) — paralelní dotazy podle profilu/regionu; vyžaduje `ADZUNA_APP_ID`+`ADZUNA_APP_KEY` (`WEB_SEARCH=false` vypne) |
| `agencies.ts` | registr agentur práce → klasifikace `is_agency` napříč zdroji |

**Dynamický screening (`src/discover.ts`):** pro nově viděnou personálku/firmu agent
prohledá internet (`web_search`/`web_fetch`), zjistí, **kde zveřejňuje nabídky**, detekuje
platformu a uloží do D1 `sources`. Znalost se buduje v čase (omezeno `MAX_DISCOVERY_PER_RUN`
na běh). ATS adaptér pak tyto zdroje čte. Přehled: `GET /api/sources`.

### Pipeline (`src/`)

`prefilter.ts` (CZ-ISCO + klíčová slova; web obchází, je předfiltrovaný) → `store.ts`
(cross-source dedup + **otisk věty / opakování v čase**) → `score.ts` (haiku, structured
outputs — **hodnotí shodu proti profilu z Nastavení**) → `enrich.ts` (Sonnet 4.6 —
deanonymizace původce) → `notify.ts` (Telegram + e-mail/MS Graph + **Slack**).
`pipeline.ts` navíc: časové limity zdrojů + celkový strop, doskórování fronty, stav běhu do `runs`.

**Můj profil:** v Nastavení vlož CV / text o sobě → AI skóruje pozice přímo proti tobě
(ne obecně). Změna profilu vynuluje skóre → příští běh přeskóruje.

### Živost inzerátu (`src/liveness.ts`)

Ve Výsledcích má každý inzerát **Stav** (✅ Aktivní / 🚫 Zrušené / ⏳ neověřeno) a v hlavičce
je filtr **Vše (default) / Aktivní / Zrušené** (uloží se do prohlížeče). U jobs.cz (`/rpd/<id>`)
a prace.cz (`/nabidka/<uuid>`) vrací zrušený inzerát **HTTP 404** → `recheckLiveness` v každém
běhu dávkově přeověří zobrazované inzeráty (přednost mají nejdéle neověřené = vypadlé z listovky;
strop `MAX_LIVENESS_CHECKS_PER_RUN`, default 60). Výskyt v živé listovce rovnou nastaví `active=1`.
MPSV nemá detailní URL k ověření → zůstává „neověřeno".

### Kontaktní osoba

Aby šlo oslovit **konkrétního člověka i po skončení výběrového řízení**, ukládá se ke
každému inzerátu kontakt (jméno, e-mail, telefon, pozice) a zobrazí se v řádku výsledku.
Reálný kontakt dává hlavně **MPSV** (`prvniKontaktSeZamestnavatelem.komuSeHlasit`); jobs.cz/
prace.cz přihlášky vedou přes portál, takže reálný e-mail neposkytují.

---

## Provoz: nezávislé na lokálním PC

Celý **denní provoz běží v cloudu** (Cloudflare Worker + Cron + D1) — lokální PC se
k běhu nepoužívá. Stav, naučené zdroje i nastavení žijí v D1.

- **Setup/deploy** lze řídit z cloudu přes **GitHub Actions** (`.github/workflows/deploy.yml`),
  takže ani deploy nepotřebuje konkrétní PC. Stačí GitHub secret `CLOUDFLARE_API_TOKEN`.
- **Seed je volitelný** — denní běh dohání přírůstky sám (`MAX_INCREMENT_BACKFILL_DAYS`).
  Pokud chceš nahrát historické otevřené pozice, spusť `seed.yml` (taky v CI, ne na PC).

---

## Setup

```bash
npm install

# 1) D1 databáze
wrangler d1 create job-watch          # → doplň database_id do wrangler.toml
npm run db:init                       # vytvoří tabulky (remote); local: npm run db:init:local

# 2) Secrets (necommitovat!)
cp .dev.vars.example .dev.vars        # vyplň pro lokální dev
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GRAPH_TENANT_ID
wrangler secret put GRAPH_CLIENT_ID
wrangler secret put GRAPH_CLIENT_SECRET
wrangler secret put GRAPH_MAILBOX
wrangler secret put SLACK_WEBHOOK_URL   # volitelné — Slack Incoming Webhook
wrangler secret put ADZUNA_APP_ID       # web zdroj (konkrétní inzeráty) — developer.adzuna.com
wrangler secret put ADZUNA_APP_KEY
# Klíče lze nově spravovat i přes UI (Nastavení → Klíče a přístupy), uloží se do D1.

# 3) Lokální běh
npm run dev                           # UI na http://localhost:8787

# 4) Deploy
npm run deploy                        # nebo z cloudu: GitHub Action deploy.yml (push do main)

# 5) Seed — VOLITELNÉ (historické otevřené pozice; denní běh ho nevyžaduje)
npm run seed                          # vygeneruje seed.sql (plný export má desítky MB)
wrangler d1 execute job-watch --remote --file=seed.sql
#   …nebo bez PC: spusť GitHub Action „Seed MPSV baseline" (seed.yml)
```

> **CI:** přidej GitHub secret `CLOUDFLARE_API_TOKEN` (Workers + D1). `deploy.yml` pak
> nasazuje při pushi do `main`, `seed.yml` se spouští ručně. Vyžaduje vyplněné `database_id`.

Nastavení (jakou pozici hledat, kam posílat e-mail, na jaký Telegram chat_id,
prahy, zapnuté kanály) se edituje v UI na `/settings` — ukládá se do D1, cron je
čte při každém běhu.

---

## Ochrana přístupu — Cloudflare Access (AKTIVNÍ)

UI běží na vlastní doméně **`jobwatch.maxferit.cz`** chráněné **Cloudflare Access**
(Zero Trust) — politika „Allow → Emails → povolený e-mail", přihlášení jednorázovým PINem.
*(Pozn.: Access nelze dát na `*.workers.dev` — proto custom doména.)*

Citlivé endpointy (`/api/keys`, `/api/run`, `/api/run/stop`, `/api/test-notify`,
`POST /api/settings`) navíc v kódu vyžadují hlavičku `Cf-Access-Authenticated-User-Email`,
takže fungují jen přes přihlášený Access (ne přímo přes workers.dev).

---

## K ověření při buildu (otevřené body)

- [x] Přesný název přírůstkového souboru: `volna-mista-prirustek-YYYY-MM-DD.json` (potvrzeno).
- [x] Názvy polí MPSV proti schématu (potvrzeno — viz `src/sources/mpsv.ts`).
- [ ] **Wrapper přírůstkového JSONu** — ověřit klíč pole položek (`mpsv.ts` parsuje defenzivně).
- [ ] **ATS endpointy** — ověřit živě tvar odpovědi pro každou platformu/firmu (`ats.ts`).
- [ ] **Registr agentur práce** — zdroj strojových dat / IČO (`agencies.ts` má fallback dle názvu).
- [ ] **Detailní URL inzerátu MPSV** — ověřit veřejný odkaz na detail (`mpsv.ts` má fallback).
- [ ] **Graph oprávnění** — app registrace s `Mail.Send` (application) + admin consent.
- [ ] **Telegram** — bot přes @BotFather, zjistit `chat_id`.
