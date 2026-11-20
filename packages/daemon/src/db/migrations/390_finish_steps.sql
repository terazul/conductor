-- ─────────────────────────────────────────────────────────────────────────────
-- 390_finish_steps — what a job does by itself when it is done (Amendment 219).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- An agent's "when done" steps (commit, test, merge, push, clean up) live in its autonomy JSON, so
-- they need no column. What they need is here:
--
--   projects.test_command   The command the Test step runs in a job's worktree (`make test`), with
--                           the user's login shell. Set on the Fleet card's edit form through PATCH
--                           /api/projects/:id. NULL: none, and Test can't run.
--
--   job_finishes.steps      JSON [{step, outcome, said}]: what each step that ran came to, in order
--                           (`WhenDoneResult`, shared/whendone.ts). NULL on a row from before this,
--                           which had no steps.
--   job_finishes.stopped_at The step that couldn't run and stopped the rest; `why` says why. NULL
--                           when nothing stopped.
--   job_finishes.test_output The last 200 lines Test printed, when it was Test that stopped them.
--   job_finishes.state      'running' while the steps run, so a daemon that stops in the middle
--                           finds the row on boot and records it "interrupted at <step>" rather than
--                           running anything again; NULL once recorded. Every older row is NULL.
--   job_finishes.current_step The step running now, while `state` is 'running'.
--   job_finishes.restored_at When the folder this row's clean-up removed was put back because a
--                           message came for one of its agents. NULL: not put back.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects ADD COLUMN test_command TEXT;
ALTER TABLE job_finishes ADD COLUMN steps TEXT;
ALTER TABLE job_finishes ADD COLUMN stopped_at TEXT;
ALTER TABLE job_finishes ADD COLUMN test_output TEXT;
ALTER TABLE job_finishes ADD COLUMN state TEXT;
ALTER TABLE job_finishes ADD COLUMN current_step TEXT;
ALTER TABLE job_finishes ADD COLUMN restored_at TEXT;
