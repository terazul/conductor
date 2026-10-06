-- ─────────────────────────────────────────────────────────────────────────────
-- 050_project_dirs — Track A. A project's directories beyond its first (Amendment 39).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `projects.path` stays the project's first directory: the one its jobs cut worktrees
-- from and its agents start in. These are the others — agents can reach them, and the
-- Files screen shows them. A side table rather than an ALTER, so the core table and
-- everything keyed on its UNIQUE path are untouched. Removing a row forgets the
-- directory; nothing on disk is touched, here or anywhere.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_dirs (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
