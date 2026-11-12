-- ─────────────────────────────────────────────────────────────────────────────
-- 380_recurring_more — repeating messages, and a job keeps its setup (Amendment 216).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A schedule is now one of two kinds, in the one table, so pause, run now, edit and the last
-- result are shared:
--   - a new job, as 360 made it: `request` is the CreateJobRequest, `agent_id` and `text` NULL;
--   - a message to an agent: `agent_id` is the agent it is sent to and `text` what is sent,
--     exactly as if you had pressed send then. `request` is '' (it is NOT NULL), `project_id`
--     the agent's project, `last_job_id` stays NULL and `last_result` is `sent` or
--     `failed: <why>`. Removing the agent removes its repeating messages.
--
-- `jobs.request` is the single-stack CreateJobRequest the job was launched from, as
-- parseCreateJob normalised it, written when the job is made: by a Spawn launch (each stack of
-- a batch its own) and by a recurring run (the schedule's request, before the run's name and
-- branch). It is what "repeat this job" copies. NULL for every job from before this.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE recurring_jobs ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE recurring_jobs ADD COLUMN text TEXT;

CREATE INDEX recurring_jobs_agent ON recurring_jobs(agent_id);

ALTER TABLE jobs ADD COLUMN request TEXT;
