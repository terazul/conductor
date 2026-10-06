/**
 * SQLite bootstrap + migration runner.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks A–E.
 *
 * WHY node:sqlite AND NOT better-sqlite3
 * --------------------------------------
 * better-sqlite3 needs a native build, and pnpm 10 blocks postinstall scripts
 * by default. On this machine the binding refused to build even after approval.
 * Five agents each running `pnpm install` in their own worktree means five
 * chances for that to fail, so the native dependency is gone: node:sqlite ships
 * with Node 22 and needs no toolchain at all.
 *
 * Two consequences to know about:
 *  • It's experimental in Node 22, so it emits an ExperimentalWarning. The
 *    daemon's start script silences that one warning; nothing else.
 *  • There is no `.transaction()` helper — use `tx(db, fn)` below.
 *  • Rows come back with a null prototype. Fine for JSON.stringify and property
 *    access; do NOT call Object.hasOwnProperty-style methods on them directly.
 *
 * MIGRATION CONVENTION — the thing that keeps five parallel agents from
 * fighting over the schema:
 *  • one numbered .sql file per track, in src/db/migrations/
 *  • APPEND-ONLY. Never edit a file that has already been applied.
 *  • your track's number: A=010, D=020, C=030.
 * Files apply in filename order and are recorded, so re-running is safe.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageNow } from '../storage.js';

export type Db = DatabaseSync;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

let handle: Db | null = null;

/**
 * Where the database is: `~/.conductor/conductor.db` once the user has allowed that
 * folder, `:memory:` until then or if they said no, or `CONDUCTOR_DB` made absolute.
 * storage.ts decides (Amendment 46).
 *
 * It was `packages/daemon/conductor.db`, inside the checkout, and before that the bare
 * `'conductor.db'` relative to wherever the daemon started — which silently created a
 * fresh, empty one from any other directory. The path never depends on the working
 * directory, and the startup line names the file actually opened.
 */
export function dbPath(): string {
  return storageNow().db;
}

/** Opens (and migrates) the database. Idempotent — safe to call from anywhere. */
export function openDb(file = dbPath()): Db {
  if (handle) return handle;
  const db = new DatabaseSync(file);
  // Said out loud, once: the first question when data looks missing is which file.
  console.log(`[db] ${file}`);
  applyPragmas(db);
  migrate(db);
  handle = db;
  return db;
}

/** For tests and the Track A spike. */
export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function applyPragmas(db: Db): void {
  // WAL so the watcher can read while the session engine writes.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

/** Run `fn` in a transaction. Replaces better-sqlite3's db.transaction(). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * Row coercion. node:sqlite types results as Record<string, SQLOutputValue>,
 * which won't cast straight to a row interface. These are the shared idiom —
 * use them everywhere instead of scattering `as unknown as`.
 *
 *   const list = rows<EventRow>(stmt.all(seq, limit));
 *   const hit  = row<{ n: number }>(stmt.get(seq));
 */
export function rows<T>(result: unknown): T[] {
  return result as T[];
}

export function row<T>(result: unknown): T | undefined {
  return (result ?? undefined) as T | undefined;
}

/** SQLite accepts only these as bound parameters. */
export type SqlParam = null | number | bigint | string | Uint8Array;

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<string>(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numeric prefixes make lexical order the right order

  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // One transaction per migration: a half-applied schema is worse than none.
    tx(db, () => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });
    console.log(`[db] applied ${file}`);
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
