-- Změna profilu už nesmí mazat skóre.
--
-- Do 31. 8. 2026 dělal `/api/settings` při změně textu profilu jediné:
--   UPDATE seen_jobs SET relevance = NULL
-- Smysl to mělo (staré skóre bylo měřené proti jinému profilu, takže není srovnatelné),
-- jenže důsledek byl horší než nemoc:
--   * z 458 inzerátů zůstalo 299 bez skóre a v přehledu je Min. skóre schovalo úplně
--     (na NULL neplatí žádné porovnání, takže je vyhodí i práh 1),
--   * přeskórovat celou historii trvá týdny — běh stihne 10-15 inzerátů, pak Worker
--     spadne na "Too many subrequests",
--   * a 154 z nich se nepřeskóruje NIKDY, protože jsou stažené z portálu a fronta
--     bere jen živé. Mezi nimi 12, o kterých už jednou přišla notifikace.
--
-- Nově se skóre nechává a jen se označí jako neaktuální: `rescore = 1`. Historie tak
-- zůstane čitelná a filtrovatelná, zatímco fronta postupně dopočítává nové hodnoty.
--
-- Pozn.: skóre, které už bylo vymazané dřív, tahle migrace nevrátí — číslo je pryč
-- (`reason` a `seniority` u těch řádků zůstaly, ale hodnota ne).
--
-- Aplikuj PŘED nasazením kódu, který sloupec čte:
--   npx wrangler d1 execute job-watch --remote --file=migrations/0003_keep_score_on_profile_change.sql

ALTER TABLE seen_jobs ADD COLUMN rescore INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_seen_rescore ON seen_jobs(rescore);
