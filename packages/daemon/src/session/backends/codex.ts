/** Run Conductor agents on Codex using the daemon user's ChatGPT subscription. */
import type { Autonomy, CodexUsageResponse, CodexUsageWindow, EventPayload } from '@conductor/shared';
import { arbiter } from '../../arbiter/index.js';
import { broadcastSpend } from '../../daily.js';
import type { Db } from '../../db/index.js';
import { eventLog } from '../../eventlog.js';
import { modelAnswered } from '../alerts.js';
import type { AgentBackend, ProviderModel, RunOpts, RunOutcome, RunnerScope } from '../backend.js';
import { addSpendToday, finishRun, getAgent, setAgentSession, setAgentUsage, startRun } from '../store.js';
import { toolLabel, toolSummary } from '../translate.js';
import { array, type CodexConnection, codexRuntime, type Json, object, string } from './codex-client.js';

type End = { error?: string; interrupted?: boolean };
const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }];
const errorLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 400);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

async function requireChatGPT(client: CodexConnection): Promise<void> {
  const status = await client.call('account/read', { refreshToken: false });
  if (object(status.account).type !== 'chatgpt') {
    client.close();
    throw new Error('Run codex login as the Conductor daemon user and choose Sign in with ChatGPT.');
  }
}

export async function codexUnavailable(): Promise<string | null> {
  try {
    await requireChatGPT(await codexRuntime.client());
    return null;
  } catch (err) {
    return errorLine(err);
  }
}

function usageWindow(value: unknown): CodexUsageWindow | null {
  const { usedPercent, windowDurationMins, resetsAt } = object(value);
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return null;
  const reset = typeof resetsAt === 'number' && resetsAt > 0 ? new Date(resetsAt * 1000) : null;
  return {
    remainingPercent: Math.max(0, 100 - usedPercent),
    durationMinutes: typeof windowDurationMins === 'number' && Number.isSafeInteger(windowDurationMins) && windowDurationMins > 0
      ? windowDurationMins : null,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
  };
}

export async function codexUsage(): Promise<CodexUsageResponse> {
  const client = await codexRuntime.client();
  await requireChatGPT(client);
  const response = await client.call('account/rateLimits/read', {});
  const limits = object(object(response.rateLimitsByLimitId).codex ?? response.rateLimits);
  return {
    windows: [usageWindow(limits.primary), usageWindow(limits.secondary)].filter((window) => window !== null),
  };
}

export async function codexModels(): Promise<ProviderModel[]> {
  const client = await codexRuntime.client();
  await requireChatGPT(client);
  const models = new Map<string, ProviderModel>();
  let cursor: string | null = null;
  do {
    const response = await client.call('model/list', { cursor, limit: 100, includeHidden: false, modelProvider: 'openai' });
    for (const entry of array(response.data)) {
      const model = object(entry);
      const id = string(model.model) || string(model.id);
      if (!id || model.hidden === true) continue;
      const efforts = array(model.supportedReasoningEfforts).map((e) => string(object(e).reasoningEffort)).filter(Boolean);
      models.set(id, { id, displayName: string(model.displayName) || id, ...(efforts.length ? { efforts } : {}) });
    }
    const next = string(response.nextCursor) || null;
    if (next === cursor) break;
    cursor = next;
  } while (cursor);
  return [...models.values()];
}

export function codexAutonomyProblem(autonomy: Autonomy): string | null {
  if (autonomy.allowedTools.length || autonomy.disallowedTools.length) return 'Codex uses its own sandbox and approval modes. Clear Conductor tool rules for this agent.';
  if (autonomy.mode === 'bypassPermissions') return 'Codex requires a sandbox. Choose a different permission mode.';
  return null;
}

export class CodexBackend implements AgentBackend {
  readonly #db: Db;
  readonly #scope: RunnerScope;
  readonly #asks = new AbortController();
  readonly #items = new Map<string, { tool: string; input: Json }>();
  #client: CodexConnection | null = null;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #live = false;
  #stopping = false;
  #end: ((result: End) => void) | null = null;
  #total: { input: number; output: number } | null = null;

  constructor(db: Db, scope: RunnerScope) {
    this.#db = db;
    this.#scope = scope;
  }

  get agentId(): string { return this.#scope.agentId; }
  get isLive(): boolean { return this.#live; }
  get sessionId(): string | null { return this.#threadId; }

  #emit(payload: EventPayload): void {
    const { projectId, jobId, agentId } = this.#scope;
    eventLog().emit({ projectId, jobId, agentId }, payload);
  }

  async run(opts: RunOpts): Promise<RunOutcome> {
    const scope = this.#scope;
    this.#threadId = opts.resume ?? null;
    const outcome: RunOutcome = {
      sessionId: this.#threadId, terminalReason: null, deferredTool: null, isError: false,
      errorDetail: null, costUsd: scope.spentUsd,
    };
    const runId = startRun(this.#db, this.agentId, this.#threadId);
    this.#live = true;
    const ended = new Promise<End>((resolve) => { this.#end = resolve; });
    let off: (() => void) | undefined;

    try {
      const problem = codexAutonomyProblem(scope.autonomy);
      if (problem) throw new Error(problem);
      const client = this.#client = await codexRuntime.client();
      await requireChatGPT(client);
      if (this.#stopping) return this.#aborted(outcome);
      const mode = scope.autonomy.mode;
      const readOnly = mode === 'plan';
      const approvalPolicy = readOnly || mode === 'dontAsk' ? 'never' : 'on-request';
      const config = {
        cwd: scope.worktreePath, model: scope.model, modelProvider: 'openai',
        approvalPolicy, approvalsReviewer: 'user',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        ...(scope.systemPrompt ? { developerInstructions: scope.systemPrompt } : {}),
      };
      const opened = this.#threadId
        ? await client.call('thread/resume', { ...config, threadId: this.#threadId })
        : await client.call('thread/start', { ...config, serviceName: 'conductor' });
      const threadId = string(object(opened.thread).id);
      if (!threadId || (this.#threadId && threadId !== this.#threadId)) throw new Error('Codex returned an unexpected thread ID.');
      this.#threadId = outcome.sessionId = threadId;
      setAgentSession(this.#db, this.agentId, threadId);
      if (this.#stopping) return this.#aborted(outcome);
      if (!opts.prompt) {
        outcome.terminalReason = 'completed';
        return outcome;
      }

      off = client.watch(threadId, (message) => {
        try {
          this.#receive(client, message);
        } catch (err) {
          this.#end?.({ error: errorLine(err) });
        }
      });
      this.#emit({ kind: 'user_text', text: opts.prompt, ...(opts.synthetic ? { synthetic: true } : {}) });
      const started = await client.call('turn/start', {
        threadId, input: textInput(opts.prompt), approvalPolicy, approvalsReviewer: 'user',
        model: scope.model, ...(scope.autonomy.effort ? { effort: scope.autonomy.effort } : {}),
        sandboxPolicy: readOnly ? { type: 'readOnly' } : {
          type: 'workspaceWrite', writableRoots: [scope.worktreePath, ...(scope.extraDirs ?? [])], networkAccess: false,
        },
      });
      this.#turnId ??= string(object(started.turn).id) || null;
      if (!this.#turnId) throw new Error('Codex returned no turn ID.');
      if (this.#stopping) await this.#interruptTurn();
      const result = await ended;
      if (this.#stopping || result.interrupted) return this.#aborted(outcome);
      if (result.error) throw new Error(result.error);
      outcome.terminalReason = 'completed';
    } catch (err) {
      if (this.#stopping) return this.#aborted(outcome);
      outcome.isError = true;
      outcome.terminalReason = 'session_error';
      outcome.errorDetail = errorLine(err);
      await this.#interruptTurn();
    } finally {
      this.#asks.abort();
      this.#live = false;
      off?.();
      for (const toolUseId of this.#items.keys()) {
        this.#emit({ kind: 'tool_end', toolUseId, ok: false, summary: 'Codex turn ended before the tool finished.' });
      }
      this.#items.clear();
      if (this.#client && this.#threadId) {
        await this.#client.call('thread/unsubscribe', { threadId: this.#threadId }, 2_000).catch(() => {});
      }
      this.#turnId = null;
      this.#end = null;
      finishRun(this.#db, runId, { sdkSessionId: outcome.sessionId, terminalReason: outcome.terminalReason ?? undefined });
    }
    return outcome;
  }

  #aborted(outcome: RunOutcome): RunOutcome {
    outcome.terminalReason = 'aborted_streaming';
    return outcome;
  }

  #receive(client: CodexConnection, message: Json): void {
    const { id, method } = message;
    const params = object(message.params);
    if (method === 'closed') {
      this.#end?.({ error: string(params.message) });
      return;
    }
    const turn = object(params.turn);
    if (method === 'turn/started') this.#turnId ??= string(turn.id) || null;
    const turnId = string(params.turnId) || string(turn.id);
    if (turnId && this.#turnId && turnId !== this.#turnId) {
      if (typeof id === 'string' || typeof id === 'number') client.rejectRequest(id);
      return;
    }
    if (typeof id === 'string' || typeof id === 'number') {
      void this.#answer(client, id, string(method), params).catch(() => client.rejectRequest(id));
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.#item(method === 'item/started', object(params.item));
    } else if (method === 'thread/tokenUsage/updated' && turnId && this.#turnId) {
      this.#usage(object(params.tokenUsage));
    } else if (method === 'turn/completed') {
      const error = string(object(turn.error).message);
      this.#end?.(turn.status === 'failed' ? { error: error || 'Codex turn failed.' } : { interrupted: turn.status === 'interrupted' });
    }
  }

  #item(start: boolean, item: Json): void {
    const toolUseId = string(item.id);
    if (!toolUseId) return;
    if (item.type === 'agentMessage' && !start) {
      const text = string(item.text);
      if (text.trim()) {
        this.#emit({ kind: 'text', text });
        modelAnswered(this.agentId);
      }
      return;
    }
    if (start) {
      let call: { tool: string; input: Json };
      if (item.type === 'commandExecution') {
        call = { tool: 'Bash', input: { command: string(item.command) } };
      } else if (item.type === 'fileChange') {
        const paths = array(item.changes).map((change) => string(object(change).path)).filter(Boolean);
        call = { tool: 'Edit', input: { file_path: paths[0] ?? '', paths } };
      } else if (item.type === 'mcpToolCall') {
        call = { tool: `mcp__${string(item.server)}__${string(item.tool)}`, input: object(item.arguments) };
      } else return;
      this.#items.set(toolUseId, call);
      this.#emit({ kind: 'tool_start', toolUseId, ...call, label: toolLabel(call.tool, call.input, this.#scope.worktreePath) });
    } else {
      const call = this.#items.get(toolUseId);
      if (!call) return;
      this.#items.delete(toolUseId);
      const ok = item.status === 'completed';
      this.#emit({ kind: 'tool_end', toolUseId, ok, summary: toolSummary(call.tool, item.aggregatedOutput ?? '', ok) });
    }
  }

  async #answer(client: CodexConnection, id: string | number, method: string, params: Json): Promise<void> {
    const itemId = string(params.itemId) || `codex:${id}`;
    if (method === 'item/permissions/requestApproval') {
      client.reply(id, { permissions: {}, scope: 'turn' });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = array(params.questions).map(object).filter((q) => q.isSecret !== true);
      const result = this.#stopping || !questions.length ? null : await this.#ask('AskUserQuestion', itemId, {
        questions: questions.map((q) => ({
          question: string(q.question), header: string(q.header), options: array(q.options).map(object), multiSelect: false,
        })),
      });
      const given = object(result?.behavior === 'allow' ? result.updatedInput?.answers : null);
      client.reply(id, { answers: Object.fromEntries(questions.flatMap((q) => {
        const answer = given[string(q.question)] ?? given[string(q.header)];
        return typeof answer === 'string' ? [[string(q.id), { answers: [answer] }]] : [];
      })) });
      return;
    }
    const shell = method === 'item/commandExecution/requestApproval';
    if (!shell && method !== 'item/fileChange/requestApproval') {
      client.rejectRequest(id);
      return;
    }
    const call = this.#items.get(itemId);
    const command = string(params.command) || string(call?.input.command);
    const input = shell ? { command, ...(params.reason ? { description: string(params.reason) } : {}) } : call?.input;
    if (this.#stopping || params.networkApprovalContext || params.grantRoot || !input || (shell && !command)) {
      client.reply(id, { decision: 'decline' });
      return;
    }
    const result = await this.#ask(shell ? 'Bash' : 'Edit', itemId, input, string(params.cwd));
    const allowed = result.behavior === 'allow' && !Object.keys(result.updatedInput ?? {}).length && !this.#stopping;
    client.reply(id, { decision: allowed ? 'accept' : 'decline' });
  }

  #ask(toolName: string, toolUseId: string, input: Json, cwd?: string) {
    return arbiter().requestPermission({
      agentId: this.agentId, toolName, toolUseId, input, cwd: cwd || this.#scope.worktreePath, signal: this.#asks.signal,
    });
  }

  #usage(usage: Json): void {
    const total = object(usage.total);
    const last = object(usage.last);
    const next = { input: count(total.inputTokens), output: count(total.outputTokens) };
    const input = this.#total ? Math.max(0, next.input - this.#total.input) : count(last.inputTokens);
    const output = this.#total ? Math.max(0, next.output - this.#total.output) : count(last.outputTokens);
    this.#total = next;
    if (!input && !output) return;
    const stored = getAgent(this.#db, this.agentId);
    const inputTokens = (stored?.inputTokens ?? 0) + input;
    const outputTokens = (stored?.outputTokens ?? 0) + output;
    const costUsd = this.#scope.spentUsd;
    setAgentUsage(this.#db, this.agentId, { costUsd, inputTokens, outputTokens });
    const today = addSpendToday(this.#db, this.agentId, { tokens: input + output }, { provider: 'codex', model: this.#scope.model });
    broadcastSpend(this.#db);
    this.#emit({ kind: 'usage', costUsd, inputTokens, outputTokens, today, model: this.#scope.model });
  }

  send(text: string, synthetic = false): boolean {
    const client = this.#client;
    if (!client || !this.#threadId || !this.#turnId || !this.#live || this.#stopping) return false;
    void client.call('turn/steer', {
      threadId: this.#threadId, expectedTurnId: this.#turnId, input: textInput(text),
    }).then(() => this.#emit({ kind: 'user_text', text, ...(synthetic ? { synthetic: true } : {}) }))
      .catch((err: unknown) => this.#emit({ kind: 'text', text: `Codex could not deliver the message: ${errorLine(err)}` }));
    return true;
  }

  async setModel(): Promise<boolean> { return false; }

  async #interruptTurn(): Promise<void> {
    if (!this.#client || !this.#threadId || !this.#turnId) return;
    await this.#client.call('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId }, 5_000).catch(() => {});
  }

  async interrupt(): Promise<void> {
    this.#stopping = true;
    this.#asks.abort();
    await this.#interruptTurn();
    this.#end?.({ interrupted: true });
  }

  async stop(): Promise<void> { await this.interrupt(); }
}
