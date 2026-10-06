-- 100_persona — Track A. What an agent's persona gave it at launch (Amendment 68).
--
-- persona:       the persona's id, for the record; NULL when the agent had none.
-- system_prompt: appended to Claude Code's own system prompt on every run, resumes too.
-- skills:        a JSON array of skill names to preload; NULL for Claude Code's defaults.
-- Copied in at launch, not looked up by id: a running or sleeping agent keeps what it
-- launched with when the persona is later edited or deleted.
ALTER TABLE agents ADD COLUMN persona TEXT;
ALTER TABLE agents ADD COLUMN system_prompt TEXT;
ALTER TABLE agents ADD COLUMN skills TEXT;
