/**
 * Validator checks for Amendment 111: pause everything until a time, and send a message
 * to an agent at a time.
 *
 * No agent reaches the real SDK: `sdk.query` is swapped for a fake for the whole run, as
 * in session/verify.ts, so a launch is a count in `runs`. Jobs and agents are inserted
 * through the store. The clock is driven by calling `scheduler().tick()` rather than
 * waiting for its interval.
 *
 * Run: pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-schedule.ts
 *
 * If it is interrupted the listener stays up and the next run dies with EADDRINUSE:
 *   lsof -ti :7812 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ScheduledMessage, ServerFrame } from '@conductor/shared';
import { PAUSE_UNTIL_KEY } from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { readSettings } from '../settings.js';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { Scheduler, listScheduled, pausedUntil, scheduler, timeProblem } from './schedule.js';
import { DEFAULT_AUTONOMY, getAgent, insertAgent, insertJob, lastStatusNote, setAgentStatus } from './store.js';
import { HOLD_NOTE, supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7812;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-schedule-verify-${Date.now()}`);

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

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' });
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# schedule verify\n');
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=v@example.invalid', '-c', 'user.name=v', 'add', '.');
  git('-c', 'user.email=v@example.invalid', '-c', 'user.name=v', 'commit', '-q', '-m', 'init');

  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();

  const frames: ServerFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((r) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', since: 0 }));
      setTimeout(r, 100);
    };
  });
  socket.onmessage = (m) => {
    try {
      frames.push(JSON.parse(String(m.data)) as ServerFrame);
    } catch {
      /* not ours */
    }
  };

  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'schedule-verify' });
  const projectId = added.body.project.id;
  insertJob(db, {
    id: 'job_s',
    projectId,
    prompt: 'keep going',
    isolation: 'in_place',
    worktreePath: ROOT,
    branch: 'main',
    status: 'working',
    budgetUsd: null,
  });
  const agent = (id: string, o: Partial<Parameters<typeof insertAgent>[1]> = {}): void => {
    insertAgent(db, {
      id,
      jobId: 'job_s',
      projectId,
      role: id.replace(/^agt_/, ''),
      model: 'claude-sonnet-5',
      sdkSessionId: null,
      status: 'queued',
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy: DEFAULT_AUTONOMY,
      ...o,
    });
  };
  const status = (id: string) => getAgent(db, id)?.status;
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const setPause = (v: string | null) => send<{ settings: Record<string, string> }>('PATCH', '/api/settings', { settings: { [PAUSE_UNTIL_KEY]: v } });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · times');
  const now = Date.parse('2026-10-09T12:00:00Z');
  check('an ISO time ahead is fine', timeProblem('2026-10-09T18:00:00Z', now) === null);
  check('a minute ago is still fine (a slow click)', timeProblem('2026-10-09T11:59:30Z', now) === null);
  check('an hour ago has passed', timeProblem('2026-10-09T11:00:00Z', now) === 'that time has passed');
  check('more than a year ahead is refused', timeProblem('2027-12-01T00:00:00Z', now) === 'more than a year ahead');
  check('not a time says so', /not a time/.test(timeProblem('tomorrow-ish', now) ?? '') && timeProblem('', now) === 'a time is required');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · pause everything until a time');
  agent('agt_worker');
  sup.pump();
  check('an agent starts while nothing is paused', await until(() => runs.length === 1 && status('agt_worker') === 'working'), String(status('agt_worker')));
  // One you paused yourself, which the end of the pause must leave alone.
  agent('agt_mine', { status: 'paused', sdkSessionId: 'sess_mine' });
  eventLog().emit({ projectId, jobId: 'job_s', agentId: 'agt_mine' }, { kind: 'status', status: 'paused', error: 'paused by the user' });

  const badPause = await setPause('soon');
  check('a pause time that is not one → 400', badPause.status === 400, String(badPause.status));
  const on = await setPause(future(60 * 60_000));
  check('PATCH pauseUntil → 200', on.status === 200, JSON.stringify(on.body).slice(0, 200));
  await scheduler().tick();
  check('the supervisor is held', sup.held === true);
  check('the working agent is paused, with the pause note', await until(() => status('agt_worker') === 'paused'), String(status('agt_worker')));
  check('its note is the hold note', lastStatusNote(db, 'agt_worker') === HOLD_NOTE, String(lastStatusNote(db, 'agt_worker')));
  check('its run was stopped', runs[0]?.finished === true);
  check('pausedUntil reads the setting', pausedUntil() !== null);

  agent('agt_later');
  sup.pump();
  await settle(150);
  check('nothing queued starts while paused', status('agt_later') === 'queued' && runs.length === 1, `${status('agt_later')} · ${runs.length} runs`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · a message due while everything is paused waits');
  agent('agt_done', { status: 'done', sdkSessionId: 'sess_done' });
  const sched = await send<{ message: ScheduledMessage }>('POST', '/api/agents/agt_done/scheduled', {
    at: new Date(Date.now() - 1_000).toISOString(),
    text: 'good morning: carry on with the tests',
  });
  check('POST scheduled → 201', sched.status === 201 && sched.body.message.agentId === 'agt_done', JSON.stringify(sched.body).slice(0, 200));
  await scheduler().tick();
  await settle(100);
  check('it is still waiting, and nothing ran', listScheduled(db).length === 1 && runs.length === 1, `${listScheduled(db).length} · ${runs.length}`);
  check('a scheduled frame went out', frames.some((f) => f.type === 'scheduled' && f.scheduled.length === 1));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · the pause ends');
  const off = await setPause(null);
  check('clearing it → 200', off.status === 200);
  await scheduler().tick();
  check('the supervisor is released', sup.held === false);
  check('the agent it paused carries on, in its own session', await until(() => status('agt_worker') === 'working'), String(status('agt_worker')));
  const resumed = runs.find((r, i) => i > 0 && r.options.resume === 'sess_fake_1');
  check('resumed, not started fresh', resumed !== undefined, runs.map((r) => r.options.resume ?? '-').join(','));
  check('what was queued starts', await until(() => status('agt_later') === 'working'), String(status('agt_later')));
  check('one you paused yourself stays paused', status('agt_mine') === 'paused');
  const delivered = await until(() => runs.some((r) => r.options.resume === 'sess_done'));
  check('the waiting message went out, resuming its agent', delivered);
  const doneRun = runs.find((r) => r.options.resume === 'sess_done');
  check('with your text', await until(() => (doneRun?.prompts ?? []).some((p) => p.includes('good morning: carry on with the tests'))), JSON.stringify(doneRun?.prompts));
  check('and its row is gone', listScheduled(db).length === 0);
  check('and every page heard', frames.some((f) => f.type === 'scheduled' && f.scheduled.length === 0));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · a pause whose time passes ends by itself');
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  agent('agt_short');
  sup.pump();
  await until(() => status('agt_short') === 'working');
  await setPause(future(400));
  await scheduler().tick();
  check('paused for now', await until(() => status('agt_short') === 'paused'));
  await settle(500);
  await scheduler().tick();
  check('and carries on once the time is past', await until(() => status('agt_short') === 'working'), String(status('agt_short')));
  check('the setting is removed', readSettings()[PAUSE_UNTIL_KEY] === undefined, readSettings()[PAUSE_UNTIL_KEY]);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · a restart after the time wakes what the pause paused');
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  agent('agt_slept', { status: 'paused', sdkSessionId: 'sess_slept' });
  eventLog().emit({ projectId, jobId: 'job_s', agentId: 'agt_slept' }, { kind: 'status', status: 'paused', error: HOLD_NOTE });
  const fresh = new Scheduler(db, sup);
  await fresh.tick();
  fresh.stop();
  check('a fresh scheduler with no pause on wakes it', await until(() => status('agt_slept') === 'working'), String(status('agt_slept')));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · refusals and failures');
  const at = future(60 * 60_000);
  const none = await send<{ error: string }>('POST', '/api/agents/agt_nope/scheduled', { at, text: 'x' });
  check('an unknown agent → 404', none.status === 404);
  const empty = await send<{ error: string }>('POST', '/api/agents/agt_done/scheduled', { at, text: '  ' });
  check('no text → 400', empty.status === 400 && empty.body.error === 'text is required');
  const past = await send<{ error: string }>('POST', '/api/agents/agt_done/scheduled', { at: new Date(Date.now() - 3_600_000).toISOString(), text: 'x' });
  check('a time that has passed → 400', past.status === 400 && past.body.error === 'that time has passed', JSON.stringify(past.body));
  const garbage = await send<{ error: string }>('POST', '/api/agents/agt_done/scheduled', { at: 'next tuesday', text: 'x' });
  check('a time that is not one → 400', garbage.status === 400);

  const later = await send<{ message: ScheduledMessage }>('POST', '/api/agents/agt_done/scheduled', { at, text: 'not yet' });
  const listed = await send<{ scheduled: ScheduledMessage[] }>('GET', '/api/scheduled');
  check('GET lists it, with its time', listed.body.scheduled.some((m) => m.id === later.body.message.id && m.at === new Date(at).toISOString()));
  await scheduler().tick();
  check('a time ahead is not sent early', listScheduled(db).some((m) => m.id === later.body.message.id));
  const gone = await send<{ removed: string }>('DELETE', `/api/scheduled/${later.body.message.id}`);
  check('DELETE cancels it', gone.status === 200 && listScheduled(db).length === 0);
  const gone2 = await send<{ error: string }>('DELETE', `/api/scheduled/${later.body.message.id}`);
  check('DELETE again → 404', gone2.status === 404);

  // At its budget: due, refused, kept with the reason, not tried again.
  agent('agt_capped', { status: 'done', sdkSessionId: 'sess_capped', costUsd: 2, autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 1 } });
  await send('POST', '/api/agents/agt_capped/scheduled', { at: new Date().toISOString(), text: 'over budget' });
  await scheduler().tick();
  const capped = listScheduled(db).find((m) => m.agentId === 'agt_capped');
  check('an agent at its budget: kept, with the reason', capped !== undefined && /budget/.test(capped.error ?? ''), JSON.stringify(capped));
  check('and nothing ran', !runs.some((r) => r.options.resume === 'sess_capped'));

  // Not started yet: no session to take it, so it waits and is tried again.
  agent('agt_unstarted', { status: 'paused', sdkSessionId: null });
  await send('POST', '/api/agents/agt_unstarted/scheduled', { at: new Date().toISOString(), text: 'when you start' });
  await scheduler().tick();
  const waiting = listScheduled(db).find((m) => m.agentId === 'agt_unstarted');
  check('an agent with no session yet: still waiting, no error', waiting !== undefined && waiting.error === null, JSON.stringify(waiting));

  // Removing the agent removes its messages.
  await send('DELETE', '/api/agents/agt_unstarted');
  check('removing the agent removes its messages', !listScheduled(db).some((m) => m.agentId === 'agt_unstarted'));

  // ───────────────────────────────────────────────────────────────────────────
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  setAgentStatus(db, 'agt_worker', 'done');
  socket.close();
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 111 schedule: PASS — ${checks} checks: pause everything until a time, wake only what it paused, end by itself; messages at a time, held by a pause, refused or kept as they should.\n`
      : `\nAmendment 111 schedule: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
