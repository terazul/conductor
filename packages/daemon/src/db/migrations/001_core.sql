-- ─────────────────────────────────────────────────────────────────────────────
-- 001_core — entities described by the frozen wire contract, plus the event log.
--
-- W0 OWNS THIS FILE. Never edit it after W0; migrations are append-only.
-- Tracks add their own numbered file and never touch another's:
--   Track A  010_session.sql    (requests, rules)
--   Track D  020_preview.sql    (dev servers, console)
--   Track C  030_workspace.sql  (worktree bookkeeping, file change cache)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt         TEXT NOT NULL,
  isolation      TEXT NOT NULL CHECK (isolation IN ('worktree','branch','in_place')),
  worktree_path  TEXT NOT NULL,
  branch         TEXT NOT NULL,
  status         TEXT NOT NULL,
  budget_usd     REAL,
  created_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  model           TEXT NOT NULL,
  -- SDK session id. Required for options.resume after a park or a restart.
  sdk_session_id  TEXT,
  status          TEXT NOT NULL,
  -- 'held' | 'parked' | NULL. See PLAN.md §1 finding B.
  block_mode      TEXT,
  cost_usd        REAL NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  -- JSON array of agent ids that must reach 'done' first.
  depends_on      TEXT NOT NULL DEFAULT '[]',
  autonomy        TEXT NOT NULL DEFAULT '{}',
  brief           TEXT,
  started_at      TEXT,
  ended_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_job ON agents(job_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- The event log. Append-only. `seq` is the rowid: global, monotonic, gapless
-- enough for a cursor. Everything the UI shows is a projection of this table.
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  project_id TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  -- NULL for job-scoped events (worktree, dev_server).
  agent_id   TEXT,
  kind       TEXT NOT NULL,
  -- Full EventPayload as JSON, including the duplicated `kind`.
  payload    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events(agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_job_seq   ON events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_kind      ON events(kind, seq);

-- Daily cost rollup for the status bar. Written by whoever records usage.
CREATE TABLE IF NOT EXISTS cost_daily (
  day       TEXT PRIMARY KEY,
  cost_usd  REAL NOT NULL DEFAULT 0
);
