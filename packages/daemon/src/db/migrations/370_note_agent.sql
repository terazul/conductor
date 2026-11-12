-- ─────────────────────────────────────────────────────────────────────────────
-- 370_note_agent — a note says which agent's screen it was typed on (Amendment 214).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A note is still the project's: these only say where it was written. `agent_id` is the agent
-- whose inspector the note was added from, and `agent_label` that agent's role as it read then
-- (`developer`), so the tag still reads once the agent is removed. No foreign key: a note
-- outlives its agent. Both NULL means no agent, which is every note from before this and every
-- note added from a Fleet card or the Project screen. PATCH never changes either.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE project_notes ADD COLUMN agent_id TEXT;
ALTER TABLE project_notes ADD COLUMN agent_label TEXT;
