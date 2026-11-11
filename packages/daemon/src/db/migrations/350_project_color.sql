-- ─────────────────────────────────────────────────────────────────────────────
-- 350_project_color — a project's colour bar (Amendment 210).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- The colour of the bar down a project's left edge in the navigator, on its Fleet card, and at the
-- top of its Project, Agent and Files screens, so a project in the menu is the same one on the page.
-- It holds a key of the web's palette (`PROJECT_COLORS` in shared/wire.ts: "sky", "mint", ...), never
-- a colour: each key is a `--proj-<key>` token with its own value in each theme. Set from the Fleet
-- card's edit form through PATCH /api/projects/:id. NULL means auto, which is every project that was
-- there before: the web gives it the key fewest projects have, in the order they were created.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects ADD COLUMN color TEXT;
