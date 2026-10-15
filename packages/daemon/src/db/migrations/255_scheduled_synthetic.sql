-- 255_scheduled_synthetic — Track A. A message waiting for a slot keeps whether it was ours (Amendment 168).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A 'slot' row (250) is a message sent while every slot was taken, kept until one frees
-- (session/supervisor.ts `pump`). Some of those are Conductor's, not yours: the ask to hand off
-- after a restart (`HANDOFF_ASK`), the page's "continue" (`synthetic: true`). `synthetic` = 1
-- keeps them shown as `auto` when they go, as they would have been sent at once. Every row
-- already here is yours: 0.
ALTER TABLE scheduled_messages ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
