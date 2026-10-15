-- ─────────────────────────────────────────────────────────────────────────────
-- 270_model_windows — Track A. The context windows the engines reported outlive a restart (Amendment 161).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- session/windows.ts keeps each model's window, by provider and exact id, for the hand-off cap
-- (Amendment 120). It was in memory only, so after a restart a resumed stack used the floor table
-- until a model list was asked for again. This table holds the same thing: `initWindows` loads it
-- at startup, and each window that changes is written here as it is kept (an upsert; one that is
-- the same as before is not written again).
--
-- `source` says where the window came from:
--   • 'list' — a model list (OpenRouter's `context_length`, Copilot's `max_context_window_tokens`,
--              the gateway's `max_input_tokens`);
--   • 'run'  — a Claude result's `modelUsage[model].contextWindow`, the window that run had. A list
--              never overwrites a 'run' row; a run overwrites either.
--
-- No foreign key: a window belongs to a model, not to an agent, project or job, and removing them
-- leaves it. Nothing is backfilled: there was nothing kept before this.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_windows (
  provider   TEXT    NOT NULL,
  model      TEXT    NOT NULL,                 -- the exact id, or the alias an agent was launched on
  tokens     INTEGER NOT NULL CHECK (tokens >= 1),
  source     TEXT    NOT NULL CHECK (source IN ('list', 'run')),
  updated_at TEXT    NOT NULL,                 -- ISO time it last changed
  PRIMARY KEY (provider, model)
);
