/**
 * Validator checks for Amendment 176: the database is backed up on its own, the last 10 are
 * kept, and the latest comes back with the daemon stopped.
 *
 * Everything in a tmpdir: a database written by another process while it is backed up, real
 * files for pruning, and a restore whose "is the daemon running" is a stand-in. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/db/verify-backup.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BACKUPS_KEPT,
  backupNow,
  backupsDir,
  listBackups,
  restoreLatest,
  startBackups,
} from './backup.js';

const ROOT = join(realpathSync(tmpdir()), `conductor-backup-verify-${Date.now()}`);

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const count = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n);
  } finally {
    db.close();
  }
};
const integrity = (file: string): string => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return String((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
  } finally {
    db.close();
  }
};
const at = (n: number): Date => new Date(2026, 9, 16, 9, 0, n);

/** Another process, writing rows in small transactions until it is killed. */
function writer(file: string): { stop: () => Promise<void>; started: Promise<void> } {
  const src = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    const ins = db.prepare('INSERT INTO t (x) VALUES (?)');
    let i = 0;
    for (;;) {
      db.exec('BEGIN');
      for (let k = 0; k < 50; k++) ins.run('row ' + i++ + ' ' + 'x'.repeat(200));
      db.exec('COMMIT');
      if (i === 50) process.stdout.write('go\\n');
    }`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  const started = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  return { stop, started };
}

/** Runs `sql` in another process, which is killed with its connection still open. */
function killedAfter(file: string, sql: string): Promise<void> {
  const src = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec(${JSON.stringify(sql)});
    process.stdout.write('go\\n');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) =>
    child.stdout.once('data', () => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    }),
  );
}

async function main(): Promise<void> {
  mkdirSync(ROOT, { recursive: true });

  console.log('\n— a backup while another process writes —');
  const home = join(ROOT, 'live');
  mkdirSync(home);
  const file = join(home, 'conductor.db');
  const setup = new DatabaseSync(file);
  setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT); INSERT INTO t (x) VALUES ('first')");
  const w = writer(file);
  await w.started;
  const made: string[] = [];
  for (let n = 0; n < 3; n++) {
    made.push(backupNow(file, { now: at(n) })!);
    await new Promise((r) => setTimeout(r, 50));
  }
  await w.stop();
  // Held open with a transaction not yet committed: a backup has what is committed, only.
  setup.exec("BEGIN; INSERT INTO t (x) VALUES ('uncommitted')");
  const midTx = backupNow(file, { now: at(3) })!;
  setup.exec('ROLLBACK');
  setup.close();
  check('backups go in backups/ beside the database', made.every((f) => f.startsWith(backupsDir(file) + '/')) && backupsDir(file) === join(home, 'backups'), made.join(' '));
  check('named conductor-auto-YYYYMMDD-HHMMSS.db, local time', basename(made[0]!) === 'conductor-auto-20261016-090000.db', basename(made[0]!));
  check('each opens and passes integrity_check', made.every((f) => integrity(f) === 'ok'), made.map(integrity).join(','));
  const counts = made.map(count);
  check('each has the rows written so far, and later ones more', counts[0]! > 1 && counts[0]! <= counts[1]! && counts[1]! <= counts[2]! && counts[2]! > counts[0]!, counts.join(' ≤ '));
  const peek = new DatabaseSync(midTx, { readOnly: true });
  const uncommitted = peek.prepare("SELECT COUNT(*) AS n FROM t WHERE x = 'uncommitted'").get() as { n: number };
  const first = peek.prepare("SELECT COUNT(*) AS n FROM t WHERE x = 'first'").get() as { n: number };
  peek.close();
  check('what was committed is in it, what was not is not', Number(first.n) === 1 && Number(uncommitted.n) === 0);
  check('no partial copy is left behind', !readdirSync(backupsDir(file)).some((f) => f.endsWith('.partial')));

  console.log('\n— pruning keeps the last 10, and only its own —');
  const prune = join(ROOT, 'prune');
  mkdirSync(join(prune, 'backups'), { recursive: true });
  const pfile = join(prune, 'conductor.db');
  const pdb = new DatabaseSync(pfile);
  pdb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
  pdb.close();
  // Hand-made copies as they are in ~/.conductor/backups/, a restore's set-aside, and a stray
  // partial from a crash.
  const others = [
    'conductor.db.20261010-221815',
    'conductor.db-wal.20261010-221815',
    'conductor.db-shm.20261010-221815',
    'conductor-before-restore-20261001-120000.db',
    'notes.txt',
  ];
  for (const f of others) writeFileSync(join(prune, 'backups', f), 'not a backup');
  writeFileSync(join(prune, 'backups', '.conductor-auto-20261001-000000.db.partial'), 'half');
  for (let n = 0; n < 13; n++) backupNow(pfile, { now: at(n) });
  const kept = listBackups(pfile).map((f) => basename(f));
  check(`exactly ${BACKUPS_KEPT} automatic backups are kept`, kept.length === BACKUPS_KEPT, String(kept.length));
  check('the newest ones', kept[0] === 'conductor-auto-20261016-090003.db' && kept.at(-1) === 'conductor-auto-20261016-090012.db', `${kept[0]} … ${kept.at(-1)}`);
  check('hand-made copies and other files are left alone', others.every((f) => existsSync(join(prune, 'backups', f))));
  check('a stale partial copy is cleared', !existsSync(join(prune, 'backups', '.conductor-auto-20261001-000000.db.partial')));
  backupNow(pfile, { now: at(12) });
  check('twice in a second, the later replaces it', listBackups(pfile).length === BACKUPS_KEPT);

  console.log('\n— nothing to back up —');
  check('an in-memory database makes no backup', backupNow(':memory:') === null);
  const lines: string[] = [];
  startBackups(':memory:', { log: (l) => lines.push(l) })();
  check('and starts no schedule', lines.length === 0);
  const fresh = join(ROOT, 'fresh', 'conductor.db');
  mkdirSync(join(ROOT, 'fresh'));
  check('a database not created yet makes none, and no folder', backupNow(fresh) === null && !existsSync(backupsDir(fresh)));

  console.log('\n— the schedule —');
  const sched = join(ROOT, 'sched');
  mkdirSync(sched);
  const sfile = join(sched, 'conductor.db');
  const sdb = new DatabaseSync(sfile);
  sdb.exec('CREATE TABLE t (x TEXT)');
  sdb.close();
  const slog: string[] = [];
  const stop = startBackups(sfile, { every: 1100, log: (l) => slog.push(l) });
  check('one at once, on start', listBackups(sfile).length === 1 && slog.length === 1 && slog[0]!.startsWith('[backup] '), slog.join(' | '));
  await new Promise((r) => setTimeout(r, 1300));
  stop();
  check('then one each period', listBackups(sfile).length === 2, String(listBackups(sfile).length));
  await new Promise((r) => setTimeout(r, 1300));
  check('and none once stopped', listBackups(sfile).length === 2, String(listBackups(sfile).length));
  const broken = join(ROOT, 'broken', 'conductor.db');
  mkdirSync(join(ROOT, 'broken'));
  writeFileSync(broken, 'this is not a database, it is long enough to have a header '.repeat(10));
  const blog: string[] = [];
  let threw = false;
  try {
    startBackups(broken, { log: (l) => blog.push(l) })();
  } catch {
    threw = true;
  }
  check('a failed backup is logged, never thrown', !threw && blog.length === 1 && blog[0]!.startsWith('[backup] failed:'), blog.join(' | '));
  check('and leaves nothing that looks like a backup', listBackups(broken).length === 0 && !readdirSync(backupsDir(broken)).some((f) => f.endsWith('.partial')));

  console.log('\n— restore —');
  const rhome = join(ROOT, 'restore');
  mkdirSync(rhome);
  const rfile = join(rhome, 'conductor.db');
  const rdb = new DatabaseSync(rfile);
  rdb.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT); INSERT INTO t (x) VALUES ('older')");
  backupNow(rfile, { now: at(0) });
  rdb.exec("INSERT INTO t (x) VALUES ('latest')");
  backupNow(rfile, { now: at(1) });
  rdb.close();
  // Written by a process that is then killed, so these rows are only in the log, as when a
  // daemon dies: the copy set aside must keep them.
  await killedAfter(rfile, "INSERT INTO t (x) VALUES ('since'), ('since')");
  check('(the rows since are only in the log)', existsSync(`${rfile}-wal`));
  const notRunning = async (): Promise<string | null> => null;
  let refused = '';
  try {
    await restoreLatest(rfile, { running: async () => 'a daemon answers on port 7777' });
  } catch (err) {
    refused = String(err);
  }
  check('refuses while the daemon runs, and says so', /daemon is running/.test(refused) && /make stop/.test(refused), refused);
  check('and changes nothing', count(rfile) === 4);
  const { from, aside } = await restoreLatest(rfile, { running: notRunning, now: at(30) });
  check('brings back the latest backup', basename(from) === 'conductor-auto-20261016-090001.db' && count(rfile) === 2, `${basename(from)} → ${count(rfile)} rows`);
  check('which opens whole', integrity(rfile) === 'ok');
  check('the stale -wal and -shm of the one it replaced are gone', !existsSync(`${rfile}-wal`) && !existsSync(`${rfile}-shm`));
  check('the one it replaced is set aside, with what its log held', aside === join(rhome, 'backups', 'conductor-before-restore-20261016-090030.db') && count(aside) === 4, aside ?? 'none');
  check('and is not an automatic backup, so is never pruned or restored', listBackups(rfile).length === 2);
  writeFileSync(listBackups(rfile).at(-1)!, 'garbage '.repeat(100));
  let bad = '';
  try {
    await restoreLatest(rfile, { running: notRunning });
  } catch (err) {
    bad = String(err);
  }
  check('a latest backup that does not open is refused, and nothing changes', bad !== '' && count(rfile) === 2, bad);
  const empty = join(ROOT, 'empty', 'conductor.db');
  mkdirSync(join(ROOT, 'empty'));
  let none = '';
  try {
    await restoreLatest(empty, { running: notRunning });
  } catch (err) {
    none = String(err);
  }
  check('no backup: says where it looked', /no automatic backup in/.test(none), none);
  let mem = '';
  try {
    await restoreLatest(':memory:', { running: notRunning });
  } catch (err) {
    mem = String(err);
  }
  check('in memory: nothing to restore into', /in memory/.test(mem), mem);

  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log('FAIL');
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((err) => {
  console.error(err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
