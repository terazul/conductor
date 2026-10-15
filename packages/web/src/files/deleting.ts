/**
 * What deleting from the Files tree asks, and in what order.  TRACK C.  (Amendment 138)
 *
 * Q2 in the wave 10 plan: a folder with files in it can be deleted, with a double check.
 * So a file, or an empty folder, is one confirm naming it; a folder with files in it is a
 * first confirm naming the folder and how many files it holds, then a second "Are you
 * sure?" that says the count again, and only that second yes sends `recursive=1`.
 *
 * The count is the daemon's (`GET …/entry`, counted on disk), not the tree's: the tree
 * leaves out what git ignores and `node_modules`, and a recursive delete takes those too.
 * Until it lands the tree's count is shown and the button waits (`ready: false`).
 *
 * Pure: no DOM, no React, no fetch. files/verify.ts runs it under Node.
 */

import type { FileNode } from '@conductor/shared';

export interface DeleteTarget {
  path: string;
  type: 'file' | 'dir';
  /** Files in it on disk, from the daemon; null until it has answered. */
  files: number | null;
  /** The tree's own count, shown while `files` is null. */
  treeFiles: number;
  /** `files` stopped at the daemon's ceiling: there are at least that many. */
  capped?: boolean;
  /** How many git has; null with no repo, or not yet known. */
  tracked: number | null;
  /** Names of the open tabs at or under it with an unsaved edit, which close with it. */
  unsaved: string[];
}

export interface DeleteStep {
  /** The question, naming what goes. */
  ask: string;
  /** What else to know before saying yes. */
  notes: string[];
  /** The destructive button's words. */
  yes: string;
  /** Is this the step whose yes sends the delete? */
  last: boolean;
  /** Does that delete take a folder's contents (`recursive=1`)? */
  recursive: boolean;
  /** False while the daemon's count is still on its way: the button waits for it. */
  ready: boolean;
}

const files = (n: number, capped = false): string =>
  `${capped ? 'at least ' : ''}${n.toLocaleString('en')} file${n === 1 && !capped ? '' : 's'}`;

/** A name as a person calls it: its last segment, a folder's with a `/`. */
export function shownName(path: string, type: 'file' | 'dir'): string {
  const name = path.split('/').pop() || path;
  return type === 'dir' ? `${name}/` : name;
}

/** Files under a tree node, as the tree lists them: deleted ones (gone already) not counted. */
export function countTreeFiles(node: FileNode): number {
  if (node.type === 'file') return node.change?.deleted ? 0 : 1;
  return (node.children ?? []).reduce((n, kid) => n + countTreeFiles(kid), 0);
}

function gitNote(t: DeleteTarget, count: number): string | null {
  // Not known until the daemon answers; saying "no git" meanwhile would be a guess.
  if (t.files === null) return null;
  if (t.tracked === null) return 'There is no git here, so nothing can bring it back.';
  if (t.type === 'file') {
    return t.tracked > 0
      ? 'Git has this file: its last commit can be restored with git.'
      : 'Git does not have this file, so nothing can bring it back.';
  }
  if (t.tracked === 0) return 'Git has none of these, so nothing can bring them back.';
  return t.tracked >= count
    ? 'Git has all of them: their last commits can be restored with git.'
    : `Git has ${files(t.tracked)} of them; the other ${files(count - t.tracked)} cannot be brought back.`;
}

function unsavedNote(t: DeleteTarget): string | null {
  if (t.unsaved.length === 0) return null;
  const names = t.unsaved.join(', ');
  return t.unsaved.length === 1
    ? `Your unsaved edit to ${names} goes with it.`
    : `Your unsaved edits to ${names} go with it.`;
}

/**
 * The steps a delete asks, in order. One for a file or an empty folder; two for a folder
 * with files in it, the second repeating the count. Each step's `last` says whether its
 * yes sends the delete.
 */
export function deleteSteps(t: DeleteTarget): DeleteStep[] {
  const name = shownName(t.path, t.type);
  const count = t.files ?? t.treeFiles;
  const ready = t.type === 'file' || t.files !== null;
  const notes = (...extra: (string | null)[]): string[] =>
    [gitNote(t, count), unsavedNote(t), ...extra].filter((n): n is string => n !== null);

  if (t.type === 'file') {
    return [{ ask: `Delete ${name}?`, notes: notes(), yes: 'delete', last: true, recursive: false, ready }];
  }
  if (count === 0 && ready) {
    return [{ ask: `Delete the empty folder ${name}?`, notes: [], yes: 'delete', last: true, recursive: false, ready }];
  }
  const held = files(count, t.capped);
  const go = count === 1 && !t.capped ? 'goes' : 'go';
  return [
    {
      ask: count === 0 ? `Delete ${name}?` : `Delete ${name} and the ${held} in it?`,
      notes: notes(ready ? null : 'Counting what is in it on disk…'),
      yes: ready ? `delete ${held}` : 'counting…',
      last: false,
      recursive: true,
      ready,
    },
    {
      ask: `Are you sure? ${held[0]!.toUpperCase()}${held.slice(1)} ${go} with ${name}, and this cannot be undone from Conductor.`,
      notes: [],
      yes: `yes, delete ${held}`,
      last: true,
      recursive: true,
      ready,
    },
  ];
}

/** What a yes on step `at` does: show the next step, or send the delete. */
export function onYes(steps: readonly DeleteStep[], at: number): { next: number } | { send: { recursive: boolean } } | null {
  const step = steps[at];
  if (!step || !step.ready) return null;
  return step.last ? { send: { recursive: step.recursive } } : { next: at + 1 };
}

/**
 * Whether `node` is on disk, so there is something to rename or delete: a file git lists
 * only because it went is not (Amendment 29). The navigator asks this, since it reads no
 * change marks itself.
 */
export function onDisk(node: FileNode): boolean {
  return node.change?.deleted !== true;
}
