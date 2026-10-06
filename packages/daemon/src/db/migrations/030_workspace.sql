-- ─────────────────────────────────────────────────────────────────────────────
-- 030_workspace — Track C. Worktree bookkeeping + the file-change projection.
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `workspaces` deliberately has NO foreign key to jobs(id). WorktreeMgr is
-- called to prepare a worktree, and whether the jobs row exists first is Track
-- A's business, not a constraint this table should be able to veto. The tree
-- endpoint resolves a jobId here first and falls back to jobs.worktree_path.
--
-- `file_changes` is a PROJECTION of file_edit events, not a second source of
-- truth (CONTRACT.md §5.2). Line counts shown in the UI always come from git at
-- read time; this table exists for the one fact git cannot answer — WHEN, and
-- by WHICH agent, a file was last touched this session. rebuild() in
-- workspace/store.ts regenerates every row from the event log.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  job_id      TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  -- The repository the worktree was cut from. Equals `path` for in_place.
  repo_path   TEXT NOT NULL,
  -- Absolute path agents actually work in. Matches jobs.worktree_path.
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  isolation   TEXT NOT NULL CHECK (isolation IN ('worktree','branch','in_place')),
  -- Commit the worktree was created from, for honest "since we started" diffs.
  base_ref    TEXT,
  created_at  TEXT NOT NULL,
  -- Set on remove() rather than deleting the row: the event log references it.
  removed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_path    ON workspaces(path);

CREATE TABLE IF NOT EXISTS file_changes (
  job_id       TEXT NOT NULL,
  -- Worktree-relative POSIX path.
  path         TEXT NOT NULL,
  added        INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  -- ISO timestamp of the most recent file_edit event for this path.
  at           TEXT NOT NULL,
  -- NULL when the writer isn't known (watcher saw it, no agent claimed it).
  by_agent_id  TEXT,
  -- seq of the file_edit event this row was projected from.
  seq          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, path)
);

CREATE INDEX IF NOT EXISTS idx_file_changes_job ON file_changes(job_id, at);
