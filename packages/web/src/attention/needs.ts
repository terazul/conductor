/**
 * What the Agent screen's Needs you panel shows, and the state each of its cards keeps
 * (Amendment 108, ADR 0007). Pure, and it imports no CSS or React, so
 * ./verify-needs-panel.ts checks it under Node. ./NeedsPanel.tsx re-exports `needsFor`.
 */

import { NO_COMPOSER, emptyDraft, type Composer, type QuestionDraft } from './interaction.js';

/**
 * Everything waiting on one agent, and only that agent (the user's choice, 9 Oct): its
 * requests, then the alerts that name it. Each oldest first, the way the Needs you screen
 * orders them. The sort is stable, so two made in the same millisecond keep their order.
 */
export function needsFor<
  P extends { agentId: string; createdAt: string },
  A extends { agentIds: readonly string[]; since: string },
>(agentId: string, pending: readonly P[], alerts: readonly A[]): { requests: P[]; alerts: A[] } {
  const at = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return {
    requests: pending.filter((r) => r.agentId === agentId).sort((x, y) => at(x.createdAt) - at(y.createdAt)),
    alerts: alerts.filter((a) => a.agentIds.includes(agentId)).sort((x, y) => at(x.since) - at(y.since)),
  };
}

/**
 * One request card's own state. The Needs you screen keeps one of these for its single
 * focused request; the panel shows them all at once, so each card has its own.
 */
export interface CardState {
  composer: Composer;
  draft: QuestionDraft;
  cursor: { q: number; o: number };
}

export function freshCard(): CardState {
  return { composer: NO_COMPOSER, draft: emptyDraft(), cursor: { q: 0, o: 0 } };
}

/**
 * Drop the state of requests that have left: answered and resolved, or gone with their
 * agent. The same map back when nothing left, so React sees no change.
 */
export function pruneCards<T>(cards: ReadonlyMap<string, T>, liveIds: readonly string[]): ReadonlyMap<string, T> {
  const live = new Set(liveIds);
  let changed = false;
  const next = new Map<string, T>();
  for (const [id, st] of cards) {
    if (live.has(id)) next.set(id, st);
    else changed = true;
  }
  return changed ? next : cards;
}
