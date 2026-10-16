/**
 * `make backup` and `make restore` (Amendment 176). Thin: the work is in backup.ts, where
 * verify-backup.ts tests it. The database is the daemon's own, as storage.ts decides it.
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/db/backup-cli.ts backup|restore
 */

import { backupNow, backupsDir, restoreLatest } from './backup.js';
import { dbPath } from './index.js';

const file = dbPath();
const verb = process.argv[2];

try {
  if (verb === 'backup') {
    const made = backupNow(file);
    console.log(made ? `backed up ${file} → ${made}` : `nothing to back up: ${file === ':memory:' ? 'no ~/.conductor/ yet' : `no ${file}`}`);
  } else if (verb === 'restore') {
    const { from, aside } = await restoreLatest(file);
    console.log(`restored ${file} from ${from}`);
    if (aside) console.log(`the database it replaced is kept as ${aside} — copy it back to undo`);
  } else {
    console.error(`usage: backup-cli.ts backup|restore   (backups in ${backupsDir(file)})`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`${verb}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
