/**
 * A Fleet card's list of agents, open or folded, kept per card (Amendment 173).
 *
 * Every card listed every agent, so a project with a twelve-helper stack was a card twelve
 * rows tall. The list now folds under one toggle, "▸ 12 agents", and STARTS FOLDED: a card's
 * project id in the set means you opened it, as a navigator fold's does (Amendment 169). The
 * set is the navigator's kind, read and written by the very functions it uses (`parseOpen`,
 * `toggleOpen`, `serializeOpen`, shell/navtree.ts), under its own key, so a card and a
 * navigator node can never share an id and opening one never opens the other.
 *
 * NOTHING THAT NEEDS YOU IS FOLDED AWAY. An agent with a request waiting, a `blocked` status,
 * or an alert naming it (the navigator's `needs`, agent/tabs.ts:63) keeps its row while the
 * list is folded, and the toggle counts them: "▸ 12 agents · 1 needs you".
 *
 * Pure: no DOM, no React, no storage. lib/verify.ts checks it under Node.
 */

import type { Agent, PendingRequest } from '@conductor/shared';
import { isOpen, parseOpen, serializeOpen, toggleOpen } from '../shell/navtree.js';

/** Which cards' agent lists are open: a JSON array of project ids. */
export const FLEET_AGENTS_KEY = 'conductor.fleetAgents';

/** Whether this card's list is open. Nothing stored is every card folded. */
export function agentsOpen(raw: string | null, projectId: string): boolean {
  return isOpen(parseOpen(raw), projectId);
}

/** What to store once this card's list is opened or folded; every other card as it was. */
export function toggleAgents(raw: string | null, projectId: string): string | null {
  return serializeOpen(toggleOpen(parseOpen(raw), projectId));
}

/** A request waits on it, it is blocked (the row's `shownStatus`), or an alert names it. */
export function needsYou(
  agent: Pick<Agent, 'id' | 'status'>,
  pending: readonly Pick<PendingRequest, 'agentId'>[],
  alerts: readonly { agentIds: readonly string[] }[],
): boolean {
  return (
    agent.status === 'blocked' ||
    pending.some((p) => p.agentId === agent.id) ||
    alerts.some((x) => x.agentIds.includes(agent.id))
  );
}

/** The rows the card draws: all of them when open, only those that need you when folded. */
export function shownAgents<A extends Pick<Agent, 'id' | 'status'>>(
  agents: readonly A[],
  open: boolean,
  pending: readonly Pick<PendingRequest, 'agentId'>[],
  alerts: readonly { agentIds: readonly string[] }[],
): A[] {
  return open ? [...agents] : agents.filter((a) => needsYou(a, pending, alerts));
}

/** The toggle's words: "3 agents", "1 agent · 1 needs you", "5 agents · 2 need you". */
export function agentsToggleWords(total: number, needing: number): string {
  const count = total === 1 ? '1 agent' : `${total} agents`;
  return needing === 0 ? count : `${count} · ${needing} ${needing === 1 ? 'needs' : 'need'} you`;
}
