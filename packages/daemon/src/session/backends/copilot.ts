/**
 * CopilotBackend — the only place in Conductor that touches the GitHub Copilot SDK.
 * TRACK A. (Amendment 76)
 *
 * Serves two providers, which differ only in how a session connects:
 *   copilot     the user's GitHub Copilot login
 *   openrouter  BYOK: the same runtime pointed at OpenRouter's OpenAI-compatible API,
 *               with the key from session/secrets.ts and no GitHub login at all
 *
 * What it is built on is in docs/plans/multi-provider-findings.md; the numbers below
 * (Q4, Q6, …) are that file's questions.
 *
 * ONE CLIENT PER PROVIDER, started lazily, stopped when the daemon closes
 * (routes/providers.ts). Each starts the bundled runtime over stdio, so nothing runs
 * until an agent, or a page asking about the login, needs it. Two rather than one
 * because BYOK is told not to look for a GitHub login (`useLoggedInUser: false`), which
 * is a client option, and a Copilot agent needs one.
 *
 * ONE SESSION PER AGENT, and its id is the agent's id (Q3): `createSession` takes one we
 * choose, so a resume is always of a session this backend made, never of an id another
 * engine stored. A session is let go (`disconnect`, which keeps it on disk) at the end of
 * every run, as claude.ts ends its query at the first result; sending to a finished
 * agent resumes it. What the runtime does not keep — the BYOK key, the callbacks, the
 * tools, the folders — is given again on every resume.
 *
 * THE PERMISSION CALLBACK IS THE SAFETY NET. Claude Code applies `disallowedTools` and
 * the permission mode itself; this SDK applies neither. So every request goes through
 * `gateCall` first, which refuses a disallowed call in every mode — bypassPermissions
 * included — and applies the mode, and only then through the arbiter, so Needs you,
 * "allow always" rules and the reversibility line work as they do for Claude. The
 * callback can wait for a human as long as it likes (Q4), and there is no `defer` (Q6),
 * so the arbiter holds these requests rather than parking them on a clock.
 *
 * NO DOLLARS (Q7). `assistant.usage` reports tokens per model call, and they are added
 * up as they arrive. The stored spend is never changed and never estimated.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  CopilotClient,
  defineTool,
  type CopilotClientOptions,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
  type Tool,
} from '@github/copilot-sdk';
import type { Autonomy, EventPayload } from '@conductor/shared';
import type { AgentBackend, PermissionDecision, ProviderModel, RunOpts, RunOutcome, RunnerScope } from '../backend.js';
import { arbiter, toolRuleFor } from '../../arbiter/index.js';
import type { Db } from '../../db/index.js';
import { eventLog } from '../../eventlog.js';
import { callTool, toolsFor } from '../../routes/helpers.js';
import { modelAnswered } from '../alerts.js';
import { budgetRefusal } from '../budget.js';
import { openRouterKey } from '../secrets.js';
import { finishRun, getAgent, newId, openRequestsForAgent, setAgentSession, setAgentUsage, startRun } from '../store.js';
import { copilotToolsFor, isWriteTool, normaliseTool } from '../translate.js';
import { CUT_SHORT } from './claude.js';
import { CopilotEvents, askFromPermission, type TurnEnd } from './copilot-events.js';

export type CopilotProvider = 'copilot' | 'openrouter';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS_TTL_MS = 10 * 60_000;

/** What Conductor uses of a client and a session. The fake in verify.ts is one of each. */
export type CopilotClientLike = Pick<CopilotClient, 'start' | 'stop' | 'createSession' | 'resumeSession' | 'getAuthStatus' | 'listModels'>;
export type CopilotSessionLike = Pick<CopilotSession, 'on' | 'send' | 'abort' | 'disconnect' | 'setModel'>;

/**
 * The SDK, behind one indirection so session/verify.ts can drive a real backend and
 * supervisor without a runtime or a network. Nothing else assigns it.
 */
export const copilotSdk: {
  createClient: (options: CopilotClientOptions) => CopilotClientLike;
  /** OpenRouter's public model list. Needs no key, and is sent none. */
  fetchOpenRouterModels: () => Promise<unknown>;
  /** Whether any credential the runtime would look for exists. Read, never opened. */
  credentialPresent: () => boolean;
} = {
  createClient: (options) => new CopilotClient(options),
  credentialPresent: () =>
    ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN'].some((k) => !!process.env[k]) ||
    [join(homedir(), '.copilot', 'config.json'), join(homedir(), '.config', 'gh', 'hosts.yml')].some((f) => existsSync(f)),
  fetchOpenRouterModels: async () => {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenRouter's model list answered ${res.status}`);
    return res.json();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// clients
// ─────────────────────────────────────────────────────────────────────────────

const clients = new Map<CopilotProvider, { client: CopilotClientLike; started: Promise<void> }>();

/**
 * The provider's client, started. `createSession` would start it on its own, but
 * `getAuthStatus` and `listModels` throw "Client not connected" unless `start()` ran
 * first (found by running the spike). A start that fails is forgotten, so the next
 * ask tries again rather than failing for good.
 */
async function clientFor(provider: CopilotProvider): Promise<CopilotClientLike> {
  let c = clients.get(provider);
  if (!c) {
    const client = copilotSdk.createClient({
      logLevel: 'error',
      ...(provider === 'openrouter' ? { useLoggedInUser: false } : {}),
    });
    const entry = { client, started: client.start() };
    entry.started.catch(() => {
      if (clients.get(provider) === entry) clients.delete(provider);
    });
    clients.set(provider, entry);
    c = entry;
  }
  await c.started;
  return c.client;
}

/** On daemon shutdown, after the supervisor has stopped every agent. */
export async function stopCopilotClients(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.allSettled(
    all.map(async ({ client, started }) => {
      await started;
      await client.stop();
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// the login, and the refusals spawn checks
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotLogin {
  authenticated: boolean;
  login: string | null;
  note?: string;
}

let lastLogin: (CopilotLogin & { at: number }) | null = null;
let asking: Promise<CopilotLogin> | null = null;

const oneLine = (err: unknown): string =>
  ((err instanceof Error ? err.message : String(err)).trim().split('\n')[0] ?? '').slice(0, 200);

/**
 * Ask the runtime who you are. Never throws: a runtime that can't say is a note.
 *
 * Asking starts the runtime, a native process of some 86 MB, and Spawn and Settings ask
 * each time they open. With no credential anywhere the runtime would look (findings,
 * "Authentication"), the answer is known without it, so it is not started.
 */
export function copilotLogin(): Promise<CopilotLogin> {
  asking ??= (async (): Promise<CopilotLogin> => {
    let found: CopilotLogin;
    if (!copilotSdk.credentialPresent()) {
      found = { authenticated: false, login: null, note: 'no GitHub credential found' };
      lastLogin = { ...found, at: Date.now() };
      return found;
    }
    try {
      const s = await (await clientFor('copilot')).getAuthStatus();
      found = s.isAuthenticated
        ? { authenticated: true, login: s.login ?? null }
        : { authenticated: false, login: null, note: s.statusMessage?.trim() || 'not logged in' };
    } catch (err) {
      found = { authenticated: false, login: null, note: `could not ask the Copilot runtime: ${oneLine(err)}` };
    }
    lastLogin = { ...found, at: Date.now() };
    return found;
  })().finally(() => {
    asking = null;
  });
  return asking;
}

/**
 * Why a Copilot agent can't start now, or null. Spawn calls this synchronously, so it
 * reads the last answer rather than starting the runtime and waiting: a login is asked
 * about when nothing is known yet or the answer is old (ten minutes for a yes, half a
 * minute for a no, so signing in is noticed soon), and the very first spawn before any
 * answer is told to try again in a moment rather than let through on a guess.
 */
export function copilotRefusal(): string | null {
  const age = lastLogin ? Date.now() - lastLogin.at : Infinity;
  if (age > (lastLogin?.authenticated ? MODELS_TTL_MS : 30_000)) void copilotLogin();
  if (!lastLogin) return 'checking your GitHub Copilot login — try again in a moment';
  if (lastLogin.authenticated) return null;
  return (
    `not logged in to GitHub Copilot (${lastLogin.note ?? 'not logged in'}) — sign in with ` +
    '`copilot login` or `gh auth login`, or set GH_TOKEN, then try again'
  );
}

export function openRouterRefusal(): string | null {
  return openRouterKey() ? null : 'no OpenRouter key — set OPENROUTER_API_KEY or add the key in Settings';
}

/** For verify: forget what was learned, as a fresh daemon would. */
export function forgetCopilotState(): void {
  lastLogin = null;
  asking = null;
  openRouterList = null;
  clients.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// models
// ─────────────────────────────────────────────────────────────────────────────

/** Copilot's own list (Q11). Needs a login; the SDK caches it after the first call. */
export async function copilotModels(): Promise<ProviderModel[]> {
  const list = await (await clientFor('copilot')).listModels();
  return list.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    ...(m.supportedReasoningEfforts?.length ? { efforts: [...m.supportedReasoningEfforts] } : {}),
  }));
}

let openRouterList: { at: number; models: ProviderModel[] } | null = null;

/** OpenRouter's public list (Q11: the runtime doesn't list a BYOK provider's models). */
export async function openRouterModels(fresh = false): Promise<ProviderModel[]> {
  if (!fresh && openRouterList && Date.now() - openRouterList.at < MODELS_TTL_MS) return openRouterList.models;
  const body = (await copilotSdk.fetchOpenRouterModels()) as { data?: unknown } | null;
  const data = Array.isArray(body?.data) ? body.data : [];
  const models: ProviderModel[] = [];
  for (const m of data as Array<{ id?: unknown; name?: unknown }>) {
    if (typeof m?.id !== 'string' || !m.id) continue;
    models.push({ id: m.id, displayName: typeof m.name === 'string' && m.name ? m.name : m.id });
  }
  openRouterList = { at: Date.now(), models };
  return models;
}

// ─────────────────────────────────────────────────────────────────────────────
// the gate: disallowedTools and the permission mode, which this SDK doesn't apply
// ─────────────────────────────────────────────────────────────────────────────

export type Gate = { kind: 'allow'; reason: string } | { kind: 'deny'; reason: string } | { kind: 'ask' };

/** Tools that only look. Claude Code lets these through inside the agent's folders. */
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof input[k] === 'string') return input[k];
  return undefined;
}

/** In the worktree or one of the project's other directories. No path means the worktree. */
function within(where: { worktreePath: string; extraDirs?: string[] }, path: string | undefined): boolean {
  if (!path) return true;
  const abs = resolve(where.worktreePath, path);
  return [where.worktreePath, ...(where.extraDirs ?? [])].some((d) => abs === d || abs.startsWith(d.endsWith(sep) ? d : `${d}${sep}`));
}

/**
 * What Claude Code would do with this call before asking anyone, applied by Conductor
 * because this SDK does nothing of it. Pure, so verify.ts checks it.
 *
 *   disallowedTools        refused, in EVERY mode. Checked first, on purpose.
 *   bypassPermissions      everything else runs
 *   a read in its folders  runs
 *   plan                   anything that isn't reading is refused (there is no plan-only
 *                          mode on this engine yet; `planMode: false` hides the control)
 *   acceptEdits            a file edit in its folders runs
 *   allowedTools           what they name runs — a pattern only if it covers every part
 *   dontAsk                anything not allowed above is refused, not asked
 *   default, auto          asked. `auto` has no classifier here, so it asks as default does.
 */
export function gateCall(
  autonomy: Autonomy,
  tool: string,
  input: Record<string, unknown>,
  where: { worktreePath: string; extraDirs?: string[] },
): Gate {
  const banned = toolRuleFor(autonomy.disallowedTools, tool, input, 'deny');
  if (banned) return { kind: 'deny', reason: `${banned} is not allowed for this agent` };
  if (autonomy.mode === 'bypassPermissions') return { kind: 'allow', reason: 'bypassPermissions' };
  const inside = within(where, pathOf(input));
  if (READS.has(tool) && inside) return { kind: 'allow', reason: 'a read in its folders' };
  if (autonomy.mode === 'plan') return { kind: 'deny', reason: 'plan mode: this agent may only read' };
  if (autonomy.mode === 'acceptEdits' && isWriteTool(tool) && inside) return { kind: 'allow', reason: 'acceptEdits' };
  const allowed = toolRuleFor(autonomy.allowedTools, tool, input, 'allow');
  if (allowed) return { kind: 'allow', reason: `allowed: ${allowed}` };
  if (autonomy.mode === 'dontAsk') return { kind: 'deny', reason: 'not pre-approved, and this agent does not ask' };
  return { kind: 'ask' };
}

/**
 * Copilot's `excludedTools` for the whole-tool entries of `disallowedTools`, so the model
 * isn't offered what it may not use. Only names that map one to one; `gateCall` is what
 * actually refuses, whatever the model calls.
 */
export function excludedFor(disallowed: readonly string[]): string[] {
  return [...new Set(disallowed.filter((r) => !r.includes('(')).flatMap((r) => copilotToolsFor(r.trim())))];
}

/** The arbiter's answer, in this SDK's words. */
function toCopilot(d: PermissionDecision): PermissionRequestResult {
  if (d.behavior === 'deny') return { kind: 'reject', feedback: d.message };
  // An edited call can't be run as edited: this SDK has no updatedInput. Running the
  // original instead would run what the human changed, so it is declined with the edit.
  if (d.updatedInput && Object.keys(d.updatedInput).length > 0) {
    return {
      kind: 'reject',
      feedback: `The human changed this call before approving it. Make it again exactly as: ${JSON.stringify(d.updatedInput).slice(0, 2_000)}`,
    };
  }
  return { kind: 'approve-once' };
}

// ─────────────────────────────────────────────────────────────────────────────
// the backend
// ─────────────────────────────────────────────────────────────────────────────

type RunEnd = TurnEnd | { kind: 'budget' };

const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class CopilotBackend implements AgentBackend {
  #db: Db;
  #scope: RunnerScope;
  #provider: CopilotProvider;
  #session: CopilotSessionLike | null = null;
  #sessionId: string | null = null;
  #live = false;
  #stopping = false;
  #events: CopilotEvents;
  /** Aborted by interrupt(), so a request the human hasn't answered is parked, as for Claude. */
  #asks = new AbortController();
  #end: ((e: RunEnd) => void) | null = null;
  /** Lifetime tokens, from what was stored when this run began. */
  #tokens = { input: 0, output: 0 };
  /** The last `ask_user` call started, so its question carries the call's id. */
  #lastAsk: string | null = null;

  constructor(db: Db, scope: RunnerScope, provider: CopilotProvider) {
    this.#db = db;
    this.#scope = scope;
    this.#provider = provider;
    this.#events = new CopilotEvents(scope.worktreePath);
  }

  get agentId(): string {
    return this.#scope.agentId;
  }

  get isLive(): boolean {
    return this.#live;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  #emit(payload: EventPayload): void {
    eventLog().emit(
      { projectId: this.#scope.projectId, jobId: this.#scope.jobId, agentId: this.#scope.agentId },
      payload,
    );
  }

  // ── options ───────────────────────────────────────────────────────────────

  /** Everything a session is given, on create and on every resume alike. */
  #config(): Omit<SessionConfig, 'sessionId'> {
    const { autonomy, worktreePath, model, extraDirs, helperCap, handOff, systemPrompt } = this.#scope;
    let provider: SessionConfig['provider'];
    if (this.#provider === 'openrouter') {
      const apiKey = openRouterKey();
      if (!apiKey) throw new Error(openRouterRefusal() ?? 'no OpenRouter key');
      if (!model) throw new Error('an OpenRouter agent needs a model id, like anthropic/claude-sonnet-4.5');
      provider = { type: 'openai', baseUrl: OPENROUTER_BASE_URL, apiKey };
    }
    const tools = helperCap || handOff ? this.#helperTools({ helperCap, handOff }) : [];
    const excluded = excludedFor(autonomy.disallowedTools);
    return {
      clientName: 'conductor',
      model,
      ...(autonomy.effort ? { reasoningEffort: autonomy.effort } : {}),
      workingDirectory: worktreePath,
      ...(extraDirs && extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
      ...(provider ? { provider } : {}),
      // Appended to the runtime's own, like Claude's preset `append`. Never `replace`,
      // which drops the runtime's guardrails.
      ...(systemPrompt?.trim() ? { systemMessage: { mode: 'append' as const, content: systemPrompt } } : {}),
      ...(excluded.length > 0 ? { excludedTools: excluded } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      onPermissionRequest: (req) => this.#onPermission(req),
      onUserInputRequest: (req) => this.#onQuestion(req),
    };
  }

  /**
   * An orchestrator's start_helper and list_helpers (Amendment 51), and hand_off for an
   * agent others wait for (Amendment 104), in-process (Q8) rather than over the MCP
   * endpoint Claude uses, and served by the same code. Allowed outright, as for Claude:
   * asking whether it may start the helpers it was launched to start would ask the
   * question twice.
   */
  #helperTools(access: { helperCap?: number; handOff?: boolean }): Tool[] {
    return toolsFor(access).map((t) =>
      defineTool(t.name, {
        description: t.description,
        parameters: t.inputSchema,
        skipPermission: true,
        handler: (args) => {
          const r = callTool(this.#scope.agentId, t.name, bag(args));
          const text = r.content.map((c) => c.text).join('\n');
          return r.isError ? { textResultForLlm: text, resultType: 'failure' as const, error: text } : text;
        },
      }),
    );
  }

  // ── permissions ───────────────────────────────────────────────────────────

  async #onPermission(req: PermissionRequest): Promise<PermissionRequestResult> {
    try {
      const { tool, input } = askFromPermission(req, this.#events.call(req.toolCallId));
      const toolUseId = req.toolCallId ?? newId('call');
      const gate = gateCall(this.#scope.autonomy, tool, input, this.#scope);
      if (gate.kind === 'deny') {
        this.#emit({ kind: 'resolved', requestId: `guard:${toolUseId}`, decision: { type: 'deny', by: 'rule', note: gate.reason } });
        return { kind: 'reject', feedback: `Not allowed: ${gate.reason}.` };
      }
      // Managed policy wants a person to say yes, whatever the mode said.
      if (gate.kind === 'allow' && !req.managedApprovalRequired) return { kind: 'approve-once' };

      // A decision taken while this agent was paused on the call, waiting for its resume.
      const staged = arbiter().preToolUse({ agentId: this.#scope.agentId, toolName: tool, toolUseId, input });
      if (staged.kind === 'allow') return { kind: 'approve-once' };
      if (staged.kind === 'deny') return { kind: 'reject', feedback: staged.reason };
      if (staged.kind === 'park') {
        // Nothing to park on without defer: the earlier call is still the question.
        return {
          kind: 'reject',
          feedback: `Not run: a ${tool} call is waiting for the human's decision. Make this call again once that one has been answered.`,
        };
      }

      return toCopilot(
        await arbiter().requestPermission({
          agentId: this.#scope.agentId,
          toolName: tool,
          toolUseId,
          input,
          cwd: this.#scope.worktreePath,
          signal: this.#asks.signal,
        }),
      );
    } catch (err) {
      // Never approve on an error. (The SDK would answer a throw with user-not-available.)
      console.error(`[copilot] ${this.#scope.agentId} permission callback failed`, err);
      return { kind: 'reject', feedback: 'Conductor could not ask about this call.' };
    }
  }

  /**
   * `ask_user`, which this SDK sends here rather than as a permission request. Asked
   * through the arbiter as an AskUserQuestion, so it is a question in Needs you.
   */
  async #onQuestion(req: { question: string; choices?: string[] }): Promise<{ answer: string; wasFreeform: boolean }> {
    const { input } = normaliseTool('ask_user', req);
    const declined = (why: string) => ({ answer: why, wasFreeform: true });
    try {
      if (toolRuleFor(this.#scope.autonomy.disallowedTools, 'AskUserQuestion', input, 'deny')) {
        return declined('Questions are not allowed for this agent. Decide yourself, and say what you assumed.');
      }
      const d = await arbiter().requestPermission({
        agentId: this.#scope.agentId,
        toolName: 'AskUserQuestion',
        toolUseId: this.#lastAsk ?? newId('ask'),
        input,
        cwd: this.#scope.worktreePath,
        signal: this.#asks.signal,
      });
      if (d.behavior === 'deny') return declined(`The human declined to answer${d.message ? `: ${d.message}` : ''}.`);
      const given = bag(d.updatedInput);
      const answers = Object.values(bag(given['answers'])).filter((v): v is string => typeof v === 'string');
      const answer = answers[0] ?? (typeof given['response'] === 'string' ? given['response'] : '');
      return { answer, wasFreeform: !(req.choices ?? []).includes(answer) };
    } catch (err) {
      console.error(`[copilot] ${this.#scope.agentId} question failed`, err);
      return declined('Conductor could not put the question to the human.');
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  #onEvent(event: SessionEvent, outcome: RunOutcome): void {
    const step = this.#events.take(event);
    for (const p of step.payloads) {
      if (p.kind === 'tool_start' && p.tool === 'AskUserQuestion') this.#lastAsk = p.toolUseId;
      this.#emit(p);
    }
    if (step.replied) modelAnswered(this.#scope.agentId);
    if (step.usage) this.#count(step.usage, outcome);
    if (step.end) this.#finish(step.end);
  }

  /**
   * One model call's tokens, added to the lifetime totals the moment they arrive — the
   * event is ephemeral, and a run cut short would otherwise count nothing. The dollar
   * spend is the stored one, untouched. Then the cap: an agent past it is stopped the
   * way Claude's budget stop ends a run, and the supervisor pauses it with the note.
   */
  #count(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, outcome: RunOutcome): void {
    this.#tokens.input += u.inputTokens;
    this.#tokens.output += u.outputTokens;
    const costUsd = this.#scope.spentUsd;
    setAgentUsage(this.#db, this.#scope.agentId, { costUsd, inputTokens: this.#tokens.input, outputTokens: this.#tokens.output });
    this.#emit({
      kind: 'usage',
      costUsd,
      inputTokens: this.#tokens.input,
      outputTokens: this.#tokens.output,
      ...(u.cacheReadTokens > 0 ? { cacheReadTokens: u.cacheReadTokens } : {}),
    });
    const agent = getAgent(this.#db, this.#scope.agentId);
    if (!this.#stopping && agent && budgetRefusal(agent)) {
      outcome.terminalReason = 'budget_exhausted';
      this.#stopping = true;
      // Ended first, so the abort's own events can't say it was only interrupted.
      this.#finish({ kind: 'budget' });
      void this.#session?.abort().catch(() => {});
    }
  }

  #finish(end: RunEnd): void {
    const done = this.#end;
    this.#end = null;
    done?.(end);
  }

  // ── the run ───────────────────────────────────────────────────────────────

  /**
   * One turn: create or resume the session, send the prompt, and wait for the root
   * agent to go idle, fail or be stopped. `resume` only ever resumes this agent's own
   * session, whose id is the agent's.
   */
  async run(opts: RunOpts): Promise<RunOutcome> {
    const agentId = this.#scope.agentId;
    const resuming = opts.resume !== undefined && opts.resume !== null;
    const outcome: RunOutcome = {
      sessionId: resuming ? agentId : null,
      terminalReason: null,
      deferredTool: null,
      isError: false,
      errorDetail: null,
      costUsd: this.#scope.spentUsd,
    };
    const stored = getAgent(this.#db, agentId);
    this.#tokens = { input: stored?.inputTokens ?? 0, output: stored?.outputTokens ?? 0 };
    const runId = startRun(this.#db, agentId, outcome.sessionId);
    this.#live = true;
    this.#stopping = false;
    this.#asks = new AbortController();
    const ended = new Promise<RunEnd>((r) => (this.#end = r));
    let off: (() => void) | null = null;

    try {
      if (resuming && opts.resume !== agentId) {
        console.warn(`[copilot] ${agentId}: asked to resume a session that isn't this agent's; resuming its own`);
      }
      const client = await clientFor(this.#provider);
      const config = this.#config();
      // Pending work is not continued (Q6: whether the runtime re-offers it is
      // unconfirmed): the resume prompt says what happened instead.
      const session = resuming
        ? await client.resumeSession(agentId, { ...config, continuePendingWork: false })
        : await client.createSession({ ...config, sessionId: agentId });
      this.#session = session;
      this.#sessionId = agentId;
      outcome.sessionId = agentId;
      setAgentSession(this.#db, agentId, agentId);
      off = session.on((e: SessionEvent) => this.#onEvent(e, outcome));

      if (this.#stopping) {
        this.#finish({ kind: 'aborted' });
      } else if (opts.prompt.length > 0) {
        this.#emit({ kind: 'user_text', text: opts.prompt, ...(opts.synthetic ? { synthetic: true } : {}) });
        await session.send({ prompt: opts.prompt });
      } else {
        // Nothing to say and nothing deferred to re-offer: there is no turn to wait for.
        this.#finish({ kind: 'idle' });
      }

      const end = await ended;
      if (end.kind === 'budget' || outcome.terminalReason === 'budget_exhausted') {
        outcome.terminalReason = 'budget_exhausted';
      } else if (end.kind === 'error' && !this.#stopping) {
        outcome.isError = true;
        outcome.terminalReason = 'session_error';
        outcome.errorDetail = end.message.trim().split('\n')[0]?.slice(0, 400) || null;
      } else if (end.kind === 'aborted' || this.#stopping) {
        outcome.terminalReason = 'aborted_streaming';
      } else {
        outcome.terminalReason = 'completed';
      }
    } catch (err) {
      if (!this.#stopping) {
        outcome.isError = true;
        outcome.terminalReason = outcome.terminalReason ?? 'iteration_error';
        outcome.errorDetail = oneLine(err) || null;
        console.error(`[copilot] ${agentId} run failed: ${oneLine(err)}`);
      }
    } finally {
      this.#live = false;
      this.#end = null;
      off?.();
      this.#closeCutShort();
      const session = this.#session;
      this.#session = null;
      if (session) await session.disconnect().catch((err: unknown) => console.error(`[copilot] ${agentId} disconnect failed: ${oneLine(err)}`));
      finishRun(this.#db, runId, { sdkSessionId: outcome.sessionId, terminalReason: outcome.terminalReason ?? undefined });
    }
    return outcome;
  }

  /**
   * A call that started and never ended — the run was stopped under it — would say
   * "running…" in the transcript for good (as Amendment 35 found for Claude). A call
   * still waiting on the human is not cut short: it is that request's.
   */
  #closeCutShort(): void {
    const waiting = new Set(openRequestsForAgent(this.#db, this.#scope.agentId).map((r) => r.toolUseId));
    for (const toolUseId of this.#events.open()) {
      this.#events.forget(toolUseId);
      if (!waiting.has(toolUseId)) this.#emit({ kind: 'tool_end', toolUseId, ok: false, summary: CUT_SHORT });
    }
  }

  // ── control ───────────────────────────────────────────────────────────────

  /** Mid-task redirect (Q1): steers the turn in progress, best effort. */
  send(text: string, synthetic = false): boolean {
    const session = this.#session;
    if (!this.#live || !session) return false;
    this.#emit({ kind: 'user_text', text, ...(synthetic ? { synthetic: true } : {}) });
    session.send({ prompt: text, mode: 'immediate' }).catch((err: unknown) => {
      console.error(`[copilot] ${this.#scope.agentId} could not send: ${oneLine(err)}`);
    });
    return true;
  }

  /** For the next message, which is when the SDK applies it. */
  async setModel(model: string): Promise<boolean> {
    const session = this.#session;
    if (!this.#live || !session) return false;
    const effort = this.#scope.autonomy.effort;
    await session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
    this.#scope = { ...this.#scope, model };
    return true;
  }

  /**
   * End the turn (Q2). A request the human hasn't answered is parked, as Claude's is
   * when interrupt() aborts its callback: answering it resumes the session with a nudge.
   */
  async interrupt(): Promise<void> {
    if (!this.#live) return;
    this.#stopping = true;
    this.#asks.abort();
    await this.#abort();
  }

  /**
   * Stop for good. Unlike interrupt() a held request is left held: the agent was paused
   * or ended (which expire it first), or the daemon is shutting down, and after a
   * restart the arbiter expires a held request of an engine that can't defer.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#abort();
  }

  async #abort(): Promise<void> {
    try {
      await this.#session?.abort();
    } catch (err) {
      console.error(`[copilot] abort failed for ${this.#scope.agentId}: ${oneLine(err)}`);
    }
    this.#finish({ kind: 'aborted' });
  }
}
