/**
 * Validator checks for Amendment 131: a question you answer after a while is not lost.
 *
 * A question is held 30 minutes before it is put aside (a permission, 90 s). Put aside, the
 * agent's turn ends and Claude Code records "the user doesn't want to proceed … STOP"; when
 * you answer, the agent is resumed with your answers in words, not "make that call again".
 *
 * A fake SDK, as in session/verify.ts. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-answer.ts
 * If interrupted: lsof -ti :7814 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { DEFER_AFTER_MS, QUESTION_DEFER_AFTER_MS } from '../arbiter/index.js';
import { openRequestsForAgent } from './store.js';
import { DEFAULT_AUTONOMY, getAgent, insertAgent, insertJob, lastStatusNote } from './store.js';
import { answeredNudge, supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7814;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-answer-verify-${Date.now()}`);

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle(20);
  }
  return true;
}

// ── a fake SDK: one run per launch, ended by the check ─────────────────────

interface FakeRun {
  options: Options;
  prompts: string[];
  finish(): void;
  finished: boolean;
}
const runs: FakeRun[] = [];

function fakeQuery({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  let wake: (() => void) | null = null;
  const run: FakeRun = {
    options: options ?? {},
    prompts: [],
    finished: false,
    finish() {
      if (run.finished) return;
      run.finished = true;
      wake?.();
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
    if (!run.finished) await new Promise<void>((r) => (wake = r));
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      session_id: sessionId,
    };
  }
  return Object.assign(messages(), {
    interrupt: async () => run.finish(),
    setModel: async () => undefined,
  }) as unknown as Query;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=v@example.invalid', '-c', 'user.name=v', ...args], { cwd, stdio: 'ignore' });
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# answer verify\n');
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'add', '.');
  git(ROOT, 'commit', '-q', '-m', 'init');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · how long a question is held, and what the agent is told');
  check('a permission is put aside after 90 s', DEFER_AFTER_MS === 90_000, String(DEFER_AFTER_MS));
  check('a question after 30 minutes', QUESTION_DEFER_AFTER_MS === 30 * 60_000, String(QUESTION_DEFER_AFTER_MS));
  const qs = [{ question: 'Which database?' }, { question: 'Which features?' }];
  const said = answeredNudge(qs, { 'Which database?': 'postgres', 'Which features?': ['auth', 'search'] }, 'and keep it small');
  check('it says each question and its answer', said.includes('"Which database?" → postgres') && said.includes('"Which features?" → auth, search'), said);
  check('and what you added', said.includes('And they added: and keep it small'));
  check("it explains the \"doesn't want to proceed\" it will see, and says to ignore it", /doesn't want to proceed/.test(said) && /Ignore that/.test(said));
  check('it says carry on, and not to ask again', /Carry on from where you stopped/.test(said) && /Do not ask this question again/.test(said));
  check('it never says "approved"', !/approved/.test(said));
  check('an answer to a question not in the list is still said', answeredNudge([], { 'Other?': 'yes' }).includes('"Other?" → yes'));
  check('no answers at all says so', answeredNudge(qs, {}).includes('no answer was given'));

  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();
  // A page is open, so a question is held rather than put aside at once.
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((r) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', since: 0 }));
      setTimeout(r, 100);
    };
  });

  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'answer-verify' });
  const projectId = added.body.project.id;
  insertJob(db, { id: 'job_q', projectId, prompt: 'design it', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_q', jobId: 'job_q', projectId, role: 'architect', model: 'claude-sonnet-5', sdkSessionId: 'sess_q', status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · asked, held, put aside, answered');
  await send('POST', '/api/agents/agt_q/message', { text: 'design the store' });
  await until(() => runs.length === 1);
  const asking = runs[0]!;
  const signal = new AbortController().signal;
  const input = {
    questions: [
      { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'postgres', description: '' }, { label: 'sqlite', description: '' }] },
    ],
  };
  void asking.options.canUseTool?.('AskUserQuestion', input, { signal, toolUseID: 'tu_q', suggestions: [] } as never);
  await until(() => getAgent(db, 'agt_q')?.blockMode === 'held');
  await settle(300);
  check('a question with a page open is held, not put aside at once', getAgent(db, 'agt_q')?.blockMode === 'held' && !asking.finished);

  // Put aside, as it would be after the hold: pausing parks it now.
  await send('POST', '/api/agents/agt_q/pause');
  await until(() => asking.finished && getAgent(db, 'agt_q')?.blockMode === 'parked');
  const open = openRequestsForAgent(db, 'agt_q');
  check('put aside, the question stays open', open.length === 1 && open[0]?.kind === 'question', JSON.stringify(open.map((r) => r.kind)));

  const before = runs.length;
  const answered = await send('POST', `/api/requests/${open[0]?.id}/decide`, { decision: { type: 'answer', answers: { 'Which database?': 'postgres' } } });
  check('answering → 200', answered.status === 200, JSON.stringify(answered.body));
  await until(() => runs.length === before + 1);
  const woke = runs.at(-1)!;
  check('it resumes its own session', woke.options.resume === 'sess_q', String(woke.options.resume));
  await until(() => woke.prompts.length > 0);
  const told = woke.prompts[0] ?? '';
  check('and is told your answer, in words', told.includes('"Which database?" → postgres'), told);
  check('not "make that exact call again"', !/Make that exact call again/.test(told) && !/approved/.test(told), told);

  // ───────────────────────────────────────────────────────────────────────────
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  socket.close();
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 131 answer: PASS — ${checks} checks: a question is held 30 minutes, and one answered after it was put aside comes back to the agent as your answer.\n`
      : `\nAmendment 131 answer: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
