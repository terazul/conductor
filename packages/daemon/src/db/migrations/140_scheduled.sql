-- 140_scheduled — Track A. Messages sent to an agent at a time you choose (Amendment 111).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A row waits until `at` (ISO), and is deleted once the message is sent: from then on the
-- agent's transcript has it. `error` is set when it was due and could not be sent (the agent
-- had reached its budget, say); such a row is not tried again, and stays until you remove it,
-- so the failure is seen. Removing the agent removes its messages.
CREATE TABLE scheduled_messages (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  error       TEXT
);
CREATE INDEX scheduled_messages_at ON scheduled_messages (at);
