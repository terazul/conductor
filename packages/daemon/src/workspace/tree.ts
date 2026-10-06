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
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FileNode, FileTreeResponse } from '@conductor/shared';
import { isRepo, listFiles, toPosix } from './git.js';
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
        visit(join(abs, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        out.push(toPosix(childRel));
      }
    }
  };

  visit(root, '', 0);
  return out;
}

interface Building {
  node: FileNode;
  children: Map<string, Building>;
}

function dir(path: string, name: string): Building {
  return { node: { path, name, type: 'dir', children: [] }, children: new Map() };
}

export async function buildTree(
  worktree: string,
  rootName: string,
  changes: ChangeSet,
  cap = MAX_TREE_ENTRIES,
): Promise<FileTreeResponse> {
  // Asked rather than passed in: a caller that got the flag wrong would either
  // throw a GitError on a scratch folder or list node_modules in a real repo.
  const files = (await isRepo(worktree))
    ? (await listFiles(worktree)).filter(listed)
    : walkFiles(worktree, cap * 5);

  // A deleted file is gone from ls-files but is exactly what a human wants to
  // see flagged, so changed paths are unioned in.
  const paths = new Set(files);
  for (const path of changes.byPath.keys()) if (listed(path)) paths.add(path);

  const dropped = Math.max(0, paths.size - cap);
  const ordered = [...paths].sort().slice(0, cap);
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
