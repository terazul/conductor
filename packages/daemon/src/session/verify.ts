/**
 * Track A verification — removing a project, end to end, against a real repo.
 *
 * TRACK A owns this file. It does not touch W0's smoke test.
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/session/verify.ts
 *
 * No prerequisites: it builds its own throwaway git repo in $TMPDIR, cuts a real
 * worktree in it, and deletes the lot at the end.
 *
 * WHY THIS SCRIPT EXISTS. `DELETE /api/projects/:id` makes one promise a person
 * has to be able to trust without reading the code: *it forgets, it does not
 * delete*. The cascade runs through three tracks' tables and the neighbouring
 * call in each of them — `WorkspaceService.close`, `WorktreeMgr.remove`,
 * `ServerRegistry.forget` — does touch the filesystem or claim a process died. So
 * the assertions that matter most here are the negative ones: after a removal the
 * worktree directory is still on disk, still registered with git, its branch is
 * still there, and the dev server is still listening.
 *
 * No agent ever reaches the real SDK, so this costs nothing: jobs and agents are
 * inserted through the store, which is what `createJob` would have done before
 * handing them to the SDK, and `sdk.query` is swapped for a fake for the whole run —
 * so a launch nobody meant to cause is a count in `runs`, not a process. Sections 11
 * to 13 launch agents on purpose, through the real supervisor and runner, with the
 * fake reporting whatever cost, retries, replies and ending each check needs.
 *
 * If you interrupt it mid-run the Fastify listener is never closed and the next
 * run dies with EADDRINUSE on 7802:
 *
 *   lsof -ti :7802 | xargs kill -9
 */

import { TURN_END_LINE } from './background.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Agent,
  ModelCatalog,
  Alert,
  DiffResponse,
  FileContentResponse,
  FileTreeResponse,
  Project,
  ServerFrame,
  Snapshot,
  RuleView,
  ProjectNote,
  ProjectSpend,
  TerminalRun,
  ProviderInfo,
  ProviderModelList,
} from '@conductor/shared';
import { allowedUnattended, arbiter, fallbackSuggestions, ruleCovers, toolRuleFor } from '../arbiter/index.js';
import type { PermissionRequest, PermissionRequestResult, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { build } from '../index.js';
import { MCP_TOOLS, callTool, toolsFor } from '../routes/helpers.js';
import { openDb, row, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { preview } from '../preview/index.js';
import { workspace } from '../workspace/service.js';
import type { WorkspaceRecord } from '../workspace/store.js';
import { ALERT_AFTER_MS, Alerts, alerts, classifyRetry, initAlerts, retryNeedsYou } from './alerts.js';
import { JOB_BUDGET_NOTE, agentBudget, budgetNote, budgetRefusal, budgetState, budgetStop, capState, ceilingOf, continuations, isRenewedNote, jobBudgetState, jobCap, newDayNote, renewals, renewedNote, resumeAtMidnight, runLimit, tokens } from './budget.js';
import { backendFor, providerRefusal, registerBackend } from './backends/index.js';
import {
  DEFAULT_AUTONOMY,
  addCostToday,
  addSpendToday,
  agentsThatSpentOn,
  costToday,
  costTotal,
  listProjects,
  projectSpend,
  getAgent,
  jobCostToday,
  spentToday as agentSpentToday,
  getJob,
  insertAgent,
  insertJob,
  finishRun,
  insertRequest,
  insertRule,
  lastDeferredTool,
  listAgents,
  openRequests,
  openRequestsForAgent,
  setJobStatus,
  setAgentSession,
  setAgentUsage,
  nowIso,
  resolveRequest,
  startRun,
  agentsForJob,
  getAgentBrief,
  getAgentProvider,
  getAgentPersona,
  getHandoff,
  getRerunPending,
  setRerunPending,
  setAgentAutonomy,
  setAgentStatus,
  localDay,
  setDayClock,
  helpersOf,
  unreportedHelpers,
} from './store.js';
import { AgentRunner, CUT_SHORT, HELPER_TOOLS, sdk } from './runner.js';
import { ClaudeBackend } from './backends/claude.js';
import { copilotModels, copilotSdk, excludedFor, gateCall, openRouterModels, type CopilotClientLike } from './backends/copilot.js';
import { CopilotEvents, apiFailureOf, askFromPermission } from './backends/copilot-events.js';
import {
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  RetryBook,
  decideRetry,
  failureCause,
  fmtDelay,
  onRetryDue,
  resetRetryBook,
  retryBook,
  retryDelaysMs,
  retryNote,
  type Clock,
} from './retry.js';
import { BUDGET_CEILING_KEY, BUDGET_RESUME_KEY, RETRY_DELAYS_KEY, budgetCeiling } from '@conductor/shared';
import { askGateway, catalog, forgetCatalog, forgetProviderModels, known, modelSources, providerModels, refusal } from './models.js';
import { forgetWindows, recordWindows, reportedWindow } from './windows.js';
import {
  HAND_OFF_LINE,
  REPEAT_MARKER,
  STACK_ASK_LINE,
  contextWindow,
  dropRepeats,
  fitTurns,
  handoffCap,
  handoffSection,
  helperReport,
  inStack,
  shareCap,
  stackLine,
  turnsFromEvents,
  type Turn,
  type Upstream,
} from './handoff.js';
import { fileEditFromTool, isWriteTool, normaliseTool, relPath, reversibility, todoFromInput, toolLabel } from './translate.js';
import { describeRule, fileHolds, ruleEntry, settingsFileFor } from './rules.js';
import { DayWatch, costChanged, dayWatch } from '../daily.js';
import { HANDOFF_ASK, NEW_DAY_NUDGE, RESTART_NUDGE, RETRY_NUDGE, SLOTS_KEY, Supervisor, WAKE_NUDGE, slotLimit, strandNote, supervisor, type ProjectRemoval } from './supervisor.js';
import { createsCycle, isStuck, rewireOnRemoval, waitersOf, type AddAgentResponse, type RemoveAgentResponse, type StackNode } from '@conductor/shared';
import { heldRefusal, rerunPlan, type RerunNode, type RerunResponse } from '@conductor/shared';
import { rerunNote, rerunStatusNote } from './rerun.js';
import { READ_ONLY_BASH, READ_ONLY_BASH_DENIED, SEND_BACKS_MAX, WRITE_TOOLS, helperModel, helperReads, marksOrchestrator, pipelineHelperCap, readOnlyRefusal, roleRefusal, sendBackRefusal, showsOrchestrator, type HelperRole } from '@conductor/shared';
import { getHelperRole, getHelperRoles, startedAsRole } from './store.js';
import { pipelineHelperBrief, pipelineReportClosing, pipelineSection } from './handoff.js';

/*
 * Nothing here may ask the real model API or start a real Claude Code: §12 answers for
 * both, and until then asking is a failure that names itself.
 */
modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7802;
const BASE = `http://127.0.0.1:${PORT}`;
/** A port nothing in this repo's other suites uses, so they can run in any order. */
const DEV_PORT = 3143;

/*
 * `realpathSync` because on macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`, and the daemon canonicalises every path it stores. A
 * removal reports back the directories it walked away from, so comparing them to
 * a raw tmpdir path would fail on the symlink alone — a verification failing for
 * a reason that has nothing to do with what it verifies.
 */
const ROOT = join(realpathSync(tmpdir()), `conductor-session-verify-${Date.now()}`);
const WT_JOB = 'job_wt';
const IP_JOB = 'job_inplace';
/** Exists only so the removal section has its own fixtures to destroy. */
const SPARE_JOB = 'job_spare';
const WT_PATH = join(ROOT, '.conductor', 'wt', WT_JOB);

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

const get = <T>(path: string): Promise<{ status: number; body: T }> => send<T>('GET', path);

const count = (db: Db, sql: string, ...args: string[]): number =>
  row<{ n: number }>(db.prepare(sql).get(...args))?.n ?? 0;

const git = (args: string[], cwd = ROOT): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** One WS connection, collecting frames. Same shape as the smoke test's. */
function connect(): Promise<{ frames: ServerFrame[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', since: 0 }));
      resolve({ frames, close: () => socket.close() });
    };
    socket.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)) as ServerFrame);
    socket.onerror = () => reject(new Error('ws error'));
  });
}

const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the file-change projection to catch up with a write.
 *
 * `file_changes` is not written by the file route. It is a projection of
 * `file_edit` events, and those come from the watcher after a per-path quiet
 * period — so the bytes are on disk the moment the PUT returns and the row is
 * not. `flush` forces the pending batch out; the polling absorbs fs-event
 * delivery latency, which a fixed sleep would turn into a flaky check.
 */
async function waitForChanges(db: Db, jobId: string, timeoutMs = 6_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await workspace().flush(jobId);
    const n = count(db, 'SELECT COUNT(*) AS n FROM file_changes WHERE job_id = ?', jobId);
    if (n > 0 || Date.now() > deadline) return n;
    await settle(75);
  }
}

/**
 * One run of the fake SDK: the options the runner built, what it was told, a way to
 * hand it messages mid-run, and a handle to end it with the `result` a real query
 * would send.
 */
interface FakeRun {
  options: Options;
  prompts: string[];
  models: string[];
  /** Deliver one SDK message, as if the model or the SDK had just sent it. */
  say(m: Record<string, unknown>): void;
  finish(r: {
    cost: number;
    reason?: string;
    subtype?: string;
    isError?: boolean;
    errors?: string[];
    /** The call a `defer` ended the run on, as the SDK names it in `deferred_tool_use`. */
    deferred?: { id: string; name: string; input: Record<string, unknown> };
    /** The HTTP status a failed result names (`api_error_status`), Amendment 123. */
    apiStatus?: number | null;
  }): void;
  finished: boolean;
}
const runs: FakeRun[] = [];

/**
 * Stands in for `query()`. It announces a session (the resumed one, when asked to
 * resume), passes on whatever the check `say`s, and ends when the check calls `finish`.
 * `total_cost_usd` is whatever the check passes — the SDK's own figure, which on a
 * resumed session already includes the earlier spend.
 */
function fakeQuery({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const inbox: Record<string, unknown>[] = [];
  let result: Parameters<FakeRun['finish']>[0] = { cost: 0 };
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  const run: FakeRun = {
    options: options ?? {},
    prompts: [],
    models: [],
    finished: false,
    say(m) {
      if (run.finished) return;
      inbox.push(m);
      poke();
    },
    finish(r) {
      if (run.finished) return;
      run.finished = true;
      result = r;
      poke();
    },
  };
  runs.push(run);
  const sessionId = options?.resume ?? `sess_fake_${runs.length}`;

  void (async () => {
    if (typeof prompt === 'string') return void run.prompts.push(prompt);
    for await (const m of prompt) run.prompts.push(String(m.message.content));
  })();

  async function* messages(): AsyncGenerator<unknown> {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    for (;;) {
      while (inbox.length > 0) yield { session_id: sessionId, ...inbox.shift() };
      if (run.finished) break;
      await new Promise<void>((r) => (wake = r));
    }
    const r = result;
    yield {
      type: 'result',
      subtype: r.subtype ?? (r.isError ? 'error_during_execution' : 'success'),
      is_error: r.isError ?? false,
      total_cost_usd: r.cost,
      ...(r.reason ? { terminal_reason: r.reason } : {}),
      ...(r.errors ? { errors: r.errors } : {}),
      ...(r.deferred ? { deferred_tool_use: r.deferred } : {}),
      ...(r.apiStatus !== undefined ? { api_error_status: r.apiStatus } : {}),
      usage: { input_tokens: 10, output_tokens: 5 },
      session_id: sessionId,
    };
  }
  return Object.assign(messages(), {
    interrupt: async () => run.finish({ cost: 0, reason: 'aborted_streaming', isError: true }),
    setModel: async (model?: string) => void run.models.push(model ?? ''),
  }) as unknown as Query;
}

/** Wait until `cond` holds, polling — runs start and settle on their own async chains. */
async function until(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle(20);
  }
  return true;
}

const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;

/**
 * The `hand_off` tool, called the way an agent's run would call it: through the same
 * `callTool` the MCP endpoint and the in-process tools both serve (Amendment 104). Throws
 * the sentence the agent would have read if it was refused.
 */
function handOffAs(agentId: string, summary = 'Done: it is all in the folder.'): string {
  const r = callTool(agentId, 'hand_off', { summary });
  const said = r.content.map((c) => c.text).join('\n');
  if ('isError' in r && r.isError) throw new Error(`hand_off refused: ${said}`);
  return said;
}

/**
 * One session of the fake Copilot client (Amendment 76): what the backend configured it
 * with, what it was sent, and a way to deliver session events as the runtime would.
 * The permission and question callbacks are on `config`, called as the runtime calls them.
 */
interface FakeCopilotSession {
  id: string;
  resumed: boolean;
  config: SessionConfig;
  prompts: { prompt: string; mode?: string }[];
  models: string[];
  aborts: number;
  disconnected: boolean;
  emit(type: string, data: Record<string, unknown>, extra?: Record<string, unknown>): void;
  ask(req: Record<string, unknown>): Promise<PermissionRequestResult>;
}
const copilotSessions: FakeCopilotSession[] = [];
const fakeCopilot = {
  auth: { isAuthenticated: false, statusMessage: 'no login in verify' } as { isAuthenticated: boolean; login?: string; statusMessage?: string },
  authFails: false,
  authAsks: 0,
  clients: 0,
  starts: 0,
  stops: 0,
  resumes: [] as string[],
  models: [{ id: 'gpt-5-mini', name: 'GPT-5 mini', supportedReasoningEfforts: ['low', 'high'] }],
};
let eventSeq = 0;

/** Stands in for `new CopilotClient()`. No runtime, no network. */
function fakeCopilotClient(): CopilotClientLike {
  fakeCopilot.clients += 1;
  const open = (id: string, config: SessionConfig, resumed: boolean): FakeCopilotSession => {
    const handlers = new Set<(e: SessionEvent) => void>();
    const s: FakeCopilotSession = {
      id,
      resumed,
      config,
      prompts: [],
      models: [],
      aborts: 0,
      disconnected: false,
      emit(type, data, extra = {}) {
        const e = { id: `ev${(eventSeq += 1)}`, parentId: null, timestamp: nowIso(), type, data, ...extra } as unknown as SessionEvent;
        for (const h of [...handlers]) h(e);
      },
      ask: (req) => Promise.resolve(config.onPermissionRequest!(req as unknown as PermissionRequest, { sessionId: id }) as Promise<PermissionRequestResult>),
    };
    const session = {
      sessionId: id,
      on: (h: (e: SessionEvent) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      send: async (o: { prompt: string; mode?: string }) => {
        s.prompts.push(o);
        return `msg${s.prompts.length}`;
      },
      abort: async () => {
        s.aborts += 1;
        s.emit('abort', { reason: 'user_initiated' });
        s.emit('session.idle', { aborted: true });
      },
      disconnect: async () => {
        s.disconnected = true;
      },
      setModel: async (m: string) => void s.models.push(m),
    };
    copilotSessions.push(s);
    return session as never;
  };
  return {
    start: async () => void (fakeCopilot.starts += 1),
    stop: async () => {
      fakeCopilot.stops += 1;
      return [];
    },
    getAuthStatus: async () => {
      fakeCopilot.authAsks += 1;
      if (fakeCopilot.authFails) throw new Error('runtime not found');
      return fakeCopilot.auth as never;
    },
    listModels: async () => fakeCopilot.models as never,
    createSession: async (config: SessionConfig) => open(config.sessionId ?? 'no-id', config, false),
    resumeSession: async (id: string, config: SessionConfig) => {
      fakeCopilot.resumes.push(id);
      return open(id, config, true);
    },
  } as unknown as CopilotClientLike;
}

function makeRepo(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# verify\n\nhand-written, must survive.\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'verify@conductor.test']);
  git(['config', 'user.name', 'verify']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(tmpdir(), `conductor-session-verify-${Date.now()}.db`);
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  makeRepo();

  const realQuery = sdk.query;
  sdk.query = fakeQuery as typeof sdk.query;
  // Nor a real Copilot runtime, nor OpenRouter (Amendment 76), nor a key from your shell.
  copilotSdk.createClient = fakeCopilotClient;
  copilotSdk.credentialPresent = () => true;
  copilotSdk.fetchOpenRouterModels = () => Promise.reject(new Error('verify asked OpenRouter'));
  delete process.env['OPENROUTER_API_KEY'];

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();

  // Something for the registry to find. Kept running to the end of the script on
  // purpose: the removal must not go anywhere near it.
  const devServer: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dev</body></html>');
  });
  await new Promise<void>((r) => devServer.listen(DEV_PORT, '127.0.0.1', r));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · add a project');
  const added = await send<{ project: { id: string; name: string; path: string } }>(
    'POST',
    '/api/projects',
    { path: ROOT, name: 'verify-repo' },
  );
  check('POST /api/projects → 201', added.status === 201, `got ${added.status}`);
  const projectId = added.body.project.id;

  const listed = await get<{ projects: { id: string }[] }>('/api/projects');
  check('it is listed', listed.body.projects.some((p) => p.id === projectId));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · give it a history worth losing');

  // Inserted rather than created through /api/jobs: `createJob` starts agents,
  // and a verification suite that spends money is one nobody runs.
  insertJob(db, {
    id: WT_JOB,
    projectId,
    prompt: 'rotate the refresh tokens',
    isolation: 'worktree',
    worktreePath: WT_PATH,
    branch: `conductor/${WT_JOB}`,
    status: 'paused',
    budgetUsd: null,
  });
  insertJob(db, {
    id: IP_JOB,
    projectId,
    prompt: 'a job with no workspace row',
    isolation: 'in_place',
    worktreePath: ROOT,
    branch: 'main',
    status: 'done',
    budgetUsd: null,
  });

  for (const [id, jobId, role] of [
    ['agt_builder', WT_JOB, 'builder'],
    ['agt_reviewer', WT_JOB, 'reviewer'],
    ['agt_scribe', IP_JOB, 'scribe'],
  ]) {
    insertAgent(db, {
      id: id!,
      jobId: jobId!,
      projectId,
      role: role!,
      model: 'claude-sonnet-5',
      sdkSessionId: null,
      status: 'paused',
      blockMode: null,
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 50,
      dependsOn: [],
      autonomy: DEFAULT_AUTONOMY,
    });
  }

  /*
   * A third job, purely so the removal section below has something of its own to delete.
   * It used to remove `agt_builder` and `job_inplace`, which the project-removal sections
   * still need — a verify that destroys its own later fixtures fails for a reason that has
   * nothing to do with the code.
   */
  insertJob(db, {
    id: SPARE_JOB,
    projectId,
    prompt: 'a job that exists to be removed',
    isolation: 'in_place',
    worktreePath: ROOT,
    branch: 'main',
    status: 'done',
    budgetUsd: null,
  });
  for (const id of ['agt_spare_a', 'agt_spare_b']) {
    insertAgent(db, {
      id,
      jobId: SPARE_JOB,
      projectId,
      role: id.endsWith('a') ? 'analyst' : 'auditor',
      model: 'sonnet',
      sdkSessionId: null,
      status: 'done',
      blockMode: null,
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      dependsOn: [],
      autonomy: DEFAULT_AUTONOMY,
    });
  }
  startRun(db, 'agt_spare_a', 'sess_spare');

  insertRequest(db, {
    id: 'req_verify',
    agentId: 'agt_builder',
    jobId: WT_JOB,
    projectId,
    kind: 'permission',
    blockMode: 'parked',
    toolName: 'Bash',
    toolUseId: 'tu_1',
    input: { command: 'rm -rf build' },
    label: 'rm -rf build',
    createdAt: nowIso(),
  });
  insertRule(db, { projectId, toolName: 'Bash', ruleContent: 'Bash(git status:*)' });
  startRun(db, 'agt_builder', 'sess_1');
  addCostToday(db, 1.5);
  const spentToday = costToday(db);

  const opened = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: WT_JOB,
    projectId,
    repoPath: ROOT,
    isolation: 'worktree',
  });
  check('a real worktree is cut', opened.status === 201, `got ${opened.status}`);
  check('the directory exists', existsSync(WT_PATH));
  check('git registers it', git(['worktree', 'list']).includes(WT_JOB));
  check('the branch exists', git(['branch', '--list', `conductor/${WT_JOB}`]).length > 0);

  const wrote = await send<FileContentResponse>('PUT', `/api/jobs/${WT_JOB}/file`, {
    path: 'src/rotate.js',
    content: 'export const rotate = () => null;\n',
  });
  check('an agent-ish write lands in it', wrote.status === 200, `got ${wrote.status}`);
  const changed = await waitForChanges(db, WT_JOB);
  check('file_changes recorded it', changed > 0, `${changed} rows`);

  const registered = await preview().registry.register({
    jobId: WT_JOB,
    projectId,
    port: DEV_PORT,
    kind: 'vite',
    command: 'pnpm dev',
  });
  check('a dev server is registered', registered !== null);
  preview().console.record(
    { jobId: WT_JOB, projectId, agentId: 'agt_builder' },
    [{ level: 'error', text: 'TypeError: undefined is not a function', at: nowIso() }],
  );
  check('console captured', count(db, 'SELECT COUNT(*) AS n FROM console_entries WHERE job_id = ?', WT_JOB) === 1);

  const seqBefore = eventLog().forJob(WT_JOB).length;
  check('the job has events', seqBefore > 0, `${seqBefore} events`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · terminating an agent');

  /*
   * `stopped` exists because none of the other six statuses tells the truth about a
   * killed agent: `done` claims it finished, `failed` claims it errored, `paused` claims
   * you might come back. The assertions here are mostly about that distinction holding
   * all the way through — including that the job it belonged to does NOT go red.
   */
  const terminated = await send<{ agent: { id: string; status: string } }>(
    'POST',
    `/api/agents/agt_reviewer/terminate`,
  );
  check('POST /terminate → 200', terminated.status === 200, `got ${terminated.status}`);
  check(
    'the agent reports itself stopped — not done, not failed',
    terminated.body.agent?.status === 'stopped',
    terminated.body.agent?.status,
  );
  check(
    'and that is what is stored',
    row<{ status: string }>(db.prepare('SELECT status FROM agents WHERE id = ?').get('agt_reviewer'))
      ?.status === 'stopped',
  );
  check(
    'and it has an end time, as a done or failed one does (Amendment 85)',
    row<{ ended_at: string | null }>(db.prepare('SELECT ended_at FROM agents WHERE id = ?').get('agt_reviewer'))
      ?.ended_at != null,
  );
  check(
    'its status change is in the event log',
    eventLog()
      .forJob(WT_JOB)
      .some((e) => e.payload.kind === 'status' && e.payload.status === 'stopped'),
  );
  check(
    'it is no longer live, so a project removal would not refuse for it',
    !sup.isLive('agt_reviewer'),
  );
  check(
    'terminating is idempotent rather than an error',
    (await send('POST', `/api/agents/agt_reviewer/terminate`)).status === 200,
  );
  check(
    'an unknown agent is a 404, not a 500',
    (await send('POST', '/api/agents/agt_nope/terminate')).status === 404,
  );

  // The parked request belonged to agt_builder; terminating it must clear the queue.
  const queueBefore = (await get<{ pending: unknown[] }>('/api/requests')).body.pending.length;
  check('the queue has something in it to begin with', queueBefore > 0, `${queueBefore}`);
  await send('POST', `/api/agents/agt_builder/terminate`);
  const queueAfter = (await get<{ pending: unknown[] }>('/api/requests')).body.pending.length;
  check(
    'a terminated agent stops asking you for things',
    queueAfter === 0,
    `${queueBefore} → ${queueAfter}`,
  );

  const wtJob = row<{ status: string }>(
    db.prepare('SELECT status FROM jobs WHERE id = ?').get(WT_JOB),
  );
  check(
    'the job settles, and NOT as failed — a deliberate stop is not an error',
    wtJob?.status !== 'failed',
    wtJob?.status,
  );

  check('nothing on disk was touched', existsSync(join(WT_PATH, 'src', 'rotate.js')));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · removing an agent, which terminate deliberately does not do');

  /*
   * Terminate ends the work and leaves the lane on screen reading `stopped`. That is
   * right while you still care what it did, and it is what made "I terminated it and it
   * still hangs on" the obvious conclusion — so removal is a separate verb. These checks
   * are about the boundary between the two: the row goes, the log does not.
   */
  const spareRuns = count(
    db,
    'SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ?',
    'agt_spare_a',
  );
  const logBeforeAgentRemoval = eventLog().forJob(WT_JOB).length;

  const removedAgent = await send<{ removed: string }>('DELETE', '/api/agents/agt_spare_a');
  check('DELETE /api/agents/:id → 200', removedAgent.status === 200, `got ${removedAgent.status}`);
  check(
    'the row is gone',
    count(db, 'SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'agt_spare_a') === 0,
  );
  check(
    'its run history cascaded',
    spareRuns > 0 &&
      count(db, 'SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ?', 'agt_spare_a') === 0,
    `${spareRuns} runs before`,
  );
  check(
    'and it is out of the snapshot, so it leaves the screen',
    !(await get<Snapshot>('/api/snapshot')).body.agents.some((a) => a.id === 'agt_spare_a'),
  );
  check(
    'the event log keeps its transcript — an orphan is truer than a hole',
    eventLog().forJob(WT_JOB).length === logBeforeAgentRemoval,
    `${eventLog().forJob(WT_JOB).length} vs ${logBeforeAgentRemoval}`,
  );
  check(
    'a second DELETE is a 404, not a 500',
    (await send('DELETE', '/api/agents/agt_spare_a')).status === 404,
  );
  check('and still nothing on disk', existsSync(join(WT_PATH, 'src', 'rotate.js')));

  // Removing a job takes its agents with it, by cascade rather than by loop.
  const spareAgents = count(db, 'SELECT COUNT(*) AS n FROM agents WHERE job_id = ?', SPARE_JOB);
  const removedJob = await send<{ removed: string }>('DELETE', `/api/jobs/${SPARE_JOB}`);
  check('DELETE /api/jobs/:id → 200', removedJob.status === 200, `got ${removedJob.status}`);
  check(
    'the job row is gone',
    count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE id = ?', SPARE_JOB) === 0,
  );
  check(
    'its agents cascaded with it',
    spareAgents > 0 &&
      count(db, 'SELECT COUNT(*) AS n FROM agents WHERE job_id = ?', SPARE_JOB) === 0,
    `${spareAgents} agents before`,
  );
  check(
    'the project itself is untouched',
    count(db, 'SELECT COUNT(*) AS n FROM projects WHERE id = ?', projectId) === 1,
  );

  /*
   * Removing a job's LAST agent leaves the job row behind, which is correct — a job is not
   * its agents — but it must not sit there claiming it might still run. An agentless job
   * reading `queued` is a row promising work that nothing can perform.
   */
  const soloJob = 'job_solo';
  insertJob(db, {
    id: soloJob,
    projectId,
    prompt: 'one agent, about to have none',
    isolation: 'in_place',
    worktreePath: ROOT,
    branch: 'main',
    status: 'queued',
    budgetUsd: null,
  });
  insertAgent(db, {
    id: 'agt_solo',
    jobId: soloJob,
    projectId,
    role: 'builder',
    model: 'sonnet',
    sdkSessionId: null,
    status: 'done',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: DEFAULT_AUTONOMY,
  });
  await send('DELETE', '/api/agents/agt_solo');
  check(
    'the job survives its last agent — a job is not its agents',
    count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE id = ?', soloJob) === 1,
  );
  check(
    'but stops claiming it is queued, which nothing could act on',
    row<{ status: string }>(db.prepare('SELECT status FROM jobs WHERE id = ?').get(soloJob))
      ?.status === 'done',
    row<{ status: string }>(db.prepare('SELECT status FROM jobs WHERE id = ?').get(soloJob))
      ?.status,
  );
  check(
    'and it is still removable, so it cannot become unreachable',
    (await send('DELETE', `/api/jobs/${soloJob}`)).status === 200,
  );

  /*
   * THE CHECK THAT WAS MISSING, and whose absence let a removed job come back.
   *
   * `workspaces` has no foreign key to `jobs`, and Track C's snapshot contributor
   * republishes any workspace no `jobs` row describes as a synthetic job — plus a
   * synthetic project named after the repo directory. So removing a job without telling
   * Track C resurrected it in every browser as a job nobody launched inside a project that
   * did not exist, and nothing could remove either, because there was no row left to
   * DELETE. Reported as "removing the project failed — no such project".
   */
  check(
    'precondition: a live job still has its workspace row',
    count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', WT_JOB) > 0,
    `job_wt has ${count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', WT_JOB)}`,
  );
  const ghostJob = 'job_ghost';
  insertJob(db, {
    id: ghostJob,
    projectId,
    prompt: 'about to be removed with a workspace attached',
    isolation: 'worktree',
    worktreePath: join(ROOT, '.conductor', 'wt', ghostJob),
    branch: `conductor/${ghostJob}`,
    status: 'done',
    budgetUsd: null,
  });
  await send('POST', '/api/workspaces', {
    jobId: ghostJob,
    projectId,
    repoPath: ROOT,
    isolation: 'worktree',
  });
  check(
    'a job with a workspace has one to lose',
    count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', ghostJob) === 1,
  );
  await send('DELETE', `/api/jobs/${ghostJob}`);
  check(
    'removing the job takes its workspace row with it',
    count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', ghostJob) === 0,
  );
  const afterGhost = await get<Snapshot>('/api/snapshot');
  check(
    'so it cannot come back as a synthetic job',
    !afterGhost.body.jobs.some((j) => j.id === ghostJob),
    afterGhost.body.jobs.map((j) => j.id).join(','),
  );
  check(
    'and the worktree it cut is still on disk — removal forgets, it does not delete',
    existsSync(join(ROOT, '.conductor', 'wt', ghostJob)),
  );

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · what survives a restart, and what has to be corrected');

  /*
   * Everything is in SQLite, so a restart remembers projects, jobs, agents, transcripts,
   * open requests, rules and spend. It cannot remember PROCESSES — and a row left saying
   * `working` after a hard kill claims one that does not exist. Nothing resumed it (`pump`
   * only takes `queued`) and nothing noticed (`isLive` is false), so it sat in the single
   * status the product reads as "leave it alone", forever.
   */
  insertJob(db, {
    id: 'job_crash',
    projectId,
    prompt: 'killed mid-run',
    isolation: 'in_place',
    worktreePath: ROOT,
    branch: 'main',
    status: 'working',
    budgetUsd: null,
  });
  for (const [id, status] of [
    ['agt_midrun', 'working'],
    ['agt_queued', 'queued'],
    ['agt_finished', 'done'],
  ] as const) {
    insertAgent(db, {
      id,
      jobId: 'job_crash',
      projectId,
      role: id,
      model: 'sonnet',
      sdkSessionId: 'sess_before_crash',
      status,
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy: DEFAULT_AUTONOMY,
    });
  }

  const fixed = sup.reconcile();
  const statusOf = (id: string) =>
    row<{ status: string }>(db.prepare('SELECT status FROM agents WHERE id = ?').get(id))?.status;

  check('reconcile reports what it corrected', fixed === 1, `${fixed}`);
  check(
    'an agent left working by a stop is queued to resume on its own, not silently stuck (Amendment 53)',
    statusOf('agt_midrun') === 'queued',
    statusOf('agt_midrun'),
  );
  check(
    'and it is resumable, because its sdk session id survived',
    row<{ sdk_session_id: string | null }>(
      db.prepare('SELECT sdk_session_id FROM agents WHERE id = ?').get('agt_midrun'),
    )?.sdk_session_id === 'sess_before_crash',
  );
  check(
    'the transcript records why, rather than just changing colour',
    eventLog()
      .forJob('job_crash')
      .some(
        (e) =>
          e.payload.kind === 'status' &&
          e.payload.status === 'queued' &&
          (e.payload.error ?? '').includes('restarted'),
      ),
  );
  check('a queued agent is left for pump', statusOf('agt_queued') === 'queued');
  check('a finished agent is not disturbed', statusOf('agt_finished') === 'done');
  check('running it again changes nothing', sup.reconcile() === 0);

  await send('DELETE', '/api/jobs/job_crash');
  /*
   * Terminating agt_midrun frees a slot and pumps, and agt_queued — same job, next in
   * line — was launched into it, only to be interrupted a moment later. Against the
   * real SDK that was a `claude` process started by removing a job.
   */
  check(
    'removing a job does not launch the agents it is about to stop',
    runs.length === 0,
    `${runs.length} launched: ${runs.map((r) => r.options.resume ?? 'fresh').join(', ')}`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · it refuses while an agent is alive');

  // Standing in for a live SDK process. The alternative is launching one, which
  // costs money and makes the suite non-deterministic; what is being verified is
  // the refusal, and `isLive` is exactly the question deleteProject asks.
  const reallyIsLive = sup.isLive.bind(sup);
  sup.isLive = (agentId: string) => agentId === 'agt_builder';

  const refused = await send<{ error: string; detail?: string }>(
    'DELETE',
    `/api/projects/${projectId}`,
  );
  check('DELETE → 409', refused.status === 409, `got ${refused.status}`);
  check('it names the agent in the way', (refused.body.detail ?? '').includes('builder'), refused.body.detail);
  check(
    'and nothing was removed',
    count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?', projectId) === 2,
  );
  check('the worktree is untouched', existsSync(WT_PATH));

  sup.isLive = reallyIsLive;

  /*
   * A workspace closed before its project goes. `close()` soft-deletes — it stamps
   * `removed_at` and keeps the row and its file_changes — and a sweep over live rows
   * only walked straight past it. Seen in a real database: one workspace row and six
   * file_changes for a project that no longer existed.
   */
  const closedJob = 'job_closed_earlier';
  const plantWorkspace = (jobId: string, project: string, removedAt: string | null) => {
    db.prepare(
      `INSERT INTO workspaces (job_id, project_id, repo_path, path, branch, isolation, base_ref, created_at, removed_at)
       VALUES (?, ?, ?, ?, 'main', 'in_place', NULL, ?, ?)`,
    ).run(jobId, project, ROOT, ROOT, new Date().toISOString(), removedAt);
    db.prepare(`INSERT INTO file_changes (job_id, path, at) VALUES (?, 'a.txt', ?)`).run(
      jobId,
      new Date().toISOString(),
    );
  };
  plantWorkspace(closedJob, projectId, new Date().toISOString());

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · remove it');
  /*
   * Captured HERE, not in section 2. The terminate section above legitimately appends to
   * the log, and the claim being tested is narrower than "the log never changes": a
   * PROJECT REMOVAL appends and deletes nothing. Measuring from the wrong moment made
   * this check fail for the one reason that is not a bug.
   */
  const logBeforeRemoval = eventLog().forJob(WT_JOB).length;
  const ws = await connect();
  const removed = await send<{ removed: ProjectRemoval }>('DELETE', `/api/projects/${projectId}`);
  check('DELETE → 200', removed.status === 200, `got ${removed.status}`);
  check('it reports what it forgot', removed.body.removed?.jobs === 2 && removed.body.removed.agents === 3, JSON.stringify(removed.body.removed));
  check(
    'and which directories it walked away from',
    removed.body.removed?.keptOnDisk.includes(WT_PATH) === true,
    JSON.stringify(removed.body.removed?.keptOnDisk),
  );

  const again = await send<{ error: string }>('DELETE', `/api/projects/${projectId}`);
  check('a second DELETE → 404', again.status === 404, `got ${again.status}`);

  await settle();
  check(
    'every browser is told to resync',
    ws.frames.some((f) => f.type === 'resync'),
    ws.frames.map((f) => f.type).join(','),
  );
  ws.close();

  console.log('\n8 · the bookkeeping is gone');
  const gone = await get<{ projects: { id: string }[] }>('/api/projects');
  check('not listed', !gone.body.projects.some((p) => p.id === projectId));
  check('projects row', count(db, 'SELECT COUNT(*) AS n FROM projects WHERE id = ?', projectId) === 0);
  check('jobs cascaded', count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?', projectId) === 0);
  check('agents cascaded', count(db, 'SELECT COUNT(*) AS n FROM agents WHERE project_id = ?', projectId) === 0);
  check('requests cascaded', count(db, 'SELECT COUNT(*) AS n FROM requests WHERE project_id = ?', projectId) === 0);
  check('session rules cascaded', count(db, 'SELECT COUNT(*) AS n FROM session_rules WHERE project_id = ?', projectId) === 0);
  check(
    'run history cascaded',
    count(db, 'SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ?', 'agt_builder') === 0,
  );
  check('workspace row', count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', WT_JOB) === 0);
  check('file_changes', count(db, 'SELECT COUNT(*) AS n FROM file_changes WHERE job_id = ?', WT_JOB) === 0);
  check('dev_servers', count(db, 'SELECT COUNT(*) AS n FROM dev_servers WHERE job_id = ?', WT_JOB) === 0);
  check('console_entries', count(db, 'SELECT COUNT(*) AS n FROM console_entries WHERE job_id = ?', WT_JOB) === 0);
  check('the watcher is detached', !workspace().list().some((w) => w.jobId === WT_JOB));
  check(
    'a workspace closed before the removal goes too',
    count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', closedJob) === 0 &&
      count(db, 'SELECT COUNT(*) AS n FROM file_changes WHERE job_id = ?', closedJob) === 0,
  );

  /*
   * And the ones already stranded by earlier removals, which no project is left to
   * lead to. Swept at startup — but only the REMOVED ones. A live workspace with no
   * job is a bootstrap workspace the snapshot publishes deliberately.
   */
  plantWorkspace('job_stranded', 'prj_long_gone', new Date().toISOString());
  plantWorkspace('job_bootstrap', 'prj_bootstrap', null);
  const swept = workspace().store.sweepOrphans();
  check('the startup sweep drops a stranded removed workspace', swept === 1, `swept ${swept}`);
  check(
    'with its file_changes',
    count(db, 'SELECT COUNT(*) AS n FROM file_changes WHERE job_id = ?', 'job_stranded') === 0,
  );
  check(
    'and leaves a live job-less workspace alone',
    count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE job_id = ?', 'job_bootstrap') === 1,
  );
  workspace().store.forget('job_bootstrap');

  const snapshot = await get<Snapshot>('/api/snapshot');
  check('out of the snapshot', !snapshot.body.projects.some((p) => p.id === projectId));
  check('its jobs too', !snapshot.body.jobs.some((j) => j.projectId === projectId));
  check(
    'and its dev server',
    !snapshot.body.servers.some((s) => s.jobId === WT_JOB),
    JSON.stringify(snapshot.body.servers),
  );

  console.log('\n9 · what a removal must never touch');
  check(
    'the event log is intact',
    eventLog().forJob(WT_JOB).length === logBeforeRemoval,
    `${eventLog().forJob(WT_JOB).length} vs ${logBeforeRemoval}`,
  );
  check("today's spend is unchanged", costToday(db) === spentToday, `${costToday(db)} vs ${spentToday}`);
  check('the project directory is still there', existsSync(ROOT));
  check(
    'the human-written file is byte-for-byte',
    readFileSync(join(ROOT, 'README.md'), 'utf8') === '# verify\n\nhand-written, must survive.\n',
  );
  check('the worktree directory is still there', existsSync(WT_PATH));
  check('with the agent-written file in it', existsSync(join(WT_PATH, 'src', 'rotate.js')));
  check('git still registers the worktree', git(['worktree', 'list']).includes(WT_JOB));
  check('the branch still exists', git(['branch', '--list', `conductor/${WT_JOB}`]).length > 0);

  const stillServing = await fetch(`http://127.0.0.1:${DEV_PORT}/`).then(
    (r) => r.ok,
    () => false,
  );
  check('the dev server was never signalled', stillServing);

  console.log('\n10 · adding the folder again starts clean');
  const readded = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT });
  check('POST → 201 with a new id', readded.status === 201 && readded.body.project.id !== projectId, `${readded.status} ${readded.body.project?.id}`);
  const afterJobs = await get<{ jobs: { projectId: string }[] }>('/api/jobs');
  check(
    'and no history follows it back',
    !afterJobs.body.jobs.some((j) => j.projectId === readded.body.project.id),
  );

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · a budget is a figure per day (it was a lifetime one), and it stops an agent at twice the budget (Amendments 124, 129)');
  /*
   * The cap used to go to the SDK as `maxBudgetUsd` unchanged, and the SDK counts that
   * from the start of each query() — so every message bought a fresh $25, and the cap
   * never stopped anything. These run a real supervisor and runner; only the SDK is fake.
   *
   * Amendment 124 moved the stop: the budget only warns (the section at the end), and what
   * the SDK is given and the agent is refused at is twice it. A $25 budget stops at $50, so
   * the numbers below are the old ones against that ceiling.
   */
  // A launch an earlier section caused has already failed its own check; counting from
  // here keeps it from failing every `runs[i]` below as well.
  for (const r of runs) r.finish({ cost: 0 });
  runs.length = 0;
  const pid = readded.body.project.id;
  const capped: Agent['autonomy'] = { ...DEFAULT_AUTONOMY, budgetUsd: 25 };
  const fixture = (id: string, jobId: string, a: Partial<Agent>): void => {
    insertAgent(db, {
      id,
      jobId,
      projectId: pid,
      role: 'builder',
      model: 'opus',
      sdkSessionId: null,
      status: 'done',
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy: capped,
      ...a,
    });
    /*
     * Amendment 129. A budget counts what was spent TODAY, which the agent row can't say
     * (`costUsd` is its lifetime). A fixture that is created with spend on it is an agent
     * whose whole life happened today, so the same figures are put in `agent_spend_daily`:
     * the dollars as they are, and the tokens as input plus output. Without this a fixture
     * with `costUsd: 51` and a $25 budget would read as having spent nothing.
     */
    if (a.costUsd || a.inputTokens || a.outputTokens) {
      addSpendToday(db, id, { usd: a.costUsd ?? 0, tokens: (a.inputTokens ?? 0) + (a.outputTokens ?? 0) });
    }
  };
  const job = (id: string, budgetUsd: number | null): void => {
    insertJob(db, {
      id,
      projectId: pid,
      prompt: `the ${id} prompt`,
      isolation: 'in_place',
      worktreePath: ROOT,
      branch: 'main',
      status: 'done',
      budgetUsd,
    });
  };
  const lastStatus = (agentId: string) =>
    eventLog()
      .forAgent(agentId)
      .map((e) => e.payload)
      .filter((p) => p.kind === 'status')
      .at(-1);

  job('job_budget', 25);
  fixture('agt_capped', 'job_budget', { sdkSessionId: 'sess_capped', costUsd: 20 });

  const said = await send<{ delivery: string }>('POST', '/api/agents/agt_capped/message', {
    text: 'one more thing',
  });
  check('a message to a finished agent resumes it', said.status === 200 && said.body.delivery === 'resumed', `${said.status} ${JSON.stringify(said.body)}`);
  await until(() => runs.length === 1);
  const first = runs[0];
  check('its own session', first?.options.resume === 'sess_capped', String(first?.options.resume));
  check(
    'with what is LEFT of the ceiling (twice the $25 budget), not the whole thing again',
    near(first?.options.maxBudgetUsd, 30),
    `maxBudgetUsd ${first?.options.maxBudgetUsd}`,
  );

  const todayBefore = costToday(db);
  // A resumed session's total carries on from the $20 its transcript saved.
  first?.finish({ cost: 24, reason: 'completed' });
  await until(() => getAgent(db, 'agt_capped')?.status === 'done');
  check('the agent has spent $24 in its lifetime', near(getAgent(db, 'agt_capped')?.costUsd, 24), String(getAgent(db, 'agt_capped')?.costUsd));
  check(
    "today's spend grows by the $4 this run cost, not by the session's whole $24",
    near(costToday(db) - todayBefore, 4),
    `grew by ${costToday(db) - todayBefore}`,
  );

  await send('POST', '/api/agents/agt_capped/message', { text: 'and another' });
  await until(() => runs.length === 2);
  check('the next run gets the $26 left under the ceiling', near(runs[1]?.options.maxBudgetUsd, 26), `maxBudgetUsd ${runs[1]?.options.maxBudgetUsd}`);
  // The subtype alone, no `terminal_reason` — which the SDK types as optional.
  runs[1]?.finish({ cost: 50.2, subtype: 'error_max_budget_usd', isError: true });
  await until(() => getAgent(db, 'agt_capped')?.status !== 'working');
  check(
    'running out is paused, not failed',
    getAgent(db, 'agt_capped')?.status === 'paused',
    getAgent(db, 'agt_capped')?.status,
  );
  const stoppedFor = lastStatus('agt_capped');
  check(
    'and says what it spent against what budget, and where that stops it',
    stoppedFor?.kind === 'status' && stoppedFor.error === 'budget reached for today — spent $50.20 of its $25 daily budget, which stops it at $50',
    JSON.stringify(stoppedFor),
  );
  check("and does not fail its job", getJob(db, 'job_budget')?.status !== 'failed', getJob(db, 'job_budget')?.status);

  const sentence = 'The Builder has spent $50.20 of its $25 daily budget today, which stops it at $50 — raise it to continue, or it renews at midnight.';
  const atCap = await send<{ error: string; detail?: string }>('POST', '/api/agents/agt_capped/message', {
    text: 'please carry on',
  });
  check('at the ceiling, a message is refused with 409', atCap.status === 409, `got ${atCap.status}`);
  check('and a sentence saying why', atCap.body.detail === sentence, JSON.stringify(atCap.body));
  const resumeRefused = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/resume');
  check('so is resume', resumeRefused.status === 409 && resumeRefused.body.detail === sentence, `${resumeRefused.status} ${JSON.stringify(resumeRefused.body)}`);
  await settle(100);
  check('and nothing ran', runs.length === 2, `${runs.length} runs`);
  check('and it is still paused', getAgent(db, 'agt_capped')?.status === 'paused');

  const watching = await connect();
  const raised = await send<{ autonomy: Agent['autonomy'] }>('POST', '/api/agents/agt_capped/autonomy', {
    autonomy: { budgetUsd: 60 },
  });
  check('the budget can be raised', raised.status === 200 && raised.body.autonomy.budgetUsd === 60, JSON.stringify(raised.body));
  check('without touching the rest of its autonomy', raised.body.autonomy.mode === capped.mode);
  await settle();
  check(
    'and every tab is told',
    watching.frames.some(
      (f) => f.type === 'entities' && f.agents?.some((a) => a.id === 'agt_capped' && a.autonomy.budgetUsd === 60),
    ),
    watching.frames.map((f) => f.type).join(','),
  );

  const resumed = await send('POST', '/api/agents/agt_capped/resume');
  check('then resume is accepted', resumed.status === 200, `got ${resumed.status}`);
  await until(() => runs.length === 3);
  check(
    'and continues the SAME session, not a fresh one from the job prompt',
    runs[2]?.options.resume === 'sess_capped',
    String(runs[2]?.options.resume),
  );
  await until(() => (runs[2]?.prompts.length ?? 0) > 0);
  check('told to carry on', runs[2]?.prompts[0] === WAKE_NUDGE, JSON.stringify(runs[2]?.prompts));
  check('with the $69.80 the raise left under the new ceiling ($120)', near(runs[2]?.options.maxBudgetUsd, 120 - 50.2), `maxBudgetUsd ${runs[2]?.options.maxBudgetUsd}`);
  // A resumed session's total never reads below what was stored, so this carries on from $50.20.
  runs[2]?.finish({ cost: 51, reason: 'completed' });
  await until(() => getAgent(db, 'agt_capped')?.status === 'done');

  /*
   * An agent answered while every slot was taken is queued with its session. pump()
   * used to launch every queued agent fresh, which threw that conversation away.
   */
  job('job_answered', null);
  fixture('agt_answered', 'job_answered', {
    status: 'queued',
    sdkSessionId: 'sess_answered',
    costUsd: 3,
    autonomy: DEFAULT_AUTONOMY,
  });
  sup.pump();
  await until(() => runs.length === 4);
  check('a queued agent with a session resumes it', runs[3]?.options.resume === 'sess_answered', String(runs[3]?.options.resume));
  check('an uncapped agent gets no maxBudgetUsd', runs[3]?.options.maxBudgetUsd === undefined);
  const beforeAnswered = costToday(db);
  // A session whose transcript saved no total starts counting again from zero.
  runs[3]?.finish({ cost: 0.5, reason: 'completed' });
  await until(() => getAgent(db, 'agt_answered')?.status === 'done');
  check(
    'a total that restarted from zero is added to what was spent, not taken as all of it',
    near(getAgent(db, 'agt_answered')?.costUsd, 3.5),
    String(getAgent(db, 'agt_answered')?.costUsd),
  );
  check("and today grows by that run's $0.50", near(costToday(db) - beforeAnswered, 0.5), `grew by ${costToday(db) - beforeAnswered}`);

  /*
   * The job's cap is its agents' CURRENT caps. Spawn launched this pair at $25 + $25;
   * the first was raised to $60 and spent $52. Against `job.budgetUsd` the second never
   * starts — "job budget reached", though nobody's cap is.
   */
  job('job_pair', 50);
  fixture('agt_first', 'job_pair', { sdkSessionId: 'sess_first', costUsd: 52, autonomy: { ...capped, budgetUsd: 60 } });
  fixture('agt_second', 'job_pair', { role: 'reviewer', status: 'queued', dependsOn: ['agt_first'] });
  sup.pump();
  await until(() => runs.length === 5);
  check(
    'raising one cap lets its queued sibling start',
    getAgent(db, 'agt_second')?.status === 'working',
    `${getAgent(db, 'agt_second')?.status} — ${JSON.stringify(lastStatus('agt_second'))}`,
  );
  check('fresh, from the job prompt, under its ceiling', runs[4]?.options.resume === undefined && near(runs[4]?.options.maxBudgetUsd, 50));
  runs[4]?.finish({ cost: 1, reason: 'completed' });
  await until(() => getAgent(db, 'agt_second')?.status === 'done');

  // At its own ceiling in a job that is not: refused at launch, before a run the SDK would
  // end on its first turn. Its siblings' headroom keeps the job-cap pause out of the way.
  fixture('agt_spent', 'job_pair', { role: 'validator', status: 'queued', sdkSessionId: 'sess_spent', costUsd: 50 });
  sup.pump();
  await until(() => getAgent(db, 'agt_spent')?.status !== 'queued');
  await settle(100);
  check('an agent at its ceiling is not launched', runs.length === 5, `${runs.length} runs`);
  const spentNote = lastStatus('agt_spent');
  check(
    'it is paused, saying so',
    getAgent(db, 'agt_spent')?.status === 'paused' &&
      spentNote?.kind === 'status' &&
      spentNote.error === 'budget reached for today — spent $50 of its $25 daily budget, which stops it at $50',
    `${getAgent(db, 'agt_spent')?.status} ${JSON.stringify(spentNote)}`,
  );
  watching.close();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n12 · switching the model — exact ids from the served list (Amendment 40)');
  const OPUS = 'us.anthropic.claude-opus-5-5';
  const SONNET = 'us.anthropic.claude-sonnet-5';
  /* Claude Code's rows as 2.1.284 gave them on 29 Sep 2026, trimmed. */
  const ccRows = [
    { value: 'default', resolvedModel: `${OPUS}[1m]`, displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'best', resolvedModel: OPUS, displayName: 'Best available' },
    { value: 'opus', resolvedModel: OPUS, displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'sonnet', resolvedModel: SONNET, displayName: 'Sonnet 5' },
    { value: 'haiku', resolvedModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Haiku 4.5' },
  ] as ModelInfo[];
  let gatewayAsks = 0;
  modelSources.gateway = async () => {
    gatewayAsks += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { host: 'gw.test', models: [{ id: 'openai.gpt-5.5' }, { id: SONNET }, { id: OPUS }] };
  };
  modelSources.claudeCode = async () => ccRows;
  forgetCatalog();

  const switches = (): number =>
    eventLog()
      .forAgent('agt_capped')
      .filter((e) => e.payload.kind === 'user_text' && e.payload.text.startsWith('switched to')).length;

  const nickEarly = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/model', { model: 'sonnet' });
  check(
    'a nickname → 400, even before any list is known — an agent keeps an exact id',
    nickEarly.status === 400 && nickEarly.body.detail?.includes('nickname') === true,
    `${nickEarly.status} ${nickEarly.body.detail}`,
  );
  check('checking a model never asks for the list', known() === null && gatewayAsks === 0, `${gatewayAsks} asks`);
  check("with no list, an unlisted id isn't refused — nothing says it isn't served", refusal('us.anthropic.claude-opus-5') === null);

  const [cat, cat2] = (await Promise.all([get<ModelCatalog>('/api/models'), get<ModelCatalog>('/api/models')])).map((r) => r.body) as [ModelCatalog, ModelCatalog];
  check('two pickers opening at once ask the model API once', gatewayAsks === 1, `${gatewayAsks} asks`);
  check(
    'GET /api/models offers what the gateway serves, and says so',
    cat.source === 'gateway' && cat.host === 'gw.test' && cat2.fetchedAt === cat.fetchedAt,
    `${cat.source} ${cat.host}`,
  );
  const ids = cat.models.map((m) => m.id);
  check(
    'Claude first in Claude Code’s order (its recommended default leads), the 1M window as its own choice, others last',
    ids.join() === [`${OPUS}[1m]`, OPUS, SONNET, 'openai.gpt-5.5'].join(),
    ids.join(),
  );
  check(
    'named as Claude Code names them — never after the "default" row',
    cat.models.find((m) => m.id === OPUS)?.label === 'Opus 5.5' &&
      cat.models.find((m) => m.id === `${OPUS}[1m]`)?.label === 'Opus 5.5 · 1M context',
    cat.models.map((m) => `${m.id}=${m.label}`).join(' '),
  );
  check(
    'a model that is not Claude is marked, so the picker can warn',
    cat.models.find((m) => m.id === 'openai.gpt-5.5')?.claude === false &&
      cat.models.filter((m) => m.claude).length === 3,
  );
  check(
    'the tiers resolve to served ids — and haiku, which the settings name but nothing serves, to none',
    cat.tiers.opus === OPUS && cat.tiers.sonnet === SONNET && cat.tiers.haiku === undefined,
    JSON.stringify(cat.tiers),
  );
  check('effort levels come along', cat.models.find((m) => m.id === OPUS)?.effortLevels?.join() === 'low,high,max');

  const unknown = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/model', { model: 'us.anthropic.claude-opus-5' });
  check('a model the gateway does not serve → 400', unknown.status === 400, `got ${unknown.status}`);
  check(
    'naming the host and the ones it does serve',
    unknown.body.detail?.includes('gw.test') === true && unknown.body.detail.includes(SONNET),
    unknown.body.detail,
  );
  const nick = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/model', { model: 'sonnet' });
  check('a nickname now says what it means', nick.status === 400 && nick.body.detail?.includes(SONNET) === true, nick.body.detail);
  const none = await send('POST', '/api/agents/agt_capped/model', {});
  check('no model → 400', none.status === 400, `got ${none.status}`);
  check('and the agent keeps its model', getAgent(db, 'agt_capped')?.model === 'opus');

  const nickJob = await send<{ error?: string; detail?: string }>('POST', '/api/jobs', {
    projectId: 'proj_any',
    prompt: 'go',
    agents: [{ role: 'builder', model: 'opus' }],
  });
  check(
    'a job naming a nickname is refused before anything is made',
    nickJob.status === 400 && nickJob.body.detail?.includes('builder') === true && nickJob.body.detail.includes(OPUS),
    `${nickJob.status} ${nickJob.body.detail}`,
  );

  // Amendment 98: an agent can only wait for one listed before it.
  const jobsBefore = (await get<{ jobs: unknown[] }>('/api/jobs')).body.jobs.length;
  const later = await send<{ detail?: string }>('POST', '/api/jobs', {
    projectId: 'proj_any',
    prompt: 'go',
    agents: [
      { role: 'architect', model: OPUS, dependsOnRoles: ['developer'] },
      { role: 'developer', model: OPUS },
    ],
  });
  check(
    'waiting for an agent listed after it → 400, and says so',
    later.status === 400 && later.body.detail?.includes('comes after it') === true,
    `${later.status} ${later.body.detail}`,
  );
  const loop = await send<{ detail?: string }>('POST', '/api/jobs', {
    projectId: 'proj_any',
    prompt: 'go',
    agents: [
      { role: 'architect', model: OPUS, dependsOnRoles: ['developer'] },
      { role: 'developer', model: OPUS, dependsOnRoles: ['architect'] },
    ],
  });
  check('two agents waiting for each other → 400: neither could ever start', loop.status === 400 && loop.body.detail?.includes('comes after it') === true, `${loop.status} ${loop.body.detail}`);
  check('and nothing was made', (await get<{ jobs: unknown[] }>('/api/jobs')).body.jobs.length === jobsBefore);
  const self = await send<{ detail?: string }>('POST', '/api/jobs', {
    projectId: 'proj_any',
    prompt: 'go',
    agents: [{ role: 'developer', model: OPUS, dependsOnRoles: ['developer'] }],
  });
  check('waiting for itself is still refused as before', self.status === 400 && self.body.detail?.includes('itself') === true, self.body.detail);
  const parsed = await send<{ detail?: string }>('POST', '/api/jobs', {
    projectId: 'proj_none',
    prompt: 'go',
    agents: [
      { role: 'architect', model: OPUS },
      { role: 'developer', model: OPUS, dependsOnRoles: ['architect'] },
    ],
  });
  check(
    'waiting for the one before it passes the check (refused later, for its missing project)',
    parsed.body.detail?.includes('comes after it') !== true && parsed.status !== 201,
    `${parsed.status} ${parsed.body.detail}`,
  );

  const tabs = await connect();
  const toSonnet = await send<{ model: string; appliesTo: string }>('POST', '/api/agents/agt_capped/model', { model: SONNET });
  check(
    'a stopped agent switches from its next run',
    toSonnet.status === 200 && toSonnet.body.model === SONNET && toSonnet.body.appliesTo === 'next run',
    `${toSonnet.status} ${JSON.stringify(toSonnet.body)}`,
  );
  check('the agent row says so', getAgent(db, 'agt_capped')?.model === SONNET);
  await settle();
  check(
    'every tab is told',
    tabs.frames.some((f) => f.type === 'entities' && f.agents?.some((a) => a.id === 'agt_capped' && a.model === SONNET)),
  );
  check('the transcript says it switched', switches() === 1, `${switches()} lines`);
  tabs.close();

  await send('POST', '/api/agents/agt_capped/message', { text: 'now in sonnet' });
  await until(() => runs.length === 6);
  check('the next run is built with the exact id', runs[5]?.options.model === SONNET, String(runs[5]?.options.model));

  const live = await send<{ appliesTo: string }>('POST', '/api/agents/agt_capped/model', { model: OPUS });
  check('a live run switches now', live.status === 200 && live.body.appliesTo === 'now', JSON.stringify(live.body));
  check('through the SDK', runs[5]?.models.join() === OPUS, JSON.stringify(runs[5]?.models));
  check('and the row follows', getAgent(db, 'agt_capped')?.model === OPUS);
  // The session's running total, which now carries on from the $51 §11 left (a smaller one would read as a restart from zero).
  runs[5]?.finish({ cost: 51.5, reason: 'completed' });
  await until(() => getAgent(db, 'agt_capped')?.status === 'done');

  const same = await send<{ appliesTo: string }>('POST', '/api/agents/agt_capped/model', { model: OPUS });
  check('choosing the model it already has changes nothing', same.status === 200 && switches() === 2, `${same.status}, ${switches()} lines`);

  // The gateway can't be asked: Claude Code's list is offered, and it proves nothing.
  modelSources.gateway = () => Promise.reject(new Error('gw.test answered 401 to a request for its models'));
  const fallback = (await get<ModelCatalog>('/api/models?fresh=1')).body;
  check(
    "without the gateway, Claude Code's list, saying why",
    fallback.source === 'claude-code' && fallback.note?.includes('401') === true &&
      fallback.models.some((m) => m.id === 'us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    `${fallback.source} ${fallback.note}`,
  );
  check("and an id missing from it isn't refused — the settings are not the server", refusal('us.anthropic.claude-opus-5') === null);
  modelSources.claudeCode = () => Promise.reject(new Error('Claude Code did not list its models within 20s'));
  const nothing = (await get<ModelCatalog>('/api/models?fresh=1')).body;
  check(
    'with neither, an empty list that says both reasons',
    nothing.source === 'none' && nothing.models.length === 0 && /401/.test(nothing.note ?? '') && /20s/.test(nothing.note ?? ''),
    `${nothing.source} ${nothing.note}`,
  );
  check('and nicknames are still refused', refusal('opus') !== null);
  modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
  modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));
  forgetCatalog();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · what needs you besides a tool call');
  /*
   * Needs You counted only pending requests. An agent that failed while you were on
   * another screen stayed silent, and one that couldn't reach the model read as working
   * for minutes (F10, F13). The same real supervisor and runner; the fake SDK says the
   * retries and replies a real one would.
   */
  for (const r of runs) r.finish({ cost: 0 });
  runs.length = 0;

  check('no HTTP response is unreachable', classifyRetry(null, 'unknown') === 'unreachable');
  check('a refused login is auth', classifyRetry(401, 'authentication_failed') === 'auth');
  check('…and so is a 403 by its status alone', classifyRetry(403, 'unknown') === 'auth');
  check('…and an account problem, whatever the status', classifyRetry(402, 'billing_error') === 'auth');
  check('a rate limit is throttled', classifyRetry(429, 'rate_limit') === 'throttled');
  check('so is an overloaded API', classifyRetry(529, 'overloaded') === 'throttled');
  check('any other status is the server', classifyRetry(500, 'server_error') === 'server');
  const blip = { cause: 'unreachable', attempt: 1, firstAt: 0, gaveUp: false } as const;
  check('one failed attempt needs nobody', !retryNeedsYou(blip, ALERT_AFTER_MS - 1));
  check('…until it has been failing for 20 s', retryNeedsYou(blip, ALERT_AFTER_MS));
  check(
    'a busy API never needs you while it retries',
    !retryNeedsYou({ ...blip, cause: 'throttled', attempt: 9 }, ALERT_AFTER_MS * 10),
  );
  check('but does once it gives up', retryNeedsYou({ ...blip, cause: 'throttled', gaveUp: true }, 0));
  check(
    'a budget note reads back as the stop it was',
    budgetStop('budget reached — spent $25 of its $25 budget') === 'budget_exhausted' &&
      budgetStop(JOB_BUDGET_NOTE) === 'job_budget_reached',
  );
  check('and a pause you asked for is not one', budgetStop('paused by the user') === null && budgetStop(undefined) === null);

  const open = (kind?: Alert['kind']): Alert[] => alerts().list().filter((a) => !kind || a.kind === kind);
  const spent = open('budget').find((a) => a.agentIds[0] === 'agt_spent');
  check('an agent paused on its cap is an alert', spent?.cause === 'budget_exhausted' && spent.jobId === 'job_pair', JSON.stringify(open()));
  const snap = await get<Snapshot>('/api/snapshot');
  check('which a fresh tab gets in the snapshot', snap.body.alerts.some((a) => a.id === spent?.id), JSON.stringify(snap.body.alerts));
  check('a finished agent is not an alert', !open().some((a) => a.agentIds.includes('agt_capped')), JSON.stringify(open().filter((a) => a.agentIds.includes('agt_capped'))));

  job('job_alerts', null);
  for (const id of ['agt_net1', 'agt_net2']) {
    fixture(id, 'job_alerts', { sdkSessionId: `sess_${id}`, autonomy: DEFAULT_AUTONOMY });
  }
  const bell = await connect();
  const alertFrames = () =>
    bell.frames.filter((f): f is Extract<ServerFrame, { type: 'alerts' }> => f.type === 'alerts');
  const retry = (run: FakeRun | undefined, attempt: number, status: number | null, error: string): void =>
    run?.say({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: status, error });
  const retries = (agentId: string) =>
    eventLog()
      .forAgent(agentId)
      .flatMap((e) => (e.payload.kind === 'api_retry' ? [e.payload] : []));

  await send('POST', '/api/agents/agt_net1/message', { text: 'go' });
  await until(() => runs.length === 1);
  const net1 = runs[0];
  retry(net1, 1, null, 'unknown');
  await until(() => retries('agt_net1').length === 1);
  const logged = retries('agt_net1')[0];
  check(
    'a retry is in the transcript, with why',
    logged?.cause === 'unreachable' && logged.attempt === 1 && logged.maxRetries === 10 && logged.delayMs === 500 && logged.httpStatus === null,
    JSON.stringify(logged),
  );
  check('one failed attempt is not an alert', open('connection').length === 0, JSON.stringify(open('connection')));
  retry(net1, 2, null, 'unknown');
  await until(() => open('connection').length > 0);
  const outage = open('connection')[0];
  check(
    'the second is',
    outage?.cause === 'unreachable' && outage.attempt === 2 && outage.maxRetries === 10 && outage.gaveUp === false,
    JSON.stringify(outage),
  );
  check('naming the agent and its job', outage?.agentIds.join() === 'agt_net1' && outage.jobId === 'job_alerts');
  const firstTry = eventLog().forAgent('agt_net1').find((e) => e.payload.kind === 'api_retry');
  check('dated from the first attempt that failed', outage?.since === firstTry?.ts, `${outage?.since} vs ${firstTry?.ts}`);
  check('first in the list', alerts().list()[0]?.id === outage?.id);
  await settle(100);
  check('and every tab is told', alertFrames().some((f) => f.alerts.some((a) => a.id === outage?.id)));

  await send('POST', '/api/agents/agt_net2/message', { text: 'go' });
  await until(() => runs.length === 2);
  const net2 = runs[1];
  retry(net2, 3, null, 'unknown');
  await until(() => (open('connection')[0]?.agentIds.length ?? 0) === 2);
  check(
    'a second agent on the same outage joins its alert',
    open('connection').length === 1 && open('connection')[0]?.id === outage?.id,
    JSON.stringify(open('connection')),
  );
  check('which shows the latest attempt', open('connection')[0]?.attempt === 3);

  net1?.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: Connection error.' }] }, error: 'unknown' });
  await until(() => eventLog().forAgent('agt_net1').some((e) => e.payload.kind === 'text'));
  await settle(50);
  check('an API error written as a reply does not clear it', open('connection').length === 1);
  net1?.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'back again' }] } });
  await until(() => open('connection').length === 0);
  check('a real reply clears it, for both agents', open('connection').length === 0, JSON.stringify(open('connection')));
  await settle(100);
  check('and every tab is told that too', alertFrames().at(-1)?.alerts.every((a) => a.kind !== 'connection') === true);

  retry(net1, 1, 429, 'rate_limit');
  retry(net1, 6, 529, 'overloaded');
  retry(net1, 1, 500, 'server_error');
  await until(() => retries('agt_net1').length === 5);
  check(
    'each cause is told apart',
    retries('agt_net1').slice(2).map((p) => p.cause).join() === 'throttled,throttled,server',
    retries('agt_net1').map((p) => p.cause).join(),
  );
  check('a busy or failing API is not yours to fix while it retries', open('connection').length === 0, JSON.stringify(open('connection')));
  retry(net1, 2, 401, 'authentication_failed');
  await until(() => open('connection').length > 0);
  const login = open('connection')[0];
  check('a refused login is', login?.cause === 'auth' && login.agentIds.join() === 'agt_net1', JSON.stringify(login));

  net1?.finish({ cost: 0.1, isError: true });
  await until(() => open('connection')[0]?.gaveUp === true);
  const gaveUp = open('connection')[0];
  check('a run that ends while retrying gave up', getAgent(db, 'agt_net1')?.status === 'failed' && gaveUp?.cause === 'auth', JSON.stringify(gaveUp));
  check("which is news: its own id, so a dismissed retry can't hide it", gaveUp !== undefined && gaveUp.id !== login?.id);
  check('and its failure is not told twice', !open('failed').some((a) => a.agentIds.includes('agt_net1')), JSON.stringify(open('failed')));

  const dismiss = async (id: string): Promise<number> =>
    (await fetch(`${BASE}/api/alerts/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })).status;
  check('an alert can be put away → 204', (await dismiss(gaveUp?.id ?? '')) === 204);
  check('and is gone from the list', !alerts().list().some((a) => a.id === gaveUp?.id));
  check('a second time there is nothing to put away → 404', (await dismiss(gaveUp?.id ?? '')) === 404);
  check('nor for an id that never was', (await dismiss('failed:nobody:1')) === 404);
  // A fresh Alerts is all a restart leaves it: the outage was only ever in memory.
  initAlerts(db);
  check(
    'after a restart the outage is gone, and the failure it stood for stays put away',
    !alerts().list().some((a) => a.agentIds.includes('agt_net1')),
    JSON.stringify(alerts().list()),
  );

  fixture('agt_broken', 'job_alerts', { role: 'reviewer', sdkSessionId: 'sess_broken', autonomy: DEFAULT_AUTONOMY });
  await send('POST', '/api/agents/agt_broken/message', { text: 'go' });
  await until(() => runs.length === 3);
  runs[2]?.finish({ cost: 0.2, isError: true, reason: 'blocking_limit' });
  await until(() => open('failed').some((a) => a.agentIds[0] === 'agt_broken'));
  const broke = open('failed').find((a) => a.agentIds[0] === 'agt_broken');
  check('an agent that failed is an alert, with why', broke?.cause === 'blocking_limit' && broke.jobId === 'job_alerts', JSON.stringify(open()));
  initAlerts(db);
  check('which a restart does not lose', alerts().list().some((a) => a.id === broke?.id));
  await send('POST', '/api/agents/agt_broken/message', { text: 'try again' });
  await until(() => !open().some((a) => a.agentIds.includes('agt_broken')));
  check('and a message that resumes it clears it', !open().some((a) => a.agentIds.includes('agt_broken')), JSON.stringify(open()));

  // Waiting on an agent that failed (Amendment 85): it stays queued, and Needs You says so.
  fixture('agt_dev_x', 'job_alerts', { role: 'developer', status: 'failed', sdkSessionId: 'sess_dev_x' });
  fixture('agt_rev_x', 'job_alerts', { role: 'reviewer', status: 'queued', dependsOn: ['agt_dev_x'] });
  fixture('agt_stop_x', 'job_alerts', { role: 'validator', status: 'stopped' });
  fixture('agt_scr_x', 'job_alerts', { role: 'scribe', status: 'queued', dependsOn: ['agt_stop_x'] });
  fixture('agt_orch_x', 'job_alerts', { role: 'orchestrator', status: 'queued', dependsOn: ['agt_help_x'] });
  fixture('agt_help_x', 'job_alerts', { role: 'helper', status: 'failed', parentId: 'agt_orch_x' });
  fixture('agt_held_x', 'job_alerts', { role: 'tester', status: 'paused', dependsOn: ['agt_dev_x'] });
  const blocked = (id: string) => open('blocked_dep').find((a) => a.agentIds[0] === id);
  const rev = blocked('agt_rev_x');
  check(
    'an agent waiting on a failed one is an alert, on the one waiting',
    rev?.cause === 'failed' && rev.blockedBy === 'agt_dev_x' && rev.agentIds.length === 1 && rev.jobId === 'job_alerts',
    JSON.stringify(open('blocked_dep')),
  );
  check('and it stays queued', getAgent(db, 'agt_rev_x')?.status === 'queued');
  check('waiting on a stopped one is too', blocked('agt_scr_x')?.cause === 'stopped' && blocked('agt_scr_x')?.blockedBy === 'agt_stop_x');
  check("a helper's orchestrator is not: it goes on without it (Amendment 51)", blocked('agt_orch_x') === undefined);
  check('nor is one that is not queued', blocked('agt_held_x') === undefined);
  setAgentStatus(db, 'agt_dev_x', 'working');
  check('the failed one running again clears it', blocked('agt_rev_x') === undefined, JSON.stringify(open('blocked_dep')));
  for (const id of ['agt_dev_x', 'agt_rev_x', 'agt_scr_x', 'agt_orch_x', 'agt_held_x']) setAgentStatus(db, id, 'done');
  check('and none is left once they have moved on', open('blocked_dep').length === 0, JSON.stringify(open('blocked_dep')));

  // A failure the SDK explains only in `errors`, as a resume of a session that is gone
  // does: no terminal_reason, so the code is a bare "error" (F20).
  const failedStatuses = (agentId: string) =>
    eventLog()
      .forAgent(agentId)
      .flatMap((e) => (e.payload.kind === 'status' && e.payload.status === 'failed' ? [e.payload] : []));
  const GONE = 'No conversation found with session ID: sess_gone';
  fixture('agt_gone', 'job_alerts', { role: 'resumer', sdkSessionId: 'sess_gone', autonomy: DEFAULT_AUTONOMY });
  const beforeGone = runs.length;
  await send('POST', '/api/agents/agt_gone/message', { text: 'carry on' });
  await until(() => runs.length === beforeGone + 1);
  runs[beforeGone]?.finish({ cost: 0, isError: true, errors: [`${GONE}\n    at resume`] });
  await until(() => open('failed').some((a) => a.agentIds[0] === 'agt_gone'));
  const lost = failedStatuses('agt_gone').at(-1);
  check("a failure the SDK explains carries its words, not just 'error'", lost?.error === 'error' && lost.detail === GONE, JSON.stringify(lost));
  const goneAlert = open('failed').find((a) => a.agentIds[0] === 'agt_gone');
  check('and so does its alert', goneAlert?.detail === GONE, JSON.stringify(goneAlert));

  // A run that can't even start: what it threw goes on the one failed status there is.
  fixture('agt_throws', 'job_alerts', { role: 'launcher', sdkSessionId: 'sess_throws', autonomy: DEFAULT_AUTONOMY });
  sdk.query = (() => {
    throw new Error('spawn claude ENOENT\n    at spawn');
  }) as typeof sdk.query;
  await send('POST', '/api/agents/agt_throws/message', { text: 'go' });
  await until(() => getAgent(db, 'agt_throws')?.status === 'failed');
  // And a first launch, which has its own catch.
  const othersQueued = listAgents(db).filter((a) => a.status === 'queued').length;
  fixture('agt_nolaunch', 'job_alerts', { role: 'starter', status: 'queued', autonomy: DEFAULT_AUTONOMY });
  sup.pump();
  await until(() => getAgent(db, 'agt_nolaunch')?.status === 'failed');
  sdk.query = fakeQuery as typeof sdk.query;
  await settle(50);
  const detailOf = (agentId: string) => open('failed').find((a) => a.agentIds[0] === agentId)?.detail;
  const threw = failedStatuses('agt_throws');
  check(
    'one that throws on resume says what, once',
    threw.length === 1 && threw[0]?.detail === 'spawn claude ENOENT' && detailOf('agt_throws') === 'spawn claude ENOENT',
    JSON.stringify(threw),
  );
  const noLaunch = failedStatuses('agt_nolaunch');
  check(
    'and on launch',
    othersQueued === 0 && noLaunch.length === 1 && noLaunch[0]?.error === 'launch_failed' && detailOf('agt_nolaunch') === 'spawn claude ENOENT',
    `${othersQueued} others queued · ${JSON.stringify(noLaunch)}`,
  );

  const paused = await send('POST', '/api/agents/agt_net2/pause');
  await until(() => net2?.finished === true);
  await settle(150);
  check(
    'a run you paused stays paused, however its interrupted run ends',
    paused.status === 200 && getAgent(db, 'agt_net2')?.status === 'paused',
    `${paused.status} ${getAgent(db, 'agt_net2')?.status}`,
  );
  check('and is not an alert', !open().some((a) => a.agentIds.includes('agt_net2')), JSON.stringify(open()));

  const FLAKY = DEV_PORT + 1;
  const flaky: Server = createServer((_req, res) => res.end('<html><body>flaky</body></html>'));
  const up = (): Promise<void> => new Promise((r) => flaky.listen(FLAKY, '127.0.0.1', r));
  const down = (): Promise<void> =>
    new Promise((r) => {
      flaky.close(() => r());
      flaky.closeAllConnections();
    });
  const registry = preview().registry;
  await up();
  await registry.register({ jobId: 'job_alerts', projectId: pid, port: FLAKY, startedByAgentId: 'agt_net2' });
  check('a running dev server is no alert', registry.forJob('job_alerts').some((s) => s.alive) && open('server_down').length === 0);
  await down();
  // The liveness sweep is the only thing that notices, every 5 s.
  await until(() => open('server_down').length > 0, 8_000);
  const died = open('server_down')[0];
  check(
    'one that stops answering on its own is',
    died?.port === FLAKY && died.jobId === 'job_alerts' && died.agentIds.join() === 'agt_net2',
    JSON.stringify(open()),
  );
  await settle(100);
  check('and every tab is told', alertFrames().some((f) => f.alerts.some((a) => a.id === died?.id)));
  await up();
  await registry.register({ jobId: 'job_alerts', port: FLAKY });
  check('back up, it clears', open('server_down').length === 0);
  registry.markDown('job_alerts', FLAKY);
  check('one you stopped is no alert', open('server_down').length === 0);
  await registry.register({ jobId: 'job_alerts', port: FLAKY });
  registry.markDown('job_alerts', FLAKY, true);
  const ghost = open('server_down').length;
  await settle(100);
  const toldGhost = alertFrames().at(-1)?.alerts.some((a) => a.kind === 'server_down') === true;
  registry.forget('job_alerts', FLAKY);
  await settle(100);
  check('forgetting a dead one clears it', ghost === 1 && open('server_down').length === 0, `${ghost} then ${open('server_down').length}`);
  check(
    'and every tab is told, though forgetting a dead server says nothing in the log',
    toldGhost && alertFrames().at(-1)?.alerts.every((a) => a.kind !== 'server_down') === true,
  );
  await down();
  bell.close();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n14 · a resume that cannot make its call');
  /*
   * An MCP call deferred while another call waited for you came back, on resume, to a
   * session whose MCP servers had not reconnected. The SDK ended that run
   * `tool_deferred_unavailable` without running it, and every resume after it the same
   * way, whatever you sent: nothing ever gave the call a result. The runner now forks
   * the session to before the reply that made the call and goes on from there, once
   * (Amendment 30). The session file is faked; the supervisor and runner are real.
   */
  for (const r of runs) r.finish({ cost: 0 });
  runs.length = 0;
  type Chain = Awaited<ReturnType<typeof sdk.getSessionMessages>>;
  const realMessages = sdk.getSessionMessages;
  const realFork = sdk.forkSession;
  const forks: { sessionId: string; upTo: string | undefined }[] = [];
  let chain: Chain = [];
  sdk.getSessionMessages = (async () => chain) as typeof sdk.getSessionMessages;
  sdk.forkSession = (async (sessionId: string, o?: { upToMessageId?: string }) => {
    forks.push({ sessionId, upTo: o?.upToMessageId });
    return { sessionId: `sess_fork_${forks.length}` };
  }) as typeof sdk.forkSession;

  const CALL = { id: 'toolu_get', name: 'mcp__lucid__get_document', input: { doc: '42' } };
  const entry = (type: 'user' | 'assistant', uuid: string, message: unknown) =>
    ({ type, uuid, session_id: 'sess_wedged', message, parent_tool_use_id: null });
  // One reply, as the SDK stores it: its text and its call are two entries sharing an id.
  const WITH_CALL = [
    entry('user', 'u1', { role: 'user', content: 'draw the diagram' }),
    entry('assistant', 'a1', { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Looking it up.' }] }),
    entry('assistant', 'a2', {
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: CALL.id, name: CALL.name, input: CALL.input }],
    }),
  ] as unknown as Chain;
  const userTexts = (agentId: string) =>
    eventLog()
      .forAgent(agentId)
      .flatMap((e) => (e.payload.kind === 'user_text' ? [e.payload] : []));
  const unavailable = { cost: 0, isError: true, reason: 'tool_deferred_unavailable', deferred: CALL };

  job('job_wedged', null);
  chain = WITH_CALL;
  fixture('agt_wedged', 'job_wedged', { sdkSessionId: 'sess_wedged', autonomy: DEFAULT_AUTONOMY });
  await send('POST', '/api/agents/agt_wedged/message', { text: 'carry on' });
  await until(() => runs.length === 1);
  runs[0]?.finish(unavailable);
  await until(() => runs.length === 2);
  const past = runs[1];
  check('a resume that cannot make its call goes on from a fork', past?.options.resume === 'sess_fork_1', String(past?.options.resume));
  check(
    'cut before the whole reply that made the call',
    forks.length === 1 && forks[0]?.sessionId === 'sess_wedged' && forks[0].upTo === 'u1',
    JSON.stringify(forks),
  );
  await until(() => (past?.prompts.length ?? 0) > 0);
  const told = past?.prompts[0] ?? '';
  check(
    'told what was lost, with your words sent again after it',
    told.includes(CALL.name) && told.includes('"doc":"42"') && told.includes('Make the call again') && told.endsWith('\n\ncarry on'),
    told,
  );
  const wedgedSaid = userTexts('agt_wedged');
  check(
    'your words are logged once, and the note as auto',
    wedgedSaid.filter((p) => p.text === 'carry on').length === 1 &&
      wedgedSaid.at(-1)?.synthetic === true &&
      wedgedSaid.at(-1)?.text.includes(CALL.name) === true &&
      wedgedSaid.at(-1)?.text.endsWith('\n\ncarry on') === false,
    JSON.stringify(wedgedSaid),
  );
  past?.finish({ cost: 0.3, reason: 'completed' });
  await until(() => getAgent(db, 'agt_wedged')?.status === 'done');
  check('then it finishes, not fails', getAgent(db, 'agt_wedged')?.status === 'done' && runs.length === 2, getAgent(db, 'agt_wedged')?.status);
  check('and carries on from the fork', getAgent(db, 'agt_wedged')?.sdkSessionId === 'sess_fork_1', getAgent(db, 'agt_wedged')?.sdkSessionId ?? '');
  check('a call it moved past is not one it is parked on', lastDeferredTool(db, 'agt_wedged') === null);

  // The fork fails the same way: once is all it gets.
  fixture('agt_twice', 'job_wedged', { sdkSessionId: 'sess_twice', autonomy: DEFAULT_AUTONOMY });
  let base = runs.length;
  await send('POST', '/api/agents/agt_twice/message', { text: 'carry on' });
  await until(() => runs.length === base + 1);
  runs[base]?.finish(unavailable);
  await until(() => runs.length === base + 2);
  runs[base + 1]?.finish(unavailable);
  await until(() => getAgent(db, 'agt_twice')?.status === 'failed');
  await settle(100);
  check(
    'a fork that fails the same way is not forked again',
    getAgent(db, 'agt_twice')?.status === 'failed' && runs.length === base + 2 && forks.length === 2,
    `${getAgent(db, 'agt_twice')?.status} · ${runs.length - base} runs · ${forks.length} forks`,
  );

  // Nothing to fork from: the call is not in the session file.
  chain = [];
  fixture('agt_stuck', 'job_wedged', { sdkSessionId: 'sess_stuck', autonomy: DEFAULT_AUTONOMY });
  base = runs.length;
  await send('POST', '/api/agents/agt_stuck/message', { text: 'carry on' });
  await until(() => runs.length === base + 1);
  runs[base]?.finish(unavailable);
  await until(() => getAgent(db, 'agt_stuck')?.status === 'failed');
  await settle(100);
  const stuck = failedStatuses('agt_stuck').at(-1);
  check(
    'one that cannot be forked fails, saying why',
    stuck?.error === 'tool_deferred_unavailable' &&
      stuck.detail?.includes(`stuck on a ${CALL.name} call`) === true &&
      stuck.detail.includes('could not be moved past it') &&
      runs.length === base + 1,
    JSON.stringify(stuck),
  );
  check('and so does its alert', detailOf('agt_stuck') === stuck?.detail, detailOf('agt_stuck') ?? '');

  // What happened to agt_c14406f3: a Lucid call waited for you, a sibling was deferred
  // behind it, and your answer resumed a session that could not make the sibling.
  chain = WITH_CALL;
  fixture('agt_decided', 'job_wedged', {
    sdkSessionId: 'sess_decided',
    status: 'blocked',
    blockMode: 'parked',
    autonomy: DEFAULT_AUTONOMY,
  });
  finishRun(db, startRun(db, 'agt_decided', 'sess_decided'), {
    sdkSessionId: 'sess_decided',
    terminalReason: 'tool_deferred',
    deferredTool: CALL,
  });
  insertRequest(db, {
    id: 'req_lucid',
    agentId: 'agt_decided',
    jobId: 'job_wedged',
    projectId: pid,
    kind: 'permission',
    blockMode: 'parked',
    toolName: 'mcp__lucid__create_document',
    toolUseId: 'toolu_create',
    input: { title: 'diagram' },
    label: 'create a Lucid document',
    createdAt: nowIso(),
  });
  check('a run that deferred is parked on its call', lastDeferredTool(db, 'agt_decided')?.id === CALL.id);
  base = runs.length;
  const decided = await send('POST', '/api/requests/req_lucid/decide', { decision: { type: 'allow_once' } });
  await until(() => runs.length === base + 1);
  check(
    'answering resumes it with nothing sent, for the SDK to re-offer the call',
    decided.status === 200 && runs[base]?.options.resume === 'sess_decided' && runs[base]?.prompts.length === 0,
    `${decided.status} · ${JSON.stringify(runs[base]?.prompts)}`,
  );
  runs[base]?.finish(unavailable);
  await until(() => runs.length === base + 2);
  await until(() => (runs[base + 1]?.prompts.length ?? 0) > 0);
  const toldDecided = runs[base + 1]?.prompts[0] ?? '';
  check(
    'the fork is told what you decided, since the resume that carried it never ran',
    toldDecided.includes('The human approved your mcp__lucid__create_document call') && !toldDecided.includes('Make the call again'),
    toldDecided,
  );
  runs[base + 1]?.finish({ cost: 0.1, reason: 'completed' });
  await until(() => getAgent(db, 'agt_decided')?.status === 'done');
  check('and it finishes', getAgent(db, 'agt_decided')?.status === 'done', getAgent(db, 'agt_decided')?.status);

  // The cause: an MCP call behind one that waits for you is declined, never deferred.
  fixture('agt_sibling', 'job_wedged', { status: 'working', autonomy: DEFAULT_AUTONOMY });
  const waiting = (id: string, toolName: string, toolUseId: string): void =>
    insertRequest(db, {
      id,
      agentId: 'agt_sibling',
      jobId: 'job_wedged',
      projectId: pid,
      kind: 'permission',
      blockMode: 'held',
      toolName,
      toolUseId,
      input: {},
      label: toolName,
      createdAt: nowIso(),
    });
  waiting('req_mcp', 'mcp__lucid__create_document', 'toolu_a');
  const sibling = arbiter().preToolUse({ agentId: 'agt_sibling', toolName: 'mcp__lucid__create_document', toolUseId: 'toolu_b', input: {} });
  check(
    'an MCP call behind a waiting one is declined with a reason, not deferred',
    sibling.kind === 'deny' && (sibling.reason ?? '').includes("waiting for the human's decision"),
    JSON.stringify(sibling),
  );
  resolveRequest(db, 'req_mcp', { type: 'deny', by: 'human' });
  waiting('req_bash', 'Bash', 'toolu_c');
  const bash = arbiter().preToolUse({ agentId: 'agt_sibling', toolName: 'Bash', toolUseId: 'toolu_d', input: {} });
  check('a built-in one is still parked with it', bash.kind === 'park', JSON.stringify(bash));
  resolveRequest(db, 'req_bash', { type: 'deny', by: 'human' });

  fixture('agt_parked_once', 'job_wedged', { autonomy: DEFAULT_AUTONOMY });
  finishRun(db, startRun(db, 'agt_parked_once', 'sess_once'), { terminalReason: 'tool_deferred', deferredTool: CALL });
  finishRun(db, startRun(db, 'agt_parked_once', 'sess_once'), { terminalReason: 'aborted_tools' });
  check(
    'one defer, ever, no longer makes every later resume look like one',
    lastDeferredTool(db, 'agt_parked_once') === null,
    JSON.stringify(lastDeferredTool(db, 'agt_parked_once')),
  );
  sdk.getSessionMessages = realMessages;
  sdk.forkSession = realFork;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n15 · an agent put to sleep, and woken (Amendment 35)');
  /*
   * ⏸ pause is sleep: the run stops, the slot is given back, the transcript and the
   * session stay. What it did badly was the edges — it threw away a question the agent
   * was waiting on, woke into a slot that wasn't there, and left the tool call it cut
   * short saying "running…" for good. The supervisor, runner and Arbiter are real.
   */
  for (const r of runs) r.finish({ cost: 0 });
  await settle(100);
  runs.length = 0;
  const sleepHooks = (r: FakeRun | undefined) => r?.options.hooks?.PreToolUse?.[0]?.hooks[0];
  const toolEnds = (agentId: string) =>
    eventLog()
      .forAgent(agentId)
      .flatMap((e) => (e.payload.kind === 'tool_end' ? [e.payload] : []));

  job('job_sleep', null);
  fixture('agt_sleeper', 'job_sleep', { sdkSessionId: 'sess_sleeper', autonomy: DEFAULT_AUTONOMY });
  await send('POST', '/api/agents/agt_sleeper/message', { text: 'run the long job' });
  await until(() => runs.length === 1);
  const signal = new AbortController().signal;
  await sleepHooks(runs[0])?.(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_long', tool_input: { command: 'make soak' } } as never,
    'toolu_long',
    { signal },
  );
  await sleepHooks(runs[0])?.(
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_quick', tool_input: { file_path: 'a' } } as never,
    'toolu_quick',
    { signal },
  );
  await runs[0]?.options.hooks?.PostToolUse?.[0]?.hooks[0]?.(
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_quick', tool_input: { file_path: 'a' }, tool_response: 'ok' } as never,
    'toolu_quick',
    { signal },
  );
  const usedAwake = sup.slots.used;
  const slept = await send('POST', '/api/agents/agt_sleeper/pause');
  await until(() => sup.slots.used === usedAwake - 1);
  check('asleep: paused', slept.status === 200 && getAgent(db, 'agt_sleeper')?.status === 'paused', getAgent(db, 'agt_sleeper')?.status);
  check('and its slot given back', sup.slots.used === usedAwake - 1, `${sup.slots.used} of ${usedAwake}`);
  check('with its session kept', getAgent(db, 'agt_sleeper')?.sdkSessionId === 'sess_sleeper');
  const cut = toolEnds('agt_sleeper').filter((t) => t.toolUseId === 'toolu_long');
  check(
    'the call it cut short says so, instead of "running…" for good',
    cut.length === 1 && cut[0]?.ok === false && cut[0].summary === CUT_SHORT,
    JSON.stringify(cut),
  );
  check(
    'and one that had finished is left as it was',
    toolEnds('agt_sleeper').filter((t) => t.toolUseId === 'toolu_quick').length === 1,
    JSON.stringify(toolEnds('agt_sleeper')),
  );

  await send('POST', '/api/agents/agt_sleeper/resume');
  await until(() => runs.length === 2);
  check('woken, it continues the same session', runs[1]?.options.resume === 'sess_sleeper', String(runs[1]?.options.resume));
  await until(() => (runs[1]?.prompts.length ?? 0) > 0);
  check('told to look before it trusts a call the pause stopped', runs[1]?.prompts[0] === WAKE_NUDGE, JSON.stringify(runs[1]?.prompts));
  runs[1]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_sleeper')?.status === 'done');

  /*
   * Woken while every slot is taken, in a job you had paused. Waking used to launch
   * straight away, one over the limit; queued, pump() left a paused job's agents where
   * they were; and launched from the queue it was told a call had been decided.
   */
  job('job_full', null);
  for (let i = 0; sup.slots.used < slotLimit(); i += 1) {
    const before = sup.slots.used;
    fixture(`agt_busy_${i}`, 'job_full', { sdkSessionId: `sess_busy_${i}`, autonomy: DEFAULT_AUTONOMY });
    await send('POST', `/api/agents/agt_busy_${i}/message`, { text: 'keep busy' });
    if (!(await until(() => sup.slots.used > before))) break;
  }
  await until(() => sup.slots.used === slotLimit());
  const busyRuns = runs.length;
  job('job_napping', null);
  setJobStatus(db, 'job_napping', 'paused');
  fixture('agt_napper', 'job_napping', { status: 'paused', sdkSessionId: 'sess_napper', autonomy: DEFAULT_AUTONOMY });
  await send('POST', '/api/agents/agt_napper/resume');
  await settle(100);
  check('with every slot taken, a woken agent waits for one', getAgent(db, 'agt_napper')?.status === 'queued' && runs.length === busyRuns, `${getAgent(db, 'agt_napper')?.status}, ${runs.length - busyRuns} new run(s)`);
  check('and no more than the limit run', sup.slots.used === slotLimit(), `${sup.slots.used} of ${slotLimit()}`);
  check('its job is live again', getJob(db, 'job_napping')?.status === 'working', getJob(db, 'job_napping')?.status);
  runs.find((r) => !r.finished)?.finish({ cost: 0, reason: 'completed' });
  await until(() => runs.length === busyRuns + 1);
  const napped = runs[busyRuns];
  check('a freed slot goes to it, with its session', napped?.options.resume === 'sess_napper', String(napped?.options.resume));
  await until(() => (napped?.prompts.length ?? 0) > 0);
  check('told it was paused, not that a call was decided', napped?.prompts[0] === WAKE_NUDGE, JSON.stringify(napped?.prompts));
  for (const r of runs) r.finish({ cost: 0, reason: 'completed' });
  await until(() => sup.slots.used === 0);

  /*
   * The limit is a setting now (Amendment 47), changed while agents run. Lowering it
   * stops nobody; raising it starts what was waiting.
   */
  const slotEyes = await connect();
  const setSlots = (v: unknown) => send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: v } });
  check('a limit that is not a whole number from 1 to 32 → 400', (await setSlots('0')).status === 400 && (await setSlots('x')).status === 400 && (await setSlots('33')).status === 400 && (await setSlots('2.5')).status === 400);
  check('a good one is taken', (await setSlots('2')).status === 200 && slotLimit() === 2, String(slotLimit()));
  job('job_limit', null);
  const limitRuns = runs.length;
  // Through the queue, the way launches are scheduled. (A reply to an idle agent starts
  // it at once, over the limit or not — see Amendment 47's open question.)
  for (let i = 0; i < 3; i += 1) {
    fixture(`agt_lim_${i}`, 'job_limit', { status: 'queued', sdkSessionId: `sess_lim_${i}`, autonomy: DEFAULT_AUTONOMY });
  }
  sup.pump();
  await until(() => sup.slots.used === 2);
  await settle(100);
  check('no more than the new limit start', sup.slots.used === 2 && runs.length === limitRuns + 2 && getAgent(db, 'agt_lim_2')?.status === 'queued', `${sup.slots.used} running, ${getAgent(db, 'agt_lim_2')?.status}`);
  await setSlots('1');
  await settle(100);
  check('lowering it stops nobody: both keep running', sup.slots.used === 2 && ['agt_lim_0', 'agt_lim_1'].every((id) => getAgent(db, id)?.status === 'working'));
  check('and the waiting one keeps waiting', getAgent(db, 'agt_lim_2')?.status === 'queued' && runs.length === limitRuns + 2);
  check('every tab hears the new limit', slotEyes.frames.some((f) => f.type === 'slots' && f.slots.total === 1 && f.slots.used === 2));
  runs[limitRuns]!.finish({ cost: 0, reason: 'completed' });
  await settle(150);
  check('a freed slot under a lowered limit starts nothing, while as many run as it allows', sup.slots.used === 1 && getAgent(db, 'agt_lim_2')?.status === 'queued', `${sup.slots.used} running, ${getAgent(db, 'agt_lim_2')?.status}`);
  await setSlots('3');
  check('raising it starts what was waiting, at once', await until(() => runs.length === limitRuns + 3 && sup.slots.used === 2), `${sup.slots.used} running`);
  check('and the snapshot reports the limit', (await get<{ slots: { total: number } }>('/api/snapshot')).body.slots.total === 3);
  for (const r of runs) r.finish({ cost: 0, reason: 'completed' });
  await until(() => sup.slots.used === 0);
  await setSlots(null);
  check('removed, it goes back to the default', slotLimit() === Number(process.env['CONDUCTOR_SLOTS'] ?? 7));
  slotEyes.close();

  /*
   * Asleep on a question. Pausing used to expire it, so the question you had not got to
   * yet was gone. Held, it is parked now; answering it is what wakes the agent.
   */
  const eyes = await connect();
  job('job_asking', null);
  fixture('agt_asker', 'job_asking', { sdkSessionId: 'sess_asker', autonomy: DEFAULT_AUTONOMY });
  const askRuns = runs.length;
  await send('POST', '/api/agents/agt_asker/message', { text: 'tidy up' });
  await until(() => runs.length === askRuns + 1);
  const asking = runs.at(-1);
  await sleepHooks(asking)?.(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_ask', tool_input: { command: 'rm -rf build' } } as never,
    'toolu_ask',
    { signal },
  );
  void asking?.options.canUseTool?.('Bash', { command: 'rm -rf build' }, { signal, toolUseID: 'toolu_ask', suggestions: [] } as never);
  await until(() => getAgent(db, 'agt_asker')?.blockMode === 'held');
  check('held on its question', getAgent(db, 'agt_asker')?.status === 'blocked' && getAgent(db, 'agt_asker')?.blockMode === 'held');
  await send('POST', '/api/agents/agt_asker/pause');
  await until(() => asking?.finished === true && sup.slots.used === 0);
  const asked = openRequestsForAgent(db, 'agt_asker');
  check('put to sleep, the question is kept', asked.length === 1 && asked[0]?.toolUseId === 'toolu_ask', JSON.stringify(asked.map((r) => r.id)));
  check(
    'parked on it, and running nothing',
    getAgent(db, 'agt_asker')?.status === 'blocked' && getAgent(db, 'agt_asker')?.blockMode === 'parked' && asking?.finished === true,
    `${getAgent(db, 'agt_asker')?.status}/${getAgent(db, 'agt_asker')?.blockMode}`,
  );
  check('its slot given back', sup.slots.used === 0, String(sup.slots.used));
  check(
    'the call waiting on you is not called cut short',
    !toolEnds('agt_asker').some((t) => t.toolUseId === 'toolu_ask'),
    JSON.stringify(toolEnds('agt_asker')),
  );
  await send('POST', '/api/agents/agt_asker/pause');
  check('pausing it again changes nothing', openRequestsForAgent(db, 'agt_asker').length === 1 && getAgent(db, 'agt_asker')?.status === 'blocked');
  const beforeAnswer = runs.length;
  const answered = await send('POST', `/api/requests/${asked[0]?.id}/decide`, { decision: { type: 'allow_once' } });
  await until(() => runs.length === beforeAnswer + 1);
  const woke = runs.at(-1);
  check('answering it wakes it, in the same session', answered.status === 200 && woke?.options.resume === 'sess_asker', `${answered.status} ${String(woke?.options.resume)}`);
  await until(() => (woke?.prompts.length ?? 0) > 0);
  check('told what you decided', (woke?.prompts[0] ?? '').includes('Bash call was approved'), JSON.stringify(woke?.prompts));
  woke?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_asker')?.status === 'done');
  eyes.close();

  for (const r of runs) r.finish({ cost: 0 });
  sdk.query = realQuery;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n16 · cleaning up what removal left behind (Amendment 36)');

  type Storage = { events: number; orphaned: number; bytes: number; path: string };
  const kept = getJob(db, 'job_asking')!;
  const scope = (jobId: string, agentId: string | null) => ({ projectId: kept.projectId, jobId, agentId });
  // One of each thing that has to go, and one of each thing that has to stay.
  eventLog().emit(scope('job_removed_16', null), { kind: 'worktree', event: 'created', path: '/x', branch: 'b' });
  eventLog().emit(scope(kept.id, 'agt_removed_16'), { kind: 'text', text: 'from a removed agent' });
  eventLog().emit({ projectId: '', jobId: kept.id, agentId: null }, { kind: 'dev_server', event: 'up', port: 1 });
  const askerEvents = eventLog().forAgent('agt_asker').length;
  const spend = count(db, 'SELECT COUNT(*) AS n FROM cost_daily');
  const before = await get<Storage>('/api/storage');
  check('storage says how big the log is', before.status === 200 && before.body.events > 0 && before.body.bytes > 0, JSON.stringify(before.body));
  check('and how much of it is left over', before.body.orphaned >= 2, String(before.body.orphaned));
  const headBefore = eventLog().head();

  const cleaned = await send<Storage & { removed: number }>('POST', '/api/storage/cleanup', {});
  check('cleanup removes exactly what was left over', cleaned.body.removed === before.body.orphaned, `${cleaned.body.removed} of ${before.body.orphaned}`);
  check('and says nothing is left', cleaned.body.orphaned === 0 && cleaned.body.events === before.body.events - before.body.orphaned);
  check("a removed job's events went", count(db, "SELECT COUNT(*) AS n FROM events WHERE job_id = 'job_removed_16'") === 0);
  check("a removed agent's events went", count(db, "SELECT COUNT(*) AS n FROM events WHERE agent_id = 'agt_removed_16'") === 0);
  check("a live agent's transcript is untouched", eventLog().forAgent('agt_asker').length === askerEvents);
  check(
    'a live job\'s event with no project id stays',
    count(db, "SELECT COUNT(*) AS n FROM events WHERE job_id = ? AND kind = 'dev_server' AND project_id = ''", kept.id) === 1,
  );
  check('spend history stays', count(db, 'SELECT COUNT(*) AS n FROM cost_daily') === spend);
  const next = eventLog().emit(scope(kept.id, null), { kind: 'worktree', event: 'created', path: '/y', branch: 'b' });
  check('a seq is never handed out twice, so every cursor stays valid', next.seq > headBefore, `${next.seq} vs ${headBefore}`);
  const twice = await send<{ removed: number }>('POST', '/api/storage/cleanup', {});
  check('running it again removes nothing', twice.body.removed === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n17 · what an agent is told about the agents it waited for (Amendment 37)');
  /*
   * dependsOn was timing only: the fixer started after the debugger, with the job prompt
   * and its own brief, and never heard the cause the debugger found. The supervisor is
   * real; the upstream replies are written to the log the way the runner writes them.
   */
  sdk.query = fakeQuery as typeof sdk.query;
  for (const r of runs) r.finish({ cost: 0 });
  await settle(100);
  runs.length = 0;
  job('job_handoff', null);
  fixture('agt_debugger', 'job_handoff', { role: 'debugger', autonomy: DEFAULT_AUTONOMY });
  fixture('agt_quiet', 'job_handoff', { role: 'validator', autonomy: DEFAULT_AUTONOMY });
  const said17 = (agentId: string, text: string) =>
    eventLog().emit({ projectId: pid, jobId: 'job_handoff', agentId }, { kind: 'text', text });
  /*
   * The debugger's whole conversation (Amendment 101), in the order the runner would log it:
   * the launch prompt (the job instruction, then its brief), working notes, tool calls with
   * output we must not pass on, a failed call, a question answered through the question tool,
   * a message from the user, one Conductor wrote, edits and spend, and the final reply.
   */
  const log17 = (agentId: string, payload: Parameters<ReturnType<typeof eventLog>['emit']>[1]) =>
    eventLog().emit({ projectId: pid, jobId: 'job_handoff', agentId }, payload);
  log17('agt_debugger', { kind: 'user_text', text: 'the job_handoff prompt\n\nYour role is debugger. Find why the parser drops tokens.' });
  said17('agt_debugger', 'Reading the parser first.');
  log17('agt_debugger', { kind: 'tool_start', toolUseId: 'tu_read', tool: 'Read', input: {}, label: 'Read src/parse.ts' });
  log17('agt_debugger', { kind: 'tool_end', toolUseId: 'tu_read', ok: true, summary: 'SECRET-FILE-CONTENTS 412 lines' });
  log17('agt_debugger', { kind: 'tool_start', toolUseId: 'tu_test', tool: 'Bash', input: {}, label: 'Bash · npm test' });
  log17('agt_debugger', { kind: 'tool_end', toolUseId: 'tu_test', ok: false, summary: 'error: SECRET-TEST-OUTPUT 3 failed' });
  log17('agt_debugger', { kind: 'user_text', text: 'switched to opus', synthetic: true });
  log17('agt_debugger', { kind: 'tool_start', toolUseId: 'tu_ask', tool: 'AskUserQuestion', input: {}, label: 'Which tokenizer is it?' });
  log17('agt_debugger', { kind: 'tool_end', toolUseId: 'tu_ask', ok: true, summary: '"Which tokenizer is it?"="the new one"' });
  log17('agt_debugger', { kind: 'user_text', text: 'Check the lexer too.' });
  log17('agt_debugger', { kind: 'file_edit', path: 'src/parse.ts', added: 3, removed: 1 });
  log17('agt_debugger', { kind: 'usage', costUsd: 0.1, inputTokens: 10, outputTokens: 5 });
  said17('agt_debugger', 'Root cause: parse.ts:42 drops the last token.');
  insertAgent(db, {
    id: 'agt_fixer',
    jobId: 'job_handoff',
    projectId: pid,
    role: 'builder',
    model: 'opus',
    sdkSessionId: null,
    status: 'queued',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: ['agt_debugger', 'agt_quiet'],
    autonomy: DEFAULT_AUTONOMY,
    brief: 'Fix the root cause the debugger identified.',
  });
  sup.pump();
  await until(() => (runs[0]?.prompts.length ?? 0) > 0);
  const told17 = runs[0]?.prompts[0] ?? '';
  check('it hears what the agent before it said last', told17.includes('[debugger]\n') && told17.includes('Agent: Root cause: parse.ts:42 drops the last token.'), told17);
  check('and its working notes too: the whole conversation, not only the last reply (Amendment 101)', told17.includes('Agent: Reading the parser first.'), told17);
  check(
    "and what the user said to it, once — the job instruction is not repeated from its launch prompt, but its brief is (Amendment 101)",
    told17.includes('User: Check the lexer too.') &&
      told17.includes('User: (the job instruction, as above)\n\nYour role is debugger. Find why the parser drops tokens.') &&
      told17.split('the job_handoff prompt').length === 2,
    told17,
  );
  check(
    'a line for each tool call, a failed one saying so, and none of what the tools returned (Amendment 101)',
    told17.includes('Tool: Read src/parse.ts\nTool: Bash · npm test (failed)') && !told17.includes('SECRET-FILE-CONTENTS') && !told17.includes('SECRET-TEST-OUTPUT'),
    told17,
  );
  check(
    'a question asked with the question tool keeps its answer (Amendment 101)',
    told17.includes('Tool: asked the user · Which tokenizer is it? → "Which tokenizer is it?"="the new one"'),
    told17,
  );
  check("a message Conductor wrote is not in it, as the user's (Amendment 101)", !told17.includes('switched to opus'), told17);
  check(
    'in the order it happened (Amendment 101)',
    ['Reading the parser first.', 'Tool: Read src/parse.ts', 'Tool: asked the user', 'User: Check the lexer too.', 'Agent: Root cause'].every(
      (needle, i, all) => i === 0 || told17.indexOf(all[i - 1]!) < told17.indexOf(needle),
    ),
    told17,
  );
  check(
    "the log gives only what a conversation is made of (Amendment 101)",
    eventLog().conversation('agt_debugger').every((e) => ['user_text', 'text', 'tool_start', 'tool_end'].includes(e.payload.kind)) &&
      eventLog().conversation('agt_debugger').length === 11,
    String(eventLog().conversation('agt_debugger').length),
  );
  check('an agent that wrote nothing is said to have written nothing', told17.includes('[validator]\n(It finished without a written reply.)'), told17);
  check(
    'in order: the job, then the handoff, then its own brief',
    told17.startsWith('the job_handoff prompt') &&
      told17.indexOf('[debugger]') < told17.indexOf('Your role is builder. Fix the root cause'),
    told17,
  );
  check(
    'and the transcript shows what it was told',
    eventLog()
      .forAgent('agt_fixer')
      .some((e) => e.payload.kind === 'user_text' && e.payload.text === told17),
  );
  check(
    'an agent that waited is told to ask with the question tool, after the handoff and before its brief (Amendment 100)',
    told17.includes(STACK_ASK_LINE) &&
      told17.indexOf('[debugger]') < told17.indexOf(STACK_ASK_LINE) &&
      told17.indexOf(STACK_ASK_LINE) < told17.indexOf('Your role is builder.'),
    told17,
  );
  check(
    'the line names the question tool under both of its names, Claude\'s and Copilot\'s (Amendment 100)',
    /AskUserQuestion/.test(STACK_ASK_LINE) && /ask_user/.test(STACK_ASK_LINE),
    STACK_ASK_LINE,
  );
  runs[0]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_fixer')?.status === 'done');

  fixture('agt_alone', 'job_handoff', { role: 'reviewer', status: 'queued', autonomy: DEFAULT_AUTONOMY });
  sup.pump();
  await until(() => (runs[1]?.prompts.length ?? 0) > 0);
  check('an agent that waited for nobody is told nothing extra', runs[1]?.prompts[0] === 'the job_handoff prompt', JSON.stringify(runs[1]?.prompts));
  check('and that includes not being told how to ask: it is not in a stack (Amendment 100)', !(runs[1]?.prompts[0] ?? '').includes(STACK_ASK_LINE));
  runs[1]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_alone')?.status === 'done');

  // The first agent of a stack waits for nobody, but the agents after it wait for it (Amendment 100).
  fixture('agt_lead', 'job_handoff', { role: 'architect', status: 'queued', autonomy: DEFAULT_AUTONOMY });
  fixture('agt_follow', 'job_handoff', { role: 'builder', status: 'queued', dependsOn: ['agt_lead'], autonomy: DEFAULT_AUTONOMY });
  const leadRun = runs.length;
  sup.pump();
  await until(() => (runs[leadRun]?.prompts.length ?? 0) > 0);
  check(
    'an agent that others wait for is told how to ask too, though it waited for nobody (Amendment 100), and to hand off (Amendment 104)',
    runs[leadRun]?.prompts[0] === `the job_handoff prompt\n\n${STACK_ASK_LINE}\n\n${HAND_OFF_LINE}`,
    JSON.stringify(runs[leadRun]?.prompts),
  );
  handOffAs('agt_lead');
  runs[leadRun]?.finish({ cost: 0, reason: 'completed' });
  await until(() => (runs[leadRun + 1]?.prompts.length ?? 0) > 0);
  runs[leadRun + 1]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_follow')?.status === 'done');

  const jobShape = [
    { id: 'a', dependsOn: [] as string[] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: [] as string[] },
  ];
  check(
    'in a stack: the one that waits, and the one waited for; not an agent on its own (Amendment 100)',
    inStack('b', jobShape) && inStack('a', jobShape) && !inStack('c', jobShape),
  );
  check('one started without a stopped agent still counts as having waited (Amendment 100)', inStack('c', jobShape, 1) && !inStack('c', jobShape, 0));
  check('the line is empty for an agent on its own (Amendment 100)', stackLine(false) === '' && stackLine(true) === STACK_ASK_LINE);

  // ── Amendment 101: the whole conversation, capped by the next model's window, oldest first ──
  const T = (kind: Turn['kind'], text: string): Turn => ({ kind, text });
  /** `n` replies of `size` characters each, tagged #001#… so a check can say which are there. Each costs size + 9. */
  const agentTurns = (n: number, size: number): Turn[] =>
    Array.from({ length: n }, (_, i) => T('agent', `#${String(i + 1).padStart(3, '0')}#${'x'.repeat(size - 5)}`));

  const ten = agentTurns(10, 100); // 109 characters each in the text
  const newest3 = fitTurns(ten, 3 * 109);
  check(
    'over the cap the oldest go first and the newest stay, whole (Amendment 101)',
    newest3.kept.length === 3 && newest3.dropped === 7 && newest3.kept[0]!.text.startsWith('#008#') && newest3.kept[2]!.text.startsWith('#010#'),
    JSON.stringify([newest3.kept.length, newest3.dropped]),
  );
  check('and exactly at the cap nothing goes, one over it the oldest does (Amendment 101)', fitTurns(ten, 10 * 109).dropped === 0 && fitTurns(ten, 10 * 109 - 1).dropped === 1);
  const bigReply = 'R'.repeat(5_000);
  const bigFit = fitTurns([T('user', 'q'), T('agent', 'older'), T('agent', bigReply)], 100);
  check('the last reply is kept whole even when it alone is over the cap (Amendment 101)', bigFit.kept.length === 1 && bigFit.kept[0]!.text === bigReply && bigFit.dropped === 2);
  const afterReply = fitTurns([T('user', 'q'), T('agent', 'last reply'), ...Array.from({ length: 50 }, (_, i) => T('tool', `Edit f${i}.ts`))], 200);
  check('and stays when the tool calls after it are over the cap — they do not push it out (Amendment 101)', afterReply.kept[0]?.text === 'last reply' && afterReply.dropped === 1);

  const cappedSec = handoffSection([{ role: 'analyst', reply: null, turns: ten }], 3 * 109);
  check(
    'the section shows the newest and says how much is left out (Amendment 101)',
    cappedSec.includes('the first 7 of 10 entries are left out to fit') && cappedSec.includes('#010#') && cappedSec.includes('#008#') && !cappedSec.includes('#007#'),
    cappedSec,
  );
  const twenty = handoffSection([{ role: 'analyst', reply: 'x'.repeat(20_000) }], handoffCap('opus'));
  check('a long last reply is no longer cut at 8,000 characters (Amendment 101)', twenty.includes('x'.repeat(20_000)) && !twenty.includes('cut at'));
  check('an agent with only its last reply is told it as the one thing it said (Amendment 101)', handoffSection([{ role: 'analyst', reply: 'Done.' }], 1_000).includes('[analyst]\nAgent: Done.'));

  // Several upstreams share the cap: equal shares, and what one does not need goes to the rest.
  check('three needing 10, 500 and 900 of 600 get 10, 295 and 295 (Amendment 101)', shareCap(600, [10, 500, 900]).join() === '10,295,295', shareCap(600, [10, 500, 900]).join());
  check('and when all of them fit, all of them get what they need (Amendment 101)', shareCap(10_000, [10, 500, 900]).join() === '10,500,900' && shareCap(0, [5, 5]).join() === '0,0');
  const shared = handoffSection(
    [
      { role: 'a', reply: null, turns: agentTurns(10, 100) },
      { role: 'b', reply: null, turns: agentTurns(10, 100) },
      { role: 'c', reply: null, turns: [T('agent', 'small')] },
    ],
    1_000,
  );
  check(
    'agents the next one waited for share the cap: the small one whole, the big ones the same cut each (Amendment 101)',
    shared.includes('[c]\nAgent: small') && (shared.match(/the first 6 of 10 entries are left out to fit/g) ?? []).length === 2 && !shared.includes('#006#') && shared.includes('#007#'),
    shared,
  );

  // The job instruction is outside it: #promptFor puts it first and does not count it.
  const BIGJOB = 'J'.repeat(200_000);
  insertJob(db, { id: 'job_big101', projectId: pid, prompt: BIGJOB, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
  fixture('agt_talker', 'job_big101', { role: 'analyst', autonomy: DEFAULT_AUTONOMY });
  for (let i = 1; i <= 400; i++) {
    eventLog().emit({ projectId: pid, jobId: 'job_big101', agentId: 'agt_talker' }, { kind: 'text', text: `#t${String(i).padStart(3, '0')}#${'y'.repeat(993)}` });
  }
  insertAgent(db, {
    id: 'agt_listener',
    jobId: 'job_big101',
    projectId: pid,
    role: 'builder',
    model: 'opus',
    sdkSessionId: null,
    status: 'queued',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: ['agt_talker'],
    autonomy: DEFAULT_AUTONOMY,
    brief: 'Carry on.',
  });
  const bigRun = runs.length;
  sup.pump();
  await until(() => (runs[bigRun]?.prompts.length ?? 0) > 0);
  const bigPrompt = runs[bigRun]?.prompts[0] ?? '';
  check('a 200,000-character job instruction is first and whole, over any share of the window (Amendment 101)', bigPrompt.startsWith(BIGJOB));
  check(
    'and the 400 replies after it are cut to a quarter of opus\'s window, the oldest first (Amendment 101)',
    bigPrompt.length - BIGJOB.length <= handoffCap('opus') + 2_000 && bigPrompt.includes('#t400#') && !bigPrompt.includes('#t001#') && /the first \d+ of 400 entries are left out to fit/.test(bigPrompt),
    String(bigPrompt.length - BIGJOB.length),
  );
  check('and its brief is still last (Amendment 101)', bigPrompt.endsWith('Your role is builder. Carry on.'), bigPrompt.slice(-120));
  runs[bigRun]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_listener')?.status === 'done');

  // Agents that did not finish keep the wording of Amendments 51 and 88.
  const unfinished = handoffSection(
    [
      { role: 'builder', reply: null, status: 'stopped' },
      { role: 'tester', reply: null, status: 'stopped', turns: [T('user', 'run it'), T('tool', 'Bash · make')] },
      { role: 'helper', reply: 'half done', status: 'failed' },
    ],
    1_000,
  );
  check(
    'one it was started without says it was stopped, and the section says it did not wait for everyone (Amendments 88, 101)',
    unfinished.startsWith('You were started without waiting for every agent before you to finish.') &&
      unfinished.includes('[builder — stopped, so it may not have finished its part]\n(It was stopped before it wrote a reply.)') &&
      unfinished.includes('[tester — stopped, so it may not have finished its part]\nUser: run it\n\nTool: Bash · make\n\n(It was stopped before it wrote a reply.)'),
    unfinished,
  );
  check('a failed one says so, over what it said (Amendments 51, 101)', unfinished.includes('[helper — failed, so it may not have finished its part]\nAgent: half done'), unfinished);
  check(
    "an orchestrator's helper report still marks a failed helper and says it wrote nothing (Amendments 51, 120)",
    helperReport(
      [
        { role: 'h1', status: 'failed', reply: null },
        { role: 'h2', status: 'done', reply: 'x'.repeat(9_000) },
      ],
      100_000,
    ).includes('[h1 — failed, so it may not have finished its part]\n(It finished without a written reply.)'),
  );
  check(
    'and a long reply is no longer cut at 8,000 characters: it is whole, as the next agent in a stack is given one (Amendment 120)',
    (() => {
      const long = helperReport([{ role: 'h2', status: 'done', reply: 'x'.repeat(9_000) }], 100_000);
      return long.includes('[h2]\nAgent: ' + 'x'.repeat(9_000)) && !long.includes('cut at');
    })(),
  );

  // The seam for hand_off: a summary goes on top of an upstream's text, whole, and the cap does not touch it.
  const summed = handoffSection([{ role: 'builder', reply: null, summary: 'Fixed parse.ts; tests pass.', turns: ten }], 109);
  check(
    'a summary goes first, whole, outside the cap, above the text (Amendment 101)',
    summed.includes('[builder]\nIts summary of its work:\nFixed parse.ts; tests pass.\n\n') && summed.indexOf('Fixed parse.ts') < summed.indexOf('#010#') && !summed.includes('#009#'),
    summed,
  );
  check('without one, nothing about a summary is said (Amendment 101)', !cappedSec.includes('summary'));

  // How big the window is, and so the cap: a table, because nothing in the repo knew.
  check(
    "windows: Claude's are 200k and, with [1m], 1M; a vendor in front is ignored; gpt, o-series and gemini 128k; anything else 64k (Amendment 101)",
    contextWindow('opus') === 200_000 && contextWindow('claude-sonnet-4-5') === 200_000 && contextWindow('claude-opus-4-1[1m]') === 1_000_000 &&
      contextWindow('anthropic/claude-sonnet-4.5') === 200_000 && contextWindow('openai/gpt-5') === 128_000 && contextWindow('gpt-5-mini') === 128_000 &&
      contextWindow('o3') === 128_000 && contextWindow('google/gemini-2.5-pro') === 128_000 && contextWindow('some-new-model') === 64_000 && contextWindow('') === 64_000,
  );
  check(
    'the cap is a quarter of the window at three characters a token (Amendment 101)',
    handoffCap('opus') === 150_000 && handoffCap('claude-opus-4-1[1m]') === 750_000 && handoffCap('gpt-5') === 96_000 && handoffCap('some-new-model') === 48_000,
  );

  // The turns themselves, from events written by hand.
  type LogEvent = Parameters<typeof turnsFromEvents>[0][number];
  const logEv = (payload: LogEvent['payload']): LogEvent => ({ seq: 1, ts: '', projectId: pid, jobId: 'j', agentId: 'a', payload });
  const turnsText = (events: LogEvent[]) => turnsFromEvents(events, 'JOB').map((t) => `${t.kind}:${t.text}`).join(' | ');
  check('a launch prompt that is only the job instruction says nothing (Amendment 101)', turnsText([logEv({ kind: 'user_text', text: 'JOB' })]) === '');
  check('a first message that does not begin with the job instruction is kept whole (Amendment 101)', turnsText([logEv({ kind: 'user_text', text: 'something else' })]) === 'user:something else');
  check(
    'only the first message is stripped of the job instruction (Amendment 101)',
    turnsText([logEv({ kind: 'user_text', text: 'JOB\n\nbrief' }), logEv({ kind: 'user_text', text: 'JOB again' })]) === 'user:(the job instruction, as above)\n\nbrief | user:JOB again',
  );
  check(
    "the line about asking, in an upstream's launch prompt, is not passed on: the next agent has its own (Amendments 100, 101)",
    turnsText([logEv({ kind: 'user_text', text: `JOB\n\n${STACK_ASK_LINE}\n\nYour role is x. Do y.` })]) === 'user:(the job instruction, as above)\n\nYour role is x. Do y.',
  );
  check(
    'blank prose, and the end of a call it never saw start, are left out (Amendment 101)',
    turnsText([logEv({ kind: 'text', text: '  \n' }), logEv({ kind: 'tool_end', toolUseId: 'nope', ok: false, summary: 'x' })]) === '',
  );

  // ── Amendment 120 ─────────────────────────────────────────────────────────

  // The line about asking: since hand_off an agent that others wait for is held, not finished.
  check(
    'the line about asking no longer says the agents after it start without the answer: they are held (Amendment 120)',
    !/start without the answer/.test(STACK_ASK_LINE) && !/starts? the agents/.test(STACK_ASK_LINE) &&
      /held as not handed off/.test(STACK_ASK_LINE) && /Needs You/.test(STACK_ASK_LINE),
    STACK_ASK_LINE,
  );
  check('and still names both engines’ question tools, and says the reply asks no one (Amendment 120)', /AskUserQuestion/.test(STACK_ASK_LINE) && /ask_user/.test(STACK_ASK_LINE) && /not put to anyone/.test(STACK_ASK_LINE));
  const OLD_ASK =
    'You are one agent in a stack, and some agents wait for others to finish. When you need an answer from the user, ask with the question tool (AskUserQuestion, or ask_user), not in your reply: a question in your reply ends your turn and the agents after you start without the answer, while the question tool holds you, and them, until the user has answered.';
  check(
    "an agent launched under Amendment 100's wording has that taken out of its prompt as well, not passed on as its brief (Amendment 120)",
    turnsText([logEv({ kind: 'user_text', text: `JOB\n\n${OLD_ASK}\n\nYour role is x. Do y.` })]) === 'user:(the job instruction, as above)\n\nYour role is x. Do y.',
  );

  // The window an engine reported is the window, in whole tokens; anything else is the floor.
  check(
    'a window the engine reported is used as it is, in whole tokens, over the table (Amendment 120)',
    contextWindow('anything', 8_192) === 8_192 && contextWindow('opus', 1_000_000) === 1_000_000 && contextWindow('opus', 8_192.9) === 8_192 && contextWindow('some-new-model', 1) === 1,
  );
  check(
    'one that is not a window (zero, negative, not a number, infinite) falls back to the floor (Amendment 120)',
    contextWindow('opus', 0) === 200_000 && contextWindow('opus', -5) === 200_000 && contextWindow('opus', Number.NaN) === 200_000 &&
      contextWindow('gpt-5', undefined) === 128_000 && contextWindow('some-new-model', Number.POSITIVE_INFINITY) === 64_000,
  );
  check(
    'the cap is a quarter of the real window at three characters a token — an estimate, not a count (Amendment 120)',
    handoffCap('x', 8_192) === 6_144 && handoffCap('opus', 1_000_000) === 750_000 && handoffCap('opus') === 150_000 && handoffCap('opus', undefined) === 150_000,
  );
  forgetWindows();
  check(
    'recordWindows keeps a window by provider and exact id, and skips what is not one (Amendment 120)',
    recordWindows('openrouter', [
      { id: 'a/b', tokens: 32_768 },
      { id: 'a/c', tokens: null },
      { id: 'a/d', tokens: 0 },
      { id: '', tokens: 5 },
      { id: 'a/e', tokens: 'big' },
      { id: 'a/f', tokens: 1_000.7 },
      { id: 'a/g' },
    ]) === 2 &&
      reportedWindow('openrouter', 'a/b') === 32_768 && reportedWindow('openrouter', 'a/c') === undefined && reportedWindow('openrouter', 'a/f') === 1_000 &&
      reportedWindow('claude', 'a/b') === undefined && reportedWindow('openrouter', 'a/zzz') === undefined,
  );
  recordWindows('claude', [{ id: 'claude-x', tokens: 200_000 }]);
  check(
    'a [1m] model is not looked up: the list gives the base model’s window, and [1m] is the 1,000,000 one the floor says (Amendment 120)',
    reportedWindow('claude', 'claude-x') === 200_000 && reportedWindow('claude', 'claude-x[1m]') === undefined && contextWindow('claude-x[1m]', reportedWindow('claude', 'claude-x[1m]')) === 1_000_000,
  );
  forgetWindows();

  // Text said twice: a part quoted inside another agent's launch prompt, seen by an agent that waits for several.
  const PLAN = 'The plan: rotate the refresh tokens, keep the family id, and revoke the whole family on reuse.';
  const arch: Upstream = {
    role: 'architect',
    reply: PLAN,
    summary: 'Architect summary: sessions live in src/session.ts, nothing else changes.',
    turns: [T('user', '(the job instruction, as above)\n\nYour role is architect. Plan the change before anyone touches the code.'), T('agent', PLAN), T('tool', 'Read src/auth.ts'), T('tool', 'Read src/session.ts')],
  };
  // What each of three agents that waited for the architect was given at launch: its section, then its own brief.
  const launched = (role: string): Upstream => ({
    role,
    reply: `${role} finished its part and all of its checks pass.`,
    turns: [
      T('user', `(the job instruction, as above)\n\n${handoffSection([arch], 100_000)}\n\nYour role is ${role}. Do your part, and only your part, of the plan.`),
      T('agent', `${role} finished its part and all of its checks pass.`),
    ],
  });
  const three = [launched('developer'), launched('validator'), launched('analyst')];
  const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
  const raw = three.flatMap((u) => u.turns ?? []).map((t) => t.text).join('\n');
  check('without dropping anything, the architect’s part is in all three launch prompts — the problem (Amendment 120)', occurrences(raw, PLAN) === 3, String(occurrences(raw, PLAN)));
  const once = handoffSection(three, 1_000_000);
  check('three agents that share a parent: the parent’s text is said once, in the first (Amendment 120)', occurrences(once, PLAN) === 1 && occurrences(once, 'Architect summary: sessions live') === 1 && once.indexOf(PLAN) < once.indexOf('[validator]'), once);
  check('the second and the third say where it went, once each, and keep what is their own (Amendment 120)', occurrences(once, REPEAT_MARKER) === 2 && ['developer', 'validator', 'analyst'].every((r) => once.includes(`Your role is ${r}. Do your part`) && once.includes(`Agent: ${r} finished its part`)), once);
  check('and the opening sentence of the quoted section and the tool lines the parent called are said once too — twice with the section’s own (Amendment 120)', occurrences(once, 'They worked in this same folder') === 2 && occurrences(once, 'Tool: Read src/auth.ts') === 1, `${occurrences(once, 'They worked in this same folder')}`);
  // A cap the three would not fit in with every copy counted, and that they do fit in once the copies are gone.
  const squeezed = handoffSection(three, raw.length - 2 * PLAN.length);
  check('the cap is spent on what is left: a cap too small for the three as they were cuts nothing now (Amendment 120)', !squeezed.includes('left out to fit') && occurrences(squeezed, PLAN) === 1, squeezed.slice(0, 300));
  const withParent = handoffSection([arch, ...three], 1_000_000);
  check(
    'the parent in the list as well, first: its text and its summary are still there once, in its own part (Amendment 120)',
    occurrences(withParent, PLAN) === 1 && occurrences(withParent, 'Architect summary: sessions live') === 1 && withParent.indexOf(PLAN) < withParent.indexOf('[developer]'),
    withParent,
  );
  const parentLast = handoffSection([...three, arch], 1_000_000);
  check('and last: still once, whichever way the agents are listed (Amendment 120)', occurrences(parentLast, PLAN) === 1 && occurrences(parentLast, 'Architect summary: sessions live') === 1, parentLast);
  check(
    'a chain A, B, C where the third waits only for the second has nothing to drop: A’s part is there once, inside B’s (Amendment 120)',
    (() => {
      const chain = handoffSection([launched('developer')], 1_000_000);
      return occurrences(chain, PLAN) === 1 && !chain.includes(REPEAT_MARKER);
    })(),
  );
  const twinA: Upstream = { role: 'a', reply: null, turns: [T('user', 'q'), T('agent', 'x'.repeat(200))] };
  const twinB: Upstream = { role: 'b', reply: null, turns: [T('user', 'q'), T('agent', 'x'.repeat(200))] };
  check('two agents that say the same long thing in their own voice both keep it: only quoting is dropped (Amendment 120)', occurrences(handoffSection([twinA, twinB], 1_000_000), 'x'.repeat(200)) === 2);
  const shortSame = [{ role: 'a', reply: null, turns: [T('user', 'Please continue with the next step.'), T('agent', 'ok')] }, { role: 'b', reply: null, turns: [T('user', 'Please continue with the next step.'), T('agent', 'ok')] }];
  check('and a short paragraph said by both is kept for both (Amendment 120)', occurrences(handoffSection(shortSame, 1_000_000), 'Please continue with the next step.') === 2);
  check('dropRepeats changes nothing for upstreams with no turns or no quoting, and hands back the same objects (Amendment 120)', (() => {
    const plain = [{ role: 'a', reply: 'r' }, twinA];
    const out = dropRepeats(plain);
    return out[0] === plain[0] && out[1] === plain[1];
  })());

  // The helper report: the same whole-conversation treatment, within the same share of the window.
  const hr = helperReport(
    [
      { role: 'h1', status: 'done', reply: 'Routes are in api.ts.', turns: [T('user', '(the job instruction, as above)\n\nYour role is h1. Build the API.'), T('tool', 'Edit src/api.ts'), T('agent', 'Routes are in api.ts.')] },
      { role: 'h2', status: 'failed', reply: 'Half of it.', turns: [T('user', 'Build the UI.'), T('agent', 'Half of it.')] },
    ],
    100_000,
  );
  check(
    'a helper report is each helper’s whole conversation — its task, a line per tool, its replies — and marks the failed one (Amendment 120)',
    hr.startsWith('Your helpers have finished. What each was told and said, in order') &&
      hr.includes('[h1]\nUser: (the job instruction, as above)\n\nYour role is h1. Build the API.\n\nTool: Edit src/api.ts\n\nAgent: Routes are in api.ts.') &&
      hr.includes('[h2 — failed, so it may not have finished its part]\nUser: Build the UI.\n\nAgent: Half of it.') &&
      hr.endsWith('Start more helpers if something is left.'),
    hr,
  );
  const many = (n: number): Turn[] => [T('user', 'task'), ...Array.from({ length: n }, (_, i) => T('agent', `#${String(i + 1).padStart(3, '0')}# ${'z'.repeat(90)}`))];
  const capped2 = helperReport([{ role: 'h1', status: 'done', reply: null, turns: many(50) }, { role: 'h2', status: 'done', reply: null, turns: [T('agent', 'tiny')] }], 2_000);
  check(
    'over its share the oldest of a helper’s lines go and the last reply stays, and a small helper’s is whole (Amendment 120)',
    capped2.includes('#050#') && !capped2.includes('#001#') && /the first \d+ of 51 entries are left out to fit/.test(capped2) && capped2.includes('[h2]\nAgent: tiny') && capped2.length < 3_500,
    capped2.slice(0, 400),
  );
  check('and an 8,000-character reply is no longer cut: it is whole (Amendment 120)', helperReport([{ role: 'h', status: 'done', reply: 'q'.repeat(12_000) }], 100_000).includes('q'.repeat(12_000)));
  sdk.query = realQuery;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n17b · "allow always" rules, listed and revoked (Amendment 48)');
  {
    // §17 put the real SDK back; nothing here may start a real Claude Code.
    sdk.query = fakeQuery as typeof sdk.query;
    job('job_rules', null);
    fixture('agt_ruler', 'job_rules', { sdkSessionId: 'sess_ruler', autonomy: DEFAULT_AUTONOMY });
    const before = runs.length;
    await send('POST', '/api/agents/agt_ruler/message', { text: 'run the tests' });
    await until(() => runs.length === before + 1);
    const run = runs.at(-1);
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
    /*
     * The way the SDK asks: the hook sees every call first. A call nothing allows is
     * deferred, which ends the run; answering it resumes the agent in a new one. What
     * the hook answers is the verdict.
     */
    const hookSays = async (r: FakeRun | undefined, id: string, command: string): Promise<string | undefined> => {
      const out = (await sleepHooks(r)?.(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } } as never,
        id,
        { signal },
      )) as { hookSpecificOutput?: { permissionDecision?: string } } | undefined;
      void r?.options.canUseTool?.('Bash', { command }, { signal, toolUseID: id, suggestions: [suggestion] } as never);
      return out?.hookSpecificOutput?.permissionDecision;
    };
    const firstSaid = await hookSays(run, 'toolu_r1', 'npm test');
    await until(() => openRequestsForAgent(db, 'agt_ruler').length === 1);
    const req = openRequestsForAgent(db, 'agt_ruler')[0];
    check('with no rule, the call waits for you', firstSaid !== 'allow' && req !== undefined, String(firstSaid));
    // Held, so the answer goes straight back to the waiting call, in the same run.
    await send('POST', `/api/requests/${req?.id}/decide`, { decision: { type: 'allow_always', suggestions: [suggestion] } });
    await until(() => openRequestsForAgent(db, 'agt_ruler').length === 0);
    const resumed = run;

    // Claude Code's copy, where a localSettings destination puts it: the agent's folder.
    mkdirSync(join(ROOT, '.claude'), { recursive: true });
    const local = join(ROOT, '.claude', 'settings.local.json');
    const localText = `${JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Read'] } }, null, 2)}\n`;
    writeFileSync(local, localText);

    type RulesReply = { rules: RuleView[] };
    const listed = (await get<RulesReply>(`/api/projects/${pid}/rules`)).body.rules;
    const rule = listed.find((r) => r.toolName === 'Bash' && r.ruleContent === 'npm test:*');
    check('the rule is listed for its project', rule !== undefined, JSON.stringify(listed));
    check('with who asked', rule?.agent?.id === 'agt_ruler' && rule?.agent?.role === 'builder', JSON.stringify(rule?.agent));
    check('and when', typeof rule?.grantedAt === 'string' && !Number.isNaN(Date.parse(rule?.grantedAt ?? '')));
    check(
      "and where Claude Code keeps its own copy, found in the agent's folder",
      rule?.copy?.destination === 'localSettings' && rule?.copy?.file === local && rule?.copy?.entry === 'Bash(npm test:*)' && rule?.copy?.present === true,
      JSON.stringify(rule?.copy),
    );
    // A later call the rule covers: the hook lets it through to canUseTool, which the rule answers.
    const canUse = (id: string, command: string) =>
      resumed?.options.canUseTool?.('Bash', { command }, { signal, toolUseID: id, suggestions: [] } as never) as Promise<{ behavior: string }> | undefined;
    const again = await Promise.race([canUse('toolu_r2', 'npm test -- --watch'), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000))]);
    check('while it stands, a matching call is allowed without asking', again?.behavior === 'allow' && openRequestsForAgent(db, 'agt_ruler').length === 0, JSON.stringify(again));

    const revoked = await send<{ removed: RuleView }>('DELETE', `/api/rules/${rule?.id}`);
    check('revoking it → 200, and the reply says where the other copy is', revoked.status === 200 && revoked.body.removed.copy?.present === true && revoked.body.removed.copy?.file === local);
    check("Claude Code's file is not touched — not a byte", readFileSync(local, 'utf8') === localText);
    check('the rule is gone from the list', !(await get<RulesReply>(`/api/projects/${pid}/rules`)).body.rules.some((r) => r.id === rule?.id));
    void canUse('toolu_r3', 'npm test');
    check('and the next matching call asks again', await until(() => openRequestsForAgent(db, 'agt_ruler').length === 1));
    check('revoking it twice → 404', (await send('DELETE', `/api/rules/${rule?.id}`)).status === 404);
    check("an unknown project's rules → 404", (await get('/api/projects/prj_nope/rules')).status === 404);
    for (const r of runs) if (!r.finished) r.finish({ cost: 0, reason: 'completed' });
    rmSync(join(ROOT, '.claude'), { recursive: true, force: true });

    check('a session-only copy names no file', settingsFileFor('session', ROOT, '/c') === null);
    check("a user-settings copy is in Claude Code's own folder", settingsFileFor('userSettings', ROOT, '/c') === '/c/settings.json');
    check('a file that cannot be read is "unknown", not "absent"', fileHolds('/nope', 'Read', () => { throw new Error('x'); }) === null);
    check('`npm test:*` covers npm test and what follows it', ruleCovers('npm test:*', 'npm test') && ruleCovers('npm test:*', 'npm test -- --watch'));
    check('but not a longer word, or something else', !ruleCovers('npm test:*', 'npm tester') && !ruleCovers('npm test:*', 'rm -rf /'));
    check('a bare trailing * is a plain prefix, and no * is exact', ruleCovers('git log*', 'git log --oneline') && ruleCovers('ls', 'ls') && !ruleCovers('ls', 'ls -la'));
    check('a whole-tool rule is written as the bare tool name', ruleEntry('Read', null) === 'Read' && ruleEntry('Bash', 'ls:*') === 'Bash(ls:*)');
    check('a rule from before names no agent', describeRule(db, { id: 'x', projectId: pid, toolName: 'Read', ruleContent: null, behavior: 'allow', suggestion: null, createdAt: 'now', agentId: null }).agent === null);
    sdk.query = realQuery;
  }

  console.log('\n17c · several agents on one role, run by an orchestrator (Amendment 51)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const start = runs.length;
    const mcp = (agentId: string, method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
      send<{ result?: Record<string, unknown>; error?: { message: string } }>('POST', `/mcp/agents/${agentId}`, {
        jsonrpc: '2.0',
        ...(id !== null ? { id } : {}),
        method,
        params,
      });
    const said = (r: { body: { result?: Record<string, unknown> } }): { text: string; isError: boolean } => {
      const res = r.body.result as { content?: { text: string }[]; isError?: boolean } | undefined;
      return { text: res?.content?.[0]?.text ?? '', isError: res?.isError === true };
    };

    job('job_orch', 25);
    fixture('agt_orch', 'job_orch', { status: 'queued', helperCap: 2, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 5 } });
    sup.pump();
    await until(() => runs.length === start + 1);
    const orchRun = runs[start];
    await until(() => (orchRun?.prompts.length ?? 0) > 0);
    const server = (orchRun?.options.mcpServers as Record<string, { type: string; url: string }> | undefined)?.['conductor'];
    check('an orchestrator is given the Conductor tools, at a URL naming it', server?.type === 'http' && /\/mcp\/agents\/agt_orch$/.test(server.url), JSON.stringify(server));
    check('allowed outright, so starting a helper never asks you', HELPER_TOOLS.every((t) => orchRun?.options.allowedTools?.includes(t)));
    check('and told how to use them, and how many it may start', /start_helper/.test(orchRun?.prompts[0] ?? '') && /up to 2 helper agents/.test(orchRun?.prompts[0] ?? ''), orchRun?.prompts[0]);

    const init = await mcp('agt_orch', 'initialize', { protocolVersion: '2025-06-18' });
    check('the endpoint speaks MCP: initialize', (init.body.result?.['serverInfo'] as { name?: string } | undefined)?.name === 'conductor' && init.body.result?.['protocolVersion'] === '2025-06-18');
    const note = await fetch(`${BASE}/mcp/agents/agt_orch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    check('a notification gets 202 and no body', note.status === 202 && (await note.text()) === '');
    const listed = await mcp('agt_orch', 'tools/list');
    check('tools/list names both tools', JSON.stringify((listed.body.result?.['tools'] as { name: string }[]).map((t) => t.name)) === '["start_helper","list_helpers"]');
    check('an unknown method is an error, by the book', (await mcp('agt_orch', 'resources/list')).body.error?.message.includes('method not found') === true);

    const one = said(await mcp('agt_orch', 'tools/call', { name: 'start_helper', arguments: { task: 'Build the API.', name: 'API' } }));
    const two = said(await mcp('agt_orch', 'tools/call', { name: 'start_helper', arguments: { task: 'Build the UI.' } }));
    const three = said(await mcp('agt_orch', 'tools/call', { name: 'start_helper', arguments: { task: 'One too many.' } }));
    check('start_helper starts one, named after its part', !one.isError && /^Started builder-api\./.test(one.text), one.text);
    check('or numbered when it has no name', !two.isError && /builder-helper-2/.test(two.text), two.text);
    check('and no more than the cap', three.isError && /may start 2 helpers/.test(three.text), three.text);
    check('a task is required', said(await mcp('agt_orch', 'tools/call', { name: 'start_helper', arguments: {} })).isError);
    fixture('agt_plain', 'job_orch', { role: 'reviewer', autonomy: DEFAULT_AUTONOMY });
    check('an agent launched without helpers cannot start any', /not launched to orchestrate/.test(said(await mcp('agt_plain', 'tools/call', { name: 'start_helper', arguments: { task: 'x' } })).text));

    const helpers = helpersOf(db, 'agt_orch');
    check('the helpers are its own: same job, model and autonomy, and they know their part', helpers.length === 2 && helpers.every((h) => h.parentId === 'agt_orch' && h.jobId === 'job_orch' && h.model === 'opus' && h.autonomy.budgetUsd === 5) && getAgentBrief(db, helpers[0]!.id)?.includes('Build the API.') === true, JSON.stringify(helpers.map((h) => h.role)));
    check('queued like any agent, and they take slots', await until(() => runs.length === start + 3 && sup.slots.used === 3), `${sup.slots.used} running`);
    const listNow = said(await mcp('agt_orch', 'tools/call', { name: 'list_helpers', arguments: {} }));
    check('list_helpers says where they are', /builder-api: working/.test(listNow.text) && /builder-helper-2: working/.test(listNow.text), listNow.text);

    orchRun?.finish({ cost: 0.1, reason: 'completed' });
    await until(() => getAgent(db, 'agt_orch')?.status === 'queued');
    check('ending its turn with helpers still going, it waits for them — queued, not done', getAgent(db, 'agt_orch')?.status === 'queued' && helpers.every((h) => getAgent(db, 'agt_orch')!.dependsOn.includes(h.id)));
    check('and gives its slot back while it waits', sup.slots.used === 2, String(sup.slots.used));

    const helperRun = (id: string) => runs.slice(start + 1).find((r) => (r.prompts[0] ?? '').includes(getAgentBrief(db, id) ?? '~'));
    const said51 = (agentId: string, text: string) => eventLog().emit({ projectId: pid, jobId: 'job_orch', agentId }, { kind: 'text', text });
    said51(helpers[0]!.id, 'API done: routes in api.ts.');
    helperRun(helpers[0]!.id)?.finish({ cost: 0.2, reason: 'completed' });
    await until(() => getAgent(db, helpers[0]!.id)?.status === 'done');
    await settle(100);
    check('one helper done is not enough: it waits for all of them', getAgent(db, 'agt_orch')?.status === 'queued' && runs.length === start + 3);
    helperRun(helpers[1]!.id)?.finish({ cost: 0, reason: 'error', isError: true });
    check('when the last has ended — even failed — it starts again', await until(() => runs.length === start + 4));
    const woke = runs[start + 3];
    await until(() => (woke?.prompts.length ?? 0) > 0);
    check('in its own session', typeof woke?.options.resume === 'string' && woke.options.resume === getAgent(db, 'agt_orch')?.sdkSessionId, String(woke?.options.resume));
    check('told what each helper said, as the next agent in a stack is (Amendment 120)', (woke?.prompts[0] ?? '').includes('[builder-api]') && (woke?.prompts[0] ?? '').includes('Agent: API done: routes in api.ts.'), woke?.prompts[0]);
    check('and which one did not finish', /\[builder-helper-2 — failed, so it may not have finished its part\]/.test(woke?.prompts[0] ?? ''), woke?.prompts[0]);
    check('it no longer waits on them, and they are marked reported', getAgent(db, 'agt_orch')!.dependsOn.length === 0 && unreportedHelpers(db, 'agt_orch').length === 0);
    woke?.finish({ cost: 0, reason: 'completed' });
    check('its next turn ends done: nothing left to hear from', await until(() => getAgent(db, 'agt_orch')?.status === 'done'));
    check('the job holds all three agents, and its cap counts each', agentsForJob(db, 'job_orch').filter((a) => a.id !== 'agt_plain').length === 3);
    const badHelpers = await send('POST', '/api/jobs', { projectId: pid, prompt: 'x', isolation: 'in_place', agents: [{ role: 'builder', model: OPUS, helpers: 9, autonomy: DEFAULT_AUTONOMY }] });
    check('a job asking for more than 8 helpers → 400', badHelpers.status === 400);
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    sdk.query = realQuery;
  }

  console.log('\n17d · a restart resumes what it interrupted (Amendment 53)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const start = runs.length;
    job('job_restart', null);
    fixture('agt_cut', 'job_restart', { status: 'working', sdkSessionId: 'sess_cut', autonomy: DEFAULT_AUTONOMY });
    fixture('agt_fresh', 'job_restart', { status: 'working', sdkSessionId: null, autonomy: DEFAULT_AUTONOMY });
    fixture('agt_capped53', 'job_restart', { status: 'working', sdkSessionId: 'sess_capped53', costUsd: 50, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } });
    check('reconcile queues every agent a restart left working', sup.reconcile() >= 3 && ['agt_cut', 'agt_fresh', 'agt_capped53'].every((id) => getAgent(db, id)?.status === 'queued'));
    sup.pump();
    check('pump resumes them, with no click', await until(() => runs.length === start + 2));
    const cut = runs.slice(start).find((r) => r.options.resume === 'sess_cut');
    await until(() => (cut?.prompts.length ?? 0) > 0);
    check('in its own session, told a restart stopped it', cut?.prompts[0] === RESTART_NUDGE, JSON.stringify(cut?.prompts));
    const fresh = runs.slice(start).find((r) => !r.options.resume);
    await until(() => (fresh?.prompts.length ?? 0) > 0);
    check('one that had no session yet starts from its prompt', (fresh?.prompts[0] ?? '').includes('the job_restart prompt'), fresh?.prompts[0]);
    check('one already at its ceiling (twice its budget) is paused, not run', getAgent(db, 'agt_capped53')?.status === 'paused' && !runs.slice(start).some((r) => r.options.resume === 'sess_capped53'));
    cut?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'agt_cut')?.status === 'done');
    await send('POST', '/api/agents/agt_cut/message', { text: 'one more thing' });
    check('told once: its next run is ordinary', await until(() => runs.length === start + 3) && runs.at(-1)?.prompts[0] === 'one more thing', JSON.stringify(runs.at(-1)?.prompts));
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log('\n17e · notes on a project (Amendment 55)');
  {
    type NoteReply = { note?: ProjectNote; project?: Project; error?: string };
    const notes = `/api/projects/${pid}/notes`;
    const eyes = await connect();
    check('a note needs text → 400', (await send<NoteReply>('POST', notes, { text: '   ' })).status === 400);
    check('and no more than the limit', (await send<NoteReply>('POST', notes, { text: 'x'.repeat(4001) })).status === 400);
    check("an unknown project's notes → 404", (await send<NoteReply>('POST', '/api/projects/prj_nope/notes', { text: 'hi' })).status === 404);
    const first = await send<NoteReply>('POST', notes, { text: '  Left off: the parser handles quotes. Next: escapes.  ' });
    check('creating one → 201, trimmed, and the project carries it', first.status === 201 && first.body.note?.text === 'Left off: the parser handles quotes. Next: escapes.' && first.body.project?.notes?.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    const second = await send<NoteReply>('POST', notes, { text: 'Blocked on the API key.' });
    check('newest first: the last one written is where you are', second.body.project?.notes?.map((n) => n.text).join(' | ') === 'Blocked on the API key. | Left off: the parser handles quotes. Next: escapes.');
    await settle();
    check('every browser hears it, notes and all', eyes.frames.some((f) => f.type === 'entities' && (f.projects ?? []).some((p) => p.id === pid && p.notes?.length === 2)));
    check('GET /api/projects carries them too', (await get<{ projects: Project[] }>('/api/projects')).body.projects.find((p) => p.id === pid)?.notes?.length === 2);
    const id = first.body.note!.id;
    const edited = await send<NoteReply>('PATCH', `${notes}/${id}`, { text: 'Escapes done too.' });
    check('changing one keeps when it was written, and says when it changed', edited.status === 200 && edited.body.note?.text === 'Escapes done too.' && edited.body.note?.createdAt === first.body.note?.createdAt && edited.body.note!.updatedAt >= edited.body.note!.createdAt);
    check('an empty change is refused — delete it instead', (await send<NoteReply>('PATCH', `${notes}/${id}`, { text: '' })).status === 400);
    check("a note is changed only through its own project", (await send<NoteReply>('PATCH', `/api/projects/prj_other/notes/${id}`, { text: 'x' })).status === 404);
    const gone = await send<NoteReply>('DELETE', `${notes}/${id}`);
    check('deleting one → 200, and it is gone', gone.status === 200 && gone.body.project?.notes?.length === 1 && gone.body.project.notes[0]?.text === 'Blocked on the API key.');
    check('deleting it twice → 404', (await send<NoteReply>('DELETE', `${notes}/${id}`)).status === 404);
    await send('DELETE', `${notes}/${second.body.note!.id}`);
    check('with none left, the project has no notes field, as before', !('notes' in ((await get<{ projects: Project[] }>('/api/projects')).body.projects.find((p) => p.id === pid) ?? {})));
    eyes.close();
  }

  console.log('\n17f · a terminal in an agent\'s folder (Amendment 58)');
  {
    job('job_term', null);
    fixture('agt_term', 'job_term', { autonomy: DEFAULT_AUTONOMY });
    const term = '/api/agents/agt_term/terminal';
    const eyes = await connect();
    type RunReply = { run?: TerminalRun; error?: string };
    check('no command → 400', (await send<RunReply>('POST', term, { command: '  ' })).status === 400);
    check("an unknown agent's terminal → 404", (await send<RunReply>('POST', '/api/agents/agt_nope/terminal', { command: 'ls' })).status === 404);
    const ran = await send<RunReply>('POST', term, { command: 'echo hello; echo oops >&2; pwd; exit 3' });
    check('a command runs → 201, in the agent\'s folder', ran.status === 201 && ran.body.run?.cwd === ROOT, JSON.stringify(ran.body));
    const ended = () => eyes.frames.some((f) => f.type === 'terminal_run' && f.run.id === ran.body.run?.id && f.run.endedAt !== null);
    check('and ends', await until(ended));
    const end = eyes.frames.find((f): f is Extract<ServerFrame, { type: 'terminal_run' }> => f.type === 'terminal_run' && f.run.id === ran.body.run?.id && f.run.endedAt !== null);
    check('with its exit code', end?.run.exitCode === 3, JSON.stringify(end?.run));
    const out = eyes.frames.flatMap((f) => (f.type === 'terminal_out' && f.runId === ran.body.run?.id ? [f] : []));
    check('its output reaches every tab, stdout and stderr apart', out.some((f) => f.stream === 'out' && f.text.includes('hello')) && out.some((f) => f.stream === 'err' && f.text.includes('oops')));
    check('it ran where the agent works', out.some((f) => f.stream === 'out' && realpathSync(f.text.trim().split('\n').at(-1) ?? '.') === realpathSync(ROOT)), JSON.stringify(out.map((f) => f.text)));
    const hist = (await get<{ runs: (TerminalRun & { output: { stream: string; text: string }[] })[] }>(term)).body.runs;
    check('and is kept, so a reload shows it', hist.length === 1 && hist[0]!.output.map((c) => c.text).join('').includes('hello'));
    check('Conductor\'s token is not in its environment', (await (async () => {
      process.env['CONDUCTOR_TOKEN'] = 'secret-for-verify';
      const r = await send<RunReply>('POST', term, { command: 'echo "[${CONDUCTOR_TOKEN:-none}]"' });
      delete process.env['CONDUCTOR_TOKEN'];
      await until(() => eyes.frames.some((f) => f.type === 'terminal_run' && f.run.id === r.body.run?.id && f.run.endedAt !== null));
      return eyes.frames.some((f) => f.type === 'terminal_out' && f.runId === r.body.run?.id && f.text.includes('[none]'));
    })()));
    const long = await send<RunReply>('POST', term, { command: 'sleep 30' });
    check('one at a time: another while it runs → 409', (await send<RunReply>('POST', term, { command: 'ls' })).status === 409);
    const stopped = await send<RunReply>('POST', `/api/terminal/${long.body.run?.id}/stop`);
    check('stop → it ends, by a signal', stopped.status === 200 && (await until(() => eyes.frames.some((f) => f.type === 'terminal_run' && f.run.id === long.body.run?.id && f.run.signal !== null))));
    const prompt = await send<RunReply>('POST', term, { command: 'read x && echo "got [$x]" || echo "no input"' });
    await until(() => eyes.frames.some((f) => f.type === 'terminal_run' && f.run.id === prompt.body.run?.id && f.run.endedAt !== null));
    check('a prompt reads end-of-file instead of hanging', eyes.frames.some((f) => f.type === 'terminal_out' && f.runId === prompt.body.run?.id && f.text.includes('no input')));
    const big = await send<RunReply>('POST', term, { command: 'head -c 400000 /dev/zero | tr "\\0" x' });
    await until(() => eyes.frames.some((f) => f.type === 'terminal_run' && f.run.id === big.body.run?.id && f.run.endedAt !== null));
    const bigRun = (await get<{ runs: (TerminalRun & { output: { text: string }[] })[] }>(term)).body.runs.find((r) => r.id === big.body.run?.id);
    check('output past the cap is dropped, and it says so', bigRun?.cut === true && bigRun.output.reduce((n, c) => n + c.text.length, 0) === 256 * 1024);
    check('clear forgets them', (await send('DELETE', term)).status === 200 && (await get<{ runs: unknown[] }>(term)).body.runs.length === 0);
    check('stopping one that is gone → 404', (await send('POST', '/api/terminal/term_nope/stop')).status === 404);
    eyes.close();
  }

  console.log('\n17g · a daily budget, warned about in Needs You (Amendment 59)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const eyes = await connect();
    const setBudget = (v: unknown) => send('PATCH', '/api/settings', { settings: { 'conductor.dailyBudget': v } });
    check('a budget that is not dollars → 400', (await setBudget('0')).status === 400 && (await setBudget('lots')).status === 400);
    const spentNow = costToday(db);
    check('a good one is taken', (await setBudget(String(spentNow + 1))).status === 200);
    const dailyAlerts = async () => (await get<Snapshot>('/api/snapshot')).body.alerts.filter((a) => a.kind === 'daily_budget');
    check('under it, no alert', (await dailyAlerts()).length === 0);
    job('job_daily', null);
    fixture('agt_spender', 'job_daily', { status: 'queued', autonomy: DEFAULT_AUTONOMY });
    const start = runs.length;
    sup.pump();
    await until(() => runs.length === start + 1);
    runs[start]!.finish({ cost: 2, reason: 'completed' });
    check('a run that spends tells every tab today\'s spend', await until(() => eyes.frames.some((f) => f.type === 'cost' && near(f.costToday, spentNow + 2))), JSON.stringify(eyes.frames.filter((f) => f.type === 'cost')));
    const over = await dailyAlerts();
    check('reaching it is an alert, with the spend and the budget', over.length === 1 && near(over[0]!.spent, spentNow + 2) && near(over[0]!.budget, spentNow + 1), JSON.stringify(over));
    check('and every tab hears it', eyes.frames.some((f) => f.type === 'alerts' && f.alerts.some((a) => a.kind === 'daily_budget')));
    check('it warns only: nothing is paused', getAgent(db, 'agt_spender')?.status === 'done');
    check("one a day: its id is today's", over[0]!.id === `daily:${localDay()}`);
    await setBudget(String(spentNow + 100));
    check('raising the budget above the spend clears it', (await dailyAlerts()).length === 0);
    const mark = eyes.frames.length;
    addCostToday(db, 150);
    costChanged();
    check('spend that grows with no other event still raises it for every tab', await until(() => eyes.frames.slice(mark).some((f) => f.type === 'alerts' && f.alerts.some((x) => x.kind === 'daily_budget'))));
    await setBudget(null);
    check('and with none set there is nothing to reach', (await dailyAlerts()).length === 0);
    eyes.close();
    sdk.query = realQuery;
  }

  console.log('\n17h · notes can be due, and done (Amendment 63)');
  {
    type NoteReply = { note?: ProjectNote; project?: Project; error?: string };
    const notes = `/api/projects/${pid}/notes`;
    const day = (offset: number): string => localDay(new Date(Date.now() + offset * 86_400_000));
    const today = localDay();
    const dueAlerts = async () => (await get<Snapshot>('/api/snapshot')).body.alerts.filter((a) => a.kind === 'note_due');
    check('a due date that is not one → 400', (await send<NoteReply>('POST', notes, { text: 'x', due: '2026-02-30' })).status === 400 && (await send<NoteReply>('POST', notes, { text: 'x', due: 'tomorrow' })).status === 400);
    const later = await send<NoteReply>('POST', notes, { text: 'Ship it', due: day(3) });
    check('a note is made with its due date', later.status === 201 && later.body.note?.due === day(3));
    check('not due yet, nothing in Needs You', (await dueAlerts()).length === 0);
    const eyes63 = await connect();
    const late = await send<NoteReply>('POST', notes, { text: 'Reply to review', due: day(-2) });
    check('every tab hears a note fall due', await until(() => eyes63.frames.some((f) => f.type === 'alerts' && f.alerts.some((x) => x.noteId === late.body.note?.id))));
    eyes63.close();
    const now = await send<NoteReply>('POST', notes, { text: 'Standup notes', due: today });
    const open = await dueAlerts();
    check('due today and late both reach Needs You, one each', open.length === 2, JSON.stringify(open.map((a) => a.noteText)));
    check('a late one says so, with its date and text', open.some((a) => a.noteId === late.body.note?.id && a.late === true && a.due === day(-2) && a.noteText === 'Reply to review'));
    check('and today\'s is not late', open.some((a) => a.noteId === now.body.note?.id && a.late === false));
    check('their ids carry today, so a dismissal lasts the day', open.every((a) => a.id.endsWith(`:${today}`)));
    const ticked = await send<NoteReply>('PATCH', `${notes}/${late.body.note!.id}`, { done: true });
    check('ticking one done keeps it, with when', ticked.status === 200 && typeof ticked.body.note?.doneAt === 'string' && ticked.body.note.text === 'Reply to review');
    check('and it stops nagging', !(await dueAlerts()).some((a) => a.noteId === late.body.note?.id));
    const unticked = await send<NoteReply>('PATCH', `${notes}/${late.body.note!.id}`, { done: false });
    check('un-ticking brings it back', !('doneAt' in (unticked.body.note ?? {})) && (await dueAlerts()).some((a) => a.noteId === late.body.note?.id));
    await send('PATCH', `${notes}/${now.body.note!.id}`, { due: null });
    check('clearing a date clears its alert, and changes nothing else', !(await dueAlerts()).some((a) => a.noteId === now.body.note?.id) && (await get<{ projects: Project[] }>('/api/projects')).body.projects.find((p) => p.id === pid)?.notes?.find((n) => n.id === now.body.note?.id)?.text === 'Standup notes');
    check('a patch that says nothing → 400', (await send('PATCH', `${notes}/${now.body.note!.id}`, {})).status === 400);
    check('done must be true or false', (await send('PATCH', `${notes}/${now.body.note!.id}`, { done: 'yes' })).status === 400);
    for (const n of [later, late, now]) await send('DELETE', `${notes}/${n.body.note!.id}`);
    check('deleting them clears them from Needs You', (await dueAlerts()).length === 0);
  }

  console.log('\n17i · what the guardrails allow, Claude Code is not asked about (Amendment 67)');
  {
    job('job_guard', null);
    const shellOn = { ...DEFAULT_AUTONOMY, mode: 'auto' as const, allowedTools: ['Read', 'Bash'] };
    fixture('agt_shell', 'job_guard', { status: 'working', autonomy: shellOn });
    fixture('agt_mcp', 'job_guard', { status: 'working', autonomy: { ...DEFAULT_AUTONOMY, allowedTools: ['Read', 'mcp__*'] } });
    fixture('agt_asks', 'job_guard', { status: 'working', autonomy: { ...DEFAULT_AUTONOMY, allowedTools: ['Read'] } });
    const within = <T,>(p: Promise<T>, ms = 1500): Promise<T | 'pending'> =>
      Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
    const ask = (agentId: string, toolName: string, input: Record<string, unknown>, id: string, suggestions?: unknown[]) =>
      arbiter().requestPermission({ agentId, toolName, toolUseId: id, input, ...(suggestions ? { suggestions: suggestions as never } : {}) });

    const flagged = await within(ask('agt_shell', 'Bash', { command: 'cd repo && git log -1' }, 'toolu_g1'));
    check('shell on: a command Claude Code flagged is allowed, not queued', typeof flagged === 'object' && flagged.behavior === 'allow' && openRequestsForAgent(db, 'agt_shell').length === 0, JSON.stringify(flagged));
    check('and the transcript says the guardrail allowed it', eventLog().forAgent('agt_shell').some((e) => e.payload.kind === 'resolved' && e.payload.decision.by === 'rule' && e.payload.decision.note === 'run shell unattended'));
    const other = await within(ask('agt_shell', 'Write', { file_path: 'x' }, 'toolu_g2'));
    check('but only the shell: another tool still asks', other === 'pending' && openRequestsForAgent(db, 'agt_shell').length === 1);
    const mcp = await within(ask('agt_mcp', 'mcp__lucid__search', { query: 'x' }, 'toolu_g3'));
    check('MCP tools on: an MCP tool is allowed', typeof mcp === 'object' && mcp.behavior === 'allow');
    const mcpShell = await within(ask('agt_mcp', 'Bash', { command: 'ls' }, 'toolu_g4'));
    check('and that does not let the shell through', mcpShell === 'pending');

    const asked = await within(ask('agt_asks', 'Bash', { command: 'cd repo && git status' }, 'toolu_g5', []));
    const req = openRequestsForAgent(db, 'agt_asks')[0];
    check('shell off: it asks, as before', asked === 'pending' && req !== undefined);
    check("and when Claude Code sent no rule, Conductor offers the exact command, so allow-all-session isn't greyed out", JSON.stringify(req?.suggestions) === JSON.stringify([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cd repo && git status' }], behavior: 'allow', destination: 'session' }]), JSON.stringify(req?.suggestions));
    await send('POST', `/api/requests/${req?.id}/decide`, { decision: { type: 'allow_always', suggestions: req?.suggestions ?? [] } });
    const again = await within(ask('agt_asks', 'Bash', { command: 'cd repo && git status' }, 'toolu_g6'));
    check('allowed always, the same command runs without asking next time', typeof again === 'object' && again.behavior === 'allow');
    const different = await within(ask('agt_asks', 'Bash', { command: 'cd repo && git push' }, 'toolu_g7'));
    check('but only that command', different === 'pending');
    check('a question gets no rule to always allow', fallbackSuggestions('AskUserQuestion', {}).length === 0 && fallbackSuggestions('mcp__x__y', {})[0]?.['rules'] !== undefined);
    check('the guard rule, by itself', allowedUnattended(['Bash'], 'Bash') === 'run shell unattended' && allowedUnattended(['Read'], 'Bash') === null && allowedUnattended(['mcp__*'], 'mcp__a__b') === 'allow MCP tools' && allowedUnattended(['mcp__*'], 'Bash') === null);
    for (const r of openRequests(db)) if (['agt_shell', 'agt_mcp', 'agt_asks'].includes(r.agentId)) await send('POST', `/api/requests/${r.id}/decide`, { decision: { type: 'deny', message: 'verify' } });
  }

  console.log("\n17j · a persona's system prompt and skills reach the SDK, on every run (Amendment 68)");
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const start = runs.length;
    const PROMPT68 = 'You review for security first. Name the threat before the fix.';
    type Made = { agents?: Agent[]; error?: string; detail?: string };
    const made = await send<Made>('POST', '/api/jobs', {
      projectId: pid,
      prompt: 'the persona prompt',
      isolation: 'in_place',
      agents: [
        { role: 'reviewer', model: OPUS, brief: 'Review it.', autonomy: DEFAULT_AUTONOMY, persona: 'reviewer', systemPrompt: `  ${PROMPT68}  `, skills: ['pdf', ' docx ', 'pdf'] },
        { role: 'builder', model: OPUS, brief: 'Build it.', autonomy: DEFAULT_AUTONOMY },
      ],
    });
    check('a job whose spec carries a persona → 201', made.status === 201, `${made.status} ${made.body.detail ?? ''}`);
    const withId = made.body.agents?.find((a) => a.role === 'reviewer')?.id ?? '~';
    const plainId = made.body.agents?.find((a) => a.role === 'builder')?.id ?? '~';
    const stored = getAgentPersona(db, withId);
    check(
      'the agent keeps them: the persona by id, the prompt trimmed, the skills without repeats',
      stored.persona === 'reviewer' && stored.systemPrompt === PROMPT68 && JSON.stringify(stored.skills) === '["pdf","docx"]',
      JSON.stringify(stored),
    );
    check('on the row, not the wire: the Agent the browser gets is the same shape as before', !Object.keys(getAgent(db, withId) ?? {}).some((k) => ['persona', 'systemPrompt', 'skills'].includes(k)));
    check('an agent without one stores nothing', JSON.stringify(getAgentPersona(db, plainId)) === '{"persona":null,"systemPrompt":null,"skills":null}');

    await until(() => runs.length === start + 2);
    await until(() => runs.slice(start).every((r) => r.prompts.length > 0));
    const runFor = (role: string) => runs.slice(start).find((r) => (r.prompts[0] ?? '').includes(`Your role is ${role}.`));
    const first = runFor('reviewer');
    const plain = runFor('builder');
    check(
      "its system prompt is appended to Claude Code's own",
      JSON.stringify(first?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: `${PROMPT68}\n\n${TURN_END_LINE}` }),
      JSON.stringify(first?.options.systemPrompt),
    );
    check('and its skills are the ones passed', JSON.stringify(first?.options.skills) === '["pdf","docx"]', JSON.stringify(first?.options.skills));
    check('an agent without a persona gets only the turn-end line (Amendment 133), and no skills', plain !== undefined && JSON.stringify(plain.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: TURN_END_LINE }) && !('skills' in plain.options), JSON.stringify(plain?.options.systemPrompt));

    first?.finish({ cost: 0, reason: 'completed' });
    plain?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, withId)?.status === 'done' && getAgent(db, plainId)?.status === 'done');
    const before = runs.length;
    await send('POST', `/api/agents/${withId}/message`, { text: 'and the auth module' });
    check('a message to it resumes it', await until(() => runs.length === before + 1));
    const resumed = runs.at(-1);
    check('in its own session', typeof resumed?.options.resume === 'string' && resumed.options.resume === getAgent(db, withId)?.sdkSessionId, String(resumed?.options.resume));
    check(
      'carrying its system prompt and skills again',
      JSON.stringify(resumed?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: `${PROMPT68}\n\n${TURN_END_LINE}` }) && JSON.stringify(resumed?.options.skills) === '["pdf","docx"]',
      JSON.stringify({ systemPrompt: resumed?.options.systemPrompt, skills: resumed?.options.skills }),
    );
    resumed?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, withId)?.status === 'done');
    await send('POST', `/api/agents/${plainId}/message`, { text: 'one more thing' });
    check('and a resume of one without stays without: only the turn-end line, and no skills', await until(() => runs.length === before + 2) && JSON.stringify(runs.at(-1)?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: TURN_END_LINE }) && !('skills' in (runs.at(-1)?.options ?? {})));
    runs.at(-1)?.finish({ cost: 0, reason: 'completed' });
    await until(() => sup.slots.used === 0);

    const orch = await send<Made>('POST', '/api/jobs', {
      projectId: pid,
      prompt: 'the persona orchestrator prompt',
      isolation: 'in_place',
      agents: [{ role: 'builder', model: OPUS, helpers: 1, autonomy: DEFAULT_AUTONOMY, persona: 'builder', systemPrompt: PROMPT68, skills: ['pdf'] }],
    });
    const orchId = orch.body.agents?.[0]?.id ?? '~';
    await until(() => getAgent(db, orchId)?.status === 'working');
    const helper = sup.startHelper(orchId, 'Check the API.');
    check('a helper runs as its orchestrator\'s persona', JSON.stringify(getAgentPersona(db, helper.id)) === JSON.stringify({ persona: 'builder', systemPrompt: PROMPT68, skills: ['pdf'] }), JSON.stringify(getAgentPersona(db, helper.id)));
    const helperRun = await until(() => runs.some((r) => (r.prompts[0] ?? '').includes('Check the API.')))
      ? runs.find((r) => (r.prompts[0] ?? '').includes('Check the API.'))
      : undefined;
    check('and launches with it', JSON.stringify(helperRun?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: `${PROMPT68}\n\n${TURN_END_LINE}` }) && JSON.stringify(helperRun?.options.skills) === '["pdf"]');
    for (let i = 0; i < 4; i += 1) {
      for (const r of runs) if (!r.finished) r.finish({ cost: 0, reason: 'completed' });
      await settle(100);
    }
    await until(() => sup.slots.used === 0);

    const bad = async (spec: Record<string, unknown>): Promise<{ status: number; detail: string }> => {
      const r = await send<Made>('POST', '/api/jobs', { projectId: pid, prompt: 'x', isolation: 'in_place', agents: [{ role: 'builder', model: OPUS, autonomy: DEFAULT_AUTONOMY, ...spec }] });
      return { status: r.status, detail: r.body.detail ?? '' };
    };
    const badId = await bad({ persona: 'Not An Id' });
    check('a persona that is not an id → 400, saying what one is', badId.status === 400 && /persona is an id/.test(badId.detail), badId.detail);
    check('nor one longer than 60', (await bad({ persona: 'a'.repeat(61) })).status === 400);
    const long = await bad({ systemPrompt: 'x'.repeat(20_001) });
    check('a system prompt over 20,000 characters → 400', long.status === 400 && /at most 20000 characters/.test(long.detail), long.detail);
    check('a system prompt that is not text → 400', (await bad({ systemPrompt: 42 })).status === 400);
    const notList = await bad({ skills: 'pdf' });
    check('skills that are not a list → 400', notList.status === 400 && /skills must be an array/.test(notList.detail), notList.detail);
    check('a skill that is not a name → 400', (await bad({ skills: ['pdf', 7] })).status === 400 && (await bad({ skills: ['x'.repeat(101)] })).status === 400);
    check('more than 50 skills → 400', (await bad({ skills: Array.from({ length: 51 }, (_, i) => `s${i}`) })).status === 400);
    check('exactly 20,000 characters and 50 skills are fine', (await bad({ systemPrompt: 'x'.repeat(20_000), skills: Array.from({ length: 50 }, (_, i) => `s${i}`) })).status === 201);
    for (let i = 0; i < 2; i += 1) {
      for (const r of runs) if (!r.finished) r.finish({ cost: 0, reason: 'completed' });
      await settle(100);
    }
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log('\n17k · each agent has a provider; claude by default (Amendment 74)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    const start = runs.length;
    const spec = { role: 'builder', model: OPUS, autonomy: DEFAULT_AUTONOMY };
    const made = await send<{ agents?: Agent[]; error?: string; detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p74', isolation: 'in_place', agents: [spec] });
    const id74 = made.body.agents?.[0]?.id ?? '';
    check('a spawn that names no provider runs on claude', made.status === 201 && getAgentProvider(db, id74) === 'claude', JSON.stringify(made.body).slice(0, 200));
    check("and a claude agent's wire shape is what it was: no provider field", made.body.agents?.[0] !== undefined && !('provider' in made.body.agents[0]!));
    check('it runs on the Claude engine, as before', await until(() => runs.length > start));
    const bad = await send<{ error?: string; detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p', isolation: 'in_place', agents: [{ ...spec, provider: 'gemini' }] });
    check('an unknown provider → 400, naming the ones there are', bad.status === 400 && /unknown provider "gemini" — one of claude, copilot, openrouter/.test(bad.body.detail ?? ''), JSON.stringify(bad.body));
    const notYet = await send<{ error?: string; detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p', isolation: 'in_place', agents: [{ ...spec, provider: 'copilot' }] });
    // Copilot has an engine since Amendment 76; with no login it still can't launch, and says so.
    check("a provider that can't launch now → 400, saying why, rather than failing mid-run", notYet.status === 400 && /GitHub Copilot/.test(notYet.body.detail ?? ''), JSON.stringify(notYet.body));
    const listed = (await get<{ providers: ProviderInfo[] }>('/api/providers')).body.providers;
    check('GET /api/providers lists all three, claude ready with every capability', listed.map((p) => p.id).join() === 'claude,copilot,openrouter' && listed[0]!.unavailable === null && Object.values(listed[0]!.capabilities).every(Boolean));
    check('and the others say why not', listed.slice(1).every((p) => typeof p.unavailable === 'string'));
    check('the old import path still gives the Claude engine', typeof AgentRunner === 'function' && AgentRunner === ClaudeBackend);
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log('\n17l · the Copilot backend: copilot and openrouter (Amendment 76)');
  {
    // ── the tool-name map: one set of translate functions for both engines ──
    const claudeIn = { file_path: join(ROOT, 'a.ts'), old_string: 'x', new_string: 'y' };
    const same = normaliseTool('Edit', claudeIn);
    check('a Claude call passes through the map untouched — the same name, the same input object', same.tool === 'Edit' && same.input === claudeIn);
    check(
      "and Claude's labels, writes, edits and todos are what they were",
      toolLabel('Bash', { command: 'ls  -la' }) === 'Bash · ls -la' &&
        toolLabel('Read', { file_path: join(ROOT, 'README.md') }, ROOT) === 'Read README.md' &&
        isWriteTool('Write') && isWriteTool('Edit') && !isWriteTool('Read') &&
        fileEditFromTool('Edit', claudeIn, ROOT)?.added === 1 &&
        todoFromInput({ todos: [{ content: 'a', status: 'completed' }] })?.items[0]?.state === 'done',
    );
    check(
      "Copilot's names become Claude's: bash, view, edit, str_replace_editor, create, update_todo, ask_user, grep, glob, web_fetch, task",
      ['bash', 'view', 'edit', 'str_replace_editor', 'create', 'update_todo', 'ask_user', 'grep', 'glob', 'web_fetch', 'task']
        .map((t) => normaliseTool(t, {}).tool)
        .join() === 'Bash,Read,Edit,Edit,Write,TodoWrite,AskUserQuestion,Grep,Glob,WebFetch,Task',
    );
    check(
      'and so do their inputs: path, old_str/new_str, file_text',
      toolLabel('view', { path: join(ROOT, 'README.md') }, ROOT) === 'Read README.md' &&
        toolLabel('bash', { command: 'npm test' }) === 'Bash · npm test' &&
        isWriteTool('create') && isWriteTool('edit') && !isWriteTool('view') &&
        JSON.stringify(fileEditFromTool('edit', { path: join(ROOT, 'a.ts'), old_str: 'a', new_str: 'b\nc' }, ROOT)) ===
          JSON.stringify({ kind: 'file_edit', path: 'a.ts', added: 2, removed: 1, source: 'tool' }) &&
        fileEditFromTool('create', { path: join(ROOT, 'n.ts'), file_text: 'a\nb\nc\n' }, ROOT)?.added === 3 &&
        normaliseTool('str_replace_editor', { command: 'view', path: 'x' }).tool === 'Read' &&
        reversibility('bash', { command: 'rm -rf dist' }).value === false,
    );
    const todo = todoFromInput(normaliseTool('update_todo', { todos: '# plan\n- [x] read it\n- [~] fix it\n- [ ] test it\nnot an item' }).input);
    check("update_todo's markdown checklist is the todo panel's list", JSON.stringify(todo?.items) === JSON.stringify([
      { text: 'read it', state: 'done' }, { text: 'fix it', state: 'active' }, { text: 'test it', state: 'pending' },
    ]), JSON.stringify(todo));

    // ── rules, and the gate that applies them ──
    check(
      'a deny pattern finds its command anywhere in a shell line; an allow pattern must cover all of it',
      toolRuleFor(['Bash(git push:*)'], 'Bash', { command: 'cd x && FOO=1 git push origin main' }, 'deny') === 'Bash(git push:*)' &&
        toolRuleFor(['Bash(git push:*)'], 'Bash', { command: 'git pushy' }, 'deny') === null &&
        toolRuleFor(['Bash(npm test:*)'], 'Bash', { command: 'npm test 2>&1 | tee log' }, 'allow') === null &&
        toolRuleFor(['Bash(npm test:*)'], 'Bash', { command: 'npm test && rm -rf /' }, 'allow') === null &&
        toolRuleFor(['Bash(npm test:*)'], 'Bash', { command: 'npm test -- --watch' }, 'allow') === 'Bash(npm test:*)' &&
        toolRuleFor(['mcp__gh'], 'mcp__gh__create_pr', {}, 'deny') === 'mcp__gh',
    );
    const where = { worktreePath: ROOT };
    const gate = (mode: Agent['autonomy']['mode'], tool: string, input: Record<string, unknown>, extra: Partial<Agent['autonomy']> = {}) =>
      gateCall({ ...DEFAULT_AUTONOMY, mode, ...extra }, tool, input, where).kind;
    check(
      'a disallowed tool is refused in every mode, bypassPermissions included',
      (['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'] as const).every(
        (m) => gate(m, 'Bash', { command: 'git push' }, { disallowedTools: ['Bash(git push:*)'] }) === 'deny' &&
          gate(m, 'Write', { file_path: 'x' }, { disallowedTools: ['Write'] }) === 'deny',
      ),
    );
    check(
      "and the modes mean what they mean for Claude: bypass runs, acceptEdits edits in its folders, plan only reads, dontAsk doesn't ask",
      gate('bypassPermissions', 'Bash', { command: 'rm -rf x' }) === 'allow' &&
        gate('default', 'Read', { file_path: join(ROOT, 'README.md') }) === 'allow' &&
        gate('default', 'Read', { file_path: '/etc/hosts' }) === 'ask' &&
        gate('acceptEdits', 'Edit', { file_path: join(ROOT, 'a.ts') }) === 'allow' &&
        gate('acceptEdits', 'Edit', { file_path: '/etc/hosts' }) === 'ask' &&
        gate('plan', 'Edit', { file_path: 'a.ts' }) === 'deny' &&
        gate('dontAsk', 'Bash', { command: 'ls' }) === 'deny' &&
        gate('default', 'Bash', { command: 'npm test' }, { allowedTools: ['Bash(npm test:*)'] }) === 'allow' &&
        gate('default', 'Bash', { command: 'ls' }) === 'ask',
    );
    {
      // A reading role's shell on an engine that applies no rules itself (Amendment 148).
      const reader = { allowedTools: ['Read', 'Glob', 'Grep', ...READ_ONLY_BASH], disallowedTools: ['WebFetch', 'WebSearch', 'Bash(git push:*)', ...WRITE_TOOLS, ...READ_ONLY_BASH_DENIED] };
      const runs = (command: string) => gate('default', 'Bash', { command }, reader);
      check(
        "a reading role's read-only commands run unasked, alone or piped together",
        ['git status --short', 'git diff --stat main...HEAD', 'git log --oneline -5 | head -3', 'git show HEAD:src/a.ts', 'git blame -L 1,20 src/a.ts',
          'grep -rn "x" src | wc -l', 'cat a.ts', 'tail -n 20 log.txt', 'ls -la', 'diff a.ts b.ts', 'stat a.ts', 'pwd', 'grep -rn x . 2>/dev/null', 'git diff 2>&1 | head'].every((c) => runs(c) === 'allow'),
        JSON.stringify(['git status --short', 'cat a.ts', 'pwd', 'grep -rn x . 2>/dev/null'].map((c) => [c, runs(c)])),
      );
      check(
        'anything else asks: a redirect into a file, a command not on the list, one that is part of a line',
        ['cat a.ts > b.ts', 'git diff >> out.patch', 'grep x a &> out', "sed -n '1w out' a.ts", 'find . -delete', 'rg --pre ./x y', 'sort -o out a',
          'git checkout main', 'git stash', 'make test', 'cd src && git diff', 'git status; rm -rf x', 'pwd -P', 'cat a | tee b'].every((c) => runs(c) === 'ask'),
        JSON.stringify(['cat a.ts > b.ts', 'cd src && git diff', 'pwd -P'].map((c) => [c, runs(c)])),
      );
      check(
        "and git's --output, wherever it is on the line, is refused",
        runs('git diff --output=x.patch') === 'deny' && runs('git diff --stat --output=x') === 'deny' && runs('git log -1 --output x') === 'deny' &&
          runs('git show HEAD --output=y') === 'deny' && runs('git log --oneline | head -1; git diff --output=z') === 'deny',
      );
      check(
        "a deny's * matches anywhere, an allow's only at the end: an allow-always saved as `rm *.o` stays exact",
        toolRuleFor(['Bash(git diff *--output*)'], 'Bash', { command: 'git diff --output=x' }, 'deny') !== null &&
          toolRuleFor(['Bash(git diff *--output*)'], 'Bash', { command: 'git diff --stat' }, 'deny') === null &&
          toolRuleFor(['Bash(rm *.o)'], 'Bash', { command: 'rm -rf / x.o' }, 'allow') === null &&
          toolRuleFor(['Bash(rm *.o)'], 'Bash', { command: 'rm *.o' }, 'allow') === 'Bash(rm *.o)',
      );
      check('a writing role without the shell pill still asks for every command', gate('default', 'Bash', { command: 'git status' }) === 'ask');
    }
    check('whole-tool disallows are kept from the model too, where the names map one to one', excludedFor(['Bash', 'Edit', 'Bash(git push:*)']).join() === 'bash,powershell,edit');
    check(
      'a permission request is named for the Claude call it is',
      JSON.stringify(askFromPermission({ kind: 'shell', fullCommandText: 'git status', intention: 'look' } as never)) === JSON.stringify({ tool: 'Bash', input: { command: 'git status', description: 'look' } }) &&
        askFromPermission({ kind: 'write', fileName: 'a.ts', diff: '' } as never, { tool: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, startedAt: 0 }).input['old_string'] === 'a' &&
        askFromPermission({ kind: 'write', fileName: 'n.ts', diff: '', newFileContents: 'x' } as never).tool === 'Write' &&
        askFromPermission({ kind: 'mcp', serverName: 'gh', toolName: 'pr', args: {} } as never).tool === 'mcp__gh__pr',
    );

    // ── the event translator, on recorded events ──
    let clock = 1_000;
    const tr = new CopilotEvents(ROOT, () => clock);
    const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ id: 'e', parentId: null, timestamp: nowIso(), type, data, ...extra }) as unknown as SessionEvent;
    const said17 = tr.take(ev('assistant.message', { messageId: 'm1', content: 'Looking at it.' }));
    const started17 = tr.take(ev('tool.execution_start', { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'npm test' } }));
    clock += 2_400;
    const ended17 = tr.take(ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: '6 passed' } }));
    tr.take(ev('tool.execution_start', { toolCallId: 'c2', toolName: 'create', arguments: { path: join(ROOT, 'n.ts'), file_text: 'a\nb\n' } }));
    const wrote17 = tr.take(ev('tool.execution_complete', { toolCallId: 'c2', success: true }));
    const planned17 = tr.take(ev('tool.execution_start', { toolCallId: 'c3', toolName: 'update_todo', arguments: { todos: '- [ ] one' } }));
    const used17 = tr.take(ev('assistant.usage', { model: 'gpt-5-mini', inputTokens: 120, outputTokens: 30, cacheReadTokens: 7 }));
    const sub17 = tr.take(ev('assistant.message', { messageId: 'm2', content: 'sub-agent words' }, { agentId: 'sub1' }));
    const subIdle17 = tr.take(ev('session.idle', {}, { agentId: 'sub1' }));
    const idle17 = tr.take(ev('session.idle', {}));
    check('assistant text is a text event', JSON.stringify(said17.payloads) === JSON.stringify([{ kind: 'text', text: 'Looking at it.' }]) && said17.replied === true);
    check(
      'a tool start is a tool_start in Claude words, and its end — which names no tool — is matched to it by toolCallId',
      started17.payloads[0]?.kind === 'tool_start' && started17.payloads[0].tool === 'Bash' && started17.payloads[0].label === 'Bash · npm test' &&
        ended17.payloads[0]?.kind === 'tool_end' && ended17.payloads[0].ok && ended17.payloads[0].summary === '6 passed · 2.4s',
      JSON.stringify([started17.payloads, ended17.payloads]),
    );
    check('a file written is a file_edit', wrote17.payloads.some((p) => p.kind === 'file_edit' && p.path === 'n.ts' && p.added === 2 && p.created === true));
    check('a plan is a todo', planned17.payloads.some((p) => p.kind === 'todo' && p.items[0]?.text === 'one'));
    check('usage is tokens, per call', JSON.stringify(used17.usage) === JSON.stringify({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 7 }) && used17.payloads.length === 0);
    check("a sub-agent's words and idling are not this agent's turn", sub17.payloads.length === 0 && subIdle17.end === undefined && idle17.end?.kind === 'idle');
    check('a call still running is known as open', tr.open().join() === 'c3');

    // ── the backend, through the real supervisor, on the fake client ──
    const cpAgent = (id: string, a: Partial<Agent> = {}) => {
      job(`job_${id}`, null);
      fixture(id, `job_${id}`, { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'gpt-5-mini', provider: 'copilot', ...a } as Partial<Agent>);
    };
    const sessionOf = async (id: string, nth = 1): Promise<FakeCopilotSession | undefined> => {
      await until(() => copilotSessions.filter((s) => s.id === id).length >= nth);
      return copilotSessions.filter((s) => s.id === id)[nth - 1];
    };
    const payloads = (id: string) => eventLog().forAgent(id).map((e) => e.payload);
    const shell = (command: string, toolCallId: string) => ({
      kind: 'shell', fullCommandText: command, intention: 'run it', toolCallId,
      commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true,
    });

    cpAgent('agt_cp1');
    sup.pump();
    const s1 = await sessionOf('agt_cp1');
    check(
      "a Copilot agent's session is made with the agent's own id, in its folder, with Conductor's permission callback",
      s1 !== undefined && !s1.resumed && s1.config.sessionId === 'agt_cp1' && s1.config.workingDirectory === ROOT &&
        typeof s1.config.onPermissionRequest === 'function' && s1.config.provider === undefined && s1.config.model === 'gpt-5-mini',
      JSON.stringify(s1?.config),
    );
    check('and it is sent the job prompt', s1?.prompts[0]?.prompt === 'the job_agt_cp1 prompt', JSON.stringify(s1?.prompts));
    check('the session id stored is the one we chose', getAgent(db, 'agt_cp1')?.sdkSessionId === 'agt_cp1');
    s1?.emit('assistant.message', { messageId: 'm1', content: 'On it.' });
    s1?.emit('tool.execution_start', { toolCallId: 't1', toolName: 'view', arguments: { path: join(ROOT, 'README.md') } });
    s1?.emit('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: '# verify' } });
    s1?.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 100, outputTokens: 20 });
    s1?.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 50, outputTokens: 5 });
    s1?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp1')?.status === 'done');
    const p1 = payloads('agt_cp1');
    check('a normal turn ends done', getAgent(db, 'agt_cp1')?.status === 'done', getAgent(db, 'agt_cp1')?.status);
    check(
      'and its transcript is the same events a Claude agent writes',
      p1.some((p) => p.kind === 'user_text') && p1.some((p) => p.kind === 'text' && p.text === 'On it.') &&
        p1.some((p) => p.kind === 'tool_start' && p.tool === 'Read' && p.label === 'Read README.md') &&
        p1.some((p) => p.kind === 'tool_end' && p.ok),
      JSON.stringify(p1.map((p) => p.kind)),
    );
    const a1 = getAgent(db, 'agt_cp1');
    check('tokens are counted as they arrive; no dollars are invented', a1?.inputTokens === 150 && a1.outputTokens === 25 && a1.costUsd === 0, JSON.stringify(a1));
    check('the session is let go at the end of the run', s1?.disconnected === true);

    // A resume: a message to a finished agent, with a bogus foreign id on its row.
    db.prepare('UPDATE agents SET sdk_session_id = ? WHERE id = ?').run('sess_claude_from_elsewhere', 'agt_cp1');
    const resumes0 = fakeCopilot.resumes.length;
    const msg = await send<{ delivery: string }>('POST', '/api/agents/agt_cp1/message', { text: 'and the docs' });
    const s1b = await sessionOf('agt_cp1', 2);
    check(
      'a message to a finished agent resumes its own session — by the agent id, never an id another engine stored',
      msg.body.delivery === 'resumed' && s1b?.resumed === true && fakeCopilot.resumes.slice(resumes0).join() === 'agt_cp1',
      JSON.stringify(fakeCopilot.resumes),
    );
    check(
      'and the resume is given its callbacks and folder again',
      typeof s1b?.config.onPermissionRequest === 'function' && s1b?.config.workingDirectory === ROOT && (s1b?.config as { continuePendingWork?: boolean }).continuePendingWork === false,
    );
    check('the message is what it is sent', s1b?.prompts[0]?.prompt === 'and the docs');
    s1b?.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 10, outputTokens: 1 });
    s1b?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp1')?.status === 'done');
    check('its tokens are a lifetime total across runs', getAgent(db, 'agt_cp1')?.inputTokens === 160);

    // A permission held, then approved; another denied.
    cpAgent('agt_cp2');
    sup.pump();
    const s2 = await sessionOf('agt_cp2');
    const asked = s2!.ask(shell('npm install', 'tc1'));
    await until(() => openRequestsForAgent(db, 'agt_cp2').length === 1);
    const r2 = openRequestsForAgent(db, 'agt_cp2')[0];
    check('a call that needs you becomes a request, in Claude words', r2?.toolName === 'Bash' && r2.label === 'Bash · npm install' && r2.toolUseId === 'tc1' && r2.reversible?.value === true, JSON.stringify(r2));
    await settle(150);
    check(
      'and is held, not parked, though no browser is watching: without defer, parking would only end the run',
      openRequestsForAgent(db, 'agt_cp2')[0]?.blockMode === 'held' && getAgent(db, 'agt_cp2')?.status === 'blocked',
    );
    await send('POST', `/api/requests/${r2!.id}/decide`, { decision: { type: 'allow_once' } });
    check('approving it lets the call run', JSON.stringify(await asked) === JSON.stringify({ kind: 'approve-once' }));
    check('and the agent is working again', getAgent(db, 'agt_cp2')?.status === 'working');
    const asked2 = s2!.ask(shell('curl example.com', 'tc2'));
    await until(() => openRequestsForAgent(db, 'agt_cp2').length === 1);
    await send('POST', `/api/requests/${openRequestsForAgent(db, 'agt_cp2')[0]!.id}/decide`, { decision: { type: 'deny', message: 'no network' } });
    check('denying it refuses the call, with what you said', JSON.stringify(await asked2) === JSON.stringify({ kind: 'reject', feedback: 'no network' }));

    // Interrupted while it waits: parked, and answering resumes the session.
    const asked3 = s2!.ask(shell('npm publish', 'tc3'));
    void asked3;
    await until(() => openRequestsForAgent(db, 'agt_cp2').length === 1);
    s2?.emit('tool.execution_start', { toolCallId: 'tc9', toolName: 'bash', arguments: { command: 'sleep 100' } });
    await send('POST', '/api/agents/agt_cp2/interrupt');
    await until(() => getAgent(db, 'agt_cp2')?.blockMode === 'parked');
    const parked = openRequestsForAgent(db, 'agt_cp2')[0];
    check('an interrupt aborts the turn', (s2?.aborts ?? 0) >= 1);
    check(
      'and a question it was waiting on is parked, as it is for Claude',
      parked?.blockMode === 'parked' && getAgent(db, 'agt_cp2')?.status === 'blocked',
      JSON.stringify([parked?.blockMode, getAgent(db, 'agt_cp2')?.status]),
    );
    check('a call it cut short says so', payloads('agt_cp2').some((p) => p.kind === 'tool_end' && p.toolUseId === 'tc9' && p.summary === CUT_SHORT));
    await send('POST', `/api/requests/${parked!.id}/decide`, { decision: { type: 'allow_once' } });
    const s2b = await sessionOf('agt_cp2', 2);
    check('answering it resumes the same session', s2b?.resumed === true && s2b.id === 'agt_cp2');
    check('told what was decided', /Your Bash call was approved/.test(s2b?.prompts[0]?.prompt ?? ''), s2b?.prompts[0]?.prompt);
    check('and the call made again is let through on that answer, without asking twice', JSON.stringify(await s2b!.ask(shell('npm publish', 'tc4'))) === JSON.stringify({ kind: 'approve-once' }) && openRequestsForAgent(db, 'agt_cp2').length === 0);
    s2b?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp2')?.status === 'done');

    // The safety net: a disallowed tool, under the loosest mode there is.
    cpAgent('agt_cp3', { autonomy: { ...DEFAULT_AUTONOMY, mode: 'bypassPermissions', disallowedTools: ['Bash(git push:*)', 'WebFetch'] } });
    sup.pump();
    const s3 = await sessionOf('agt_cp3');
    const pushed = await s3!.ask(shell('git add . && git push origin main', 'tp1'));
    check(
      'a disallowed call is refused under bypassPermissions — Conductor refuses it, since this SDK would not',
      pushed.kind === 'reject' && /Bash\(git push:\*\)/.test((pushed as { feedback?: string }).feedback ?? '') && openRequestsForAgent(db, 'agt_cp3').length === 0,
      JSON.stringify(pushed),
    );
    check('and says so in its transcript', payloads('agt_cp3').some((p) => p.kind === 'resolved' && p.decision.type === 'deny' && p.decision.by === 'rule'));
    check('anything else runs, as bypass means', (await s3!.ask(shell('git status', 'tp2'))).kind === 'approve-once');
    check('a disallowed whole tool is also kept from the model', (s3?.config.excludedTools as string[] | undefined)?.includes('web_fetch') === true, JSON.stringify(s3?.config.excludedTools));
    s3?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp3')?.status === 'done');

    // A failed run reaches Needs you, as a Claude failure does.
    cpAgent('agt_cp4');
    sup.pump();
    const s4 = await sessionOf('agt_cp4');
    s4?.emit('session.error', { errorType: 'model', message: 'model gpt-9 is not available\nstack…' });
    await until(() => getAgent(db, 'agt_cp4')?.status === 'failed');
    const failed4 = alerts().list().find((a) => a.kind === 'failed' && a.agentIds.includes('agt_cp4'));
    check('a session error fails the run, with why', getAgent(db, 'agt_cp4')?.status === 'failed' && failed4?.detail === 'model gpt-9 is not available', JSON.stringify(failed4));

    // A token cap (Amendment 77) reached mid-run stops it the way Claude's budget stop does.
    cpAgent('agt_cp5', { costUsd: 0.5, autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 1_000_000 } });
    sup.pump();
    const s5 = await sessionOf('agt_cp5');
    // The budget lowered under what it has spent: the next model call finds it at its ceiling
    // (Amendment 124: twice the budget, so ten tokens against a budget of five).
    setAgentAutonomy(db, 'agt_cp5', { ...DEFAULT_AUTONOMY, budgetTokens: 5 });
    s5?.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 5, outputTokens: 5 });
    await until(() => getAgent(db, 'agt_cp5')?.status === 'paused');
    check(
      'over its cap after a model call: stopped and paused with the budget note, its spend unchanged',
      getAgent(db, 'agt_cp5')?.status === 'paused' && (s5?.aborts ?? 0) >= 1 && getAgent(db, 'agt_cp5')?.costUsd === 0.5 &&
        payloads('agt_cp5').some((p) => p.kind === 'status' && p.status === 'paused' && /budget reached .*-token daily budget/.test(p.error ?? '')),
      JSON.stringify(payloads('agt_cp5').filter((p) => p.kind === 'status')),
    );

    // An orchestrator's helper tools, in-process.
    cpAgent('agt_cp6', { helperCap: 2 } as Partial<Agent>);
    sup.pump();
    const s6 = await sessionOf('agt_cp6');
    const tools6 = (s6?.config.tools ?? []) as { name: string; skipPermission?: boolean; handler?: (a: unknown, i: unknown) => unknown }[];
    check('an orchestrator is given start_helper and list_helpers, needing no permission', tools6.map((t) => t.name).join() === 'start_helper,list_helpers' && tools6.every((t) => t.skipPermission === true));
    check('served by the same code as Claude\'s', (await tools6[1]?.handler?.({}, {})) === 'No helpers started yet.');
    // ask_user comes to its own callback, and is a question in Needs you.
    const question = s6!.config.onUserInputRequest!({ question: 'Which database?', choices: ['sqlite', 'postgres'] }, { sessionId: 'agt_cp6' });
    await until(() => openRequestsForAgent(db, 'agt_cp6').length === 1);
    const q6 = openRequestsForAgent(db, 'agt_cp6')[0];
    check('ask_user is a question, with its choices', q6?.kind === 'question' && q6.questions?.[0]?.options.map((o) => o.label).join() === 'sqlite,postgres', JSON.stringify(q6?.questions));
    await send('POST', `/api/requests/${q6!.id}/decide`, { decision: { type: 'answer', answers: { 'Which database?': 'postgres' } } });
    check('and your answer is its answer', JSON.stringify(await question) === JSON.stringify({ answer: 'postgres', wasFreeform: false }));
    s6?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp6')?.status === 'done');

    // hand_off, in-process, for an agent others wait for (Amendment 104).
    job('job_cp_hand', null);
    fixture('agt_cp_lead', 'job_cp_hand', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'gpt-5-mini', provider: 'copilot' } as Partial<Agent>);
    fixture('agt_cp_next', 'job_cp_hand', { status: 'queued', dependsOn: ['agt_cp_lead'], autonomy: DEFAULT_AUTONOMY, model: 'gpt-5-mini', provider: 'copilot' } as Partial<Agent>);
    sup.pump();
    const sLead = await sessionOf('agt_cp_lead');
    type InProcessTool = { name: string; skipPermission?: boolean; handler?: (a: unknown, i: unknown) => unknown };
    const leadTools = (sLead?.config.tools ?? []) as InProcessTool[];
    check('a Copilot agent others wait for is given hand_off, needing no permission (Amendment 104)', leadTools.map((t) => t.name).join() === 'hand_off' && leadTools.every((t) => t.skipPermission === true), JSON.stringify(leadTools.map((t) => t.name)));
    const refusedBlank = (await leadTools[0]?.handler?.({ summary: '  ' }, {})) as { resultType?: string; error?: string } | undefined;
    check('a blank summary is a failure the model reads, not a hand-off', refusedBlank?.resultType === 'failure' && /needs a summary/.test(refusedBlank.error ?? '') && getHandoff(db, 'agt_cp_lead').summary === null, JSON.stringify(refusedBlank));
    sLead?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp_lead')?.status === 'done');
    await settle(150);
    check(
      'its turn ends without hand_off: held, and the next agent has not started',
      getHandoff(db, 'agt_cp_lead').held && !copilotSessions.some((x) => x.id === 'agt_cp_next') && getAgent(db, 'agt_cp_next')?.status === 'queued' &&
        alerts().list().some((a) => a.kind === 'handoff_held' && a.agentIds[0] === 'agt_cp_lead'),
    );
    await send('POST', '/api/agents/agt_cp_lead/message', { text: 'say what you did' });
    const sLead2 = await sessionOf('agt_cp_lead', 2);
    const leadTools2 = (sLead2?.config.tools ?? []) as InProcessTool[];
    check('the resume is given the tool again', sLead2?.resumed === true && leadTools2.map((t) => t.name).join() === 'hand_off');
    const handed = await leadTools2[0]?.handler?.({ summary: 'The lead is done: see notes.md.' }, {});
    check('hand_off through the in-process tool is the same call Claude makes over the endpoint', typeof handed === 'string' && /^Handed off\./.test(handed) && getHandoff(db, 'agt_cp_lead').summary === 'The lead is done: see notes.md.', String(handed));
    sLead2?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp_lead')?.status === 'done');
    const sNext = await sessionOf('agt_cp_next');
    check('then its turn ends, and the next agent starts with the summary', /Its summary of its work:\nThe lead is done: see notes\.md\./.test(sNext?.prompts[0]?.prompt ?? '') && !getHandoff(db, 'agt_cp_lead').held, sNext?.prompts[0]?.prompt);
    check('the last agent in the chain is given no tools, and cannot hand off', (sNext?.config.tools ?? []).length === 0 && callTool('agt_cp_next', 'hand_off', { summary: 'x' }).isError === true);
    sNext?.emit('session.idle', {});
    await until(() => getAgent(db, 'agt_cp_next')?.status === 'done');
    check('and it finishes done, as it did', getAgent(db, 'agt_cp_next')?.status === 'done' && !getHandoff(db, 'agt_cp_next').held);

    // A restart finds a request held by an engine that can't defer: expired, not left hanging.
    for (const [id, provider] of [['agt_cp_orphan', 'copilot'], ['agt_claude_orphan', 'claude']] as const) {
      job(`job_${id}`, null);
      fixture(id, `job_${id}`, { status: 'blocked', blockMode: 'held', sdkSessionId: id, provider } as Partial<Agent>);
      insertRequest(db, {
        id: `req_${id}`, agentId: id, jobId: `job_${id}`, projectId: pid, kind: 'permission', blockMode: 'held',
        toolName: 'Bash', toolUseId: `tu_${id}`, input: { command: 'make' }, label: 'Bash · make', createdAt: nowIso(),
      });
    }
    arbiter().recoverOrphans();
    const orphan = row<{ decision: string | null; resolved_at: string | null }>(db.prepare('SELECT decision, resolved_at FROM requests WHERE id = ?').get('req_agt_cp_orphan'));
    const said = JSON.parse(orphan?.decision ?? '{}') as { type?: string; note?: string };
    check(
      "after a restart, a Copilot agent's held request is expired, saying why",
      orphan?.resolved_at !== null && said.type === 'expired' && /restarted/.test(said.note ?? '') &&
        payloads('agt_cp_orphan').some((p) => p.kind === 'resolved' && p.decision.type === 'expired'),
      JSON.stringify(orphan),
    );
    check("and the agent is put back to working, so the restart's reconcile resumes it to ask again", getAgent(db, 'agt_cp_orphan')?.status === 'working');
    check(
      "a Claude agent's is parked, as it always was",
      openRequestsForAgent(db, 'agt_claude_orphan')[0]?.blockMode === 'parked' && getAgent(db, 'agt_claude_orphan')?.blockMode === 'parked',
    );
    for (const id of ['agt_cp_orphan', 'agt_claude_orphan']) {
      arbiter().cancelForAgent(id, 'verify');
      setAgentStatus(db, id, 'done');
    }

    // ── the OpenRouter key, and the refusals spawn checks ──
    const spec = { role: 'builder', model: 'anthropic/claude-sonnet-4.5', autonomy: DEFAULT_AUTONOMY, provider: 'openrouter' };
    const noKey = await send<{ detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p76', isolation: 'in_place', agents: [spec] });
    check('openrouter with no key → 400 at spawn, saying where the key goes', noKey.status === 400 && /OPENROUTER_API_KEY or add the key in Settings/.test(noKey.body.detail ?? ''), JSON.stringify(noKey.body));
    check('the key is unset to begin with', JSON.stringify((await get('/api/providers/openrouter/key')).body) === JSON.stringify({ set: false, source: null }));
    const KEY = 'sk-or-v1-verify-0123456789abcdef';
    const put = await send<{ set: boolean; source: string }>('PUT', '/api/providers/openrouter/key', { key: KEY });
    check('PUT keeps it, and answers only whether it is set', put.status === 200 && JSON.stringify(put.body) === JSON.stringify({ set: true, source: 'settings' }));
    const bad = await fetch(`${BASE}/api/providers/openrouter/key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: `${KEY} two` }) });
    const badText = await bad.text();
    check('a key that cannot be one → 400, without repeating it', bad.status === 400 && !badText.includes(KEY), badText);
    check('openrouter can launch now', providerRefusal('openrouter') === null);
    const made = await send<{ agents?: Agent[] }>('POST', '/api/jobs', { projectId: pid, prompt: 'p76', isolation: 'in_place', agents: [spec] });
    const orId = made.body.agents?.[0]?.id ?? '';
    const sOr = await sessionOf(orId);
    check(
      "an OpenRouter agent's session is BYOK, at OpenRouter, with the key and the model it was given",
      made.status === 201 && sOr?.config.provider?.baseUrl === 'https://openrouter.ai/api/v1' && sOr.config.provider.apiKey === KEY &&
        sOr.config.provider.type === 'openai' && sOr.config.model === 'anthropic/claude-sonnet-4.5',
      JSON.stringify({ status: made.status, provider: sOr?.config.provider?.baseUrl }),
    );
    // The question tool, too: OpenRouter runs on the Copilot backend, whose one config
    // gives it `onUserInputRequest`, so ask_user reaches Needs you as for Copilot (Amendment 100).
    const orAsk = sOr!.config.onUserInputRequest!({ question: 'Which database?', choices: ['sqlite', 'postgres'] }, { sessionId: orId });
    await until(() => openRequestsForAgent(db, orId).length === 1);
    const qOr = openRequestsForAgent(db, orId)[0];
    check('an OpenRouter agent is given the question tool: ask_user is a question in Needs you (Amendment 100)', qOr?.kind === 'question' && qOr.questions?.[0]?.options.map((o) => o.label).join() === 'sqlite,postgres', JSON.stringify(qOr?.questions));
    await send('POST', `/api/requests/${qOr!.id}/decide`, { decision: { type: 'answer', answers: { 'Which database?': 'sqlite' } } });
    check('and your answer is its answer (Amendment 100)', JSON.stringify(await orAsk) === JSON.stringify({ answer: 'sqlite', wasFreeform: false }));
    sOr?.emit('session.idle', {});
    await until(() => getAgent(db, orId)?.status === 'done');
    // hand_off reaches OpenRouter agents the same way (Amendment 104): one backend, two ways in.
    const orStack = await send<{ agents?: Agent[] }>('POST', '/api/jobs', {
      projectId: pid, prompt: 'p104', isolation: 'in_place',
      agents: [{ ...spec, role: 'planner' }, { ...spec, role: 'worker', dependsOnRoles: ['planner'] }],
    });
    const [orPlan, orWork] = orStack.body.agents ?? [];
    const sPlan = await sessionOf(orPlan?.id ?? '');
    const planTools = (sPlan?.config.tools ?? []) as { name: string; skipPermission?: boolean; handler?: (a: unknown, i: unknown) => unknown }[];
    check('an OpenRouter agent others wait for is given hand_off', orStack.status === 201 && sPlan?.config.provider?.baseUrl === 'https://openrouter.ai/api/v1' && planTools.map((t) => t.name).join() === 'hand_off' && planTools[0]?.skipPermission === true, JSON.stringify({ status: orStack.status, tools: planTools.map((t) => t.name) }));
    const orHanded = await planTools[0]?.handler?.({ summary: 'Plan: three steps, in plan.md.' }, {});
    check('and the call is taken', typeof orHanded === 'string' && /^Handed off\. worker will start/.test(orHanded), String(orHanded));
    sPlan?.emit('session.idle', {});
    await until(() => getAgent(db, orPlan?.id ?? '')?.status === 'done');
    const sWork = await sessionOf(orWork?.id ?? '');
    check('the worker starts with the planner’s summary', /Its summary of its work:\nPlan: three steps, in plan\.md\./.test(sWork?.prompts[0]?.prompt ?? '') && (sWork?.config.tools ?? []).length === 0, sWork?.prompts[0]?.prompt);
    sWork?.emit('session.idle', {});
    await until(() => getAgent(db, orWork?.id ?? '')?.status === 'done');
    const everywhere = [
      JSON.stringify((await get('/api/settings')).body),
      JSON.stringify((await get('/api/snapshot')).body),
      JSON.stringify((await get('/api/providers')).body),
      JSON.stringify((await get('/api/providers/openrouter/key')).body),
      JSON.stringify(eventLog().forAgent(orId)),
      JSON.stringify(db.prepare('SELECT * FROM agents').all()),
      JSON.stringify(db.prepare('SELECT * FROM agent_runs').all()),
    ];
    check('the key is in no response, setting, event or row', everywhere.every((t) => !t.includes(KEY)));
    process.env['OPENROUTER_API_KEY'] = 'sk-or-v1-from-the-environment';
    check('OPENROUTER_API_KEY wins, and says so', JSON.stringify((await get('/api/providers/openrouter/key')).body) === JSON.stringify({ set: true, source: 'env' }));
    delete process.env['OPENROUTER_API_KEY'];
    const cleared = await send('PUT', '/api/providers/openrouter/key', { key: null });
    check('{ key: null } forgets it', JSON.stringify(cleared.body) === JSON.stringify({ set: false, source: null }) && providerRefusal('openrouter') !== null);

    // ── the Copilot login, and the model lists ──
    copilotSdk.credentialPresent = () => false;
    const asksBefore = fakeCopilot.authAsks;
    const none = await get<{ authenticated: boolean; note?: string }>('/api/providers/copilot/login');
    check(
      'with no GitHub credential anywhere, the runtime is not asked — opening Spawn or Settings starts nothing',
      none.body.authenticated === false && none.body.note === 'no GitHub credential found' && fakeCopilot.authAsks === asksBefore,
      JSON.stringify(none.body),
    );
    copilotSdk.credentialPresent = () => true;
    const out = await get<{ authenticated: boolean; login: string | null; note?: string }>('/api/providers/copilot/login');
    check('no Copilot login is said plainly', out.body.authenticated === false && out.body.login === null && out.body.note === 'no login in verify', JSON.stringify(out.body));
    check('and spawning on copilot is refused, saying how to sign in', /not logged in to GitHub Copilot/.test(providerRefusal('copilot') ?? ''), providerRefusal('copilot') ?? 'null');
    fakeCopilot.authFails = true;
    const broke = await get<{ authenticated: boolean; note?: string }>('/api/providers/copilot/login');
    check('a runtime that cannot say fails soft, with a note', broke.status === 200 && broke.body.authenticated === false && /could not ask the Copilot runtime: runtime not found/.test(broke.body.note ?? ''), JSON.stringify(broke.body));
    fakeCopilot.authFails = false;
    fakeCopilot.auth = { isAuthenticated: true, login: 'octocat' };
    const inn = await get<{ authenticated: boolean; login: string | null }>('/api/providers/copilot/login');
    check('signed in, it says who', inn.body.authenticated === true && inn.body.login === 'octocat');
    check('and copilot can launch', providerRefusal('copilot') === null);
    check(
      "copilot's models are the SDK's list",
      JSON.stringify(await backendFor('copilot')!.listModels()) === JSON.stringify([{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', efforts: ['low', 'high'] }]),
    );
    let asks = 0;
    copilotSdk.fetchOpenRouterModels = async () => {
      asks += 1;
      return { data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }, { name: 'no id' }] };
    };
    const orModels = await backendFor('openrouter')!.listModels();
    await backendFor('openrouter')!.listModels();
    check("openrouter's are its public list, asked once and cached", JSON.stringify(orModels) === JSON.stringify([{ id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' }]) && asks === 1);
    copilotSdk.fetchOpenRouterModels = () => Promise.reject(new Error('verify asked OpenRouter'));
    const caps = (await get<{ providers: ProviderInfo[] }>('/api/providers')).body.providers.find((p) => p.id === 'copilot')?.capabilities;
    check('its capabilities are the findings: no defer, no dollars, no plan mode yet', JSON.stringify(caps) === JSON.stringify({ defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true }));
    check('one client per provider, started once each', fakeCopilot.clients === 2 && fakeCopilot.starts === 2, JSON.stringify(fakeCopilot));
    await until(() => sup.slots.used === 0);
  }

  console.log('\n17m · an engine that reports no dollars is capped in tokens (Amendment 77)');
  /*
   * A fake engine on `copilot` with `costUsd: false`, the way step 4's will be: each run
   * reports tokens and $0, and ends `budget_exhausted` when the backend sees the cap —
   * what the real one does by calling budgetRefusal after each usage update.
   */
  const tokenRuns: { agentId: string; resume: string | null; end: (o: { input: number; output: number; atCap?: boolean }) => void }[] = [];
  const fakeEngine = (provider: 'copilot' | 'openrouter', listModels: () => Promise<{ id: string; displayName: string; efforts?: string[] }[]>) => ({
    provider,
    capabilities: { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true },
    listModels,
    unavailable: () => null,
    create: (d: Db, scope: { agentId: string }) => {
      let live = false;
      return {
        agentId: scope.agentId,
        get isLive() { return live; },
        get sessionId() { return getAgent(d, scope.agentId)?.sdkSessionId ?? null; },
        run: (opts: { resume?: string | null }) =>
          new Promise<{ sessionId: string; terminalReason: string; deferredTool: null; isError: boolean; errorDetail: null; costUsd: number }>((resolve) => {
            live = true;
            tokenRuns.push({
              agentId: scope.agentId,
              resume: opts.resume ?? null,
              end: ({ input, output, atCap }) => {
                live = false;
                const sid = `${provider}_sess_${scope.agentId}`;
                setAgentSession(d, scope.agentId, sid);
                // The real backend adds each call's tokens to the agent's day as they arrive (Amendment 129);
                // this one reports lifetime totals at the end, so the day grows by the difference.
                const had = getAgent(d, scope.agentId);
                setAgentUsage(d, scope.agentId, { costUsd: 0, inputTokens: input, outputTokens: output });
                addSpendToday(d, scope.agentId, { tokens: input + output - ((had?.inputTokens ?? 0) + (had?.outputTokens ?? 0)) });
                resolve({ sessionId: sid, terminalReason: atCap ? 'budget_exhausted' : 'completed', deferredTool: null, isError: atCap === true, errorDetail: null, costUsd: 0 });
              },
            });
          }),
        send: () => false,
        setModel: async () => false,
        interrupt: async () => { live = false; },
        stop: async () => { live = false; },
      };
    },
  });
  const enginesBefore = { copilot: backendFor('copilot'), openrouter: backendFor('openrouter') };
  {
    registerBackend(fakeEngine('copilot', async () => []));

    const shown = [tokens(950), tokens(12_550), tokens(412_999), tokens(500_000), tokens(1_250_000)].join();
    check('tokens read as people say them, rounded down', shown === '950,12.5k,412k,500k,1.2M', shown);
    // Amendment 129: what a budget reads is what the agent spent TODAY (`spentToday`), in dollars or in tokens.
    const todays = (usd: number, tokens: number) => ({ day: localDay(), usd, tokens });
    const tokenAgent = { role: 'builder', spentToday: todays(0, 412_000), autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000 } };
    check('under its token cap, a $0 agent may run', budgetRefusal(tokenAgent) === null);
    // Amendment 124: at the token budget (500k) it is only over; what refuses is twice it (1M).
    check('at the budget itself a $0 agent may still run: that is the warning', budgetRefusal({ ...tokenAgent, spentToday: todays(0, 500_000) }) === null);
    const atTokenCap = { ...tokenAgent, spentToday: todays(0, 1_000_000) };
    check('at twice it, refused in tokens — no dollar figure', budgetRefusal(atTokenCap) === 'The Builder has spent 1M of its 500k-token daily budget today, which stops it at 1M — raise it to continue, or it renews at midnight.', String(budgetRefusal(atTokenCap)));
    check('and its note says the same', budgetNote(atTokenCap) === 'budget reached for today — spent 1M of its 500k-token daily budget, which stops it at 1M', budgetNote(atTokenCap));
    check('which still reads as a budget stop', budgetStop(budgetNote(atTokenCap)) === 'budget_exhausted');
    const dollars = { role: 'builder', spentToday: todays(50, 9_000_000), autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } };
    check('a dollar budget reads in dollars, whatever the tokens', budgetRefusal(dollars) === 'The Builder has spent $50 of its $25 daily budget today, which stops it at $50 — raise it to continue, or it renews at midnight.' && budgetNote(dollars) === 'budget reached for today — spent $50 of its $25 daily budget, which stops it at $50');
    check('and tokens never stop an agent capped in dollars', budgetRefusal({ ...dollars, spentToday: todays(1, 9_000_000) }) === null);
    check('a job with a token-capped agent has no dollar cap: its dollars are unknown, not zero', jobCap([{ autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 5 } }, { autonomy: tokenAgent.autonomy }]) === null);

    const agentsBefore = new Set(listAgents(db).map((a) => a.id));
    const spawn = (agents: unknown[]) => send<{ agents?: Agent[]; error?: string; detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p77', isolation: 'in_place', agents });
    const onCopilot = (autonomy: unknown) => ({ role: 'builder', model: 'gpt-5', provider: 'copilot', autonomy });
    const usd = await spawn([onCopilot({ ...DEFAULT_AUTONOMY, budgetUsd: 5 })]);
    check('a dollar cap on an engine that reports no dollars → 400, saying to cap tokens', usd.status === 400 && /copilot doesn't report what a run costs in dollars.*budgetTokens/.test(usd.body.detail ?? ''), JSON.stringify(usd.body));
    for (const bad of [0, -5, 1.5, '500000', 2 ** 60]) {
      const r = await spawn([onCopilot({ ...DEFAULT_AUTONOMY, budgetTokens: bad })]);
      check(`budgetTokens ${JSON.stringify(bad)} → 400, not a silent "no cap"`, r.status === 400 && /budgetTokens is a whole number/.test(r.body.detail ?? ''), JSON.stringify(r.body));
    }
    const onClaude = await spawn([{ role: 'builder', model: OPUS, autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 1000 } }]);
    check('a token cap on Claude → 400: its budget is in dollars', onClaude.status === 400 && /claude reports what a run costs in dollars/.test(onClaude.body.detail ?? ''), JSON.stringify(onClaude.body));
    check('nothing was made by any of those', !listAgents(db).some((a) => !agentsBefore.has(a.id) && (a.autonomy.budgetTokens !== undefined || (a.provider === 'copilot' && a.autonomy.budgetUsd !== null))));

    const todayBefore = costToday(db);
    const made = await spawn([onCopilot({ ...DEFAULT_AUTONOMY, budgetTokens: 500_000 })]);
    const tid = made.body.agents?.[0]?.id ?? '';
    check('a token cap on an engine that reports no dollars is kept', made.status === 201 && getAgent(db, tid)?.autonomy.budgetTokens === 500_000 && getAgent(db, tid)?.autonomy.budgetUsd === null, JSON.stringify(made.body).slice(0, 300));
    check('under it, the agent runs', await until(() => tokenRuns.length === 1 && getAgent(db, tid)?.status === 'working'));
    tokenRuns[0]?.end({ input: 300_000, output: 100_000 });
    await until(() => getAgent(db, tid)?.status === 'done');
    check('400k used, $0 reported: done, with its tokens counted', getAgent(db, tid)?.status === 'done' && getAgent(db, tid)?.inputTokens === 300_000 && getAgent(db, tid)?.costUsd === 0);
    const said = await send<{ delivery?: string }>('POST', `/api/agents/${tid}/message`, { text: 'more' });
    check('below the cap, a message resumes it', said.status === 200 && said.body.delivery === 'resumed' && (await until(() => tokenRuns.length === 2)), JSON.stringify(said.body));
    check('on its own session', tokenRuns[1]?.resume === `copilot_sess_${tid}`, String(tokenRuns[1]?.resume));
    tokenRuns[1]?.end({ input: 700_000, output: 550_000, atCap: true });
    await until(() => getAgent(db, tid)?.status === 'paused');
    const note = eventLog().forAgent(tid).map((e) => e.payload).filter((p) => p.kind === 'status').at(-1);
    check('reaching the ceiling pauses the agent, in tokens', getAgent(db, tid)?.status === 'paused' && note?.kind === 'status' && note.error === 'budget reached for today — spent 1.2M of its 500k-token daily budget, which stops it at 1M', JSON.stringify(note));
    const sentence = 'The Builder has spent 1.2M of its 500k-token daily budget today, which stops it at 1M — raise it to continue, or it renews at midnight.';
    const refusedMsg = await send<{ detail?: string }>('POST', `/api/agents/${tid}/message`, { text: 'go on' });
    check('then a message is refused with that sentence', refusedMsg.status === 409 && refusedMsg.body.detail === sentence, JSON.stringify(refusedMsg.body));
    const refusedResume = await send<{ detail?: string }>('POST', `/api/agents/${tid}/resume`);
    check('and so is resume', refusedResume.status === 409 && refusedResume.body.detail === sentence, JSON.stringify(refusedResume.body));
    check('and nothing ran', tokenRuns.length === 2);
    check("today's spend is dollars only — 1.2M tokens added nothing to it", costToday(db) === todayBefore, `${costToday(db)} vs ${todayBefore}`);

    const toUsd = await send<{ detail?: string }>('POST', `/api/agents/${tid}/autonomy`, { autonomy: { budgetUsd: 10 } });
    check('a dollar cap is refused on it later, too', toUsd.status === 400 && /budgetTokens instead/.test(toUsd.body.detail ?? ''), JSON.stringify(toUsd.body));
    const badRaise = await send<{ detail?: string }>('POST', `/api/agents/${tid}/autonomy`, { autonomy: { budgetTokens: -1 } });
    check('and a token cap that is not one', badRaise.status === 400 && getAgent(db, tid)?.autonomy.budgetTokens === 500_000);
    const raised = await send<{ autonomy: Agent['autonomy'] }>('POST', `/api/agents/${tid}/autonomy`, { autonomy: { budgetTokens: 1_000_000 } });
    check('the token cap can be raised', raised.status === 200 && raised.body.autonomy.budgetTokens === 1_000_000 && getAgent(db, tid)?.autonomy.budgetTokens === 1_000_000, JSON.stringify(raised.body));
    const resumed = await send('POST', `/api/agents/${tid}/resume`);
    check('then resume is accepted, and it runs again', resumed.status === 200 && (await until(() => tokenRuns.length === 3)));
    tokenRuns[2]?.end({ input: 400_000, output: 140_000 });
    await until(() => getAgent(db, tid)?.status === 'done');
    const uncap = await send<{ autonomy: Agent['autonomy'] }>('POST', `/api/agents/${tid}/autonomy`, { autonomy: { budgetTokens: null } });
    check('null takes the cap off', uncap.status === 200 && uncap.body.autonomy.budgetTokens === undefined && budgetRefusal(getAgent(db, tid)!) === null, JSON.stringify(uncap.body));

    sdk.query = fakeQuery as typeof sdk.query;
    const claudeOk = await spawn([{ role: 'builder', model: OPUS, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 5, budgetTokens: null } }]);
    const cid = claudeOk.body.agents?.[0]?.id ?? '';
    check("a Claude agent's autonomy is the shape it was: no budgetTokens key", claudeOk.status === 201 && !('budgetTokens' in (claudeOk.body.agents?.[0]?.autonomy ?? {})) && claudeOk.body.agents?.[0]?.autonomy.budgetUsd === 5, JSON.stringify(claudeOk.body).slice(0, 300));
    const claudeTokens = await send<{ detail?: string }>('POST', `/api/agents/${cid}/autonomy`, { autonomy: { budgetTokens: 100 } });
    check('nor can one be given a token cap later', claudeTokens.status === 400 && /budgetUsd, not budgetTokens/.test(claudeTokens.body.detail ?? ''));
    await sup.terminateAgent(cid);
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log('\n17n · each provider lists its own models (Amendment 78)');
  {
    forgetProviderModels();
    let orAsks = 0;
    const SONNET45 = 'anthropic/claude-sonnet-4.5';
    registerBackend(fakeEngine('openrouter', async () => {
      orAsks += 1;
      await new Promise((r) => setTimeout(r, 20));
      return [
        { id: SONNET45, displayName: 'Claude Sonnet 4.5' },
        { id: 'openai/gpt-5', displayName: '', efforts: ['low', 'high'] },
        { id: SONNET45, displayName: 'again' },
      ];
    }));
    // What a listing failure could carry: a credential and a stack. Neither may reach a note.
    registerBackend(fakeEngine('copilot', async () => {
      throw new Error('Not authenticated: Bearer sk-or-v1-0123456789abcdef\n    at listModels (client.js:308)');
    }));

    const plainCat = await get<ModelCatalog & { provider?: string }>('/api/models');
    const claudeCat = await get<ModelCatalog & { provider?: string }>('/api/models?provider=claude');
    check('no provider is the Claude catalog, shaped as it was', plainCat.status === 200 && 'tiers' in plainCat.body && 'source' in plainCat.body && !('provider' in plainCat.body), JSON.stringify(plainCat.body).slice(0, 200));
    check('and ?provider=claude is the same catalog', claudeCat.status === 200 && 'tiers' in claudeCat.body && claudeCat.body.source === plainCat.body.source && !('provider' in claudeCat.body));
    const gem = await get<{ error?: string; detail?: string }>('/api/models?provider=gemini');
    check('an unknown provider → 400, naming the ones there are', gem.status === 400 && /"gemini" — one of claude, copilot, openrouter/.test(gem.body.detail ?? ''), JSON.stringify(gem.body));

    const [or1, or2] = await Promise.all([get<ProviderModelList>('/api/models?provider=openrouter'), get<ProviderModelList>('/api/models?provider=openrouter')]);
    check('two pickers opening at once ask the provider once', orAsks === 1 && or1!.body.fetchedAt === or2!.body.fetchedAt, `${orAsks} asks`);
    const ol = or1!.body;
    check('another provider answers its own list', or1!.status === 200 && ol.provider === 'openrouter' && ol.models.map((m) => m.id).join() === `${SONNET45},openai/gpt-5` && ol.note === undefined && typeof ol.fetchedAt === 'string', JSON.stringify(ol));
    check('free-form ids kept exactly, named, a nameless one by its id, with efforts', ol.models[0]?.displayName === 'Claude Sonnet 4.5' && ol.models[1]?.displayName === 'openai/gpt-5' && ol.models[1]?.efforts?.join() === 'low,high' && !('tiers' in ol));
    await get('/api/models?provider=openrouter');
    check('and it is cached', orAsks === 1, `${orAsks} asks`);
    await get('/api/models?provider=openrouter&fresh=1');
    check('?fresh=1 asks again', orAsks === 2, `${orAsks} asks`);

    const cp = await get<ProviderModelList>('/api/models?provider=copilot');
    const cpText = JSON.stringify(cp.body);
    check('a listing that fails → 200, an empty list and a note saying why', cp.status === 200 && cp.body.provider === 'copilot' && cp.body.models.length === 0 && /couldn't be asked for its models: Not authenticated/.test(cp.body.note ?? ''), cpText);
    check('the note carries no credential and no stack', !/sk-or|0123456789abcdef|client\.js|\bat listModels/.test(cpText), cpText);
    const unbuilt = await providerModels('openrouter', undefined);
    check('a provider not registered → an empty list, saying so', unbuilt.models.length === 0 && /isn't available in this build/.test(unbuilt.note ?? ''), JSON.stringify(unbuilt));

    const spawn = (agent: Record<string, unknown>) => send<{ agents?: Agent[]; error?: string; detail?: string }>('POST', '/api/jobs', { projectId: pid, prompt: 'p78', isolation: 'in_place', agents: [{ role: 'builder', autonomy: DEFAULT_AUTONOMY, ...agent }] });
    const start = tokenRuns.length;
    const notListed = await spawn({ provider: 'openrouter', model: 'openai/gpt-6' });
    check('spawn with a model its provider does not offer → 400, naming what it does', notListed.status === 400 && notListed.body.detail === `Error: agent builder: openrouter does not offer "openai/gpt-6" — pick one of ${SONNET45}, openai/gpt-5.`, JSON.stringify(notListed.body));
    const tier = await spawn({ provider: 'openrouter', model: 'sonnet' });
    check("Claude's tiers are not ids anywhere else", tier.status === 400 && /does not offer "sonnet"/.test(tier.body.detail ?? ''), JSON.stringify(tier.body));
    const noModel = await spawn({ provider: 'openrouter', model: '' });
    check('a non-Claude spec needs a model too', noModel.status === 400 && /needs a model/.test(noModel.body.detail ?? ''));
    check('nothing ran for any of those', tokenRuns.length === start);
    const listed = await spawn({ provider: 'openrouter', model: SONNET45 });
    const oid = listed.body.agents?.[0]?.id ?? '';
    check('a listed id spawns, kept exactly', listed.status === 201 && getAgent(db, oid)?.model === SONNET45 && getAgentProvider(db, oid) === 'openrouter', JSON.stringify(listed.body).slice(0, 200));
    const anyId = await spawn({ provider: 'copilot', model: 'whatever-copilot-serves' });
    const kid = anyId.body.agents?.[0]?.id ?? '';
    check("a provider that couldn't be asked refuses nothing", anyId.status === 201 && getAgent(db, kid)?.model === 'whatever-copilot-serves', JSON.stringify(anyId.body).slice(0, 200));
    await until(() => tokenRuns.length === start + 2);
    for (const r of tokenRuns.slice(start)) r.end({ input: 10, output: 10 });
    await until(() => getAgent(db, oid)?.status === 'done' && getAgent(db, kid)?.status === 'done');

    const setModel = (id: string, model: string) => send<{ model?: string; appliesTo?: string; detail?: string }>('POST', `/api/agents/${id}/model`, { model });
    const toGpt = await setModel(oid, 'openai/gpt-5');
    check('the model route takes an id from the agent’s own provider', toGpt.status === 200 && toGpt.body.model === 'openai/gpt-5' && getAgent(db, oid)?.model === 'openai/gpt-5', JSON.stringify(toGpt.body));
    const toClaudeId = await setModel(oid, OPUS);
    check("and refuses one from Claude's, which Claude's check would let through", toClaudeId.status === 400 && /openrouter does not offer/.test(toClaudeId.body.detail ?? '') && refusal(OPUS) === null, JSON.stringify(toClaudeId.body));
    const nick = await setModel(oid, 'opus');
    check('a nickname on it is just an id it does not offer', nick.status === 400 && /openrouter does not offer "opus"/.test(nick.body.detail ?? ''), JSON.stringify(nick.body));
    const empty = await send<{ detail?: string }>('POST', `/api/agents/${oid}/model`, {});
    check('no model → 400, pointing at its provider’s list', empty.status === 400 && empty.body.detail === 'no model was given — pick one from GET /api/models?provider=openrouter.', JSON.stringify(empty.body));
    check('on copilot, which could not be asked, any id is taken', (await setModel(kid, 'gpt-5.5')).status === 200 && getAgent(db, kid)?.model === 'gpt-5.5');
    const claudeNick = await setModel('agt_capped', 'sonnet');
    check("a Claude agent's model is checked as it always was", claudeNick.status === 400 && /is a nickname/.test(claudeNick.body.detail ?? ''), JSON.stringify(claudeNick.body));
    const claudeEmpty = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/model', {});
    check('with the same words when none is given', claudeEmpty.body.detail === 'no model was given — pick one from GET /api/models.', JSON.stringify(claudeEmpty.body));
    forgetProviderModels();
  }
  // The engines registered before the fakes are put back, so later sections see the real ones.
  if (enginesBefore.copilot) registerBackend(enginesBefore.copilot);
  if (enginesBefore.openrouter) registerBackend(enginesBefore.openrouter);

  console.log('\n17o · nobody waits for good on an agent that was stopped or removed (Amendment 88)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const said88 = (jobId: string, agentId: string, text: string) =>
      eventLog().emit({ projectId: pid, jobId, agentId }, { kind: 'text', text });
    const note88 = (id: string) => {
      const p = lastStatus(id);
      return p?.kind === 'status' ? (p.error ?? null) : null;
    };
    const pipeline = (jobId: string, prefix: string) => {
      job(jobId, null);
      setJobStatus(db, jobId, 'working');
      const id = (r: string) => `${prefix}_${r}`;
      fixture(id('arch'), jobId, { role: 'architect', status: 'queued', autonomy: DEFAULT_AUTONOMY });
      fixture(id('dev'), jobId, { role: 'developer', status: 'queued', dependsOn: [id('arch')], autonomy: DEFAULT_AUTONOMY });
      fixture(id('val'), jobId, { role: 'validator', status: 'queued', dependsOn: [id('dev')], autonomy: DEFAULT_AUTONOMY });
      fixture(id('rev'), jobId, { role: 'reviewer', status: 'queued', dependsOn: [id('dev'), id('val')], autonomy: DEFAULT_AUTONOMY });
      fixture(id('scr'), jobId, { role: 'scribe', status: 'queued', dependsOn: [id('rev')], autonomy: DEFAULT_AUTONOMY });
      return id;
    };

    // The pure rules first.
    const n = (id: string, dependsOn: string[], o: Partial<StackNode> = {}): StackNode => ({ id, dependsOn, status: 'queued', sdkSessionId: null, ...o });
    const chain = [n('a', [], { status: 'done', sdkSessionId: 's' }), n('b', ['a']), n('c', ['b'])];
    check('A→B→C, remove B: C waits on A', JSON.stringify(rewireOnRemoval(chain, 'b')) === '[{"agentId":"c","dependsOn":["a"]}]', JSON.stringify(rewireOnRemoval(chain, 'b')));
    check(
      'nothing twice, and not the removed one’s helpers',
      JSON.stringify(rewireOnRemoval([n('a', []), n('h', [], { parentId: 'b' }), n('b', ['a', 'h']), n('c', ['a', 'b'])], 'b')) === '[{"agentId":"c","dependsOn":["a"]}]',
    );
    check('one that has started is left alone', rewireOnRemoval([n('a', []), n('b', ['a']), n('c', ['b'], { status: 'working', sdkSessionId: 's' })], 'b').length === 0);
    check('a paused one that never ran is rewired', rewireOnRemoval([n('b', []), n('c', ['b'], { status: 'paused' })], 'b')[0]?.dependsOn.length === 0);
    const graph = [n('a', [], { status: 'paused' }), n('b', ['a']), n('c', ['b']), n('d', ['x']), n('e', [], { status: 'working' }), n('f', ['e'])];
    check('queued behind a paused one, directly or further up, is stuck', isStuck(graph[1]!, graph) && isStuck(graph[2]!, graph));
    check('so is one behind an agent that is gone', isStuck(graph[3]!, graph));
    check('one behind a working one is not', !isStuck(graph[5]!, graph));
    check("an orchestrator behind its own stopped helper is not (Amendment 51)", !isStuck(n('o', ['h']), [n('o', ['h']), n('h', [], { status: 'stopped', parentId: 'o' })]));

    // The repro: a full pipeline, the architect stopped mid-run.
    const start = runs.length;
    const p = pipeline('job_strand', 's88');
    sup.pump();
    check('the architect starts, and only it', await until(() => runs.length === start + 1) && getAgent(db, p('dev'))?.status === 'queued');
    await until(() => (runs[start]?.prompts.length ?? 0) > 0);
    said88('job_strand', p('arch'), 'Plan: half of it, in PLAN.md.');
    const stop = await send('POST', `/api/agents/${p('arch')}/terminate`, {});
    await settle(100);
    check('stopping it → 200', stop.status === 200 && getAgent(db, p('arch'))?.status === 'stopped');
    check('the developer waiting on it is paused, not left waiting for good', getAgent(db, p('dev'))?.status === 'paused');
    check('and says why, and what to do', note88(p('dev')) === strandNote('architect') && note88(p('dev')) === 'waits for architect, which was stopped — resume to run without it, or remove it', String(note88(p('dev'))));
    check('the ones further down wait on the developer, as they should', ['val', 'rev', 'scr'].every((r) => getAgent(db, p(r))?.status === 'queued'));
    check('nothing new started: no money spent unasked', runs.length === start + 1 && sup.slots.used === 0);
    check('and the job settles, since nothing in it can move by itself', getJob(db, 'job_strand')?.status === 'done', getJob(db, 'job_strand')?.status);
    const waiting88 = alerts().list().filter((a) => a.kind === 'blocked_dep' && a.agentIds[0] === p('dev'));
    check('Needs You has it: the developer, waiting on a stopped architect', waiting88.length === 1 && waiting88[0]?.cause === 'stopped' && waiting88[0].blockedBy === p('arch'), JSON.stringify(waiting88));

    const resumed = await send('POST', `/api/agents/${p('dev')}/resume`, {});
    check('resuming it → 200, and it runs', resumed.status === 200 && (await until(() => runs.length === start + 2)));
    const devRun = runs[start + 1];
    await until(() => (devRun?.prompts.length ?? 0) > 0);
    check('without the architect: it no longer waits on it', getAgent(db, p('dev'))?.dependsOn.length === 0);
    check(
      'and hears what the architect wrote, marked stopped, as a helper report would say it',
      (devRun?.prompts[0] ?? '').includes('[architect — stopped, so it may not have finished its part]\nAgent: Plan: half of it, in PLAN.md.') &&
        (devRun?.prompts[0] ?? '').includes('without waiting for every agent before you'),
      devRun?.prompts[0],
    );
    check('the job is open again', getJob(db, 'job_strand')?.status === 'working');
    check('and the alert has cleared', !alerts().list().some((a) => a.kind === 'blocked_dep' && a.agentIds[0] === p('dev')));
    handOffAs(p('dev'));
    devRun?.finish({ cost: 0, reason: 'completed' });
    check('once it is done, the rest of the pipeline goes on', await until(() => runs.length === start + 3) && getAgent(db, p('val'))?.status === 'working');
    await send('POST', '/api/jobs/job_strand/terminate', {});
    check('stopping the whole job pauses nobody: it stops them all', ['dev', 'val', 'rev', 'scr'].every((r) => ['stopped', 'done'].includes(getAgent(db, p(r))?.status ?? '')), JSON.stringify(['dev', 'val', 'rev', 'scr'].map((r) => getAgent(db, p(r))?.status)));

    // Rows from before the fix: queued behind a stopped or a deleted agent. A restart pauses them.
    job('job_legacy', null);
    setJobStatus(db, 'job_legacy', 'working');
    fixture('agt_old_stop', 'job_legacy', { role: 'analyst', status: 'stopped' });
    fixture('agt_old_wait', 'job_legacy', { role: 'scribe', status: 'queued', dependsOn: ['agt_old_stop'], autonomy: DEFAULT_AUTONOMY });
    fixture('agt_old_gone', 'job_legacy', { role: 'reviewer', status: 'queued', dependsOn: ['agt_never_was'], autonomy: DEFAULT_AUTONOMY });
    const before = runs.length;
    sup.reconcile();
    check('a restart pauses one queued behind a stopped agent', getAgent(db, 'agt_old_wait')?.status === 'paused' && note88('agt_old_wait') === strandNote('analyst'));
    check('and one behind an agent that is gone', getAgent(db, 'agt_old_gone')?.status === 'paused' && note88('agt_old_gone') === strandNote(null));
    sup.pump();
    await settle(100);
    check('and starts neither', runs.length === before);

    // Removing the stopped one is the say-so: who waited on it, and was paused for it, goes on.
    const rm = await send<RemoveAgentResponse>('DELETE', '/api/agents/agt_old_stop');
    check('removing it says who now waits on what', rm.status === 200 && JSON.stringify(rm.body.rewired) === '[{"agentId":"agt_old_wait","dependsOn":[]}]', JSON.stringify(rm.body));
    check('and the one paused for it starts', await until(() => runs.length === before + 1) && getAgent(db, 'agt_old_wait')?.status === 'working');
    runs[before]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'agt_old_wait')?.status === 'done');
    await send('POST', '/api/agents/agt_old_gone/resume', {});
    check('resuming one behind a gone agent runs it without', await until(() => runs.length === before + 2) && getAgent(db, 'agt_old_gone')?.dependsOn.length === 0);
    runs[before + 1]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'agt_old_gone')?.status === 'done');

    // Delete a queued middle agent: the one after it waits on the one before, and hears it.
    job('job_rw', null);
    setJobStatus(db, 'job_rw', 'working');
    fixture('agt_rw_a', 'job_rw', { role: 'architect', status: 'working', sdkSessionId: 'sess_rw_a', autonomy: DEFAULT_AUTONOMY });
    fixture('agt_rw_b', 'job_rw', { role: 'developer', status: 'queued', dependsOn: ['agt_rw_a'], autonomy: DEFAULT_AUTONOMY });
    fixture('agt_rw_c', 'job_rw', { role: 'scribe', status: 'queued', dependsOn: ['agt_rw_b'], autonomy: DEFAULT_AUTONOMY });
    const rw = await send<RemoveAgentResponse>('DELETE', '/api/agents/agt_rw_b');
    check('deleting a middle agent rewires the one after it to the one before', rw.status === 200 && JSON.stringify(getAgent(db, 'agt_rw_c')?.dependsOn) === '["agt_rw_a"]' && getAgent(db, 'agt_rw_b') === undefined, JSON.stringify(rw.body));
    check('and it still waits, since the architect is still working', getAgent(db, 'agt_rw_c')?.status === 'queued' && getJob(db, 'job_rw')?.status === 'working');
    said88('job_rw', 'agt_rw_a', 'The plan is in PLAN.md.');
    setAgentStatus(db, 'agt_rw_a', 'done');
    const atRw = runs.length;
    sup.pump();
    await until(() => (runs[atRw]?.prompts.length ?? 0) > 0);
    check('its handoff comes from the architect', (runs[atRw]?.prompts[0] ?? '').includes('[architect]\nAgent: The plan is in PLAN.md.'), runs[atRw]?.prompts[0]);
    runs[atRw]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'agt_rw_c')?.status === 'done');

    // Delete a running agent: its slot is freed and the one after it, rewired to nobody, starts.
    job('job_rw2', null);
    setJobStatus(db, 'job_rw2', 'working');
    fixture('agt_rw2_a', 'job_rw2', { role: 'developer', status: 'queued', autonomy: DEFAULT_AUTONOMY });
    fixture('agt_rw2_b', 'job_rw2', { role: 'reviewer', status: 'queued', dependsOn: ['agt_rw2_a'], autonomy: DEFAULT_AUTONOMY });
    const atRw2 = runs.length;
    sup.pump();
    await until(() => sup.isLive('agt_rw2_a'));
    const used = sup.slots.used;
    const rw2 = await send<RemoveAgentResponse>('DELETE', '/api/agents/agt_rw2_a');
    check('deleting a running agent stops it and removes it', rw2.status === 200 && !sup.isLive('agt_rw2_a') && getAgent(db, 'agt_rw2_a') === undefined);
    check('the one after it starts, in the slot it freed', (await until(() => getAgent(db, 'agt_rw2_b')?.status === 'working')) && sup.slots.used === used && runs.length === atRw2 + 2, `${sup.slots.used} vs ${used}`);
    runs.at(-1)?.finish({ cost: 0, reason: 'completed' });
    check('and the job settles', await until(() => getJob(db, 'job_rw2')?.status === 'done'));

    // Behind a FAILED one it stays queued (Amendment 85), and the job still settles.
    job('job_fail88', null);
    setJobStatus(db, 'job_fail88', 'working');
    fixture('agt_f_dev', 'job_fail88', { role: 'developer', status: 'queued', autonomy: DEFAULT_AUTONOMY });
    fixture('agt_f_rev', 'job_fail88', { role: 'reviewer', status: 'queued', dependsOn: ['agt_f_dev'], autonomy: DEFAULT_AUTONOMY });
    const atF = runs.length;
    sup.pump();
    await until(() => runs.length === atF + 1);
    runs[atF]?.finish({ cost: 0, isError: true, reason: 'error' });
    await until(() => getAgent(db, 'agt_f_dev')?.status === 'failed');
    check('behind a failed one it stays queued', getAgent(db, 'agt_f_rev')?.status === 'queued');
    check('and the job settles failed, rather than saying working for good', getJob(db, 'job_fail88')?.status === 'failed', getJob(db, 'job_fail88')?.status);
    await send('POST', '/api/agents/agt_f_dev/message', { text: 'try again' });
    check('continuing the failed one opens the job again', await until(() => runs.length === atF + 2) && getJob(db, 'job_fail88')?.status === 'working');
    handOffAs('agt_f_dev');
    runs[atF + 1]?.finish({ cost: 0, reason: 'completed' });
    check('and once it is done the one waiting starts', await until(() => getAgent(db, 'agt_f_rev')?.status === 'working'));
    runs.at(-1)?.finish({ cost: 0, reason: 'completed' });
    check('every job here settled', await until(() => ['job_strand', 'job_legacy', 'job_rw', 'job_rw2', 'job_fail88'].every((j) => ['done', 'failed'].includes(getJob(db, j)?.status ?? ''))), JSON.stringify(['job_strand', 'job_legacy', 'job_rw', 'job_rw2', 'job_fail88'].map((j) => getJob(db, j)?.status)));
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log('\n17p · one more agent in a running job (Amendment 89)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    type Added = AddAgentResponse & { detail?: string };
    const add = (jobId: string, body: Record<string, unknown>) => send<Added>('POST', `/api/jobs/${jobId}/agents`, body);
    const five = { ...DEFAULT_AUTONOMY, budgetUsd: 5 };
    const spec = (role: string, o: Record<string, unknown> = {}) => ({ role, model: OPUS, brief: `Do the ${role} part.`, autonomy: five, ...o });
    const runOf = (role: string) => runs.find((r) => (r.prompts[0] ?? '').includes(`Your role is ${role}.`));

    check('a loop is one only through a fed agent upstream', createsCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }], ['b'], ['a']) && !createsCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }], ['a'], ['b']));

    job('job_add', null);
    setJobStatus(db, 'job_add', 'working');
    fixture('agt_add_dev', 'job_add', { role: 'developer', status: 'working', sdkSessionId: 'sess_add_dev', autonomy: five });
    fixture('agt_add_scr', 'job_add', { role: 'scribe', status: 'queued', dependsOn: ['agt_add_dev'], autonomy: five });
    check('two agents at $5: the job is capped at $10', jobCap(agentsForJob(db, 'job_add')) === 10);
    const start = runs.length;

    const mid = await add('job_add', spec('validator', { dependsOnRoles: ['developer'], feeds: ['scribe'] }));
    const vid = mid.body.agent?.id ?? '';
    check('adding one mid-job → 201, queued, waiting on the developer', mid.status === 201 && getAgent(db, vid)?.status === 'queued' && JSON.stringify(getAgent(db, vid)?.dependsOn) === '["agt_add_dev"]', JSON.stringify(mid.body));
    check('the scribe it feeds now waits for it too', mid.body.fed?.[0]?.id === 'agt_add_scr' && JSON.stringify(getAgent(db, 'agt_add_scr')?.dependsOn) === JSON.stringify(['agt_add_dev', vid]));
    check('built as a launch builds it: model, brief, budget', getAgent(db, vid)?.model === OPUS && getAgentBrief(db, vid) === 'Do the validator part.' && getAgent(db, vid)?.autonomy.budgetUsd === 5);
    check("the job's cap grows by its cap", jobCap(agentsForJob(db, 'job_add')) === 15);
    check('it is said to be queued, like any agent', lastStatus(vid)?.kind === 'status' && (lastStatus(vid) as { status?: string }).status === 'queued');

    const refuse = async (label: string, body: Record<string, unknown>, why: RegExp, jobId = 'job_add') => {
      const r = await add(jobId, body);
      check(label, r.status === 400 && why.test(r.body.detail ?? ''), `${r.status} ${JSON.stringify(r.body)}`);
    };
    await refuse('a loop is refused', spec('tester', { dependsOnRoles: ['scribe'], feeds: ['validator'] }), /a loop/);
    await refuse('so is feeding one it waits for', spec('tester', { dependsOnRoles: ['validator'], feeds: ['validator'] }), /a loop/);
    await refuse('a role already in the job is refused', spec('scribe'), /already in this job/);
    await refuse('waiting for a role not in the job is refused', spec('tester', { dependsOnRoles: ['nobody'] }), /nobody, which is not in this job/);
    await refuse('feeding one that has started is refused', spec('tester', { feeds: ['developer'] }), /already started/);
    await refuse('a feed that is not a list is refused', spec('tester', { feeds: 'scribe' }), /feeds is a list/);
    await refuse('an agent with no cap of its own is refused', spec('tester', { autonomy: DEFAULT_AUTONOMY }), /budget of its own/);
    await refuse('a reading role that could write is refused', spec('reviewer'), /reading role, so Edit, Write, MultiEdit, NotebookEdit must be in disallowedTools/);
    await refuse(
      'and one that writes nothing but accepts edits',
      spec('reviewer', { autonomy: { ...five, mode: 'acceptEdits', disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } }),
      /mode is plan or default/,
    );
    await refuse('the model is checked as a launch checks it', spec('tester', { model: 'opus' }), /nickname/);
    let engine = '';
    try {
      sup.addAgent('job_add', { role: 'tester', model: 'gpt-5-mini', provider: 'copilot', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 1000 } });
    } catch (err) {
      engine = (err as Error).message;
    }
    check('another engine than the job’s is refused', /this job runs on claude, so tester must too, not copilot/.test(engine), engine);
    check('an unknown job → 404', (await add('job_nope', spec('tester'))).status === 404);
    const reader = await add('job_add', spec('reviewer', { dependsOnRoles: ['validator'], autonomy: { ...five, mode: 'plan', disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } }));
    check('a reading role that is read-only is taken', reader.status === 201, JSON.stringify(reader.body));
    check('none of the refusals left a row or started anything', agentsForJob(db, 'job_add').length === 4 && runs.length === start, String(agentsForJob(db, 'job_add').length));

    eventLog().emit({ projectId: pid, jobId: 'job_add', agentId: 'agt_add_dev' }, { kind: 'text', text: 'Built it in src/thing.ts.' });
    setAgentStatus(db, 'agt_add_dev', 'done');
    sup.pump();
    check('once the developer is done, the added validator starts', await until(() => runOf('validator') !== undefined && (runOf('validator')?.prompts.length ?? 0) > 0));
    check('and hears the developer', (runOf('validator')?.prompts[0] ?? '').includes('[developer]\nAgent: Built it in src/thing.ts.'), runOf('validator')?.prompts[0]);
    check('the scribe it feeds still waits for it', getAgent(db, 'agt_add_scr')?.status === 'queued');
    handOffAs(vid);
    runOf('validator')?.finish({ cost: 0, reason: 'completed' });
    check('then the scribe and the reviewer start', await until(() => getAgent(db, 'agt_add_scr')?.status === 'working' && getAgent(db, reader.body.agent?.id ?? '')?.status === 'working'));
    for (const r of runs) if (!r.finished) r.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes', await until(() => getJob(db, 'job_add')?.status === 'done'));

    const late = await add('job_add', spec('tester', { dependsOnRoles: ['scribe'] }));
    check('adding one to a finished job → 201, and the job reopens', late.status === 201 && getJob(db, 'job_add')?.status === 'working');
    check('it starts at once: what it waits for is done', await until(() => runOf('tester') !== undefined));
    runOf('tester')?.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes again', await until(() => getJob(db, 'job_add')?.status === 'done'));

    // Behind something that can't move without you, adding one leaves the job settled.
    job('job_add_stuck', null);
    fixture('agt_stuck_dev', 'job_add_stuck', { role: 'developer', status: 'failed', autonomy: five });
    setJobStatus(db, 'job_add_stuck', 'failed');
    const stuck = await add('job_add_stuck', spec('reviewer', { dependsOnRoles: ['developer'], autonomy: { ...five, mode: 'default', disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } }));
    check('behind a failed agent it is added, queued, and the job stays settled', stuck.status === 201 && getAgent(db, stuck.body.agent?.id ?? '')?.status === 'queued' && getJob(db, 'job_add_stuck')?.status === 'failed', `${stuck.status} ${getJob(db, 'job_add_stuck')?.status}`);
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  console.log("\n17q · today's spend reads zero when the day changes (Amendment 103)");
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const eyes = await connect();
    const costFrames = (from: number): number[] => eyes.frames.slice(from).flatMap((f) => (f.type === 'cost' ? [f.costToday] : []));
    const dailyAlerts = async () => (await get<Snapshot>('/api/snapshot')).body.alerts.filter((a) => a.kind === 'daily_budget');
    const spend = async (id: string, dollars: number): Promise<void> => {
      job(`job_${id}`, null);
      fixture(`agt_${id}`, `job_${id}`, { status: 'queued', autonomy: DEFAULT_AUTONOMY });
      const first = runs.length;
      sup.pump();
      await until(() => runs.length === first + 1);
      runs[first]!.finish({ cost: dollars, reason: 'completed' });
    };

    // The watch is the one Alerts started. Its timer is ours to drive while the clock is fake.
    // This section is about the day's spend; midnight's continue (Amendment 140) is off for it,
    // so the budget pauses earlier sections left are not woken by its turns.
    await send('PATCH', '/api/settings', { settings: { [BUDGET_RESUME_KEY]: 'off' } });
    const watch = dayWatch();
    check('the daemon is watching the day', watch !== null);
    watch?.stop();
    let now = new Date(2031, 2, 14, 23, 50, 0); // 14 Mar 2031, ten minutes before midnight
    setDayClock(() => now);
    watch?.check(); // it has seen day 1
    check('the fake clock sets today: it is day 1', localDay() === '2031-03-14', localDay());
    await send('PATCH', '/api/settings', { settings: { 'conductor.dailyBudget': '5' } });

    await spend('midnight_1', 6);
    check('spend on day 1 is told to every tab', await until(() => costFrames(0).some((c) => near(c, 6))), JSON.stringify(costFrames(0)));
    const standing = await dailyAlerts();
    check('it passes the daily budget: the alert stands, with day 1 in its id', standing.length === 1 && standing[0]!.id === 'daily:2031-03-14', JSON.stringify(standing));

    const mark = eyes.frames.length;
    now = new Date(2031, 2, 15, 0, 0, 20); // twenty seconds past midnight
    watch?.start(25);
    check('past midnight, a cost frame carrying 0 goes to every tab', await until(() => costFrames(mark).includes(0)), JSON.stringify(costFrames(mark)));
    await settle(250); // ten more looks
    check('and only once, not on every look', costFrames(mark).length === 1, JSON.stringify(costFrames(mark)));
    check('the standing daily-budget alert clears', (await dailyAlerts()).length === 0);
    check('and every tab hears that', eyes.frames.slice(mark).some((f) => f.type === 'alerts' && !f.alerts.some((a) => a.kind === 'daily_budget')));
    check('a look on the same day sends nothing', watch?.check() === false && costFrames(mark).length === 1);
    check('and a tab that connects now reads 0', (await get<Snapshot>('/api/snapshot')).body.costToday === 0);

    const mark2 = eyes.frames.length;
    await spend('midnight_2', 2);
    check("spend on day 2 shows day 2's total", await until(() => costFrames(mark2).some((c) => near(c, 2))), JSON.stringify(costFrames(mark2)));
    check("and not yesterday's with it", !costFrames(mark2).some((c) => near(c, 8)) && near(costToday(db), 2), `${costToday(db)}`);
    check('under the budget again, so no alert', (await dailyAlerts()).length === 0);
    check("yesterday's total is kept", near(row<{ cost_usd: number }>(db.prepare('SELECT cost_usd FROM cost_daily WHERE day = ?').get('2031-03-14'))?.cost_usd, 6));

    const mark3 = eyes.frames.length;
    now = new Date(2031, 2, 18, 9, 0, 0); // the machine slept through three midnights
    check('a clock that jumps whole days sends a frame', await until(() => costFrames(mark3).length > 0), JSON.stringify(costFrames(mark3)));
    await settle(250);
    check('one frame, carrying that day\'s 0', costFrames(mark3).length === 1 && costFrames(mark3)[0] === 0, JSON.stringify(costFrames(mark3)));

    // The watch itself, with a clock of its own.
    const turns: string[] = [];
    let when = '2031-01-31';
    const unit = new DayWatch((day, was) => turns.push(`${was}>${day}`), () => when);
    check('a first look finds the day it started on', unit.check() === false && turns.length === 0);
    when = '2031-02-01';
    check('the next day is a turn, once', unit.check() === true && unit.check() === false && turns.join() === '2031-01-31>2031-02-01', turns.join());
    when = '2031-02-05';
    check('and a jump of days is one turn', unit.check() === true && turns.join() === '2031-01-31>2031-02-01,2031-02-01>2031-02-05', turns.join());
    unit.start(10);
    when = '2031-02-06';
    check('started, it looks by itself', await until(() => turns.length === 3));
    unit.stop();
    when = '2031-02-07';
    await settle(60);
    check('and stopped, it does not', turns.length === 3);

    await send('PATCH', '/api/settings', { settings: { 'conductor.dailyBudget': null } });
    setDayClock();
    watch?.check();
    watch?.start();
    await send('PATCH', '/api/settings', { settings: { [BUDGET_RESUME_KEY]: null } });
    db.prepare("DELETE FROM cost_daily WHERE day >= '2031-01-01'").run();
    eyes.close();
    sdk.query = realQuery;
  }

  console.log("\n18 · a project's other directories (Amendment 39)");
  /*
   * A project is a list of directories: the first, where its jobs start, and others its
   * agents can reach and the Files screen shows. PKG is a folder INSIDE another repo, so
   * git's paths (repo-root-relative by default) have to be read relative to it.
   */
  const OTHER = `${ROOT}-other`;
  const PKG = join(OTHER, 'pkg');
  const HOME = `${ROOT}-home`;
  rmSync(OTHER, { recursive: true, force: true });
  mkdirSync(PKG, { recursive: true });
  mkdirSync(join(HOME, 'notes'), { recursive: true });
  writeFileSync(join(PKG, 'a.txt'), 'one\n');
  writeFileSync(join(OTHER, 'top.txt'), 'top\n');
  git(['init', '-q', '-b', 'main'], OTHER);
  git(['config', 'user.email', 'verify@conductor.test'], OTHER);
  git(['config', 'user.name', 'verify'], OTHER);
  git(['add', '.'], OTHER);
  git(['commit', '-q', '-m', 'init'], OTHER);
  writeFileSync(join(PKG, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(OTHER, 'top.txt'), 'top\nchanged\n');

  type DirsReply = { project: Project; existing?: boolean; error?: string };
  const dirs = `/api/projects/${pid}/dirs`;
  check('no path → 400', (await send<DirsReply>('POST', dirs, { path: '  ' })).status === 400);
  check('a path that is not there → 400', (await send<DirsReply>('POST', dirs, { path: join(ROOT, 'nope') })).status === 400);
  check('a file, not a directory → 400', (await send<DirsReply>('POST', dirs, { path: join(ROOT, 'README.md') })).status === 400);
  check('an unknown project → 404', (await send<DirsReply>('POST', '/api/projects/prj_nope/dirs', { path: PKG })).status === 404);

  const ws18 = await connect();
  const addedDir = await send<DirsReply>('POST', dirs, { path: `${PKG}/` });
  check('adding a directory → 201, and the project lists it', addedDir.status === 201 && JSON.stringify(addedDir.body.project.extraDirs) === JSON.stringify([PKG]), JSON.stringify(addedDir.body));
  await settle();
  check(
    'every browser hears the project changed',
    ws18.frames.some((f) => f.type === 'entities' && (f.projects ?? []).some((p) => p.id === pid && (p.extraDirs ?? []).includes(PKG))),
  );
  const twice18 = await send<DirsReply>('POST', dirs, { path: PKG });
  check('adding it again is not an error: 200, existing', twice18.status === 200 && twice18.body.existing === true && twice18.body.project.extraDirs?.length === 1);
  const first18 = await send<DirsReply>('POST', dirs, { path: ROOT });
  check('nor is adding the first directory', first18.status === 200 && first18.body.existing === true && first18.body.project.extraDirs?.length === 1);

  const realHome = process.env['HOME'];
  process.env['HOME'] = HOME;
  const tilde = await send<DirsReply>('POST', dirs, { path: '~/notes' });
  process.env['HOME'] = realHome;
  check('`~` is home, the way the completion list offered it', tilde.status === 201 && tilde.body.project.extraDirs?.includes(join(HOME, 'notes')) === true, JSON.stringify(tilde.body));
  const listed18 = await get<{ projects: Project[] }>('/api/projects');
  check('GET /api/projects carries them', listed18.body.projects.find((p) => p.id === pid)?.extraDirs?.length === 2);

  /*
   * A new project with its referenced folders in one request (Amendment 45) — what the
   * Fleet "add a project" form sends. A fresh main folder, so it cannot collide.
   */
  const NEWMAIN = `${ROOT}-newmain`;
  rmSync(NEWMAIN, { recursive: true, force: true });
  mkdirSync(NEWMAIN, { recursive: true });
  const before45 = (await get<{ projects: Project[] }>('/api/projects')).body.projects.length;
  const bad45 = await send<DirsReply>('POST', '/api/projects', { path: NEWMAIN, dirs: [PKG, join(ROOT, 'nope')] });
  const after45 = (await get<{ projects: Project[] }>('/api/projects')).body.projects.length;
  check('one missing referenced folder refuses the whole project — 400, and nothing is created', bad45.status === 400 && after45 === before45, `${bad45.status} ${before45}→${after45}`);
  const file45 = await send<DirsReply>('POST', '/api/projects', { path: NEWMAIN, dirs: [join(ROOT, 'README.md')] });
  check('so does a file where a folder was meant', file45.status === 400);
  check('dirs that are not a list of paths → 400', (await send<DirsReply>('POST', '/api/projects', { path: NEWMAIN, dirs: 'x' })).status === 400);
  process.env['HOME'] = HOME;
  const made45 = await send<DirsReply>('POST', '/api/projects', {
    path: NEWMAIN,
    name: 'with refs',
    dirs: [PKG, `${PKG}/`, NEWMAIN, '~/notes', ''],
  });
  process.env['HOME'] = realHome;
  check(
    'a project is created with its main folder and its referenced ones, deduplicated, in order',
    made45.status === 201 &&
      made45.body.project.path === NEWMAIN &&
      JSON.stringify(made45.body.project.extraDirs) === JSON.stringify([PKG, join(HOME, 'notes')]),
    JSON.stringify(made45.body.project),
  );
  check('its name is the one given', made45.body.project.name === 'with refs');
  const again45 = await send<DirsReply>('POST', '/api/projects', { path: NEWMAIN, dirs: [OTHER] });
  check(
    'creating it again reports the existing project and changes nothing about it',
    again45.status === 200 && again45.body.existing === true && again45.body.project.extraDirs?.length === 2,
    JSON.stringify(again45.body),
  );
  const del45 = await send('DELETE', `/api/projects/${made45.body.project.id}`);
  check('and it can be removed again, leaving the folders alone', del45.status === 200 && existsSync(NEWMAIN) && existsSync(PKG), String(del45.status));

  const read = `/api/projects/${pid}/dir`;
  const q = (dir: string, path?: string) =>
    `?dir=${encodeURIComponent(dir)}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ''}`;
  check('a read with no dir → 400', (await get(`${read}/tree`)).status === 400);
  check('a directory the project does not have → 404', (await get(`${read}/tree${q(OTHER)}`)).status === 404);
  check('the first directory is readable too', (await get<FileTreeResponse>(`${read}/tree${q(ROOT)}`)).status === 200);
  const tree18 = await get<FileTreeResponse>(`${read}/tree${q(PKG)}`);
  const a18 = tree18.body.root?.children?.find((n) => n.path === 'a.txt');
  check(
    "a folder inside a repo shows its own changes, by its own paths, and not the repo's others",
    tree18.status === 200 && a18?.change?.added === 1 && tree18.body.changedFiles === 1,
    JSON.stringify({ status: tree18.status, changed: tree18.body.changedFiles, a: a18 }),
  );
  const diff18 = await get<DiffResponse>(`${read}/diff${q(PKG)}`);
  check(
    'and its diff is the same folder, relative to it',
    diff18.status === 200 && diff18.body.diff.includes('a/a.txt') && !diff18.body.diff.includes('top.txt') && diff18.body.files === 1,
    diff18.body.diff,
  );
  const file18 = await get<FileContentResponse>(`${read}/file${q(PKG, 'a.txt')}`);
  check('a file reads with its diff', file18.status === 200 && file18.body.raw === 'one\ntwo\n' && (file18.body.diff ?? '').includes('+two'));
  check('a read cannot climb out of the directory', (await get(`${read}/file${q(PKG, '../top.txt')}`)).status === 400);
  check('a file read needs a path', (await get(`${read}/file${q(PKG)}`)).status === 400);
  const put18 = await send('PUT', `${read}/file${q(PKG)}`, { path: 'a.txt', content: 'edited\n' });
  check('and a file can be saved there', put18.status === 200 && readFileSync(join(PKG, 'a.txt'), 'utf8') === 'edited\n', String(put18.status));

  // What the agents are given: the other directories that are still there.
  sdk.query = fakeQuery as typeof sdk.query;
  runs.length = 0;
  rmSync(join(HOME, 'notes'), { recursive: true, force: true });
  job('job_dirs', null);
  fixture('agt_dirs', 'job_dirs', { role: 'builder', status: 'queued', autonomy: DEFAULT_AUTONOMY });
  sup.pump();
  await until(() => runs.length > 0);
  check('it starts in the first directory', runs[0]?.options.cwd === ROOT, String(runs[0]?.options.cwd));
  check(
    'and can reach the others that are still there — a missing one is left out, not a failed run',
    JSON.stringify(runs[0]?.options.additionalDirectories) === JSON.stringify([PKG]),
    JSON.stringify(runs[0]?.options.additionalDirectories),
  );
  runs[0]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_dirs')?.status === 'done');
  sdk.query = realQuery;
  check('a gone directory is said to be gone, not empty', (await get(`${read}/tree${q(join(HOME, 'notes'))}`)).status === 410);

  check(
    "an edit outside the worktree is not reported as the worktree's",
    fileEditFromTool('Write', { file_path: join(PKG, 'b.txt'), content: 'x\n' }, ROOT) === null &&
      relPath(ROOT, join(PKG, 'b.txt')) === join(PKG, 'b.txt') &&
      relPath(ROOT, join(ROOT, 'src', 'x.ts')) === 'src/x.ts',
  );

  const unDir = (path: string) => send<DirsReply>('DELETE', `${dirs}?path=${encodeURIComponent(path)}`);
  const firstDir = (await send<{ detail?: string }>('DELETE', `${dirs}?path=${encodeURIComponent(ROOT)}`)).body;
  check(
    'the first directory cannot be removed this way, and it says what to do instead',
    (firstDir.detail ?? '').includes("change the project's path"),
    firstDir.detail,
  );
  check('removing needs a path', (await send('DELETE', dirs)).status === 400);
  const forgot = await unDir(PKG);
  check('removing one → 200, and the project no longer lists it', forgot.status === 200 && !(forgot.body.project.extraDirs ?? []).includes(PKG));
  check('and touches nothing on disk', readFileSync(join(PKG, 'a.txt'), 'utf8') === 'edited\n' && existsSync(join(OTHER, '.git')));
  check('removing it twice → 400', (await unDir(PKG)).status === 400);
  check('its reads are refused once it is gone from the project', (await get(`${read}/tree${q(PKG)}`)).status === 404);

  await send('POST', dirs, { path: PKG });
  const moved = await send<{ project: Project }>('PATCH', `/api/projects/${pid}`, { path: PKG });
  check(
    'making a directory the first one takes it off the others',
    moved.status === 200 && moved.body.project.path === PKG && !(moved.body.project.extraDirs ?? []).includes(PKG),
    JSON.stringify(moved.body),
  );
  const dirRows = (): number => count(db, 'SELECT COUNT(*) AS n FROM project_dirs WHERE project_id = ?', pid);
  check('the other directories are rows of their own', dirRows() === 1);
  await send('DELETE', `/api/projects/${pid}`);
  check('removing the project forgets them with it', dirRows() === 0 && existsSync(PKG) && existsSync(HOME));
  rmSync(OTHER, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });

  console.log('\n19 · re-run the agents after one, from here (Amendment 102)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    // Section 18 removed the project the earlier sections used, so this one has its own.
    const rpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'rerun' })).body.project.id;
    const rjob = (id: string): void => {
      insertJob(db, { id, projectId: rpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const rfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: rpid, ...a });
    const say = (jobId: string, agentId: string, text: string): void => {
      eventLog().emit({ projectId: rpid, jobId, agentId }, { kind: 'text', text });
    };
    type Rerun = RerunResponse & { error?: string; detail?: string };
    const rerun = (id: string) => send<Rerun>('POST', `/api/agents/${id}/rerun`, {});
    const statusOf = (id: string) => getAgent(db, id)?.status;
    const noteOf = (id: string) => {
      const p = lastStatus(id);
      return p?.kind === 'status' ? (p.error ?? null) : null;
    };

    // The pure rules first: what is after an agent, and in what order.
    const nd = (id: string, role: string, dependsOn: string[], o: Partial<RerunNode> = {}): RerunNode => ({ id, role, dependsOn, status: 'done', sdkSessionId: `s_${id}`, ...o });
    const listed = rerunPlan([nd('c', 'scribe', ['b']), nd('b', 'validator', ['a']), nd('a', 'architect', []), nd('x', 'analyst', [])], 'a', { hasReply: true });
    check('everything after it is listed in dependency order, however the job lists it, and nothing else', JSON.stringify(listed.steps.map((s) => s.role)) === '["validator","scribe"]' && listed.refusal === null, JSON.stringify(listed));
    const diamond = rerunPlan([nd('a', 'architect', []), nd('b', 'developer', ['a']), nd('c', 'reviewer', ['a']), nd('d', 'scribe', ['b', 'c'])], 'a', { hasReply: true });
    check('an agent comes after every agent it waits for', JSON.stringify(diamond.steps.map((s) => s.role)) === '["developer","reviewer","scribe"]' && JSON.stringify(diamond.steps[2]?.after) === '["developer","reviewer"]', JSON.stringify(diamond.steps));
    check('an agent with nothing after it is refused with a reason', /No agent comes after scribe/.test(rerunPlan([nd('a', 'scribe', [])], 'a', { hasReply: true }).refusal ?? ''));
    check('a running one is marked to be stopped; one that has not started is left alone', JSON.stringify(rerunPlan([nd('a', 'architect', []), nd('b', 'developer', ['a'], { status: 'working' }), nd('c', 'scribe', ['b'], { status: 'queued', sdkSessionId: null })], 'a', { hasReply: true }).steps.map((s) => [s.action, s.stops])) === '[["resume",true],["wait",false]]');
    const noteText = rerunNote(['architect'], [{ role: 'architect', reply: 'Plan v2.' }], 100_000);
    check('the note says the input changed, that nothing was reset, and carries the reply as a first prompt would', noteText.startsWith('Your input changed. architect has said something new') && noteText.includes('Nothing was reset') && noteText.includes('[architect]\nAgent: Plan v2.') && !noteText.includes('You started after'), noteText);
    check('and says it of several', rerunNote(['a', 'b'], [], 100_000).includes('a, b have said something new') && !rerunNote([], [], 100_000).includes('What each said last'));
    check('it asks for the same section a first prompt does, in one place', noteText.includes(handoffSection([{ role: 'architect', reply: 'Plan v2.' }], 100_000, 'Here is what the agents before you said, as it stands now.')));

    // One job: architect → developer → validator, and a scribe that waits for both. The
    // developer is running, as it is when you have been talking to it.
    rjob('job_rerun');
    rfix('rr_arch', 'job_rerun', { role: 'architect', status: 'done', sdkSessionId: 'sess_rr_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('rr_dev', 'job_rerun', { role: 'developer', status: 'done', sdkSessionId: 'sess_rr_dev', dependsOn: ['rr_arch'], autonomy: DEFAULT_AUTONOMY });
    rfix('rr_val', 'job_rerun', { role: 'validator', status: 'done', sdkSessionId: 'sess_rr_val', dependsOn: ['rr_dev'], autonomy: DEFAULT_AUTONOMY });
    rfix('rr_doc', 'job_rerun', { role: 'analyst', status: 'done', sdkSessionId: 'sess_rr_doc', autonomy: DEFAULT_AUTONOMY });
    const base = runs.length;

    const silent = await rerun('rr_arch');
    check('an agent that has written nothing yet → 409, and says so', silent.status === 409 && /has not written a reply/.test(silent.body.detail ?? ''), JSON.stringify(silent.body));
    check('an agent that is not there → 404', (await rerun('rr_nobody')).status === 404);

    say('job_rerun', 'rr_arch', 'Plan v1.');
    say('job_rerun', 'rr_arch', 'Plan v2: the tokens expire after an hour.');
    const talk = await send('POST', '/api/agents/rr_dev/message', { text: 'start on the plan' });
    check('the developer is working', talk.status === 200 && (await until(() => runs.length === base + 1)) && statusOf('rr_dev') === 'working');
    const devOld = runs[base]!;
    // Not before the developer is running: with it done, the scribe would start at once.
    rfix('rr_scr', 'job_rerun', { role: 'scribe', status: 'queued', dependsOn: ['rr_dev', 'rr_val'], autonomy: DEFAULT_AUTONOMY });
    const nothing = await rerun('rr_scr');
    check('the last agent has nothing after it → 409, and the reason', nothing.status === 409 && /No agent comes after scribe/.test(nothing.body.detail ?? ''), JSON.stringify(nothing.body));
    check('and so has one on its own branch', (await rerun('rr_doc')).status === 409);


    const sentinel = join(ROOT, 'rerun-sentinel.txt');
    writeFileSync(sentinel, 'built by the developer\n');
    const gitBefore = `${git(['status', '--porcelain'])}\n${git(['rev-parse', 'HEAD'])}`;

    const pressed = await rerun('rr_arch');
    check('re-running from the architect → 200', pressed.status === 200 && pressed.body.from === 'architect', JSON.stringify(pressed.body));
    check(
      'it lists who: the developer (stopped first), the validator, and the scribe, which is left alone, in that order',
      JSON.stringify(pressed.body.agents?.map((a) => [a.role, a.action, a.stopped])) === '[["developer","resume",true],["validator","resume",false],["scribe","wait",false]]',
      JSON.stringify(pressed.body.agents),
    );
    check('the running developer was stopped', devOld.finished);
    check('and a second run took its place, in its own session', (await until(() => runs.length === base + 2)) && runs[base + 1]?.options.resume === 'sess_rr_dev', String(runs[base + 1]?.options.resume));
    await until(() => (runs[base + 1]?.prompts.length ?? 0) > 0);
    const devPrompt = runs[base + 1]?.prompts[0] ?? '';
    check('told its input changed', devPrompt.startsWith('Your input changed. architect has said something new'), devPrompt);
    check('with the architect’s LATEST reply, after the one before it (the whole conversation, Amendment 101)', devPrompt.includes('Agent: Plan v2: the tokens expire after an hour.') && devPrompt.lastIndexOf('Agent: Plan v2') > devPrompt.lastIndexOf('Agent: Plan v1.'), devPrompt);
    check('and that nothing was reset', devPrompt.includes('Nothing was reset'));
    check('it holds one slot: the stopped run gave its own back', sup.slots.used === 1, String(sup.slots.used));
    check('the validator waits until the developer is done again: queued, not started', statusOf('rr_val') === 'queued' && runs.length === base + 2);
    check('and says why it is queued', noteOf('rr_val') === rerunStatusNote('architect') && noteOf('rr_val') === 're-running after architect, whose reply changed', String(noteOf('rr_val')));
    check('the scribe, which had not started, is untouched', statusOf('rr_scr') === 'queued' && getAgent(db, 'rr_scr')?.sdkSessionId === null);
    check('the agent on its own branch is untouched', statusOf('rr_doc') === 'done');
    check(
      'nothing in the worktree was touched: the files, the index and the commit are as they were',
      readFileSync(sentinel, 'utf8') === 'built by the developer\n' && `${git(['status', '--porcelain'])}\n${git(['rev-parse', 'HEAD'])}` === gitBefore,
    );
    check('the session ids are the ones they had', getAgent(db, 'rr_dev')?.sdkSessionId === 'sess_rr_dev' && getAgent(db, 'rr_val')?.sdkSessionId === 'sess_rr_val');

    say('job_rerun', 'rr_dev', 'Fixed it against plan v2.');
    // The note told it to hand off again (Amendment 104); the validator and the scribe wait for that.
    handOffAs('rr_dev', 'Fixed against plan v2; the tests are in tests/auth.test.ts.');
    runs[base + 1]?.finish({ cost: 0, reason: 'completed' });
    check('once the developer is done, the validator resumes in its own session', (await until(() => runs.length === base + 3)) && runs[base + 2]?.options.resume === 'sess_rr_val', String(runs[base + 2]?.options.resume));
    await until(() => (runs[base + 2]?.prompts.length ?? 0) > 0);
    const valPrompt = runs[base + 2]?.prompts[0] ?? '';
    check('told the developer’s NEW reply, which it did not have when you pressed the button', valPrompt.includes('developer has said something new') && valPrompt.includes('Agent: Fixed it against plan v2.'), valPrompt);
    check('and the scribe still waits', statusOf('rr_scr') === 'queued' && runs.length === base + 3);
    say('job_rerun', 'rr_val', 'Checked again: green.');
    handOffAs('rr_val');
    runs[base + 2]?.finish({ cost: 0, reason: 'completed' });
    check('then the scribe, which never ran, starts as it would have: from its prompt', (await until(() => runs.length === base + 4)) && !runs[base + 3]?.options.resume);
    await until(() => (runs[base + 3]?.prompts.length ?? 0) > 0);
    const scrPrompt = runs[base + 3]?.prompts[0] ?? '';
    check('with what the developer and the validator said last', scrPrompt.includes('[developer]') && scrPrompt.includes('Agent: Fixed it against plan v2.') && scrPrompt.includes('[validator]') && scrPrompt.includes('Agent: Checked again: green.') && !scrPrompt.includes('Your input changed'), scrPrompt);
    runs[base + 3]?.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes', await until(() => getJob(db, 'job_rerun')?.status === 'done'), String(getJob(db, 'job_rerun')?.status));
    rmSync(sentinel, { force: true });

    // Refused: nothing is stopped, queued or started.
    const refusedAt = runs.length;
    rjob('job_rerun_no');
    rfix('rn_arch', 'job_rerun_no', { role: 'architect', status: 'working', sdkSessionId: 'sess_rn_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('rn_dev', 'job_rerun_no', { role: 'developer', status: 'done', sdkSessionId: 'sess_rn_dev', dependsOn: ['rn_arch'], autonomy: DEFAULT_AUTONOMY });
    say('job_rerun_no', 'rn_arch', 'A draft.');
    const early = await rerun('rn_arch');
    check('while the agent is still working → 409, to wait for its reply', early.status === 409 && /architect is still working\. Re-run once it has finished/.test(early.body.detail ?? ''), JSON.stringify(early.body));

    rjob('job_rerun_stop');
    rfix('rs_arch', 'job_rerun_stop', { role: 'architect', status: 'done', sdkSessionId: 'sess_rs_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('rs_dev', 'job_rerun_stop', { role: 'developer', status: 'stopped', sdkSessionId: 'sess_rs_dev', dependsOn: ['rs_arch'], autonomy: DEFAULT_AUTONOMY });
    rfix('rs_val', 'job_rerun_stop', { role: 'validator', status: 'done', sdkSessionId: 'sess_rs_val', dependsOn: ['rs_dev'], autonomy: DEFAULT_AUTONOMY });
    say('job_rerun_stop', 'rs_arch', 'The plan.');
    const stoppedOne = await rerun('rs_arch');
    check('an agent after it that was stopped → 409, to remove it first', stoppedOne.status === 409 && /developer was stopped.*Remove it from the stack first/.test(stoppedOne.body.detail ?? ''), JSON.stringify(stoppedOne.body));
    check('and the validator behind it was not queued', statusOf('rs_val') === 'done');

    // Two after it, one of them at its ceiling: refused whole, with the other still running.
    rjob('job_rerun_cap');
    rfix('rc_arch', 'job_rerun_cap', { role: 'architect', status: 'done', sdkSessionId: 'sess_rc_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('rc_dev', 'job_rerun_cap', { role: 'developer', status: 'blocked', blockMode: 'parked', sdkSessionId: 'sess_rc_dev', dependsOn: ['rc_arch'], autonomy: DEFAULT_AUTONOMY });
    rfix('rc_val', 'job_rerun_cap', { role: 'validator', status: 'done', sdkSessionId: 'sess_rc_val', dependsOn: ['rc_dev'], costUsd: 50 });
    const ASKED = { id: 'toolu_rc', name: 'Bash', input: { command: 'make soak' } };
    finishRun(db, startRun(db, 'rc_dev', 'sess_rc_dev'), { terminalReason: 'tool_deferred', deferredTool: ASKED });
    insertRequest(db, {
      id: 'req_rc',
      agentId: 'rc_dev',
      jobId: 'job_rerun_cap',
      projectId: rpid,
      kind: 'permission',
      blockMode: 'parked',
      toolName: 'Bash',
      toolUseId: 'toolu_rc',
      input: { command: 'make soak' },
      label: 'run make soak',
      createdAt: nowIso(),
    });
    say('job_rerun_cap', 'rc_arch', 'The plan, revised.');
    const capped2 = await rerun('rc_arch');
    check('one of them at its ceiling → 409, and the sentence says to raise it', capped2.status === 409 && /validator can't go again\. The Validator has spent \$50 of its \$25 daily budget today, which stops it at \$50 — raise it to continue/.test(capped2.body.detail ?? ''), JSON.stringify(capped2.body));
    check('all or nothing: the parked developer still has its question and was not queued', statusOf('rc_dev') === 'blocked' && openRequestsForAgent(db, 'rc_dev').length === 1 && statusOf('rc_val') === 'done');
    await settle(100);
    check('and nothing started', runs.length === refusedAt);

    setAgentAutonomy(db, 'rc_val', { ...DEFAULT_AUTONOMY, budgetUsd: 50 });
    const raised = await rerun('rc_arch');
    check('with its budget raised → 200', raised.status === 200 && raised.body.agents?.length === 2, JSON.stringify(raised.body));
    check('the question the parked developer was asked about the old input is cancelled', openRequestsForAgent(db, 'rc_dev').length === 0);
    check('and it resumes with the note, where a parked call would have been re-offered with nothing', (await until(() => runs.length === refusedAt + 1)) && runs[refusedAt]?.options.resume === 'sess_rc_dev');
    await until(() => (runs[refusedAt]?.prompts.length ?? 0) > 0);
    check('told its input changed', (runs[refusedAt]?.prompts[0] ?? '').includes('Agent: The plan, revised.'), runs[refusedAt]?.prompts[0]);
    handOffAs('rc_dev');
    runs[refusedAt]?.finish({ cost: 0, reason: 'completed' });
    check('and the validator follows it', (await until(() => runs.length === refusedAt + 2)) && runs[refusedAt + 1]?.options.resume === 'sess_rc_val');
    runs[refusedAt + 1]?.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes', await until(() => getJob(db, 'job_rerun_cap')?.status === 'done'), String(getJob(db, 'job_rerun_cap')?.status));

    // An orchestrator after it, with a helper still working on the old input.
    const atOrch = runs.length;
    rjob('job_rerun_orch');
    rfix('ro_arch', 'job_rerun_orch', { role: 'architect', status: 'done', sdkSessionId: 'sess_ro_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('ro_orch', 'job_rerun_orch', { role: 'developer', status: 'queued', sdkSessionId: 'sess_ro_orch', helperCap: 1, dependsOn: ['ro_arch', 'ro_helper'], autonomy: DEFAULT_AUTONOMY });
    rfix('ro_helper', 'job_rerun_orch', { role: 'developer-helper-1', status: 'working', sdkSessionId: 'sess_ro_helper', parentId: 'ro_orch', autonomy: DEFAULT_AUTONOMY });
    say('job_rerun_orch', 'ro_arch', 'The plan, again.');
    say('job_rerun_orch', 'ro_helper', 'Half of the tokens work.');
    const orch = await rerun('ro_arch');
    check('an orchestrator is re-run, and its working helper is stopped with it', orch.status === 200 && statusOf('ro_helper') === 'stopped', JSON.stringify(orch.body));
    check('the orchestrator resumes in its own session', (await until(() => runs.length === atOrch + 1)) && runs[atOrch]?.options.resume === 'sess_ro_orch');
    await until(() => (runs[atOrch]?.prompts.length ?? 0) > 0);
    const orchPrompt = runs[atOrch]?.prompts[0] ?? '';
    check('told its input changed, and that the helper was stopped, with what it had said', orchPrompt.includes('Your input changed') && orchPrompt.includes('[developer-helper-1 — stopped, so it may not have finished its part]\nAgent: Half of the tokens work.'), orchPrompt);
    runs[atOrch]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getJob(db, 'job_rerun_orch')?.status === 'done');

    // One that failed before it had a session starts from its prompt, which carries the new reply.
    const atFail = runs.length;
    rjob('job_rerun_fail');
    rfix('rf_arch', 'job_rerun_fail', { role: 'architect', status: 'done', sdkSessionId: 'sess_rf_arch', autonomy: DEFAULT_AUTONOMY });
    rfix('rf_dev', 'job_rerun_fail', { role: 'developer', status: 'failed', sdkSessionId: null, dependsOn: ['rf_arch'], autonomy: DEFAULT_AUTONOMY });
    say('job_rerun_fail', 'rf_arch', 'The plan, third time.');
    const failed = await rerun('rf_arch');
    check('one that failed before it had a session is started again', failed.status === 200 && failed.body.agents?.[0]?.action === 'start', JSON.stringify(failed.body));
    check('from its prompt, not a resume, and with the new reply', (await until(() => runs.length === atFail + 1)) && !runs[atFail]?.options.resume && (await until(() => (runs[atFail]?.prompts.length ?? 0) > 0)) && (runs[atFail]?.prompts[0] ?? '').includes('Agent: The plan, third time.'), runs[atFail]?.prompts[0]);
    runs[atFail]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getJob(db, 'job_rerun_fail')?.status === 'done');

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n20 · an agent hands off only by saying so: the hand_off tool (Amendment 104)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    // The project the earlier sections used is gone (section 18), and 19's is the same folder.
    const hpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'handoff' })).body.project.id;
    const hjobRow = (id: string): void => {
      insertJob(db, { id, projectId: hpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const hfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: hpid, ...a });

    // The pure rules: who has agents waiting for it, and so who is given the tool.
    const shape = [
      { id: 'o', dependsOn: ['h'], parentId: null },
      { id: 'h', dependsOn: [] as string[], parentId: 'o' },
      { id: 'n', dependsOn: ['o'], parentId: null },
    ];
    check('the agents that wait for one are the ones its hand_off is for', waitersOf('o', shape).map((a) => a.id).join() === 'n');
    check('an orchestrator is not one: it waits for its helpers by another road (Amendment 51)', waitersOf('h', shape).length === 0);
    check('and an agent nobody waits for has none', waitersOf('n', shape).length === 0);
    const names = (a: Parameters<typeof toolsFor>[0]): string => toolsFor(a).map((t) => t.name).join();
    check(
      'start_helper and list_helpers go to an orchestrator, hand_off to an agent others wait for, both to one that is both, and none to the last agent',
      names({ helperCap: 2 }) === 'start_helper,list_helpers' && names({ handOff: true }) === 'hand_off' &&
        names({ helperCap: 2, handOff: true }) === 'start_helper,list_helpers,hand_off' && names({}) === '' && names({ helperCap: 0, handOff: false }) === '',
    );
    const schema = MCP_TOOLS.find((t) => t.name === 'hand_off')?.inputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined;
    check('hand_off takes a summary, and requires it', JSON.stringify(schema?.required) === '["summary"]' && 'summary' in (schema?.properties ?? {}));
    check('the columns are there, and an agent starts with neither', (() => {
      const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
      return cols.includes('handoff_summary') && cols.includes('handoff_held');
    })());

    // A stack: architect → developer → validator, run by the real supervisor on the fake SDK.
    const hjob = 'job_handoff104';
    hjobRow(hjob);
    hfix('h_arch', hjob, { role: 'architect', status: 'queued', autonomy: DEFAULT_AUTONOMY });
    hfix('h_dev', hjob, { role: 'developer', status: 'queued', dependsOn: ['h_arch'], autonomy: DEFAULT_AUTONOMY });
    hfix('h_val', hjob, { role: 'validator', status: 'queued', dependsOn: ['h_dev'], autonomy: DEFAULT_AUTONOMY });
    const start = runs.length;
    const sayH = (agentId: string, text: string) => eventLog().emit({ projectId: hpid, jobId: hjob, agentId }, { kind: 'text', text });
    const held = () => alerts().list().filter((a) => a.kind === 'handoff_held');
    const mcp = (agentId: string, method: string, params: Record<string, unknown> = {}) =>
      send<{ result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } }>('POST', `/mcp/agents/${agentId}`, { jsonrpc: '2.0', id: 1, method, params });
    const handOffOver = async (agentId: string, summary: string) => {
      const r = (await mcp(agentId, 'tools/call', { name: 'hand_off', arguments: { summary } })).body.result;
      return { text: r?.content?.[0]?.text ?? '', isError: r?.isError === true };
    };
    const handOffRoute = (agentId: string, body: unknown) => send<{ agent?: Agent; error?: string; detail?: string }>('POST', `/api/agents/${agentId}/hand-off`, body);

    sup.pump();
    check('the architect starts, and only it', (await until(() => runs.length === start + 1)) && getAgent(db, 'h_dev')?.status === 'queued');
    const archRun = runs[start]!;
    await until(() => archRun.prompts.length > 0);
    const server = (archRun.options.mcpServers as Record<string, { type: string; url: string }> | undefined)?.['conductor'];
    check('an agent others wait for is given the Conductor tools at a URL naming it', server?.type === 'http' && /\/mcp\/agents\/h_arch$/.test(server.url), JSON.stringify(server));
    check(
      'hand_off is allowed outright, and start_helper is not: it is no orchestrator',
      JSON.stringify((archRun.options.allowedTools ?? []).filter((t) => t.startsWith('mcp__conductor__'))) === '["mcp__conductor__hand_off"]',
      JSON.stringify(archRun.options.allowedTools),
    );
    check('it is told to hand off, after how to ask and before its brief', archRun.prompts[0] === `the ${hjob} prompt\n\n${STACK_ASK_LINE}\n\n${HAND_OFF_LINE}`, archRun.prompts[0]);
    check('tools/list over the endpoint is that agent’s own: hand_off for the architect', JSON.stringify((await mcp('h_arch', 'tools/list')).body.result?.tools?.map((t) => t.name)) === '["hand_off"]');
    check('and none for the validator, which nobody waits for', JSON.stringify((await mcp('h_val', 'tools/list')).body.result?.tools) === '[]');
    const nobody = await handOffOver('h_val', 'x');
    check('the last agent cannot hand off: there is no one to', nobody.isError && /No agent waits for you/.test(nobody.text), nobody.text);
    const blank = await handOffOver('h_arch', '   ');
    check('a hand-off needs a summary', blank.isError && /needs a summary/.test(blank.text), blank.text);
    const huge = await handOffOver('h_arch', 'x'.repeat(20_001));
    check('and not a huge one, which the next prompt would pay for', huge.isError && /20,000/.test(huge.text) && getHandoff(db, 'h_arch').summary === null, huge.text);

    // A turn that ends without hand_off holds. The agent is `done`; the others stay queued.
    sayH('h_arch', 'Plan: use JWT.');
    archRun.finish({ cost: 0, reason: 'completed' });
    check('ending its turn without hand_off: it is done, not a new status', await until(() => getAgent(db, 'h_arch')?.status === 'done'));
    await settle(150);
    check('and the developer stays queued: nothing started', getAgent(db, 'h_dev')?.status === 'queued' && runs.length === start + 1 && sup.slots.used === 0);
    check('with the hold on the agent', getHandoff(db, 'h_arch').held && getHandoff(db, 'h_arch').summary === null);
    const note1 = lastStatus('h_arch');
    check('its status event says why, for the transcript', note1?.kind === 'status' && note1.status === 'done' && note1.error === 'stopped without handing off', JSON.stringify(note1));
    const alert1 = held();
    check(
      'Needs You has it: "stopped without handing off", on the architect',
      alert1.length === 1 && alert1[0]?.agentIds.join() === 'h_arch' && alert1[0].cause === 'stopped without handing off' && alert1[0].jobId === hjob,
      JSON.stringify(alert1),
    );
    check('a page that loads now is given it', (await get<Snapshot>('/api/snapshot')).body.alerts.some((a) => a.kind === 'handoff_held' && a.agentIds[0] === 'h_arch'));
    check('it is the only alert: the developer is not "blocked", the architect did not fail', alerts().list().filter((a) => a.agentIds.some((i) => i.startsWith('h_'))).length === 1);
    check('the job is still working: it is not done while someone is waiting to be handed to', getJob(db, hjob)?.status === 'working', getJob(db, hjob)?.status);

    // It survives a restart: the alert is built from what is stored, and nothing starts by itself.
    initAlerts(db);
    sup.pump();
    await settle(150);
    check('a restart keeps the hold: the alert is still there', held().length === 1 && held()[0]?.id === alert1[0]?.id, JSON.stringify(held()));
    check('and the developer still waits', getAgent(db, 'h_dev')?.status === 'queued' && runs.length === start + 1);
    // A second connection to the same file is what a daemon that has restarted opens.
    const reopened = new DatabaseSync(process.env['CONDUCTOR_DB']!);
    const reborn = new Alerts(reopened).list().filter((a) => a.kind === 'handoff_held');
    check(
      'a daemon that opens the file afresh finds the same hold, built from nothing but what is stored',
      reborn.length === 1 && reborn[0]?.id === alert1[0]?.id && getHandoff(reopened, 'h_arch').held,
      JSON.stringify(reborn),
    );
    reopened.close();

    // Replying to it is the other way out: it works again, and is held again if it still doesn't say.
    const reply = await send<{ delivery: string }>('POST', '/api/agents/h_arch/message', { text: 'also cover the refresh tokens' });
    check('a reply resumes it', reply.body.delivery === 'resumed' && (await until(() => runs.length === start + 2)) && runs[start + 1]?.options.resume === getAgent(db, 'h_arch')?.sdkSessionId);
    check('while it works there is no hold and no alert', !getHandoff(db, 'h_arch').held && held().length === 0 && getAgent(db, 'h_arch')?.status === 'working');
    sayH('h_arch', 'Refresh tokens covered.');
    runs[start + 1]?.finish({ cost: 0, reason: 'completed' });
    check('still no hand_off: held again, and the developer still waits', (await until(() => held().length === 1)) && getAgent(db, 'h_dev')?.status === 'queued' && runs.length === start + 2);
    const alert2 = held()[0]!;
    check('a new hold is a new alert, so putting the first away would not hide it', alert2.id !== alert1[0]?.id);

    // The person hands off, with their own words.
    check('a summary that is not text → 400', (await handOffRoute('h_arch', {})).status === 400);
    check('an agent that is not there → 404', (await handOffRoute('h_nobody', { summary: 'x' })).status === 404);
    const empty = await handOffRoute('h_arch', { summary: '   ' });
    check('an empty one → 409, and it is still held', empty.status === 409 && /needs a summary/.test(empty.body.detail ?? '') && getHandoff(db, 'h_arch').held, JSON.stringify(empty.body));
    check('a huge one → 409', (await handOffRoute('h_arch', { summary: 'x'.repeat(20_001) })).status === 409);
    check('an agent that is not held cannot be handed off → 409', (await handOffRoute('h_dev', { summary: 'x' })).status === 409);
    const sent = await handOffRoute('h_arch', { summary: '  Use JWT, and refresh tokens too (edited).  ' });
    check('handing off with an edited summary → 200', sent.status === 200 && sent.body.agent?.status === 'done', JSON.stringify(sent.body));
    check('the hold and the alert are gone', !getHandoff(db, 'h_arch').held && held().length === 0);
    const note2 = lastStatus('h_arch');
    check('the transcript says a person did it', note2?.kind === 'status' && note2.error === 'handed off by you', JSON.stringify(note2));
    check('the developer starts', await until(() => runs.length === start + 3) && getAgent(db, 'h_dev')?.status === 'working');
    const devRun = runs[start + 2]!;
    await until(() => devRun.prompts.length > 0);
    const devPrompt = devRun.prompts[0] ?? '';
    check('with the summary the person edited, trimmed — not the architect’s last reply as it was', devPrompt.includes('Its summary of its work:\nUse JWT, and refresh tokens too (edited).'), devPrompt);
    check(
      'printed first, above the conversation, which is still there',
      devPrompt.indexOf('Its summary of its work:') < devPrompt.indexOf('Agent: Plan: use JWT.') && devPrompt.includes('Agent: Refresh tokens covered.'),
      devPrompt,
    );
    check('and the developer is told to hand off too, since the validator waits for it', devPrompt.includes(HAND_OFF_LINE));
    check('handing off twice is refused: it already has', (await handOffRoute('h_arch', { summary: 'again' })).status === 409);

    // The developer hands off itself, by the tool, and its turn ends: the validator starts with the summary.
    const said = await handOffOver('h_dev', 'Auth is in src/auth.ts; the tests are not written.');
    check('hand_off over the endpoint is taken, and says who starts', !said.isError && /validator will start once your turn ends/.test(said.text), said.text);
    check('the summary is kept on the agent', getHandoff(db, 'h_dev').summary === 'Auth is in src/auth.ts; the tests are not written.');
    check('and the validator does not start before the turn ends', getAgent(db, 'h_val')?.status === 'queued' && runs.length === start + 3);
    sayH('h_dev', 'Built it.');
    devRun.finish({ cost: 0, reason: 'completed' });
    check('the turn ends: the validator starts', await until(() => runs.length === start + 4) && getAgent(db, 'h_val')?.status === 'working');
    const valRun = runs[start + 3]!;
    await until(() => valRun.prompts.length > 0);
    const valPrompt = valRun.prompts[0] ?? '';
    check('with the developer’s summary first', valPrompt.includes('[developer]\nIts summary of its work:\nAuth is in src/auth.ts; the tests are not written.') && valPrompt.indexOf('Its summary of its work:') < valPrompt.indexOf('Agent: Built it.'), valPrompt);
    check('and no hold on the developer', !getHandoff(db, 'h_dev').held && held().length === 0);
    check('the last agent has no tools and is not told to hand off', valRun.options.mcpServers === undefined && !valPrompt.includes(HAND_OFF_LINE) && !(valRun.options.allowedTools ?? []).some((t) => t.includes('hand_off')), JSON.stringify(valRun.options.allowedTools));
    sayH('h_val', 'All green.');
    valRun.finish({ cost: 0, reason: 'completed' });
    check('the last agent finishes done, as it did, and nothing holds it', (await until(() => getAgent(db, 'h_val')?.status === 'done')) && !getHandoff(db, 'h_val').held && held().length === 0);
    check('and the job finishes', await until(() => getJob(db, hjob)?.status === 'done'), String(getJob(db, hjob)?.status));

    // Re-run from here (Amendment 102). You talk to the architect after it has handed off: that is a new run,
    // and nothing holds it, since the agents after it have all run.
    const chat = await send('POST', '/api/agents/h_arch/message', { text: 'actually, sessions instead of JWT' });
    check('talking to the architect after it handed off is a new run', chat.status === 200 && (await until(() => runs.length === start + 5)));
    check('its last summary was about its last run: it starts without one', getHandoff(db, 'h_arch').summary === null);
    sayH('h_arch', 'Plan v3: sessions, not JWT.');
    runs[start + 4]?.finish({ cost: 0, reason: 'completed' });
    check('and ends done, not held: the developer and the validator have run', (await until(() => getAgent(db, 'h_arch')?.status === 'done')) && !getHandoff(db, 'h_arch').held && held().length === 0);
    await until(() => getJob(db, hjob)?.status === 'done');
    const again = await send<RerunResponse & { detail?: string }>('POST', '/api/agents/h_arch/rerun', {});
    check('so the architect counts as handed off: re-run from it works', again.status === 200 && again.body.agents.map((a) => a.role).join() === 'developer,validator', JSON.stringify(again.body));
    check('the developer resumes in its own session', (await until(() => runs.length === start + 6)) && runs[start + 5]?.options.resume === getAgent(db, 'h_dev')?.sdkSessionId);
    const devAgain = runs[start + 5]!;
    await until(() => devAgain.prompts.length > 0);
    const note = devAgain.prompts[0] ?? '';
    check('told its input changed, with the new reply', note.startsWith('Your input changed.') && note.includes('Agent: Plan v3: sessions, not JWT.'), note);
    check('not the summary from before, which was about the old plan', !note.includes('edited') && getHandoff(db, 'h_dev').summary === null, note);
    check('and told to hand off again, since the validator waits for it', note.includes(HAND_OFF_LINE) && note.includes('Call it again'), note);
    sayH('h_dev', 'Switched to sessions.');
    devAgain.finish({ cost: 0, reason: 'completed' });
    check('the developer ends without hand_off: held, and the validator waits', (await until(() => held().length === 1)) && held()[0]?.agentIds[0] === 'h_dev' && getAgent(db, 'h_val')?.status === 'queued' && runs.length === start + 6);
    const refusedRerun = await send<{ detail?: string }>('POST', '/api/agents/h_dev/rerun', {});
    check('a re-run from the held one is refused, saying to hand off first', refusedRerun.status === 409 && /stopped without handing off.*Hand it off in Needs You/.test(refusedRerun.body.detail ?? ''), JSON.stringify(refusedRerun.body));
    check('the person hands off for it', (await handOffRoute('h_dev', { summary: 'Sessions are in src/session.ts.' })).status === 200);
    check('the validator resumes in its own session', (await until(() => runs.length === start + 7)) && runs[start + 6]?.options.resume === getAgent(db, 'h_val')?.sdkSessionId);
    const valAgain = runs[start + 6]!;
    await until(() => valAgain.prompts.length > 0);
    check(
      'and its re-run note carries that summary, first',
      valAgain.prompts[0]?.startsWith('Your input changed.') === true && (valAgain.prompts[0] ?? '').includes('[developer]\nIts summary of its work:\nSessions are in src/session.ts.'),
      valAgain.prompts[0],
    );
    valAgain.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes', await until(() => getJob(db, hjob)?.status === 'done'), String(getJob(db, hjob)?.status));

    // A failed agent is not held: it failed, and Needs You already says so.
    hjobRow('job_handoff104_fail');
    hfix('hf_a', 'job_handoff104_fail', { role: 'architect', status: 'queued', autonomy: DEFAULT_AUTONOMY });
    hfix('hf_b', 'job_handoff104_fail', { role: 'developer', status: 'queued', dependsOn: ['hf_a'], autonomy: DEFAULT_AUTONOMY });
    const atFail = runs.length;
    sup.pump();
    await until(() => runs.length === atFail + 1);
    runs[atFail]?.finish({ cost: 0, isError: true, reason: 'error' });
    await until(() => getAgent(db, 'hf_a')?.status === 'failed');
    check('an agent that failed is failed, not held', !getHandoff(db, 'hf_a').held && held().length === 0 && alerts().list().some((a) => a.kind === 'failed' && a.agentIds[0] === 'hf_a'));

    // A restart is the likeliest reason an agent forgot: asked once, itself, before you are (Amendment 119).
    check('the restart nudge says background work was stopped with it', /background/.test(RESTART_NUDGE) && /do not end your turn/.test(RESTART_NUDGE), RESTART_NUDGE);
    hjobRow('job_handoff119');
    hfix('hr_a', 'job_handoff119', { role: 'analyst', status: 'working', sdkSessionId: 'sess_hr_a', autonomy: DEFAULT_AUTONOMY });
    hfix('hr_b', 'job_handoff119', { role: 'developer', status: 'queued', dependsOn: ['hr_a'], autonomy: DEFAULT_AUTONOMY });
    const at119 = runs.length;
    sup.reconcile();
    sup.pump();
    check('a restart resumes the analyst in its own session', await until(() => runs.slice(at119).some((r) => r.options.resume === 'sess_hr_a')));
    const hr1 = runs.slice(at119).find((r) => r.options.resume === 'sess_hr_a')!;
    await until(() => hr1.prompts.length > 0);
    check('told a restart stopped it', hr1.prompts[0] === RESTART_NUDGE, JSON.stringify(hr1.prompts));
    const before119 = runs.length;
    hr1.finish({ cost: 0, reason: 'completed' });
    check('it ends its turn without hand_off: it is asked, in the same session, not held', await until(() => runs.length === before119 + 1) && runs.at(-1)?.options.resume === 'sess_hr_a');
    const hr2 = runs.at(-1)!;
    await until(() => hr2.prompts.length > 0);
    check('and what it is told is to hand off', hr2.prompts[0] === HANDOFF_ASK, JSON.stringify(hr2.prompts));
    check(
      'meanwhile it is working, nothing is held, no alert, and the developer waits',
      getAgent(db, 'hr_a')?.status === 'working' && !getHandoff(db, 'hr_a').held && held().length === 0 && getAgent(db, 'hr_b')?.status === 'queued',
      String(getAgent(db, 'hr_a')?.status),
    );
    hr2.finish({ cost: 0, reason: 'completed' });
    check('ending that turn without it as well: it is held, as before', await until(() => getAgent(db, 'hr_a')?.status === 'done' && getHandoff(db, 'hr_a').held));
    await settle(150);
    check(
      'asked once: no third run, the developer waits, and Needs You has it',
      runs.length === before119 + 1 && getAgent(db, 'hr_b')?.status === 'queued' && held().some((a) => a.agentIds[0] === 'hr_a'),
      `${runs.length - before119} runs`,
    );

    // One that does hand off after the restart is not asked, and what waits for it starts.
    hjobRow('job_handoff119_ok');
    hfix('hq_a', 'job_handoff119_ok', { role: 'analyst', status: 'working', sdkSessionId: 'sess_hq_a', autonomy: DEFAULT_AUTONOMY });
    hfix('hq_b', 'job_handoff119_ok', { role: 'developer', status: 'queued', dependsOn: ['hq_a'], autonomy: DEFAULT_AUTONOMY });
    const atOk = runs.length;
    sup.reconcile();
    sup.pump();
    await until(() => runs.slice(atOk).some((r) => r.options.resume === 'sess_hq_a'));
    const hq1 = runs.slice(atOk).find((r) => r.options.resume === 'sess_hq_a')!;
    check('it hands off', !(await handOffOver('hq_a', 'Findings are in notes.md.')).isError);
    hq1.finish({ cost: 0, reason: 'completed' });
    check('and the developer starts, with no second request to the analyst', (await until(() => getAgent(db, 'hq_b')?.status === 'working')) && !runs.slice(atOk).some((r) => r !== hq1 && r.options.resume === 'sess_hq_a'));
    check('the analyst is done and not held', getAgent(db, 'hq_a')?.status === 'done' && !getHandoff(db, 'hq_a').held);

    // Nothing that is not a restart resume is asked: an ordinary turn that ends without it is held at once
    // (the first check in this section), and a person's reply to a held agent works it again as before.

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n21 · the hold on the wire, a re-run note that outlives a restart, real windows, and text said once (Amendment 120)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const lpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'l120' })).body.project.id;
    const ljob = (id: string): void => {
      insertJob(db, { id, projectId: lpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const lfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: lpid, autonomy: DEFAULT_AUTONOMY, ...a });
    const sayL = (jobId: string, agentId: string, text: string): void => {
      eventLog().emit({ projectId: lpid, jobId, agentId }, { kind: 'text', text });
    };
    const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

    // A second Supervisor on this database pumps every queued agent in it: nothing else may be queued.
    // (Queued behind a failed or a held agent, as 20's are, it is not started by anyone.)
    const strangers = listAgents(db)
      .filter((a) => a.status === 'queued' && a.dependsOn.every((d) => getAgent(db, d)?.status === 'done' && !getHandoff(db, d).held))
      .map((a) => a.id);
    check('nothing from the sections before is waiting to start, so a second Supervisor starts only what this one puts there (Amendment 120)', strangers.length === 0, strangers.join());

    // ── the hold, on the wire; a restart that is a second Supervisor ──────────
    const ws = await connect();
    await settle(100); // the subscription is taken on the daemon's next turn, not when the socket opens
    const jobH = 'job_l120_hold';
    ljob(jobH);
    lfix('l_arch', jobH, { role: 'architect', status: 'queued' });
    lfix('l_dev', jobH, { role: 'developer', status: 'queued', dependsOn: ['l_arch'] });
    const atH = runs.length;
    sup.pump();
    check('the architect starts, and only it', (await until(() => runs.length === atH + 1)) && getAgent(db, 'l_dev')?.status === 'queued');
    check('an agent that is not held has no such field on it (Amendment 120)', !('handoffHeld' in getAgent(db, 'l_arch')!));
    sayL(jobH, 'l_arch', 'Plan: sessions, not JWT.');
    runs[atH]!.finish({ cost: 0, reason: 'completed' });
    check('its turn ends without hand_off: done and held', await until(() => getAgent(db, 'l_arch')?.status === 'done' && getHandoff(db, 'l_arch').held));
    check('the hold is on the agent the wire carries: handoffHeld, and only while it is true (Amendment 120)', getAgent(db, 'l_arch')?.handoffHeld === true && !('handoffHeld' in getAgent(db, 'l_dev')!));
    check(
      'a page that loads now is sent it',
      (await get<Snapshot>('/api/snapshot')).body.agents.some((a) => a.id === 'l_arch' && a.handoffHeld === true),
    );
    await settle(100);
    const pushedHeld = ws.frames.filter((f): f is Extract<ServerFrame, { type: 'entities' }> => f.type === 'entities').flatMap((f) => f.agents ?? []).filter((a) => a.id === 'l_arch');
    check('and one that is open is pushed it, in the entities frame that carries the agent as it ends (Amendment 120)', pushedHeld.at(-1)?.status === 'done' && pushedHeld.at(-1)?.handoffHeld === true, JSON.stringify(pushedHeld.at(-1)));

    // The one rule, in shared: what the button is disabled with is what the daemon says.
    const heldPlan = rerunPlan(agentsForJob(db, jobH), 'l_arch', { hasReply: true });
    check(
      'rerunPlan refuses a held agent and still lists who is after it, so the button is there, disabled (Amendment 120)',
      heldPlan.steps.map((s) => s.role).join() === 'developer' && /stopped without handing off, so the agents after it haven't started\. Hand it off in Needs You first\./.test(heldPlan.refusal ?? ''),
      JSON.stringify(heldPlan),
    );
    const heldHttp = await send<{ detail?: string }>('POST', '/api/agents/l_arch/rerun', {});
    check('the daemon answers 409 with that very sentence', heldHttp.status === 409 && heldHttp.body.detail === heldPlan.refusal, JSON.stringify(heldHttp.body));
    check('nothing was stopped, queued or started', getAgent(db, 'l_dev')?.status === 'queued' && runs.length === atH + 1);
    check(
      'it is only for an agent that is done and held (Amendment 120)',
      heldRefusal({ role: 'x', status: 'done' }) === null && heldRefusal({ role: 'x', status: 'working', handoffHeld: true }) === null && heldRefusal({ role: 'x', status: 'done', handoffHeld: true }) !== null,
    );

    // A restart: a second Supervisor, on a second connection to the file, knowing only what is stored.
    const reopened = new DatabaseSync(process.env['CONDUCTOR_DB']!);
    const sup2 = new Supervisor(reopened);
    check('a daemon that opens the file afresh finds the hold on the agent it sends (Amendment 120)', getAgent(reopened, 'l_arch')?.handoffHeld === true && getHandoff(reopened, 'l_arch').held);
    sup2.pump();
    await settle(150);
    check('a second Supervisor pumping starts nothing: a held agent does not count as done there either (Amendment 120)', runs.length === atH + 1 && getAgent(reopened, 'l_dev')?.status === 'queued');
    const refusedBy2 = await sup2.rerunFrom('l_arch').then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    check('and it refuses a re-run with the same sentence', refusedBy2 === heldPlan.refusal, String(refusedBy2));
    const handed = sup2.handOffByUser('l_arch', '  Sessions, in src/session.ts.  ');
    check('a hand-off through it clears the hold and starts the developer — in the second Supervisor (Amendment 120)', handed.status === 'done' && handed.handoffHeld === undefined && (await until(() => runs.length === atH + 2)));
    const devRunL = runs[atH + 1]!;
    await until(() => devRunL.prompts.length > 0);
    check('with the summary the person sent, trimmed and first', (devRunL.prompts[0] ?? '').includes('[architect]\nIts summary of its work:\nSessions, in src/session.ts.'), devRunL.prompts[0]);
    check('the first connection to the file sees it: the field is gone and the developer works', getAgent(db, 'l_arch')?.handoffHeld === undefined && getAgent(db, 'l_dev')?.status === 'working');
    await settle(100);
    const pushedFree = ws.frames.filter((f): f is Extract<ServerFrame, { type: 'entities' }> => f.type === 'entities').flatMap((f) => f.agents ?? []).filter((a) => a.id === 'l_arch');
    check('and an open page is pushed the agent without it', pushedFree.at(-1)?.handoffHeld === undefined && pushedFree.at(-1)?.status === 'done', JSON.stringify(pushedFree.at(-1)));
    devRunL.finish({ cost: 0, reason: 'completed' });
    check('the developer, which nobody waits for, ends done', await until(() => getAgent(db, 'l_dev')?.status === 'done'));
    reopened.close();
    ws.close();

    // ── the re-run note, in the row, so a restart between the press and the start keeps it ──
    const jobN = 'job_l120_note';
    ljob(jobN);
    lfix('n_arch', jobN, { role: 'architect', status: 'done', sdkSessionId: 'sess_n_arch' });
    lfix('n_dev', jobN, { role: 'developer', status: 'done', sdkSessionId: 'sess_n_dev', dependsOn: ['n_arch'] });
    sayL(jobN, 'n_arch', 'Plan v1.');
    sayL(jobN, 'n_arch', 'Plan v2: the tokens expire after an hour.');
    check('no note waits for an agent that was never re-run', getRerunPending(db, 'n_dev') === null && getRerunPending(db, 'n_arch') === null);
    // One Supervisor presses the button with everything held, so nothing starts before the "restart".
    const supA = new Supervisor(db);
    await supA.hold();
    const atN = runs.length;
    const pressed = await supA.rerunFrom('n_arch');
    check('the button is pressed: the developer is queued, to go again', pressed.agents.length === 1 && pressed.agents[0]?.action === 'resume' && getAgent(db, 'n_dev')?.status === 'queued');
    check('and nothing started, as this Supervisor is held', runs.length === atN);
    check('the note is in the row, not in memory: the roles whose reply changed (Amendment 120)', JSON.stringify(getRerunPending(db, 'n_dev')) === '["architect"]', JSON.stringify(getRerunPending(db, 'n_dev')));
    check('and the agent that was pressed from has none', getRerunPending(db, 'n_arch') === null);
    const reopened2 = new DatabaseSync(process.env['CONDUCTOR_DB']!);
    check('a daemon that opens the file afresh still finds it', JSON.stringify(getRerunPending(reopened2, 'n_dev')) === '["architect"]');
    const supB = new Supervisor(reopened2);
    supB.pump();
    check('the new Supervisor resumes the developer in its own session', (await until(() => runs.length === atN + 1)) && runs[atN]?.options.resume === 'sess_n_dev', String(runs[atN]?.options.resume));
    await until(() => (runs[atN]?.prompts.length ?? 0) > 0);
    const noteL = runs[atN]?.prompts[0] ?? '';
    check(
      'with the note the press made, not the usual wake nudge: input changed, and the architect’s latest reply (Amendment 120)',
      noteL.startsWith('Your input changed. architect has said something new') && noteL.includes('Agent: Plan v2: the tokens expire after an hour.') && noteL !== WAKE_NUDGE,
      noteL,
    );
    check('it is taken: the column is empty again, so a second resume gets no stale note', getRerunPending(db, 'n_dev') === null);
    runs[atN]?.finish({ cost: 0, reason: 'completed' });
    check('and the developer ends done', await until(() => getAgent(db, 'n_dev')?.status === 'done'));
    reopened2.close();
    // Terminating an agent takes a waiting note away with it.
    lfix('n_dev2', jobN, { role: 'validator', status: 'queued', sdkSessionId: 'sess_n_dev2', dependsOn: ['n_dev'] });
    setRerunPending(db, 'n_dev2', ['developer']);
    await sup.terminateAgent('n_dev2');
    check('terminating an agent clears a note waiting for it', getRerunPending(db, 'n_dev2') === null && getAgent(db, 'n_dev2')?.status === 'stopped');

    // ── real windows: where they come from, and a cap that follows them ──────
    forgetWindows();
    copilotSdk.fetchOpenRouterModels = async () => ({
      data: [
        { id: 'vendor/big', name: 'Big', context_length: 1_000_000 },
        { id: 'vendor/small', name: 'Small', context_length: 8_192 },
        { id: 'vendor/none', name: 'None' },
        { id: 'vendor/zero', name: 'Zero', context_length: 0 },
      ],
    });
    const orList = await openRouterModels(true);
    copilotSdk.fetchOpenRouterModels = () => Promise.reject(new Error('verify asked OpenRouter'));
    check('OpenRouter’s list is as it was (Amendment 120)', JSON.stringify(orList.map((m) => m.id)) === '["vendor/big","vendor/small","vendor/none","vendor/zero"]');
    check(
      'and its context_length is kept for each model that has one, by provider (Amendment 120)',
      reportedWindow('openrouter', 'vendor/big') === 1_000_000 && reportedWindow('openrouter', 'vendor/small') === 8_192 && reportedWindow('openrouter', 'vendor/none') === undefined &&
        reportedWindow('openrouter', 'vendor/zero') === undefined && reportedWindow('copilot', 'vendor/big') === undefined && reportedWindow('claude', 'vendor/big') === undefined,
    );
    const keptModels = fakeCopilot.models;
    fakeCopilot.models = [
      { id: 'gpt-win', name: 'GPT win', capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64_000 } } },
      { id: 'gpt-nowin', name: 'No window' },
    ] as never;
    const cpList = await copilotModels();
    fakeCopilot.models = keptModels;
    check('Copilot’s list is as it was, and its max_context_window_tokens is kept (Amendment 120)', cpList.map((m) => m.id).join() === 'gpt-win,gpt-nowin' && reportedWindow('copilot', 'gpt-win') === 64_000 && reportedWindow('copilot', 'gpt-nowin') === undefined);
    const gwBefore = { gateway: modelSources.gateway, claudeCode: modelSources.claudeCode };
    modelSources.gateway = async () => ({ host: 'gw.test', models: [{ id: 'claude-win-l120', contextTokens: 50_000 }, { id: 'claude-nowin-l120' }] });
    modelSources.claudeCode = async () => [];
    forgetCatalog();
    await catalog(true);
    modelSources.gateway = gwBefore.gateway;
    modelSources.claudeCode = gwBefore.claudeCode;
    forgetCatalog();
    check('the gateway’s max_input_tokens is kept for Claude, and a model it does not say for has none (Amendment 120)', reportedWindow('claude', 'claude-win-l120') === 50_000 && reportedWindow('claude', 'claude-nowin-l120') === undefined);
    // The gateway's answer as the Models API words it, read by the real asker from a local server.
    const gw = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'claude-opus-l120', display_name: 'Opus', type: 'model', max_input_tokens: 1_000_000, max_tokens: 64_000 },
          { id: 'claude-null-l120', display_name: 'Null', type: 'model', max_input_tokens: null, max_tokens: null },
          { id: 'claude-missing-l120', type: 'model' },
        ],
        has_more: false,
        first_id: 'claude-opus-l120',
        last_id: 'claude-missing-l120',
      }));
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    const envWas = { base: process.env['ANTHROPIC_BASE_URL'], key: process.env['ANTHROPIC_API_KEY'] };
    process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${(gw.address() as { port: number }).port}`;
    process.env['ANTHROPIC_API_KEY'] = 'verify-key-l120';
    const served = await askGateway();
    if (envWas.base === undefined) delete process.env['ANTHROPIC_BASE_URL']; else process.env['ANTHROPIC_BASE_URL'] = envWas.base;
    if (envWas.key === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = envWas.key;
    await new Promise<void>((r) => gw.close(() => r()));
    check(
      'read from the response as the Models API words it: max_input_tokens, and null or missing is no window (Amendment 120)',
      served.models.find((m) => m.id === 'claude-opus-l120')?.contextTokens === 1_000_000 && served.models.find((m) => m.id === 'claude-null-l120')?.contextTokens === undefined &&
        served.models.find((m) => m.id === 'claude-missing-l120')?.contextTokens === undefined && served.models.length === 3,
      JSON.stringify(served),
    );

    // A downstream agent on a model with a small window is given a quarter of THAT, not of the floor.
    const jobW = 'job_l120_win';
    ljob(jobW);
    lfix('w_up', jobW, { role: 'analyst', status: 'done', sdkSessionId: 'sess_w_up' });
    for (let i = 1; i <= 40; i++) sayL(jobW, 'w_up', `#w${String(i).padStart(2, '0')}# ${'v'.repeat(100)}`);
    recordWindows('claude', [{ id: 'claude-tiny-l120', tokens: 2_000 }]);
    lfix('w_tiny', jobW, { role: 'builder', status: 'queued', dependsOn: ['w_up'], model: 'claude-tiny-l120' });
    lfix('w_floor', jobW, { role: 'reviewer', status: 'queued', dependsOn: ['w_up'], model: 'claude-other-l120' });
    const atW = runs.length;
    sup.pump();
    check('both start', await until(() => runs.length === atW + 2));
    const tinyRun = runs.slice(atW).find((r) => r.options.model === 'claude-tiny-l120')!;
    const floorRun = runs.slice(atW).find((r) => r.options.model === 'claude-other-l120')!;
    await until(() => tinyRun.prompts.length > 0 && floorRun.prompts.length > 0);
    const tiny = tinyRun.prompts[0] ?? '';
    const floor = floorRun.prompts[0] ?? '';
    check(
      'a model whose engine reported 2,000 tokens is given about 1,500 characters: the newest, the rest said to be left out (Amendment 120)',
      tiny.includes('#w40#') && !tiny.includes('#w01#') && /the first \d+ of 40 entries are left out to fit/.test(tiny) && tiny.length < 3_500,
      `${tiny.length} characters`,
    );
    check('one with no reported window is given what the floor says — all 40 replies (Amendment 120)', floor.includes('#w01#') && floor.includes('#w40#') && !/left out to fit/.test(floor) && floor.length > 4_800, `${floor.length} characters`);
    for (const r of [tinyRun, floorRun]) r.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'w_tiny')?.status === 'done' && getAgent(db, 'w_floor')?.status === 'done');
    forgetWindows();

    // ── text said once, through the real prompts ─────────────────────────────
    const jobG = 'job_l120_diamond';
    ljob(jobG);
    const PLAN_L = 'The plan: rotate the refresh tokens, keep the family id, and revoke the whole family on reuse.';
    const SUMMARY_L = 'Architect summary: sessions live in src/session.ts, nothing else changes.';
    lfix('g_p', jobG, { role: 'architect', status: 'queued' });
    lfix('g_x', jobG, { role: 'developer', status: 'queued', dependsOn: ['g_p'] });
    lfix('g_y', jobG, { role: 'validator', status: 'queued', dependsOn: ['g_p'] });
    lfix('g_z', jobG, { role: 'analyst', status: 'queued', dependsOn: ['g_p'] });
    lfix('g_r', jobG, { role: 'scribe', status: 'queued', dependsOn: ['g_x', 'g_y', 'g_z'] });
    const atG = runs.length;
    sup.pump();
    check('the architect starts', await until(() => runs.length === atG + 1));
    sayL(jobG, 'g_p', PLAN_L);
    handOffAs('g_p', SUMMARY_L);
    runs[atG]!.finish({ cost: 0, reason: 'completed' });
    check('and the three that wait for it start together', await until(() => runs.length === atG + 4));
    await until(() => runs.slice(atG + 1).every((r) => r.prompts.length > 0));
    check('each is given the architect’s part (this is what the scribe will see three times)', runs.slice(atG + 1).every((r) => (r.prompts[0] ?? '').includes(PLAN_L) && (r.prompts[0] ?? '').includes(SUMMARY_L)));
    for (const [id, role] of [['g_x', 'developer'], ['g_y', 'validator'], ['g_z', 'analyst']] as const) {
      sayL(jobG, id, `${role} finished its part and all of its checks pass.`);
      handOffAs(id, `${role} summary: done, nothing left.`);
    }
    for (const r of runs.slice(atG + 1)) r.finish({ cost: 0, reason: 'completed' });
    check('then the scribe, which waits for the three', await until(() => runs.length === atG + 5));
    await until(() => (runs[atG + 4]?.prompts.length ?? 0) > 0);
    const scribe = runs[atG + 4]?.prompts[0] ?? '';
    check('the architect’s plan is in the scribe’s prompt once, not three times (Amendment 120)', occurrences(scribe, PLAN_L) === 1, `${occurrences(scribe, PLAN_L)} times`);
    check('and so is the architect’s summary, which each of the three had been given', occurrences(scribe, SUMMARY_L) === 1, `${occurrences(scribe, SUMMARY_L)} times`);
    check('the second and third of them say where it went (Amendment 120)', occurrences(scribe, REPEAT_MARKER) >= 2, `${occurrences(scribe, REPEAT_MARKER)} markers`);
    check(
      'and everything that is their own is there: each one’s reply and each one’s summary (Amendment 120)',
      ['developer', 'validator', 'analyst'].every((r) => scribe.includes(`Agent: ${r} finished its part and all of its checks pass.`) && scribe.includes(`Its summary of its work:\n${r} summary: done, nothing left.`) && scribe.includes(`[${r}]`)),
      scribe,
    );
    runs[atG + 4]?.finish({ cost: 0, reason: 'completed' });
    check('and the job finishes', await until(() => getJob(db, jobG)?.status === 'done'), String(getJob(db, jobG)?.status));

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n22 · the Metrics tab: model usage, calls, time and errors (Amendment 122)');
  {
    type MR = import('@conductor/shared').MetricsResponse;
    const mx = await import('./metrics.js');

    // ── the arithmetic, on plain values ──
    const tk = (input: number, output: number, cacheRead = 0, costUsd = 0) => ({ input, output, cacheRead, costUsd });
    const folded = mx.foldModelUsage({
      'claude-opus-4-7[1m]': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5, costUSD: 0.5, canonicalModel: 'claude-opus-4-7' },
      'claude-opus-4-7': { inputTokens: 40, outputTokens: 4, cacheReadInputTokens: 0, costUSD: 0.1 },
      'claude-haiku-4-5': { inputTokens: 7, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.01 },
      junk: 'not an object',
    });
    check(
      "a model's raw keys that name one canonical model are one model; junk is skipped",
      folded.size === 2 && folded.get('claude-opus-4-7')?.input === 140 && folded.get('claude-haiku-4-5')?.output === 1 && mx.foldModelUsage(undefined).size === 0 && mx.foldModelUsage([1]).size === 0,
      JSON.stringify([...folded]),
    );
    const base = new Map([['m', tk(100, 20, 5, 0.5)]]);
    const grown = new Map([['m', tk(160, 35, 9, 0.8)]]);
    const asFacts = (over: Partial<Parameters<typeof mx.resultDelta>[0]> = {}): Parameters<typeof mx.resultDelta>[0] => ({
      stored: 0.5, reportedCost: 0.8, reported: grown, baseline: base, baselined: true, reportedApiMs: 9000, storedApiMs: 6000, ...over,
    });
    const cont = mx.resultDelta(asFacts());
    check(
      'a result that continues the session adds the difference, not its running total',
      cont.continued && cont.perModel.get('m')?.input === 60 && cont.perModel.get('m')?.output === 15 && cont.perModel.get('m')?.cacheRead === 4 && near(cont.perModel.get('m')?.costUsd, 0.3) && cont.apiMs === 3000 && cont.nextApiMs === 9000 && cont.nextBaseline.get('m')?.input === 160,
      JSON.stringify([...cont.perModel]),
    );
    const fresh = mx.resultDelta(asFacts({ reportedCost: 0.2, reported: new Map([['m', tk(30, 5, 0, 0.2)]]) }));
    check(
      'one that started again from zero (a lower total than was spent) is wholly new, and the baseline carries on from the sum',
      !fresh.continued && fresh.perModel.get('m')?.input === 30 && fresh.nextBaseline.get('m')?.input === 130 && fresh.apiMs === 9000 && fresh.nextApiMs === 15000,
      JSON.stringify([fresh.perModel.get('m'), fresh.nextBaseline.get('m'), fresh.apiMs, fresh.nextApiMs]),
    );
    const first = mx.resultDelta(asFacts({ baselined: false, baseline: new Map() }));
    check(
      'the first result for an agent from before metrics only sets the baseline: its totals include runs never seen',
      first.perModel.size === 0 && first.apiMs === null && first.nextBaseline.get('m')?.input === 160 && first.nextApiMs === 9000,
    );
    check(
      'but if that result started again from zero, it is all new',
      mx.resultDelta(asFacts({ baselined: false, baseline: new Map(), reportedCost: 0.1, reported: new Map([['m', tk(30, 5)]]) })).perModel.get('m')?.input === 30,
    );
    check('a total that went down on a continued session adds nothing, never a negative', mx.resultDelta(asFacts({ reported: new Map([['m', tk(90, 10, 1, 0.4)]]) })).perModel.get('m')?.input === 0);
    check('a result with no API time adds none and leaves the running total', mx.resultDelta(asFacts({ reportedApiMs: null })).apiMs === null && mx.resultDelta(asFacts({ reportedApiMs: null })).nextApiMs === 6000);
    const two = new Map([['claude-sonnet-4-6', tk(500, 100)], ['claude-haiku-4-5', tk(900, 20)]]);
    check('the run is credited to the model that did most in it; a tie goes to the agent\'s own', mx.primaryModel(two, 'sonnet') === 'claude-haiku-4-5' && mx.primaryModel(new Map([['a', tk(5, 5)], ['b', tk(5, 5)]]), 'b') === 'b' && mx.primaryModel(new Map(), 'opus') === 'opus');
    check(
      'an alias finds its model by name: opus is claude-opus-4-7[1m]; one with no match stays as it is',
      mx.matchModel('opus', ['claude-sonnet-4-6', 'claude-opus-4-7']) === 'claude-opus-4-7' && mx.matchModel('opus[1m]', ['claude-opus-4-7']) === 'claude-opus-4-7' && mx.matchModel('gpt-5', ['claude-opus-4-7']) === 'gpt-5' && mx.matchModel('default', ['x']) === 'default',
    );
    check('days are the daemon\'s local ones, across a month and a year', mx.addDays('2033-03-01', -1) === '2033-02-28' && mx.addDays('2033-01-02', -6) === '2032-12-27' && mx.rangeStart('7d', '2033-03-15', '2033-01-01') === '2033-03-09' && mx.rangeStart('today', '2033-03-15', '2033-01-01') === '2033-03-15' && mx.rangeStart('all', '2033-03-15', '2033-01-01') === '2033-01-01');

    // ── a fake query whose result carries what a real one does ──
    interface ModelFig { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; costUSD: number; canonicalModel?: string }
    interface MResult {
      cost: number;
      models?: Record<string, ModelFig>;
      turns?: number;
      apiMs?: number;
      durationMs?: number;
      usage?: { input_tokens: number; output_tokens: number };
      reason?: string;
      subtype?: string;
      isError?: boolean;
    }
    interface MRun { options: Options; finished: boolean; say(m: Record<string, unknown>): void; finish(r: MResult): void }
    const mruns: MRun[] = [];
    const metricsQuery = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
      const inbox: Record<string, unknown>[] = [];
      let result: MResult = { cost: 0 };
      let wake: (() => void) | null = null;
      const poke = (): void => {
        wake?.();
        wake = null;
      };
      const run: MRun = {
        options: options ?? {},
        finished: false,
        say(m) {
          if (!run.finished) {
            inbox.push(m);
            poke();
          }
        },
        finish(r) {
          if (run.finished) return;
          run.finished = true;
          result = r;
          poke();
        },
      };
      mruns.push(run);
      const sessionId = options?.resume ?? `sess_metrics_${mruns.length}`;
      void (async () => {
        if (typeof prompt !== 'string') for await (const _ of prompt) void _;
      })();
      async function* messages(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: sessionId };
        for (;;) {
          while (inbox.length > 0) yield { session_id: sessionId, ...inbox.shift() };
          if (run.finished) break;
          await new Promise<void>((r) => (wake = r));
        }
        const r = result;
        yield {
          type: 'result',
          subtype: r.subtype ?? (r.isError ? 'error_during_execution' : 'success'),
          is_error: r.isError ?? false,
          total_cost_usd: r.cost,
          ...(r.reason ? { terminal_reason: r.reason } : {}),
          ...(r.models ? { modelUsage: r.models } : {}),
          ...(r.turns !== undefined ? { num_turns: r.turns } : {}),
          ...(r.apiMs !== undefined ? { duration_api_ms: r.apiMs } : {}),
          ...(r.durationMs !== undefined ? { duration_ms: r.durationMs } : {}),
          usage: r.usage ?? { input_tokens: 10, output_tokens: 5 },
          session_id: sessionId,
        };
      }
      return Object.assign(messages(), {
        interrupt: async () => run.finish({ cost: 0, reason: 'aborted_streaming', isError: true, models: { 'claude-metrics-b': { inputTokens: 0, outputTokens: 0, costUSD: 0 } } }),
        setModel: async () => undefined,
      }) as unknown as Query;
    };
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = metricsQuery as typeof sdk.query;

    const A = 'claude-metrics-a';
    const B = 'claude-metrics-b';
    const fig = (inputTokens: number, outputTokens: number, costUSD: number, cacheReadInputTokens = 0): ModelFig => ({ inputTokens, outputTokens, cacheReadInputTokens, costUSD });
    const report = async (range = 'all'): Promise<MR> => (await get<MR>(`/api/metrics?range=${range}`)).body;
    const rowOf = (r: MR, model: string, provider = 'claude') => r.models.find((m) => m.model === model && m.provider === provider);
    const usages = (id: string) => eventLog().forAgent(id).map((e) => e.payload).filter((p) => p.kind === 'usage');
    // Section 18 removed the project the earlier sections used, so this one has its own.
    const mpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'metrics' })).body.project.id;
    const mjob = (id: string): void => {
      insertJob(db, { id, projectId: mpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
    };
    const mfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: mpid, ...a });

    // ── a run adds one set of rows ──
    mjob('job_mt');
    mfix('mt_a', 'job_mt', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'opus' });
    sup.pump();
    await until(() => mruns.length === 1);
    const r1 = mruns[0]!;
    r1.say({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: 'overloaded' });
    r1.finish({
      cost: 0.5, models: { [A]: fig(1000, 200, 0.5, 50) }, turns: 4, apiMs: 8000, durationMs: 12000,
      usage: { input_tokens: 300, output_tokens: 60 }, reason: 'completed',
    });
    await until(() => getAgent(db, 'mt_a')?.status === 'done');
    await settle(50);
    let rep = await report();
    let a = rowOf(rep, A);
    check(
      'one run adds its tokens, calls, time and the dollars the engine reported, to its model',
      a?.inputTokens === 1000 && a.outputTokens === 200 && a.cacheReadTokens === 50 && near(a.costUsd ?? undefined, 0.5) && a.calls === 4 && a.apiMs === 8000 && a.timedCalls === 4 && a.timedOutputTokens === 200,
      JSON.stringify(a),
    );
    check('and counts as a run that did not fail, with its wall time and the retry it went through', a?.runs === 1 && a.failedRuns === 0 && a.runMs >= 0 && a.retries === 1, JSON.stringify(a));
    const u1 = usages('mt_a').at(-1);
    check(
      'the usage event names the model and carries calls and time (Amendment 122)',
      u1?.kind === 'usage' && u1.model === A && u1.calls === 4 && u1.durationMs === 12000 && u1.apiMs === 8000 && u1.inputTokens === 300 && u1.outputTokens === 60,
      JSON.stringify(u1),
    );
    check(
      "and the agent row holds that run's main-loop tokens, not the model's: this is why the tab does not read the rows",
      getAgent(db, 'mt_a')?.inputTokens === 300 && getAgent(db, 'mt_a')?.outputTokens === 60 && near(getAgent(db, 'mt_a')?.costUsd, 0.5),
    );
    check('the total has the dollars of an engine that reports them', near(rep.total.costUsd ?? undefined, rep.models.filter((m) => m.provider === 'claude').reduce((s, m) => s + (m.costUsd ?? 0), 0)) && rep.range === 'all');

    // ── a resumed run adds only what is new ──
    const sessionA = getAgent(db, 'mt_a')?.sdkSessionId;
    await send('POST', '/api/agents/mt_a/message', { text: 'again' });
    await until(() => mruns.length === 2);
    const r2 = mruns[1]!;
    check('the second run resumes the first one\'s session', r2.options.resume === sessionA, `${r2.options.resume} vs ${sessionA}`);
    // A resumed session's first result already carries the earlier run: running totals.
    const spent0 = costToday(db);
    r2.finish({
      cost: 0.9, models: { [A]: fig(1600, 350, 0.9, 80) }, turns: 3, apiMs: 14000, durationMs: 9000,
      usage: { input_tokens: 150, output_tokens: 40 }, reason: 'completed',
    });
    await until(() => getAgent(db, 'mt_a')?.status === 'done' && (usages('mt_a').length === 2));
    await settle(50);
    a = rowOf(await report(), A);
    check(
      'a RESUMED run adds only the difference: not 2600 in and 550 out, as summing the results would',
      a?.inputTokens === 1600 && a.outputTokens === 350 && a.cacheReadTokens === 80 && near(a.costUsd ?? undefined, 0.9),
      JSON.stringify(a),
    );
    check('with its calls and API time added once each, and a second run', a?.calls === 7 && a.apiMs === 14000 && a.timedCalls === 7 && a.runs === 2, JSON.stringify(a));
    check('today\'s spend still grew by the run\'s own $0.40, as before', near(getAgent(db, 'mt_a')?.costUsd, 0.9) && near(costToday(db) - spent0, 0.4), `${costToday(db) - spent0}`);

    // A session whose transcript kept no totals starts again from zero: that is new.
    await send('POST', '/api/agents/mt_a/message', { text: 'a third time' });
    await until(() => mruns.length === 3);
    mruns[2]!.finish({ cost: 0.2, models: { [A]: fig(100, 40, 0.2) }, turns: 2, apiMs: 3000, durationMs: 4000, reason: 'completed' });
    await until(() => getAgent(db, 'mt_a')?.status === 'done' && usages('mt_a').length === 3);
    await settle(50);
    a = rowOf(await report(), A);
    check(
      'a resumed session that started again from zero (less than was spent) is wholly new',
      a?.inputTokens === 1700 && a.outputTokens === 390 && near(a.costUsd ?? undefined, 1.1) && a.calls === 9 && a.apiMs === 17000 && a.runs === 3,
      JSON.stringify(a),
    );

    // ── a model switch splits the totals ──
    check('switching the model is for the next run', (await sup.setModel('mt_a', B)) === 'next run' && getAgent(db, 'mt_a')?.model === B);
    await send('POST', '/api/agents/mt_a/message', { text: 'on the other model' });
    await until(() => mruns.length === 4);
    // Cumulative for the session: model A as it stood, model B new.
    mruns[3]!.finish({
      cost: 1.4, models: { [A]: fig(1700, 390, 1.1, 80), [B]: fig(500, 120, 0.3) }, turns: 2, apiMs: 18500, durationMs: 5000,
      usage: { input_tokens: 500, output_tokens: 120 }, reason: 'completed',
    });
    await until(() => getAgent(db, 'mt_a')?.status === 'done' && usages('mt_a').length === 4);
    await settle(50);
    rep = await report();
    a = rowOf(rep, A);
    let b = rowOf(rep, B);
    check('model A, which did nothing this run, is as it was', a?.inputTokens === 1700 && a.outputTokens === 390 && a.calls === 9 && a.runs === 3, JSON.stringify(a));
    check(
      'model B has its own row: its tokens, dollars, and the run\'s calls, time and run',
      b?.inputTokens === 500 && b.outputTokens === 120 && near(b.costUsd ?? undefined, 0.3) && b.calls === 2 && b.apiMs === 1500 && b.runs === 1,
      JSON.stringify(b),
    );
    check('the agent row, meanwhile, says only B: the history is not in it', getAgent(db, 'mt_a')?.model === B);
    check('the usage event of that run names B', (usages('mt_a').at(-1) as { model?: string } | undefined)?.model === B);

    // ── errors: a failed run counts, your stop and a budget stop do not ──
    const total0 = (await report()).total;
    mjob('job_mt_f');
    mfix('mt_f', 'job_mt_f', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'opus' });
    sup.pump();
    await until(() => mruns.length === 5);
    mruns[4]!.finish({ cost: 0.01, models: { [B]: fig(10, 2, 0.01) }, turns: 1, reason: 'error', isError: true });
    await until(() => getAgent(db, 'mt_f')?.status === 'failed');
    await settle(50);
    rep = await report();
    check('a run that ends failed is a run and a failed run, on its model', rowOf(rep, B)?.runs === 2 && rowOf(rep, B)?.failedRuns === 1 && rep.total.failedRuns === total0.failedRuns + 1, JSON.stringify(rowOf(rep, B)));

    mjob('job_mt_cap');
    mfix('mt_cap', 'job_mt_cap', { status: 'queued', autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 1 }, model: 'opus' });
    sup.pump();
    await until(() => mruns.length === 6);
    mruns[5]!.finish({ cost: 1.2, models: { [B]: fig(20, 4, 1.2) }, turns: 1, subtype: 'error_max_budget_usd', isError: true });
    await until(() => getAgent(db, 'mt_cap')?.status === 'paused');
    await settle(50);
    const afterCap = await report();
    check('a budget stop is a run, and not a failure', rowOf(afterCap, B)?.runs === 3 && rowOf(afterCap, B)?.failedRuns === 1 && afterCap.total.failedRuns === total0.failedRuns + 1, JSON.stringify(rowOf(afterCap, B)));

    mjob('job_mt_stop');
    mfix('mt_stop', 'job_mt_stop', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'opus' });
    sup.pump();
    await until(() => mruns.length === 7 && getAgent(db, 'mt_stop')?.status === 'working');
    await send('POST', '/api/agents/mt_stop/terminate');
    await until(() => getAgent(db, 'mt_stop')?.status === 'stopped');
    await settle(80);
    const afterStop = await report();
    check('stopping an agent yourself is a run, and not a failure', afterStop.total.runs === afterCap.total.runs + 1 && afterStop.total.failedRuns === afterCap.total.failedRuns && getAgent(db, 'mt_stop')?.status === 'stopped', JSON.stringify([afterStop.total.runs, afterCap.total.runs]));

    // A result with no model breakdown: the main loop's own figures, on the agent's model.
    const opus0 = rowOf(await report(), 'opus');
    mjob('job_mt_n');
    mfix('mt_n', 'job_mt_n', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'opus' });
    sup.pump();
    await until(() => mruns.length === 8);
    mruns[7]!.finish({ cost: 0.1, turns: 1, usage: { input_tokens: 70, output_tokens: 9 }, reason: 'completed' });
    await until(() => getAgent(db, 'mt_n')?.status === 'done');
    await settle(50);
    const opus1 = rowOf(await report(), 'opus');
    check(
      'a result with no modelUsage still counts: its own tokens and dollars, on the agent\'s model',
      (opus1?.inputTokens ?? 0) - (opus0?.inputTokens ?? 0) === 70 && (opus1?.outputTokens ?? 0) - (opus0?.outputTokens ?? 0) === 9 && near((opus1?.costUsd ?? 0) - (opus0?.costUsd ?? 0), 0.1),
      JSON.stringify([opus0, opus1]),
    );

    // ── before metrics were recorded ──
    const before0 = (await report()).before;
    mjob('job_mt_old');
    mfix('mt_old', 'job_mt_old', { status: 'done', autonomy: DEFAULT_AUTONOMY, model: 'opus', sdkSessionId: 'sess_old', costUsd: 2, inputTokens: 800, outputTokens: 90 });
    const before1 = (await report()).before;
    check(
      'an agent that spent before metrics, and never ran since, is in the "before" line from its row',
      before1 !== null && before1.agents === (before0?.agents ?? 0) + 1 && near((before1.costUsd ?? 0) - (before0?.costUsd ?? 0), 2) && before1.inputTokens - (before0?.inputTokens ?? 0) === 800 && before1.outputTokens - (before0?.outputTokens ?? 0) === 90,
      JSON.stringify([before0, before1]),
    );
    check('and the other ranges do not show it', (await report('today')).before === null && (await report('7d')).before === null);
    const bBefore = rowOf(await report(), B)!;
    await send('POST', '/api/agents/mt_old/message', { text: 'continue' });
    await until(() => mruns.length === 9);
    mruns[8]!.finish({ cost: 2.6, models: { [B]: fig(5000, 700, 2.6) }, turns: 3, apiMs: 9000, durationMs: 7000, reason: 'completed' });
    await until(() => getAgent(db, 'mt_old')?.status === 'done' && usages('mt_old').length === 1);
    await settle(50);
    let repOld = await report();
    let bOld = rowOf(repOld, B)!;
    check(
      'its first result since metrics began only sets the baseline: running totals that include runs never seen are not added',
      bOld.inputTokens === bBefore.inputTokens && bOld.outputTokens === bBefore.outputTokens && near(bOld.costUsd ?? 0, bBefore.costUsd ?? 0) && bOld.apiMs === bBefore.apiMs,
      JSON.stringify([bBefore, bOld]),
    );
    check('though its calls and its run are counted', bOld.calls === bBefore.calls + 3 && bOld.runs === bBefore.runs + 1);
    check(
      'and the "before" line keeps what the row held then, not what it holds now',
      repOld.before?.agents === before1?.agents && near(repOld.before?.costUsd ?? 0, before1?.costUsd ?? 0) && repOld.before?.inputTokens === before1?.inputTokens && getAgent(db, 'mt_old')?.costUsd === 2.6,
      JSON.stringify([repOld.before, before1]),
    );
    await send('POST', '/api/agents/mt_old/message', { text: 'and again' });
    await until(() => mruns.length === 10);
    mruns[9]!.finish({ cost: 2.9, models: { [B]: fig(5600, 780, 2.9) }, turns: 2, apiMs: 10000, durationMs: 3000, reason: 'completed' });
    await until(() => getAgent(db, 'mt_old')?.status === 'done' && usages('mt_old').length === 2);
    await settle(50);
    repOld = await report();
    const bNext = rowOf(repOld, B)!;
    check(
      'from its second run on, it adds the difference like any other',
      bNext.inputTokens === bOld.inputTokens + 600 && bNext.outputTokens === bOld.outputTokens + 80 && near((bNext.costUsd ?? 0) - (bOld.costUsd ?? 0), 0.3) && bNext.apiMs === bOld.apiMs + 1000,
      JSON.stringify([bOld, bNext]),
    );
    b = bNext;

    // ── Copilot and OpenRouter: one event per call, no dollars ──
    const copilotBefore = rowOf(await report(), 'gpt-5-mini', 'copilot');
    mjob('job_mt_c');
    mfix('mt_c', 'job_mt_c', { status: 'queued', autonomy: DEFAULT_AUTONOMY, model: 'gpt-5-mini', provider: 'copilot' } as Partial<Agent>);
    sup.pump();
    await until(() => copilotSessions.some((s) => s.id === 'mt_c'));
    const cs = copilotSessions.filter((s) => s.id === 'mt_c').at(-1)!;
    cs.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, duration: 2000 });
    cs.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 50, outputTokens: 5 });
    cs.emit('assistant.usage', { model: 'gpt-4.1', inputTokens: 30, outputTokens: 3, duration: 500 }, { agentId: 'sub1' });
    cs.emit('session.idle', {});
    await until(() => getAgent(db, 'mt_c')?.status === 'done');
    await settle(50);
    rep = await report();
    const g5 = rowOf(rep, 'gpt-5-mini', 'copilot');
    const g41 = rowOf(rep, 'gpt-4.1', 'copilot');
    check(
      'each call is a call, on the model it was made on, with its own time where the runtime gave one',
      g5 !== undefined && g5.calls === (copilotBefore?.calls ?? 0) + 2 && g5.inputTokens === (copilotBefore?.inputTokens ?? 0) + 150 && g5.outputTokens === (copilotBefore?.outputTokens ?? 0) + 25 && g5.cacheReadTokens === (copilotBefore?.cacheReadTokens ?? 0) + 10 && g5.apiMs === (copilotBefore?.apiMs ?? 0) + 2000 && g5.timedCalls === (copilotBefore?.timedCalls ?? 0) + 1 && g5.timedOutputTokens === (copilotBefore?.timedOutputTokens ?? 0) + 20,
      JSON.stringify([copilotBefore, g5]),
    );
    check('a sub-agent\'s call on another model is that model\'s', g41?.calls === 1 && g41.inputTokens === 30 && g41.apiMs === 500);
    check('the run is credited to the first model called, the agent\'s own', g5?.runs === (copilotBefore?.runs ?? 0) + 1 && (g41?.runs ?? 0) === 0);
    check('an engine that reports no dollars shows none, not $0.00', g5?.costUsd === null && g41?.costUsd === null);
    const cu = usages('mt_c');
    check(
      'its usage events carry the model, one call, and the call\'s time when it has one',
      cu[0]?.kind === 'usage' && cu[0].model === 'gpt-5-mini' && cu[0].calls === 1 && cu[0].apiMs === 2000 && cu[1]?.kind === 'usage' && cu[1].apiMs === undefined && cu[2]?.kind === 'usage' && cu[2].model === 'gpt-4.1',
      JSON.stringify(cu),
    );
    check('and the agent row is still its lifetime tokens', getAgent(db, 'mt_c')?.inputTokens === 180 && getAgent(db, 'mt_c')?.costUsd === 0);

    // ── Amendment 136: the retry rate's whole is Claude's calls, and the counts per project ──
    rep = await report();
    const claudeRows = rep.models.filter((m) => m.provider === 'claude');
    const claudeCallsSum = claudeRows.reduce((n, m) => n + m.calls, 0);
    check(
      "with Copilot in the range, the total says how many of its calls were Claude's: the retry rate's whole",
      rep.total.claudeCalls === claudeCallsSum && rep.total.claudeCalls < rep.total.calls && rep.total.calls - rep.total.claudeCalls === rep.models.filter((m) => m.provider !== 'claude').reduce((n, m) => n + m.calls, 0),
      JSON.stringify([rep.total.calls, rep.total.claudeCalls, claudeCallsSum]),
    );
    check(
      "a Claude row's Claude calls are its calls, a Copilot row's none, and every retry is on a Claude row",
      claudeRows.every((m) => m.claudeCalls === m.calls) && rep.models.filter((m) => m.provider !== 'claude').every((m) => m.claudeCalls === 0 && m.retries === 0) && (rowOf(rep, A)?.retries ?? 0) >= 1,
      JSON.stringify(rep.models.map((m) => [m.provider, m.model, m.calls, m.claudeCalls, m.retries])),
    );
    check('the all-projects report says it is for no one project', rep.project === null);

    const projRep = (await get<MR>(`/api/metrics?range=all&projectId=${mpid}`)).body;
    check("?projectId= reads that project's counts, and the answer names the project", projRep.project?.id === mpid && projRep.project.name === (await get<{ projects: Project[] }>('/api/projects')).body.projects.find((p) => p.id === mpid)?.name && projRep.range === 'all', JSON.stringify(projRep.project));
    check(
      "every run this section made was this project's agents', so its models' rows are the same in both views",
      [A, B].every((m) => JSON.stringify(rowOf(projRep, m)) === JSON.stringify(rowOf(rep, m))) && JSON.stringify(rowOf(projRep, 'gpt-4.1', 'copilot')) === JSON.stringify(rowOf(rep, 'gpt-4.1', 'copilot')),
      JSON.stringify([rowOf(projRep, A), rowOf(rep, A)]),
    );
    check('a project has no "before" line: the rows from before recording cannot say whose runs were whose', projRep.before === null && rep.before !== null);
    check('and it starts when per-project counting did, a local day', /^\d{4}-\d{2}-\d{2}$/.test(projRep.since) && projRep.since >= rep.since && projRep.from === projRep.since, JSON.stringify([projRep.since, projRep.from, rep.since]));
    check(
      'the project table has rows for the project, keyed by it, written with the daily ones',
      count(db, 'SELECT COUNT(*) AS n FROM metrics_project_daily WHERE project_id = ?', mpid) > 0 && count(db, 'SELECT COUNT(*) AS n FROM metrics_project_daily WHERE model = ?', A) === 1,
    );

    // Another project's agent, on another engine: in its project's view and the all-projects one, not in this one's.
    const { insertProject } = await import('./store.js');
    const other = insertProject(db, { path: join(ROOT, 'metrics-other'), name: 'metrics other', defaultBranch: 'main' });
    insertJob(db, { id: 'job_mt_o', projectId: other.id, prompt: 'the other prompt', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
    fixture('mt_o', 'job_mt_o', { projectId: other.id, status: 'done', autonomy: DEFAULT_AUTONOMY, model: 'or-metrics', provider: 'openrouter' } as Partial<Agent>);
    const otherEmpty = (await get<MR>(`/api/metrics?range=today&projectId=${other.id}`)).body;
    check('a project nothing has run in yet is an empty report, not a 404', otherEmpty.project?.id === other.id && otherEmpty.models.length === 0 && otherEmpty.total.calls === 0);
    mx.recordCall(db, { agentId: 'mt_o', model: 'or-metrics', inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, durationMs: 400 });
    mx.recordCall(db, { agentId: 'mt_o', model: 'or-metrics', inputTokens: 60, outputTokens: 12, cacheReadTokens: 0 });
    mx.recordRunEnd(db, 'mt_o', 1500);
    const otherRep = (await get<MR>(`/api/metrics?range=today&projectId=${other.id}`)).body;
    const mine = (await get<MR>(`/api/metrics?range=all&projectId=${mpid}`)).body;
    const everyone = await report();
    const orRow = rowOf(otherRep, 'or-metrics', 'openrouter');
    check(
      "the other project's view has its agent's calls, tokens and run, and nothing of this project's",
      orRow?.calls === 2 && orRow.inputTokens === 100 && orRow.runs === 1 && otherRep.models.length === 1 && otherRep.total.claudeCalls === 0 && rowOf(otherRep, A) === undefined,
      JSON.stringify(otherRep.models),
    );
    check("this project's view does not have them", rowOf(mine, 'or-metrics', 'openrouter') === undefined && JSON.stringify(mine.total) === JSON.stringify(projRep.total));
    check(
      'and the all-projects view has both',
      rowOf(everyone, 'or-metrics', 'openrouter')?.calls === 2 && JSON.stringify(rowOf(everyone, A)) === JSON.stringify(rowOf(rep, A)) && everyone.total.calls === rep.total.calls + 2 && everyone.total.claudeCalls === rep.total.claudeCalls,
    );
    check('a project that is not there is a 404', (await get('/api/metrics?projectId=prj_nothere000')).status === 404);
    check(
      'a project id that is not the shape of one is a 400, and so is an empty one, or two of them',
      (await get('/api/metrics?projectId=%2E%2E%2Fx')).status === 400 && (await get('/api/metrics?projectId=')).status === 400 && (await get(`/api/metrics?projectId=${mpid}&projectId=${other.id}`)).status === 400,
    );
    check('and a bad range is still a 400 with a project', (await get(`/api/metrics?range=fortnight&projectId=${mpid}`)).status === 400);

    // ── removing the job keeps the history ──
    const keep = await report();
    const baselinesOf = (id: string): number => count(db, 'SELECT COUNT(*) AS n FROM metrics_baseline WHERE agent_id = ?', id);
    check('before the removal the agent has its running baselines', baselinesOf('mt_a') === 2);
    const gone = await send('DELETE', '/api/jobs/job_mt');
    check('the job and its agent are removed', gone.status === 200 && getAgent(db, 'mt_a') === undefined);
    const kept = await report();
    check(
      'the history is untouched: every row, every figure',
      JSON.stringify(rowOf(kept, A)) === JSON.stringify(rowOf(keep, A)) && JSON.stringify(rowOf(kept, B)) === JSON.stringify(rowOf(keep, B)) && JSON.stringify(kept.total) === JSON.stringify(keep.total) && kept.days.length === keep.days.length,
    );
    check('only the agent\'s own bookkeeping went with it', baselinesOf('mt_a') === 0 && count(db, 'SELECT COUNT(*) AS n FROM metrics_agent WHERE agent_id = ?', 'mt_a') === 0);

    // ── the route's three ranges, on days of our own ──
    const day = (iso: string) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) });
    const put = (iso: string, input: number, extra: { calls?: number; cost?: number } = {}): void => {
      db.prepare(
        `INSERT INTO metrics_daily (day, provider, model, input_tokens, calls, runs, cost_usd) VALUES (?, 'claude', 'claude-range', ?, ?, 1, ?)`,
      ).run(iso, input, extra.calls ?? 1, extra.cost ?? 0.1);
    };
    const t = day('2033-03-15');
    setDayClock(() => new Date(t.y, t.m - 1, t.d, 12, 0, 0));
    put('2033-03-15', 10);
    put('2033-03-12', 20);
    put('2033-03-09', 30);
    put('2033-03-08', 40);
    put('2033-03-01', 50);
    const today = await report('today');
    const week = await report('7d');
    const all = await report('all');
    const only = (r: MR) => rowOf(r, 'claude-range');
    check('today is today only', only(today)?.inputTokens === 10 && today.from === '2033-03-15' && today.to === '2033-03-15' && today.days.map((d) => d.day).join() === '2033-03-15', JSON.stringify(today.days.map((d) => d.day)));
    check('7 days is today and the six before it', only(week)?.inputTokens === 60 && week.from === '2033-03-09' && week.to === '2033-03-15' && week.days.map((d) => d.day).join() === '2033-03-15,2033-03-12,2033-03-09', JSON.stringify(week.days.map((d) => d.day)));
    check('all is everything since recording began, newest day first', only(all)?.inputTokens === 150 && all.days.slice(0, 5).map((d) => d.day).join() === '2033-03-15,2033-03-12,2033-03-09,2033-03-08,2033-03-01' && all.from <= '2033-03-01', all.from);
    check('the per-day rows add up to the total', all.days.reduce((s, d) => s + d.inputTokens, 0) === all.total.inputTokens && week.days.reduce((s, d) => s + d.runs, 0) === week.total.runs);
    check('the day recording began is told, as a local day', /^\d{4}-\d{2}-\d{2}$/.test(all.since) && all.since === week.since);
    check('a range that is not one of the three is a 400', (await get('/api/metrics?range=fortnight')).status === 400);
    check('no range is today', (await get<MR>('/api/metrics')).body.range === 'today');
    db.prepare("DELETE FROM metrics_daily WHERE model = 'claude-range'").run();
    setDayClock();

    // Everything these runs left is dated today, and the run before the last has finished.
    for (const r of mruns) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n23 · trying again when the model can't be reached (Amendment 123)");
  {
    // Section 21 built extra Supervisors on second connections and closed them; the retry timer
    // calls the handler the last-built Supervisor set, so point it back at the live one.
    onRetryDue(() => sup.pump());
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);

    // ── the rules, with nothing running ──
    const failed = (httpStatus: number | null, error: string) => ({ httpStatus, error });
    const ended = (over: Partial<Parameters<typeof decideRetry>[0]> = {}) =>
      decideRetry({ isError: true, terminalReason: 'api_error', failure: failed(null, 'unknown'), userStopped: false, used: 0, ...over });
    const delays = [0, 1, 2, 3, 4].map((used) => ended({ used }));
    check(
      'five waits, in turn: 5 s, 15 s, 30 s, 60 s, 5 min',
      delays.every((v, i) => v.retry && v.delayMs === RETRY_DELAYS_MS[i] && v.attempt === i + 1 && v.of === 5) &&
        RETRY_DELAYS_MS.join() === '5000,15000,30000,60000,300000' && MAX_RETRIES === 5,
      JSON.stringify(delays),
    );
    check('and they read as 5 s, 15 s, 30 s, 60 s, 5 min', RETRY_DELAYS_MS.map(fmtDelay).join() === '5 s,15 s,30 s,60 s,5 min');
    check('the sixth failure is not retried: that is `failed`, as before', JSON.stringify(ended({ used: 5 })) === '{"retry":false,"why":"out_of_tries"}');
    check(
      'a login problem is not retried: a person has to fix it',
      ['authentication_failed', 'billing_error', 'account_on_hold'].every((e) => JSON.stringify(ended({ failure: failed(null, e) })) === '{"retry":false,"why":"needs_a_person"}') &&
        JSON.stringify(ended({ failure: failed(403, 'unknown') })) === '{"retry":false,"why":"needs_a_person"}',
    );
    check('a budget stop is not, even with the API failing under it', JSON.stringify(ended({ terminalReason: 'budget_exhausted' })) === '{"retry":false,"why":"budget"}');
    check('your own stop or pause is not', JSON.stringify(ended({ userStopped: true })) === '{"retry":false,"why":"stopped"}');
    check('an interrupted run is not a failure', JSON.stringify(ended({ terminalReason: 'aborted_streaming' })) === '{"retry":false,"why":"interrupted"}');
    check('a run that did not end in error is not', JSON.stringify(ended({ isError: false })) === '{"retry":false,"why":"not_an_error"}');
    check(
      "nor is the agent's own limit, whatever the API last said",
      JSON.stringify(ended({ terminalReason: 'blocking_limit' })) === '{"retry":false,"why":"not_the_model"}' &&
        JSON.stringify(ended({ terminalReason: 'max_turns' })) === '{"retry":false,"why":"not_the_model"}',
    );
    check(
      'nor an error with nothing from the API behind it',
      JSON.stringify(ended({ failure: null })) === '{"retry":false,"why":"not_api"}' && JSON.stringify(ended({ failure: undefined })) === '{"retry":false,"why":"not_api"}',
    );
    check(
      'what the API says decides: no response, throttled, overloaded and a 5xx wait; a bad request or a missing model does not',
      failureCause(failed(null, 'unknown')) === 'unreachable' && failureCause(failed(429, 'rate_limit')) === 'throttled' &&
        failureCause(failed(529, 'overloaded')) === 'throttled' && failureCause(failed(503, 'unknown')) === 'server' &&
        failureCause(failed(null, 'server_error')) === 'server' && failureCause(failed(408, 'unknown')) === 'server' &&
        failureCause(failed(400, 'unknown')) === null && failureCause(failed(null, 'invalid_request')) === null &&
        failureCause(failed(404, 'model_not_found')) === null && failureCause(failed(null, 'max_output_tokens')) === null,
    );
    check('the transcript line says why and how long', retryNote('throttled', 3, 5, 30_000) === 'the model is busy — trying again in 30 s (3 of 5)');

    // ── the book, on a clock a check turns ──
    interface Timer {
      id: number;
      at: number;
      fn: () => void;
    }
    const makeClock = () => {
      let t = 1_700_000_000_000;
      let next = 1;
      let timers: Timer[] = [];
      return {
        now: () => t,
        setTimer: (fn: () => void, ms: number): unknown => {
          const id = next++;
          timers.push({ id, at: t + ms, fn });
          return id;
        },
        clearTimer: (h: unknown): void => void (timers = timers.filter((x) => x.id !== h)),
        advance(ms: number): void {
          t += ms;
          for (;;) {
            const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
            if (!due) return;
            timers = timers.filter((x) => x !== due);
            due.fn();
          }
        },
        pending: () => timers.length,
      } satisfies Clock & { advance(ms: number): void; pending(): number };
    };
    {
      const c = makeClock();
      const fired: string[] = [];
      let changes = 0;
      const book = new RetryBook(c, (id) => fired.push(id), () => (changes += 1));
      const who = { agentId: 'x', projectId: 'p', jobId: 'j', terminalReason: 'api_error', errorDetail: null };
      const verdict = (used: number) => ended({ used }) as Extract<ReturnType<typeof decideRetry>, { retry: true }>;
      const w1 = book.wait(verdict(book.used('x')), who);
      check('a wait is counted when it starts, and knows when it ends', book.used('x') === 1 && w1.attempt === 1 && w1.at === c.now() + 5_000 && book.waiting('x') === w1 && book.list().length === 1);
      c.advance(4_999);
      check('nothing fires early', fired.length === 0 && book.waiting('x') !== undefined);
      c.advance(1);
      check('at its time it fires once, and is no longer waiting', fired.join() === 'x' && book.waiting('x') === undefined && c.pending() === 0 && book.used('x') === 1);
      book.wait(verdict(book.used('x')), who);
      check('the next wait is the next delay', book.waiting('x')?.delayMs === 15_000 && book.waiting('x')?.attempt === 2);
      check('and the trouble began at the first', book.waiting('x')?.since === w1.since);
      check('retry now fires it at once and clears the timer', book.now('x') && fired.length === 2 && c.pending() === 0 && !book.now('x'));
      book.wait(verdict(book.used('x')), who);
      book.answered('x');
      check('a reply starts the count again, with the wait left alone', book.used('x') === 0 && book.waiting('x') !== undefined);
      book.cancel('x');
      check('cancelling drops the wait and its timer and keeps the count', book.waiting('x') === undefined && c.pending() === 0 && fired.length === 2);
      book.wait(verdict(0), who);
      book.wait(verdict(1), who);
      check('waiting again replaces the wait: one timer', c.pending() === 1 && book.list().length === 1);
      book.forget('x');
      check('forgetting takes the wait and the count', book.used('x') === 0 && book.list().length === 0 && c.pending() === 0 && changes > 0);
      book.wait(verdict(0), who);
      book.clear();
      c.advance(10 * 60_000);
      check('clearing (the daemon stopping) leaves no timer to fire', fired.length === 2 && c.pending() === 0);
    }

    // ── through the real supervisor and runner, on the fake SDK and a fake clock ──
    const rpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'retry' })).body.project.id;
    const rjob = (id: string): void => {
      insertJob(db, { id, projectId: rpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const rfix = (id: string, jobId: string, a: Partial<Agent> = {}): void => fixture(id, jobId, { projectId: rpid, status: 'queued', autonomy: DEFAULT_AUTONOMY, ...a });
    const clock = makeClock();
    resetRetryBook(clock);
    const statusOf = (id: string) => eventLog().forAgent(id).map((e) => e.payload).filter((p) => p.kind === 'status').at(-1);
    const retryOf = (id: string) => {
      const p = statusOf(id);
      return p?.kind === 'status' ? p.retry : undefined;
    };
    /** The SDK says it is retrying a call, then gives up: the run ends in error. */
    const failWith = (run: FakeRun | undefined, status: number | null, error: string, reason = 'api_error'): void => {
      run?.say({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 500, error_status: status, error });
      run?.finish({ cost: 0, isError: true, reason });
    };
    const isWaiting = (id: string): boolean => retryBook().waiting(id) !== undefined && getAgent(db, id)?.status === 'queued';
    const reconnecting = (id: string) => alerts().list().find((a) => a.kind === 'reconnecting' && a.agentIds.includes(id));

    // Each delay in turn, the sixth failure `failed`, the job live and the slot free while it waits.
    rjob('job_retry_a');
    rfix('rt_a', 'job_retry_a');
    const bell = await connect();
    // Subscribed before anything happens: a frame broadcast before the hello is not this tab's.
    await until(() => bell.frames.some((f) => f.type === 'hello'));
    const atA = runs.length;
    sup.pump();
    check('the agent starts', await until(() => runs.length === atA + 1 && getAgent(db, 'rt_a')?.status === 'working'));
    let run = runs[atA]!;
    let firstCardId: string | undefined;
    for (let i = 0; i < MAX_RETRIES; i += 1) {
      const delay = RETRY_DELAYS_MS[i]!;
      failWith(run, null, 'unknown');
      await until(() => isWaiting('rt_a'));
      const r = retryOf('rt_a');
      check(
        `failure ${i + 1}: queued, not failed, to try again in ${fmtDelay(delay)} (${i + 1} of 5)`,
        isWaiting('rt_a') && r?.attempt === i + 1 && r.of === 5 && r.delayMs === delay && r.cause === 'unreachable',
        `${getAgent(db, 'rt_a')?.status} ${JSON.stringify(r)}`,
      );
      check('…its slot is free and its job is still live', sup.slots.used === 0 && getJob(db, 'job_retry_a')?.status === 'working', `${sup.slots.used} used, job ${getJob(db, 'job_retry_a')?.status}`);
      const card = reconnecting('rt_a');
      // From the first retry (Amendment 140, Q3): it was from the second (Amendment 123).
      check(
        `…Needs You has the card: ${i + 1} of 5, at the time it will try${i === 0 ? ' (from the first retry, Amendment 140)' : ''}`,
        card?.attempt === i + 1 && card.maxRetries === 5 && card.cause === 'unreachable' && card.jobId === 'job_retry_a' && Date.parse(card.retryAt ?? '') === clock.now() + delay,
        JSON.stringify(card),
      );
      if (i === 0) {
        // A new connection is sent the log so far before what is live, so this waits for the frame rather than a fixed time.
        check('…and every tab is told at the first, so a page chimes as for any alert', await until(() => bell.frames.some((f) => f.type === 'alerts' && f.alerts.some((a) => a.kind === 'reconnecting' && a.agentIds[0] === 'rt_a' && a.attempt === 1))));
        const snap = await get<Snapshot>('/api/snapshot');
        check('…a fresh tab gets it in the snapshot', snap.body.alerts.some((a) => a.kind === 'reconnecting'), JSON.stringify(snap.body.alerts.map((a) => a.kind)));
      }
      if (i === 1) {
        check('…one card for the bout: the second retry updates it, with the same id', alerts().list().filter((a) => a.kind === 'reconnecting' && a.agentIds.includes('rt_a')).length === 1 && card?.id === firstCardId, `${card?.id} / ${firstCardId}`);
      }
      if (i === 0) firstCardId = card?.id;
      const before = runs.length;
      clock.advance(delay - 1);
      await settle(60);
      check('…nothing starts a moment early', runs.length === before && isWaiting('rt_a'));
      clock.advance(1);
      check('…at its time it resumes', await until(() => runs.length === before + 1 && getAgent(db, 'rt_a')?.status === 'working'));
      run = runs[before]!;
      await until(() => run.prompts.length > 0);
      check(
        '…in its own session, told what happened',
        run.options.resume === getAgent(db, 'rt_a')?.sdkSessionId && run.prompts[0] === RETRY_NUDGE,
        `${run.options.resume} / ${JSON.stringify(run.prompts)}`,
      );
      check('…and the card is gone', reconnecting('rt_a') === undefined);
    }
    failWith(run, null, 'unknown');
    check('the sixth failure is failed, as it always was', await until(() => getAgent(db, 'rt_a')?.status === 'failed'), String(getAgent(db, 'rt_a')?.status));
    check('…with no wait left, and the job failed', retryBook().waiting('rt_a') === undefined && clock.pending() === 0 && getJob(db, 'job_retry_a')?.status === 'failed');
    const gave = alerts().list().filter((a) => a.agentIds.includes('rt_a'));
    check('…and Needs You says so, as it did: the outage gave up', gave.length === 1 && gave[0]?.kind === 'connection' && gave[0].gaveUp === true && gave[0].cause === 'unreachable', JSON.stringify(gave));
    check(
      '…and the transcript is told five times, then the failure',
      eventLog().forAgent('rt_a').filter((e) => e.payload.kind === 'status' && e.payload.retry).length === 5 && statusOf('rt_a')?.kind === 'status' && statusOf('rt_a')?.status === 'failed',
    );
    bell.close();

    // Continuing a failed one starts five tries again.
    const atA2 = runs.length;
    await send('POST', '/api/agents/rt_a/message', { text: 'try once more' });
    await until(() => runs.length === atA2 + 1);
    failWith(runs[atA2], null, 'unknown');
    await until(() => isWaiting('rt_a'));
    check('a person continuing a failed agent gets five tries again: the first wait, 5 s', retryOf('rt_a')?.attempt === 1 && retryOf('rt_a')?.delayMs === 5_000, JSON.stringify(retryOf('rt_a')));
    await send('POST', '/api/agents/rt_a/pause');
    await until(() => getAgent(db, 'rt_a')?.status === 'paused');

    // A real reply from the model starts the count again; an API error written as a reply does not.
    rjob('job_retry_c');
    rfix('rt_c', 'job_retry_c');
    const atC = runs.length;
    sup.pump();
    await until(() => runs.length === atC + 1);
    failWith(runs[atC], 429, 'rate_limit');
    await until(() => isWaiting('rt_c'));
    check('throttled waits like the rest: 5 s', retryOf('rt_c')?.cause === 'throttled' && retryOf('rt_c')?.delayMs === 5_000);
    clock.advance(5_000);
    await until(() => runs.length === atC + 2);
    failWith(runs[atC + 1], 529, 'overloaded');
    await until(() => isWaiting('rt_c') && retryOf('rt_c')?.attempt === 2);
    check('the second is 15 s', retryOf('rt_c')?.delayMs === 15_000);
    clock.advance(15_000);
    await until(() => runs.length === atC + 3);
    runs[atC + 2]?.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: overloaded' }] }, error: 'overloaded' });
    runs[atC + 2]?.finish({ cost: 0, isError: true, reason: 'api_error' });
    await until(() => isWaiting('rt_c') && retryOf('rt_c')?.attempt === 3);
    check(
      "an API error written as the assistant's turn is not a reply: the third is 30 s, and it is still the API's trouble",
      retryOf('rt_c')?.attempt === 3 && retryOf('rt_c')?.delayMs === 30_000 && retryOf('rt_c')?.cause === 'throttled',
      JSON.stringify(retryOf('rt_c')),
    );
    clock.advance(30_000);
    await until(() => runs.length === atC + 4);
    runs[atC + 3]?.say({ type: 'assistant', message: { content: [{ type: 'text', text: 'back again' }] } });
    await until(() => retryBook().used('rt_c') === 0);
    check('a real reply starts the count from nothing', retryBook().used('rt_c') === 0);
    failWith(runs[atC + 3], null, 'unknown');
    await until(() => isWaiting('rt_c'));
    check('so the next failure waits 5 s again, as the first', retryOf('rt_c')?.attempt === 1 && retryOf('rt_c')?.delayMs === 5_000, JSON.stringify(retryOf('rt_c')));
    check('…and a different cause is told as it is', retryOf('rt_c')?.cause === 'unreachable');
    await send('POST', '/api/agents/rt_c/terminate');
    await until(() => getAgent(db, 'rt_c')?.status === 'stopped');
    check('stopped while it waits, nothing is left to fire', clock.pending() === 0 && retryBook().waiting('rt_c') === undefined);

    // A failed result that names a status, with no retry announced, is the API's too.
    rjob('job_retry_st');
    rfix('rt_st', 'job_retry_st');
    const atSt = runs.length;
    sup.pump();
    await until(() => runs.length === atSt + 1);
    runs[atSt]?.finish({ cost: 0, isError: true, reason: 'api_error', apiStatus: 503 });
    await until(() => isWaiting('rt_st'));
    check('a 503 on the result alone is a server error, waited out', retryOf('rt_st')?.cause === 'server', JSON.stringify(retryOf('rt_st')));
    clock.advance(5_000);
    await until(() => runs.length === atSt + 2);
    runs[atSt + 1]?.finish({ cost: 0, isError: true, reason: 'api_error', apiStatus: 400 });
    await until(() => getAgent(db, 'rt_st')?.status === 'failed');
    check('a 400 is not: the same request fails the same way', getAgent(db, 'rt_st')?.status === 'failed' && clock.pending() === 0 && getJob(db, 'job_retry_st')?.status === 'failed');

    // What is not retried.
    rjob('job_retry_n');
    const notRetried = ['rt_auth', 'rt_bill', 'rt_budget', 'rt_pause', 'rt_stop', 'rt_plain'];
    for (const id of notRetried) rfix(id, 'job_retry_n');
    const atN = runs.length;
    sup.pump();
    await until(() => runs.length === atN + notRetried.length);
    // Runs start in agent order, so the n-th new run is the n-th agent's.
    const mine = (id: string): FakeRun => runs[atN + notRetried.indexOf(id)]!;

    failWith(mine('rt_auth'), 401, 'authentication_failed');
    await until(() => getAgent(db, 'rt_auth')?.status === 'failed');
    check('a refused login is failed at once: no wait, no timer', getAgent(db, 'rt_auth')?.status === 'failed' && retryBook().waiting('rt_auth') === undefined && retryOf('rt_auth') === undefined && clock.pending() === 0);
    check('and Needs You has it as an outage that needs a person, as before', alerts().list().some((a) => a.kind === 'connection' && a.agentIds.includes('rt_auth') && a.cause === 'auth' && a.gaveUp === true));
    failWith(mine('rt_bill'), 402, 'billing_error');
    await until(() => getAgent(db, 'rt_bill')?.status === 'failed');
    check('so is a billing problem', getAgent(db, 'rt_bill')?.status === 'failed' && retryBook().waiting('rt_bill') === undefined);

    failWith(mine('rt_budget'), 429, 'rate_limit', 'budget_exhausted');
    await until(() => getAgent(db, 'rt_budget')?.status === 'paused');
    check('a budget stop is paused with its reason, never waited out', getAgent(db, 'rt_budget')?.status === 'paused' && retryBook().waiting('rt_budget') === undefined && retryOf('rt_budget') === undefined);

    mine('rt_pause').say({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
    await send('POST', '/api/agents/rt_pause/pause');
    await until(() => getAgent(db, 'rt_pause')?.status === 'paused');
    await settle(60);
    check('your own pause, with the SDK mid-retry, is a pause: no wait', getAgent(db, 'rt_pause')?.status === 'paused' && retryBook().waiting('rt_pause') === undefined);
    mine('rt_stop').say({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
    await send('POST', '/api/agents/rt_stop/terminate');
    await until(() => getAgent(db, 'rt_stop')?.status === 'stopped');
    await settle(60);
    check('and your own stop is a stop', getAgent(db, 'rt_stop')?.status === 'stopped' && retryBook().waiting('rt_stop') === undefined);

    mine('rt_plain').finish({ cost: 0, isError: true, reason: 'max_turns' });
    await until(() => getAgent(db, 'rt_plain')?.status === 'failed');
    check("a failure that is not the API's is failed as before", getAgent(db, 'rt_plain')?.status === 'failed' && retryOf('rt_plain') === undefined);
    check('nothing is waiting anywhere', clock.pending() === 0 && retryBook().list().length === 0, `${clock.pending()} timers`);

    // The job stays live while one of its agents waits, and the others finishing does not settle it.
    rjob('job_retry_j');
    rfix('rt_j1', 'job_retry_j');
    rfix('rt_j2', 'job_retry_j');
    const atJ = runs.length;
    sup.pump();
    await until(() => runs.length === atJ + 2);
    failWith(runs[atJ], 500, 'server_error');
    await until(() => isWaiting('rt_j1'));
    runs[atJ + 1]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'rt_j2')?.status === 'done');
    await settle(60);
    check('the other agent finishing does not settle the job while one waits', getJob(db, 'job_retry_j')?.status === 'working', String(getJob(db, 'job_retry_j')?.status));

    // retry now, and stop retrying.
    const retryNowRoute = (id: string) => send<{ error?: string; detail?: string }>('POST', `/api/agents/${id}/retry-now`);
    const stopRoute = (id: string) => send<{ agent?: Agent; error?: string; detail?: string }>('POST', `/api/agents/${id}/stop-retrying`);
    check('an agent nobody has heard of → 404', (await retryNowRoute('nobody')).status === 404 && (await stopRoute('nobody')).status === 404);
    const notWaiting = await retryNowRoute('rt_j2');
    check('retry now for one that is not waiting → 409, with why', notWaiting.status === 409 && /not waiting to retry/.test(notWaiting.body.detail ?? ''), JSON.stringify(notWaiting.body));
    check('so is stop retrying', (await stopRoute('rt_j2')).status === 409);
    check('rt_j1 has a timer', clock.pending() === 1);
    const pressed = await retryNowRoute('rt_j1');
    check('retry now → 200', pressed.status === 200);
    check('it starts at once, without the clock', await until(() => runs.length === atJ + 3 && getAgent(db, 'rt_j1')?.status === 'working'));
    await until(() => runs[atJ + 2]!.prompts.length > 0);
    check('…in its own session, told what happened', runs[atJ + 2]?.prompts[0] === RETRY_NUDGE && runs[atJ + 2]?.options.resume === getAgent(db, 'rt_j1')?.sdkSessionId);
    check('…and its timer is gone: nothing starts a second time', clock.pending() === 0 && retryBook().waiting('rt_j1') === undefined);
    clock.advance(10 * 60_000);
    await settle(60);
    check('…even when the time it had comes', runs.length === atJ + 3);
    failWith(runs[atJ + 2], 500, 'server_error');
    await until(() => isWaiting('rt_j1'));
    check('the retry now counted: the next wait is 15 s', retryOf('rt_j1')?.attempt === 2 && retryOf('rt_j1')?.delayMs === 15_000, JSON.stringify(retryOf('rt_j1')));
    const stopped2 = await stopRoute('rt_j1');
    check('stop retrying → 200, with the agent, failed', stopped2.status === 200 && stopped2.body.agent?.status === 'failed' && getAgent(db, 'rt_j1')?.status === 'failed');
    const f = statusOf('rt_j1');
    check('failed with the reason the run ended with, as it would have been', f?.kind === 'status' && f.status === 'failed' && f.error === 'api_error' && f.retry === undefined, JSON.stringify(f));
    check('…the timer is gone, the card is gone, and the job is failed now', clock.pending() === 0 && reconnecting('rt_j1') === undefined && getJob(db, 'job_retry_j')?.status === 'failed');
    check(
      '…and Needs You has the failure',
      alerts().list().some((a) => a.kind === 'failed' && a.agentIds.includes('rt_j1') && a.cause === 'api_error'),
      JSON.stringify(alerts().list().filter((a) => a.agentIds.includes('rt_j1'))),
    );
    check('another stop retrying → 409', (await stopRoute('rt_j1')).status === 409);

    // The slot is free while it waits, and taken again when it resumes.
    await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: '1' } });
    rjob('job_retry_s');
    rfix('rt_s1', 'job_retry_s');
    rfix('rt_s2', 'job_retry_s');
    const atS = runs.length;
    sup.pump();
    await until(() => runs.length === atS + 1 && sup.slots.used === 1);
    const first = getAgent(db, 'rt_s1')?.status === 'working' ? 'rt_s1' : 'rt_s2';
    const other = first === 'rt_s1' ? 'rt_s2' : 'rt_s1';
    check('one slot: one agent runs, the other waits for it', getAgent(db, other)?.status === 'queued' && runs.length === atS + 1);
    failWith(runs[atS], null, 'unknown');
    await until(() => isWaiting(first));
    check('the one waiting for the model gives up its slot…', await until(() => getAgent(db, other)?.status === 'working' && runs.length === atS + 2));
    check('…and the queued one takes it', sup.slots.used === 1 && getAgent(db, first)?.status === 'queued');
    clock.advance(5_000);
    await settle(100);
    check('its time comes with no slot free: it keeps waiting, and no more than one runs', getAgent(db, first)?.status === 'queued' && sup.slots.used === 1 && runs.length === atS + 2);
    runs[atS + 1]?.finish({ cost: 0, reason: 'completed' });
    check(
      'a slot frees and it takes one again, resuming its session',
      (await until(() => runs.length === atS + 3 && getAgent(db, first)?.status === 'working')) && runs[atS + 2]?.options.resume === getAgent(db, first)?.sdkSessionId,
    );
    await until(() => runs[atS + 2]!.prompts.length > 0);
    check('…with the nudge', runs[atS + 2]?.prompts[0] === RETRY_NUDGE);
    runs[atS + 2]?.finish({ cost: 0, reason: 'completed' });
    await until(() => sup.slots.used === 0);
    await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: null } });

    // Stopped or paused while it waits: the wait goes, and so does the count.
    rjob('job_retry_w');
    rfix('rt_w1', 'job_retry_w');
    rfix('rt_w2', 'job_retry_w');
    const atW = runs.length;
    sup.pump();
    await until(() => runs.length === atW + 2);
    failWith(runs[atW], null, 'unknown');
    failWith(runs[atW + 1], null, 'unknown');
    await until(() => isWaiting('rt_w1') && isWaiting('rt_w2'));
    check('two waiting, two timers', clock.pending() === 2);
    await send('POST', '/api/agents/rt_w1/pause');
    check(
      'pausing one takes its wait and timer away',
      (await until(() => getAgent(db, 'rt_w1')?.status === 'paused')) && retryBook().waiting('rt_w1') === undefined && clock.pending() === 1 && retryBook().used('rt_w1') === 0,
    );
    await send('POST', '/api/agents/rt_w2/terminate');
    check('and so does stopping one', (await until(() => getAgent(db, 'rt_w2')?.status === 'stopped')) && clock.pending() === 0 && retryBook().used('rt_w2') === 0);
    clock.advance(10 * 60_000);
    await settle(60);
    check('nothing starts when their time comes', runs.length === atW + 2 && getAgent(db, 'rt_w1')?.status === 'paused');
    const atW2 = runs.length;
    await send('POST', '/api/agents/rt_w1/resume');
    await until(() => runs.length === atW2 + 1);
    await until(() => runs[atW2]!.prompts.length > 0);
    check('resumed, it is woken as a paused agent is, not told the model failed', runs[atW2]?.prompts[0] === WAKE_NUDGE, JSON.stringify(runs[atW2]?.prompts));
    runs[atW2]?.finish({ cost: 0, reason: 'completed' });

    // Everything paused until a time: the wait ends, and nothing starts until it is released.
    rjob('job_retry_h');
    rfix('rt_h', 'job_retry_h');
    const atH = runs.length;
    sup.pump();
    await until(() => runs.length === atH + 1);
    failWith(runs[atH], null, 'unknown');
    await until(() => isWaiting('rt_h'));
    await sup.hold();
    const heldNow = await retryNowRoute('rt_h');
    check('while everything is paused, retry now is refused with why', heldNow.status === 409 && /paused until/.test(heldNow.body.detail ?? ''), JSON.stringify(heldNow.body));
    clock.advance(5_000);
    await settle(80);
    check('and when its time comes nothing starts', runs.length === atH + 1 && getAgent(db, 'rt_h')?.status === 'queued' && retryBook().waiting('rt_h') === undefined);
    sup.release();
    check('released, it starts as any queued agent does', await until(() => runs.length === atH + 2 && getAgent(db, 'rt_h')?.status === 'working'));
    runs[atH + 1]?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, 'rt_h')?.status === 'done');

    // A restart while waiting: the agent carries on as one a restart interrupted, with five tries again.
    rjob('job_retry_r');
    rfix('rt_r', 'job_retry_r');
    const atR = runs.length;
    sup.pump();
    await until(() => runs.length === atR + 1);
    failWith(runs[atR], null, 'unknown');
    await until(() => isWaiting('rt_r'));
    check('waiting, with the wait only in memory', retryOf('rt_r')?.attempt === 1 && getAgent(db, 'rt_r')?.sdkSessionId !== null);
    resetRetryBook(clock); // the process is gone, and with it every wait
    check('a restart forgets the wait', retryBook().waiting('rt_r') === undefined && retryBook().used('rt_r') === 0);
    sup.reconcile();
    sup.pump();
    check(
      'the agent is resumed on its own, in its own session',
      (await until(() => runs.length === atR + 2 && getAgent(db, 'rt_r')?.status === 'working')) && runs[atR + 1]?.options.resume === getAgent(db, 'rt_r')?.sdkSessionId,
    );
    await until(() => runs[atR + 1]!.prompts.length > 0);
    check('told a restart stopped it, as any agent is', runs[atR + 1]?.prompts[0] === RESTART_NUDGE, JSON.stringify(runs[atR + 1]?.prompts));
    failWith(runs[atR + 1], null, 'unknown');
    await until(() => isWaiting('rt_r'));
    check('and the count starts again: the first wait, 5 s', retryOf('rt_r')?.attempt === 1 && retryOf('rt_r')?.delayMs === 5_000);
    await send('POST', '/api/agents/rt_r/terminate');
    await until(() => getAgent(db, 'rt_r')?.status === 'stopped');

    // The Copilot engine, and OpenRouter on the same one (Amendment 76): session.error carries the type and status.
    check(
      "the runtime's errors are told apart: a throttle, a 5xx and a lost connection wait; a login, a quota, a full context and a bad query do not",
      apiFailureOf({ message: 'x', errorType: 'rate_limit', statusCode: 429 })?.error === 'rate_limit' &&
        apiFailureOf({ message: 'x', statusCode: 502 })?.error === 'server_error' &&
        apiFailureOf({ message: 'request to https://api failed: ECONNRESET' })?.httpStatus === null &&
        apiFailureOf({ message: 'x', errorType: 'authentication' })?.error === 'authentication_failed' &&
        apiFailureOf({ message: 'x', errorType: 'quota' })?.error === 'billing_error' &&
        failureCause(apiFailureOf({ message: 'x', errorType: 'authentication' })) === 'auth' &&
        failureCause(apiFailureOf({ message: 'x', errorType: 'context_limit' })) === null &&
        failureCause(apiFailureOf({ message: 'x', errorType: 'query' })) === null &&
        failureCause(apiFailureOf({ message: 'x', statusCode: 404 })) === null &&
        apiFailureOf({ message: 'model gpt-9 is not available' }) === null,
    );
    const cpRetry = (id: string, provider: 'copilot' | 'openrouter', model: string): void => {
      rjob(`job_${id}`);
      rfix(id, `job_${id}`, { model, provider } as Partial<Agent>);
    };
    const sessionNth = async (id: string, nth = 1): Promise<FakeCopilotSession | undefined> => {
      await until(() => copilotSessions.filter((x) => x.id === id).length >= nth);
      return copilotSessions.filter((x) => x.id === id)[nth - 1];
    };
    process.env['OPENROUTER_API_KEY'] = 'sk-or-verify';
    for (const [provider, model] of [['copilot', 'gpt-5-mini'], ['openrouter', 'anthropic/claude-sonnet-4.5']] as const) {
      const id = `rt_cp_${provider}`;
      cpRetry(id, provider, model);
      sup.pump();
      const c1 = await sessionNth(id);
      c1?.emit('session.error', { errorType: 'rate_limit', statusCode: 429, message: 'Too many requests' });
      await until(() => isWaiting(id));
      check(`${provider}: a throttle waits 5 s, queued`, retryOf(id)?.cause === 'throttled' && retryOf(id)?.delayMs === 5_000 && retryOf(id)?.attempt === 1, JSON.stringify(retryOf(id)));
      check(`${provider}: its slot is free and its job live`, sup.slots.used === 0 && getJob(db, `job_${id}`)?.status === 'working');
      clock.advance(5_000);
      const c2 = await sessionNth(id, 2);
      await until(() => (c2?.prompts.length ?? 0) > 0);
      check(`${provider}: it resumes its own session, told what happened`, c2?.resumed === true && c2.id === id && c2.prompts[0]?.prompt === RETRY_NUDGE, JSON.stringify(c2?.prompts));
      c2?.emit('assistant.message', { messageId: 'mr', content: 'Back.' });
      c2?.emit('session.error', { errorType: 'unknown', message: 'read ECONNRESET' });
      await until(() => isWaiting(id));
      check(`${provider}: a reply starts the count again, so a lost connection waits 5 s`, retryOf(id)?.cause === 'unreachable' && retryOf(id)?.attempt === 1 && retryOf(id)?.delayMs === 5_000, JSON.stringify(retryOf(id)));
      clock.advance(5_000);
      const c3 = await sessionNth(id, 3);
      c3?.emit('session.error', { errorType: 'authentication', statusCode: 401, message: 'bad credentials' });
      await until(() => getAgent(db, id)?.status === 'failed');
      check(`${provider}: a refused login is failed at once`, getAgent(db, id)?.status === 'failed' && retryBook().waiting(id) === undefined && getJob(db, `job_${id}`)?.status === 'failed');
    }
    delete process.env['OPENROUTER_API_KEY'];
    cpRetry('rt_cp_query', 'copilot', 'gpt-5-mini');
    sup.pump();
    const cb = await sessionNth('rt_cp_query');
    cb?.emit('session.error', { errorType: 'query', message: 'the query was refused' });
    await until(() => getAgent(db, 'rt_cp_query')?.status === 'failed');
    check("copilot: an error that is not the API's is failed as before", getAgent(db, 'rt_cp_query')?.status === 'failed' && retryOf('rt_cp_query') === undefined);

    // ── the delays are a setting (Amendment 140) ──
    const setDelays = (v: unknown) => send<{ detail?: string }>('PATCH', '/api/settings', { settings: { [RETRY_DELAYS_KEY]: v } });
    const refusedDelays: number[] = [];
    for (const bad of ['', '0', '5, 15, 30, 60, 300, 600', '1801', '2.5', 'soon', '5,,15', '-5']) refusedDelays.push((await setDelays(bad)).status);
    check(
      'a delay list that is not 1-5 whole seconds, each 1 to 1800, is refused → 400, and the default stays',
      refusedDelays.every((s) => s === 400) && retryDelaysMs().join() === RETRY_DELAYS_MS.join(),
      refusedDelays.join(),
    );
    check('the sentence says what will do', /one to 5 whole numbers of seconds, separated by commas, each from 1 to 1800/.test((await setDelays('0')).body.detail ?? ''));
    check('the longest it takes is 30 min, and five of them', (await setDelays('1800, 1800, 1800, 1800, 1800')).status === 200 && retryDelaysMs().join() === '1800000,1800000,1800000,1800000,1800000');
    check('a good one is taken, spaces or none', (await setDelays('2,7')).status === 200 && (await setDelays('2, 7')).status === 200 && retryDelaysMs().join() === '2000,7000', retryDelaysMs().join());
    check(
      'the rule reads it: two tries, 2 s then 7 s, and the third failure is out of tries',
      JSON.stringify(ended({ used: 0 })) === '{"retry":true,"cause":"unreachable","attempt":1,"of":2,"delayMs":2000}' &&
        JSON.stringify(ended({ used: 1 })) === '{"retry":true,"cause":"unreachable","attempt":2,"of":2,"delayMs":7000}' &&
        JSON.stringify(ended({ used: 2 })) === '{"retry":false,"why":"out_of_tries"}',
      JSON.stringify([ended({ used: 0 }), ended({ used: 1 }), ended({ used: 2 })]),
    );
    rjob('job_retry_set');
    rfix('rt_set', 'job_retry_set');
    const atSet = runs.length;
    sup.pump();
    await until(() => runs.length === atSet + 1);
    failWith(runs[atSet], null, 'unknown');
    await until(() => isWaiting('rt_set'));
    const setCard = reconnecting('rt_set');
    check(
      'through the supervisor: it waits the set 2 s (1 of 2), and the card is up at the first',
      retryOf('rt_set')?.delayMs === 2_000 && retryOf('rt_set')?.of === 2 && setCard?.attempt === 1 && setCard.maxRetries === 2,
      `${JSON.stringify(retryOf('rt_set'))} ${JSON.stringify(setCard)}`,
    );
    check(
      '…and the transcript says the set time',
      eventLog().forAgent('rt_set').some((e) => e.payload.kind === 'status' && e.payload.error === "can't reach the model — trying again in 2 s (1 of 2)"),
    );
    clock.advance(1_999);
    await settle(60);
    check('…nothing starts a moment early', runs.length === atSet + 1 && isWaiting('rt_set'));
    clock.advance(1);
    check('…at 2 s it resumes', await until(() => runs.length === atSet + 2 && getAgent(db, 'rt_set')?.status === 'working'));
    failWith(runs[atSet + 1], null, 'unknown');
    await until(() => isWaiting('rt_set'));
    check('…the second wait is the set 7 s (2 of 2)', retryOf('rt_set')?.delayMs === 7_000 && retryOf('rt_set')?.attempt === 2 && retryOf('rt_set')?.of === 2, JSON.stringify(retryOf('rt_set')));
    clock.advance(7_000);
    await until(() => runs.length === atSet + 3);
    failWith(runs[atSet + 2], null, 'unknown');
    check('…and the third failure is failed: two tries were all it had', await until(() => getAgent(db, 'rt_set')?.status === 'failed') && retryBook().waiting('rt_set') === undefined && reconnecting('rt_set') === undefined);
    check('removing the setting puts the default back', (await setDelays(null)).status === 200 && retryDelaysMs().join() === RETRY_DELAYS_MS.join() && JSON.stringify(ended({ used: 0 })).includes('"of":5'));

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    resetRetryBook();
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n24 · an agent's budget warns, and stops it only at twice the budget (Amendment 124)");
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);

    // The thresholds, pure: the one copy the screens read too.
    // What the budget reads is the agent's spend today (Amendment 129); the lifetime figures aren't in it.
    const spend = (usd: number, budgetUsd: number | null, inputTokens = 0, outputTokens = 0, budgetTokens?: number) => ({
      spentToday: { day: localDay(), usd, tokens: inputTokens + outputTokens },
      autonomy: { ...DEFAULT_AUTONOMY, budgetUsd, ...(budgetTokens !== undefined ? { budgetTokens } : {}) },
    });
    check('under the budget: ok', budgetState(spend(24.99, 25)) === 'ok');
    check('at it: over, which is only a warning', budgetState(spend(25, 25)) === 'over' && budgetState(spend(49.99, 25)) === 'over');
    check('at twice it: the ceiling', budgetState(spend(50, 25)) === 'ceiling' && budgetState(spend(900, 25)) === 'ceiling');
    check('no budget is never anything', budgetState(spend(1e6, null)) === 'ok' && capState(1e6, null) === 'ok');
    check('a token budget goes through the same two lines', budgetState(spend(0, null, 300_000, 199_999, 500_000)) === 'ok' && budgetState(spend(0, null, 300_000, 200_000, 500_000)) === 'over' && budgetState(spend(0, null, 600_000, 400_000, 500_000)) === 'ceiling');
    check('tokens never stand in for dollars: a dollar budget is read in dollars whatever the tokens', budgetState(spend(1, 25, 9_000_000, 0)) === 'ok');
    check('the ceiling is twice the budget', ceilingOf(25) === 50 && ceilingOf(500_000) === 1_000_000);
    check('the SDK is given what is left of the ceiling, never the budget', near(runLimit(25, 20) ?? undefined, 30) && near(runLimit(25, 49) ?? undefined, 1) && runLimit(25, 60) === 0 && runLimit(null, 20) === null);
    const pair = [{ autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } }, { autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } }];
    check('a job goes through them too: the sum of its budgets, and twice it', jobBudgetState(pair, 49) === 'ok' && jobBudgetState(pair, 50) === 'over' && jobBudgetState(pair, 99) === 'over' && jobBudgetState(pair, 100) === 'ceiling');
    check('one agent without a budget leaves the job without one', jobBudgetState([...pair, { autonomy: DEFAULT_AUTONOMY }], 1e6) === 'ok');

    const bpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'budget124' })).body.project.id;
    const bjob = (id: string): void => {
      insertJob(db, { id, projectId: bpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const bfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: bpid, ...a });
    const warns = (agentId?: string): Alert[] => alerts().list().filter((a) => a.kind === 'budget_over' && (agentId === undefined || a.agentIds.includes(agentId)));
    const stops = (agentId: string): Alert[] => alerts().list().filter((a) => a.kind === 'budget' && a.agentIds.includes(agentId));
    const statusNote = (agentId: string): string | null => {
      const p = lastStatus(agentId);
      return p?.kind === 'status' ? (p.error ?? null) : null;
    };
    const eyes = await connect();
    const said = (agentId: string, text = 'carry on') => send<{ delivery?: string; detail?: string }>('POST', `/api/agents/${agentId}/message`, { text });

    // ── a Claude agent, in dollars: $25 budget, $50 ceiling ────────────────────
    bjob('job_b124');
    bfix('b_over', 'job_b124', { sdkSessionId: 'sess_b_over', costUsd: 20 });
    check('under its budget there is nothing to warn about', warns('b_over').length === 0);
    let at = runs.length;
    check('a message resumes it', (await said('b_over')).body.delivery === 'resumed' && (await until(() => runs.length === at + 1)));
    check('the SDK is given the $30 left under the ceiling, not the $5 left under the budget', near(runs[at]?.options.maxBudgetUsd, 30), String(runs[at]?.options.maxBudgetUsd));
    runs[at]?.finish({ cost: 27, reason: 'completed' });
    await until(() => getAgent(db, 'b_over')?.status === 'done' && warns('b_over').length === 1);
    const first = warns('b_over')[0];
    check(
      'past its budget it is warned about, with the spend, the budget and the unit',
      first !== undefined && first.cause === 'budget_over' && near(first.spent, 27) && first.budget === 25 && first.unit === 'usd' && first.jobId === 'job_b124' && first.projectId === bpid,
      JSON.stringify(first),
    );
    check('and it was not stopped: done, not paused or failed, with no budget-reached alert', getAgent(db, 'b_over')?.status === 'done' && stops('b_over').length === 0, getAgent(db, 'b_over')?.status);
    check('every tab hears it', eyes.frames.some((f) => f.type === 'alerts' && f.alerts.some((a) => a.kind === 'budget_over' && a.agentIds.includes('b_over'))));
    check('and a fresh tab gets it in the snapshot', (await get<Snapshot>('/api/snapshot')).body.alerts.some((a) => a.id === first?.id));

    at = runs.length;
    const kept = await said('b_over', 'keep going');
    check('a message to it is not refused: it carries on past its budget', kept.status === 200 && kept.body.delivery === 'resumed' && (await until(() => runs.length === at + 1)), JSON.stringify(kept.body));
    check('with the $23 left under the ceiling', near(runs[at]?.options.maxBudgetUsd, 23), String(runs[at]?.options.maxBudgetUsd));
    check('and the warning stands while it works', getAgent(db, 'b_over')?.status === 'working' && warns('b_over').length === 1);
    runs[at]?.finish({ cost: 28, reason: 'completed' });
    await until(() => getAgent(db, 'b_over')?.status === 'done' && near(warns('b_over')[0]?.spent, 28));
    check('it is one warning, not one a turn: the same id, the same time, the new spend', warns('b_over').length === 1 && warns('b_over')[0]!.id === first!.id && warns('b_over')[0]!.since === first!.since && near(warns('b_over')[0]!.spent, 28));

    // Raising the budget is what the card's +$10 / +$25 do: it clears the warning, with no status change to say so.
    const mark = eyes.frames.length;
    const raised = await send<{ autonomy: Agent['autonomy'] }>('POST', '/api/agents/b_over/autonomy', { autonomy: { budgetUsd: 30 } });
    check('the budget can be raised', raised.status === 200 && raised.body.autonomy.budgetUsd === 30);
    check('which clears the warning', warns('b_over').length === 0 && getAgent(db, 'b_over')?.status === 'done');
    check('and every tab is told', eyes.frames.slice(mark).some((f) => f.type === 'alerts' && !f.alerts.some((a) => a.kind === 'budget_over' && a.agentIds.includes('b_over'))));

    // Over the new budget it is a new warning, and putting that away lasts.
    at = runs.length;
    await said('b_over', 'more');
    await until(() => runs.length === at + 1);
    check('the SDK is given the $32 left under the new ceiling of $60', near(runs[at]?.options.maxBudgetUsd, 32), String(runs[at]?.options.maxBudgetUsd));
    runs[at]?.finish({ cost: 31, reason: 'completed' });
    await until(() => getAgent(db, 'b_over')?.status === 'done' && warns('b_over').length === 1);
    const second = warns('b_over')[0];
    check('over the raised budget it warns again, as a new alert', second !== undefined && second.id !== first!.id && second.budget === 30, JSON.stringify(second));
    const dismissed = await fetch(`${BASE}/api/alerts/${encodeURIComponent(second!.id)}/dismiss`, { method: 'POST' });
    check('and it can be put away → 204', dismissed.status === 204 && warns('b_over').length === 0);
    at = runs.length;
    await said('b_over', 'and more');
    await until(() => runs.length === at + 1);
    runs[at]?.finish({ cost: 33, reason: 'completed' });
    await until(() => getAgent(db, 'b_over')?.status === 'done' && near(getAgent(db, 'b_over')?.costUsd, 33));
    await settle(60);
    check('which lasts: more spending past the same budget does not ask again', warns('b_over').length === 0);

    // The ceiling: twice the budget stops it, exactly as the budget used to.
    at = runs.length;
    await said('b_over', 'last one');
    await until(() => runs.length === at + 1);
    check('the SDK is given the $27 left under the ceiling', near(runs[at]?.options.maxBudgetUsd, 27), String(runs[at]?.options.maxBudgetUsd));
    runs[at]?.finish({ cost: 60.5, subtype: 'error_max_budget_usd', isError: true });
    await until(() => getAgent(db, 'b_over')?.status === 'paused');
    check('at the ceiling it is paused, not failed', getAgent(db, 'b_over')?.status === 'paused');
    check('saying what it spent, against what budget, and where that stops it', statusNote('b_over') === 'budget reached for today — spent $60.50 of its $30 daily budget, which stops it at $60', String(statusNote('b_over')));
    check('and Needs You has the budget-reached card, not a warning', stops('b_over').length === 1 && stops('b_over')[0]!.cause === 'budget_exhausted' && warns('b_over').length === 0, JSON.stringify(alerts().list().filter((a) => a.agentIds.includes('b_over'))));
    const refused = await said('b_over', 'please');
    check('a message is refused with 409, and the sentence', refused.status === 409 && refused.body.detail === 'The Builder has spent $60.50 of its $30 daily budget today, which stops it at $60 — raise it to continue, or it renews at midnight.', JSON.stringify(refused));
    check('so is resume', (await send('POST', '/api/agents/b_over/resume')).status === 409);
    await send('POST', '/api/agents/b_over/autonomy', { autonomy: { budgetUsd: 40 } });
    at = runs.length;
    check('raised to $40 (a ceiling of $80), resume is accepted', (await send('POST', '/api/agents/b_over/resume')).status === 200 && (await until(() => runs.length === at + 1)));
    check('with the $19.50 left under it', near(runs[at]?.options.maxBudgetUsd, 19.5), String(runs[at]?.options.maxBudgetUsd));
    check('and the card clears with the pause', stops('b_over').length === 0);
    runs[at]?.finish({ cost: 61, reason: 'completed' });
    await until(() => getAgent(db, 'b_over')?.status === 'done' && warns('b_over').length === 1);
    check('still over the raised budget ($61 of $40), it warns again', warns('b_over')[0]?.budget === 40);

    // ── an agent that is paused or stopped is not warned about ─────────────────
    bfix('b_paused', 'job_b124', { role: 'reviewer', status: 'paused', sdkSessionId: 'sess_b_paused', costUsd: 30 });
    bfix('b_stopped', 'job_b124', { role: 'validator', status: 'stopped', costUsd: 30 });
    bfix('b_failed', 'job_b124', { role: 'tester', status: 'failed', costUsd: 30 });
    check('over its budget but paused, stopped or failed, there is no warning: nothing is spending', warns('b_paused').length === 0 && warns('b_stopped').length === 0 && warns('b_failed').length === 0);

    // ── an engine in tokens: a 500k budget, a 1M ceiling ─────────────────────────
    registerBackend(fakeEngine('copilot', async () => []));
    const t0 = tokenRuns.length;
    const made = await send<{ agents?: Agent[] }>('POST', '/api/jobs', {
      projectId: bpid,
      prompt: 'p124',
      isolation: 'in_place',
      agents: [{ role: 'builder', model: 'gpt-5', provider: 'copilot', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000 } }],
    });
    const tid = made.body.agents?.[0]?.id ?? '';
    check('a token-budget agent runs', await until(() => tokenRuns.length === t0 + 1 && getAgent(db, tid)?.status === 'working'), JSON.stringify(made.body).slice(0, 200));
    // What the real backend does on each model call: the totals, then the usage event.
    const usage = (inputTokens: number, outputTokens: number): void => {
      // And the day's figure grows by the call's tokens, which is what the budget reads (Amendment 129).
      const had = getAgent(db, tid)!;
      setAgentUsage(db, tid, { costUsd: 0, inputTokens, outputTokens });
      addSpendToday(db, tid, { tokens: inputTokens + outputTokens - (had.inputTokens + had.outputTokens) });
      eventLog().emit({ projectId: bpid, jobId: getAgent(db, tid)!.jobId, agentId: tid }, { kind: 'usage', costUsd: 0, inputTokens, outputTokens });
    };
    usage(300_000, 150_000);
    check('under 500k: nothing', warns(tid).length === 0);
    usage(350_000, 200_000);
    check('over it mid-run, the warning is raised, in tokens', await until(() => warns(tid).length === 1), JSON.stringify(alerts().list()));
    check('with the tokens spent and the budget', warns(tid)[0]?.unit === 'tokens' && warns(tid)[0]?.spent === 550_000 && warns(tid)[0]?.budget === 500_000, JSON.stringify(warns(tid)));
    check('and it is still working: nothing stops a token budget below twice it', getAgent(db, tid)?.status === 'working' && budgetRefusal(getAgent(db, tid)!) === null);
    usage(450_000, 300_000);
    check('spending on updates the same warning', await until(() => warns(tid).length === 1 && warns(tid)[0]?.spent === 750_000));
    usage(500_000, 500_000);
    check('at 1M it is the ceiling, which the backend refuses at', budgetRefusal(getAgent(db, tid)!) !== null && budgetState(getAgent(db, tid)!) === 'ceiling');
    tokenRuns[t0]?.end({ input: 500_000, output: 500_000, atCap: true });
    await until(() => getAgent(db, tid)?.status === 'paused');
    check('the run ends paused, with the note in tokens', getAgent(db, tid)?.status === 'paused' && statusNote(tid) === 'budget reached for today — spent 1M of its 500k-token daily budget, which stops it at 1M', String(statusNote(tid)));
    check('Needs You has the budget-reached card for it, and no warning', stops(tid).length === 1 && warns(tid).length === 0);
    await send('POST', `/api/agents/${tid}/autonomy`, { autonomy: { budgetTokens: 1_000_000 } });
    check('raised to 1M (a ceiling of 2M), it may run again', budgetRefusal(getAgent(db, tid)!) === null);
    await send('POST', `/api/agents/${tid}/resume`);
    check('and does', await until(() => tokenRuns.length === t0 + 2));
    check('at the raised 1M budget it is over it again, so the warning returns', await until(() => warns(tid).length === 1), JSON.stringify(warns(tid)));
    tokenRuns[t0 + 1]?.end({ input: 500_000, output: 500_000 });
    await until(() => getAgent(db, tid)?.status === 'done');

    // ── a job: the sum of its agents' budgets, warned at 1x, held at 2x ──────────
    bjob('job_b124_job');
    bfix('bj_a', 'job_b124_job', { sdkSessionId: 'sess_bj_a', costUsd: 30 });
    bfix('bj_b', 'job_b124_job', { role: 'reviewer', status: 'queued', dependsOn: ['bj_a'], costUsd: 22 });
    at = runs.length;
    sup.pump();
    await until(() => runs.length === at + 1);
    check('52 spent of the job\'s $50 (25 + 25): a queued agent still starts — the job only warns', getAgent(db, 'bj_b')?.status === 'working');
    const jobWarn = alerts().list().filter((a) => a.kind === 'budget_over' && a.cause === 'job_budget_over' && a.jobId === 'job_b124_job');
    check('and the job is warned about, with the sum, and no one agent named', jobWarn.length === 1 && near(jobWarn[0]?.spent, 52) && jobWarn[0]?.budget === 50 && jobWarn[0]?.agentIds.length === 0 && jobWarn[0]?.unit === 'usd', JSON.stringify(jobWarn));
    runs[at]?.finish({ cost: 22, reason: 'completed' });
    await until(() => getAgent(db, 'bj_b')?.status === 'done');
    check('with nothing left that could spend, the job warning goes (the agent one stays)', !alerts().list().some((a) => a.cause === 'job_budget_over' && a.jobId === 'job_b124_job') && warns('bj_a').length === 1);

    bjob('job_b124_ceil');
    bfix('bc_a', 'job_b124_ceil', { sdkSessionId: 'sess_bc_a', costUsd: 55 });
    bfix('bc_b', 'job_b124_ceil', { role: 'reviewer', status: 'queued', dependsOn: ['bc_a'], costUsd: 45 });
    at = runs.length;
    sup.pump();
    await until(() => getAgent(db, 'bc_b')?.status !== 'queued');
    await settle(60);
    check('at twice the job budget (100 of 50), the queued agent is held, as it was at the budget before', getAgent(db, 'bc_b')?.status === 'paused' && statusNote('bc_b') === JOB_BUDGET_NOTE && runs.length === at, `${getAgent(db, 'bc_b')?.status} ${statusNote('bc_b')}`);
    check('with the job-budget card', stops('bc_b').length === 1 && stops('bc_b')[0]!.cause === 'job_budget_reached');
    await send('POST', '/api/agents/bc_b/autonomy', { autonomy: { budgetUsd: 50 } });
    check('raise one agent\'s budget ($25 to $50) and the job\'s ceiling is $150, so it may start', (await send('POST', '/api/agents/bc_b/resume')).status === 200 && (await until(() => runs.length === at + 1)));
    runs[at]?.finish({ cost: 45, reason: 'completed' });
    await until(() => getAgent(db, 'bc_b')?.status === 'done');

    // ── the ceiling is a setting (Amendment 140) ────────────────────────────────
    const setCeiling = (v: unknown) => send<{ detail?: string }>('PATCH', '/api/settings', { settings: { [BUDGET_CEILING_KEY]: v } });
    const refusedCeil: number[] = [];
    for (const bad of ['0.5', '0', '10.5', '11', 'twice', '', 'Infinity', '-2']) refusedCeil.push((await setCeiling(bad)).status);
    check('a ceiling that is not a number from 1 to 10 is refused → 400, and twice stays', refusedCeil.every((s) => s === 400) && budgetCeiling() === 2 && ceilingOf(25) === 50, refusedCeil.join());
    check('the sentence says what will do', /a number from 1 to 10/.test((await setCeiling('11')).body.detail ?? ''));
    bfix('b_ceil', 'job_b124', { sdkSessionId: 'sess_b_ceil', costUsd: 40 });
    alerts().refresh();
    check('at twice, $40 of $25 is over its budget and only warned about', budgetState(getAgent(db, 'b_ceil')!) === 'over' && warns('b_ceil').length === 1);
    const ceilMark = eyes.frames.length;
    check('1.5 is taken', (await setCeiling('1.5')).status === 200 && budgetCeiling() === 1.5);
    check('the ceiling is the budget times it, read at once', ceilingOf(25) === 37.5 && ceilingOf(500_000) === 750_000 && ceilingOf(25, 2) === 50 && ceilingOf(25, 1.1) === 27.5);
    check(
      'the lines move with it: an agent, a token budget and a job',
      budgetState(spend(37.49, 25)) === 'over' && budgetState(spend(37.5, 25)) === 'ceiling' &&
        budgetState(spend(0, null, 500_000, 249_999, 500_000)) === 'over' && budgetState(spend(0, null, 500_000, 250_000, 500_000)) === 'ceiling' &&
        jobBudgetState(pair, 74.99) === 'over' && jobBudgetState(pair, 75) === 'ceiling',
    );
    check('the SDK is given what is left of the new ceiling', near(runLimit(25, 20) ?? undefined, 17.5), String(runLimit(25, 20)));
    check('the change is told at once: $40 is past the new ceiling, so its warning goes', warns('b_ceil').length === 0 && eyes.frames.slice(ceilMark).some((f) => f.type === 'alerts'));
    const ceilRefused = await said('b_ceil');
    check(
      'a message to it is refused at the 1.5x ceiling, the sentence saying where it stops',
      ceilRefused.status === 409 && ceilRefused.body.detail === 'The Builder has spent $40 of its $25 daily budget today, which stops it at $37.50 — raise it to continue, or it renews at midnight.',
      JSON.stringify(ceilRefused.body),
    );
    check('the pause note says the same', budgetNote(getAgent(db, 'b_ceil')!) === 'budget reached for today — spent $40 of its $25 daily budget, which stops it at $37.50', budgetNote(getAgent(db, 'b_ceil')!));
    check('at 1 the budget is the stop', (await setCeiling('1')).status === 200 && budgetState(spend(25, 25)) === 'ceiling' && budgetState(spend(24.99, 25)) === 'ok');
    check('10 is taken', (await setCeiling('10')).status === 200 && budgetCeiling() === 10);
    at = runs.length;
    const ceilGo = await said('b_ceil', 'go on');
    check('and at 10 it runs again, the SDK given the $210 left under $250', ceilGo.status === 200 && (await until(() => runs.length === at + 1)) && near(runs[at]?.options.maxBudgetUsd, 210), `${JSON.stringify(ceilGo.body)} ${runs[at]?.options.maxBudgetUsd}`);
    runs[at]?.finish({ cost: 41, reason: 'completed' });
    await until(() => getAgent(db, 'b_ceil')?.status === 'done');
    check('removing the setting puts twice back', (await setCeiling(null)).status === 200 && budgetCeiling() === 2 && ceilingOf(25) === 50);

    eyes.close();
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    if (enginesBefore.copilot) registerBackend(enginesBefore.copilot);
    if (enginesBefore.openrouter) registerBackend(enginesBefore.openrouter);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n25 · orchestrated stacks: one agent starts the others, as the roles it was launched with (Amendment 128)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    // Nothing is known of what the gateway serves, so a model id is checked only against the nicknames.
    forgetCatalog();

    const O_OPUS = 'claude-opus-o128';
    const O_SONNET = 'claude-sonnet-o128';
    const O_HAIKU = 'claude-haiku-o128';
    const tierIds = { opus: O_OPUS, sonnet: O_SONNET, haiku: O_HAIKU };
    const rope = (a: Partial<Agent['autonomy']> = {}): Agent['autonomy'] => ({ ...DEFAULT_AUTONOMY, budgetUsd: 5, ...a });
    const ROLES: HelperRole[] = [
      { id: 'developer', tier: 'sonnet', model: O_SONNET, brief: 'Implement the work.', systemPrompt: 'DEVELOPER PROMPT o128', skills: ['tdd'], autonomy: rope({ mode: 'acceptEdits' }), tiers: tierIds },
      { id: 'reviewer', tier: 'opus', model: O_OPUS, brief: 'Review the change.', systemPrompt: 'REVIEWER PROMPT o128', autonomy: rope({ mode: 'default', disallowedTools: [...WRITE_TOOLS] }), tiers: tierIds },
      { id: 'scribe', tier: 'haiku', model: O_HAIKU, brief: 'Write it down.', systemPrompt: 'SCRIBE PROMPT o128', autonomy: rope({ mode: 'acceptEdits' }), tiers: tierIds },
    ];

    // ── the pure rules, shared with the screens ─────────────────────────────────
    check('the helpers a stack may start in all: each role once, and sent back twice', SEND_BACKS_MAX === 2 && pipelineHelperCap(4) === 12 && pipelineHelperCap(3) === 9 && pipelineHelperCap(1) === 3);
    check('one agent needs no orchestrator; two or more do', !showsOrchestrator(0) && !showsOrchestrator(1) && showsOrchestrator(2) && showsOrchestrator(5));
    const lone = { id: 'o', pipelineRoles: undefined, parentId: undefined };
    check('an orchestrator is marked only with roles to start, and never a helper', marksOrchestrator({ id: 'o', pipelineRoles: ['developer'] }, []) && !marksOrchestrator(lone, []) && !marksOrchestrator({ id: 'o', pipelineRoles: [] }, []) && !marksOrchestrator({ id: 'h', pipelineRoles: ['developer'], parentId: 'o' }, []));
    check('an ordinary orchestrator, whose helpers have no role, is not marked', !marksOrchestrator({ id: 'o' }, [{ parentId: 'o' }, { parentId: 'o' }]));
    check('a role not listed is refused, with the roles that are and the question tool', (() => {
      const why = roleRefusal('designer', ['developer', 'reviewer'], 'orchestrator');
      return !!why && /"designer" is not one of the roles this stack lists/.test(why) && /developer and reviewer/.test(why) && /question tool/.test(why);
    })());
    check('a stack with roles needs one named', /lists the roles you may start: developer and reviewer/.test(roleRefusal(undefined, ['developer', 'reviewer']) ?? '') && roleRefusal(' Developer ', ['developer']) === null);
    check('and an orchestrator with none takes no role, but starts helpers as before', /takes no role here/.test(roleRefusal('developer', [], 'builder') ?? '') && roleRefusal(undefined, []) === null);
    check('a role is started three times at most: once, and sent back twice; the fourth asks the user', sendBackRefusal('developer', 0) === null && sendBackRefusal('developer', 2) === null && /4 times|3 times/.test(sendBackRefusal('developer', 3) ?? '') && /Ask the user with the question tool/.test(sendBackRefusal('developer', 3) ?? ''));
    check('a tier is the listed one or a cheaper one, never a dearer one', (() => {
      const dev = ROLES[0]!;
      const same = helperModel(dev, undefined);
      const cheaper = helperModel(dev, 'haiku');
      const dearer = helperModel(dev, 'opus');
      return 'model' in same && same.model === O_SONNET && 'model' in cheaper && cheaper.model === O_HAIKU && 'why' in dearer && /sonnet and haiku, not on opus/.test(dearer.why);
    })());
    check('a tier on an engine without tiers, or one that is not a tier, is refused', 'why' in helperModel({ id: 'developer', model: 'gpt-5' }, 'haiku') && 'why' in helperModel(ROLES[0]!, 'gigantic'));
    check('a reading role is one by its name or by its rope', helperReads(ROLES[1]!) && !helperReads(ROLES[0]!) && helperReads({ id: 'custom', autonomy: rope({ disallowedTools: [...WRITE_TOOLS] }) }));

    // ── the migration ────────────────────────────────────────────────────────────
    const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
    check('the columns are there: the roles on the orchestrator, the role on a helper', cols.includes('helper_roles') && cols.includes('helper_role'));

    // ── a launch is checked, as every other field of a spec is ───────────────────
    const opid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'orch128' })).body.project.id;
    type Made = { agents?: Agent[]; error?: string; detail?: string };
    const launch = (agents: Record<string, unknown>[]) =>
      send<Made>('POST', '/api/jobs', { projectId: opid, prompt: 'the orchestrated prompt', isolation: 'in_place', agents });
    const orchSpec = { role: 'orchestrator', model: O_OPUS, autonomy: rope(), persona: 'architect', systemPrompt: 'ARCHITECT PROMPT o128', helpers: pipelineHelperCap(ROLES.length), helperRoles: ROLES };
    const bad = async (over: Record<string, unknown>): Promise<{ status: number; detail: string }> => {
      const r = await launch([{ ...orchSpec, ...over }]);
      return { status: r.status, detail: r.body.detail ?? r.body.error ?? '' };
    };
    const looseReviewer = await bad({ helperRoles: [{ ...ROLES[1]!, autonomy: rope({ mode: 'acceptEdits' }) }] });
    check('a reading role whose rope would let it write → 400, by readOnlyRefusal', looseReviewer.status === 400 && /reviewer is a reading role/.test(looseReviewer.detail), looseReviewer.detail);
    const noWrite = await bad({ helperRoles: [{ ...ROLES[1]!, autonomy: rope({ mode: 'plan', disallowedTools: ['Edit'] }) }] });
    check('or one missing some of the write tools', noWrite.status === 400 && /Write, MultiEdit, NotebookEdit must be in disallowedTools/.test(noWrite.detail), noWrite.detail);
    check('a tier that is not a tier → 400', (await bad({ helperRoles: [{ ...ROLES[0]!, tier: 'gigantic' }] })).status === 400);
    check('a role id that is not an id, or listed twice → 400', (await bad({ helperRoles: [{ ...ROLES[0]!, id: 'Not An Id' }] })).status === 400 && (await bad({ helperRoles: [ROLES[0]!, ROLES[0]!] })).status === 400);
    check('a role with no model, or a nickname for one → 400', (await bad({ helperRoles: [{ ...ROLES[0]!, model: '' }] })).status === 400 && (await bad({ helperRoles: [{ ...ROLES[0]!, model: 'sonnet' }] })).status === 400);
    check('roles that are not a list → 400', (await bad({ helperRoles: 'developer' })).status === 400);
    check('more than 8 roles → 400', (await bad({ helperRoles: Array.from({ length: 9 }, (_, i) => ({ ...ROLES[0]!, id: `role-${i}` })), helpers: 8 })).status === 400);
    const none = await bad({ helpers: 0 });
    check('roles with no helpers to start them as → 400', none.status === 400 && /helpers must be above 0/.test(none.detail), none.detail);
    const tooMany = await bad({ helpers: pipelineHelperCap(ROLES.length) + 1 });
    check('and no more helpers than the roles, each started and sent back twice → 400', tooMany.status === 400 && /0 to 9/.test(tooMany.detail), tooMany.detail);
    check('an ordinary orchestrator is still held to 8', (await bad({ helperRoles: undefined, helpers: 9 })).status === 400);

    // ── an orchestrated stack, launched ──────────────────────────────────────────
    const made = await launch([orchSpec]);
    check('the launch → 201', made.status === 201, `${made.status} ${made.body.detail ?? ''}`);
    const orchId = made.body.agents?.[0]?.id ?? '~';
    const orchJob = made.body.agents?.[0]?.jobId ?? '~';
    const orchAgent = getAgent(db, orchId);
    check('the orchestrator carries its role ids on the wire, and the cap that covers them', JSON.stringify(orchAgent?.pipelineRoles) === '["developer","reviewer","scribe"]' && orchAgent?.helperCap === 9, JSON.stringify(orchAgent));
    check('but not their prompts: those stay on the row, like a persona', !JSON.stringify(orchAgent).includes('DEVELOPER PROMPT') && getHelperRoles(db, orchId).length === 3 && getHelperRoles(db, orchId)[0]?.systemPrompt === 'DEVELOPER PROMPT o128');
    check('and listAgents (what a restart reads back) says the same', listAgents(db).find((a) => a.id === orchId)?.pipelineRoles?.join() === 'developer,reviewer,scribe');
    await until(() => runs.some((r) => (r.prompts[0] ?? '').includes('the orchestrated prompt') && (r.prompts[0] ?? '').includes('orchestrate this orchestrator pipeline')));
    const orchRun = runs.find((r) => (r.prompts[0] ?? '').includes('orchestrate this orchestrator pipeline'))!;
    const p0 = orchRun.prompts[0] ?? '';
    check('it is given the pipeline prompt, not the parallel-work one', /one at a time and in order/.test(p0) && !/parts that can run in parallel/.test(p0), p0);
    check('which names the roles it may start, with their tiers and which only read', /developer \(on sonnet\), reviewer \(on opus, reads only\), scribe \(on haiku\)/.test(p0), p0);
    check('says to read each result before the next, and to write the brief in full', /Read it before you decide anything/.test(p0) && /write the `task` in full/.test(p0));
    check('says to ask the user with the question tool when unsure', /ask the user with the question tool \(AskUserQuestion, or ask_user\)/.test(p0));
    check('says to send work back, at most twice a role', /send the work back/.test(p0) && /at most 2 times/.test(p0) && /started at most 3 times in all/.test(p0));
    check('and that its helpers have no hand_off', /no hand_off tool/.test(p0) && /up to 9 helpers in all/.test(p0));
    check('it runs on its persona: the architect prompt', JSON.stringify(orchRun.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: `ARCHITECT PROMPT o128\n\n${TURN_END_LINE}` }));

    const mcp = (agentId: string, method: string, params: Record<string, unknown> = {}) =>
      send<{ result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; inputSchema: { properties?: Record<string, { enum?: string[] }>; required?: string[] } }[] } }>('POST', `/mcp/agents/${agentId}`, { jsonrpc: '2.0', id: 1, method, params });
    const startOver = async (agentId: string, args: Record<string, unknown>) => {
      const r = (await mcp(agentId, 'tools/call', { name: 'start_helper', arguments: args })).body.result;
      return { text: r?.content?.[0]?.text ?? '', isError: r?.isError === true };
    };
    const listed = (await mcp(orchId, 'tools/list')).body.result?.tools ?? [];
    const sh = listed.find((t) => t.name === 'start_helper');
    check('tools/list gives its start_helper the roles to choose from, and requires one', JSON.stringify(sh?.inputSchema.properties?.['role']?.enum) === '["developer","reviewer","scribe"]' && JSON.stringify(sh?.inputSchema.required) === '["role","task"]' && JSON.stringify(sh?.inputSchema.properties?.['tier']?.enum) === '["opus","sonnet","haiku"]');
    check('Copilot and OpenRouter are given the same schema, in-process', JSON.stringify(toolsFor({ helperCap: 9, roles: [{ id: 'developer', tier: 'sonnet' }, { id: 'reviewer', reads: true }] }).find((t) => t.name === 'start_helper')?.inputSchema['properties']).includes('"enum":["developer","reviewer"]'));

    // ── start_helper with a role ─────────────────────────────────────────────────
    const asDev = await startOver(orchId, { role: 'developer', task: 'Build the parser in src/parse.ts.' });
    check('a listed role starts, named for the role', !asDev.isError && /^Started developer\./.test(asDev.text) && /woken with its whole conversation/.test(asDev.text), asDev.text);
    const dev1 = helpersOf(db, orchId)[0]!;
    check('the helper is the role: its model, its rope, its persona', dev1.role === 'developer' && dev1.model === O_SONNET && dev1.autonomy.mode === 'acceptEdits' && dev1.autonomy.budgetUsd === 5 && dev1.parentId === orchId && dev1.jobId === orchJob, JSON.stringify(dev1));
    check("with the persona's prompt and skills, stored for every run", JSON.stringify(getAgentPersona(db, dev1.id)) === JSON.stringify({ persona: 'developer', systemPrompt: 'DEVELOPER PROMPT o128', skills: ['tdd'] }), JSON.stringify(getAgentPersona(db, dev1.id)));
    check("and the brief is the role's, then the orchestrator's, then what to reply with", (() => {
      const b = getAgentBrief(db, dev1.id) ?? '';
      return b.includes('You are the developer in a pipeline the orchestrator runs') && b.includes('Implement the work.') && b.includes('Build the parser in src/parse.ts.') && b.includes('what you did, what you decided and why');
    })(), getAgentBrief(db, dev1.id) ?? '');
    await until(() => runs.some((r) => (r.prompts[0] ?? '').includes('Build the parser in src/parse.ts.')));
    const devRun = runs.find((r) => (r.prompts[0] ?? '').includes('Build the parser in src/parse.ts.'))!;
    check('it launches on that model, with that persona and skills', devRun.options.model === O_SONNET && JSON.stringify(devRun.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: `DEVELOPER PROMPT o128\n\n${TURN_END_LINE}` }) && JSON.stringify(devRun.options.skills) === '["tdd"]', JSON.stringify([devRun.options.model, devRun.options.systemPrompt]));
    check('and is told the job, and its role — not that it works beside others', (devRun.prompts[0] ?? '').startsWith('the orchestrated prompt') && /Your role is developer\./.test(devRun.prompts[0] ?? '') && !/Other helpers are working/.test(devRun.prompts[0] ?? ''));

    const asRev = await startOver(orchId, { role: 'reviewer', task: 'Review src/parse.ts against the brief.', tier: 'haiku' });
    const rev = helpersOf(db, orchId).find((h) => h.role === 'reviewer')!;
    check('a cheaper tier than the listed one is honoured', !asRev.isError && rev.model === O_HAIKU, `${asRev.text} ${rev?.model}`);
    check('a reading role stays read-only: the write tools denied, and it is not auto-approved', readOnlyRefusal('reviewer', rev.autonomy) === null && WRITE_TOOLS.every((t) => rev.autonomy.disallowedTools.includes(t)) && rev.autonomy.mode === 'default', JSON.stringify(rev.autonomy));
    await until(() => runs.some((r) => (r.prompts[0] ?? '').includes('Review src/parse.ts')));
    const revRun = runs.find((r) => (r.prompts[0] ?? '').includes('Review src/parse.ts'))!;
    check('and its run is denied them too, in every permission mode', WRITE_TOOLS.every((t) => revRun.options.disallowedTools?.includes(t)) && revRun.options.permissionMode !== 'acceptEdits', JSON.stringify([revRun.options.disallowedTools, revRun.options.permissionMode]));
    const dearer = await startOver(orchId, { role: 'scribe', task: 'Write it down.', tier: 'opus' });
    check('a dearer tier than the user listed is refused with a sentence', dearer.isError && /The user put scribe on haiku/.test(dearer.text) && helpersOf(db, orchId).every((h) => h.role !== 'scribe'), dearer.text);

    const unlisted = await startOver(orchId, { role: 'designer', task: 'Design it.' });
    check('a role not in the list is refused, with the ones that are', unlisted.isError && /not one of the roles this stack lists/.test(unlisted.text) && /developer, reviewer and scribe/.test(unlisted.text), unlisted.text);
    const roleless = await startOver(orchId, { task: 'Do it yourself.' });
    check('so is no role at all: it can start only the listed ones', roleless.isError && /Say which one with role/.test(roleless.text), roleless.text);
    check('a role that is not text is refused, not dropped', (await startOver(orchId, { role: 7, task: 'x' })).isError);
    check('and a task is still required', (await startOver(orchId, { role: 'developer' })).isError);
    check('none of those started anything', helpersOf(db, orchId).length === 2);

    // ── sending work back, at most twice a role ──────────────────────────────────
    const again1 = await startOver(orchId, { role: 'developer', task: 'The review found a fault in line 3; fix it.' });
    const again2 = await startOver(orchId, { role: 'developer', task: 'The test still fails; fix it.' });
    check('the developer can be started again, twice: named apart', !again1.isError && /^Started developer-2\./.test(again1.text) && !again2.isError && /^Started developer-3\./.test(again2.text), `${again1.text} | ${again2.text}`);
    check('and it is counted from the database, by the role it was started as', startedAsRole(db, orchId, 'developer') === 3 && startedAsRole(db, orchId, 'reviewer') === 1 && helpersOf(db, orchId).filter((h) => getHelperRole(db, h.id) === 'developer').length === 3);
    const third = await startOver(orchId, { role: 'developer', task: 'One more go.' });
    check('a fourth start of the same role is refused', third.isError && helpersOf(db, orchId).length === 4, third.text);
    check('with a sentence that tells it to ask the user, with the question tool', /Ask the user with the question tool \(AskUserQuestion, or ask_user\)/.test(third.text) && /sent its work back 2 times/.test(third.text) && /Do not start it again/.test(third.text), third.text);
    check('other roles are not affected', !(await startOver(orchId, { role: 'scribe', task: 'Write it down.', tier: 'haiku' })).isError);

    // ── a helper never hands off, and is never held ──────────────────────────────
    const helperAccess = sup.toolAccess(dev1.id);
    check('a helper is given no hand_off, and no start_helper: it starts nothing', helperAccess.handOff === false && !helperAccess.helperCap && JSON.stringify((await mcp(dev1.id, 'tools/list')).body.result?.tools) === '[]');
    check('its run is given no Conductor tools at all', !('mcpServers' in devRun.options) && !(devRun.prompts[0] ?? '').includes(HAND_OFF_LINE));
    const handed = await mcp(dev1.id, 'tools/call', { name: 'hand_off', arguments: { summary: 'Done.' } });
    check('and calling hand_off anyway is refused: there is no one to hand off to', handed.body.result?.isError === true && /No agent waits for you/.test(handed.body.result.content?.[0]?.text ?? ''));
    // Even with an agent wired to wait for it, which the stack's own screens never do.
    fixture('o128_after', orchJob, { projectId: opid, role: 'after', status: 'queued', dependsOn: [dev1.id], autonomy: DEFAULT_AUTONOMY });
    check('wired so another agent waits for the helper, it still has no hand_off', sup.toolAccess(dev1.id).handOff === false && JSON.stringify((await mcp(dev1.id, 'tools/list')).body.result?.tools) === '[]');
    check("and the orchestrator's own wait is not a hand-off either", sup.toolAccess(orchId).handOff === false);
    const said128 = (agentId: string, text: string) => eventLog().emit({ projectId: opid, jobId: orchJob, agentId }, { kind: 'text', text });

    // The orchestrator ends its turn, having started helpers: it waits for them, queued.
    orchRun.finish({ cost: 0.1, reason: 'completed' });
    check('it ends its turn and waits for the helpers, giving its slot back', await until(() => getAgent(db, orchId)?.status === 'queued'));

    said128(dev1.id, 'Parser done in src/parse.ts; the tests pass.');
    devRun.finish({ cost: 0.2, reason: 'completed' });
    check('the helper ends done, not held, though another agent waits for it', await until(() => getAgent(db, dev1.id)?.status === 'done'));
    await settle(100);
    check('no hold on it, and no card in Needs You for one', !getHandoff(db, dev1.id).held && getAgent(db, dev1.id)?.handoffHeld === undefined && !alerts().list().some((a) => a.kind === 'handoff_held' && a.agentIds.includes(dev1.id)));
    check('and the agent waiting for it starts, as for any agent that ended', await until(() => getAgent(db, 'o128_after')?.status !== 'queued'));

    // ── the orchestrator hears each helper, and is told to judge it ──────────────
    said128(rev.id, 'Found a fault: parse.ts line 3 drops the last token.');
    revRun.finish({ cost: 0.1, reason: 'completed' });
    await until(() => getAgent(db, rev.id)?.status === 'done');
    // The two send-backs and the scribe are still running; end every helper's run so the orchestrator is woken.
    for (let i = 0; i < 8; i += 1) {
      for (const r of runs) if (!r.finished && (r.prompts[0] ?? '').includes('in a pipeline the orchestrator runs')) r.finish({ cost: 0, reason: 'completed' });
      await settle(80);
    }
    const woke = await until(() => runs.some((r) => r.options.resume === getAgent(db, orchId)?.sdkSessionId && (r.prompts[0] ?? '').includes('Your helpers have finished')));
    check('when they have all ended it is woken in its own session', woke);
    const wokeRun = runs.find((r) => r.options.resume === getAgent(db, orchId)?.sdkSessionId && (r.prompts[0] ?? '').includes('Your helpers have finished'))!;
    const wp = wokeRun?.prompts[0] ?? '';
    check("told what each said, as the next agent in a stack is: the helper's whole conversation", wp.includes('[developer]') && wp.includes('Agent: Parser done in src/parse.ts; the tests pass.') && wp.includes('[reviewer]') && wp.includes('Agent: Found a fault: parse.ts line 3 drops the last token.'), wp);
    check('and told to judge the step, write the next brief, send work back or ask — not "combine it"', /Read what each did before you decide anything/.test(wp) && /send the work back/.test(wp) && /at most 2 times/.test(wp) && /question tool/.test(wp) && !/combine it/.test(wp), wp);
    check('and it ends with the pipeline closing line', wp.includes(pipelineReportClosing(SEND_BACKS_MAX).trim().slice(0, 40)));
    wokeRun.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, orchId)?.status === 'done');

    // ── an ordinary orchestrator is as it was ────────────────────────────────────
    const plainMade = await launch([{ role: 'builder', model: O_OPUS, helpers: 2, autonomy: rope({ mode: 'acceptEdits' }) }]);
    const plainId = plainMade.body.agents?.[0]?.id ?? '~';
    await until(() => runs.some((r) => (r.prompts[0] ?? '').includes('You orchestrate this builder work')));
    const plainPrompt = runs.find((r) => (r.prompts[0] ?? '').includes('You orchestrate this builder work'))?.prompts[0] ?? '';
    check('its prompt is the old parallel-work one, not the pipeline', /parts that can run in parallel/.test(plainPrompt) && !/one at a time and in order/.test(plainPrompt) && !/pipeline/.test(plainPrompt), plainPrompt);
    check('it is not marked, whatever it starts, and carries no roles', !marksOrchestrator(getAgent(db, plainId)!, [{ parentId: plainId }, { parentId: plainId }]) && getAgent(db, plainId)?.pipelineRoles === undefined && getHelperRoles(db, plainId).length === 0);
    check('with no roles of its own it takes no role, and says so', (await startOver(plainId, { role: 'developer', task: 'x' })).isError && helpersOf(db, plainId).length === 0);
    const plainRole = await startOver(plainId, { role: 'developer', task: 'x' });
    check('in a sentence', /takes no role here/.test(plainRole.text), plainRole.text);
    check('nor a tier', (await startOver(plainId, { tier: 'haiku', task: 'x' })).isError);
    const plainStart = await startOver(plainId, { task: 'Build the API.', name: 'API' });
    const plainHelper = helpersOf(db, plainId)[0];
    check('without a role it starts as it always did: its model, its permissions, the old brief', !plainStart.isError && /^Started builder-api\./.test(plainStart.text) && plainHelper?.model === O_OPUS && plainHelper.autonomy.mode === 'acceptEdits' && (getAgentBrief(db, plainHelper.id) ?? '').includes('Other helpers are working in this folder at the same time') && getHelperRole(db, plainHelper.id) === null, plainStart.text);
    check('its tool schema has no role, and is the old one', (() => {
      const t = toolsFor({ helperCap: 2 }).find((x) => x.name === 'start_helper');
      return !!t && !('role' in (t.inputSchema['properties'] as object)) && JSON.stringify(t.inputSchema['required']) === '["task"]' && t === MCP_TOOLS[0];
    })());
    check('the pipeline prompt is its own text, for the pipeline', (() => {
      const o = pipelineSection('builder', 2, [{ id: 'developer' }]);
      return /one at a time and in order/.test(o) && !/parts that can run in parallel/.test(o);
    })());
    check('the pipeline helper brief names the role, the orchestrator and the step', pipelineHelperBrief('orchestrator', 'validator', 'Write tests.', 'Cover the parser.').includes('You are the validator in a pipeline the orchestrator runs') && pipelineHelperBrief('orchestrator', 'validator', undefined, 'Cover the parser.').includes('Cover the parser.'));

    // ── the defence at start: a row whose rope no longer keeps a reader reading ──
    fixture('o128_loose', orchJob, { projectId: opid, role: 'orchestrator', status: 'working', sdkSessionId: 'sess_o128_loose', helperCap: 3, autonomy: rope() });
    db.prepare('UPDATE agents SET helper_roles = ? WHERE id = ?').run(JSON.stringify([{ ...ROLES[1]!, autonomy: rope({ mode: 'acceptEdits' }) }]), 'o128_loose');
    const loose = await startOver('o128_loose', { role: 'reviewer', task: 'Review it.' });
    check('a reading role whose stored rope would let it write is not started', loose.isError && /reviewer is a reading role/.test(loose.text) && helpersOf(db, 'o128_loose').length === 0, loose.text);


    // ── the other engines: the same roles reach their in-process tools ───────────
    const scopes: { agentId: string; helperCap?: number; handOff?: boolean; roles?: { id: string; tier?: string; model?: string; reads?: boolean }[]; model: string }[] = [];
    const seen = { copilot: backendFor('copilot') };
    registerBackend({
      provider: 'copilot',
      capabilities: { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true },
      listModels: async () => [],
      unavailable: () => null,
      create: (d: Db, scope: (typeof scopes)[number]) => {
        scopes.push(scope);
        return {
          agentId: scope.agentId,
          isLive: false,
          sessionId: null,
          run: () => new Promise(() => {}),
          send: () => false,
          setModel: async () => false,
          interrupt: async () => {},
          stop: async () => {},
        } as never;
      },
    });
    const onCopilot = await launch([
      {
        role: 'orchestrator',
        model: 'gpt-5',
        provider: 'copilot',
        autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000 },
        helpers: pipelineHelperCap(2),
        helperRoles: [
          { id: 'developer', model: 'gpt-5', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000 } },
          { id: 'reviewer', model: 'gpt-5', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000, mode: 'default', disallowedTools: [...WRITE_TOOLS] } },
        ],
      },
    ]);
    check('a stack on Copilot or OpenRouter launches with its roles, with no tiers to choose between', onCopilot.status === 201 && getAgent(db, onCopilot.body.agents?.[0]?.id ?? '~')?.pipelineRoles?.join() === 'developer,reviewer', `${onCopilot.status} ${onCopilot.body.detail ?? ''}`);
    await until(() => scopes.length > 0);
    check("its backend is given the roles, to build start_helper from in-process", scopes[0]?.helperCap === 6 && scopes[0]?.roles?.map((r) => r.id).join() === 'developer,reviewer' && scopes[0]?.roles?.find((r) => r.id === 'reviewer')?.reads === true && scopes[0]?.roles?.find((r) => r.id === 'developer')?.reads === undefined, JSON.stringify(scopes[0]));
    const copilotTool = toolsFor({ helperCap: scopes[0]?.helperCap, roles: scopes[0]?.roles }).find((t) => t.name === 'start_helper');
    check('which is the schema Claude\'s endpoint serves: a role is required, and a tier is not offered where no tier was listed', JSON.stringify(copilotTool?.inputSchema['required']) === '["role","task"]' && /developer, reviewer \(reads only\)/.test(copilotTool?.description ?? ''));
    const cpHelper = await startOver(onCopilot.body.agents?.[0]?.id ?? '~', { role: 'reviewer', task: 'Review it.' });
    const cpH = helpersOf(db, onCopilot.body.agents?.[0]?.id ?? '~')[0];
    check('a role starts there too, on the same provider, read-only and capped in tokens', !cpHelper.isError && cpH?.provider === 'copilot' && cpH.model === 'gpt-5' && cpH.autonomy.budgetTokens === 500_000 && readOnlyRefusal('reviewer', cpH.autonomy) === null, cpHelper.text);
    check('and a tier is refused there: this engine has none', (await startOver(onCopilot.body.agents?.[0]?.id ?? '~', { role: 'developer', task: 'x', tier: 'haiku' })).isError);
    if (seen.copilot) registerBackend(seen.copilot);

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n26 · an agent's and a job's budget count what was spent today (Amendment 129), with midnight's continue off (Amendment 140)");
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const eyes = await connect();
    // Amendment 129's midnight renews and resumes nothing. Since Amendment 140 that is the
    // day change with `conductor.budgetResumeAtMidnight` off; section 27 has it on.
    check('the continue at midnight is set off for this section', (await send('PATCH', '/api/settings', { settings: { [BUDGET_RESUME_KEY]: 'off' } })).status === 200 && !resumeAtMidnight());
    const D1 = '2032-06-10';
    const D2 = '2032-06-11';
    const D3 = '2032-06-12';
    const D4 = '2032-06-13';

    // The watch is the one Alerts started; its timer is ours to drive while the clock is fake (Amendment 103).
    const watch = dayWatch();
    watch?.stop();
    let now = new Date(2032, 5, 10, 23, 50, 0);
    setDayClock(() => now);
    watch?.check();
    check('the fake clock sets today: day 1', localDay() === D1, localDay());
    const goTo = (to: Date): boolean => {
      now = to;
      return watch?.check() === true;
    };

    const warns = (id: string): Alert[] => alerts().list().filter((a) => a.kind === 'budget_over' && a.agentIds.includes(id));
    const stops = (id: string): Alert[] => alerts().list().filter((a) => a.kind === 'budget' && a.agentIds.includes(id));
    const note = (id: string): string | null => {
      const p = lastStatus(id);
      return p?.kind === 'status' ? (p.error ?? null) : null;
    };
    const rowsOf = (id: string): Array<{ day: string; cost_usd: number; tokens: number }> =>
      db.prepare('SELECT day, cost_usd, tokens FROM agent_spend_daily WHERE agent_id = ? ORDER BY day').all(id) as never;
    /** An agent from before this amendment: it has a lifetime spend and no rows for any day. */
    const before = (id: string, jobId: string, a: Partial<Agent>): void => {
      dfix(id, jobId, a);
      db.prepare('DELETE FROM agent_spend_daily WHERE agent_id = ?').run(id);
    };
    const usageOf = (id: string) => eventLog().forAgent(id).map((e) => e.payload).filter((p) => p.kind === 'usage').at(-1);

    const dpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'daily129' })).body.project.id;
    const djob = (id: string): void => {
      insertJob(db, { id, projectId: dpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const dfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: dpid, ...a });
    djob('job_d129');

    // ── spend accrues per day, by the growth of the lifetime figure ─────────────
    const runCost = async (id: string, cost: number, text = 'carry on'): Promise<void> => {
      const at = runs.length;
      await send('POST', `/api/agents/${id}/message`, { text });
      await until(() => runs.length === at + 1);
      runs[at]!.finish({ cost, reason: 'completed' });
      await until(() => getAgent(db, id)?.status === 'done');
    };
    dfix('d_a', 'job_d129', { status: 'queued' });
    let at = runs.length;
    sup.pump();
    await until(() => runs.length === at + 1);
    check('a fresh agent has spent nothing today, stamped with today', JSON.stringify(getAgent(db, 'd_a')?.spentToday) === JSON.stringify({ day: D1, usd: 0, tokens: 0 }), JSON.stringify(getAgent(db, 'd_a')?.spentToday));
    runs[at]!.finish({ cost: 4, reason: 'completed' });
    await until(() => getAgent(db, 'd_a')?.status === 'done');
    check("a run's cost is the agent's spend on that day", JSON.stringify(rowsOf('d_a')) === JSON.stringify([{ day: D1, cost_usd: 4, tokens: 0 }]), JSON.stringify(rowsOf('d_a')));
    check('and it is on the wire, beside the lifetime figure', near(getAgent(db, 'd_a')?.spentToday?.usd, 4) && getAgent(db, 'd_a')?.spentToday?.day === D1 && near(getAgent(db, 'd_a')?.costUsd, 4));
    const u1 = usageOf('d_a');
    check('the usage event carries the day too, for a page that is watching', u1?.kind === 'usage' && u1.today?.day === D1 && near(u1.today.usd, 4), JSON.stringify(u1));
    await runCost('d_a', 9);
    check('a resumed run adds only the growth: 9 less the 4 it had, not 13', near(agentSpentToday(db, 'd_a').usd, 9) && near(getAgent(db, 'd_a')?.costUsd, 9), JSON.stringify(rowsOf('d_a')));
    await runCost('d_a', 2, 'and again');
    check('a session that saved no total starts again from zero: the 2 it reports are added', near(getAgent(db, 'd_a')?.costUsd, 11) && near(agentSpentToday(db, 'd_a').usd, 11), JSON.stringify(rowsOf('d_a')));
    const day1Total = costToday(db);
    goTo(new Date(2032, 5, 11, 0, 0, 20));
    check('on the next day it has spent nothing, and yesterday\'s row is kept', agentSpentToday(db, 'd_a').day === D2 && agentSpentToday(db, 'd_a').usd === 0 && near(rowsOf('d_a')[0]?.cost_usd, 11), JSON.stringify(rowsOf('d_a')));
    check('its lifetime figure did not move', near(getAgent(db, 'd_a')?.costUsd, 11));
    await runCost('d_a', 14);
    check('and the day it spends on is the day it arrives: 3 on day 2, 11 still on day 1', JSON.stringify(rowsOf('d_a').map((r) => [r.day, r.cost_usd])) === JSON.stringify([[D1, 11], [D2, 3]]), JSON.stringify(rowsOf('d_a')));
    check("the machine's day total counts day 2's $3 and not the agent's whole $14", near(costToday(db), 3) && day1Total > 0, `${costToday(db)}`);
    goTo(new Date(2032, 5, 10, 23, 55, 0));
    check('a clock moved back reads the earlier day again, as the watch does', agentSpentToday(db, 'd_a').day === D1 && near(agentSpentToday(db, 'd_a').usd, 11));

    // ── the cap reads today, not the lifetime ───────────────────────────────────
    before('d_life', 'job_d129', { sdkSessionId: 'sess_life', costUsd: 80 });
    check("an agent from before: $80 in its life, no rows, so nothing today", near(getAgent(db, 'd_life')?.costUsd, 80) && getAgent(db, 'd_life')?.spentToday?.usd === 0);
    check('its $25 budget is not reached: no refusal, state ok', budgetRefusal(getAgent(db, 'd_life')!) === null && budgetState(getAgent(db, 'd_life')!) === 'ok');
    at = runs.length;
    const lifeMsg = await send<{ delivery?: string }>('POST', '/api/agents/d_life/message', { text: 'go' });
    check('so a message is accepted', lifeMsg.status === 200 && lifeMsg.body.delivery === 'resumed' && (await until(() => runs.length === at + 1)), JSON.stringify(lifeMsg.body));
    check('and the SDK is given the whole $50 ceiling of today, not what its lifetime would leave (nothing)', near(runs[at]?.options.maxBudgetUsd, 50), String(runs[at]?.options.maxBudgetUsd));
    runs[at]?.finish({ cost: 83, reason: 'completed' });
    await until(() => getAgent(db, 'd_life')?.status === 'done');
    check('its $3 of growth is today\'s spend; the lifetime is $83', near(agentSpentToday(db, 'd_life').usd, 3) && near(getAgent(db, 'd_life')?.costUsd, 83));
    check('the shared rule gives the same figure with the stamp it was given', JSON.stringify(agentBudget(getAgent(db, 'd_life')!)) === JSON.stringify({ unit: 'usd', spent: 3, budget: 25 }), JSON.stringify(agentBudget(getAgent(db, 'd_life')!)));

    // ── what a budget does at the day change ────────────────────────────────────
    // On day 1: one over its budget and working on, one at its ceiling, a job at its ceiling, one a person paused.
    dfix('d_over', 'job_d129', { sdkSessionId: 'sess_over', costUsd: 27 });
    dfix('d_pause', 'job_d129', { status: 'queued', sdkSessionId: 'sess_pause', costUsd: 55 });
    dfix('d_flow', 'job_d129', { status: 'queued' });
    djob('job_d129_job');
    dfix('e_a', 'job_d129_job', { sdkSessionId: 'sess_e_a', costUsd: 55 });
    dfix('e_b', 'job_d129_job', { role: 'reviewer', status: 'queued', dependsOn: ['e_a'], sdkSessionId: 'sess_e_b', costUsd: 45 });
    dfix('d_user', 'job_d129', { status: 'paused', sdkSessionId: 'sess_user', costUsd: 60 });
    eventLog().emit({ projectId: dpid, jobId: 'job_d129', agentId: 'd_user' }, { kind: 'status', status: 'paused', error: 'paused by the user' });
    at = runs.length;
    sup.pump();
    await until(() => getAgent(db, 'd_pause')?.status === 'paused' && getAgent(db, 'e_b')?.status === 'paused' && runs.length === at + 1);
    const flow = runs[at]!;
    check('on day 1: d_over is over its budget and warned about, not stopped', warns('d_over').length === 1 && getAgent(db, 'd_over')?.status === 'done' && budgetState(getAgent(db, 'd_over')!) === 'over', JSON.stringify(warns('d_over')));
    check("d_flow was launched with the whole $50 of day 1, and keeps that limit", near(flow.options.maxBudgetUsd, 50), String(flow.options.maxBudgetUsd));
    check('d_pause is paused at its ceiling, the card says so and not that it is renewed', getAgent(db, 'd_pause')?.status === 'paused' && stops('d_pause').length === 1 && stops('d_pause')[0]!.renewed === undefined && /^budget reached for today/.test(note('d_pause') ?? ''), String(note('d_pause')));
    check("and e_b is held for its job's: 100 of 50 across the job, today", jobBudgetState(agentsForJob(db, 'job_d129_job'), jobCostToday(db, 'job_d129_job')) === 'ceiling' && note('e_b') === JOB_BUDGET_NOTE && stops('e_b')[0]?.cause === 'job_budget_reached');

    const dismissed = warns('d_over')[0]!;
    check('the warning is put away for the day', (await fetch(`${BASE}/api/alerts/${encodeURIComponent(dismissed.id)}/dismiss`, { method: 'POST' })).status === 204 && warns('d_over').length === 0);

    // ── midnight, with a run in flight ──────────────────────────────────────────
    const mark = eyes.frames.length;
    const runsAtTurn = runs.length;
    const eventsOf = (id: string) => eventLog().forAgent(id).length;
    const pauseEvents = eventsOf('d_pause');
    check('the day turns once', goTo(new Date(2032, 5, 11, 0, 0, 20)) && localDay() === D2);
    await settle(80);
    check('d_over is under its budget again: its own spent is back at zero, and the lifetime $27 stays', getAgent(db, 'd_over')?.spentToday?.day === D2 && getAgent(db, 'd_over')?.spentToday?.usd === 0 && budgetState(getAgent(db, 'd_over')!) === 'ok' && near(getAgent(db, 'd_over')?.costUsd, 27));
    check('the agents that spent yesterday are pushed afresh, so an open page redraws', eyes.frames.slice(mark).some((f) => f.type === 'entities' && (f.agents ?? []).some((a) => a.id === 'd_over' && a.spentToday?.day === D2 && a.spentToday.usd === 0)), `${eyes.frames.length - mark} frames`);
    check('and a stale day stamp reads as nothing spent, for a page that has not heard yet', JSON.stringify(agentBudget({ spentToday: { day: D1, usd: 99, tokens: 0 }, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } })) === JSON.stringify({ unit: 'usd', spent: 0, budget: 25 }));
    check('with the continue off, nothing started by itself: not one new run at midnight', runs.length === runsAtTurn && getAgent(db, 'd_pause')?.status === 'paused' && getAgent(db, 'e_b')?.status === 'paused' && getAgent(db, 'd_user')?.status === 'paused');
    check('the agent paused at its ceiling stays paused, and its pause now says its budget is renewed', budgetStop(note('d_pause') ?? '') === 'budget_exhausted' && isRenewedNote(note('d_pause') ?? '') && /renewed for 2032-06-11.*no raise needed/.test(note('d_pause') ?? ''), String(note('d_pause')));
    check('the Budget reached card is the same single card, marked renewed', stops('d_pause').length === 1 && stops('d_pause')[0]!.renewed === true, JSON.stringify(stops('d_pause')));
    check("the job's held agent too, with the job's own words", getAgent(db, 'e_b')?.status === 'paused' && budgetStop(note('e_b') ?? '') === 'job_budget_reached' && isRenewedNote(note('e_b') ?? '') && stops('e_b')[0]?.renewed === true, String(note('e_b')));
    check("a pause that was not about a budget is left as it was", note('d_user') === 'paused by the user' && stops('d_user').length === 0);
    check("the job's figure is back to zero", jobCostToday(db, 'job_d129_job') === 0 && jobBudgetState(agentsForJob(db, 'job_d129_job'), jobCostToday(db, 'job_d129_job')) === 'ok' && near(agentsForJob(db, 'job_d129_job').reduce((n, a) => n + a.costUsd, 0), 100));
    check('every tab hears the budget cards change', eyes.frames.slice(mark).some((f) => f.type === 'alerts' && f.alerts.some((a) => a.kind === 'budget' && a.agentIds.includes('d_pause') && a.renewed === true)));
    check('a second turn rewrites nothing: the notes already say it', sup.newDay(D2, D1) === 0 && eventsOf('d_pause') === pauseEvents + 1, `${eventsOf('d_pause') - pauseEvents} events`);
    check('and a look on the same day does not turn it', watch?.check() === false);

    // the run in flight when the day turned: its cost is today's, the limit it was given is what it was
    flow.finish({ cost: 12, reason: 'completed' });
    await until(() => getAgent(db, 'd_flow')?.status === 'done');
    check("the run that crossed midnight is credited to the day its result arrived", JSON.stringify(rowsOf('d_flow').map((r) => [r.day, r.cost_usd])) === JSON.stringify([[D2, 12]]), JSON.stringify(rowsOf('d_flow')));
    check("and it kept the SDK limit it was launched with", near(flow.options.maxBudgetUsd, 50));

    // a new day's warning is a new warning, not hidden by yesterday's dismissal
    addSpendToday(db, 'd_over', { usd: 26 });
    alerts().refresh();
    check("spending past the budget again on day 2 warns again, with day 2 in its id", warns('d_over').length === 1 && warns('d_over')[0]!.id !== dismissed.id && warns('d_over')[0]!.id.endsWith(`:${D2}`) && near(warns('d_over')[0]!.spent, 26), JSON.stringify(warns('d_over')));

    // the pure rewrite, directly
    const pausedAtCeiling = { agent: { id: 'x', spentToday: { day: D2, usd: 0, tokens: 0 }, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } }, note: 'budget reached for today — spent $50 of its $25 daily budget, which stops it at $50', jobAtCeiling: false };
    const plan = renewals(
      [
        pausedAtCeiling,
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 'y', spentToday: { day: D2, usd: 50, tokens: 0 } } },
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 'z' }, note: 'paused by the user' },
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 'w' }, note: renewedNote('budget_exhausted', pausedAtCeiling.agent, D1) },
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 'j' }, note: JOB_BUDGET_NOTE, jobAtCeiling: false },
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 'k' }, note: JOB_BUDGET_NOTE, jobAtCeiling: true },
        { ...pausedAtCeiling, agent: { ...pausedAtCeiling.agent, id: 't', autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: null, budgetTokens: 500_000 } }, note: 'budget reached for today — spent 1M of its 500k-token daily budget, which stops it at 1M' },
      ],
      D2,
    );
    check(
      'the rewrite is pure: ceiling pauses and job holds with room today are renewed, in their own unit; the rest are left',
      plan.map((p) => p.agentId).join() === 'x,j,t' && /^budget reached — its \$25 daily budget is renewed for 2032-06-11/.test(plan[0]!.note) && /^job budget reached — the job's daily budget is renewed/.test(plan[1]!.note) && /500k-token daily budget is renewed/.test(plan[2]!.note),
      JSON.stringify(plan),
    );

    // ── continue needs no raise ─────────────────────────────────────────────────
    at = runs.length;
    const cont = await send<unknown>('POST', '/api/agents/d_pause/resume');
    check('a plain continue is accepted for the agent paused at its ceiling', cont.status === 200 && (await until(() => runs.length === at + 1)), JSON.stringify(cont));
    check('the SDK is given the whole $50 ceiling of the new day (it spent $55 in its life)', near(runs[at]?.options.maxBudgetUsd, 50), String(runs[at]?.options.maxBudgetUsd));
    check('and the card clears with the pause', stops('d_pause').length === 0);
    runs[at]?.finish({ cost: 56, reason: 'completed' });
    await until(() => getAgent(db, 'd_pause')?.status === 'done');
    check("its growth since is day 2's, the rest of its $56 is the past", near(agentSpentToday(db, 'd_pause').usd, 1) && near(getAgent(db, 'd_pause')?.costUsd, 56));
    at = runs.length;
    const contJob = await send<unknown>('POST', '/api/agents/e_b/resume');
    check("the agent held for its job's budget starts on a plain continue too", contJob.status === 200 && (await until(() => runs.length === at + 1)), JSON.stringify(contJob));
    runs[at]?.finish({ cost: 46, reason: 'completed' });
    await until(() => getAgent(db, 'e_b')?.status === 'done');
    // A message does the same for an agent whose pause is renewed.
    const msgUser = await send<{ delivery?: string }>('POST', '/api/agents/d_user/message', { text: 'go' });
    check('and a message to an agent over its lifetime figure is not refused', msgUser.status === 200, JSON.stringify(msgUser.body));
    at = runs.length;
    await until(() => runs.length >= at + 1 || getAgent(db, 'd_user')?.status === 'working');
    for (const r of runs) if (!r.finished) r.finish({ cost: 60, reason: 'completed' });
    await until(() => sup.slots.used === 0);

    // ── a token budget, on an engine that reports no dollars ───────────────────
    dfix('d_tok', 'job_d129', { status: 'queued', provider: 'copilot', model: 'gpt-5-mini', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 100 } } as Partial<Agent>);
    sup.pump();
    await until(() => copilotSessions.some((x) => x.id === 'd_tok'));
    const tokSession = copilotSessions.filter((x) => x.id === 'd_tok').at(-1)!;
    tokSession.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 60, outputTokens: 60 });
    check('on day 2, 120 tokens of a 100-token budget: over it, warned, still working', await until(() => warns('d_tok').length === 1) && getAgent(db, 'd_tok')?.status === 'working' && warns('d_tok')[0]?.unit === 'tokens' && warns('d_tok')[0]?.spent === 120, JSON.stringify(warns('d_tok')));
    check("it is the call's tokens that went to the day: input plus output", JSON.stringify(rowsOf('d_tok').map((r) => [r.day, r.cost_usd, r.tokens])) === JSON.stringify([[D2, 0, 120]]), JSON.stringify(rowsOf('d_tok')));
    goTo(new Date(2032, 5, 12, 0, 0, 20));
    check('on day 3 the token budget is renewed: the warning clears and the day reads zero', warns('d_tok').length === 0 && getAgent(db, 'd_tok')?.spentToday?.tokens === 0 && getAgent(db, 'd_tok')?.inputTokens === 60);
    tokSession.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 100, outputTokens: 10 });
    check('110 tokens today is over the budget, and its 230 over its life is not what stops it: the ceiling is 200 today', await until(() => warns('d_tok').length === 1) && getAgent(db, 'd_tok')?.status === 'working' && getAgent(db, 'd_tok')?.inputTokens === 160 && getAgent(db, 'd_tok')?.outputTokens === 70 && warns('d_tok')[0]?.spent === 110, JSON.stringify(warns('d_tok')));
    tokSession.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 100, outputTokens: 0 });
    await until(() => getAgent(db, 'd_tok')?.status === 'paused');
    check('210 today is twice the budget: stopped, with the note in tokens and for today', getAgent(db, 'd_tok')?.status === 'paused' && tokSession.aborts >= 1 && note('d_tok') === 'budget reached for today — spent 210 of its 100-token daily budget, which stops it at 200', String(note('d_tok')));
    const tokRefused = await send<{ detail?: string }>('POST', '/api/agents/d_tok/resume');
    check('a resume is refused with the daily sentence', tokRefused.status === 409 && /210 of its 100-token daily budget today.*renews at midnight/.test(tokRefused.body.detail ?? ''), JSON.stringify(tokRefused.body));
    goTo(new Date(2032, 5, 13, 0, 0, 20));
    check('on day 4 its pause says the token budget is renewed, and it is still paused', getAgent(db, 'd_tok')?.status === 'paused' && /100-token daily budget is renewed for 2032-06-13/.test(note('d_tok') ?? '') && stops('d_tok')[0]?.renewed === true, String(note('d_tok')));
    const tokGo = await send<unknown>('POST', '/api/agents/d_tok/resume');
    check('and it continues without a raise', tokGo.status === 200 && (await until(() => copilotSessions.filter((x) => x.id === 'd_tok').length === 2)), JSON.stringify(tokGo));
    check('with nothing spent on day 4 yet', getAgent(db, 'd_tok')?.spentToday?.day === D4 && getAgent(db, 'd_tok')?.spentToday?.tokens === 0);
    copilotSessions.filter((x) => x.id === 'd_tok').at(-1)?.emit('session.idle', {});
    await until(() => getAgent(db, 'd_tok')?.status === 'done');

    // ── removing an agent removes its days ──────────────────────────────────────
    check('d_a has rows for two days before it is removed', rowsOf('d_a').length === 2);
    const removed = await fetch(`${BASE}/api/agents/d_a`, { method: 'DELETE' });
    check('removing it → 200', removed.status === 200, String(removed.status));
    check('removes its rows with it', rowsOf('d_a').length === 0 && getAgent(db, 'd_a') === undefined);
    check("but the machine's day totals keep the money that was spent", row<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM cost_daily WHERE day >= '2032-01-01' AND cost_usd > 0").get())!.n >= 2);
    check("and which agents spent on a day is read from the rows that are left", agentsThatSpentOn(db, D1).includes('d_over') && !agentsThatSpentOn(db, D1).includes('d_a'));

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    setDayClock();
    watch?.check();
    watch?.start();
    db.prepare("DELETE FROM cost_daily WHERE day >= '2032-01-01'").run();
    check('the setting removed, the continue is on again', (await send('PATCH', '/api/settings', { settings: { [BUDGET_RESUME_KEY]: null } })).status === 200 && resumeAtMidnight());
    eyes.close();
    sdk.query = realQuery;
  }

  console.log('\n27 · a new day continues the agents only its budget paused (Amendment 140, Q4 of wave 10)');
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const eyes = await connect();
    const Q1 = '2033-02-10';
    const Q2 = '2033-02-11';
    const Q3 = '2033-02-12';
    const Q4 = '2033-02-13';

    const watch = dayWatch();
    watch?.stop();
    let now = new Date(2033, 1, 10, 23, 50, 0);
    setDayClock(() => now);
    watch?.check();
    check('the fake clock sets today: day 1', localDay() === Q1, localDay());
    const goTo = (to: Date): boolean => {
      now = to;
      return watch?.check() === true;
    };
    const stops = (id: string): Alert[] => alerts().list().filter((a) => a.kind === 'budget' && a.agentIds.includes(id));
    const note = (id: string): string | null => {
      const p = lastStatus(id);
      return p?.kind === 'status' ? (p.error ?? null) : null;
    };
    const queuedWith = (id: string, day: string): boolean =>
      eventLog().forAgent(id).some((e) => e.payload.kind === 'status' && e.payload.status === 'queued' && e.payload.error === newDayNote(day));
    const runFor = (session: string, from: number): FakeRun | undefined => runs.slice(from).find((r) => r.options.resume === session);
    const statusAt = (id: string, iso: string): void => {
      db.prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND kind = 'status'").run(iso, id);
    };
    const setResume = (v: unknown) => send<{ detail?: string }>('PATCH', '/api/settings', { settings: { [BUDGET_RESUME_KEY]: v } });

    // ── the setting ─────────────────────────────────────────────────────────────
    check('the setting is on or off, nothing else → 400', (await setResume('yes')).status === 400 && (await setResume('')).status === 400 && /on or off/.test((await setResume('true')).body.detail ?? ''));
    check('with nothing set it is on', resumeAtMidnight());

    const qpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'midnight140' })).body.project.id;
    const qjob = (id: string): void => {
      insertJob(db, { id, projectId: qpid, prompt: `the ${id} prompt`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    };
    const qfix = (id: string, jobId: string, a: Partial<Agent>): void => fixture(id, jobId, { projectId: qpid, ...a });
    qjob('job_q4');
    qjob('job_q4_job');

    // On day 1: one at its own ceiling, one held for its job's, one a person paused, one paused for something else.
    qfix('q_ceil', 'job_q4', { status: 'queued', sdkSessionId: 'sess_q_ceil', costUsd: 55 });
    qfix('qj_a', 'job_q4_job', { sdkSessionId: 'sess_qj_a', costUsd: 55 });
    qfix('qj_b', 'job_q4_job', { role: 'reviewer', status: 'queued', dependsOn: ['qj_a'], sdkSessionId: 'sess_qj_b', costUsd: 45 });
    qfix('q_user', 'job_q4', { status: 'paused', sdkSessionId: 'sess_q_user', costUsd: 60 });
    eventLog().emit({ projectId: qpid, jobId: 'job_q4', agentId: 'q_user' }, { kind: 'status', status: 'paused', error: 'paused by the user' });
    qfix('q_other', 'job_q4', { status: 'paused', sdkSessionId: 'sess_q_other' });
    eventLog().emit({ projectId: qpid, jobId: 'job_q4', agentId: 'q_other' }, { kind: 'status', status: 'paused', error: strandNote('architect') });
    let at = runs.length;
    sup.pump();
    await until(() => getAgent(db, 'q_ceil')?.status === 'paused' && getAgent(db, 'qj_b')?.status === 'paused');
    check('on day 1: q_ceil is paused at its ceiling, qj_b held for its job, and nothing ran', budgetStop(note('q_ceil') ?? '') === 'budget_exhausted' && note('qj_b') === JOB_BUDGET_NOTE && runs.length === at && stops('q_ceil').length === 1, String(note('q_ceil')));

    // ── midnight, with one slot ─────────────────────────────────────────────────
    // What earlier sections left running keeps its slots; one more than that is free.
    const held = sup.slots.used;
    check('one slot free', (await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: String(held + 1) } })).status === 200 && slotLimit() === held + 1);
    const mark = eyes.frames.length;
    at = runs.length;
    check('the day turns', goTo(new Date(2033, 1, 11, 0, 0, 20)) && localDay() === Q2);
    await until(() => runs.length === at + 1);
    await settle(80);
    const both = ['q_ceil', 'qj_b'].map((id) => getAgent(db, id)?.status).sort().join();
    check('both are continued, within the slots: one runs, the other is queued for the slot', runs.length === at + 1 && sup.slots.used === held + 1 && both === 'queued,working', `${both}, ${runs.length - at} runs`);
    check('each is queued with a note on its transcript that a new day began', queuedWith('q_ceil', Q2) && queuedWith('qj_b', Q2) && newDayNote(Q2) === "a new day's budget began (2033-02-11) — continuing");
    const first = runs[at]!;
    await until(() => first.prompts.length > 0);
    const firstId = first.options.resume === 'sess_q_ceil' ? 'q_ceil' : 'qj_b';
    check('the one that runs resumes its own session, and is told why', (first.options.resume === 'sess_q_ceil' || first.options.resume === 'sess_qj_b') && first.prompts[0] === NEW_DAY_NUDGE, JSON.stringify(first.prompts));
    check('with the whole of the new day\'s ceiling', near(first.options.maxBudgetUsd, 50), String(first.options.maxBudgetUsd));
    check('their Budget reached cards clear, and every tab hears it', stops('q_ceil').length === 0 && stops('qj_b').length === 0 && eyes.frames.slice(mark).some((f) => f.type === 'alerts'));
    check("a pause a person made, and one that was not the budget's, are left as they were", getAgent(db, 'q_user')?.status === 'paused' && note('q_user') === 'paused by the user' && getAgent(db, 'q_other')?.status === 'paused' && note('q_other') === strandNote('architect'));
    first.finish({ cost: 56, reason: 'completed' });
    const secondId = firstId === 'q_ceil' ? 'qj_b' : 'q_ceil';
    check('when the slot frees, the other goes, told the same', await until(() => runFor(secondId === 'q_ceil' ? 'sess_q_ceil' : 'sess_qj_b', at + 1) !== undefined));
    const second = runFor(secondId === 'q_ceil' ? 'sess_q_ceil' : 'sess_qj_b', at + 1)!;
    await until(() => second.prompts.length > 0);
    check('…with the nudge', second.prompts[0] === NEW_DAY_NUDGE, JSON.stringify(second.prompts));
    second.finish({ cost: secondId === 'q_ceil' ? 56 : 46, reason: 'completed' });
    await until(() => getAgent(db, 'q_ceil')?.status === 'done' && getAgent(db, 'qj_b')?.status === 'done');
    const atMsg = runs.length;
    await send('POST', '/api/agents/q_ceil/message', { text: 'one more thing' });
    const msgRun = (await until(() => runs.length === atMsg + 1 && runs[atMsg]!.prompts.length > 0)) ? runs[atMsg] : undefined;
    check('a later message is an ordinary one: the nudge was for that one run', msgRun?.prompts[0] === 'one more thing', JSON.stringify(msgRun?.prompts));
    msgRun?.finish({ cost: 57, reason: 'completed' });
    await until(() => getAgent(db, 'q_ceil')?.status === 'done');
    check('a second turn on the same day continues nothing', sup.newDay(Q2, Q1) === 0);
    check('the slots back to the default', (await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: null } })).status === 200);

    // ── while everything is paused ─────────────────────────────────────────────
    qfix('q_hold', 'job_q4', { status: 'queued', sdkSessionId: 'sess_q_hold', costUsd: 55 });
    sup.pump();
    await until(() => getAgent(db, 'q_hold')?.status === 'paused');
    await sup.hold();
    at = runs.length;
    check('on day 2 q_hold is paused at its ceiling, and everything is paused until a time', budgetStop(note('q_hold') ?? '') === 'budget_exhausted' && sup.held);
    check('the day turns again', goTo(new Date(2033, 1, 12, 0, 0, 20)) && localDay() === Q3);
    await settle(80);
    check('it is continued, but waits for the pause of everything: queued, not run', getAgent(db, 'q_hold')?.status === 'queued' && queuedWith('q_hold', Q3) && runs.length === at);
    sup.release();
    check('when the pause ends it goes, told the new day began', await until(() => runFor('sess_q_hold', at) !== undefined && runFor('sess_q_hold', at)!.prompts.length > 0) && runFor('sess_q_hold', at)!.prompts[0] === NEW_DAY_NUDGE);
    runFor('sess_q_hold', at)!.finish({ cost: 56, reason: 'completed' });
    await until(() => getAgent(db, 'q_hold')?.status === 'done');

    // ── the rule, pure ─────────────────────────────────────────────────────────
    const base = { agent: { id: 'x', spentToday: { day: Q3, usd: 0, tokens: 0 }, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } }, note: 'budget reached for today — spent $50 of its $25 daily budget, which stops it at $50', jobAtCeiling: false };
    const picked = continuations(
      [
        base,
        { ...base, agent: { ...base.agent, id: 'y', spentToday: { day: Q3, usd: 50, tokens: 0 } } },
        { ...base, agent: { ...base.agent, id: 'z' }, note: 'paused by the user' },
        { ...base, agent: { ...base.agent, id: 'w' }, note: renewedNote('budget_exhausted', base.agent, Q2) },
        { ...base, agent: { ...base.agent, id: 'j' }, note: JOB_BUDGET_NOTE },
        { ...base, agent: { ...base.agent, id: 'k' }, note: JOB_BUDGET_NOTE, jobAtCeiling: true },
        { ...base, agent: { ...base.agent, id: 'h' }, note: 'paused until the scheduled time' },
        { ...base, agent: { ...base.agent, id: 'n' }, note: undefined },
      ],
      Q3,
    );
    check('the rule is pure: a ceiling pause, a renewed one and a job hold with room are continued; the rest are left', picked.join() === 'x,w,j', picked.join());

    // ── the daemon was down at midnight ────────────────────────────────────────
    qfix('q_down', 'job_q4', { status: 'queued', sdkSessionId: 'sess_q_down', costUsd: 55 });
    sup.pump();
    await until(() => getAgent(db, 'q_down')?.status === 'paused');
    statusAt('q_down', new Date(2033, 1, 12, 22, 0, 0).toISOString());
    // Paused by its budget today and since raised: a pause from today, which a start must not touch.
    qfix('q_today', 'job_q4', { status: 'paused', sdkSessionId: 'sess_q_today' });
    eventLog().emit({ projectId: qpid, jobId: 'job_q4', agentId: 'q_today' }, { kind: 'status', status: 'paused', error: 'budget reached for today — spent $50 of its $25 daily budget, which stops it at $50' });
    statusAt('q_today', new Date(2033, 1, 13, 0, 30, 0).toISOString());
    // The clock moves to day 4 with no day turn seen, as a daemon down at midnight would find it.
    now = new Date(2033, 1, 13, 1, 0, 0);
    check('day 4 has come with no turn seen', localDay() === Q4 && getAgent(db, 'q_down')?.status === 'paused');
    at = runs.length;
    check('at start, the pause from an earlier day is brought up to today: one', sup.catchUpDay() === 1);
    check('…continued, with the note for today, and it runs told why', queuedWith('q_down', Q4) && (await until(() => runFor('sess_q_down', at) !== undefined && runFor('sess_q_down', at)!.prompts.length > 0)) && runFor('sess_q_down', at)!.prompts[0] === NEW_DAY_NUDGE);
    check("a budget pause written today is left, and so are a person's and the others", getAgent(db, 'q_today')?.status === 'paused' && getAgent(db, 'q_user')?.status === 'paused' && getAgent(db, 'q_other')?.status === 'paused');
    check('a second look at start changes nothing', sup.catchUpDay() === 0);
    runFor('sess_q_down', at)!.finish({ cost: 56, reason: 'completed' });
    await until(() => getAgent(db, 'q_down')?.status === 'done');
    check('routes/session.ts runs it at start, after the scheduler, before the first pump', /await sched\.start\(\);[\s\S]{0,400}sup\.catchUpDay\(\);\s*sup\.pump\(\);/.test(readFileSync(new URL('../routes/session.ts', import.meta.url), 'utf8')));

    // With the setting off, the start renews instead, as the day turn does.
    qfix('q_off', 'job_q4', { status: 'queued', sdkSessionId: 'sess_q_off', costUsd: 55 });
    sup.pump();
    await until(() => getAgent(db, 'q_off')?.status === 'paused');
    statusAt('q_off', new Date(2033, 1, 13, 22, 0, 0).toISOString());
    now = new Date(2033, 1, 14, 1, 0, 0);
    check('the continue set off', (await setResume('off')).status === 200 && !resumeAtMidnight());
    at = runs.length;
    check(
      "with it off, the start renews the earlier pauses (q_off's, and q_today's, now a day old) and runs nothing",
      sup.catchUpDay() === 2 && getAgent(db, 'q_off')?.status === 'paused' && isRenewedNote(note('q_off') ?? '') && isRenewedNote(note('q_today') ?? '') && runs.length === at,
      `${note('q_off')} / ${note('q_today')}`,
    );
    check('the setting removed, on again', (await setResume(null)).status === 200 && resumeAtMidnight());

    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    // Back to the real day with the continue off, so the pauses left here are not woken by it.
    await setResume('off');
    setDayClock();
    watch?.check();
    watch?.start();
    await setResume(null);
    db.prepare("DELETE FROM cost_daily WHERE day >= '2033-01-01'").run();
    eyes.close();
    sdk.query = realQuery;
  }

  console.log("\n28 · each agent, project and the fleet keep a total beside today's, and removing an agent keeps it (Amendment 146)");
  {
    sdk.query = fakeQuery as typeof sdk.query;
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
    const eyes = await connect();
    await until(() => eyes.frames.some((f) => f.type === 'hello'));
    const hello = eyes.frames.find((f) => f.type === 'hello');
    check(
      "the snapshot carries the fleet's all-time total and each project's pair",
      hello?.type === 'hello' && typeof hello.snapshot.costTotal === 'number' && Array.isArray(hello.snapshot.projectSpend) && hello.snapshot.projectSpend.length === listProjects(db).length,
      JSON.stringify(hello?.type === 'hello' ? hello.snapshot.projectSpend : null),
    );
    const T1 = '2034-03-10';
    const T2 = '2034-03-11';
    const watch = dayWatch();
    watch?.stop();
    let now = new Date(2034, 2, 10, 12, 0, 0);
    setDayClock(() => now);
    watch?.check();
    check('the fake clock sets today', localDay() === T1, localDay());

    const tpid = (await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'totals146' })).body.project.id;
    insertJob(db, { id: 'job_t146', projectId: tpid, prompt: 'the totals prompt', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    const tfix = (id: string, a: Partial<Agent>): void => fixture(id, 'job_t146', { projectId: tpid, ...a });
    const mine = (): ProjectSpend => projectSpend(db).find((p) => p.projectId === tpid) ?? { projectId: tpid, today: 0, total: 0, tokensToday: 0, tokensTotal: 0 };
    const base = { project: mine(), fleet: costTotal(db) };

    // ── a credited run raises the agent's, the project's and the fleet's totals ──
    tfix('t_a', { status: 'queued' });
    const mark = eyes.frames.length;
    let at = runs.length;
    sup.pump();
    await until(() => runs.length === at + 1);
    runs[at]!.finish({ cost: 6, reason: 'completed' });
    await until(() => getAgent(db, 't_a')?.status === 'done');
    check("the agent: $6 today and $6 over its life", near(getAgent(db, 't_a')?.spentToday?.usd, 6) && near(getAgent(db, 't_a')?.costUsd, 6));
    check("its project: $6 more today and in total", near(mine().today - base.project.today, 6) && near(mine().total - base.project.total, 6), JSON.stringify(mine()));
    check("the fleet's all-time total: $6 more", near(costTotal(db) - base.fleet, 6), `${costTotal(db)} vs ${base.fleet}`);
    check(
      'and every page is told all three in the cost frame',
      await until(() =>
        eyes.frames.slice(mark).some((f) => f.type === 'cost' && near(f.costTotal, costTotal(db)) && f.projectSpend?.some((p) => p.projectId === tpid && near(p.total, mine().total)) === true),
      ),
    );
    check('a project that spent nothing is listed with zeros', projectSpend(db).length === listProjects(db).length);

    // tokens, for an engine that reports no dollars
    tfix('t_tok', { provider: 'copilot', model: 'gpt-5-mini' } as Partial<Agent>);
    addSpendToday(db, 't_tok', { tokens: 1200 });
    check("a token engine's day grows its project's tokens today and in total", mine().tokensToday - base.project.tokensToday === 1200 && mine().tokensTotal - base.project.tokensTotal === 1200, JSON.stringify(mine()));
    check('a credit to an agent that is gone records nothing anywhere', (() => {
      const before = JSON.stringify(projectSpend(db));
      addSpendToday(db, 't_nobody', { usd: 5, tokens: 5 });
      return JSON.stringify(projectSpend(db)) === before;
    })());

    // ── removing the agent keeps the project's and the fleet's ──
    const kept = { project: mine(), fleet: costTotal(db) };
    const gone = await fetch(`${BASE}/api/agents/t_a`, { method: 'DELETE' });
    check('removing the agent → 200, and its own days go with it', gone.status === 200 && getAgent(db, 't_a') === undefined && agentsThatSpentOn(db, T1).every((id) => id !== 't_a'));
    check("its project's today and total are what they were", near(mine().today, kept.project.today) && near(mine().total, kept.project.total), JSON.stringify(mine()));
    check("and the fleet's total", near(costTotal(db), kept.fleet));
    const jobGone = await fetch(`${BASE}/api/jobs/job_t146`, { method: 'DELETE' });
    check('removing the whole job keeps them too', [200, 204].includes(jobGone.status) && near(mine().total, kept.project.total) && mine().tokensTotal === kept.project.tokensTotal, `${jobGone.status} ${JSON.stringify(mine())}`);

    // ── the day change resets today, not the totals ──
    const turn = eyes.frames.length;
    now = new Date(2034, 2, 11, 0, 0, 20);
    check('the day turns', watch?.check() === true && localDay() === T2);
    check("today reads zero for the project and the fleet", mine().today === 0 && mine().tokensToday === 0 && costToday(db) === 0);
    check('the totals do not move', near(mine().total, kept.project.total) && mine().tokensTotal === kept.project.tokensTotal && near(costTotal(db), kept.fleet));
    check(
      "and the day change's cost frame says so",
      await until(() => eyes.frames.slice(turn).some((f) => f.type === 'cost' && f.costToday === 0 && near(f.costTotal, kept.fleet) && f.projectSpend?.some((p) => p.projectId === tpid && p.today === 0 && near(p.total, kept.project.total)) === true)),
    );

    // ── the backfill, on a database from before 240 ──
    {
      const old = new DatabaseSync(':memory:');
      old.exec('PRAGMA foreign_keys = ON');
      const dir = new URL('../db/migrations/', import.meta.url);
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((f) => f < '240')) old.exec(readFileSync(new URL(f, dir), 'utf8'));
      old.exec(`INSERT INTO projects (id, name, path, created_at) VALUES ('bp1', 'one', '/tmp/bp1', 'x'), ('bp2', 'two', '/tmp/bp2', 'x'), ('bp3', 'three', '/tmp/bp3', 'x')`);
      old.exec(`INSERT INTO jobs (id, project_id, prompt, isolation, worktree_path, branch, status, created_at) VALUES
        ('bj1', 'bp1', 'p', 'in_place', '/tmp/bp1', 'main', 'done', 'x'), ('bj2', 'bp2', 'p', 'in_place', '/tmp/bp2', 'main', 'done', 'x'), ('bj3', 'bp3', 'p', 'in_place', '/tmp/bp3', 'main', 'done', 'x')`);
      const ag = old.prepare(`INSERT INTO agents (id, job_id, project_id, role, model, status, cost_usd, input_tokens, output_tokens, provider) VALUES (?, ?, ?, 'builder', 'm', 'done', ?, ?, ?, ?)`);
      ag.run('ba1', 'bj1', 'bp1', 10, 500, 300, 'claude');   // $10 in its life, of which $3 today and $2 the day before
      ag.run('ba2', 'bj1', 'bp1', 4, 0, 0, 'claude');        // $4, from before 129: no days at all
      ag.run('ba3', 'bj1', 'bp1', 0, 600, 400, 'copilot');   // 1000 tokens in its life, 250 of them today
      ag.run('ba4', 'bj2', 'bp2', 7, 0, 0, 'claude');        // a second project
      const sd = old.prepare('INSERT INTO agent_spend_daily (agent_id, day, cost_usd, tokens) VALUES (?, ?, ?, ?)');
      sd.run('ba1', '2034-03-10', 3, 0);
      sd.run('ba1', '2034-03-09', 2, 0);
      sd.run('ba3', '2034-03-10', 0, 250);
      old.exec(readFileSync(new URL('240_spend_totals.sql', dir), 'utf8'));
      const got = old.prepare('SELECT project_id, day, cost_usd, tokens FROM project_spend_daily ORDER BY project_id, day').all() as Array<{ project_id: string; day: string; cost_usd: number; tokens: number }>;
      const at1 = (p: string, d: string) => got.find((r) => r.project_id === p && r.day === d);
      check('the backfill copies every dated day of the agents, per project', near(at1('bp1', '2034-03-10')?.cost_usd, 3) && at1('bp1', '2034-03-10')?.tokens === 250 && near(at1('bp1', '2034-03-09')?.cost_usd, 2), JSON.stringify(got));
      check(
        "and a 'before' row with the rest of the lifetime: $14 less the $5 dated, 1000 tokens less the 250",
        at1('bp1', '0000-00-00')?.cost_usd === 9 && at1('bp1', '0000-00-00')?.tokens === 750,
        JSON.stringify(at1('bp1', '0000-00-00')),
      );
      check("so the project's total starts at its agents' lifetime, and today at today's", near(got.filter((r) => r.project_id === 'bp1').reduce((n, r) => n + r.cost_usd, 0), 14) && got.filter((r) => r.project_id === 'bp1').reduce((n, r) => n + r.tokens, 0) === 1000);
      check('a project whose agents had no days gets its lifetime as before', at1('bp2', '0000-00-00')?.cost_usd === 7 && got.filter((r) => r.project_id === 'bp2').length === 1);
      check('a project that spent nothing gets no row', got.every((r) => r.project_id !== 'bp3'));
      // Read the way the daemon reads it, with today at 2034-03-10.
      const readNow = now;
      now = new Date(2034, 2, 10, 9, 0, 0);
      const bp1 = projectSpend(old).find((p) => p.projectId === 'bp1');
      now = readNow;
      check("and projectSpend reads it: today $3 and 250 tokens, in all $14 and 1000", near(bp1?.today, 3) && bp1?.tokensToday === 250 && near(bp1?.total, 14) && bp1?.tokensTotal === 1000, JSON.stringify(bp1));
      old.close();
    }

    setDayClock();
    watch?.check();
    watch?.start();
    db.prepare("DELETE FROM cost_daily WHERE day >= '2034-01-01'").run();
    db.prepare("DELETE FROM project_spend_daily WHERE day >= '2034-01-01'").run();
    eyes.close();
    sdk.query = realQuery;
  }

  // ───────────────────────────────────────────────────────────────────────────
  await new Promise<void>((r) => devServer.close(() => r()));
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nTrack A session: PASS — project removal forgets bookkeeping and touches no files; budgets are per day, and at midnight only an agent its budget paused is continued, within the slots and a pause of everything (or renewed, with the setting off); models switch; failures and outages reach Needs You; a resume that cannot make its call is moved past it; an agent put to sleep keeps its question and wakes into a free slot; cleanup clears only what removal left behind; an agent that waited hears what the ones before it said; the other directories of a project are reachable, readable, and forgotten without touching them; an agent whose model cannot be reached waits and tries again, five times at most, then fails as it did; each agent, project and the fleet keep an all-time total beside the figure for today, which removing an agent does not lower.\n'
      : `\nTrack A session: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  process.exit(1);
});
