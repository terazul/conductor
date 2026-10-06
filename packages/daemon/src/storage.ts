/**
 * Where Conductor keeps what it keeps.  W0. (Amendment 46)
 *
 * One folder in the home directory, `~/.conductor/` (`CONDUCTOR_DATA` moves it): the
 * database and `settings.json`. Job worktrees are code, not settings, and stay beside
 * each repo in `<repo>/.conductor/wt`.
 *
 * NOTHING IS WRITTEN UNDER HOME UNTIL THE USER SAYS SO. The daemon starts before any
 * page is open, so it can't ask in person; instead, until the folder exists, it runs a
 * setup server that answers only the question (index.ts), and the page asks. "Yes"
 * creates the folder. "No" runs the whole daemon in memory — nothing saved, the page
 * says so — and is itself not saved anywhere, so the next start asks again.
 *
 * `CONDUCTOR_DB` overrides all of this, for tests and for anyone who wants the database
 * somewhere else; then there is no question, and settings last as long as the process.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync as Sqlite } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageMode, StorageState } from '@conductor/shared';

export type { StorageMode, StorageState };

/** Where the database was kept before Amendment 46. `CONDUCTOR_LEGACY_DB` is for verify. */
const LEGACY_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'conductor.db');
const legacyDb = (): string => process.env['CONDUCTOR_LEGACY_DB'] || LEGACY_DEFAULT;

/**
 * `CONDUCTOR_DATA`, not `CONDUCTOR_HOME`. The dock launcher exports `CONDUCTOR_HOME` as
 * the CHECKOUT (scripts/dock.sh, scripts/launch.sh), and reading it here made a dock
 * launch keep its data in the checkout — a fresh, empty database, so no projects
 * (Amendment 61). This one name is the data folder's, and nothing else sets it.
 */
export function conductorHome(): string {
  const o = process.env['CONDUCTOR_DATA'];
  return o && o.trim() ? resolve(o.trim()) : join(homedir(), '.conductor');
}

const DB_FILE = 'conductor.db';
const SETTINGS_FILE = 'settings.json';

let mode: StorageMode | null = null;
let savedAt: string | undefined;
let broughtFrom: string | undefined;

/** Counted read-only, so asking never changes the old file. */
function legacyHolds(): { projects: number; agents: number } | undefined {
  if (!existsSync(legacyDb())) return undefined;
  try {
    const db = new Sqlite(legacyDb(), { readOnly: true });
    try {
      const n = (t: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      return { projects: n('projects'), agents: n('agents') };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * How this start was decided: the override, a folder that exists, or not yet. The
 * folder is the consent — `allowHome` is the only thing that creates it — so a start
 * that finds it doesn't ask again.
 */
export function decideAtBoot(): StorageMode {
  if (process.env['CONDUCTOR_DB']) mode = 'override';
  else if (existsSync(conductorHome())) mode = 'home';
  else mode = 'undecided';
  return mode;
}

export function storageMode(): StorageMode {
  return mode ?? decideAtBoot();
}

export function storageNow(): StorageState {
  const m = storageMode();
  const dir = conductorHome();
  const override = process.env['CONDUCTOR_DB'];
  const db =
    m === 'override' && override
      ? override === ':memory:'
        ? override
        : resolve(override)
      : m === 'home'
        ? join(dir, DB_FILE)
        : ':memory:';
  return {
    mode: m,
    dir,
    saved: m === 'home' || (m === 'override' && db !== ':memory:'),
    db,
    settings: m === 'home' ? join(dir, SETTINGS_FILE) : null,
    ...(savedAt ? { savedAt } : {}),
    ...(m !== 'override' && existsSync(legacyDb()) ? { legacy: legacyDb() } : {}),
    ...(m === 'undecided' ? (() => { const h = legacyHolds(); return h ? { legacyHolds: h } : {}; })() : {}),
    ...(broughtFrom ? { broughtFrom } : {}),
  };
}

/**
 * The user said yes. Creates the folder — and only now.
 *
 * With `bring`, the old database comes too (Amendment 53): copied, opened read-only, with
 * `VACUUM INTO`, which reads what its write-ahead log holds as well, so nothing written
 * last is left behind. The old file is not changed. Never over a database already there.
 */
export function allowHome(bring = false): StorageState {
  if (storageMode() !== 'undecided') throw new Error(`storage is already decided: ${storageMode()}`);
  const dir = conductorHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, DB_FILE);
  if (bring && existsSync(legacyDb()) && !existsSync(file)) {
    const old = new Sqlite(legacyDb(), { readOnly: true });
    try {
      old.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    } finally {
      old.close();
    }
    broughtFrom = legacyDb();
  }
  mode = 'home';
  return storageNow();
}

/** The user said no. Remembered by nothing: the next start asks again. */
export function declineHome(): StorageState {
  if (storageMode() !== 'undecided') throw new Error(`storage is already decided: ${storageMode()}`);
  mode = 'memory';
  return storageNow();
}

/**
 * A memory session, changed its mind: copy what is in memory to `~/.conductor/` so the
 * next start opens it. This process keeps running on memory — its database handle is
 * held by every part of the daemon — so the page says to restart.
 *
 * Refuses when the folder already holds a database: that one is somebody's history.
 */
export function saveMemoryHome(db: DatabaseSync): StorageState {
  if (storageMode() !== 'memory') throw new Error('only an in-memory session can be saved home');
  const dir = conductorHome();
  const file = join(dir, DB_FILE);
  if (existsSync(file)) throw new Error(`${file} already exists — Conductor won't overwrite it`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  savedAt = new Date().toISOString();
  return storageNow();
}

/** For verify: forget the decision, as a fresh process would. */
export function resetStorageForTest(): void {
  mode = null;
  savedAt = undefined;
  broughtFrom = undefined;
}

/** For verify: where the old database is looked for. */
export function legacyDbPath(): string {
  return legacyDb();
}
