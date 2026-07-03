-- JobWatch migrace 0002 — kanonizace MPSV id na číselné portalId.
-- Sjednotí id ze seedu (mpsv:VolneMisto/<num>) i z přírůstků (mpsv:VolneMistoPrirustek/<num>)
-- na tvar mpsv:<num>, aby se týž inzerát napříč zdroji zdedupoval podle primárního klíče.
-- Aplikuj jednou:
--   wrangler d1 execute job-watch --remote --file=migrations/0002_mpsv_id_canonical.sql
-- Bezpečné jen bez kolizí PK (ověřeno: řádky → tolik unikátních portalId; žádný duplicate_of
-- neukazuje na 'mpsv:.../...'). Kód (src/sources/mpsv.ts, scripts/seed.ts) už tvoří mpsv:<num>.
UPDATE seen_jobs
SET id = 'mpsv:' || substr(id, instr(id, '/') + 1)
WHERE source = 'mpsv' AND id LIKE 'mpsv:%/%';
