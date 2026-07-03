-- JobWatch migrace 0001 — živost inzerátu (aktivní/zrušené) + kontaktní osoba.
-- Aplikuj jednou na existující DB:
--   wrangler d1 execute job-watch --remote --file=migrations/0001_active_contacts.sql
-- (Nové instalace už mají sloupce ze schema.sql — tuto migraci nespouštěj.)
ALTER TABLE seen_jobs ADD COLUMN active            INTEGER;
ALTER TABLE seen_jobs ADD COLUMN active_checked_at TEXT;
ALTER TABLE seen_jobs ADD COLUMN contact_name      TEXT;
ALTER TABLE seen_jobs ADD COLUMN contact_email     TEXT;
ALTER TABLE seen_jobs ADD COLUMN contact_phone     TEXT;
ALTER TABLE seen_jobs ADD COLUMN contact_position  TEXT;
CREATE INDEX IF NOT EXISTS idx_seen_active ON seen_jobs(active);
