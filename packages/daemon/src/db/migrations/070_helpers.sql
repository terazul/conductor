-- 070_helpers — Track A. An orchestrator and the helpers it starts (Amendment 51).
--
-- helper_cap: how many helpers this agent may start; 0 for an ordinary agent.
-- parent_id:  the orchestrator that started this one; NULL for an agent Spawn made.
-- No foreign key on parent_id: removing an orchestrator must not cascade its helpers'
-- transcripts away, and agents are removed one by one anyway.
ALTER TABLE agents ADD COLUMN helper_cap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN parent_id TEXT;
-- reported_at: when this helper's final reply was handed to its orchestrator. Kept
-- here, not in memory, so a restart neither drops a report nor sends one twice.
ALTER TABLE agents ADD COLUMN reported_at TEXT;
