-- ─────────────────────────────────────────────────────────────────────────────
-- 290_project_monthly_budget — Wave 12, M3. A project's monthly budget (Amendment 182).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A month's spend is a sum over `project_spend_daily` for the local month (store.ts
-- `projectSpend`), so nothing here holds money spent. This is only the budget a project's month is
-- held up against, in dollars, set from the Fleet card's edit form through PATCH
-- /api/projects/:id. NULL means none, which is every project that was there before. Like every
-- budget since Amendment 180, it only warns: reaching it adds a `monthly_budget` alert and stops,
-- holds or refuses nothing.
--
-- It is a column of `projects`, so removing a project takes it with it. `project_spend_daily` is
-- left alone (Amendment 146).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects ADD COLUMN monthly_budget_usd REAL;
