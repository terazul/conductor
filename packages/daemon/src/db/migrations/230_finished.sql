-- ─────────────────────────────────────────────────────────────────────────────
-- 230_finished — Track A. A worktree job that finished, and what became of its branch (Amendment 144).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- One row each time a job isolated in a worktree settles `done` with its branch ahead of the
-- target (`session/finish.ts`):
--   • kind 'offer'  — nothing was merged: Needs You asks "Finished: merge into <target>?". The
--                     card is derived from this row while the job is still there and `done`;
--                     `why` says why it wasn't merged by itself, when the agent asked for that.
--   • kind 'merged' — the agent's "merge into main and clean up when done" merged it (`sha`),
--                     and `cleaned` says whether the job, its folder and its branch went too
--                     (`why` says why not). Information only, until dismissed.
--
-- No foreign key to `jobs`: the job is removed by the clean-up this row reports, and the row
-- says so afterwards. Dismissals are `alert_dismissals`, as for every alert.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_finishes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT    NOT NULL,
  project_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,              -- 'offer' | 'merged'
  branch     TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  ahead      INTEGER NOT NULL,
  agent_ids  TEXT    NOT NULL DEFAULT '[]', -- JSON: the job's agents when it finished
  sha        TEXT,
  cleaned    INTEGER NOT NULL DEFAULT 0,
  why        TEXT,
  at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_finishes_job ON job_finishes(job_id);
