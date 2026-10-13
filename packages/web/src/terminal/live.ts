/**
 * Every tab's lists of terminals, kept current by the hub (Amendment 141).
 *
 * The daemon broadcasts `{ type: 'terminals', scope, terminals }` whenever a scope's list
 * changes: one opened, exited, closed or forgotten, from this tab or another. The store hands
 * the frame here (lib/store.ts), as it hands settings to lib/settings.ts, and each terminal
 * panel listening for that scope takes the new list. A panel still asks for its list when it
 * mounts; the frames keep it current after that.
 */

import { termScopeKey, type ServerFrame, type TermInfo, type TermScope } from '@conductor/shared';

type Frame = Extract<ServerFrame, { type: 'terminals' }>;

const listeners = new Map<string, Set<(list: TermInfo[]) => void>>();

/** A `terminals` frame from the hub. */
export function receiveTerminals(frame: Frame): void {
  for (const fn of listeners.get(termScopeKey(frame.scope)) ?? []) fn(frame.terminals);
}

/** Be told a scope's new list whenever it changes. Returns the unsubscribe. */
export function onTerminals(scope: TermScope, fn: (list: TermInfo[]) => void): () => void {
  const key = termScopeKey(scope);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}
