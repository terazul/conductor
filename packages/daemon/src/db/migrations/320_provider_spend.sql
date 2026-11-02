-- ─────────────────────────────────────────────────────────────────────────────
-- 320_provider_spend — what each engine spent, by day and model (Amendment 188).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A monthly budget can be set for an engine (claude, copilot, openrouter) and, under Claude, for a
-- route (the prefix before `.anthropic.`, `claudeRoute` in @conductor/shared). This table is what
-- those months are read from (store.ts `providerSpend`). Dollars for Claude, input plus output
-- tokens for Copilot and OpenRouter, as `agent_spend_daily` counts them.
--
-- Why not `metrics_daily` (170), which is keyed by day, engine and model already: it grows by each
-- result's per-model figures against a baseline of its own (session/metrics.ts), not by the deltas
-- the status bar's `cost_daily` grows by, and the two disagree (Metrics said $5.80 for a month the
-- status bar called $4.27). An engine's months have to add up to the fleet's month (`costMonth`),
-- so this table grows by the SAME deltas, in the SAME transaction, as `agent_spend_daily` and
-- `project_spend_daily` (`addSpendToday`).
--
-- The model is stored, not the route, so a route's rule can change without rewriting a row. The
-- model is the one the run was started with (the runner's scope). No foreign key: removing an agent
-- refunds nothing, as `cost_daily` keeps the fleet's money.
--
-- THE BACKFILL, once, here: every row in `agent_spend_daily`, summed per day, engine and the agent's
-- model (`agents.provider`, NULL read as claude). Two things it cannot know:
--   • what agents removed before this migration spent (their `agent_spend_daily` rows went with
--     them), so an engine's month this month may be short of the fleet's by that much;
--   • which model an agent ran on before its model was changed: those days count under the model it
--     has now.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS provider_spend_daily (
  day      TEXT    NOT NULL,                 -- the daemon's local day, 'YYYY-MM-DD'
  provider TEXT    NOT NULL,                 -- claude | copilot | openrouter
  model    TEXT    NOT NULL,
  cost_usd REAL    NOT NULL DEFAULT 0,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);

INSERT INTO provider_spend_daily (day, provider, model, cost_usd, tokens)
SELECT s.day, COALESCE(a.provider, 'claude'), a.model, SUM(s.cost_usd), SUM(s.tokens)
  FROM agent_spend_daily s JOIN agents a ON a.id = s.agent_id
 GROUP BY s.day, COALESCE(a.provider, 'claude'), a.model;
