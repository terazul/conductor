-- 130_handoff — Track A. An agent hands off only by saying so (Amendment 104).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `handoff_summary` is what the agent said to the agents after it with its `hand_off` tool
-- (or what a person sent for it, edited, from Needs You): the next agents are told it before
-- the conversation. NULL until it hands off, and again once the agent works after finishing,
-- so a summary always belongs to the agent's last run. Off the wire, like the persona: only
-- a prompt reads it.
--
-- `handoff_held` is 1 while the agent has ended its turn WITHOUT handing off, with agents
-- waiting. It stays `done`, and the agents after it stay queued; the alert in Needs You is
-- derived from this column, so a daemon restart keeps the hold.
ALTER TABLE agents ADD COLUMN handoff_summary TEXT;
ALTER TABLE agents ADD COLUMN handoff_held INTEGER NOT NULL DEFAULT 0;
