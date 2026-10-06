/**
 * Directory completion for the "where" field — the one place Conductor looks
 * outside a workspace.
 *
 * TRACK C owns this file.
 *
 * A browser cannot hand a web app a real filesystem path. `<input
 * type="file" webkitdirectory>` yields file names and a bare folder name, never
 * an absolute path, and it is an upload rather than a reference — so the native
 * picker cannot answer "which folder is my repo in". The daemon can: it is a
 * local process with ordinary disk access. This module is that access, and it is
 * deliberately the narrowest form of it that answers the question.
 *
 * WHAT MAKES THIS SAFE IS WHAT IT CANNOT DO. Every other path in this track goes
 * through workspace/paths.ts and is contained to a worktree. This one has no root
 * to be contained to — that is the feature — so containment is replaced by four
 * limits, each of which removes a category of abuse rather than making it
 * unlikely:
 *
 *   1. DIRECTORIES ONLY. Files are not listed, at all. You cannot use this to
 *      discover `~/Documents/tax-return.pdf` or `~/.aws/credentials`; the answer
 *      to "what is in this folder" is only ever "these folders".
 *   2. NAMES ONLY. It reads directory entries. It never opens a file, so there is
 *      no content to leak even for the paths it does name.
 *   3. DOTFILES STAY HIDDEN until you type the dot yourself, exactly as a shell
 *      behaves. `.ssh` and `.aws` do not appear in a listing of your home
 *      directory that you did not ask for.
 *   4. A HARD ENTRY CAP, with the overflow counted rather than dropped silently —
 *      Amendment 4's rule, restated for a different tree.
 *
 * It performs no writes and has no way to. There is no `mkdir`, no `rename`, no
 * `unlink` in this file and none should be added: the moment this module can
 * change the disk it stops being a lookup and becomes the remote-file-write hole
 * that paths.ts exists to prevent.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonicalRoot } from './paths.js';

/**
 * Past this many matches the list has stopped being a way to find a folder and
 * become a way to scroll one. Type another character instead — which is what the
 * count in `truncated` is telling you to do.
 */
const MAX_ENTRIES = 40;

export interface DirEntry {
  /** Basename — what the UI shows. */
  name: string;
  /** Absolute path, canonical. What gets sent to POST /api/projects. */
  path: string;
  /**
   * A git repository. `.git` is a directory in a normal clone and a FILE in a
   * linked worktree or a submodule, so existence is the test, not `isDirectory`.
   */
  repo: boolean;
}

export interface CompleteResult {
  /** The directory the entries live in, absolute and canonical. */
  dir: string;
  /** The fragment being matched inside `dir`. Echoed so the UI can highlight it. */
  prefix: string;
  entries: DirEntry[];
  /** Matches beyond the cap. Zero when the list is complete. */
  truncated: number;
  /** The input itself, when it is already a directory — so the UI can confirm it. */
  target: DirEntry | null;
}

function isRepo(abs: string): boolean {
  return existsSync(join(abs, '.git'));
}

function entryFor(abs: string): DirEntry {
  return { name: basename(abs), path: abs, repo: isRepo(abs) };
}

/**
 * Expand `~`, then resolve.
 *
 * A bare relative fragment resolves against HOME rather than the daemon's cwd.
 * The cwd is wherever Conductor was started from — usually its own source tree,
 * which is never the answer anyone typing here wants. Home is both a better guess
 * and a legible one, since every completion shows its absolute path.
 */
export function expand(input: string): string {
  const home = homedir();
  if (input === '~') return home;
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) {
    return join(home, input.slice(2));
  }
  if (input.length === 0) return home;
  return isAbsolute(input) ? input : join(home, input);
}

/** Directories in `dir` whose name starts with `prefix`, case-insensitively. */
function childDirs(dir: string, prefix: string): { names: string[]; total: number } {
  let raw: string[];
  try {
    raw = readdirSync(dir, { withFileTypes: true })
      .filter((d) => {
        // A symlink to a directory is a directory for navigation purposes —
        // `~/code` pointing at an external drive is an ordinary setup. statSync
        // rather than realpath because a broken link should just vanish.
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        try {
          return statSync(join(dir, d.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((d) => d.name);
  } catch {
    // ENOENT while the path is half-typed, ENOTDIR on a file, EACCES on someone
    // else's home. All three mean "nothing to offer", none is an error worth
    // showing: the field is mid-sentence.
    return { names: [], total: 0 };
  }

  const lower = prefix.toLowerCase();
  const matched = raw
    .filter((name) => {
      // Hidden unless asked for, like a shell. `.ssh` does not appear in a
      // listing of $HOME that the user did not ask for by typing the dot.
      if (name.startsWith('.') && !prefix.startsWith('.')) return false;
      return name.toLowerCase().startsWith(lower);
    })
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return { names: matched.slice(0, MAX_ENTRIES), total: matched.length };
}

/**
 * Complete a partially typed directory path.
 *
 * Splits the way a shell does: a trailing separator means "list this directory",
 * anything else means "match this fragment inside its parent". So `/Users/you/pl`
 * offers `playground`, and `/Users/you/playground/` offers what is inside it.
 */
export function completePath(input: string): CompleteResult {
  // A NUL byte reaches the syscall layer and is rejected there with a TypeError
  // rather than an fs error, which would be a 500 instead of an empty list.
  const raw = input.replace(/\0/g, '');
  const expanded = expand(raw);

  // A bare `~` lists home rather than matching the fragment `dtavares` inside
  // `/Users`. A shell completes usernames there; here the only user is the one
  // running the daemon, so the shell's reading would offer you exactly one entry —
  // your own home — as a thing to click. `~` means home; show what is in it.
  const listing = raw.length === 0 || raw === '~' || raw.endsWith('/') || raw.endsWith(sep);
  const dirInput = listing ? expanded : dirname(expanded);
  const prefix = listing ? '' : basename(expanded);

  // canonicalRoot resolves symlinks — /tmp → /private/tmp on macOS — so the paths
  // handed back are the same ones the workspace layer will canonicalise later.
  // Without this, adding a project via a symlinked path and adding it via its
  // real path would look like two different projects.
  const dir = canonicalRoot(resolve(dirInput));

  const { names, total } = childDirs(dir, prefix);
  const target = !listing && existsSync(expanded) && statSync(expanded).isDirectory()
    ? entryFor(canonicalRoot(expanded))
    : listing && existsSync(dir)
      ? entryFor(dir)
      : null;

  return {
    dir,
    prefix,
    entries: names.map((name) => entryFor(join(dir, name))),
    truncated: Math.max(0, total - names.length),
    target,
  };
}
