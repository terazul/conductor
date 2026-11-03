-- ─────────────────────────────────────────────────────────────────────────────
-- 330_reply_seq — the agent's latest reply, by its event's seq (Amendment 193).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A reply is what the agent wrote after its last tool call or ask, once its run has ended: the
-- same rule as the transcript's `splitTurn` (web agent/transcript.tsx), so this seq is the key a
-- person ticks the reply read by. Set when a run settles (`markReply`, session/store.ts), and only
-- when that run ended on prose; a run that ended on a tool or an ask leaves it where it was.
--
-- Why a column, and not read from the log: after a reload the web holds events only for the agents
-- you opened, and the navigator and the Agent tabs say "to read" for every agent. They read this.
--
-- NULL means no reply yet, which is every agent that was there before. No backfill: the replies
-- from before this count as read anyway (the web's `sinceSeq`), so there is nothing to find.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agents ADD COLUMN reply_seq INTEGER;
