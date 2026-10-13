#!/usr/bin/env node
// Is node_modules the install pnpm-lock.yaml asks for? (Amendment 134)
//
// pnpm writes a copy of the lockfile to node_modules/.pnpm/lock.yaml on every install; when the
// install is current the two are byte for byte the same. After a pull that changes the lock they
// differ, and starting anyway ends in Vite's "Failed to resolve import" overlay. `make start` runs
// this first, so it says so instead and starts nothing.
//
//   node scripts/check-install.mjs [--root <dir>]
//
// Current: exits 0 and says nothing. Stale or missing: one sentence on stderr and exit 1, or, with
// CONDUCTOR_AUTO_INSTALL=1, runs `pnpm install --frozen-lockfile --prefer-offline` and exits with
// its code. --root points it at another checkout (the verify uses a temp dir); the default is the
// repo this script is in, whatever the cwd.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STALE_LINE =
  'Dependencies are out of date: run `make install` (or `pnpm install`), then start again.';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..');

/** 'current' when pnpm's copy matches the lock, 'stale' when it differs, 'missing' when there is no install (or no lock). */
export function installState(root = REPO_ROOT) {
  const lock = join(root, 'pnpm-lock.yaml');
  const copy = join(root, 'node_modules', '.pnpm', 'lock.yaml');
  if (!existsSync(lock) || !existsSync(copy)) return 'missing';
  return readFileSync(lock).equals(readFileSync(copy)) ? 'current' : 'stale';
}

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return REPO_ROOT;
  const dir = argv[i + 1];
  if (!dir) {
    process.stderr.write('check-install: --root needs a directory\n');
    process.exit(2);
  }
  return resolve(dir);
}

function main() {
  const root = rootFromArgs(process.argv.slice(2));
  if (installState(root) === 'current') return 0;
  if (process.env.CONDUCTOR_AUTO_INSTALL === '1') {
    const r = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (r.error) {
      process.stderr.write(`check-install: could not run pnpm: ${r.error.message}\n`);
      return 1;
    }
    return r.status ?? 1;
  }
  process.stderr.write(STALE_LINE + '\n');
  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main());
}
