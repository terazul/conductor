-- 120_went_without — Track A. What an agent was started without (Amendment 88).
--
-- An agent waiting on one that was stopped is paused; resuming it drops the stopped one
-- from depends_on and runs without it. The handoff still says what that agent wrote last,
-- marked stopped, so it is kept here: JSON [{ "id": "...", "role": "..." }], or NULL.
-- Off the wire, like the persona: only the first prompt reads it.
ALTER TABLE agents ADD COLUMN went_without TEXT;
