/**
 * Tree building — a worktree's files as the nested shape the wire expects.
 *
 * TRACK C owns this file. Response shape frozen in shared/src/wire.ts.
 *
 * File discovery is `git ls-files -co --exclude-standard`, which means
 * .gitignore is honoured by git itself rather than by a pattern matcher this
 * daemon maintains. On top of that a structural deny-list, because the scratch
 * repo — like plenty of real ones — has no .gitignore, and `node_modules` in a
 * file tree is not a file tree.
 *
 * A directory with no git in it falls back to `walkFiles`, because `in_place`
 * isolation runs in scratch folders that were never `git init`ed and the Files
 * screen is not allowed to be the reason that doesn't work.
 *
 * Directories carry a rolled-up `change` so a collapsed `src/` still shows that
 * something underneath it moved. That is the difference between a tree you can
 * scan and a tree you have to expand.
 *
 * Nested repos (Amendment 90): `git ls-files` stops at another repo's boundary
 * and hands back one opaque entry for the whole thing — `inner/` for a clone,
 * `inner` for a submodule's gitlink. Left alone that becomes a file leaf with
 * nothing under it, which is the bug this amendment closes. `classifyLevel`
 * below is the one place that notices the boundary (by `lstat`, not `isRepo` —
 * `isRepo` answers true for every folder inside the outer repo, nested or
 * not), and `expandNestedRepo` re-lists it with its own `listFiles`, grafting
 * the result in and marking the folder with its branch.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FileNode, FileTreeResponse } from '@conductor/shared';
import { isRepo, listFiles, nestedBranch, toPosix } from './git.js';
import type { ChangeSet } from './changes.js';

/**
 * Past this, the browser is the bottleneck and the tree stops being useful.
 *
 * Truncation is reported through `FileTreeResponse.truncated` (Amendment 4) and
 * logged on the server. It must never be silent: a file browser that quietly
 * omits files makes someone conclude the file does not exist, which is a
 * correctness bug dressed as a display limit.
 */
export const MAX_TREE_ENTRIES = 12_000;

const NEVER_LISTED = new Set([
  '.git',
  '.conductor',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  '.gradle',
  '.idea',
  '.DS_Store',
]);

function listed(path: string): boolean {
  return !path.split('/').some((s) => NEVER_LISTED.has(s));
}

/**
 * The same enumeration for a directory with no git in it. `in_place` isolation
 * works there, so the Files screen has to as well.
 *
 * This is the one place the deny-list above stops being a nicety and becomes
 * load-bearing: `git ls-files` applies .gitignore for us, and without git there
 * is nothing between this walk and a 40k-entry `node_modules`. So the pruning
 * happens during traversal, not as a filter afterwards.
 *
 * `limit` is a safety ceiling on the walk, deliberately well above the tree's
 * display cap: stopping at the display cap would make `truncated` say "1 not
 * shown" when thousands were, and a file browser that misreports how much it hid
 * is the same correctness bug as one that hides silently.
 *
 * Depth is bounded because `followSymlinks: false` is not available here and a
 * symlink loop must not hang the request.
 *
 * A nested repo (Amendment 90) stops the walk the moment it's found and the
 * boundary directory is handed back as its own entry, exactly the shape
 * `git ls-files` gives one at a repo boundary. `classifyLevel` is what expands
 * it from there with the nested repo's own `listFiles` — this walk's job is
 * only to notice the boundary, not to cross it.
 */
export function walkFiles(root: string, limit: number, maxDepth = 12): string[] {
  const out: string[] = [];

  const visit = (abs: string, rel: string, depth: number): void => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      // Unreadable directory: skipped, not fatal. A permission error deep in a
      // tree should not fail the whole screen.
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (NEVER_LISTED.has(entry.name)) continue;
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const childAbs = join(abs, entry.name);
        if (hasDotGit(childAbs)) {
          out.push(toPosix(childRel));
          continue;
        }
        visit(childAbs, childRel, depth + 1);
      } else if (entry.isFile()) {
        out.push(toPosix(childRel));
      }
    }
  };

  visit(root, '', 0);
  return out;
}

/**
 * Amendment 90's repo-boundary test: a non-symlink directory containing a
 * `.git` entry — a directory for an ordinary clone, a file for a submodule's
 * gitlink. `lstat`, never `stat`: a symlink must not read as a directory here,
 * or a link back up the tree (`loop -> ..`) would get "expanded" into the very
 * infinite recursion this check exists to prevent, instead of staying the
 * harmless leaf it is.
 *
 * Deliberately not `isRepo` (git.ts): `isRepo` runs `git rev-parse --git-dir`
 * and answers true for *any* directory inside the outer repo, nested boundary
 * or not — useless for telling "this folder is its own repo" from "this folder
 * is just a folder".
 */
function hasDotGit(abs: string): boolean {
  try {
    lstatSync(join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** How many nested-repo boundaries deep the tree follows before it stops
 * recursing and just marks what's there. Chosen to be generous for the
 * clone-inside-a-clone case without letting a pathological chain of them turn
 * one tree request into dozens of serial `git` processes. */
const MAX_NESTED_DEPTH = 4;

interface LevelEntries {
  /** Plain file leaves, already relative to the worktree root. */
  files: string[];
  /** Nested-repo boundaries at this level, relative to the worktree root. */
  repoDirs: string[];
  /** Listed directories with no `.git` inside — an uninitialised submodule
   * looks exactly like this: tracked, present on disk, empty. */
  emptyDirs: string[];
}

/**
 * Sorts one listing's entries — `git ls-files` output, or a nested repo's own
 * — into plain files, repo boundaries, and empty (no-`.git`) directories.
 * `prefix` is the worktree-relative path this listing's own entries are
 * relative to; pass it with a trailing slash already on, or `''` at the root.
 */
function classifyLevel(worktreeAbs: string, entries: string[], prefix: string): LevelEntries {
  const files: string[] = [];
  const repoDirs: string[] = [];
  const emptyDirs: string[] = [];

  for (const raw of entries) {
    // A trailing slash marks an untracked nested clone in `ls-files -o`
    // output; a submodule gitlink has none. `lstat` below is authoritative
    // either way, so the slash itself is only cosmetic and gets stripped.
    const clean = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (clean.length === 0) continue;
    const relPath = `${prefix}${clean}`;
    const abs = join(worktreeAbs, relPath);

    let isDir: boolean;
    try {
      isDir = lstatSync(abs).isDirectory();
    } catch {
      // Listed but gone (a race with a concurrent write): drop it rather than
      // surface a leaf for a path that no longer exists.
      continue;
    }

    if (!isDir) {
      files.push(relPath);
    } else if (hasDotGit(abs)) {
      repoDirs.push(relPath);
    } else {
      emptyDirs.push(relPath);
    }
  }

  return { files, repoDirs, emptyDirs };
}

interface Expanded {
  files: string[];
  repos: Map<string, string | null>;
  emptyDirs: string[];
}

/**
 * Lists a nested repo (`relPath`, worktree-relative) with its own `listFiles`
 * and recurses into whatever nested repos *it* contains, up to
 * `MAX_NESTED_DEPTH` levels. `depth` is `relPath`'s own nesting level — 1 for
 * a repo found directly under the worktree root.
 *
 * Siblings run in parallel (`Promise.all` below and at the call site): a
 * project with several nested repos pays for `git ls-files` once per repo on
 * every tree request, and there's no reason to pay for it serially too.
 */
async function expandNestedRepo(
  worktreeAbs: string,
  relPath: string,
  depth: number,
): Promise<Expanded> {
  const abs = join(worktreeAbs, relPath);
  const repos = new Map<string, string | null>([[relPath, await nestedBranch(abs)]]);
  const files: string[] = [];
  const emptyDirs: string[] = [];

  let entries: string[] = [];
  try {
    entries = (await listFiles(abs)).filter(listed);
  } catch {
    // A corrupt or otherwise unreadable nested repo still gets its folder and
    // its branch (or null, if even that failed) — just no children.
    return { files, repos, emptyDirs };
  }

  const level = classifyLevel(worktreeAbs, entries, `${relPath}/`);
  files.push(...level.files);
  emptyDirs.push(...level.emptyDirs);

  if (depth < MAX_NESTED_DEPTH) {
    const subs = await Promise.all(
      level.repoDirs.map((p) => expandNestedRepo(worktreeAbs, p, depth + 1)),
    );
    for (const sub of subs) {
      files.push(...sub.files);
      emptyDirs.push(...sub.emptyDirs);
      for (const [p, b] of sub.repos) repos.set(p, b);
    }
  } else {
    // Four levels down already: still mark what's there as a repo, but this
    // is as deep as the tree goes — nothing past here gets listed.
    for (const p of level.repoDirs) repos.set(p, await nestedBranch(join(worktreeAbs, p)));
  }

  return { files, repos, emptyDirs };
}

interface Building {
  node: FileNode;
  children: Map<string, Building>;
}

function dir(path: string, name: string): Building {
  return { node: { path, name, type: 'dir', children: [] }, children: new Map() };
}

/**
 * Walks/creates every segment of `path` as a directory, including the last
 * one, and returns it. Used to force a nested repo's folder — and an
 * uninitialised submodule's — into the tree even when it contributes no file
 * leaves of its own: without this, a nested repo with nothing survived by the
 * cap, or with no files at all, would simply never appear.
 */
function ensureDir(root: Building, path: string): Building {
  const segments = path.split('/').filter((s) => s.length > 0);
  let cursor = root;
  for (let i = 0; i < segments.length; i += 1) {
    const name = segments[i]!;
    const childPath = segments.slice(0, i + 1).join('/');
    let next = cursor.children.get(name);
    if (!next) {
      next = dir(childPath, name);
      cursor.children.set(name, next);
    }
    cursor = next;
  }
  return cursor;
}

export async function buildTree(
  worktree: string,
  rootName: string,
  changes: ChangeSet,
  cap = MAX_TREE_ENTRIES,
): Promise<FileTreeResponse> {
  // Asked rather than passed in: a caller that got the flag wrong would either
  // throw a GitError on a scratch folder or list node_modules in a real repo.
  const rawEntries = (await isRepo(worktree))
    ? (await listFiles(worktree)).filter(listed)
    : walkFiles(worktree, cap * 5);

  const top = classifyLevel(worktree, rawEntries, '');

  // Amendment 90: expand every nested-repo boundary found at the root, in
  // parallel, each recursing into whatever it contains of its own.
  const nested = await Promise.all(top.repoDirs.map((p) => expandNestedRepo(worktree, p, 1)));

  const repos = new Map<string, string | null>();
  const emptyDirs = [...top.emptyDirs];
  const nestedFiles: string[] = [];
  for (const n of nested) {
    nestedFiles.push(...n.files);
    emptyDirs.push(...n.emptyDirs);
    for (const [p, b] of n.repos) repos.set(p, b);
  }

  // A deleted file is gone from ls-files but is exactly what a human wants to
  // see flagged, so changed paths are unioned in — into the outer repo's own
  // paths, never the nested ones. A nested repo's own changes are a deliberate
  // gap (ADR 0003): the outer `git status` only ever reports the whole nested
  // directory as one opaque entry, never a path inside it.
  const ownPaths = new Set(top.files);
  const nestedDirs = new Set(repos.keys());
  for (const raw of changes.byPath.keys()) {
    const path = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (path.length === 0 || !listed(path) || nestedDirs.has(path)) continue;
    ownPaths.add(path);
  }

  // Budget (ADR 0003): the outer repo's own paths go first, so one large
  // nested `vendor/` clone can never push the project's own files out of a
  // capped tree. Nested paths only get what's left of the one shared cap.
  const ownOrdered = [...ownPaths].sort();
  const nestedOrdered = [...new Set(nestedFiles)].sort();
  const dropped = Math.max(0, ownOrdered.length + nestedOrdered.length - cap);
  const ordered = [...ownOrdered, ...nestedOrdered].slice(0, cap);
  const root = dir('', rootName);

  for (const path of ordered) {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      const childPath = segments.slice(0, i + 1).join('/');
      let next = cursor.children.get(name);
      if (!next) {
        next = dir(childPath, name);
        cursor.children.set(name, next);
      }
      cursor = next;
    }

    const name = segments.at(-1)!;
    const change = changes.byPath.get(path);
    const leaf: FileNode = { path, name, type: 'file' };
    if (change) {
      leaf.change = {
        added: change.added,
        removed: change.removed,
        created: change.created,
        at: change.at,
      };
      if (change.deleted) leaf.change.deleted = true;
    }
    cursor.children.set(name, { node: leaf, children: new Map() });
  }

  // Nested-repo folders (and empty, `.git`-less listed directories) go into
  // the tree unconditionally, never subject to the cap above: the cap trims
  // *files*, but the folder marking where a nested repo lives — and its
  // branch — is how the ADR says "the project's own files always survive"
  // stays honest even when that repo's own contents got capped out.
  for (const [relPath, branch] of repos) {
    ensureDir(root, relPath).node.repo = { branch };
  }
  for (const relPath of emptyDirs) {
    ensureDir(root, relPath);
  }

  finish(root);

  if (dropped > 0) {
    console.warn(
      `[workspace] ${worktree}: tree capped at ${cap} entries, ${dropped} not shown`,
    );
  }

  return {
    root: root.node,
    changedFiles: changes.files,
    added: changes.added,
    removed: changes.removed,
    // Optional in the contract, so it is absent rather than 0 when nothing was
    // dropped — `truncated` present at all means "this tree is incomplete".
    ...(dropped > 0 ? { truncated: dropped } : {}),
  };
}

/**
 * Collapse the build map into sorted `children` arrays and roll each directory's
 * change summary up from its descendants. Directories first, then alphabetical —
 * the order a file tree is expected to be in.
 */
function finish(node: Building): { added: number; removed: number; at: string | null } {
  if (node.node.type === 'file') {
    const c = node.node.change;
    return c ? { added: c.added, removed: c.removed, at: c.at } : { added: 0, removed: 0, at: null };
  }

  let added = 0;
  let removed = 0;
  let at: string | null = null;

  const kids = [...node.children.values()].sort((a, b) => {
    if (a.node.type !== b.node.type) return a.node.type === 'dir' ? -1 : 1;
    return a.node.name.localeCompare(b.node.name);
  });

  for (const kid of kids) {
    const sum = finish(kid);
    added += sum.added;
    removed += sum.removed;
    if (sum.at && (at === null || sum.at > at)) at = sum.at;
  }

  node.node.children = kids.map((k) => k.node);
  if (added > 0 || removed > 0 || at !== null) {
    node.node.change = { added, removed, created: false, at: at ?? new Date().toISOString() };
  }
  return { added, removed, at };
}
