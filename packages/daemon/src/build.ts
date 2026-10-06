/**
 * What is running — the commit, when it was made, and when the daemon started.  W0.
 * (Amendment 38)
 *
 * Conductor runs from source (`tsx`, `vite dev`), so there is no build step to stamp.
 * The nearest thing is the checkout the daemon was started from, read once at boot.
 * The daemon does not reload itself, so after a pull or a commit it keeps running the
 * code it started with, and `behind` says so: HEAD is read again on every request and
 * compared. That is the question this answers — "is what I'm looking at the code I
 * just changed?" — and the answer is `make restart`.
 *
 * git is asked with `-C` this file's folder, never the process cwd: the daemon's cwd
 * is packages/daemon today, but nothing here should depend on that. No git, or not a
 * checkout, gives nulls rather than a failed boot.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface BuildInfo {
  /** package.json `version` of the repo root. */
  version: string;
  /** Short hash of HEAD when the daemon started; null outside a checkout. */
  commit: string | null;
  branch: string | null;
  /** When that commit was made (committer date, ISO 8601). */
  committedAt: string | null;
  /** Uncommitted changes to tracked files at start — the commit alone is not the code. */
  dirty: boolean;
  /** When this daemon process started (ISO 8601). */
  startedAt: string;
  node: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', HERE, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim();
  } catch {
    return null;
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '../../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** HEAD's short hash now. Cheap enough to ask per request. */
export function headCommit(): string | null {
  return git(['rev-parse', '--short', 'HEAD']) || null;
}

function read(): BuildInfo {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    version: version(),
    commit: headCommit(),
    // A detached HEAD reports the literal word "HEAD", which is not a branch.
    branch: branch && branch !== 'HEAD' ? branch : null,
    committedAt: git(['log', '-1', '--format=%cI']) || null,
    // --untracked-files=no: a stray scratch file is not a change to what runs.
    dirty: (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
    startedAt: new Date().toISOString(),
    node: process.version,
  };
}

/** Read once, at import — which is boot. */
export const BUILD: BuildInfo = read();

/** The boot-time record, plus whether HEAD has moved since. */
export function buildNow(): BuildInfo & { head: string | null; behind: boolean } {
  const head = headCommit();
  return { ...BUILD, head, behind: head !== null && BUILD.commit !== null && head !== BUILD.commit };
}
