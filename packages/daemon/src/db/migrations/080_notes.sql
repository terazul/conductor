-- 080_notes — Track A. Notes you keep on a project, to track where you are (Amendment 55).
--
-- Yours, not an agent's: nothing but the notes routes writes here. Removing the project
-- forgets its notes with it, like every other row that is only about the project.
CREATE TABLE IF NOT EXISTS project_notes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes(project_id);
