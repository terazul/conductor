/**
 * Backups of the database, made on their own, and the restore of the latest.  (Amendment 176)
 *
 * One on every daemon start, before migrations run, and one every 6 h after; the last 10 are
 * kept, in `backups/` beside the database (`~/.conductor/backups/`). Each is `VACUUM INTO` from a
 * connection of its own, which is a consistent copy while the daemon writes — what its
 * write-ahead log holds included — and never changes the database.
 *
 * THEIR NAMES ARE THE RULE. `conductor-auto-YYYYMMDD-HHMMSS.db`, the daemon's local time, so the
 * latest is the last by name and pruning sorts names. Only names of that shape are ever pruned or
 * restored: copies made by hand in the same folder (`conductor.db.20261010-221815`) and the
 * `conductor-before-restore-…` a restore sets aside are never touched.
 *
 * Restore runs with the daemon stopped (`make restore`, backup-cli.ts): it sets the current
 * database aside, with its log, then copies the latest backup in its place.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT } from '@conductor/shared';

export const BACKUP_EVERY_MS = 6 * 60 * 60 * 1000;
export const BACKUPS_KEPT = 10;

const AUTO = /^conductor-auto-\d{8}-\d{6}\.db$/;
/** A copy cut short by a crash: never looks like a backup, and the next one clears it. */
const PARTIAL = /^\.conductor-auto-\d{8}-\d{6}\.db\.partial$/;

/** `20261016-140501`, local time like the app's days (`localDay`). */
function stamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Beside the database, so a test's database in tmpdir never touches `~/.conductor/`. */
export function backupsDir(file: string): string {
  return join(dirname(file), 'backups');
}

/** The automatic backups, oldest first. */
export function listBackups(file: string): string[] {
  const dir = backupsDir(file);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => AUTO.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Takes one backup of `file` and prunes to `keep`. Returns its path, or null when there is
 * nothing to back up: an in-memory database, or one not created yet. Throws on failure, and
 * leaves no file that looks like a backup.
 */
export function backupNow(file: string, opts: { now?: Date; keep?: number } = {}): string | null {
  if (file === ':memory:' || !existsSync(file)) return null;
  const dir = backupsDir(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `conductor-auto-${stamp(opts.now ?? new Date())}.db`;
  const target = join(dir, name);
  // VACUUM INTO refuses a target that exists, and a crash mid-copy must not leave a half file
  // under a backup's name: so a temp name, renamed once whole. Twice in a second, the later wins.
  const partial = join(dir, `.${name}.partial`);
  rmSync(partial, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    db.close();
  }
  renameSync(partial, target);
  pruneBackups(file, opts.keep ?? BACKUPS_KEPT);
  return target;
}

/** Keeps the last `keep` automatic backups, and clears stale partial copies. Nothing else. */
export function pruneBackups(file: string, keep = BACKUPS_KEPT): string[] {
  const all = listBackups(file);
  const gone = all.slice(0, Math.max(0, all.length - keep));
  for (const f of gone) rmSync(f, { force: true });
  const dir = backupsDir(file);
  for (const f of readdirSync(dir)) if (PARTIAL.test(f)) rmSync(join(dir, f), { force: true });
  return gone;
}

/**
 * One now, then every `every` ms. A failed backup is logged and the daemon carries on. The
 * timer is unref'd, so it never holds the process open; the returned function stops it.
 */
export function startBackups(
  file: string,
  opts: { every?: number; log?: (line: string) => void } = {},
): () => void {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (file === ':memory:') return () => {};
  const once = (): void => {
    try {
      const made = backupNow(file);
      if (made) log(`[backup] ${made}`);
    } catch (err) {
      log(`[backup] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  once();
  const timer = setInterval(once, opts.every ?? BACKUP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Why restore must not run now, or null. A daemon answering health on its port, or any process
 * holding the database open (lsof, where there is one): a daemon from another checkout on
 * another port holds the file too.
 */
export async function daemonRunning(file: string): Promise<string | null> {
  const port = Number(process.env['CONDUCTOR_PORT'] ?? DEFAULT_PORT);
  try {
    // Any answer at all: the setup server answers health too (Amendment 46).
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return `a daemon answers on port ${port}`;
  } catch {
    /* nothing listening */
  }
  try {
    const pids = execFileSync('lsof', ['-t', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (pids) return `${file} is open in process ${pids.split('\n').join(', ')}`;
  } catch {
    /* lsof exits 1 when nobody has it open, or isn't installed */
  }
  return null;
}

export interface Restored {
  from: string;
  /** Where the database it replaced was set aside, if there was one. */
  aside: string | null;
}

/**
 * Puts the latest automatic backup in place of `file`. Refuses while the daemon runs, when there
 * is no backup, and when the backup fails `integrity_check`. The database it replaces is set aside
 * first, with its `-wal` and `-shm`, as `backups/conductor-before-restore-<stamp>.db`, so a restore
 * is undone by copying that back; it is never pruned.
 */
export async function restoreLatest(
  file: string,
  opts: { running?: (file: string) => Promise<string | null>; now?: Date } = {},
): Promise<Restored> {
  if (file === ':memory:') throw new Error('the database is in memory: there is nothing to restore into');
  const running = await (opts.running ?? daemonRunning)(file);
  if (running) throw new Error(`the daemon is running (${running}) — make stop first`);
  const from = listBackups(file).at(-1);
  if (!from) throw new Error(`no automatic backup in ${backupsDir(file)}`);

  const check = new DatabaseSync(from, { readOnly: true });
  let verdict: string;
  try {
    verdict = String((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
  } finally {
    check.close();
  }
  if (verdict !== 'ok') throw new Error(`${from} fails integrity_check (${verdict}) — left as it is`);

  let aside: string | null = null;
  if (existsSync(file)) {
    aside = join(backupsDir(file), `conductor-before-restore-${stamp(opts.now ?? new Date())}.db`);
    renameSync(file, aside);
    // Its log goes with it, under the names SQLite looks for, so the aside copy opens whole.
    for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, aside + ext);
  }
  for (const ext of ['-wal', '-shm']) rmSync(file + ext, { force: true });
  const partial = `${file}.restoring`;
  copyFileSync(from, partial);
  renameSync(partial, file);
  return { from, aside };
}
