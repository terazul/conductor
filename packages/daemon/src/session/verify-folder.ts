/**
 * Validator checks for Amendment 114: an agent whose job's folder is gone is told so, and
 * the folder can be put back so it carries on in its own session.
 *
 * A real git repo and worktree in tmpdir; a fake SDK, as in session/verify.ts, so a launch
 * is a count in `runs`. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-folder.ts
 * If interrupted: lsof -ti :7813 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { existsSync } from 'node:fs';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { alerts } from './alerts.js';
import { DEFAULT_AUTONOMY, getAgent, insertAgent, insertJob, lastStatusNote } from './store.js';
import { FOLDER_GONE, supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7813;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-folder-verify-${Date.now()}`);

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=v@example.invalid', '-c', 'user.name=v', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# folder verify\n');
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'add', '.');
  git(ROOT, 'commit', '-q', '-m', 'init');
  const WT = join(ROOT, '.conductor', 'wt', 'job_f');
  git(ROOT, 'worktree', 'add', '-q', '-b', 'conductor/job_f', WT, 'main');
  writeFileSync(join(WT, 'work.txt'), 'committed on the job branch\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'job work');

  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();

  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'folder-verify' });
  const projectId = added.body.project.id;
  const job = (id: string, isolation: 'worktree' | 'in_place', path: string, branch: string) =>
    insertJob(db, { id, projectId, prompt: 'work', isolation, worktreePath: path, branch, status: 'done', budgetUsd: null });
  const agent = (id: string, jobId: string, o: Partial<Parameters<typeof insertAgent>[1]> = {}): void => {
    insertAgent(db, {
      id, jobId, projectId, role: 'architect', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
      blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY, ...o,
    });
  };
  const status = (id: string) => getAgent(db, id)?.status;
  job('job_f', 'worktree', WT, 'conductor/job_f');
  agent('agt_arch', 'job_f', { sdkSessionId: 'sess_arch' });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the folder is deleted');
  git(ROOT, 'worktree', 'remove', '--force', WT);
  check('it is gone', !existsSync(WT));

  const msg = await send<{ error: string; detail?: string }>('POST', '/api/agents/agt_arch/message', { text: 'carry on' });
  check('a message is refused with 409, saying the folder is gone', msg.status === 409 && /folder .* is gone/.test(msg.body.detail ?? ''), JSON.stringify(msg.body));
  check('and says how to fix it', /recreate it/.test(msg.body.detail ?? ''), msg.body.detail);
  check('nothing was launched', runs.length === 0);
  check('its status is unchanged', status('agt_arch') === 'done');

  agent('agt_queued', 'job_f', { status: 'queued' });
  sup.pump();
  check('a queued agent there fails with folder_gone instead of starting', await until(() => status('agt_queued') === 'failed') && lastStatusNote(db, 'agt_queued') === FOLDER_GONE, `${status('agt_queued')} ${lastStatusNote(db, 'agt_queued')}`);
  check('still nothing launched', runs.length === 0);
  const alert = alerts().list().find((a) => a.kind === 'failed' && a.agentIds[0] === 'agt_queued');
  check('Needs You has it, with the cause and the sentence', alert?.cause === FOLDER_GONE && /is gone/.test(alert.detail ?? ''), JSON.stringify(alert));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · recreate it on its branch');
  const restored = await send<{ path: string; branch: string; from: string }>('POST', '/api/jobs/job_f/folder');
  check('POST /api/jobs/:id/folder → 200, from its branch', restored.status === 200 && restored.body.from === 'branch', JSON.stringify(restored.body));
  check('the folder is back, on its branch, with what was committed', existsSync(join(WT, 'work.txt')) && git(WT, 'branch', '--show-current') === 'conductor/job_f');
  const evs = await send<{ events: { payload: { kind: string; text?: string } }[] }>('GET', '/api/agents/agt_arch/events');
  check("its transcript says the folder was recreated, and to check what's there", evs.body.events.some((e) => e.payload.kind === 'user_text' && /was deleted and has been recreated on conductor\/job_f/.test(e.payload.text ?? '')));
  const again = await send<{ error: string; detail?: string }>('POST', '/api/jobs/job_f/folder');
  check('again → 409, it is there already', again.status === 409 && /there already/.test(again.body.detail ?? ''), JSON.stringify(again.body));

  const go = await send<{ ok: boolean }>('POST', '/api/agents/agt_arch/message', { text: 'carry on' });
  check('now a message goes through', go.status === 200, JSON.stringify(go.body));
  check('and resumes its own session there', await until(() => runs.some((r) => r.options.resume === 'sess_arch' && r.options.cwd === WT)), runs.map((r) => `${r.options.resume}@${r.options.cwd}`).join(','));
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · folder and branch both gone: recreated from main');
  git(ROOT, 'worktree', 'remove', '--force', WT);
  git(ROOT, 'branch', '-D', 'conductor/job_f');
  const fromMain = await send<{ from: string; base?: string }>('POST', '/api/jobs/job_f/folder');
  check('→ 200, from main, on a new branch of the same name', fromMain.status === 200 && fromMain.body.from === 'base' && fromMain.body.base === 'main' && git(WT, 'branch', '--show-current') === 'conductor/job_f', JSON.stringify(fromMain.body));
  check('without the lost commit', !existsSync(join(WT, 'work.txt')));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · what cannot be recreated');
  const GONE = join(ROOT, 'elsewhere');
  job('job_ip', 'in_place', GONE, 'main');
  const inPlace = await send<{ error: string; detail?: string }>('POST', '/api/jobs/job_ip/folder');
  check('a job that works in a folder of its own choosing → 409, saying what to do', inPlace.status === 409 && /put that folder back/.test(inPlace.body.detail ?? ''), JSON.stringify(inPlace.body));
  const none = await send<{ error: string }>('POST', '/api/jobs/job_nope/folder');
  check('no such job → 404', none.status === 404);

  // ───────────────────────────────────────────────────────────────────────────
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 114 folder: PASS — ${checks} checks: a deleted folder is said plainly, nothing is launched into it, and it is recreated on its branch or from main.\n`
      : `\nAmendment 114 folder: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
