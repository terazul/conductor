-- ─────────────────────────────────────────────────────────────────────────────
-- 340_agent_resume_at — when a paused agent wakes by itself (Amendment 205).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- ⏸ pause can be given a time: "until 14:05", "for an hour", "tomorrow 09:00". This is that time,
-- as an ISO instant, the same form `scheduled_messages.send_at` keeps. The scheduler's tick
-- (session/schedule.ts) resumes a paused agent once it has passed, as ▶ resume would, and clears it.
--
-- Only a pause of yours has one. A pause for the fleet hold or a model that can't be reached is
-- woken by what paused it, and never carries one. Anything but `paused` clears it (setAgentStatus,
-- session/store.ts), so ▶ resume, stop, delete or a run ending can't leave one behind.
--
-- NULL means no time: until you resume it, which is every agent that was there before.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agents ADD COLUMN resume_at TEXT;
