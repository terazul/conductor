-- ─────────────────────────────────────────────────────────────────────────────
-- 010_session — Track A. Human decisions and the rules that come from them.
--
-- APPEND-ONLY. Never edit this file once it has been applied; add 011_*.sql.
--
-- The event log (001_core) stays the source of truth for everything the UI
-- renders. These tables hold the two things an append-only log is bad at:
--   • requests — mutable open/closed state that must survive a daemon restart,
--     so a parked agent can be answered after a `kill -9` (PLAN.md §1 finding B)
--   • session_rules — "allow always", persisted by us rather than only handed to
--     the SDK as `updatedPermissions`, because a PARKED request has no live
--     canUseTool callback to return suggestions from
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  job_id        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('permission','question')),
  -- 'held'   : a canUseTool promise is pending in a live process
  -- 'parked' : PreToolUse returned `defer`; the query ended, this row is all
  --            that is left. Answering it relaunches with options.resume.
  block_mode    TEXT NOT NULL CHECK (block_mode IN ('held','parked')),
  tool_name     TEXT NOT NULL,
  -- SDK tool_use id. Identifies the exact call to re-approve after a resume.
  tool_use_id   TEXT,
  input         TEXT NOT NULL,   -- JSON: the tool input, as the card shows it
  label         TEXT NOT NULL,   -- one-line summary for the queue
  matched_rule  TEXT,            -- permission only
  cwd           TEXT,            -- permission only
  suggestions   TEXT,            -- permission only, JSON PermissionSuggestion[]
  reversible    TEXT,            -- permission only, JSON {value, reason}
  questions     TEXT,            -- question only, JSON Question[]
  created_at    TEXT NOT NULL,
  -- NULL while the request is open. The attention queue is a query on this.
  resolved_at   TEXT,
  decision      TEXT             -- JSON DecisionSummary once answered
);

-- The attention queue: open requests, oldest first.
CREATE INDEX IF NOT EXISTS idx_requests_open  ON requests(resolved_at, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_agent ON requests(agent_id);

-- "Allow always". Scoped to a project so a rule earned in one repo does not
-- silently widen permissions in another.
CREATE TABLE IF NOT EXISTS session_rules (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  -- NULL means "the whole tool", mirroring PermissionRuleValue.ruleContent.
  rule_content TEXT,
  behavior     TEXT NOT NULL DEFAULT 'allow',
  -- Opaque passthrough of the SDK PermissionUpdate that produced this row, so
  -- we can replay it as `updatedPermissions` on a later held request.
  suggestion   TEXT,
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_rules_unique
  ON session_rules(project_id, tool_name, COALESCE(rule_content, ''));

-- Bookkeeping the agents table has no column for and the event log should not
-- carry: which SDK session to resume, and how the last run ended.
CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sdk_session_id TEXT,
  -- 'completed' | 'tool_deferred' | 'aborted_tools' | error subtypes …
  terminal_reason TEXT,
  -- JSON SDKDeferredToolUse when the run ended parked, so the resume knows
  -- exactly which call is waiting on a human.
  deferred_tool  TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at);
