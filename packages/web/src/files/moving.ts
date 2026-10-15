/**
 * Moving an entry into a folder in the Files tree.  TRACK C.  (Amendment 159)
 *
 * Two ways to the same move, as spawn/reorder.tsx has: drag a row onto a folder row (or
 * the section's heading, for the top), or its **Move to…** button, which asks for the
 * folder in the name box and works from the keyboard. Either way the move is a rename
 * (`renameEntry`), and the open tabs and their edits follow it (`followRename`), as a
 * rename's do.
 *
 * A drag carries its path as `application/x-conductor-path`, so a project's drag in the
 * navigator (text/plain only) is never taken for one, and a folder takes no other kind.
 * A folder refuses the entry itself and anything under it; the folder it already sits
 * in takes nothing, since dropping there moves nothing. A file row is not a target. A
 * taken name is the daemon's to refuse (409), and its sentence is what shows.
 *
 * The rules (`moveInto`, `canDrop`) are pure: no DOM, no React, no fetch, so files/verify.ts
 * runs them under Node. `moveEntry` is the call.
 */

import type { RenameResponse } from '@conductor/shared';
import { isUnder } from './tabs.js';
import { renameEntry } from './useWorkspace.js';
import { followRename } from './useTabs.js';

/** What a drag from the tree carries: the entry's tree path. */
export const MOVE_MIME = 'application/x-conductor-path';

/** The folder `path` sits in, as a tree path ('' is the top). */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export type MovePlan = { to: string } | { stay: true } | { refused: string };

/**
 * Where `from` lands in `folder` ('' is the top): its new path, nothing to do when it is
 * already there, or why not, in the daemon's own words (workspace/service.ts `renameOf`).
 */
export function moveInto(from: string, folder: string): MovePlan {
  if (folder === parentOf(from)) return { stay: true };
  if (isUnder(folder, from)) return { refused: `${from} cannot be moved into itself` };
  const name = from.slice(from.lastIndexOf('/') + 1);
  return { to: folder.length > 0 ? `${folder}/${name}` : name };
}

/**
 * Whether `folder` takes the drag: it is a tree drag (`types` has MOVE_MIME), it started
 * in this section (`dragging`, the dragged path, else null), and it would move something.
 */
export function canDrop(types: readonly string[], dragging: string | null, folder: string): boolean {
  if (dragging === null || !types.includes(MOVE_MIME)) return false;
  return 'to' in moveInto(dragging, folder);
}

/**
 * Move `from` into `folder`: the rename, then the tabs. Resolves to where it went, or
 * null when it was already there; rejects with the reason it could not.
 */
export async function moveEntry(root: string, from: string, folder: string): Promise<RenameResponse | null> {
  const plan = moveInto(from, folder);
  if ('stay' in plan) return null;
  if ('refused' in plan) throw new Error(plan.refused);
  const done = await renameEntry(root, from, plan.to);
  followRename(root, done.from, done.to);
  return done;
}
