/**
 * A job's stack: its agents and who waits for whom (ADR 0002).
 *
 * A launched job doesn't remember its preset. It is a set of agent rows, each with
 * `dependsOn` (agent ids), so editing a running stack means editing those. The rules are
 * here, pure, because the daemon applies them and the browser says what they will do
 * before you press anything — one copy, so the two can't disagree.
 */

import type { AgentRole, AgentStatus } from './events.js';
import type { Agent, Autonomy, HelperRole, ModelTier } from './wire.js';

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


// ─────────────────────────────────────────────────────────────────────────────
// Orchestrated stacks (Amendment 128)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An orchestrated stack: one agent, the orchestrator, starts the others one after another,
 * reads what each did, and writes the next one's brief. The roles it may start are listed
 * before launch (`AgentSpec.helperRoles`), each with the tier it runs on. The rules are here,
 * pure and shared, so the daemon that enforces them and the screens that say them agree.
 */

/** The roles an orchestrated stack lists unless you change them, in the order they run. */
export const DEFAULT_PIPELINE_ROLES: readonly string[] = ['developer', 'validator', 'reviewer', 'scribe'];

/** How many roles a stack can list. */
export const PIPELINE_ROLES_MAX = 8;

/**
 * How many times the orchestrator may send a lane's work back (start it again, as the
 * developer after a failed review) before it must ask the user. A lane is a role and the name
 * it was started with (Amendment 150): it is started once, so the most starts of one lane is
 * one more than this. A new name is new work, its own lane.
 */
export const SEND_BACKS_MAX = 2;

/**
 * How many helpers a stack listing `roles` roles may start in all, unless the launch chose
 * another number: each role once, and sent back as often as allowed.
 */
export function pipelineHelperCap(roles: number): number {
  return roles * (1 + SEND_BACKS_MAX);
}

/**
 * The most helpers an orchestrated stack may be launched to start in all (Amendment 150): a
 * plan of many lanes needs more than each role once and sent back twice. Spawn offers up to it
 * ("helpers in all"), and the daemon refuses more. An ordinary orchestrator is still held to
 * HELPERS_MAX.
 */
export const PIPELINE_HELPERS_MAX = 48;

/**
 * The name a helper is stored under, from the `name` the orchestrator gave `start_helper`:
 * lowercase, runs of anything else as one dash, at most 24 characters. '' for no name. It is
 * also what makes two starts one lane (Amendment 150): the same role with the same name.
 */
export function helperSlug(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/** "a", "a and b", "a, b and c". */
function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** What the orchestrator is told to do when a sentence below stops it: put the question to the user. */
const ASK_THE_USER = 'ask the user with the question tool (AskUserQuestion, or ask_user)';

/**
 * Why `asked` is not a role this orchestrator may start, or null when it is. `listed` is the
 * ids it was launched with; empty is an ordinary orchestrator, whose helpers have no role and
 * run with its model and permissions, as they always did.
 */
export function roleRefusal(asked: string | undefined, listed: readonly string[], who = 'this agent'): string | null {
  const want = (asked ?? '').trim().toLowerCase();
  if (listed.length === 0) {
    return want
      ? `${who} was not launched with roles to start, so start_helper takes no role here: leave it out and the helper runs with your model and permissions.`
      : null;
  }
  if (!want) return `This stack lists the roles you may start: ${andList(listed)}. Say which one with role.`;
  if (!listed.includes(want)) {
    return (
      `"${asked?.trim()}" is not one of the roles this stack lists. You may start: ${andList(listed)}. ` +
      `If the work needs another kind of agent, ${ASK_THE_USER}.`
    );
  }
  return null;
}

/** Whether `asked` is the id of a listed role, after the same trim and case-fold `roleRefusal` applies. */
export function listedRole<T extends { id: string }>(asked: string | undefined, listed: readonly T[]): T | undefined {
  const want = (asked ?? '').trim().toLowerCase();
  return want ? listed.find((r) => r.id === want) : undefined;
}

/**
 * Why a lane may not be started again, or null when it may. `started` is how many helpers of
 * this role the orchestrator has started under this name (`lane`, as `helperSlug` stores it;
 * '' or absent for the role's unnamed lane), ended or not (Amendment 150). The first start is
 * the work; every one after it is a send-back, and the third is where it must ask.
 */
export function sendBackRefusal(role: string, started: number, lane?: string): string | null {
  if (started < 1 + SEND_BACKS_MAX) return null;
  const who = lane ? `the ${role} for “${lane}”` : `the ${role}`;
  return (
    `You have started ${who} ${started} times: once, and then you sent its work back ${SEND_BACKS_MAX} times, ` +
    'which is the most you may. Do not start it again. Ask the user with the question tool (AskUserQuestion, or ask_user): ' +
    'say what keeps failing, and ask whether to go on, change the brief, or stop.'
  );
}

/** The tiers from the cheapest up, which is how far a helper may be moved down from the one listed. */
export const TIER_ORDER: readonly ModelTier[] = ['haiku', 'sonnet', 'opus'];

const isTier = (t: string): t is ModelTier => (TIER_ORDER as readonly string[]).includes(t);

/**
 * The model a helper of `role` runs on. With no `asked` tier it is the listed one. The
 * orchestrator may ask for a cheaper tier than the user listed, never a dearer one: the tier in
 * Spawn is what the user chose to spend on that role.
 */
export function helperModel(
  role: Pick<HelperRole, 'id' | 'tier' | 'model' | 'tiers'>,
  asked: unknown,
): { model: string; tier?: ModelTier } | { why: string } {
  const listed = role.tier;
  if (asked === undefined || asked === null || asked === '') return { model: role.model, ...(listed ? { tier: listed } : {}) };
  const want = typeof asked === 'string' ? asked.trim().toLowerCase() : '';
  if (!isTier(want)) return { why: `tier is opus, sonnet or haiku, not ${JSON.stringify(asked)}. Leave it out to use the listed one.` };
  if (!listed || !role.tiers) {
    return { why: `${role.id} runs on ${role.model}, and this engine has no tiers to choose between. Leave tier out.` };
  }
  if (want === listed) return { model: role.model, tier: listed };
  if (TIER_ORDER.indexOf(want) > TIER_ORDER.indexOf(listed)) {
    // The listed tier and the cheaper ones, dearest first: what it may ask for.
    const allowed = TIER_ORDER.slice(0, TIER_ORDER.indexOf(listed) + 1).reverse();
    return {
      why: `The user put ${role.id} on ${listed}, so you may start it on ${andList(allowed)}, not on ${want}. Leave tier out to use ${listed}.`,
    };
  }
  const id = role.tiers[want];
  if (!id) return { why: `The model API serves no ${want} model right now, so ${role.id} cannot run on it. Leave tier out to use ${role.model}.` };
  return { model: id, tier: want };
}

/**
 * Whether the orchestrator of a stack of `agents` agents (itself and the ones it runs) is
 * shown as one. One agent needs no orchestrator, so nothing marks it and nothing offers the
 * affordance: the launch is one plain agent. The one rule Spawn's plan, Fleet and Project
 * lanes and the Agent tabs all ask.
 */
export function showsOrchestrator(agents: number): boolean {
  return agents >= 2;
}

/**
 * How many agents the orchestrator `a` has in its stack: itself, and either the roles it was
 * launched with or the helpers it has started, whichever is more.
 */
export function orchestratedSize(
  a: Pick<Agent, 'id' | 'pipelineRoles'>,
  jobAgents: readonly Pick<Agent, 'parentId'>[],
): number {
  const started = jobAgents.filter((x) => x.parentId === a.id).length;
  return 1 + Math.max(a.pipelineRoles?.length ?? 0, started);
}

/**
 * Whether `a` is marked as an orchestrator: the one agent of an orchestrated stack that starts
 * the others, in a stack of two or more. A helper never is.
 */
export function marksOrchestrator(
  a: Pick<Agent, 'id' | 'pipelineRoles' | 'parentId'>,
  jobAgents: readonly Pick<Agent, 'parentId'>[],
): boolean {
  return !a.parentId && (a.pipelineRoles?.length ?? 0) > 0 && showsOrchestrator(orchestratedSize(a, jobAgents));
}

/**
 * Whether helpers of this role cannot change files: a reading role (`READ_ONLY_ROLES`), or one
 * whose rope has the write tools denied, as a reading persona's does (Amendment 68). What the
 * orchestrator's prompt and its `start_helper` tell it, and what Spawn marks read-only.
 */
export function helperReads(role: Pick<HelperRole, 'id' | 'autonomy'>): boolean {
  return isReadOnlyRole(role.id) || WRITE_TOOLS.every((t) => role.autonomy.disallowedTools.includes(t));
}
