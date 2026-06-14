-- JobWatch — D1 schéma
-- Aplikuj: npm run db:init        (remote)
--          npm run db:init:local  (lokální dev)

-- Nalezené / sledované pozice napříč všemi zdroji.
CREATE TABLE IF NOT EXISTS seen_jobs (
  id                 TEXT PRIMARY KEY,   -- source-prefixed id, např. "mpsv:12345" nebo "ats:recruitee:firma:67"
  source             TEXT NOT NULL,      -- "mpsv" | "ats:recruitee:firma" | ...
  hash               TEXT NOT NULL,      -- hash obsahu (detekce změny inzerátu)
  dedup_key          TEXT,               -- fuzzy klíč pro cross-source dedup (zaměstnavatel|titul|lokalita)
  title              TEXT,
  employer           TEXT,
  employer_ico       TEXT,
  location           TEXT,
  region             TEXT,
  cz_isco            TEXT,
  salary_from        INTEGER,
  salary_to          INTEGER,
  url                TEXT,
  description        TEXT,
  is_agency          INTEGER DEFAULT 0,  -- 0/1: zaměstnavatel je personální agentura
  relevance          INTEGER,            -- 0–100 z LLM scoringu
  seniority          TEXT,               -- lead | senior | other
  reason             TEXT,               -- krátké zdůvodnění skóre
  real_employer      TEXT,               -- odmaskovaný původce (u agentur)
  real_employer_url  TEXT,               -- first-party stránka původce
  duplicate_of       TEXT,               -- id jiného záznamu, je-li tento duplikát
  fingerprint        TEXT,               -- otisk věty (detekce opakování v čase / napříč zdroji)
  seen_count         INTEGER DEFAULT 1,  -- kolikrát se inzerát objevil (1 = poprvé, >1 = opakovaný)
  notified_at        TEXT,               -- kdy odešla notifikace (NULL = ještě ne)
  first_seen         TEXT DEFAULT (datetime('now')),
  last_seen          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_relevance ON seen_jobs(relevance);
CREATE INDEX IF NOT EXISTS idx_seen_dedup     ON seen_jobs(dedup_key);
CREATE INDEX IF NOT EXISTS idx_seen_agency    ON seen_jobs(is_agency);
CREATE INDEX IF NOT EXISTS idx_seen_first     ON seen_jobs(first_seen);
CREATE INDEX IF NOT EXISTS idx_seen_fp        ON seen_jobs(fingerprint);

-- Key-value úložiště: editovatelné nastavení (JSON pod 'settings') + kurzory běhu.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Dynamicky objevené zdroje (personálky/firmy a kde zveřejňují nabídky).
-- Buduje se v čase přes discover.ts — žádné statické adresy v kódu.
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,      -- jméno agentury/firmy
  ico           TEXT,               -- IČO, je-li známé
  kind          TEXT,               -- 'agency' | 'company'
  platform      TEXT,               -- recruitee|greenhouse|lever|ashby|smartrecruiters|unknown
  slug          TEXT,               -- slug v ATS URL
  endpoint      TEXT,               -- rozparsovaná fetch URL (JSON/RSS), je-li
  careers_url   TEXT,               -- lidská kariérní stránka
  status        TEXT DEFAULT 'unresolved', -- active|unresolved|dead
  confidence    INTEGER DEFAULT 0,  -- 0–100 jistota nálezu
  discovered_at TEXT DEFAULT (datetime('now')),
  last_checked  TEXT,
  last_ok       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_ico    ON sources(ico);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_ico ON sources(ico) WHERE ico IS NOT NULL;

-- Záznam každého běhu (cron i ruční) — aby bylo v UI vidět, co agent reálně dělá.
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  trigger     TEXT,          -- 'cron' | 'manual'
  ok          INTEGER DEFAULT 0,
  stats       TEXT,          -- JSON RunStats
  log         TEXT           -- řádky logu (oddělené \n)
);
CREATE INDEX IF NOT EXISTS idx_runs_id ON runs(id);
