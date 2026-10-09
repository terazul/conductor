/**
 * "This project's branches changed", from the daemon's `branches` frame (Amendment 109).
 *
 * The frame carries only a project id: the screen re-reads the branches itself, so the
 * store keeps nothing about them. `lib/store.ts` hands each frame here, the way it hands
 * settings to `lib/settings.ts`, and the Branches screen listens while it is mounted.
 */

type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();

/** Called by lib/store.ts for each `branches` frame. */
export function receiveBranches(projectId: string): void {
  for (const fn of listeners) fn(projectId);
}

/** Hear about every project's branch changes. Returns the unsubscribe. */
export function onBranchesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
