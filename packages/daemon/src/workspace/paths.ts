/**
 * Path containment. THE security boundary of this track.
 *
 * TRACK C owns this file.
 *
 * `GET /file?path=` and `PUT /file` take a path from the browser. On a daemon
 * bound to localhost that browser is still the whole internet's DNS-rebinding
 * target, and a path that escapes the worktree turns this feature into remote
 * file read/write on the user's machine. So: every path crosses this module
 * before any fs call, and there is no second way in.
 *
 * Four escapes are handled, because three of them look handled by accident:
 *   1. `../../etc/passwd`            — normalise, then require the prefix.
 *   2. `/etc/passwd`                 — resolve(root, absolute) RETURNS the
 *                                      absolute path. Rejected before resolve.
 *   3. `wt/job/link` → /etc          — a symlink inside the worktree. Defeated
 *                                      by realpath-ing the result, and the
 *                                      PARENT for writes (target may not exist).
 *   4. `.git/hooks/post-checkout`    — inside the worktree, still catastrophic:
 *                                      a written hook is arbitrary execution.
 *
 * Prefix checks use `root + sep` so `/repo/wt/job` can never match
 * `/repo/wt/job-evil`.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { toPosix } from './git.js';

export class PathEscape extends Error {
  readonly requested: string;

  constructor(requested: string, reason: string) {
    super(`refusing path ${JSON.stringify(requested)}: ${reason}`);
    this.name = 'PathEscape';
    this.requested = requested;
  }
}

/** Directories no request may touch, at any depth. */
const FORBIDDEN_SEGMENTS = new Set(['.git']);

function assertSaneInput(rel: string): void {
  if (rel.includes('\0')) throw new PathEscape(rel, 'NUL byte in path');
  if (isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new PathEscape(rel, 'absolute paths are not accepted — send a worktree-relative path');
  }
  const segments = normalize(rel).split(/[\\/]/);
  for (const s of segments) {
    if (FORBIDDEN_SEGMENTS.has(s.toLowerCase())) {
      throw new PathEscape(rel, `${s} is off limits — writing there is arbitrary code execution`);
    }
  }
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Canonical form of the worktree root. Call once per workspace and cache it:
 * on macOS /tmp is a symlink to /private/tmp, so an uncanonicalised root makes
 * every later prefix check fail.
 */
export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Resolve a worktree-relative path for READING. The file must already be inside
 * the worktree after symlinks are followed.
 */
export function resolveForRead(root: string, rel: string): string {
  assertSaneInput(rel);
  const abs = resolve(root, rel);
  if (!contains(root, abs)) throw new PathEscape(rel, 'resolves outside the worktree');

  // Follow symlinks: a link inside the worktree pointing at /etc passes the
  // textual check and fails this one.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    // Doesn't exist. The textual check already passed; the caller's read will
    // produce the honest ENOENT.
    return abs;
  }
  if (!contains(root, real)) throw new PathEscape(rel, 'symlink leaves the worktree');
  return real;
}

/**
 * Resolve a worktree-relative path for WRITING. The target may not exist yet,
 * so containment is proven against the nearest existing ancestor.
 */
export function resolveForWrite(root: string, rel: string): { abs: string; parent: string } {
  assertSaneInput(rel);
  const abs = resolve(root, rel);
  if (!contains(root, abs)) throw new PathEscape(rel, 'resolves outside the worktree');
  if (abs === root) throw new PathEscape(rel, 'that is the worktree itself');

  // Walk up to the first ancestor that exists, canonicalise it, and require
  // that it is still inside the worktree.
  let probe = abs;
  for (;;) {
    const parent = resolve(probe, '..');
    if (parent === probe) throw new PathEscape(rel, 'no existing ancestor inside the worktree');
    try {
      const realParent = realpathSync(parent);
      if (!contains(root, realParent)) {
        throw new PathEscape(rel, 'a parent directory leaves the worktree');
      }
      break;
    } catch (err) {
      if (err instanceof PathEscape) throw err;
      probe = parent; // parent doesn't exist either — keep walking up
    }
  }

  // If the file itself already exists it must not be a symlink out.
  try {
    const realTarget = realpathSync(abs);
    if (!contains(root, realTarget)) throw new PathEscape(rel, 'symlink leaves the worktree');
    return { abs: realTarget, parent: resolve(realTarget, '..') };
  } catch (err) {
    if (err instanceof PathEscape) throw err;
    return { abs, parent: resolve(abs, '..') };
  }
}

/** Worktree-relative POSIX form, for the wire. */
export function relativePosix(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]/, '') : abs;
  return toPosix(rel);
}
