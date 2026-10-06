-- ─────────────────────────────────────────────────────────────────────────────
-- 020_preview — Track D. Dev-server registry + captured browser console.
--
-- TRACK D OWNS THIS FILE. Append-only: never edit it once applied.
--
-- Why these need to be persisted rather than held in memory:
--  • dev_servers — the daemon can restart while an agent's `npm run dev` keeps
--    running. Without a record we lose the port/pid and the Preview screen goes
--    blank even though the server is fine. On boot the registry re-probes every
--    row and resurrects the ones still listening.
--  • console_entries — "send errors to the agent" has to work after a page
--    reload, and the browser is not a durable store. Trimmed to a cap per job.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dev_servers (
  job_id               TEXT NOT NULL,
  port                 INTEGER NOT NULL,
  -- WHICH LOOPBACK FAMILY ANSWERED. A dev server told to listen on `localhost`
  -- binds ONE address, and on macOS `localhost` resolves to both 127.0.0.1 and
  -- ::1 — Vite routinely ends up on [::1] and nothing else. Probing only IPv4
  -- reports "no dev server" for a server that is running fine. So the family
  -- that answered is recorded and the proxy dials that one.
  --
  -- The CHECK is the SSRF boundary expressed in the schema: even a corrupted or
  -- hand-edited database cannot point the proxy off this machine.
  host                 TEXT NOT NULL DEFAULT '127.0.0.1'
                         CHECK (host IN ('127.0.0.1', '::1')),
  -- Discovered from the listening socket (lsof), not from the tool call — the
  -- Bash tool gives us a command, never a pid. NULL when discovery failed.
  pid                  INTEGER,
  -- Which agent's Bash call launched it. NULL for manual registration.
  started_by_agent_id  TEXT,
  project_id           TEXT NOT NULL DEFAULT '',
  -- The command we matched, kept for the UI ("vite · pid 48210") and debugging.
  command              TEXT,
  -- Framework tag parsed out of the command: 'vite', 'next', 'npm', …
  kind                 TEXT,
  detected_at          TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  alive                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (job_id, port)
);

CREATE INDEX IF NOT EXISTS idx_dev_servers_alive ON dev_servers(alive, job_id);

CREATE TABLE IF NOT EXISTS console_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id   TEXT NOT NULL,
  level    TEXT NOT NULL CHECK (level IN ('log','warn','error')),
  text     TEXT NOT NULL,
  at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_console_job ON console_entries(job_id, id);
CREATE INDEX IF NOT EXISTS idx_console_level ON console_entries(job_id, level, id);
