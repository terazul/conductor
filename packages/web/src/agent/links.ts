/**
 * File names in a transcript, as links to the Files screen.  TRACK B.  (F16)
 *
 * Files already has a deep link (`#files?jobId=…&path=…`, Amendment 3). The work here
 * is the path. A tool's input carries an ABSOLUTE path; Files takes one RELATIVE to the
 * job's worktree, and the daemon refuses anything absolute or anything that resolves
 * outside it (`workspace/paths.ts`). That refusal is a security boundary, so this does
 * not try to get around it: a path outside the worktree simply isn't a link.
 *
 * Two levels of trust, because the two sources differ:
 *
 *  • TOUCHED — a path a tool was handed. The agent really did read or write it, so
 *    being inside the worktree is enough.
 *  • NAMED — a path in the agent's prose. Plenty of code spans look like files and
 *    aren't (`${name}.png.part`, an elided `…-stage-gates.md`, a file in another repo),
 *    so these link only if the job's tree actually has the file. A dead link is worse
 *    than plain text.
 *
 * Pure: no DOM, no store. `agent/verify.ts` runs it under node.
 */

import type { FileNode } from '@conductor/shared';
import { hrefFor } from '../lib/nav.js';
import { SCREEN } from '../shell/nav.js';

/**
 * A worktree-relative path for Files, or null if `raw` can't be one.
 *
 * A trailing `:line`, `:line:col` or `:from-to` is dropped: the Files pane has no line
 * anchor, and agents write `store.ts:42` far more often than a bare name.
 */
export function linkablePath(raw: string, worktreePath: string): string | null {
  let p = raw.trim().replace(/:\d+(?:[:-]\d+)?$/, '');
  // `~` is the daemon's home, not the worktree; a scheme is a URL, or a drive letter.
  if (p === '' || p.startsWith('~') || p.includes('\\') || /^[a-z][\w+.-]*:/i.test(p)) {
    return null;
  }
  if (p.startsWith('/')) {
    // The `/` matters: without it `/wt/job-evil/x` passes as being under `/wt/job`.
    // The daemon guards the same trap.
    const root = `${worktreePath.replace(/\/+$/, '')}/`;
    if (root === '/' || !p.startsWith(root)) return null;
    p = p.slice(root.length);
  }
  // Relative paths are the agent's, and agents run in the worktree.
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // climbed out
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length > 0 ? out.join('/') : null;
}

/** Every file (not directory) in a tree, by its worktree-relative path. */
export function filesIn(root: FileNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: FileNode): void => {
    if (n.type === 'file') out.add(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

export interface FileLinks {
  /** The job's worktree, which a tool's absolute paths are relative to. */
  readonly worktreePath: string;
  /** A path a tool was handed. Linked whenever it is inside the worktree. */
  touched(raw: string): string | null;
  /** A path named in prose. Linked only when the job's tree has that file. */
  named(raw: string): string | null;
}

/**
 * Links into one job's worktree. `files` is null until the tree has loaded, and until
 * then nothing in prose links — it fills in when the tree lands, rather than guessing.
 */
export function fileLinks(
  job: { id: string; worktreePath: string },
  files: ReadonlySet<string> | null,
): FileLinks {
  const href = (path: string): string => hrefFor(SCREEN.files, { jobId: job.id, path });
  return {
    worktreePath: job.worktreePath,
    touched(raw) {
      const path = linkablePath(raw, job.worktreePath);
      return path === null ? null : href(path);
    },
    named(raw) {
      const path = linkablePath(raw, job.worktreePath);
      return path !== null && files?.has(path) === true ? href(path) : null;
    },
  };
}

/** Why a touched path isn't a link, for its `title`. */
export const OUTSIDE = "outside this job's worktree";
