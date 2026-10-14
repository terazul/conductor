-- ─────────────────────────────────────────────────────────────────────────────
-- 240_spend_totals — Track A. What each project spent, today and over its whole life (Amendment 146).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- An agent's budget is per day (Amendment 129, `agent_spend_daily`), and its lifetime figure is
-- `agents.cost_usd`. Both go when the agent goes, so a project's spend read from its agents fell
-- each time one was removed (web `fleet/project.tsx` summed the current agents' `costUsd`). This
-- table keeps it: one row per project and local day, grown by the same deltas and in the same
-- transaction as `agent_spend_daily` (`addSpendToday`, session/store.ts). Dollars for an engine
-- that reports them (Claude), input plus output tokens for one that doesn't (Copilot, OpenRouter).
--
-- No foreign key, to `agents` or to `projects`: removing an agent, a job or a project's agents
-- refunds nothing, as `cost_daily` keeps the fleet's money. A forgotten project's rows stay and are
-- not read (`projectSpend` reads only the projects there are). The fleet's all-time total is
-- SUM(cost_daily.cost_usd), which already outlives every removal.
--
-- THE BACKFILL, once, here:
--   • every dated row already in `agent_spend_daily` (today's, and the days before it that 210 has
--     kept), summed per project and day, so today's figure and the days since 210 start right;
--   • one row per project on day '0000-00-00', "before": what the project's agents spent over
--     their lives (SUM(agents.cost_usd), and for the token engines SUM(input + output tokens),
--     which are lifetime figures there) less what the dated rows already hold. Never negative.
--     A row in the same table rather than a separate base table, so a project's total is one SUM
--     over its rows and today is `day = localDay()`, which '0000-00-00' never is.
--   What agents removed before this migration spent cannot be recovered for their project; the
--   fleet's total has it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_spend_daily (
  project_id TEXT    NOT NULL,
  day        TEXT    NOT NULL,                 -- the daemon's local day, 'YYYY-MM-DD'; '0000-00-00' is before
  cost_usd   REAL    NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);

INSERT INTO project_spend_daily (project_id, day, cost_usd, tokens)
SELECT a.project_id, s.day, SUM(s.cost_usd), SUM(s.tokens)
  FROM agent_spend_daily s JOIN agents a ON a.id = s.agent_id
 GROUP BY a.project_id, s.day;

INSERT INTO project_spend_daily (project_id, day, cost_usd, tokens)
SELECT life.project_id, '0000-00-00',
       MAX(0, life.usd - COALESCE(dated.usd, 0)),
       MAX(0, life.tokens - COALESCE(dated.tokens, 0))
  FROM (SELECT project_id,
               SUM(cost_usd) AS usd,
               SUM(CASE WHEN provider <> 'claude' THEN input_tokens + output_tokens ELSE 0 END) AS tokens
          FROM agents GROUP BY project_id) life
  LEFT JOIN (SELECT project_id, SUM(cost_usd) AS usd, SUM(tokens) AS tokens
               FROM project_spend_daily GROUP BY project_id) dated
    ON dated.project_id = life.project_id
 WHERE life.usd - COALESCE(dated.usd, 0) > 0 OR life.tokens - COALESCE(dated.tokens, 0) > 0;
