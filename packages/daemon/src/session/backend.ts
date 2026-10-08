/**
 * What the supervisor needs from an agent engine (Amendment 72).  TRACK A.
 *
 * Every agent used to be a Claude Code session, driven by runner.ts. This is the seam
 * PLAN.md §11.4 reserved for "bring your own agent", widened so a job can also run on
 * GitHub Copilot or on OpenRouter (docs/plans/multi-provider-backends.md). It is exactly
 * the surface the supervisor already used — nothing new is asked of the Claude engine —
 * plus what a backend can and cannot do, so the screens can say so instead of offering a
 * control that silently does nothing.
 *
 * Everything downstream of a backend speaks EventPayload, as it always has.
 */

import type { Autonomy } from '@conductor/shared';
import type { DeferredTool } from './store.js';
import type { Db } from '../db/index.js';

/** Where an agent runs. `claude` is the default, and every agent from before this. */
export type ProviderId = 'claude' | 'copilot' | 'openrouter';
export const PROVIDERS: readonly ProviderId[] = ['claude', 'copilot', 'openrouter'];

export function isProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/**
 * What an engine can do. A false flag hides or disables the control that needs it; it
 * never stops a job. (Set from docs/plans/multi-provider-findings.md for non-Claude ones.)
 */
export interface BackendCapabilities {
  /** A tool call can be deferred and re-offered on resume, so a question survives a restart. */
  defer: boolean;
  /** A session can be resumed by id after the daemon restarts. */
  resume: boolean;
  /** It reports what a run cost in dollars. False: budgets are not in dollars. */
  costUsd: boolean;
  /** Thinking effort can be set. */
  effort: boolean;
  /** It has a plan-only mode. */
  planMode: boolean;
  /** It can be given Conductor's helper tools, so it can orchestrate (Amendment 51). */
  helperTools: boolean;
}

/** One model a provider offers. */
export interface ProviderModel {
  id: string;
  displayName: string;
  efforts?: string[];
}

/**
 * A human's answer to a tool call, in no SDK's words. The arbiter returns this; each
 * backend turns it into its own SDK's shape. (It was the Claude SDK's PermissionResult.)
 */
export type PermissionDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      /** Rules to keep (Claude's `updatedPermissions`). A backend that has none ignores them. */
      updatedPermissions?: unknown[];
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** What an agent runs with. Built by the supervisor, the same for every backend. */
export interface RunnerScope {
  agentId: string;
  jobId: string;
  projectId: string;
  /** cwd for the agent — the job's worktree. */
  worktreePath: string;
  /**
   * The project's other directories (Amendment 39). The agent can read and edit these
   * too — in place, since only the first directory has a worktree.
   */
  extraDirs?: string[];
  /** Amendment 51: an orchestrator's helper cap, which gives it the Conductor tools. */
  helperCap?: number;
  /**
   * Amendment 104: agents wait for this one, so it is given `hand_off` (over the same
   * endpoint for Claude, in-process for Copilot and OpenRouter). Nobody waiting for it: it
   * has no one to hand off to and finishes `done` as it always did.
   */
  handOff?: boolean;
  model: string;
  autonomy: Autonomy;
  /**
   * The agent's lifetime spend when this run starts. The budget is a lifetime cap and
   * the SDK's `maxBudgetUsd` counts only this query's spend, so the runner has to know
   * what was spent before it.
   */
  spentUsd: number;
  /**
   * From the agent's persona (Amendment 68): appended to Claude Code's own system prompt,
   * and the skills it may use, preloaded. Passed on every run, resumes included, since a
   * resumed query starts from these options afresh.
   */
  systemPrompt?: string;
  skills?: string[];
}

export interface RunOutcome {
  sessionId: string | null;
  terminalReason: string | null;
  /**
   * Set when the run ended because PreToolUse returned `defer` — and when a resume
   * found that call's tool gone (`tool_deferred_unavailable`), which names it too.
   */
  deferredTool: DeferredTool | null;
  isError: boolean;
  /** The result's `errors`, when it failed and the SDK said why. */
  errorDetail: string | null;
  /** What the session has cost so far, in dollars. 0 from a backend that can't say. */
  costUsd: number;
}

export interface RunOpts {
  prompt: string;
  resume?: string | null;
  /** Conductor's own text rather than the human's — a resume nudge. */
  synthetic?: boolean;
}

/** One agent's engine: exactly what the supervisor calls. */
export interface AgentBackend {
  readonly agentId: string;
  readonly isLive: boolean;
  readonly sessionId: string | null;
  run(opts: RunOpts): Promise<RunOutcome>;
  /** A message while it works. False when there is no live run to take it. */
  send(text: string, synthetic?: boolean): boolean;
  /** Switch model for the next reply. False when the live run couldn't. */
  setModel(model: string): Promise<boolean>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

/** A provider: what it can do, what it offers, and how to make one agent's engine. */
export interface BackendFactory {
  readonly provider: ProviderId;
  readonly capabilities: BackendCapabilities;
  listModels(): Promise<ProviderModel[]>;
  /** Why it can't launch an agent right now (no login, no key), or null. Checked at spawn. */
  unavailable(): string | null;
  create(db: Db, scope: RunnerScope): AgentBackend;
}
