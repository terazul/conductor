-- 090_note_due — Track A. A note can be due, and done (Amendment 63).
--
-- due:     a local calendar date, YYYY-MM-DD, or NULL for no date. A date, not a time:
--          "due today" means today where you are, as the daily budget's day does.
-- done_at: when you ticked it done, or NULL. A done note stays, greyed, and stops nagging.
ALTER TABLE project_notes ADD COLUMN due TEXT;
ALTER TABLE project_notes ADD COLUMN done_at TEXT;
