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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
  TerminalRun,
  ProviderInfo,
  ProviderModelList,
} from '@conductor/shared';
import { allowedUnattended, arbiter, fallbackSuggestions, ruleCovers, toolRuleFor } from '../arbiter/index.js';
import type { PermissionRequest, PermissionRequestResult, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { build } from '../index.js';
import { openDb, row, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { preview } from '../preview/index.js';
import { workspace } from '../workspace/service.js';
import type { WorkspaceRecord } from '../workspace/store.js';
import { ALERT_AFTER_MS, alerts, classifyRetry, initAlerts, retryNeedsYou } from './alerts.js';
import { JOB_BUDGET_NOTE, budgetNote, budgetRefusal, budgetStop, jobCap, tokens } from './budget.js';
import { backendFor, providerRefusal, registerBackend } from './backends/index.js';
import {
  DEFAULT_AUTONOMY,
  addCostToday,
  costToday,
  getAgent,
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
  setAgentAutonomy,
  setAgentStatus,
  localDay,
  helpersOf,
  unreportedHelpers,
} from './store.js';
import { AgentRunner, CUT_SHORT, HELPER_TOOLS, sdk } from './runner.js';
import { ClaudeBackend } from './backends/claude.js';
import { copilotSdk, excludedFor, gateCall, type CopilotClientLike } from './backends/copilot.js';
import { CopilotEvents, askFromPermission } from './backends/copilot-events.js';
import { forgetCatalog, forgetProviderModels, known, modelSources, providerModels, refusal } from './models.js';
import { HANDOFF_CAP, handoffSection } from './handoff.js';
import { fileEditFromTool, isWriteTool, normaliseTool, relPath, reversibility, todoFromInput, toolLabel } from './translate.js';
import { describeRule, fileHolds, ruleEntry, settingsFileFor } from './rules.js';
import { costChanged } from '../daily.js';
import { RESTART_NUDGE, SLOTS_KEY, WAKE_NUDGE, slotLimit, strandNote, supervisor, type ProjectRemoval } from './supervisor.js';
import { isStuck, rewireOnRemoval, type RemoveAgentResponse, type StackNode } from '@conductor/shared';

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
  console.log('\n11 · a budget is a lifetime cap');
  /*
   * The cap used to go to the SDK as `maxBudgetUsd` unchanged, and the SDK counts that
   * from the start of each query() — so every message bought a fresh $25, and the cap
   * never stopped anything. These run a real supervisor and runner; only the SDK is fake.
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
    'with what is LEFT of the cap, not the whole cap again',
    near(first?.options.maxBudgetUsd, 5),
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
  check('the next run gets the $1 left', near(runs[1]?.options.maxBudgetUsd, 1), `maxBudgetUsd ${runs[1]?.options.maxBudgetUsd}`);
  // The subtype alone, no `terminal_reason` — which the SDK types as optional.
  runs[1]?.finish({ cost: 25.2, subtype: 'error_max_budget_usd', isError: true });
  await until(() => getAgent(db, 'agt_capped')?.status !== 'working');
  check(
    'running out is paused, not failed',
    getAgent(db, 'agt_capped')?.status === 'paused',
    getAgent(db, 'agt_capped')?.status,
  );
  const stoppedFor = lastStatus('agt_capped');
  check(
    'and says what it spent against what cap',
    stoppedFor?.kind === 'status' && stoppedFor.error === 'budget reached — spent $25.20 of its $25 budget',
    JSON.stringify(stoppedFor),
  );
  check("and does not fail its job", getJob(db, 'job_budget')?.status !== 'failed', getJob(db, 'job_budget')?.status);

  const sentence = 'The Builder has spent $25.20 of its $25 budget — raise it to continue.';
  const atCap = await send<{ error: string; detail?: string }>('POST', '/api/agents/agt_capped/message', {
    text: 'please carry on',
  });
  check('at the cap, a message is refused with 409', atCap.status === 409, `got ${atCap.status}`);
  check('and a sentence saying why', atCap.body.detail === sentence, JSON.stringify(atCap.body));
  const resumeRefused = await send<{ detail?: string }>('POST', '/api/agents/agt_capped/resume');
  check('so is resume', resumeRefused.status === 409 && resumeRefused.body.detail === sentence, `${resumeRefused.status} ${JSON.stringify(resumeRefused.body)}`);
  await settle(100);
  check('and nothing ran', runs.length === 2, `${runs.length} runs`);
  check('and it is still paused', getAgent(db, 'agt_capped')?.status === 'paused');

  const watching = await connect();
  const raised = await send<{ autonomy: Agent['autonomy'] }>('POST', '/api/agents/agt_capped/autonomy', {
    autonomy: { budgetUsd: 35 },
  });
  check('the cap can be raised', raised.status === 200 && raised.body.autonomy.budgetUsd === 35, JSON.stringify(raised.body));
  check('without touching the rest of its autonomy', raised.body.autonomy.mode === capped.mode);
  await settle();
  check(
    'and every tab is told',
    watching.frames.some(
      (f) => f.type === 'entities' && f.agents?.some((a) => a.id === 'agt_capped' && a.autonomy.budgetUsd === 35),
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
  check('with the $9.80 the raise left', near(runs[2]?.options.maxBudgetUsd, 35 - 25.2), `maxBudgetUsd ${runs[2]?.options.maxBudgetUsd}`);
  runs[2]?.finish({ cost: 26, reason: 'completed' });
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
  check('fresh, from the job prompt', runs[4]?.options.resume === undefined && near(runs[4]?.options.maxBudgetUsd, 25));
  runs[4]?.finish({ cost: 1, reason: 'completed' });
  await until(() => getAgent(db, 'agt_second')?.status === 'done');

  // At its own cap in a job that is not: refused at launch, before a run the SDK would
  // end on its first turn. Its siblings' headroom keeps the job-cap pause out of the way.
  fixture('agt_spent', 'job_pair', { role: 'validator', status: 'queued', sdkSessionId: 'sess_spent', costUsd: 25 });
  sup.pump();
  await until(() => getAgent(db, 'agt_spent')?.status !== 'queued');
  await settle(100);
  check('an agent at its cap is not launched', runs.length === 5, `${runs.length} runs`);
  const spentNote = lastStatus('agt_spent');
  check(
    'it is paused, saying so',
    getAgent(db, 'agt_spent')?.status === 'paused' &&
      spentNote?.kind === 'status' &&
      spentNote.error === 'budget reached — spent $25 of its $25 budget',
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
  runs[5]?.finish({ cost: 26.5, reason: 'completed' });
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
  check('a finished agent is not an alert', !open().some((a) => a.agentIds.includes('agt_capped')));

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
  said17('agt_debugger', 'Reading the parser first.');
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
  check('it hears what the agent before it said last', told17.includes('[debugger]\nRoot cause: parse.ts:42 drops the last token.'), told17);
  check('and only what it said last, not its working notes', !told17.includes('Reading the parser first.'), told17);
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
  runs[0]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_fixer')?.status === 'done');

  fixture('agt_alone', 'job_handoff', { role: 'reviewer', status: 'queued', autonomy: DEFAULT_AUTONOMY });
  sup.pump();
  await until(() => (runs[1]?.prompts.length ?? 0) > 0);
  check('an agent that waited for nobody is told nothing extra', runs[1]?.prompts[0] === 'the job_handoff prompt', JSON.stringify(runs[1]?.prompts));
  runs[1]?.finish({ cost: 0, reason: 'completed' });
  await until(() => getAgent(db, 'agt_alone')?.status === 'done');

  const long = handoffSection([{ role: 'analyst', reply: 'x'.repeat(HANDOFF_CAP + 500) }]);
  check('a very long reply is cut, and says so', long.length < HANDOFF_CAP + 400 && long.includes(`of ${(HANDOFF_CAP + 500).toLocaleString('en')} characters`), String(long.length));
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
    check('told what each helper said last', (woke?.prompts[0] ?? '').includes('[builder-api]\nAPI done: routes in api.ts.'), woke?.prompts[0]);
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
    fixture('agt_capped53', 'job_restart', { status: 'working', sdkSessionId: 'sess_capped53', costUsd: 30, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } });
    check('reconcile queues every agent a restart left working', sup.reconcile() >= 3 && ['agt_cut', 'agt_fresh', 'agt_capped53'].every((id) => getAgent(db, id)?.status === 'queued'));
    sup.pump();
    check('pump resumes them, with no click', await until(() => runs.length === start + 2));
    const cut = runs.slice(start).find((r) => r.options.resume === 'sess_cut');
    await until(() => (cut?.prompts.length ?? 0) > 0);
    check('in its own session, told a restart stopped it', cut?.prompts[0] === RESTART_NUDGE, JSON.stringify(cut?.prompts));
    const fresh = runs.slice(start).find((r) => !r.options.resume);
    await until(() => (fresh?.prompts.length ?? 0) > 0);
    check('one that had no session yet starts from its prompt', (fresh?.prompts[0] ?? '').includes('the job_restart prompt'), fresh?.prompts[0]);
    check('one already at its cap is paused, not run', getAgent(db, 'agt_capped53')?.status === 'paused' && !runs.slice(start).some((r) => r.options.resume === 'sess_capped53'));
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
      JSON.stringify(first?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: PROMPT68 }),
      JSON.stringify(first?.options.systemPrompt),
    );
    check('and its skills are the ones passed', JSON.stringify(first?.options.skills) === '["pdf","docx"]', JSON.stringify(first?.options.skills));
    check('an agent without a persona launches as before: neither option', plain !== undefined && !('systemPrompt' in plain.options) && !('skills' in plain.options), JSON.stringify(Object.keys(plain?.options ?? {})));

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
      JSON.stringify(resumed?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: PROMPT68 }) && JSON.stringify(resumed?.options.skills) === '["pdf","docx"]',
      JSON.stringify({ systemPrompt: resumed?.options.systemPrompt, skills: resumed?.options.skills }),
    );
    resumed?.finish({ cost: 0, reason: 'completed' });
    await until(() => getAgent(db, withId)?.status === 'done');
    await send('POST', `/api/agents/${plainId}/message`, { text: 'one more thing' });
    check('and a resume of one without stays without', await until(() => runs.length === before + 2) && !('systemPrompt' in (runs.at(-1)?.options ?? {})) && !('skills' in (runs.at(-1)?.options ?? {})));
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
    check('and launches with it', JSON.stringify(helperRun?.options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code', append: PROMPT68 }) && JSON.stringify(helperRun?.options.skills) === '["pdf"]');
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
    // The cap lowered under what it has spent: the next model call finds it reached.
    setAgentAutonomy(db, 'agt_cp5', { ...DEFAULT_AUTONOMY, budgetTokens: 5 });
    s5?.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 5, outputTokens: 5 });
    await until(() => getAgent(db, 'agt_cp5')?.status === 'paused');
    check(
      'over its cap after a model call: stopped and paused with the budget note, its spend unchanged',
      getAgent(db, 'agt_cp5')?.status === 'paused' && (s5?.aborts ?? 0) >= 1 && getAgent(db, 'agt_cp5')?.costUsd === 0.5 &&
        payloads('agt_cp5').some((p) => p.kind === 'status' && p.status === 'paused' && /budget reached .*-token budget/.test(p.error ?? '')),
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
    sOr?.emit('session.idle', {});
    await until(() => getAgent(db, orId)?.status === 'done');
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
                setAgentUsage(d, scope.agentId, { costUsd: 0, inputTokens: input, outputTokens: output });
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
    const tokenAgent = { role: 'builder', costUsd: 0, inputTokens: 300_000, outputTokens: 112_000, autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 500_000 } };
    check('under its token cap, a $0 agent may run', budgetRefusal(tokenAgent) === null);
    const atTokenCap = { ...tokenAgent, outputTokens: 200_000 };
    check('at it, refused in tokens — no dollar figure', budgetRefusal(atTokenCap) === 'The Builder has spent 500k of its 500k-token budget — raise it to continue.', String(budgetRefusal(atTokenCap)));
    check('and its note says the same', budgetNote(atTokenCap) === 'budget reached — spent 500k of its 500k-token budget', budgetNote(atTokenCap));
    check('which still reads as a budget stop', budgetStop(budgetNote(atTokenCap)) === 'budget_exhausted');
    const dollars = { role: 'builder', costUsd: 25, inputTokens: 9_000_000, outputTokens: 0, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 25 } };
    check('a dollar cap reads exactly as before, whatever the tokens', budgetRefusal(dollars) === 'The Builder has spent $25 of its $25 budget — raise it to continue.' && budgetNote(dollars) === 'budget reached — spent $25 of its $25 budget');
    check('and tokens never stop an agent capped in dollars', budgetRefusal({ ...dollars, costUsd: 1 }) === null);
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
    tokenRuns[1]?.end({ input: 380_000, output: 132_000, atCap: true });
    await until(() => getAgent(db, tid)?.status === 'paused');
    const note = eventLog().forAgent(tid).map((e) => e.payload).filter((p) => p.kind === 'status').at(-1);
    check('reaching it pauses the agent, in tokens', getAgent(db, tid)?.status === 'paused' && note?.kind === 'status' && note.error === 'budget reached — spent 512k of its 500k-token budget', JSON.stringify(note));
    const sentence = 'The Builder has spent 512k of its 500k-token budget — raise it to continue.';
    const refusedMsg = await send<{ detail?: string }>('POST', `/api/agents/${tid}/message`, { text: 'go on' });
    check('then a message is refused with that sentence', refusedMsg.status === 409 && refusedMsg.body.detail === sentence, JSON.stringify(refusedMsg.body));
    const refusedResume = await send<{ detail?: string }>('POST', `/api/agents/${tid}/resume`);
    check('and so is resume', refusedResume.status === 409 && refusedResume.body.detail === sentence, JSON.stringify(refusedResume.body));
    check('and nothing ran', tokenRuns.length === 2);
    check("today's spend is dollars only — 912k tokens added nothing to it", costToday(db) === todayBefore, `${costToday(db)} vs ${todayBefore}`);

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
      (devRun?.prompts[0] ?? '').includes('[architect — stopped, so it may not have finished its part]\nPlan: half of it, in PLAN.md.') &&
        (devRun?.prompts[0] ?? '').includes('without waiting for every agent before you'),
      devRun?.prompts[0],
    );
    check('the job is open again', getJob(db, 'job_strand')?.status === 'working');
    check('and the alert has cleared', !alerts().list().some((a) => a.kind === 'blocked_dep' && a.agentIds[0] === p('dev')));
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
    check('its handoff comes from the architect', (runs[atRw]?.prompts[0] ?? '').includes('[architect]\nThe plan is in PLAN.md.'), runs[atRw]?.prompts[0]);
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
    runs[atF + 1]?.finish({ cost: 0, reason: 'completed' });
    check('and once it is done the one waiting starts', await until(() => getAgent(db, 'agt_f_rev')?.status === 'working'));
    runs.at(-1)?.finish({ cost: 0, reason: 'completed' });
    check('every job here settled', await until(() => ['job_strand', 'job_legacy', 'job_rw', 'job_rw2', 'job_fail88'].every((j) => ['done', 'failed'].includes(getJob(db, j)?.status ?? ''))), JSON.stringify(['job_strand', 'job_legacy', 'job_rw', 'job_rw2', 'job_fail88'].map((j) => getJob(db, j)?.status)));
    for (const r of runs) if (!r.finished) r.finish({ cost: 0 });
    await until(() => sup.slots.used === 0);
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

  // ───────────────────────────────────────────────────────────────────────────
  await new Promise<void>((r) => devServer.close(() => r()));
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nTrack A session: PASS — project removal forgets bookkeeping and touches no files; budgets are lifetime caps; models switch; failures and outages reach Needs You; a resume that cannot make its call is moved past it; an agent put to sleep keeps its question and wakes into a free slot; cleanup clears only what removal left behind; an agent that waited hears what the ones before it said; the other directories of a project are reachable, readable, and forgotten without touching them.\n'
      : `\nTrack A session: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  process.exit(1);
});
