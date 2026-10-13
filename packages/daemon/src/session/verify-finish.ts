/**
 * Validator checks for Amendment 144: when a job finishes, its branch is merged and cleaned up
 * if its agent asked for that and the merge is clean, and Needs You asks otherwise.
 *
 * A real git repo with real worktrees in tmpdir; a fake SDK, as in verify-folder.ts, whose runs
 * end at once, so each job settles `done` through the supervisor's own `#rollUpJob`. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-finish.ts
 * If interrupted: lsof -ti :7817 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Alert, Autonomy, BranchActionResult, BranchMergePreview } from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { alerts } from './alerts.js';
import { DEFAULT_AUTONOMY, getAgent, getJob, insertAgent, insertJob } from './store.js';
import { supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7817;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-finish-verify-${Date.now()}`);

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
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle(20);
  }
  return true;
}

// ── a fake SDK: every run ends as soon as it starts ─────────────────────────

let launched = 0;
function fakeQuery({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  launched++;
  const sessionId = options?.resume ?? `sess_fake_${launched}`;
  void (async () => {
    if (typeof prompt !== 'string') for await (const _ of prompt) void _;
  })();
  async function* messages(): AsyncGenerator<unknown> {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sessionId };
  }
  return Object.assign(messages(), { interrupt: async () => undefined, setModel: async () => undefined }) as unknown as Query;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=v@example.invalid', '-c', 'user.name=v', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const gitOk = (cwd: string, ...args: string[]): boolean => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};
const hasBranch = (name: string): boolean => gitOk(ROOT, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`);

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# finish verify\n');
  writeFileSync(join(ROOT, 'c.txt'), 'base\n');
  writeFileSync(join(ROOT, '.gitignore'), '.conductor/\n');
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'add', '.');
  git(ROOT, 'commit', '-q', '-m', 'init');

  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();

  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'finish-verify' });
  const projectId = added.body.project.id;
  const URL = `/api/projects/${projectId}/branches`;
  const wt = (id: string) => join(ROOT, '.conductor', 'wt', id);
  const ON: Autonomy = { ...DEFAULT_AUTONOMY, mergeWhenDone: true };

  /** A job on its own worktree and branch, with `commits` files committed there. */
  const prepare = (id: string, commits: Record<string, string>): void => {
    git(ROOT, 'worktree', 'add', '-q', '-b', `conductor/${id}`, wt(id), 'main');
    for (const [file, text] of Object.entries(commits)) {
      writeFileSync(join(wt(id), file), text);
      git(wt(id), 'add', '--', file);
      git(wt(id), 'commit', '-q', '-m', `${id}: ${file}`);
    }
  };
  /** Start its one agent and wait until the job has settled and its finish has run. */
  const run = async (id: string, autonomy: Autonomy, isolation: 'worktree' | 'in_place' = 'worktree'): Promise<void> => {
    const path = isolation === 'worktree' ? wt(id) : ROOT;
    const branch = isolation === 'worktree' ? `conductor/${id}` : 'main';
    insertJob(db, { id, projectId, prompt: `work ${id}`, isolation, worktreePath: path, branch, status: 'queued', budgetUsd: null });
    insertAgent(db, {
      id: `agt_${id}`, jobId: id, projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'queued',
      blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy,
    });
    sup.pump();
    await until(() => getJob(db, id)?.status === 'done' || getJob(db, id) === undefined);
    await sup.finishing(id);
    await settle(50);
  };
  const cardFor = (id: string, kind: Alert['kind']): Alert | undefined => alerts().list().find((a) => a.kind === kind && a.jobId === id);
  const eventsOf = (agentId: string): { kind: string; text?: string }[] =>
    (db.prepare('SELECT payload FROM events WHERE agent_id = ? ORDER BY seq').all(agentId) as { payload: string }[]).map((r) => JSON.parse(r.payload));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the setting is the agent’s own');
  insertJob(db, { id: 'job_set', projectId, prompt: 'x', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_set', jobId: 'job_set', projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
  });
  const turnOn = await send<{ autonomy: Autonomy }>('POST', '/api/agents/agt_set/autonomy', { autonomy: { mergeWhenDone: true } });
  check('POST autonomy { mergeWhenDone: true } turns it on, the rest kept', turnOn.status === 200 && getAgent(db, 'agt_set')?.autonomy.mergeWhenDone === true && getAgent(db, 'agt_set')?.autonomy.mode === DEFAULT_AUTONOMY.mode, JSON.stringify(turnOn.body));
  await send('POST', '/api/agents/agt_set/autonomy', { autonomy: { mergeWhenDone: false } });
  check('and false turns it off (left out, as absent)', getAgent(db, 'agt_set')?.autonomy.mergeWhenDone === undefined, JSON.stringify(getAgent(db, 'agt_set')?.autonomy));
  await send('POST', '/api/agents/agt_set/autonomy', { autonomy: { mergeWhenDone: 'yes' } });
  check('anything but true is off', getAgent(db, 'agt_set')?.autonomy.mergeWhenDone === undefined);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · on, and the merge is clean: merged, then the job, its folder and branch removed');
  prepare('job_a', { 'a.txt': 'from a\n' });
  const mainBefore = git(ROOT, 'rev-parse', 'main');
  await run('job_a', ON);
  const merge = git(ROOT, 'log', '-1', '--format=%H %P %s', 'main').split(' ');
  check('main has a merge commit of the job branch', merge[1] === mainBefore && merge.slice(3).join(' ') === "Merge branch 'conductor/job_a' into main", merge.join(' '));
  check('a.txt is in main', git(ROOT, 'show', 'main:a.txt') === 'from a');
  check('the job row is gone, and its agent', getJob(db, 'job_a') === undefined && getAgent(db, 'agt_job_a') === undefined);
  check('its folder is gone', !existsSync(wt('job_a')));
  check('its branch is gone', !hasBranch('conductor/job_a'));
  const notes = eventsOf('agt_job_a');
  check('its transcript is kept', notes.length > 0);
  check(
    'with a note saying what was merged and removed, and the merge sha',
    notes.some((e) => e.kind === 'user_text' && e.text?.includes(`was merged into main as ${merge[0]!.slice(0, 7)}`) && e.text.includes('have been removed; this transcript stays')),
    JSON.stringify(notes.filter((e) => e.kind === 'user_text')),
  );
  const info = cardFor('job_a', 'merged');
  check('Needs You has the information card, with the sha, cleaned', info?.cause === 'merged and cleaned up' && info.sha === merge[0] && info.cleaned === true && info.branch === 'conductor/job_a' && info.into === 'main', JSON.stringify(info));
  check('and no "merge?" card for it', !cardFor('job_a', 'finished'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · on, but it would conflict: the card, and nothing removed');
  prepare('job_b', { 'c.txt': 'from b\n' });
  writeFileSync(join(ROOT, 'c.txt'), 'main moved on\n');
  git(ROOT, 'commit', '-q', '-am', 'main edits c');
  const mainB = git(ROOT, 'rev-parse', 'main');
  await run('job_b', ON);
  const conflictCard = cardFor('job_b', 'finished');
  check('Needs You asks "merge into main?"', conflictCard?.into === 'main' && conflictCard.branch === 'conductor/job_b' && conflictCard.ahead === 1, JSON.stringify(conflictCard));
  check('saying why it wasn’t done by itself: the conflict, naming the file', /would conflict with main in c\.txt/.test(conflictCard?.detail ?? ''), conflictCard?.detail);
  check('main did not move', git(ROOT, 'rev-parse', 'main') === mainB);
  check('the job, its folder and its branch are all there', getJob(db, 'job_b') !== undefined && existsSync(wt('job_b')) && hasBranch('conductor/job_b'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · on, but main’s checkout has changes: the card, saying so');
  prepare('job_g', { 'g.txt': 'g\n' });
  writeFileSync(join(ROOT, 'README.md'), '# finish verify, edited\n');
  await run('job_g', ON);
  const dirtyCard = cardFor('job_g', 'finished');
  check('the card, with the reason the merge would give', /main's checkout has changes/.test(dirtyCard?.detail ?? ''), JSON.stringify(dirtyCard));
  check('nothing merged, nothing removed', !git(ROOT, 'log', '--format=%s', 'main').includes("conductor/job_g") && getJob(db, 'job_g') !== undefined && existsSync(wt('job_g')));
  git(ROOT, 'checkout', '-q', '--', 'README.md');

  console.log('\n4b · on, merged, but the clean-up is refused: it stops there and says why');
  prepare('job_h', { 'h.txt': 'h\n' });
  writeFileSync(join(wt('job_h'), 'scratch.txt'), 'left behind, untracked\n');
  await run('job_h', ON);
  const half = cardFor('job_h', 'merged');
  check('merged into main', git(ROOT, 'show', 'main:h.txt') === 'h');
  check('the information card says merged, not cleaned up, and why', half?.cause === 'merged' && half.cleaned === false && /uncommitted file/.test(half.detail ?? ''), JSON.stringify(half));
  check('the job, its folder (with the untracked file) and its branch are all still there', getJob(db, 'job_h') !== undefined && existsSync(join(wt('job_h'), 'scratch.txt')) && hasBranch('conductor/job_h'));
  check('no "merge?" card for what is merged already', !cardFor('job_h', 'finished'));
  check(
    "its agent's transcript says it wasn't cleaned up",
    eventsOf('agt_job_h').some((e) => e.kind === 'user_text' && /It was not cleaned up: .*uncommitted/.test(e.text ?? '')),
  );

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · off: the card, and the card’s "merge"');
  prepare('job_c', { 'cc.txt': 'c\n' });
  await run('job_c', DEFAULT_AUTONOMY);
  const offCard = cardFor('job_c', 'finished');
  check('Needs You asks "merge into main?", with no reason (nothing was tried)', offCard !== undefined && offCard.detail === undefined && offCard.agentIds.join() === 'agt_job_c', JSON.stringify(offCard));
  check('nothing moved', getJob(db, 'job_c') !== undefined && existsSync(wt('job_c')) && hasBranch('conductor/job_c'));
  const pre = await send<BranchMergePreview>('GET', `${URL}/preview?branch=${encodeURIComponent('conductor/job_c')}&into=main`);
  check('the card’s preview: clean, nothing refusing it', pre.status === 200 && pre.body.reason === null && pre.body.conflicts?.length === 0, JSON.stringify(pre.body));
  const merged = await send<BranchActionResult>('POST', URL, { action: 'merge', branch: 'conductor/job_c' });
  check('"merge" is the Branches merge: 200, merged', merged.status === 200 && merged.body.ok && merged.body.merged.join() === 'conductor/job_c', JSON.stringify(merged.body).slice(0, 200));
  check('the job, its folder and its branch stay, so its agent can still be messaged', getJob(db, 'job_c') !== undefined && existsSync(wt('job_c')) && hasBranch('conductor/job_c'));
  const dismissed = await send<{ dismissed?: boolean }>('POST', `/api/alerts/${encodeURIComponent(offCard!.id)}/dismiss`, {});
  check('and the card is put away', dismissed.status < 300 && !cardFor('job_c', 'finished'), `${dismissed.status} ${JSON.stringify(dismissed.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · off: the card’s "merge and clean up"');
  prepare('job_d', { 'd.txt': 'd\n' });
  await run('job_d', DEFAULT_AUTONOMY);
  const dCard = cardFor('job_d', 'finished');
  check('the card', dCard !== undefined);
  const m2 = await send<BranchActionResult>('POST', URL, { action: 'merge', branch: 'conductor/job_d' });
  const del = await send<BranchActionResult & { error?: string }>('POST', URL, { action: 'delete', branch: 'conductor/job_d', forgetJob: true });
  check('merge, then delete with forgetJob: both 200', m2.status === 200 && m2.body.ok && del.status === 200 && del.body.removed?.join() === 'conductor/job_d' && del.body.forgotJobs?.join() === 'job_d', `${JSON.stringify(m2.body).slice(0, 120)} ${JSON.stringify(del.body).slice(0, 200)}`);
  check('the job, its folder and its branch are gone', getJob(db, 'job_d') === undefined && !existsSync(wt('job_d')) && !hasBranch('conductor/job_d'));
  check('its transcript is kept', eventsOf('agt_job_d').length > 0);
  check('the card went with the job', !cardFor('job_d', 'finished'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · what gets no card');
  prepare('job_e', {});
  await run('job_e', ON);
  check('a job whose branch is not ahead: no card, nothing removed', !cardFor('job_e', 'finished') && !cardFor('job_e', 'merged') && getJob(db, 'job_e') !== undefined && existsSync(wt('job_e')));
  await run('job_ip', ON, 'in_place');
  check('a job in the project folder: no card', !cardFor('job_ip', 'finished') && !cardFor('job_ip', 'merged') && getJob(db, 'job_ip') !== undefined);
  check('the conflicting job still has its card', cardFor('job_b', 'finished') !== undefined);
  check('nothing was pushed: the repo has no remote, and none was added', git(ROOT, 'remote') === '');

  // ───────────────────────────────────────────────────────────────────────────
  await until(() => sup.slots.used === 0);
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 144 finish: PASS — ${checks} checks: the agent's "merge into main and clean up when done" merges a clean branch and removes the job, its folder and its branch, keeping the transcript with a note and saying so in Needs You; a conflict, a dirty main or the setting off asks instead, removing nothing; the card's merge keeps the job, and merge and clean up removes it.\n`
      : `\nAmendment 144 finish: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
