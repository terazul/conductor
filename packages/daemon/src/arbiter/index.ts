/**
 * The Arbiter — every human decision in one place.
 *
 * WHY THIS SHAPE (read before changing the state machine)
 * ───────────────────────────────────────────────────────
 * The Phase-0 spike measured the two ways a blocked agent can be made durable,
 * and they are not equivalent:
 *
 *   PreToolUse -> 'defer'   query ends with terminal_reason='tool_deferred' and
 *                           names the exact call in `deferred_tool_use`. On
 *                           resume the SAME call is re-offered automatically:
 *                           678 ms, no extra model turn, no nudge.
 *   interrupt()             aborts a pending canUseTool in ~32 ms and ends the
 *                           query ('aborted_tools'), but resume does NOT
 *                           re-offer. It needs a synthetic continuation message
 *                           and the model RE-DECIDES what to do: ~26 s and a
 *                           full extra turn.
 *
 * `defer` is strictly better — but it can only be returned from PreToolUse,
 * which fires BEFORE the SDK decides whether a human is needed at all. Deferring
 * there would park calls that an allow-rule or `acceptEdits` was about to
 * approve, which would stop an agent dead on every tool call. Guessing the SDK's
 * permission outcome ourselves would duplicate logic that is not ours and would
 * rot on the next SDK release.
 *
 * So the rule is: only ever park a call we KNOW needs a human, and we only know
 * that once canUseTool has fired.
 *
 *   canUseTool fires  ─ a human is definitely required
 *     ├─ a persisted "allow always" rule covers it → allow, no request at all
 *     ├─ create the request (block_mode 'held'), hold the promise
 *     ├─ nobody is watching (no WS client)  → escalate to parked immediately;
 *     │                                       holding a process for an empty
 *     │                                       browser is pure waste
 *     └─ otherwise hold until DEFER_AFTER, then escalate to parked
 *
 *   PreToolUse (async, sees EVERY call — finding A)
 *     ├─ this agent was answered while parked → apply that decision here, which
 *     │  is the cheap `defer`-style path: allow/deny straight from the hook
 *     ├─ the same call is re-offered while its request is STILL open → 'defer'
 *     │  again, so a re-park costs nothing — except an MCP call, which is denied
 *     │  with a reason: a deferred MCP call cannot be resumed (Amendment 30)
 *     └─ otherwise {async:true} — never block the agent on us (CONTRACT.md §5.4)
 *
 * DURABILITY. `defer` is not what makes a parked agent survive `kill -9`; the
 * requests row plus agents.sdk_session_id are. On boot, any request still open
 * whose holding process is gone is re-labelled 'parked' (#recoverOrphans), so a
 * daemon killed mid-decision comes back answerable. That is PLAN.md §1 finding B
 * delivered without depending on which mechanism ended the query.
 *
 * AN ENGINE WITHOUT `defer` (Amendment 76: GitHub Copilot, OpenRouter) is never parked
 * by the clock. Parking is cheap for Claude because `defer` re-offers the call; on an
 * engine that can't, ending the run would only make the model decide again. Its
 * callback can wait as long as it likes, so a held request stays held until it is
 * answered, or the agent is paused. On boot, one of its held requests has nothing left
 * to answer — the call it asked about went with the process — so it is expired, said
 * why, and the agent resumes and asks again if it still needs to.
 */

import type {
  BlockMode,
  Decision,
  DecisionSummary,
  PendingRequest,
  PermissionSuggestion,
} from '@conductor/shared';
import type { PermissionDecision } from '../session/backend.js';
import { backendFor } from '../session/backends/index.js';
import type { Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub } from '../hub.js';
import {
  getAgent,
  getAgentProvider,
  getRequest,
  insertRequest,
  insertRule,
  newId,
  nowIso,
  openRequests,
  openRequestsForAgent,
  pendingRequests,
  resolveRequest,
  rulesForProject,
  setAgentStatus,
  setRequestBlockMode,
  type RequestRecord,
} from '../session/store.js';
import { extractQuestions, reversibility, toolLabel } from '../session/translate.js';

/**
 * How long a blocked agent is kept warm before we let its process go.
 *
 * PLAN.md §1 says 90 s and CONTRACT.md §8 leaves the final value to this spike.
 * The measurement: a park costs ~0.7 s and one replayed turn to come back, so
 * parking early is cheap and 90 s is a safe, conservative default. Lowering it
 * to ~30 s would free slots sooner at the cost of more replayed turns — a real
 * trade, so the number stays configurable and the default stays as planned.
 */
export const DEFER_AFTER_MS = Number(process.env.CONDUCTOR_DEFER_AFTER_MS ?? 90_000);

/** What the runner's PreToolUse hook should do with a call. */
export type PreToolVerdict =
  | { kind: 'observe' }
  | { kind: 'allow'; reason: string; updatedInput?: Record<string, unknown> }
  | { kind: 'deny'; reason: string }
  | { kind: 'park'; reason: string };

export interface PermissionAsk {
  agentId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  cwd?: string;
  suggestions?: PermissionSuggestion[];
  matchedRule?: string;
  signal?: AbortSignal;
}

/**
 * What the Arbiter needs from the running agent. Implemented by the Supervisor
 * and injected, so the Arbiter never imports the runner (and there is no cycle).
 */
export interface AgentControl {
  /** End the turn of a live agent whose held request has aged out. */
  interrupt(agentId: string): Promise<void>;
  /** Relaunch a parked agent with options.resume so its pending call proceeds. */
  resumeParked(agentId: string): void;
  /** True while a query() is iterating for this agent. */
  isLive(agentId: string): boolean;
}

interface Held {
  requestId: string;
  agentId: string;
  resolve: (r: PermissionDecision) => void;
  /** When it escalates to parked. None on an engine that can't defer: it holds. */
  timer: NodeJS.Timeout | undefined;
}

/** A decision taken while the agent had no live process, waiting for its resume. */
interface PendingDecision {
  requestId: string;
  toolName: string;
  toolUseId: string | null;
  decision: Decision;
}

export class Arbiter {
  #db: Db;
  #control: AgentControl | null = null;
  /** requestId → the live canUseTool promise it is holding. */
  #held = new Map<string, Held>();
  /** agentId → decision to apply from PreToolUse on the next run. */
  #decided = new Map<string, PendingDecision>();

  constructor(db: Db) {
    this.#db = db;
  }

  attach(control: AgentControl): void {
    this.#control = control;
  }

  // ── snapshot + broadcast ──────────────────────────────────────────────────

  pending(): PendingRequest[] {
    return pendingRequests(this.#db);
  }

  #broadcastPending(): void {
    hub().broadcast({ type: 'pending', pending: this.pending() });
  }

  /**
   * A daemon that died while agents were blocked comes back with rows that claim
   * to be 'held' by a process that no longer exists. Re-label them so the queue
   * tells the truth and answering them takes the resume path.
   */
  recoverOrphans(): number {
    let moved = 0;
    let expired = 0;
    for (const r of openRequests(this.#db)) {
      if (r.blockMode === 'held' && !this.#held.has(r.id)) {
        if (!this.#defers(r.agentId)) {
          this.#expireOrphan(r);
          expired += 1;
          continue;
        }
        setRequestBlockMode(this.#db, r.id, 'parked');
        setAgentStatus(this.#db, r.agentId, 'blocked', 'parked');
        moved += 1;
      }
    }
    if (moved > 0) console.log(`[arbiter] recovered ${moved} orphaned request(s) as parked`);
    if (expired > 0) console.log(`[arbiter] expired ${expired} orphaned request(s) an engine without defer cannot re-offer`);
    if (moved + expired > 0) this.#broadcastPending();
    return moved + expired;
  }

  /** Whether this agent's engine can re-offer a call it parked (`defer`). Claude can. */
  #defers(agentId: string): boolean {
    return backendFor(getAgentProvider(this.#db, agentId))?.capabilities.defer ?? true;
  }

  /**
   * A held request of an engine that can't defer, found after a restart (Amendment 76).
   * The call it asked about went with the process, so an answer would reach nothing.
   * Expired with the reason, rather than parked for an answer that could only start a
   * resume the model would re-decide anyway. The agent is put back to `working`, which
   * is what it was doing, so `Supervisor.reconcile` — run right after this — resumes it
   * with RESTART_NUDGE, and it asks again if it still needs to.
   */
  #expireOrphan(r: RequestRecord): void {
    const note = 'Conductor restarted while this was waiting. This engine cannot keep a pending call across a restart, so the question was dropped; the agent resumes and asks again if it still needs to.';
    resolveRequest(this.#db, r.id, { type: 'expired', by: 'system', note });
    eventLog().emit(
      { projectId: r.projectId, jobId: r.jobId, agentId: r.agentId },
      { kind: 'resolved', requestId: r.id, decision: { type: 'expired', by: 'system', note } },
    );
    if (getAgent(this.#db, r.agentId)?.status === 'blocked' && openRequestsForAgent(this.#db, r.agentId).length === 0) {
      setAgentStatus(this.#db, r.agentId, 'working');
    }
  }

  // ── PreToolUse: observation, plus the two cheap decision paths ────────────

  /**
   * Called from the async PreToolUse hook for EVERY tool call. Must be fast and
   * must never throw — the agent is waiting on the hook's return value.
   */
  preToolUse(ctx: {
    agentId: string;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }): PreToolVerdict {
    // 1. Answered while parked: apply it here rather than waiting for canUseTool.
    //    This is the path the spike measured at 678 ms with no extra model turn.
    const decided = this.#decided.get(ctx.agentId);
    if (decided && decided.toolName === ctx.toolName) {
      this.#decided.delete(ctx.agentId);
      const d = decided.decision;
      if (d.type === 'deny') {
        return { kind: 'deny', reason: d.message || 'denied by the human' };
      }
      if (d.type === 'allow_always') {
        this.#persistRules(ctx.agentId, d.suggestions);
        return { kind: 'allow', reason: 'allowed always by the human' };
      }
      if (d.type === 'answer') {
        return {
          kind: 'allow',
          reason: 'question answered by the human',
          updatedInput: this.#answerInput(decided, d),
        };
      }
      // allow_once, and allow_edited — whose updatedInput cannot be honoured on
      // this path (PLAN.md §1: `defer` drops updatedInput), so it degrades to a
      // plain allow. The routes layer refuses allow_edited for parked requests,
      // so reaching here means the request was escalated after the edit.
      return { kind: 'allow', reason: 'allowed by the human' };
    }

    // 2. The same call re-offered while its request is still open: re-park it.
    //    Cheap, and it keeps a parked agent parked instead of burning a slot.
    const stillOpen = openRequestsForAgent(this.#db, ctx.agentId).find(
      (r) => r.toolUseId === ctx.toolUseId || r.toolName === ctx.toolName,
    );
    if (stillOpen) {
      /*
       * Never an MCP call. On resume the SDK checks that a deferred call's tool exists
       * before the session's MCP servers have reconnected, finds it missing, and ends
       * the run `tool_deferred_unavailable` without running it. The call it left open
       * never gets a result, so every resume after that fails the same way, for good
       * (Amendment 30). Declining with a reason costs the model one retry instead.
       */
      if (ctx.toolName.startsWith('mcp__')) {
        return {
          kind: 'deny',
          reason:
            `Not run: a ${ctx.toolName} call is waiting for the human's decision. ` +
            `Make this call again once that one has been answered.`,
        };
      }
      return { kind: 'park', reason: `awaiting decision ${stillOpen.id}` };
    }

    return { kind: 'observe' };
  }

  // ── canUseTool: a human is definitely required ────────────────────────────

  /**
   * The canUseTool implementation. Returning this promise is what holds the
   * agent; the SDK documents that it may stay pending indefinitely and the spike
   * confirmed 65 s (and, accidentally, four minutes) with the tool still running
   * afterwards.
   */
  async requestPermission(ask: PermissionAsk): Promise<PermissionDecision> {
    const agent = getAgent(this.#db, ask.agentId);
    if (!agent) return { behavior: 'deny', message: 'unknown agent' };

    /*
     * What the agent's own guardrails already allow, Conductor answers (Amendment 67).
     * With Bash in `allowedTools` — "run shell unattended" — Claude Code still asks about
     * commands its own checks flag: `cd x && git …`, `$VARIABLES`, a clone. The user
     * chose: when shell is on, those don't reach Needs you either. The same for MCP tools
     * under "allow MCP tools" (`mcp__*`). Deny rules were applied before this was asked,
     * so `no push` still holds; a reading role never has Bash allowed.
     */
    const unattended = allowedUnattended(agent.autonomy.allowedTools, ask.toolName);
    if (unattended) {
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
        {
          kind: 'resolved',
          requestId: `guard:${ask.toolUseId}`,
          decision: { type: 'allow_once', by: 'rule', note: unattended },
        },
      );
      return { behavior: 'allow' };
    }

    // An "allow always" earned earlier means we must not ask again.
    const rule = this.#matchRule(agent.projectId, ask.toolName, ask.input);
    if (rule) {
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
        {
          kind: 'resolved',
          requestId: `rule:${rule.id}`,
          decision: { type: 'allow_always', by: 'rule', note: rule.toolName },
        },
      );
      return { behavior: 'allow' };
    }

    const isQuestion = ask.toolName === 'AskUserQuestion';
    const questions = isQuestion ? extractQuestions(ask.input) : undefined;
    const requestId = newId('req');
    const label = toolLabel(ask.toolName, ask.input, agent.jobId);

    const record: Omit<RequestRecord, 'resolvedAt' | 'decision'> = {
      id: requestId,
      agentId: agent.id,
      jobId: agent.jobId,
      projectId: agent.projectId,
      kind: isQuestion ? 'question' : 'permission',
      blockMode: 'held',
      toolName: ask.toolName,
      toolUseId: ask.toolUseId,
      input: ask.input,
      label,
      matchedRule: ask.matchedRule,
      cwd: ask.cwd,
      // Claude Code sends no rule for a call its own checks flagged, which left "allow all
      // session" greyed out on exactly the calls that ask most (Amendment 67).
      suggestions: ask.suggestions && ask.suggestions.length > 0 ? ask.suggestions : fallbackSuggestions(ask.toolName, ask.input),
      reversible: isQuestion ? undefined : reversibility(ask.toolName, ask.input),
      questions,
      createdAt: nowIso(),
    };
    insertRequest(this.#db, record);

    setAgentStatus(this.#db, agent.id, 'blocked', 'held');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
      {
        kind: 'request',
        requestId,
        requestKind: record.kind,
        blockMode: 'held',
        label,
      },
    );
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
      { kind: 'status', status: 'blocked', blockMode: 'held' },
    );
    this.#broadcastPending();

    // Nobody is watching: a held promise pins a process for a browser that
    // cannot answer. Park it now and free the slot. Not on an engine that can't
    // defer: parking it would only end the run (Amendment 76), so it keeps holding.
    const watched = hub().clientCount > 0;
    const holdFor = watched ? DEFER_AFTER_MS : 0;
    const parks = this.#defers(agent.id);

    return new Promise<PermissionDecision>((resolve) => {
      const timer = parks
        ? setTimeout(() => {
            void this.#escalate(requestId);
          }, holdFor)
        : undefined;

      this.#held.set(requestId, { requestId, agentId: agent.id, resolve, timer });

      // If the SDK abandons the call (interrupt, shutdown) stop holding.
      ask.signal?.addEventListener('abort', () => {
        const h = this.#held.get(requestId);
        if (!h) return;
        clearTimeout(h.timer);
        this.#held.delete(requestId);
        // Leave the request OPEN: it is still a question the human owes an
        // answer to, it is just no longer held by a live promise.
        setRequestBlockMode(this.#db, requestId, 'parked');
        setAgentStatus(this.#db, agent.id, 'blocked', 'parked');
        this.#broadcastPending();
      });
    });
  }

  /**
   * A held request outlived DEFER_AFTER (or was never watched). Let the process
   * go: mark parked, then interrupt so the query ends. The request stays open.
   */
  async #escalate(requestId: string): Promise<void> {
    const held = this.#held.get(requestId);
    if (!held) return;
    const request = getRequest(this.#db, requestId);
    if (!request || request.resolvedAt) return;

    clearTimeout(held.timer);
    this.#held.delete(requestId);

    setRequestBlockMode(this.#db, requestId, 'parked');
    const agent = getAgent(this.#db, held.agentId);
    setAgentStatus(this.#db, held.agentId, 'blocked', 'parked');
    if (agent) {
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
        { kind: 'status', status: 'blocked', blockMode: 'parked' },
      );
    }
    this.#broadcastPending();

    // End the turn WITHOUT answering the callback. Resolving it with a deny
    // first looks tempting — it tidies the promise up — but the model then sees
    // a refusal, and on resume it concludes the call was rejected and does not
    // retry. The spike confirmed both halves of this: interrupt() alone aborts
    // the pending callback in ~32 ms and ends the query as 'aborted_tools', and
    // the model re-issues the call after a nudge. The unresolved promise is
    // abandoned with the query and goes away with the runner.
    try {
      await this.#control?.interrupt(held.agentId);
    } catch (err) {
      console.error('[arbiter] interrupt during escalation failed', err);
    }
  }

  // ── applying a decision ───────────────────────────────────────────────────

  /**
   * Answer an open request. Held requests resolve the live promise; parked ones
   * record the decision and relaunch the agent with options.resume.
   */
  decide(requestId: string, decision: Decision, by: DecisionSummary['by'] = 'human'): void {
    const request = getRequest(this.#db, requestId);
    if (!request) throw new Error(`no such request ${requestId}`);
    if (request.resolvedAt) throw new Error(`request ${requestId} is already resolved`);

    const agent = getAgent(this.#db, request.agentId);
    if (!agent) throw new Error(`request ${requestId} has no agent`);

    if (decision.type === 'allow_always') {
      this.#persistRules(request.agentId, decision.suggestions);
    }

    const summary: DecisionSummary = { type: decision.type, by };
    resolveRequest(this.#db, requestId, summary);
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
      { kind: 'resolved', requestId, decision: summary },
    );

    const held = this.#held.get(requestId);
    if (held) {
      clearTimeout(held.timer);
      this.#held.delete(requestId);
      setAgentStatus(this.#db, agent.id, 'working');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
        { kind: 'status', status: 'working' },
      );
      held.resolve(this.#toPermissionDecision(request, decision));
      this.#broadcastPending();
      return;
    }

    // Parked: stage the decision for PreToolUse and bring the session back.
    this.#decided.set(request.agentId, {
      requestId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      decision,
    });
    this.#broadcastPending();
    this.#control?.resumeParked(request.agentId);
  }

  /** Drop any hold for an agent that is being stopped or has failed. */
  cancelForAgent(agentId: string, note = 'agent stopped'): void {
    for (const held of [...this.#held.values()]) {
      if (held.agentId !== agentId) continue;
      clearTimeout(held.timer);
      this.#held.delete(held.requestId);
      resolveRequest(this.#db, held.requestId, { type: 'expired', by: 'system', note });
      held.resolve({ behavior: 'deny', message: note });
    }

    /*
     * PARKED requests have no `#held` entry — the query ended and the ROW is the durable
     * record (that is the whole point of parking) — so the loop above cannot see them.
     *
     * Without this, cancelling a parked agent left its request open forever: a card in
     * "Needs you" asking permission on behalf of an agent that had been paused or
     * terminated, which nothing could clear because the agent was never coming back to
     * answer it. Run after the held loop, so those rows are already resolved and this
     * query returns only the genuinely parked ones.
     */
    for (const open of openRequestsForAgent(this.#db, agentId)) {
      resolveRequest(this.#db, open.id, { type: 'expired', by: 'system', note });
    }

    this.#decided.delete(agentId);
    this.#broadcastPending();
  }

  /**
   * Put an agent's question to one side without answering it — how a paused agent keeps
   * it (Amendment 35). A held request is parked now rather than after DEFER_AFTER, which
   * ends the run and frees its slot; the request stays open, so answering it later is
   * what brings the agent back. True when the agent has an open request, held or
   * parked, and so is asleep on it.
   */
  async parkForAgent(agentId: string): Promise<boolean> {
    for (const held of [...this.#held.values()]) {
      if (held.agentId === agentId) await this.#escalate(held.requestId);
    }
    return openRequestsForAgent(this.#db, agentId).length > 0;
  }

  /** True when this agent has an answered decision waiting for its resume. */
  hasStagedDecision(agentId: string): boolean {
    return this.#decided.has(agentId);
  }

  // ── Decision → PermissionDecision, which each backend turns into its SDK's shape ───────────────────────────────────────

  /**
   * The mapping the whole attention screen rests on. `allow_edited` is only
   * reachable here (the held path); a parked request cannot honour updatedInput.
   */
  #toPermissionDecision(request: RequestRecord, decision: Decision): PermissionDecision {
    switch (decision.type) {
      case 'allow_once':
        return { behavior: 'allow' };

      case 'allow_always':
        return {
          behavior: 'allow',
          // Echo the SDK's own suggestions back so it writes the rule itself
          // (localSettings → .claude/settings.local.json).
          updatedPermissions: decision.suggestions as never,
        };

      case 'allow_edited':
        return {
          behavior: 'allow',
          updatedInput: (decision.updatedInput ?? {}) as Record<string, unknown>,
        };

      case 'deny':
        return { behavior: 'deny', message: decision.message || 'denied by the human' };

      case 'answer':
        return {
          behavior: 'allow',
          updatedInput: this.#answerInput(
            { requestId: request.id, toolName: request.toolName, toolUseId: request.toolUseId },
            decision,
          ),
        };
    }
  }

  /**
   * AskUserQuestion's reply. The SDK's output shape is
   * `{ questions, answers, response? }` where `answers` maps question text to a
   * single string — multi-select answers are comma-separated, so arrays join.
   */
  #answerInput(
    ctx: { requestId: string; toolName: string; toolUseId: string | null },
    decision: Extract<Decision, { type: 'answer' }>,
  ): Record<string, unknown> {
    const request = getRequest(this.#db, ctx.requestId);
    const answers: Record<string, string> = {};
    for (const [question, value] of Object.entries(decision.answers)) {
      answers[question] = Array.isArray(value) ? value.join(', ') : value;
    }
    return {
      questions: request?.questions ?? [],
      answers,
      ...(decision.response ? { response: decision.response } : {}),
    };
  }

  // ── "allow always" rules ──────────────────────────────────────────────────

  /**
   * Persist the rule ourselves as well as handing it to the SDK. A parked
   * request has no live callback to return `updatedPermissions` from, so without
   * our own copy "allow always" would silently mean "allow once".
   */
  #persistRules(agentId: string, suggestions: PermissionSuggestion[]): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    for (const s of suggestions) {
      const raw = s as Record<string, unknown>;
      const rules = raw['rules'];
      if (!Array.isArray(rules)) continue;
      for (const r of rules) {
        const rr = (r ?? {}) as Record<string, unknown>;
        const toolName = typeof rr['toolName'] === 'string' ? rr['toolName'] : undefined;
        if (!toolName) continue;
        insertRule(this.#db, {
          projectId: agent.projectId,
          agentId,
          toolName,
          ruleContent: typeof rr['ruleContent'] === 'string' ? rr['ruleContent'] : null,
          suggestion: s,
        });
      }
    }
  }

  /**
   * Does a stored rule cover this call? `ruleContent` follows the SDK's rule
   * syntax, of which only the prefix forms are honoured here — `npm test:*`, which
   * is how Claude Code writes "any command starting with npm test", and a bare
   * trailing `*`. Anything more exotic is left to the SDK's own matcher via
   * updatedPermissions.
   *
   * `:*` used to be read as a literal colon followed by `*`, so `npm test:*` matched
   * only commands starting `npm test:` — none — and Conductor's own copy of every
   * Bash "allow always" rule allowed nothing (found in Amendment 48).
   */
  #matchRule(
    projectId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): { id: string; toolName: string } | undefined {
    const subject =
      typeof input['command'] === 'string'
        ? input['command']
        : typeof input['file_path'] === 'string'
          ? input['file_path']
          : '';

    for (const rule of rulesForProject(this.#db, projectId)) {
      if (rule.toolName !== toolName) continue;
      if (!rule.ruleContent) return { id: rule.id, toolName: rule.toolName };
      if (ruleCovers(rule.ruleContent, subject)) {
        return { id: rule.id, toolName: rule.toolName };
      }
    }
    return undefined;
  }

  /** Requests a given agent currently has open — used by the runner on shutdown. */
  openFor(agentId: string): RequestRecord[] {
    return openRequestsForAgent(this.#db, agentId);
  }

  /** Staged decision for an agent about to resume, if any. */
  stagedFor(agentId: string): PendingDecision | undefined {
    return this.#decided.get(agentId);
  }

  /**
   * Drop a staged decision the resumed run never consumed — the model chose not
   * to re-issue the call. Without this a stale "allow" would silently approve an
   * unrelated call of the same tool on some later run.
   */
  clearStaged(agentId: string): void {
    this.#decided.delete(agentId);
  }

  get blockModeFor(): (agentId: string) => BlockMode | null {
    return (agentId: string) => {
      const open = openRequestsForAgent(this.#db, agentId)[0];
      return open ? open.blockMode : null;
    };
  }
}

/**
 * Whether a rule's content covers a call's subject (its command, or file path). Pure,
 * so session/verify.ts checks it.
 */
export function ruleCovers(pattern: string, subject: string): boolean {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    // `npm test:*` is `npm test` and anything after it — not `npm tester`.
    return subject === prefix || subject.startsWith(`${prefix} `);
  }
  if (pattern.endsWith('*')) return subject.startsWith(pattern.slice(0, -1));
  return subject === pattern;
}

/**
 * The rule in `rules` — `disallowedTools` or `allowedTools`, in Claude Code's syntax —
 * that covers a call, or null. For an engine that applies no such list itself
 * (Amendment 76), so Conductor's permission callback has to.
 *
 *   `Bash`                the whole tool
 *   `Bash(git push:*)`    a command, by ruleCovers; `Edit(src/x.ts)` a path
 *   `mcp__srv` `mcp__srv__*`   every tool of an MCP server
 *
 * A shell command is split where one command ends and the next begins (`&&`, `;`, `|`,
 * `$(`, …), so `cd x && git push` is a `git push`. A deny needs one part covered; an
 * allow needs every part, or `npm test && rm -rf /` would be allowed by `npm test:*`.
 * Best effort on purpose: a deny that matches too much is the safe way to be wrong.
 */
export function toolRuleFor(
  rules: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
  mode: 'deny' | 'allow',
): string | null {
  for (const rule of rules) {
    const m = /^([^()]+?)\s*(?:\((.*)\))?$/s.exec(rule.trim());
    if (!m) continue;
    const name = m[1]!;
    const pattern = m[2]?.trim();
    const named =
      name === toolName ||
      (name.endsWith('*') && toolName.startsWith(name.slice(0, -1))) ||
      (name.startsWith('mcp__') && name.split('__').length === 2 && toolName.startsWith(`${name}__`));
    if (!named) continue;
    if (!pattern || pattern === '*') return rule;
    const subjects = ruleSubjects(toolName, input);
    if (subjects.length === 0) continue;
    const covered = (s: string) => ruleCovers(pattern, s);
    if (mode === 'deny' ? subjects.some(covered) : subjects.every(covered)) return rule;
  }
  return null;
}

/** What a rule's pattern is matched against: each command of a shell line, or a path or URL. */
function ruleSubjects(toolName: string, input: Record<string, unknown>): string[] {
  const command = typeof input['command'] === 'string' ? input['command'] : null;
  if (toolName === 'Bash' && command !== null) {
    const parts = command
      // `2>&1` redirects; it doesn't start another command.
      .replace(/\d*>&\d*/g, ' ')
      .split(/&&|\|\||[;|&\n`]|\$\(|[()]/)
      // `FOO=1 git push` is a git push.
      .map((p) => p.trim().replace(/\s+/g, ' ').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts : [command.trim()];
  }
  for (const k of ['file_path', 'path', 'notebook_path', 'url']) {
    if (typeof input[k] === 'string') return [input[k]];
  }
  return [];
}

/**
 * Whether the agent's guardrails let this tool run without asking, and in whose words:
 * `run shell unattended` for Bash, `allow MCP tools` for an MCP server's tool. Null when
 * they don't — then the call asks, as it always did. (Amendment 67)
 */
export function allowedUnattended(allowedTools: readonly string[], toolName: string): string | null {
  if (toolName === 'Bash' && allowedTools.includes('Bash')) return 'run shell unattended';
  if (toolName.startsWith('mcp__') && allowedTools.includes('mcp__*')) return 'allow MCP tools';
  return null;
}

/**
 * The "allow all session" rule Conductor offers when Claude Code offered none: the exact
 * command for Bash — what was flagged is that command, not every command — and the whole
 * tool for anything else. Session-scoped for Claude Code; Conductor keeps its own copy
 * for the project, as for every allow-always (see #persistRules).
 */
export function fallbackSuggestions(toolName: string, input: Record<string, unknown>): PermissionSuggestion[] {
  if (toolName === 'AskUserQuestion') return [];
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (toolName === 'Bash' && !command) return [];
  const rule = toolName === 'Bash' ? { toolName, ruleContent: command } : { toolName };
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
}

let instance: Arbiter | null = null;

export function initArbiter(db: Db): Arbiter {
  instance = new Arbiter(db);
  return instance;
}

export function arbiter(): Arbiter {
  if (!instance) throw new Error('Arbiter not initialised — call initArbiter(db) first');
  return instance;
}
