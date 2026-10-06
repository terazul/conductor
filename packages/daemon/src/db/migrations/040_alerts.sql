-- ─────────────────────────────────────────────────────────────────────────────
-- 040_alerts — Track A. Dismissed alerts (Amendment 28, F13).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- Only the dismissal is stored. The alerts themselves are derived: a failed agent,
-- a budget stop or a dead dev server is an open alert until what it describes
-- changes, so a restart can't lose one. An id names one occurrence (it carries the
-- seq of the event that raised it), so dismissing one failure never hides the next.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_dismissals (
  alert_id      TEXT PRIMARY KEY,
  dismissed_at  TEXT NOT NULL
);
