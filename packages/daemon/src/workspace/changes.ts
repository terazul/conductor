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

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkIgnore, isRepo, numstat, status, toPosix, type NumStat, type StatusEntry } from './git.js';
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
 *
 * Nested repos (Amendment 155): the outer `git status` names a nested clone or a
 * submodule only as one opaque entry for its whole folder (`?? inner/`, ` M inner`),
 * never a path inside it. Each such entry is scanned again as its own repo, its
 * paths prefixed with its folder, and the opaque entry itself is dropped, so the
 * badges inside `inner/` are inner's own. Down to `MAX_NESTED_DEPTH`, as the tree
 * lists them. A clean nested repo is not in the outer status at all, so it costs
 * nothing and shows nothing.
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

  const byPath = new Map<string, Change>();
  for (const c of await scanRepo(worktree, '', known, 0)) byPath.set(c.path, c);

  let added = 0;
  let removed = 0;
  for (const c of byPath.values()) {
    added += c.added;
    removed += c.removed;
  }

  return { byPath, files: byPath.size, added, removed };
}

/** How many nested-repo boundaries deep changes are scanned: the tree's own limit. */
export const MAX_NESTED_DEPTH = 4;

/**
 * One repo's changes, `prefix` (`''` at the worktree root, else `inner/`) put in
 * front of every path. `depth` is how many nested boundaries `prefix` crossed.
 */
async function scanRepo(
  worktree: string,
  prefix: string,
  known: Map<string, FileChangeRecord>,
  depth: number,
): Promise<Change[]> {
  const repo = join(worktree, prefix);
  let entries: StatusEntry[];
  let stats: NumStat[];
  try {
    [entries, stats] = await Promise.all([status(repo), numstat(repo)]);
  } catch (err) {
    // A corrupt nested repo: its folder still shows in the tree, with no badges.
    if (prefix.length === 0) throw err;
    return [];
  }

  // The opaque entries: a folder in this repo's status that is a repo of its own.
  const nested = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
    if (path.length > 0 && isNestedRepo(join(repo, path))) nested.add(path);
  }
  const opaque = (path: string): boolean =>
    nested.has(path.endsWith('/') ? path.slice(0, -1) : path);

  const statByPath = new Map(stats.map((s) => [s.path, s]));
  const out = new Map<string, Change>();

  for (const entry of entries) {
    if (opaque(entry.path)) continue;
    const path = entry.path;
    const stat = statByPath.get(path);
    const record = known.get(prefix + path);

    let added = stat?.added ?? 0;
    let removed = stat?.removed ?? 0;
    let binary = stat?.binary ?? false;

    if (entry.untracked) {
      const counted = countNewFile(join(repo, path));
      added = counted.lines;
      removed = 0;
      binary = counted.binary;
    } else if (entry.deleted) {
      // A deleted tracked file: numstat already reports every line as removed.
      binary = stat?.binary ?? false;
    }

    out.set(path, {
      path: prefix + path,
      added,
      removed,
      // 'A ' is staged-new; both it and '??' are files that did not exist at HEAD.
      created: entry.untracked || entry.code.startsWith('A') || (record?.created ?? false),
      deleted: entry.deleted,
      at: record?.at ?? mtimeIso(join(repo, path)),
      by: record?.byAgentId ?? null,
      binary,
    });
  }

  // numstat can name a path that `status` doesn't (staged-only changes with a
  // clean worktree). Those are still changes the UI should badge.
  for (const stat of stats) {
    if (out.has(stat.path) || opaque(stat.path)) continue;
    const record = known.get(prefix + stat.path);
    out.set(stat.path, {
      path: prefix + stat.path,
      added: stat.added,
      removed: stat.removed,
      created: record?.created ?? false,
      deleted: false,
      at: record?.at ?? mtimeIso(join(repo, stat.path)),
      by: record?.byAgentId ?? null,
      binary: stat.binary,
    });
  }

  const changes = [...out.values()];
  if (depth < MAX_NESTED_DEPTH) {
    const subs = await Promise.all(
      [...nested].map((p) => scanRepo(worktree, `${prefix}${p}/`, known, depth + 1)),
    );
    for (const sub of subs) changes.push(...sub);
  }
  return changes;
}

/**
 * The nested repo that owns `relPath`, as its worktree-relative folder with a
 * trailing slash, or `''` when the worktree's own repo does (Amendment 155). The
 * deepest boundary on the way down wins, up to `MAX_NESTED_DEPTH` of them: a path
 * past that is the deepest scanned repo's, which sees only an opaque folder, so no
 * route gives it a badge or a diff. The boundary test is the tree's (`tree.ts`
 * `hasDotGit`, Amendment 90): a non-symlink folder with a `.git` in it.
 */
export function ownerOf(worktree: string, relPath: string): string {
  const segments = relPath.split('/').filter((s) => s.length > 0);
  let owner = '';
  let depth = 0;
  for (let i = 1; i < segments.length && depth < MAX_NESTED_DEPTH; i += 1) {
    const dir = segments.slice(0, i).join('/');
    if (isNestedRepo(join(worktree, dir))) {
      owner = `${dir}/`;
      depth += 1;
    }
  }
  return owner;
}

function isNestedRepo(abs: string): boolean {
  try {
    if (!lstatSync(abs).isDirectory()) return false;
    lstatSync(join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
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
