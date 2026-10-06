/**
 * A job's lanes, with each orchestrator's helpers right after it (Amendment 51). Pure,
 * so lib/verify.ts checks it.
 *
 * The user chose "nested under the orchestrator" over a flat lane: a helper means little
 * apart from the agent that started it, and six lanes reading builder-helper-N in
 * creation order would bury whose they are.
 */

import type { Agent } from '@conductor/shared';

export interface LaneSlot {
  agent: Agent;
  /** The orchestrator's role, on a helper's lane. */
  helperOf: string | null;
}

export function nestHelpers(agents: readonly Agent[]): LaneSlot[] {
  const ids = new Set(agents.map((a) => a.id));
  // A helper whose orchestrator isn't in this list (removed) stands on its own.
  const isNested = (a: Agent): boolean => Boolean(a.parentId && ids.has(a.parentId));
  const out: LaneSlot[] = [];
  const place = (a: Agent, helperOf: string | null): void => {
    out.push({ agent: a, helperOf });
    for (const h of agents) if (h.parentId === a.id) place(h, a.role);
  };
  for (const a of agents) if (!isNested(a)) place(a, null);
  return out;
}
