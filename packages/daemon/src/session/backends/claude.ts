/**
 * ClaudeBackend — the only place in Conductor that touches the Claude Agent SDK.
 *
 * It was AgentRunner in session/runner.ts, the only engine there was. Moved here unchanged
 * behind `AgentBackend` (Amendment 72) so other engines can sit beside it; runner.ts
 * re-exports it under its old name.
 *
 * PLAN.md §10 pins the SDK version and keeps all contact inside this class so an
 * SDK change is a one-file change, and §11.4's "bring your own agent" seam stays
 * open: everything downstream of here speaks EventPayload, not SDKMessage.
 *
 * STREAMING INPUT MODE is mandatory, not a preference. `prompt` is an
 * AsyncIterable<SDKUserMessage>, which is what makes mid-task redirect and
 * interrupt() available at all (PLAN.md §1).
 *
 * TWO PERMISSION CHANNELS, TWO JOBS (finding A, confirmed by the spike — the SDK
 * itself warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` when you conflate them):
 *   PreToolUse hook, no matcher, returns {async:true}  → sees EVERY call,
 *       including auto-approved ones. Drives the activity feed and sparkline,
 *       and never makes the agent wait on our bookkeeping (CONTRACT.md §5.4).
 *   canUseTool                                          → human decisions only.
 *
 * A run ends at the first `result` message. Streaming input would otherwise keep
 * the process alive waiting for more input, which would pin a slot per finished
 * agent; sending to a finished agent resumes its session instead.
 */

import type { AgentBackend, RunOpts, RunOutcome, RunnerScope } from '../backend.js';
export type { RunOpts, RunOutcome, RunnerScope } from '../backend.js';
import {
  forkSession,
  getSessionMessages,
  query,
  type HookInput,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Autonomy, Decision, EventPayload } from '@conductor/shared';
import { DEFAULT_PORT } from '@conductor/shared';
import { arbiter } from '../../arbiter/index.js';
import type { Db } from '../../db/index.js';
import { eventLog } from '../../eventlog.js';
import { classifyRetry, modelAnswered } from '../alerts.js';
import { budgetLeft, lifetimeCost } from '../budget.js';
import { costChanged } from '../../daily.js';
import { hub } from '../../hub.js';
import {
  addCostToday,
  costToday,
  finishRun,
  openRequestsForAgent,
  setAgentSession,
  setAgentUsage,
  startRun,
  type DeferredTool,
} from '../store.js';
import {
  assistantText,
  fileEditFromTool,
  isWriteTool,
  toolLabel,
  toolSummary,
  todoFromInput,
} from '../translate.js';

/**
 * The SDK's `query`, behind one indirection so session/verify.ts can drive a real
 * runner and supervisor without spending money. Nothing else assigns it. The two
 * session-file calls are here for the same reason: getting a session past a call it
 * can't make (`#runPast`).
 */
export const sdk: {
  query: typeof query;
  getSessionMessages: typeof getSessionMessages;
  forkSession: typeof forkSession;
} = { query, getSessionMessages, forkSession };

/** Streaming input: an AsyncIterable we can push to while the query runs. */
class MessageStream implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    if (this.#closed) return;
    this.#queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.#wake?.();
    this.#wake = null;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
  }
}





/**
 * The Conductor tools an orchestrator gets (Amendment 51): an MCP server the daemon
 * serves over HTTP, on its own port, at a path naming the agent. HTTP rather than the
 * SDK's in-process server because that one needs zod, which the daemon doesn't depend
 * on (CONTRACT §3).
 */
export const HELPER_TOOLS = ['mcp__conductor__start_helper', 'mcp__conductor__list_helpers'];

export function helperTools(agentId: string): { servers: NonNullable<Options['mcpServers']>; allowed: string[] } {
  const port = Number(process.env['CONDUCTOR_PORT'] ?? DEFAULT_PORT);
  const token = process.env['CONDUCTOR_TOKEN'];
  return {
    servers: {
      conductor: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp/agents/${encodeURIComponent(agentId)}`,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      },
    },
    allowed: HELPER_TOOLS,
  };
}

/** What a tool call cut short by a pause or a terminate says in the transcript. */
export const CUT_SHORT = 'stopped before it finished';

export class ClaudeBackend implements AgentBackend {
  #db: Db;
  #scope: RunnerScope;
  #input = new MessageStream();
  #query: Query | null = null;
  #sessionId: string | null = null;
  #live = false;
  #stopping = false;
  /** Set by stop(): this run is being ended, not just interrupted (Amendment 35). */
  #stopped = false;
  /** tool_use_id → started-at, so tool_end can report a duration. */
  #startedAt = new Map<string, number>();

  constructor(db: Db, scope: RunnerScope) {
    this.#db = db;
    this.#scope = scope;
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

  // ── events ────────────────────────────────────────────────────────────────

  #emit(payload: EventPayload): void {
    eventLog().emit(
      {
        projectId: this.#scope.projectId,
        jobId: this.#scope.jobId,
        agentId: this.#scope.agentId,
      },
      payload,
    );
  }

  // ── options ───────────────────────────────────────────────────────────────

  #buildOptions(resume: string | null): Options {
    const { autonomy, worktreePath, model, spentUsd, extraDirs, helperCap, systemPrompt, skills } = this.#scope;
    const left = budgetLeft(autonomy.budgetUsd, spentUsd);
    const tools = helperCap ? helperTools(this.#scope.agentId) : null;

    return {
      cwd: worktreePath,
      // The project's other directories, reachable alongside the worktree.
      ...(extraDirs && extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
      model,
      permissionMode: autonomy.mode === 'auto' ? 'auto' : autonomy.mode,
      /*
       * The SDK refuses `bypassPermissions` unless this is set — a deliberate speed
       * bump, "to ensure intentional bypassing of permissions". Passed conditionally
       * rather than always, so it is present exactly when the mode it guards is chosen
       * and an unrelated mode never carries a dangerous-sounding flag.
       *
       * Without it, the composer's bypass pill would look like it worked and do
       * nothing, which is the worst of the three possible behaviours.
       */
      ...(autonomy.mode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // Bare entries here AUTO-APPROVE the whole tool before canUseTool is
      // consulted, so anything the human wants to be asked about must be absent
      // from this list. disallowedTools survives every mode and is the real
      // safety net (PLAN.md §10).
      // An orchestrator's own tools are allowed outright: asking the human whether it may
      // start the helpers it was launched to start would ask the question twice.
      allowedTools: tools ? [...autonomy.allowedTools, ...tools.allowed] : autonomy.allowedTools,
      ...(tools ? { mcpServers: tools.servers } : {}),
      disallowedTools: autonomy.disallowedTools,
      // What is LEFT of the lifetime cap, since the SDK counts from this query's start.
      ...(left !== null ? { maxBudgetUsd: left } : {}),
      // Omitted when unset, so the SDK's own default applies rather than ours.
      ...(autonomy.effort ? { effort: autonomy.effort } : {}),
      ...(resume ? { resume } : {}),
      // A persona's own (Amendment 68). Appended to Claude Code's prompt rather than
      // replacing it, so the agent keeps its tools' instructions; omitted when empty, so
      // an agent without one launches exactly as before.
      ...(systemPrompt?.trim()
        ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt } }
        : {}),
      ...(skills && skills.length > 0 ? { skills } : {}),

      // We are a browser, so Claude's option previews can render natively rather
      // than as monospace ASCII. Sanitized on the way into the event log.
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },

      // Token-level deltas would multiply event volume ~12x (measured: 0.65 →
      // 7.72 messages/sec for one agent) and the transcript renders whole blocks.
      includePartialMessages: false,

      // The arbiter answers in no SDK's words (Amendment 72); its allow and deny are the
      // Claude SDK's own shape, so this is a narrowing, not a translation.
      canUseTool: (toolName, input, opts): Promise<PermissionResult> =>
        arbiter().requestPermission({
          agentId: this.#scope.agentId,
          toolName,
          toolUseId: opts.toolUseID,
          input,
          cwd: worktreePath,
          suggestions: opts.suggestions as never,
          matchedRule: opts.matchedAskRule?.ruleContent ?? opts.decisionReason,
          signal: opts.signal,
        }) as Promise<PermissionResult>,

      // THE TWO CHANNELS. Finding A is not an inference any more — set a bare
      // tool name in allowedTools alongside canUseTool and the SDK says so
      // itself, verbatim:
      //
      //   [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be
      //   invoked for: Read, Write, Edit, Glob, Grep, Bash, TodoWrite. Bare
      //   allowedTools entries auto-approve the whole tool before the callback
      //   is consulted. To gate every tool call, use a PreToolUse hook; or
      //   remove the bare names from allowedTools so they fall through to
      //   canUseTool. Allow rules from settings files can also shadow the
      //   callback but are not visible here.
      //
      // Hence: PreToolUse observes (it is the ONLY channel that sees every
      // call), canUseTool decides. The spike measured 7 calls seen by the hook
      // and 0 by the callback under acceptEdits.
      hooks: {
        PreToolUse: [{ hooks: [(input, toolUseId) => this.#onPreToolUse(input, toolUseId)] }],
        PostToolUse: [{ hooks: [(input) => this.#onPostToolUse(input)] }],
      },
    };
  }

  // ── hooks ─────────────────────────────────────────────────────────────────

  /**
   * Observation for every call, plus the two cheap decision paths the Arbiter
   * owns. Must not throw: the agent is blocked on this return value.
   */
  async #onPreToolUse(
    input: HookInput,
    _toolUseId: string | undefined,
  ): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };

    const tool = input.tool_name;
    const toolUseId = input.tool_use_id;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    try {
      this.#startedAt.set(toolUseId, Date.now());
      this.#emit({
        kind: 'tool_start',
        toolUseId,
        tool,
        input: toolInput,
        label: toolLabel(tool, toolInput, this.#scope.worktreePath),
      });

      // The agent's own plan, when it publishes one.
      if (tool === 'TodoWrite') {
        const todo = todoFromInput(toolInput);
        if (todo) this.#emit(todo);
      }

      const verdict = arbiter().preToolUse({
        agentId: this.#scope.agentId,
        toolName: tool,
        toolUseId,
        input: toolInput,
      });

      switch (verdict.kind) {
        case 'allow':
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: verdict.reason,
              ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
            },
          };
        case 'deny':
          // Never ran, so it is not one a stop could cut short.
          this.#startedAt.delete(toolUseId);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: verdict.reason,
            },
          };
        case 'park':
          // Ends the query with terminal_reason 'tool_deferred' and names this
          // call in deferred_tool_use, so a resume re-offers exactly it.
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'defer',
              permissionDecisionReason: verdict.reason,
            },
          };
        case 'observe':
        default:
          // Never block the agent on Conductor's bookkeeping.
          return { async: true, asyncTimeout: 30_000 };
      }
    } catch (err) {
      console.error('[runner] PreToolUse hook failed', err);
      return { async: true, asyncTimeout: 30_000 };
    }
  }

  async #onPostToolUse(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PostToolUse') return { continue: true };

    try {
      const tool = input.tool_name;
      const toolUseId = input.tool_use_id;
      const startedAt = this.#startedAt.get(toolUseId);
      this.#startedAt.delete(toolUseId);
      const durationMs = input.duration_ms ?? (startedAt ? Date.now() - startedAt : undefined);

      const response = input.tool_response;
      const ok = !looksLikeError(response);

      this.#emit({
        kind: 'tool_end',
        toolUseId,
        ok,
        summary: toolSummary(tool, response, ok, durationMs),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });

      // Track C's watcher is authoritative for diffstats; this makes the
      // transcript show a number the moment the write happens.
      if (ok && isWriteTool(tool)) {
        const edit = fileEditFromTool(tool, input.tool_input, this.#scope.worktreePath);
        if (edit) this.#emit(edit);
      }
    } catch (err) {
      console.error('[runner] PostToolUse hook failed', err);
    }
    return { async: true, asyncTimeout: 30_000 };
  }

  // ── the run loop ──────────────────────────────────────────────────────────

  /**
   * Drive one run to its first `result`. `prompt` seeds the turn; `resume` picks
   * an existing SDK session back up (the parked-agent path).
   */
  async run(opts: RunOpts): Promise<RunOutcome> {
    try {
      const outcome = await this.#runOnce(opts);
      if (outcome.terminalReason !== 'tool_deferred_unavailable' || this.#stopping) return outcome;
      return await this.#runPast(outcome, opts);
    } finally {
      if (this.#stopped) this.#closeCutShort();
    }
  }

  /**
   * A tool call that stop() cut short gets no PostToolUse, so its line in the
   * transcript said "running…" for good, on an agent that had been paused or ended
   * (Amendment 35). Closed here, once the SDK has let go and nothing else can report
   * on it. A call still waiting on your answer is not cut short: it is parked, and is
   * answered or asked again.
   */
  #closeCutShort(): void {
    const waiting = new Set(openRequestsForAgent(this.#db, this.#scope.agentId).map((r) => r.toolUseId));
    for (const toolUseId of this.#startedAt.keys()) {
      if (waiting.has(toolUseId)) continue;
      this.#emit({ kind: 'tool_end', toolUseId, ok: false, summary: CUT_SHORT });
    }
    this.#startedAt.clear();
  }

  /**
   * A resume that found its deferred call's tool gone (Amendment 30).
   *
   * The SDK re-offers a deferred call by finding it in the session file with no result
   * after it, and checks the tool exists before anything else, without waiting for MCP
   * servers to connect. Once that check fails it fails on every resume after, whatever
   * is sent, because nothing ever gives the call a result. So the session is forked to
   * end before the reply that made the call, and the fork is run once, told what was
   * lost and what the human decided. The original session file is left as it is.
   */
  async #runPast(failed: RunOutcome, opts: RunOpts): Promise<RunOutcome> {
    const call = failed.deferredTool;
    if (!call || !failed.sessionId) return failed;

    let fork: string | null = null;
    try {
      fork = await forkBefore(failed.sessionId, this.#scope.worktreePath, call.id);
    } catch (err) {
      console.error(`[runner] ${this.#scope.agentId} could not fork past ${call.name}`, err);
    }
    if (!fork) {
      failed.errorDetail = `stuck on a ${call.name} call that can no longer be made, and could not be moved past it`;
      return failed;
    }
    if (this.#stopping) return failed;
    console.log(`[runner] ${this.#scope.agentId}: ${call.name} was unavailable on resume; continuing from fork ${fork}`);

    const note = unavailableNote(call, arbiter().stagedFor(this.#scope.agentId));
    // What the failed run was sent never reached the model. Your words go again, after
    // the note; a nudge of ours is replaced by it.
    const theirs = opts.synthetic ? '' : opts.prompt.trim();
    this.#scope = { ...this.#scope, spentUsd: failed.costUsd };
    return this.#runOnce({
      prompt: theirs ? `${note}\n\n${theirs}` : note,
      resume: fork,
      synthetic: true,
      shown: note,
    });
  }

  async #runOnce(opts: RunOpts & { shown?: string }): Promise<RunOutcome> {
    const outcome: RunOutcome = {
      sessionId: opts.resume ?? null,
      terminalReason: null,
      deferredTool: null,
      isError: false,
      errorDetail: null,
      costUsd: this.#scope.spentUsd,
    };

    const runId = startRun(this.#db, this.#scope.agentId, opts.resume ?? null);
    this.#input = new MessageStream();
    this.#live = true;
    this.#stopping = false;

    const q = sdk.query({ prompt: this.#input, options: this.#buildOptions(opts.resume ?? null) });
    this.#query = q;

    // A resumed run re-offers the parked call on its own — the spike measured
    // 678 ms and no extra turn — so it needs no prompt. Sending one anyway would
    // add a turn and let the model reconsider.
    if (opts.prompt.length > 0) {
      this.#input.push(opts.prompt);
      // The ONLY place a launch prompt becomes a user_text event. The supervisor used
      // to emit one as well before calling in here, which double-logged every message
      // sent to a parked agent. `shown` is for a prompt that repeats words already
      // logged: only the new part is.
      this.#emit({
        kind: 'user_text',
        text: opts.shown ?? opts.prompt,
        ...(opts.synthetic ? { synthetic: true } : {}),
      });
    }

    try {
      for await (const message of q) {
        this.#onMessage(message, outcome);
        if (message.type === 'result') break;
      }
    } catch (err) {
      // An interrupt mid-iteration surfaces here; it is a normal park, not a bug.
      if (!this.#stopping) {
        outcome.isError = true;
        outcome.terminalReason = outcome.terminalReason ?? 'iteration_error';
        console.error(`[runner] ${this.#scope.agentId} iteration failed`, err);
      }
    } finally {
      this.#live = false;
      this.#input.close();
      this.#query = null;
      finishRun(this.#db, runId, {
        sdkSessionId: outcome.sessionId,
        terminalReason: outcome.terminalReason ?? undefined,
        deferredTool: outcome.deferredTool,
      });
    }

    return outcome;
  }

  #onMessage(message: SDKMessage, outcome: RunOutcome): void {
    const m = message as unknown as Record<string, unknown>;

    // Every message carries session_id; there is no q.getSessionId() in v0.3.278
    // despite what PLAN.md §1 says, so this is where we learn it.
    const sid = typeof m['session_id'] === 'string' ? m['session_id'] : null;
    if (sid && sid !== this.#sessionId) {
      this.#sessionId = sid;
      outcome.sessionId = sid;
      setAgentSession(this.#db, this.#scope.agentId, sid);
    }

    switch (message.type) {
      case 'assistant': {
        for (const text of assistantText(m['message'])) {
          this.#emit({ kind: 'text', text });
        }
        // A real reply ends any outage it was retrying through. An API error the SDK
        // writes as the assistant's turn carries `error`, and is not a reply.
        if (m['error'] === undefined) modelAnswered(this.#scope.agentId);
        break;
      }

      case 'system': {
        // The SDK retrying a model call (F10). These used to be dropped with the rest of
        // `system`, so an agent that couldn't reach the API read as "working" for minutes.
        if (m['subtype'] !== 'api_retry') break;
        const httpStatus = typeof m['error_status'] === 'number' ? m['error_status'] : null;
        const error = typeof m['error'] === 'string' ? m['error'] : 'unknown';
        this.#emit({
          kind: 'api_retry',
          attempt: numberOr(m['attempt'], 1),
          maxRetries: numberOr(m['max_retries'], 0),
          delayMs: numberOr(m['retry_delay_ms'], 0),
          cause: classifyRetry(httpStatus, error),
          httpStatus,
          error,
        });
        break;
      }

      case 'result': {
        // `terminal_reason` is optional, and the subtype is what the SDK documents a
        // budget stop by, so a budget stop reads the same whichever of the two it sent.
        outcome.terminalReason =
          typeof m['terminal_reason'] === 'string'
            ? m['terminal_reason']
            : m['subtype'] === 'error_max_budget_usd'
              ? 'budget_exhausted'
              : null;
        outcome.isError = m['is_error'] === true;
        // A failure with no terminal_reason — a resume of a session that is gone — is
        // explained here and nowhere else (F20).
        if (outcome.isError) outcome.errorDetail = errorsOf(m['errors']);

        const deferred = m['deferred_tool_use'];
        if (deferred && typeof deferred === 'object') {
          outcome.deferredTool = deferred as DeferredTool;
        }

        const reported = typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : 0;
        const costUsd = lifetimeCost(this.#scope.spentUsd, reported);
        const usage = (m['usage'] ?? {}) as Record<string, unknown>;
        const inputTokens = numberOr(usage['input_tokens'], 0);
        const outputTokens = numberOr(usage['output_tokens'], 0);
        const cacheReadTokens = numberOr(usage['cache_read_input_tokens'], 0);

        // total_cost_usd is cumulative for the session, so the delta is what
        // today's rollup should grow by. Summing the raw value would compound — and
        // did, across resumes, until `outcome.costUsd` started from the spend stored
        // before this run rather than from zero: every resume added the session's
        // whole earlier total to today again.
        const previous = outcome.costUsd;
        outcome.costUsd = costUsd;
        addCostToday(this.#db, Math.max(0, costUsd - previous));
        // Every status bar shows today's spend as it grows, and the daily budget's alert
        // is checked against it (Amendment 59).
        if (costUsd > previous) {
          try {
            hub().broadcast({ type: 'cost', costToday: costToday(this.#db) });
          } catch {
            // No hub outside the daemon (the spike). Not fatal.
          }
          costChanged();
        }

        setAgentUsage(this.#db, this.#scope.agentId, { costUsd, inputTokens, outputTokens });
        this.#emit({
          kind: 'usage',
          costUsd,
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        });
        break;
      }

      default:
        // The rest of system, stream events, task notifications and the like carry no
        // payload the frozen event union models. Deliberately dropped rather
        // than smuggled through as text.
        break;
    }
  }

  // ── control ───────────────────────────────────────────────────────────────

  /** Mid-task redirect. Only meaningful while the run is live. */
  send(text: string, synthetic = false): boolean {
    if (!this.#live) return false;
    this.#input.push(text);
    this.#emit({ kind: 'user_text', text, ...(synthetic ? { synthetic: true } : {}) });
    return true;
  }

  /**
   * Change the model for the rest of this run. Streaming input is what makes this
   * possible (`Query.setModel`, sdk.d.ts); permission mode and the tool lists have no
   * equivalent, which is why those wait for the next run and this does not.
   * False when there is no live run to change.
   */
  async setModel(model: string): Promise<boolean> {
    if (!this.#live || !this.#query) return false;
    await this.#query.setModel(model);
    this.#scope = { ...this.#scope, model };
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.#query) return;
    this.#stopping = true;
    try {
      await this.#query.interrupt();
    } catch (err) {
      console.error(`[runner] interrupt failed for ${this.#scope.agentId}`, err);
    }
  }

  /** Stop for good: interrupt, then let the iterator finish. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopped = true;
    await this.interrupt();
    this.#input.close();
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A failed result's `errors`, one line each, as one line. Null when it gave none. */
function errorsOf(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const lines = v
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().split('\n')[0] ?? '')
    .filter((e) => e.length > 0);
  return lines.length > 0 ? lines.join(' · ').slice(0, 400) : null;
}

/**
 * Fork `sessionId` to end just before the reply that made call `toolUseId`, so a
 * resume of the fork has no call pending. Null when the call isn't in the session or
 * nothing comes before it.
 */
async function forkBefore(sessionId: string, dir: string, toolUseId: string): Promise<string | null> {
  const chain = await sdk.getSessionMessages(sessionId, { dir });
  const at = chain.findIndex((m) => m.type === 'assistant' && madeCall(m.message, toolUseId));
  if (at < 0) return null;
  // One reply is several entries — thinking, text, each tool_use — sharing the API
  // message's id. All of it goes: half a reply is nothing to resume from.
  const reply = replyId(chain[at]!.message);
  let start = at;
  while (
    start > 0 &&
    reply !== null &&
    chain[start - 1]!.type === 'assistant' &&
    replyId(chain[start - 1]!.message) === reply
  ) {
    start -= 1;
  }
  const before = chain[start - 1];
  if (!before) return null;
  const { sessionId: fork } = await sdk.forkSession(sessionId, { dir, upToMessageId: before.uuid });
  return fork;
}

function madeCall(message: unknown, toolUseId: string): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  return (
    Array.isArray(content) &&
    content.some((b: { type?: unknown; id?: unknown } | null) => b?.type === 'tool_use' && b.id === toolUseId)
  );
}

function replyId(message: unknown): string | null {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * What the fork is told. The reply that made the call is gone from its context, so the
 * call is spelled out, and so is any decision the human made while it waited — the
 * resume that should have delivered it never ran.
 */
function unavailableNote(
  call: DeferredTool,
  staged: { toolName: string; decision: Decision } | undefined,
): string {
  const input = JSON.stringify(call.input ?? {});
  const lines = [
    `Your last reply was lost. It ended in a ${call.name} call that never ran: the tool ` +
      `was not available when this session resumed. The call was:`,
    `${call.name} ${input.length > 1_500 ? `${input.slice(0, 1_500)}…` : input}`,
  ];
  const d = staged?.decision;
  if (!staged || !d) {
    lines.push(
      'Make the call again if you still need it. If the tool is still missing, carry on ' +
        'without it and say what you could not do.',
    );
  } else if (d.type === 'deny') {
    lines.push(
      `The human declined your ${staged.toolName} call${d.message ? `: ${d.message}` : ''}. ` +
        `Do not retry it. Continue with the rest of the task, or stop if nothing else remains.`,
    );
  } else if (d.type === 'answer') {
    lines.push(`The human answered your ${staged.toolName} call. Make it again now to read the answer.`);
  } else {
    lines.push(
      `The human approved your ${staged.toolName} call. Make it again now and carry on ` +
        `from where you stopped.`,
    );
  }
  return lines.join('\n');
}

/** Tool responses have no single error shape; look for the common markers. */
function looksLikeError(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  if (r['is_error'] === true || r['isError'] === true) return true;
  if (typeof r['error'] === 'string' && r['error'].length > 0) return true;
  if (typeof r['stderr'] === 'string' && r['stderr'].length > 0 && r['stdout'] === '') return true;
  return false;
}
