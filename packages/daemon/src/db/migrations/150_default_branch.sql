-- ─────────────────────────────────────────────────────────────────────────────
-- 150_default_branch — Track A. Choose a project's default branch (Amendment 117).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `projects.default_branch` was captured once at registration and never updated
-- (Amendment 113's `resolveTarget` kept it a low-priority fallback for exactly that
-- reason). This flag marks when a user has since set it on purpose, from the Branches
-- screen's "Make default": `resolveTarget` then puts it ahead of origin/HEAD instead of
-- behind it. A plain ALTER with a default, so every existing row reads as not yet set.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects ADD COLUMN default_branch_set INTEGER NOT NULL DEFAULT 0;
