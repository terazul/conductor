-- ─────────────────────────────────────────────────────────────────────────────
-- 300_agent_name — an agent's own name, as you typed it (Amendment 184).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- What the navigator and the Agent tabs call it, set with PATCH /api/agents/:id. NULL means
-- none, which is every agent that was there before: they read as their role, numbered when a
-- project has two of it ("developer 2"). Only a label: `role` is still what the agent is, what
-- its lane is named and what its rules are read by.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agents ADD COLUMN name TEXT;
