-- ─────────────────────────────────────────────────────────────────────────────
-- 210_spend_daily — Track A. An agent's budget counts what was spent TODAY (Amendment 129).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A budget was a lifetime cap on `agents.cost_usd` and `agents.input_tokens + output_tokens`
-- (Amendments 77, 124). It is now per day, and goes back to zero at local midnight. The agent
-- row cannot say what it spent today: `cost_usd` is the whole life, and for Claude the token
-- columns hold only the last run's main loop. So the day's figure is kept here, one row per
-- agent and local day (`localDay`, the day `cost_daily` and the status bar use), and grows by
-- DELTAS as usage arrives, as `cost_daily` does for the machine's day total:
--   • Claude: by the growth of the lifetime dollar cost. A resumed run adds only the difference.
--   • Copilot and OpenRouter: by the input plus output tokens each model call adds.
-- `agents.cost_usd` stays the lifetime figure and is still shown, as information.
--
-- Goes with its agent (ON DELETE CASCADE), unlike `cost_daily` and `metrics_daily`: a removed
-- agent has no budget left to read. The machine's day total keeps the money it spent.
--
-- Agents that existed before this have no rows, so their budgets read 0 today: a cap they had
-- reached is renewed on first start. The first day's figure is then counted from there.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_spend_daily (
  agent_id TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,                 -- the daemon's local day, 'YYYY-MM-DD'
  cost_usd REAL    NOT NULL DEFAULT 0,       -- dollars, for an engine that reports them
  tokens   INTEGER NOT NULL DEFAULT 0,       -- input plus output, for one that doesn't
  PRIMARY KEY (agent_id, day)
);

-- "Who spent anything on this day": the day change pushes those agents afresh.
CREATE INDEX IF NOT EXISTS agent_spend_daily_day ON agent_spend_daily (day);
