/**
 * Your order for the Fleet cards (Amendment 54). Pure, so lib/verify.ts checks it.
 *
 * The grid used to have one order: needs-you first, then by status. That stays, as
 * **needs you first**; **your order** is the one you drag the cards into. It's the
 * `conductor.fleetOrder` setting (a list of project ids), so it's the same in every
 * browser. A project added since goes at the end, and a removed one drops out.
 *
 * The project navigator lists projects in this same order (Amendment 69): it reads the
 * same two settings and calls the same `sortFacts` and `sortProjects`, so the panel and
 * the grid can't disagree, and a new Sort by moves both at once.
 */

import type { Agent, AgentStatus, PendingRequest } from '@conductor/shared';

export const ORDER_KEY = 'conductor.fleetOrder';
export const SORT_KEY = 'conductor.fleetSort';

/** Every way the grid can be sorted — the Sort by menu (Amendment 57). */
export const SORTS = [
  { id: 'attention', label: 'needs you first', hint: 'What waits on you, then failures, then working, then the rest.' },
  { id: 'mine', label: 'my order', hint: 'The order you dragged the cards into.' },
  { id: 'name', label: 'name', hint: 'A to Z.' },
  { id: 'working', label: 'working', hint: 'Most agents working now first.' },
  { id: 'recent', label: 'recently active', hint: 'The project an agent last started or finished in first.' },
  { id: 'spend', label: 'spend', hint: 'Most spent by its agents first.' },
  { id: 'added', label: 'newest', hint: 'The project added last first.' },
] as const;
export type FleetSort = (typeof SORTS)[number]['id'];

/** What the other sorts need to know about each project, computed by `sortFacts`. */
export interface SortFacts {
  /** Needs-you rank: lower comes first. */
  rank: number;
  working: number;
  /** Epoch ms of the latest agent start or end, 0 for none. */
  lastActive: number;
  spend: number;
}

/** Worst first. The card you have to deal with should never be below the fold. */
export const SORT_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  failed: 1,
  working: 2,
  queued: 3,
  paused: 4,
  // Below paused, above done: nobody is waiting on a stopped agent, but "someone ended
  // this" is still more worth surfacing than "it finished".
  stopped: 5,
  done: 6,
};

/**
 * Each project's facts, for every sort but name, mine and newest. Rank is by the project's
 * worst agent, and a live request outranks everything (-1). This only decides ORDER;
 * each Fleet card reads useProjectStatus itself for the colour it paints, so ordering
 * can never disagree with the stripe.
 *
 * It was a `useMemo` in fleet.tsx; it is here, pure, so the navigator computes the very
 * same facts (Amendment 69). fleet.tsx still memoises the call.
 */
export function sortFacts(
  projects: readonly { id: string }[],
  agents: readonly Pick<Agent, 'projectId' | 'status' | 'costUsd' | 'startedAt' | 'endedAt'>[],
  pending: readonly Pick<PendingRequest, 'projectId'>[],
): Map<string, SortFacts> {
  const out = new Map<string, SortFacts>();
  for (const p of projects) {
    let best = SORT_RANK.done;
    let working = 0;
    let lastActive = 0;
    let spend = 0;
    for (const a of agents) {
      if (a.projectId !== p.id) continue;
      best = Math.min(best, SORT_RANK[a.status]);
      if (a.status === 'working') working += 1;
      spend += a.costUsd;
      for (const t of [a.startedAt, a.endedAt]) {
        const ms = t ? Date.parse(t) : 0;
        if (ms > lastActive) lastActive = ms;
      }
    }
    // A live request outranks everything, even a failure.
    if (pending.some((q) => q.projectId === p.id)) best = -1;
    out.set(p.id, { rank: best, working, lastActive, spend });
  }
  return out;
}

/**
 * The projects in `sort`'s order. Every sort ties on name, so two projects that compare
 * equal never swap places between renders.
 */
export function sortProjects<P extends { id: string; name: string; createdAt: string }>(
  projects: readonly P[],
  sort: FleetSort,
  order: readonly string[],
  facts: ReadonlyMap<string, SortFacts>,
): P[] {
  if (sort === 'mine') return applyOrder(projects, order);
  const f = (p: P): SortFacts => facts.get(p.id) ?? { rank: 9, working: 0, lastActive: 0, spend: 0 };
  const byName = (a: P, b: P): number => a.name.localeCompare(b.name);
  const cmp: Record<Exclude<FleetSort, 'mine'>, (a: P, b: P) => number> = {
    attention: (a, b) => f(a).rank - f(b).rank,
    name: () => 0,
    working: (a, b) => f(b).working - f(a).working,
    recent: (a, b) => f(b).lastActive - f(a).lastActive,
    spend: (a, b) => f(b).spend - f(a).spend,
    added: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  };
  return [...projects].sort((a, b) => cmp[sort](a, b) || byName(a, b));
}

export function parseOrder(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The sort in use: what you picked, else yours once you've arranged the cards. */
export function fleetSort(raw: string | null, order: string[]): FleetSort {
  if (SORTS.some((s) => s.id === raw)) return raw as FleetSort;
  return order.length > 0 ? 'mine' : 'attention';
}

/** The projects in your order; ones you haven't placed keep their order, after. */
export function applyOrder<P extends { id: string }>(projects: readonly P[], order: readonly string[]): P[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (at.get(a.p.id) ?? order.length + a.i) - (at.get(b.p.id) ?? order.length + b.i))
    .map((x) => x.p);
}

/** The order after putting `id` just before `before` — or at the end, for null. */
export function moveBefore(shown: readonly { id: string }[], id: string, before: string | null): string[] {
  const ids = shown.map((p) => p.id).filter((x) => x !== id);
  const at = before === null ? -1 : ids.indexOf(before);
  if (at < 0) ids.push(id);
  else ids.splice(at, 0, id);
  return ids;
}

/** One step earlier (-1) or later (+1), for the card's menu and the keyboard. */
export function moveBy(shown: readonly { id: string }[], id: string, step: -1 | 1): string[] {
  const ids = shown.map((p) => p.id);
  const i = ids.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return ids;
}
