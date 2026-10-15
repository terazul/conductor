/**
 * Validator checks for Amendment 111: pause everything until a time, and send a message
 * to an agent at a time. §8 is Amendment 157's: a message queued until the agent is done.
 * §9 is Amendment 168's: a message due with every slot taken waits for one.
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
import { DatabaseSync } from 'node:sqlite';
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
import {
  DEFAULT_AUTONOMY,
  addSpendToday,
  getAgent,
  getJob,
  insertAgent,
  insertJob,
  lastStatusNote,
  openRequestsForAgent,
  setAgentStatus,
} from './store.js';
import { HOLD_NOTE, SLOTS_KEY, SLOT_WAIT_NOTE, slotLimit, supervisor } from './supervisor.js';

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
  /** End the turn in error, not a model outage: the agent is `failed` (§8). */
  fail(): void;
  finished: boolean;
  failed: boolean;
}
const runs: FakeRun[] = [];

function fakeQuery({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  let wake: (() => void) | null = null;
  const run: FakeRun = {
    options: options ?? {},
    prompts: [],
    finished: false,
    failed: false,
    finish() {
      if (run.finished) return;
      run.finished = true;
      wake?.();
    },
    fail() {
      run.failed = true;
      run.finish();
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
      subtype: run.failed ? 'error_during_execution' : 'success',
      is_error: run.failed,
      ...(run.failed ? { errors: ['it broke'] } : {}),
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
    // A budget counts what was spent TODAY (Amendment 129): an agent made with spend on it spent it today.
    if (o.costUsd) addSpendToday(db, id, { usd: o.costUsd });
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
  console.log('\n8 · a message queued until the agent is done (Amendment 157)');
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  const whenDone = (id: string, text: string, trigger = 'done') =>
    send<{ message: ScheduledMessage; error?: string }>('POST', `/api/agents/${id}/scheduled`, { trigger, text });
  const queuedFor = (id: string) => listScheduled(db).filter((m) => m.agentId === id && m.trigger === 'done').map((m) => m.text);
  const said = (r: FakeRun | undefined, text: string) => (r?.prompts ?? []).some((p) => p.includes(text));
  /** Tell agt_q something yourself, and return the run that takes it. */
  const tell = async (text: string): Promise<FakeRun | undefined> => {
    const n = runs.length;
    await send('POST', '/api/agents/agt_q/message', { text });
    return (await until(() => runs.length === n + 1 && status('agt_q') === 'working')) ? runs.at(-1) : undefined;
  };

  agent('agt_q');
  sup.pump();
  check('an agent starts its turn', await until(() => status('agt_q') === 'working' && Boolean(getAgent(db, 'agt_q')?.sdkSessionId)), String(status('agt_q')));
  const qSession = getAgent(db, 'agt_q')?.sdkSessionId;
  const turn1 = runs.at(-1)!;
  const q1 = await whenDone('agt_q', 'first follow-up');
  check(
    'POST { trigger: done } → 201, a row with no time of its own',
    q1.status === 201 && q1.body.message.trigger === 'done' && q1.body.message.at === q1.body.message.createdAt,
    JSON.stringify(q1.body).slice(0, 200),
  );
  await settle(5);
  const q2 = await whenDone('agt_q', 'second follow-up');
  check('a second one queues behind it', q2.status === 201 && queuedFor('agt_q').join('|') === 'first follow-up|second follow-up', queuedFor('agt_q').join('|'));
  check('every page hears of it', frames.some((f) => f.type === 'scheduled' && f.scheduled.some((m) => m.id === q1.body.message.id && m.trigger === 'done')));
  const base = runs.length;
  await scheduler().tick();
  await settle(100);
  check('nothing is sent while the agent is working, and the clock never reads it as due', runs.length === base && queuedFor('agt_q').length === 2 && !said(turn1, 'follow-up'));

  agent('agt_fin', { status: 'done', sdkSessionId: 'sess_fin' });
  const fin = await whenDone('agt_fin', 'x');
  check('for an agent already done → 400: send it now', fin.status === 400 && /send the message now/.test(fin.body.error ?? ''), JSON.stringify(fin.body));
  agent('agt_halted', { status: 'stopped', sdkSessionId: 'sess_halted' });
  const halted = await whenDone('agt_halted', 'x');
  check('for one that was stopped → 400', halted.status === 400 && /stopped/.test(halted.body.error ?? ''), JSON.stringify(halted.body));
  const slot = await whenDone('agt_q', 'x', 'slot');
  const bogus = await whenDone('agt_q', 'x', 'soon');
  check("'slot' (not built yet) and an unknown trigger → 400", slot.status === 400 && bogus.status === 400, `${slot.status} ${bogus.status}`);
  check('and none of them made a row', listScheduled(db).every((m) => m.text !== 'x'));

  turn1.finish();
  check('its turn ends done: the oldest goes, in its own session', await until(() => runs.length === base + 1), `${runs.length - base} runs`);
  const turn2 = runs.at(-1)!;
  check('resumed, not started fresh', turn2.options.resume === qSession, String(turn2.options.resume));
  check('with that text, and only that one', (await until(() => said(turn2, 'first follow-up'))) && !said(turn2, 'second follow-up'), JSON.stringify(turn2.prompts));
  check('sent once: its row is gone, the second still waits', queuedFor('agt_q').join('|') === 'second follow-up', queuedFor('agt_q').join('|'));
  check('it is working again, and its job did not finish under it', status('agt_q') === 'working' && getJob(db, 'job_s')?.status === 'working', `${status('agt_q')} · ${getJob(db, 'job_s')?.status}`);

  const question = {
    questions: [{ question: 'Which file?', header: 'File', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }],
  };
  void turn2.options.canUseTool?.('AskUserQuestion', question, { signal: new AbortController().signal, toolUseID: 'tu_q8', suggestions: [] } as never);
  check('it stops to ask you something', await until(() => status('agt_q') === 'blocked'), String(status('agt_q')));
  await settle(150);
  check('a question does not send it', runs.length === base + 1 && queuedFor('agt_q').length === 1, `${runs.length - base} runs · ${queuedFor('agt_q').length}`);
  const asked = openRequestsForAgent(db, 'agt_q')[0];
  await send('POST', `/api/requests/${asked?.id}/decide`, { decision: { type: 'answer', answers: { 'Which file?': 'a' } } });
  await until(() => status('agt_q') === 'working');
  turn2.finish();
  check('two queued messages take two turns: the second goes at the next done', await until(() => runs.length === base + 2), `${runs.length - base} runs`);
  const turn3 = runs.at(-1)!;
  check('with its own text, and none is left', (await until(() => said(turn3, 'second follow-up'))) && queuedFor('agt_q').length === 0, JSON.stringify(turn3.prompts));
  turn3.finish();
  await until(() => status('agt_q') === 'done');
  await settle(100);
  check('with none queued, done sends nothing', runs.length === base + 2 && status('agt_q') === 'done', `${runs.length - base} runs`);

  // On failed it waits, and goes after a later turn that ends done.
  const risky = await tell('try the risky thing');
  await whenDone('agt_q', 'after the failure');
  risky?.fail();
  check('the turn fails', await until(() => status('agt_q') === 'failed'), String(status('agt_q')));
  const afterFail = runs.length;
  await settle(150);
  check('on failed it waits', runs.length === afterFail && queuedFor('agt_q').join() === 'after the failure', `${runs.length - afterFail} · ${queuedFor('agt_q').join()}`);
  const mended = await tell('go on, carefully');
  mended?.finish();
  check('and goes once a later turn ends done', await until(() => said(runs.at(-1), 'after the failure') && runs.at(-1) !== mended), JSON.stringify(runs.at(-1)?.prompts));
  check('its row is gone', queuedFor('agt_q').length === 0);
  runs.at(-1)!.finish();
  await until(() => status('agt_q') === 'done');

  // Cancel works.
  const working = await tell('one more thing');
  const doomed = await whenDone('agt_q', 'never mind');
  const cancelled = await send('DELETE', `/api/scheduled/${doomed.body.message.id}`);
  check('DELETE cancels one', cancelled.status === 200 && queuedFor('agt_q').length === 0);
  const afterCancel = runs.length;
  working?.finish();
  await until(() => status('agt_q') === 'done');
  await settle(100);
  check('and nothing goes at done', runs.length === afterCancel && !runs.some((r) => said(r, 'never mind')));

  // The rows survive a restart: it is in the file, a fresh clock doesn't send it, the next done does.
  const resting = await tell('the long one');
  await whenDone('agt_q', 'after a restart');
  await send('POST', '/api/agents/agt_q/pause');
  check('paused by you', await until(() => status('agt_q') === 'paused' && resting?.finished === true), String(status('agt_q')));
  const file = new DatabaseSync(join(ROOT, 'conductor.db'));
  const onDisk = file.prepare("SELECT trigger, text FROM scheduled_messages WHERE agent_id = 'agt_q'").all() as { trigger: string; text: string }[];
  file.close();
  check('the row is in the database file, as done', onDisk.length === 1 && onDisk[0]?.trigger === 'done' && onDisk[0]?.text === 'after a restart', JSON.stringify(onDisk));
  const afterPause = runs.length;
  const reboot = new Scheduler(db, sup);
  await reboot.tick();
  reboot.stop();
  await settle(100);
  check('on paused it waits, and a fresh clock sends nothing', runs.length === afterPause && queuedFor('agt_q').length === 1 && status('agt_q') === 'paused');
  db.prepare("INSERT INTO scheduled_messages (id, agent_id, at, text, created_at) VALUES ('sch_old', 'agt_q', ?, 'old', ?)").run(future(3_600_000), new Date().toISOString());
  check('a row written without a trigger reads as a timed one', listScheduled(db).find((m) => m.id === 'sch_old')?.trigger === 'at');
  db.prepare("DELETE FROM scheduled_messages WHERE id = 'sch_old'").run();
  await send('POST', '/api/agents/agt_q/resume');
  check('resumed', await until(() => status('agt_q') === 'working' && runs.length === afterPause + 1), String(status('agt_q')));
  runs.at(-1)!.finish();
  check('and it goes at the next done', await until(() => said(runs.at(-1), 'after a restart')) && queuedFor('agt_q').length === 0, JSON.stringify(runs.at(-1)?.prompts));
  runs.at(-1)!.finish();
  await until(() => status('agt_q') === 'done');

  // A paused fleet holds them.
  const held = await tell('a big job');
  await whenDone('agt_q', 'after the pause');
  await setPause(future(60 * 60_000));
  await scheduler().tick();
  check('everything paused: the agent with it is paused', await until(() => status('agt_q') === 'paused' && held?.finished === true), String(status('agt_q')));
  const atHold = runs.length;
  await settle(100);
  check('a paused fleet holds it', runs.length === atHold && queuedFor('agt_q').length === 1);
  // Told something yourself during the pause, its turn ends done: still held.
  const yours = await tell('a quick one, during the pause');
  yours?.finish();
  await until(() => status('agt_q') === 'done');
  await settle(100);
  check('a turn that ends done while paused: held still', runs.length === atHold + 1 && queuedFor('agt_q').length === 1, `${runs.length - atHold} · ${queuedFor('agt_q').length}`);
  await setPause(null);
  await scheduler().tick();
  check('the pause ends: it goes', await until(() => said(runs.at(-1), 'after the pause')) && queuedFor('agt_q').length === 0, JSON.stringify(runs.at(-1)?.prompts));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · a message due with every slot taken waits for one (Amendment 168)');
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  const limitWas = slotLimit();
  await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: '1' } });
  agent('agt_full', { status: 'done', sdkSessionId: 'sess_full' });
  await send('POST', '/api/agents/agt_full/message', { text: 'take the only slot' });
  check('one slot, and it is taken', await until(() => sup.slots.used === 1 && slotLimit() === 1), `${sup.slots.used} of ${slotLimit()}`);
  agent('agt_due', { status: 'done', sdkSessionId: 'sess_due' });
  const due = await send<{ message: ScheduledMessage }>('POST', '/api/agents/agt_due/scheduled', {
    at: new Date(Date.now() - 1_000).toISOString(),
    text: 'the time has come: the release notes',
  });
  const beforeDue = runs.length;
  await scheduler().tick();
  await settle(100);
  check('its time comes: nothing starts, and no more than the limit run', runs.length === beforeDue && sup.slots.used === 1, `${runs.length - beforeDue} new run(s), ${sup.slots.used} running`);
  const dueRows = listScheduled(db).filter((m) => m.agentId === 'agt_due');
  check(
    "it waits as a 'slot' message, word for word, in place of the timed one",
    dueRows.length === 1 && dueRows[0]?.trigger === 'slot' && dueRows[0]?.text === 'the time has come: the release notes' && dueRows[0]?.id !== due.body.message.id,
    JSON.stringify(dueRows),
  );
  check('the agent is queued, saying why', status('agt_due') === 'queued' && lastStatusNote(db, 'agt_due') === SLOT_WAIT_NOTE, `${status('agt_due')}: ${lastStatusNote(db, 'agt_due')}`);
  runs.at(-1)?.finish();
  check('a freed slot goes to it, in its own session', await until(() => runs.length === beforeDue + 1 && runs.at(-1)?.options.resume === 'sess_due'), `${runs.length - beforeDue} new run(s)`);
  check(
    'with the message, and none is left',
    (await until(() => said(runs.at(-1), 'the time has come: the release notes'))) && listScheduled(db).every((m) => m.agentId !== 'agt_due'),
    JSON.stringify(runs.at(-1)?.prompts),
  );
  await send('PATCH', '/api/settings', { settings: { [SLOTS_KEY]: String(limitWas) } });

  // ───────────────────────────────────────────────────────────────────────────
  for (const r of runs) r.finish();
  await until(() => sup.slots.used === 0);
  setAgentStatus(db, 'agt_worker', 'done');
  socket.close();
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 111 schedule: PASS — ${checks} checks: pause everything until a time, wake only what it paused, end by itself; messages at a time, held by a pause, refused or kept as they should; and (Amendment 157) messages queued until the agent is done, one per done turn; and (Amendment 168) a message due with every slot taken waits for one.\n`
      : `\nAmendment 111/157/167 schedule: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
