/**
 * Change scanning — what is dirty in a worktree, and by how much.
 *
 * TRACK C owns this file.
 *
 * Line counts always come from git, never from a cache. A revert must make a
 * badge disappear, and it can only do that if the number was never stored. The
 * one fact git has no opinion on — *when* the file was last written, and by
 * which agent — comes from the file_edit projection and is merged in here.
 *
 * Untracked files need their own count: `git diff HEAD` has nothing to say about
 * a file it has never seen, but "created, 41 lines" is exactly what the UI wants
 * to show. So they are counted by reading the file, with a size ceiling.
 *
 * The one exception to "always from git" is a workspace with no git in it, which
 * `in_place` isolation permits. There the projection is the record — see
 * `fromProjection`. The revert-clears-the-badge property is weaker there by
 * necessity: with no committed state to return to, "reverted" is not a thing the
 * daemon can observe.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkIgnore, isRepo, numstat, status, toPosix } from './git.js';
import type { FileChangeRecord } from './store.js';

/** Past this a file is not something a human reads in a browser pane. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export interface Change {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  /** ISO. From the file_edit projection when known, else the file's mtime. */
  at: string;
  /** Agent that last wrote it, when the log knows. */
  by: string | null;
  binary: boolean;
}

export interface ChangeSet {
  byPath: Map<string, Change>;
  files: number;
  added: number;
  removed: number;
}

/**
 * Scan the worktree. One `git status`, one `git diff --numstat`, and a read per
 * untracked file — which is bounded by how many files an agent has created, not
 * by the size of the repo.
 */
export async function scanChanges(
  worktree: string,
  known: Map<string, FileChangeRecord>,
): Promise<ChangeSet> {
  // No git, no HEAD, nothing to diff against — so the `file_edit` projection is
  // the only record of what moved, and here it is the whole answer rather than
  // just the attribution. Counts in it came from reading the files as they were
  // written (see the watcher), so they are real; what is genuinely unavailable is
  // "changed relative to a commit", because there is no commit.
  if (!(await isRepo(worktree))) return fromProjection(known);

  const [entries, stats] = await Promise.all([status(worktree), numstat(worktree)]);
  const statByPath = new Map(stats.map((s) => [s.path, s]));

  const byPath = new Map<string, Change>();

  for (const entry of entries) {
    const path = entry.path;
    const stat = statByPath.get(path);
    const record = known.get(path);

    let added = stat?.added ?? 0;
    let removed = stat?.removed ?? 0;
    let binary = stat?.binary ?? false;

    if (entry.untracked) {
      const counted = countNewFile(join(worktree, path));
      added = counted.lines;
      removed = 0;
      binary = counted.binary;
    } else if (entry.deleted) {
      // A deleted tracked file: numstat already reports every line as removed.
      binary = stat?.binary ?? false;
    }

    byPath.set(path, {
      path,
      added,
      removed,
      // 'A ' is staged-new; both it and '??' are files that did not exist at HEAD.
      created: entry.untracked || entry.code.startsWith('A') || (record?.created ?? false),
      deleted: entry.deleted,
      at: record?.at ?? mtimeIso(join(worktree, path)),
      by: record?.byAgentId ?? null,
      binary,
    });
  }

  // numstat can name a path that `status` doesn't (staged-only changes with a
  // clean worktree). Those are still changes the UI should badge.
  for (const stat of stats) {
    if (byPath.has(stat.path)) continue;
    const record = known.get(stat.path);
    byPath.set(stat.path, {
      path: stat.path,
      added: stat.added,
      removed: stat.removed,
      created: record?.created ?? false,
      deleted: false,
      at: record?.at ?? mtimeIso(join(worktree, stat.path)),
      by: record?.byAgentId ?? null,
      binary: stat.binary,
    });
  }

  let added = 0;
  let removed = 0;
  for (const c of byPath.values()) {
    added += c.added;
    removed += c.removed;
  }

  return { byPath, files: byPath.size, added, removed };
}

/**
 * The change set for a git-less workspace, built from the edit log alone.
 *
 * A deleted file stays in the set — that is what the badge is for — but the
 * `binary` flag cannot be recovered from a record, so it is false and the diff
 * path falls back to whatever `git diff --no-index` makes of the file (it says
 * "Binary files differ", which is the right answer arrived at differently).
 */
function fromProjection(known: Map<string, FileChangeRecord>): ChangeSet {
  const byPath = new Map<string, Change>();
  let added = 0;
  let removed = 0;

  for (const [path, rec] of known) {
    byPath.set(path, {
      path,
      added: rec.added,
      removed: rec.removed,
      created: rec.created,
      deleted: rec.deleted,
      at: rec.at,
      by: rec.byAgentId,
      binary: false,
    });
    added += rec.added;
    removed += rec.removed;
  }

  return { byPath, files: byPath.size, added, removed };
}

/** Line count for a file git has never seen. Binary files report 0. */
export function countNewFile(abs: string): { lines: number; binary: boolean } {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { lines: 0, binary: false };
    if (st.size > MAX_TEXT_BYTES) return { lines: 0, binary: true };
    const buf = readFileSync(abs);
    if (looksBinary(buf)) return { lines: 0, binary: true };
    const text = buf.toString('utf8');
    if (text.length === 0) return { lines: 0, binary: false };
    // A trailing newline terminates the last line; it doesn't start a new one.
    const n = text.split('\n').length;
    return { lines: text.endsWith('\n') ? n - 1 : n, binary: false };
  } catch {
    return { lines: 0, binary: false };
  }
}

/** A NUL byte in the first 8k is the same heuristic git itself uses. */
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i += 1) if (buf[i] === 0) return true;
  return false;
}

function mtimeIso(abs: string): string {
  try {
    return statSync(abs).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Drop gitignored paths from a candidate list. The watcher needs this because
 * chokidar's `ignored` matcher is synchronous and .gitignore is not a pattern
 * this process should be reimplementing.
 */
export async function withoutIgnored(worktree: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const ignored = await checkIgnore(worktree, paths);
  return paths.filter((p) => !ignored.has(toPosix(p)));
}
