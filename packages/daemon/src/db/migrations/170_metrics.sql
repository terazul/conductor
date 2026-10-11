-- ─────────────────────────────────────────────────────────────────────────────
-- 170_metrics — Track A. The Metrics tab's own history (Amendment 122).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- Removing a job or an agent deletes its `agents` and `agent_runs` rows, and `agents.model`
-- is overwritten when the model is switched, so neither can answer "which model, how many
-- calls, how long, how often did it fail". `events` stay, but carry no model. So the tab is
-- built from a table of its own keyed by day, engine and model, as `cost_daily` is keyed by
-- day, and incremented as results arrive. Nothing here references `agents`, so removing an
-- agent leaves what it did exactly where it was.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS metrics_daily (
  day                  TEXT    NOT NULL,   -- the daemon's local day, as cost_daily's
  provider             TEXT    NOT NULL,   -- claude | copilot | openrouter
  model                TEXT    NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  -- Dollars, where the engine reports them. Stays 0 for an engine that does not.
  cost_usd             REAL    NOT NULL DEFAULT 0,
  -- Model round-trips: a Claude result's num_turns, one per Copilot/OpenRouter usage event.
  calls                INTEGER NOT NULL DEFAULT 0,
  -- api_retry events: a model call the SDK had to try again.
  retries              INTEGER NOT NULL DEFAULT 0,
  runs                 INTEGER NOT NULL DEFAULT 0,
  -- Runs that ended `failed`. Your own stop, a pause and a budget stop are not errors.
  failed_runs          INTEGER NOT NULL DEFAULT 0,
  -- Wall time of the runs counted in `runs`.
  run_ms               INTEGER NOT NULL DEFAULT 0,
  -- Time the engine spent in model calls, and the calls and output tokens that time covers,
  -- so a per-call time and a tokens-per-second figure divide like by like.
  api_ms               INTEGER NOT NULL DEFAULT 0,
  timed_calls          INTEGER NOT NULL DEFAULT 0,
  timed_output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);

-- When recording began. Agents with spend and no row in metrics_agent are older than this.
CREATE TABLE IF NOT EXISTS metrics_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT OR IGNORE INTO metrics_meta (k, v) VALUES ('since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- What an agent had already spent when metrics first saw it: the "before metrics were
-- recorded" line, which can only come from the agent rows. Goes with the agent.
CREATE TABLE IF NOT EXISTS metrics_agent (
  agent_id          TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  pre_cost_usd      REAL    NOT NULL DEFAULT 0,
  pre_input_tokens  INTEGER NOT NULL DEFAULT 0,
  pre_output_tokens INTEGER NOT NULL DEFAULT 0,
  -- 0: the SDK's running totals include earlier runs this table never saw, so the next
  -- result only sets the baseline below and counts none of those tokens.
  baselined         INTEGER NOT NULL DEFAULT 1,
  -- The running API time the SDK last reported for the session.
  api_ms            INTEGER NOT NULL DEFAULT 0
);

-- The SDK's result carries each model's CUMULATIVE tokens and cost for the session, and a
-- resumed session continues from its transcript's totals. What a result adds is the
-- difference from the last one, so the last one is kept here, per agent and model.
CREATE TABLE IF NOT EXISTS metrics_baseline (
  agent_id          TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model             TEXT    NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, model)
);
