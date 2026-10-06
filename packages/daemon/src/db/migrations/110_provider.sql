-- 110_provider — Track A. Which engine an agent runs on (Amendment 74).
--
-- 'claude' (the Claude Agent SDK, and every agent from before this), 'copilot' or
-- 'openrouter'. Fixed for the agent's life: its stored session id is only valid for the
-- provider that made it, so it is never handed to another.
ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
