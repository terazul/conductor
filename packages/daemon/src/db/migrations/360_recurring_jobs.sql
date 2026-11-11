-- ─────────────────────────────────────────────────────────────────────────────
-- 360_recurring_jobs — a job that repeats (Amendment 211).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A saved Spawn setup and a rule for when to launch it again: every day at a time, on some
-- weekdays at a time, or every N hours. Each run is a new job from `request`, the exact
-- CreateJobRequest Spawn would send, so each one starts fresh. It stays until you cancel it;
-- the jobs it started stay too. `every` is the rule as JSON (`Every` in shared/recurring.ts).
-- `next_at` is the next time it is due, ISO; `last_result` is `started`, `skipped` (the last
-- run's job had not ended) or `failed: <why>`. Removing the project removes its schedules.
--
-- `jobs.recurring_id` is the schedule a job came from. Plain text, no foreign key: the job
-- outlives a cancelled schedule, and says it came from one.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE recurring_jobs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  request     TEXT NOT NULL,
  every       TEXT NOT NULL,
  next_at     TEXT NOT NULL,
  last_at     TEXT,
  last_job_id TEXT,
  last_result TEXT,
  created_at  TEXT NOT NULL,
  paused      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX recurring_jobs_project ON recurring_jobs(project_id);

ALTER TABLE jobs ADD COLUMN recurring_id TEXT;
