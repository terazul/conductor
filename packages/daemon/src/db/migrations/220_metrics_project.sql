-- ─────────────────────────────────────────────────────────────────────────────
-- 220_metrics_project — Track A. The Metrics tab, per project (Amendment 136).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `metrics_daily` (170) is keyed by day, engine and model, and says nothing of which project
-- the work was for. Rather than re-key it (a table rebuild, and every row before this would
-- need a project it never had), the same counters are kept a second time here, with the
-- project in the key, written by the same `bump` in session/metrics.ts in the same
-- transaction. So `metrics_daily` and every query on it are exactly as they were, the
-- "all projects" view still reads it, and a project's view reads this.
--
-- Counts from before this migration have no project: they are in `metrics_daily` only, and
-- show under "all projects". Like `metrics_daily`, nothing here references `projects` or
-- `agents`, so removing a job, an agent or even the project leaves the counts where they are
-- (the route answers 404 for a project that is gone, since there is no name to show).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS metrics_project_daily (
  day                  TEXT    NOT NULL,   -- the daemon's local day, as metrics_daily's
  project_id           TEXT    NOT NULL,   -- the agent's project when the count was made
  provider             TEXT    NOT NULL,
  model                TEXT    NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL    NOT NULL DEFAULT 0,
  calls                INTEGER NOT NULL DEFAULT 0,
  retries              INTEGER NOT NULL DEFAULT 0,
  runs                 INTEGER NOT NULL DEFAULT 0,
  failed_runs          INTEGER NOT NULL DEFAULT 0,
  run_ms               INTEGER NOT NULL DEFAULT 0,
  api_ms               INTEGER NOT NULL DEFAULT 0,
  timed_calls          INTEGER NOT NULL DEFAULT 0,
  timed_output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, provider, model)
);

-- When per-project counting began: a project's view starts here, not at metrics_meta's 'since'.
INSERT OR IGNORE INTO metrics_meta (k, v) VALUES ('project_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
