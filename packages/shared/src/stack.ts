/**
 * A job's stack: its agents and who waits for whom (ADR 0002).
 *
 * A launched job doesn't remember its preset. It is a set of agent rows, each with
 * `dependsOn` (agent ids), so editing a running stack means editing those. The rules are
 * here, pure, because the daemon applies them and the browser says what they will do
 * before you press anything — one copy, so the two can't disagree.
 */

import type { AgentRole, AgentStatus } from './events.js';
import type { Agent, Autonomy } from './wire.js';

/** Just what the graph needs from an agent. */
export type StackNode = Pick<Agent, 'id' | 'dependsOn' | 'status' | 'sdkSessionId'> & {
  parentId?: string | null;
};

/** Hasn't started: no session yet, and still waiting (queued) or held before it ran (paused). */
export function notStarted(a: Pick<Agent, 'status' | 'sdkSessionId'>): boolean {
  return a.sdkSessionId === null && (a.status === 'queued' || a.status === 'paused');
}

/** One agent's new `dependsOn` after a removal. */
export interface Rewired {
  agentId: string;
  dependsOn: string[];
}

/**
 * Who waits for whom once `removedId` is gone (Amendment 88).
 *
 * Each agent that waited on it and hasn't started waits on what IT waited on instead:
 * A→B→C, remove B, and C waits on A — so its handoff comes from A. The removed agent's own
 * helpers aren't inherited (they belong to it), nor is the agent itself, and nothing is
 * listed twice. Agents that have started or ended are left alone: they are past waiting.
 */
export function rewireOnRemoval(agents: readonly StackNode[], removedId: string): Rewired[] {
  const removed = agents.find((a) => a.id === removedId);
  if (!removed) return [];
  const known = new Set(agents.map((a) => a.id));
  const inherited = removed.dependsOn.filter(
    (id) => id !== removedId && known.has(id) && agents.find((a) => a.id === id)?.parentId !== removedId,
  );
  const out: Rewired[] = [];
  for (const a of agents) {
    if (a.id === removedId || !a.dependsOn.includes(removedId) || !notStarted(a)) continue;
    const next: string[] = [];
    for (const id of a.dependsOn) {
      for (const d of id === removedId ? inherited : [id]) {
        if (d !== a.id && !next.includes(d)) next.push(d);
      }
    }
    out.push({ agentId: a.id, dependsOn: next });
  }
  return out;
}

/** A dependency that won't finish on its own: the user has to act on it first. */
const NEEDS_USER: ReadonlySet<AgentStatus> = new Set(['paused', 'failed', 'stopped']);

/**
 * Whether a queued agent can't start without the user (Amendment 88): something it waits
 * on, directly or further up, is paused, failed, stopped or gone. A helper that failed or
 * was stopped has still ended for its own orchestrator (Amendment 51), so it doesn't count.
 *
 * The roll-up counts such an agent as settled, so a job always settles once nothing in it
 * can move on by itself.
 */
export function isStuck(agent: StackNode, agents: readonly StackNode[]): boolean {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const stuck = (a: StackNode): boolean => {
    if (a.status !== 'queued' || seen.has(a.id)) return false;
    seen.add(a.id);
    for (const id of a.dependsOn) {
      const dep = byId.get(id);
      // Gone. One that had started passed this gate already; one that hadn't can't now.
      if (!dep) {
        if (a.sdkSessionId === null) return true;
        continue;
      }
      if (dep.status === 'done') continue;
      if (dep.parentId === a.id && (dep.status === 'failed' || dep.status === 'stopped')) continue;
      if (NEEDS_USER.has(dep.status)) return true;
      if (stuck(dep)) return true;
    }
    return false;
  };
  return stuck(agent);
}

/**
 * Whether adding an agent that waits on `dependsOn` and feeds `feeds` would close a loop
 * (Amendment 89). Only a fed agent can be upstream of the new one, so it is a loop exactly
 * when one of `feeds` is in `dependsOn`, or is something those wait on, however far up.
 */
export function createsCycle(agents: readonly Pick<StackNode, 'id' | 'dependsOn'>[], dependsOn: readonly string[], feeds: readonly string[]): boolean {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const upstream = new Set<string>();
  const walk = (id: string): void => {
    if (upstream.has(id)) return;
    upstream.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) walk(d);
  };
  for (const id of dependsOn) walk(id);
  return feeds.some((f) => upstream.has(f));
}

/**
 * Roles whose entire job is to read (Amendment 41), here since Amendment 89 so the daemon
 * checks an added agent against the same list Spawn pins.
 *
 * EVERY NEW READING ROLE BELONGS HERE. Forgetting is silent in the worst way: the
 * agent still runs, the plan preview still says it writes nothing, and it writes.
 * A list is easier to audit than a condition, which is why this is a Set and not
 * four `||`s. 'auditor' stays after leaving the analysis preset: agents launched as
 * one still exist, and their role is what they were promised.
 */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(['reviewer', 'debugger', 'analyst', 'auditor']);

/** Whether this role writes nothing. */
export function isReadOnlyRole(role: AgentRole): boolean {
  return READ_ONLY_ROLES.has(role);
}

/**
 * The file-mutating tools, denied outright for a reading role. `disallowedTools` is the
 * only setting that holds in every permission mode, so it is what carries the promise.
 */
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Why `autonomy` doesn't keep a reading role read-only, or null when it does: the write
 * tools denied, and a mode that changes nothing unasked (plan, or ask me).
 */
export function readOnlyRefusal(role: AgentRole, autonomy: Pick<Autonomy, 'mode' | 'disallowedTools'>): string | null {
  if (!isReadOnlyRole(role)) return null;
  const missing = WRITE_TOOLS.filter((t) => !autonomy.disallowedTools.includes(t));
  if (missing.length > 0) return `${role} is a reading role, so ${missing.join(', ')} must be in disallowedTools`;
  if (autonomy.mode !== 'plan' && autonomy.mode !== 'default') {
    return `${role} is a reading role, so its mode is plan or default, not ${autonomy.mode}`;
  }
  return null;
}

/**
 * The agents that wait for `agentId`: the ones its `hand_off` is for. Its orchestrator is
 * not one of them (it waits for its helpers by a different road, Amendment 51), and a
 * helper hands its reply to the agent that started it, not to a stack. Pure and shared, so
 * the daemon (which gives the agent the tool) and Needs You (which says who is waiting) agree.
 */
export function waitersOf<T extends { id: string; dependsOn: readonly string[] }>(
  agentId: string,
  jobAgents: readonly (T & { parentId?: string | null })[],
): T[] {
  const me = jobAgents.find((a) => a.id === agentId);
  return jobAgents.filter((a) => a.dependsOn.includes(agentId) && me?.parentId !== a.id);
}

