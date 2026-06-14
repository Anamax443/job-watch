# JobWatch — monitor volných míst pro vedoucí IT

Cloudový agent (Cloudflare Worker), který každý den prohledá oficiální i firemní
zdroje volných míst, vyfiltruje pozice typu **vedoucí IT / IT manažer / Solution
Architect**, nechá je ohodnotit přes **Anthropic API**, u anonymních agenturních
inzerátů se pokusí dohledat **původce** a pošle nové nálezy na **Telegram / e-mail**.

- **Stack:** Cloudflare Worker + Cron + D1 + Anthropic API + statické UI
- **Modely:** `claude-haiku-4-5` (scoring) · `claude-sonnet-4-6` (deanonymizace)
- **Licence:** MIT · **Autor:** Milan Trnka (maxferit)

---

## Architektura

```
Cloudflare Worker "job-watch"  (+ statické UI, + D1, + cron)
 ├─ Cron 07:00 → fetch (MPSV + ATS z D1 + celý web) → prefilter → dedup → score
 │               → enrich (deanonymizace) → notify → discover (screening zdrojů)
 ├─ Web:
 │    GET  /              → Výsledky (dashboard)
 │    GET  /settings      → Nastavení
 │    GET  /api/jobs      → výsledky (JSON)
 │    GET  /api/sources   → dynamicky naučené zdroje (JSON)
 │    GET  /api/settings  → načti nastavení
 │    POST /api/settings  → ulož nastavení
 │    POST /api/run       → ruční spuštění běhu (test)
 └─ (ochrana přístupu: zatím vypnutá — viz níže)
D1:
 ├─ seen_jobs   → výsledky napříč zdroji
 ├─ sources     → dynamicky objevené zdroje (personálky/firmy + kde inzerují)
 └─ meta        → nastavení (JSON) + kurzor přírůstků
```

### Zdroje (`src/sources/`)

| Adaptér | Co dělá |
|---|---|
| `mpsv.ts` | denní přírůstky ÚP ČR / MPSV (celý trh, bez bot ochrany) |
| `ats.ts` | veřejná JSON API ATS systémů (Recruitee, Greenhouse, Lever, Ashby, SmartRecruiters); **cíle se čtou z D1 `sources`** — dynamicky objevené, žádné statické adresy |
| `web.ts` | **otevřené hledání podle role napříč celým webem** (Sonnet + web search) — inzeráty můžou být kdekoliv, nespoléhá na pevný seznam (`WEB_SEARCH=false` vypne) |
| `agencies.ts` | registr agentur práce → klasifikace `is_agency` napříč zdroji |

**Dynamický screening (`src/discover.ts`):** pro nově viděnou personálku/firmu agent
prohledá internet (`web_search`/`web_fetch`), zjistí, **kde zveřejňuje nabídky**, detekuje
platformu a uloží do D1 `sources`. Znalost se buduje v čase (omezeno `MAX_DISCOVERY_PER_RUN`
na běh). ATS adaptér pak tyto zdroje čte. Přehled: `GET /api/sources`.

### Pipeline (`src/`)

`prefilter.ts` (CZ-ISCO + klíčová slova) → `store.ts` (cross-source dedup) →
`score.ts` (haiku, structured outputs) → `enrich.ts` (Sonnet 4.6 + web_search/
web_fetch — deanonymizace původce) → `notify.ts` (Telegram + MS Graph).

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

## Ochrana přístupu

UI je **zatím bez přihlášení**. Zapnutí je jen konfigurace (žádná změna kódu):
v Cloudflare Zero Trust → Access přidej aplikaci na doménu Workeru a politiku
povolující jen tvůj e-mail. Doporučeno před ostrým provozem.

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
