/**
 * Re-run from here: which agents go again when one agent's reply has changed (Amendment 102).
 *
 * You talk to an agent after it has finished, and what it says now is not what the agents
 * after it were given. A button on that agent starts them again, each in its own
 * conversation, told that its input changed. It is manual on purpose: a chat with the
 * architect must not re-run the whole stack on every message.
 *
 * The rules are here, pure, for the reason `stack.ts` gives: the daemon applies them and the
 * browser says what they will do before you press anything — one copy, so the two can't
 * disagree.
 *
 * "After it" is everything downstream, however far: an agent that waits for it, one that
 * waits for that one, and so on. Helpers aren't in the stack (their orchestrator decides
 * when they run), so the walk doesn't go through them; a re-run agent's helpers that are
 * still working are stopped with it.
 */

import type { AgentStatus } from './events.js';
import type { Agent } from './wire.js';

/** Just what the plan needs from an agent. */
export type RerunNode = Pick<Agent, 'id' | 'role' | 'dependsOn' | 'status' | 'sdkSessionId'> & {
  parentId?: string | null;
};

/**
 * What happens to one agent after it:
 *  - `resume`: back into its own session, told its input changed.
 *  - `start`: it failed before it had a session, so it starts from its prompt, which now
 *    carries the new reply.
 *  - `wait`: it hasn't started yet. It is left as it is and reads the new reply when it does.
 */
export type RerunAction = 'resume' | 'start' | 'wait';

export interface RerunStep {
  agentId: string;
  role: Agent['role'];
  status: AgentStatus;
  action: RerunAction;
  /** Running now (working, or held on a question): its input is stale, so it is stopped first. */
  stops: boolean;
  /** Roles of its helpers that are still running, which are stopped with it. */
  stopsHelpers: string[];
  /** Roles of the agents after the first that it waits for: it goes again once they are done again. */
  after: string[];
}

export interface RerunPlan {
  /** The agent whose reply changed. */
  from: { id: string; role: Agent['role'] };
  /** Everything after it, in dependency order: an agent comes after every agent it waits for. */
  steps: RerunStep[];
  /** Why it can't be done, or null. A sentence the person reads. */
  refusal: string | null;
}

/** Statuses of an agent that is in the middle of something. */
const RUNNING: ReadonlySet<AgentStatus> = new Set(['working', 'blocked']);
/** Statuses of an agent that has ended. */
const ENDED: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);

/** Why `agent` can't hand its reply on yet, or null when it can. */
function notReady(agent: RerunNode, hasReply: boolean): string | null {
  const who = agent.role;
  switch (agent.status) {
    case 'done':
      return hasReply ? null : `${who} has not written a reply yet, so there is nothing to pass on.`;
    case 'working':
    case 'blocked':
    case 'queued':
      return `${who} is still ${agent.status === 'working' ? 'working' : agent.status === 'blocked' ? 'waiting for you' : 'waiting to run'}. Re-run once it has finished its reply.`;
    case 'paused':
      return `${who} is paused. Resume it, and re-run once it has finished its reply.`;
    case 'failed':
      return `${who} failed, so its last reply may be unfinished. Continue it, and re-run once it is done.`;
    case 'stopped':
      return `${who} was stopped, so it has no finished reply to pass on.`;
  }
}

/**
 * What re-running from `rootId` would do. `hasReply` is whether the agent has written any
 * prose: a plan from nothing would hand the others an empty reply.
 */
export function rerunPlan(agents: readonly RerunNode[], rootId: string, opts: { hasReply: boolean }): RerunPlan {
  const root = agents.find((a) => a.id === rootId);
  if (!root) return { from: { id: rootId, role: 'agent' as Agent['role'] }, steps: [], refusal: 'No such agent.' };
  const from = { id: root.id, role: root.role };
  const refuse = (refusal: string): RerunPlan => ({ from, steps: [], refusal });

  if (root.parentId) return refuse(`${root.role} is a helper: the agent that started it decides when it runs.`);

  // Everything after it: waits for it, or for something that does. Helpers aren't in the stack.
  const own = agents.filter((a) => !a.parentId);
  const down = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of own) {
      if (a.id === rootId || down.has(a.id)) continue;
      if (a.dependsOn.some((d) => d === rootId || down.has(d))) {
        down.add(a.id);
        grew = true;
      }
    }
  }
  if (down.size === 0) return refuse(`No agent comes after ${root.role}, so there is nothing to re-run.`);

  // In dependency order, the job's own order where it doesn't matter.
  const queue = own.filter((a) => down.has(a.id));
  const ordered: RerunNode[] = [];
  const placed = new Set<string>();
  while (queue.length > 0) {
    const i = queue.findIndex((a) => a.dependsOn.every((d) => !down.has(d) || placed.has(d)));
    const [next] = queue.splice(i < 0 ? 0 : i, 1);
    ordered.push(next!);
    placed.add(next!.id);
  }

  const roleOf = new Map(agents.map((a) => [a.id, a.role]));
  const steps: RerunStep[] = [];
  // The first thing in the way of an agent after it. Steps are kept even when something is
  // in the way, so the screen can still say who is after it and why it can't go.
  let inTheWay: string | null = null;
  for (const a of ordered) {
    const running = RUNNING.has(a.status);
    if (a.status === 'stopped') {
      inTheWay ??= `${a.role} was stopped, and the agents after it would wait for it for good. Remove it from the stack first, then re-run.`;
    } else if (a.sdkSessionId === null && running) {
      inTheWay ??= `${a.role} is only just starting. Try again in a moment.`;
    }
    const action: RerunAction =
      a.sdkSessionId !== null ? 'resume' : a.status === 'queued' || a.status === 'paused' || running || a.status === 'stopped' ? 'wait' : 'start';
    steps.push({
      agentId: a.id,
      role: a.role,
      status: a.status,
      action,
      stops: running && a.sdkSessionId !== null,
      stopsHelpers:
        action === 'wait'
          ? []
          : agents.filter((h) => h.parentId === a.id && !ENDED.has(h.status)).map((h) => h.role),
      after: a.dependsOn.filter((d) => down.has(d)).map((d) => roleOf.get(d) ?? 'an agent'),
    });
  }

  const refusal =
    notReady(root, opts.hasReply) ??
    inTheWay ??
    (steps.every((s) => s.action === 'wait')
      ? `None of the agents after ${root.role} has started, so each will read its new reply when it does.`
      : null);
  return { from, steps, refusal };
}

/** What `POST /api/agents/:id/rerun` did, step by step. */
export interface RerunResponse {
  from: string;
  agents: { agentId: string; role: Agent['role']; action: RerunAction; stopped: boolean }[];
}
