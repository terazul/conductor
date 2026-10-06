/**
 * Editing a running stack (ADR 0002, Amendments 88 and 89): one more agent in a job, and
 * what removing one does to the agents that waited on it. Pure, so spawn/verify.ts checks
 * the rules under Node.
 *
 * A launched job doesn't remember its preset, so everything here reads the job's agents:
 * who waits for whom, which engine they run on, what permissions and cap they were given.
 * The graph rules themselves (`rewireOnRemoval`, `createsCycle`, `isReadOnlyRole`) are
 * shared/src/stack.ts's, the daemon's own, so this can't promise what it won't do.
 */

import type { AddAgentRequest, Agent, AgentRole, Autonomy } from '@conductor/shared';
import { WRITE_TOOLS, createsCycle, isReadOnlyRole, rewireOnRemoval } from '@conductor/shared';
import { CLAUDE, parseTokens, providerOf } from '../lib/providers.js';
import { DEFAULT_BUDGET_USD, DEFAULT_MODE, defaultPills, toAutonomy } from './autonomy.js';
import { DEFAULT_BUDGET_TOKENS } from './engine.js';
import type { PersonaTools, Persona } from './personas.js';

const ROLE = /^[a-z][a-z0-9-]{0,30}$/;

/** "a", "a and b", "a, b and c". */
function and(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/**
 * What removing `removedId` does to who waits for whom, as the confirm says it: "scribe will
 * wait for architect instead." One sentence per agent that moves; '' when none does.
 */
export function rewirePreview(agents: readonly Agent[], removedId: string): string {
  const role = (id: string): string => agents.find((a) => a.id === id)?.role ?? 'an agent';
  return rewireOnRemoval(agents, removedId)
    .map((r) => {
      const a = agents.find((x) => x.id === r.agentId);
      const who = a?.role ?? 'an agent';
      const pending = r.dependsOn.filter((id) => agents.find((x) => x.id === id)?.status !== 'done');
      // Paused for some other reason than this one being stopped, it stays paused.
      if (a?.status === 'paused' && !(agents.find((x) => x.id === removedId)?.status === 'stopped')) {
        return r.dependsOn.length === 0
          ? `${who} stays paused, and will wait for no one.`
          : `${who} stays paused, and will wait for ${and(r.dependsOn.map(role))} instead.`;
      }
      if (pending.length === 0) {
        return r.dependsOn.length === 0
          ? `${who} will start, waiting for no one.`
          : `${who} will start: ${and(r.dependsOn.map(role))} ${r.dependsOn.length === 1 ? 'is' : 'are'} done.`;
      }
      return `${who} will wait for ${and(r.dependsOn.map(role))} instead.`;
    })
    .join(' ');
}

/** One more agent, as the row editor holds it. */
export interface AddDraft {
  role: AgentRole;
  brief: string;
  /** The persona's id; '' is none, chosen; absent is the persona of the role's name. */
  persona?: string;
  dependsOnRoles: AgentRole[];
  /** Roles of agents that haven't started, which should wait for this one too. */
  feeds: AgentRole[];
  model: string;
  /** As typed: dollars on an engine that reports them, tokens (`500k`, `2M`) otherwise. */
  budget: string;
}

const own = (agents: readonly Agent[]): Agent[] => agents.filter((a) => !a.parentId);

/** Who it can wait for: the job's agents, not helpers, and not one that was stopped. */
export function waitOptions(agents: readonly Agent[]): Agent[] {
  return own(agents).filter((a) => a.status !== 'stopped');
}

/** Who it can feed: the job's agents that haven't started — queued, with no session. */
export function feedOptions(agents: readonly Agent[]): Agent[] {
  return own(agents).filter((a) => a.status === 'queued' && a.sdkSessionId === null);
}

/** The job's engine: what its agents run on. Claude for a job with none left. */
export function jobEngine(agents: readonly Agent[]): string {
  const first = own(agents)[0];
  return first ? providerOf(first) : CLAUDE;
}

/** Whether the role, with its persona, writes nothing — as `readsOnly` says for Spawn. */
function readsOnly(role: AgentRole, persona: Persona | undefined): boolean {
  return isReadOnlyRole(role) || persona?.tools.write === false;
}

/** Whether a launched agent was pinned to read: a reading role, or the write tools denied. */
const reads = (a: Agent): boolean => isReadOnlyRole(a.role) || WRITE_TOOLS.every((t) => a.autonomy.disallowedTools.includes(t));

/**
 * The sibling an added agent takes its model, cap and permissions from: one that reads
 * alike, else one that writes, else any. (A reader's permissions are never a writer's:
 * `addedAutonomy` checks.)
 */
export function templateFor(agents: readonly Agent[], role: AgentRole, persona?: Persona): Agent | undefined {
  const siblings = own(agents);
  const alike = siblings.find((a) => reads(a) === readsOnly(role, persona));
  return alike ?? siblings.find((a) => !reads(a)) ?? siblings[0];
}

/** What the cap field starts at: the template's cap, else Spawn's default. */
export function budgetDefault(agents: readonly Agent[], role: AgentRole, usd: boolean): string {
  const t = templateFor(agents, role)?.autonomy;
  if (usd) return String(t?.budgetUsd ?? DEFAULT_BUDGET_USD);
  return String(t?.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
}

/** A persona's tool rules over an autonomy, as `pillsWith` puts them over Spawn's pills. */
function withTools(a: Autonomy, t: PersonaTools): Autonomy {
  let allowed = [...a.allowedTools];
  let denied = [...a.disallowedTools];
  const allow = (tool: string, on: boolean): void => {
    allowed = allowed.filter((x) => x !== tool);
    if (on) allowed.push(tool);
  };
  const deny = (tool: string, on: boolean): void => {
    denied = denied.filter((x) => x !== tool);
    if (on) denied.push(tool);
  };
  if (t.bash !== undefined) allow('Bash', t.bash);
  if (t.mcp !== undefined) allow('mcp__*', t.mcp);
  if (t.push !== undefined) deny('Bash(git push:*)', !t.push);
  if (t.network !== undefined) {
    for (const tool of ['WebFetch', 'WebSearch']) {
      allow(tool, t.network);
      deny(tool, !t.network);
    }
  }
  return { ...a, allowedTools: allowed, disallowedTools: denied };
}

/**
 * The added agent's autonomy: a sibling's that reads alike (the job's pills, as launched),
 * its persona's tool rules over it, then pinned read-only for a reading role or persona the
 * way `toAgentSpecs` pins one, and its own cap. Spawn's defaults when the job has nobody.
 */
export function addedAutonomy(
  agents: readonly Agent[],
  role: AgentRole,
  persona: Persona | undefined,
  cap: { usd: number } | { tokens: number },
): Autonomy {
  const t = templateFor(agents, role, persona);
  // A writer in a job of readers can't take a reader's pin: Spawn's defaults, then.
  const base = t && (readsOnly(role, persona) || !reads(t)) ? t.autonomy : toAutonomy(defaultPills(), null, undefined, DEFAULT_MODE);
  let a: Autonomy = persona ? withTools(base, persona.tools) : { ...base };
  if (readsOnly(role, persona)) {
    a = {
      ...a,
      mode: a.mode === 'plan' ? 'plan' : 'default',
      // MCP tools can change things outside the folder, so a reading role has none (Amendment 67).
      allowedTools: a.allowedTools.filter((t) => t !== 'Bash' && t !== 'mcp__*'),
      disallowedTools: [...a.disallowedTools.filter((t) => !WRITE_TOOLS.includes(t)), ...WRITE_TOOLS],
    };
  }
  const { budgetTokens: _was, ...rest } = a;
  return 'usd' in cap ? { ...rest, budgetUsd: cap.usd } : { ...rest, budgetUsd: null, budgetTokens: cap.tokens };
}

/** The cap as typed, in the engine's unit, or why it can't be one. Required: no "uncapped". */
export function parseCap(text: string, usd: boolean): { usd: number } | { tokens: number } | { why: string } {
  if (usd) {
    const n = Number(text.trim().replace(/^\$/, ''));
    return text.trim() !== '' && Number.isFinite(n) && n > 0 ? { usd: n } : { why: 'Give it a budget in dollars, more than 0 — every agent has a cap of its own.' };
  }
  const t = parseTokens(text);
  if ('why' in t) return t;
  return t.cap === null ? { why: 'Give it a budget in tokens, like 500k or 2M — every agent has a cap of its own.' } : { tokens: t.cap };
}

/** What's wrong with the draft, one sentence each, before the daemon is asked. Empty: it can be added. */
export function addAgentProblems(draft: AddDraft, agents: readonly Agent[], usd: boolean): string[] {
  const out: string[] = [];
  if (!ROLE.test(draft.role)) out.push('A role is lowercase letters, digits and dashes, starting with a letter.');
  else if (agents.some((a) => a.role === draft.role)) out.push(`${draft.role} is already in this job. Name it apart, like ${draft.role}-2.`);
  const byRole = new Map(agents.map((a) => [a.role, a]));
  for (const r of draft.dependsOnRoles) {
    const a = byRole.get(r);
    if (!a) out.push(`${r} is not in this job.`);
    else if (a.status === 'stopped') out.push(`${r} was stopped, so it won't finish: don't wait for it.`);
  }
  for (const r of draft.feeds) {
    const a = byRole.get(r);
    if (!a || !feedOptions(agents).includes(a)) out.push(`${r} has already started, so it can't wait for this one.`);
  }
  const ids = (roles: readonly AgentRole[]): string[] => roles.flatMap((r) => byRole.get(r)?.id ?? []);
  if (createsCycle(agents, ids(draft.dependsOnRoles), ids(draft.feeds))) {
    out.push('It would wait for an agent that waits for it: a loop nothing could start.');
  }
  if (!draft.model.trim()) out.push('Pick a model.');
  const cap = parseCap(draft.budget, usd);
  if ('why' in cap) out.push(cap.why);
  return out;
}

/**
 * The request for `POST /api/jobs/:jobId/agents`. Call it once `addAgentProblems` is empty;
 * the persona's brief is the row's unless one was typed, as on Spawn's Custom setup.
 */
export function addAgentSpec(draft: AddDraft, agents: readonly Agent[], persona: Persona | undefined, usd: boolean): AddAgentRequest {
  const cap = parseCap(draft.budget, usd);
  const engine = jobEngine(agents);
  const brief = draft.brief.trim() || persona?.brief.trim() || '';
  return {
    role: draft.role,
    model: draft.model.trim(),
    ...(brief ? { brief } : {}),
    dependsOnRoles: draft.dependsOnRoles,
    ...(draft.feeds.length > 0 ? { feeds: draft.feeds } : {}),
    autonomy: addedAutonomy(agents, draft.role, persona, 'why' in cap ? { usd: 0 } : cap),
    ...(persona ? { persona: persona.id } : {}),
    ...(persona?.systemPrompt ? { systemPrompt: persona.systemPrompt } : {}),
    ...(persona && persona.skills.length > 0 ? { skills: persona.skills } : {}),
    ...(engine !== CLAUDE ? { provider: engine } : {}),
  };
}
