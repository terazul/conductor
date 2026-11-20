/**
 * Validator checks for Amendment 219 (and what it kept of 144): when a job settles done, the steps
 * its agents asked for run in order, commit → test → merge → push → clean up, each only if the one
 * before it worked or was off; the transcript and Needs You say what each came to.
 *
 * A real git repo with real worktrees in tmpdir, and a local bare repo as its origin; a fake SDK,
 * as in verify-folder.ts, whose runs end at once, so each job settles `done` through the
 * supervisor's own `#rollUpJob`. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-finish.ts
 * If interrupted: lsof -ti :7817 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Alert, Autonomy, BranchActionResult, BranchMergePreview, WhenDone } from '@conductor/shared';
import { build } from '../index.js';
import { migrate, openDb } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { alerts } from './alerts.js';
import { finishAlerts, finishJob, NO_TEST_COMMAND, recoverFinishes } from './finish.js';
import { DEFAULT_AUTONOMY, getAgent, getJob, insertAgent, insertJob, setJobStatus } from './store.js';
import { supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7817;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-finish-verify-${Date.now()}`);
const BARE = `${ROOT}-origin.git`;
const OTHER = `${ROOT}-other`;
const OLD_DB = `${ROOT}-old.db`;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

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
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
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
  for (const p of [ROOT, BARE, OTHER, OLD_DB]) rmSync(p, { recursive: true, force: true });
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
  const steps = (whenDone: WhenDone): Autonomy => ({ ...DEFAULT_AUTONOMY, whenDone });
  const setTest = (testCommand: string | null) => send<{ project?: { testCommand?: string | null } }>('PATCH', `/api/projects/${projectId}`, { testCommand });

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
  const run = async (id: string, autonomy: Autonomy, opts: { isolation?: 'worktree' | 'in_place'; name?: string; said?: string } = {}): Promise<void> => {
    const isolation = opts.isolation ?? 'worktree';
    const path = isolation === 'worktree' ? wt(id) : ROOT;
    const branch = isolation === 'worktree' ? `conductor/${id}` : 'main';
    insertJob(db, { id, projectId, prompt: `work ${id}\nsecond line`, isolation, worktreePath: path, branch, status: 'queued', budgetUsd: null, ...(opts.name ? { name: opts.name } : {}) });
    insertAgent(db, {
      id: `agt_${id}`, jobId: id, projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'queued',
      blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy,
    });
    if (opts.said) eventLog().emit({ projectId, jobId: id, agentId: `agt_${id}` }, { kind: 'text', text: opts.said });
    sup.pump();
    await until(() => getJob(db, id)?.status === 'done' || getJob(db, id) === undefined);
    await sup.finishing(id);
    await settle(50);
  };
  const cardFor = (id: string, kind: Alert['kind']): Alert | undefined => alerts().list().find((a) => a.kind === kind && a.jobId === id);
  const eventsOf = (agentId: string): { kind: string; text?: string }[] =>
    (db.prepare('SELECT payload FROM events WHERE agent_id = ? ORDER BY seq').all(agentId) as { payload: string }[]).map((r) => JSON.parse(r.payload));
  const noteOf = (agentId: string): string | undefined =>
    eventsOf(agentId).filter((e) => e.kind === 'user_text' && e.text?.startsWith('When done:')).at(-1)?.text;
  const finishRows = (id: string): number => (db.prepare('SELECT COUNT(*) AS n FROM job_finishes WHERE job_id = ?').get(id) as { n: number }).n;
  const kept = (id: string): boolean => getJob(db, id)?.status === 'done' && getAgent(db, `agt_${id}`) !== undefined;
  const short = (ref: string, cwd = ROOT): string => git(cwd, 'rev-parse', '--short=7', ref);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the setting: whenDone, read from the old mergeWhenDone too');
  insertJob(db, { id: 'job_set', projectId, prompt: 'x', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'done', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_set', jobId: 'job_set', projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
  });
  const whenDoneOf = () => JSON.stringify(getAgent(db, 'agt_set')?.autonomy.whenDone);
  const on1 = await send<{ autonomy: Autonomy }>('POST', '/api/agents/agt_set/autonomy', { autonomy: { whenDone: { commit: true, push: true, bogus: true, merge: 'yes' } } });
  check('POST autonomy { whenDone } keeps the steps that are true, the rest of autonomy kept', on1.status === 200 && whenDoneOf() === '{"commit":true,"push":true}' && getAgent(db, 'agt_set')?.autonomy.mode === DEFAULT_AUTONOMY.mode, JSON.stringify(on1.body));
  await send('POST', '/api/agents/agt_set/autonomy', { autonomy: { whenDone: {} } });
  check('{ whenDone: {} } turns them all off (absent)', getAgent(db, 'agt_set')?.autonomy.whenDone === undefined, whenDoneOf());
  await send('POST', '/api/agents/agt_set/autonomy', { autonomy: { mergeWhenDone: true } });
  check('POST { mergeWhenDone: true } still means merge + clean up', whenDoneOf() === '{"merge":true,"cleanup":true}', whenDoneOf());
  const stored = (db.prepare('SELECT autonomy FROM agents WHERE id = ?').get('agt_set') as { autonomy: string }).autonomy;
  check('and what is written is whenDone, never mergeWhenDone', !stored.includes('mergeWhenDone') && stored.includes('"whenDone"'), stored);
  db.prepare('UPDATE agents SET autonomy = ? WHERE id = ?').run(JSON.stringify({ ...DEFAULT_AUTONOMY, mergeWhenDone: true }), 'agt_set');
  check('a row stored before this, { mergeWhenDone: true }, reads as merge + clean up', whenDoneOf() === '{"merge":true,"cleanup":true}' && !('mergeWhenDone' in (getAgent(db, 'agt_set')?.autonomy ?? {})), whenDoneOf());
  const tc = await setTest('  echo ok  ');
  check('PATCH /api/projects/:id { testCommand } sets it, trimmed', tc.status === 200 && tc.body.project?.testCommand === 'echo ok', JSON.stringify(tc.body));
  const tcBad = await setTest(42 as unknown as string);
  check('and a test command that is not a string is refused', tcBad.status === 400, `${tcBad.status}`);
  await setTest(null);
  check('null clears it', (db.prepare('SELECT test_command AS t FROM projects WHERE id = ?').get(projectId) as { t: string | null }).t === null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · commit alone');
  prepare('job_cm', {});
  writeFileSync(join(wt('job_cm'), 'new.txt'), 'uncommitted\n');
  await run('job_cm', steps({ commit: true }), { name: 'Tidy the readme', said: 'Added new.txt for the check.\nAnd more.' });
  const cmSubject = git(ROOT, 'log', '-1', '--format=%s', 'conductor/job_cm');
  check('what was left uncommitted is committed on the job branch', git(ROOT, 'show', 'conductor/job_cm:new.txt') === 'uncommitted' && git(wt('job_cm'), 'status', '--porcelain') === '');
  check('with "<job name> — <first line of the last reply>"', cmSubject === 'Tidy the readme — Added new.txt for the check.', cmSubject);
  check('the note says so, with the sha', noteOf('agt_job_cm') === `When done: committed ${short('conductor/job_cm')}.`, noteOf('agt_job_cm'));
  check('main did not move, and the job, folder and branch stay', !gitOk(ROOT, 'merge-base', '--is-ancestor', 'conductor/job_cm', 'main') && kept('job_cm') && existsSync(wt('job_cm')));
  const cmCard = cardFor('job_cm', 'finished');
  check('Needs You still asks "merge into main?", the commit listed', cmCard?.steps?.join() === `committed ${short('conductor/job_cm')}` && cmCard.stoppedAt === undefined, JSON.stringify(cmCard));
  prepare('job_cm2', {});
  await run('job_cm2', steps({ commit: true }), { said: 'x'.repeat(200) });
  check('nothing uncommitted: skipped, not failed', noteOf('agt_job_cm2') === 'When done: nothing to commit.' && cardFor('job_cm2', 'merged')?.stoppedAt === undefined, noteOf('agt_job_cm2'));
  prepare('job_cm3', {});
  writeFileSync(join(wt('job_cm3'), 'long.txt'), 'x\n');
  await run('job_cm3', steps({ commit: true }), { said: 'y'.repeat(200) });
  const long = git(ROOT, 'log', '-1', '--format=%s', 'conductor/job_cm3');
  check('the message is cut to 72 characters, from the prompt’s first line when there is no name', long.length === 72 && long.startsWith('work job_cm3 — yyy') && long.endsWith('…'), `${long.length} ${long}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · test alone');
  await setTest(`test "$(pwd -P)" = "${realpathSync(ROOT)}/.conductor/wt/job_t1" && echo tests ran here`);
  prepare('job_t1', { 't1.txt': 't1\n' });
  await run('job_t1', steps({ test: true }));
  check('a command exiting 0 in the job’s worktree passes', /^When done: tests passed \(test .*, \d+s\)\.$/.test(noteOf('agt_job_t1') ?? ''), noteOf('agt_job_t1'));
  await setTest(null);
  prepare('job_t0', { 't0.txt': 't0\n' });
  await run('job_t0', steps({ test: true, merge: true }));
  check('no test command: Test fails with the sentence, and merge doesn’t run', noteOf('agt_job_t0') === `When done: didn't test: ${NO_TEST_COMMAND}. Merge didn't run.`, noteOf('agt_job_t0'));
  check('and the card says it stopped at test', cardFor('job_t0', 'finished')?.cause === 'stopped at test', JSON.stringify(cardFor('job_t0', 'finished')));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · a failing test stops merge, push and clean up, and keeps the tail');
  await setTest('for i in $(seq 1 300); do echo "line $i"; done; exit 3');
  prepare('job_tf', { 'tf.txt': 'tf\n' });
  const mainTf = git(ROOT, 'rev-parse', 'main');
  await run('job_tf', steps({ test: true, merge: true, push: true, cleanup: true }));
  check('the note: failed with its exit code, and what didn’t run', /^When done: tests failed \(for i in .*, exit 3, \d+s\)\. Merge, push and clean up didn't run\.$/.test(noteOf('agt_job_tf') ?? ''), noteOf('agt_job_tf'));
  check('main did not move; the job, its folder and its branch stay', git(ROOT, 'rev-parse', 'main') === mainTf && kept('job_tf') && existsSync(wt('job_tf')) && hasBranch('conductor/job_tf'));
  const tfCard = cardFor('job_tf', 'finished');
  const tail = tfCard?.testOutput?.split('\n') ?? [];
  check('the card: stopped at test, offering the merge, with the last 200 lines', tfCard?.stoppedAt === 'test' && tfCard.into === 'main' && tail.length === 200 && tail[0] === 'line 101' && tail[199] === 'line 300', `${tfCard?.stoppedAt} ${tail.length} ${tail[0]} ${tail.at(-1)}`);
  await setTest(null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · merge alone: clean, conflicting, and main’s checkout dirty');
  prepare('job_m', { 'm.txt': 'm\n' });
  await run('job_m', steps({ merge: true }));
  check('merged into main', git(ROOT, 'show', 'main:m.txt') === 'm' && git(ROOT, 'log', '-1', '--format=%s', 'main') === "Merge branch 'conductor/job_m' into main");
  check('the note names the sha', noteOf('agt_job_m') === `When done: merged into main as ${short('main')}.`, noteOf('agt_job_m'));
  const mCard = cardFor('job_m', 'merged');
  check('Needs You has the information card, listing the steps; no "merge?" card', mCard?.cause === 'when done' && mCard.steps?.join() === `merged into main as ${short('main')}` && mCard.cleaned === false && !cardFor('job_m', 'finished'), JSON.stringify(mCard));
  check('the job, its agent, its folder and its branch stay', kept('job_m') && existsSync(wt('job_m')) && hasBranch('conductor/job_m'));

  prepare('job_b', { 'c.txt': 'from b\n' });
  writeFileSync(join(ROOT, 'c.txt'), 'main moved on\n');
  git(ROOT, 'commit', '-q', '-am', 'main edits c');
  const mainB = git(ROOT, 'rev-parse', 'main');
  await run('job_b', steps({ merge: true, cleanup: true }));
  const conflictCard = cardFor('job_b', 'finished');
  check('a conflict: the offer card, saying why and naming the file', conflictCard?.stoppedAt === 'merge' && /would conflict with main in c\.txt/.test(conflictCard.detail ?? ''), JSON.stringify(conflictCard));
  check('main did not move, and nothing was cleaned up', git(ROOT, 'rev-parse', 'main') === mainB && existsSync(wt('job_b')) && hasBranch('conductor/job_b'));
  check('the note says clean up didn’t run', /^When done: didn't merge: .*c\.txt\. Clean up didn't run\.$/.test(noteOf('agt_job_b') ?? ''), noteOf('agt_job_b'));

  prepare('job_g', { 'g.txt': 'g\n' });
  writeFileSync(join(ROOT, 'README.md'), '# finish verify, edited\n');
  await run('job_g', steps({ merge: true }));
  check('main’s checkout has changes: the card, with the reason the merge would give', /main's checkout has changes/.test(cardFor('job_g', 'finished')?.detail ?? ''), JSON.stringify(cardFor('job_g', 'finished')));
  git(ROOT, 'checkout', '-q', '--', 'README.md');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · push: no remote, then to a local bare repo');
  prepare('job_p0', { 'p0.txt': 'p0\n' });
  await run('job_p0', steps({ push: true }));
  check('no remote: Push fails with a clear sentence', noteOf('agt_job_p0') === "When done: didn't push conductor/job_p0: the project has no remote called origin to push to.", noteOf('agt_job_p0'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE]);
  git(ROOT, 'remote', 'add', 'origin', BARE);
  git(ROOT, 'push', '-q', 'origin', 'main');
  const bare = (ref: string): string => (gitOk(BARE, 'rev-parse', '--verify', '--quiet', ref) ? git(BARE, 'rev-parse', ref) : '');

  prepare('job_p1', { 'p1.txt': 'p1\n' });
  await run('job_p1', steps({ merge: true, push: true }));
  check('after a merge, the target is pushed', bare('main') === git(ROOT, 'rev-parse', 'main') && git(ROOT, 'show', 'main:p1.txt') === 'p1');
  check('the note says merged, then pushed main', noteOf('agt_job_p1') === `When done: merged into main as ${short('main')} · pushed main to origin.`, noteOf('agt_job_p1'));
  check('the job branch was not pushed', bare('refs/heads/conductor/job_p1') === '');

  prepare('job_p2', { 'p2.txt': 'p2\n' });
  const mainP2 = git(ROOT, 'rev-parse', 'main');
  await run('job_p2', steps({ push: true }));
  check('with merge off, the job branch is pushed, and main is not', bare('refs/heads/conductor/job_p2') === git(ROOT, 'rev-parse', 'conductor/job_p2') && bare('main') === mainP2, noteOf('agt_job_p2'));
  check('and the card still offers the merge', cardFor('job_p2', 'finished') !== undefined);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · all five, in order');
  await setTest('echo all good');
  prepare('job_all', {});
  writeFileSync(join(wt('job_all'), 'all.txt'), 'all\n');
  await run('job_all', steps({ commit: true, test: true, merge: true, push: true, cleanup: true }), { name: 'Everything', said: 'All done.' });
  const allMerge = short('main');
  const allNote = noteOf('agt_job_all') ?? '';
  check(
    'one note, each step in order',
    new RegExp(`^When done: committed [0-9a-f]{7} · tests passed \\(echo all good, \\d+s\\) · merged into main as ${allMerge} · pushed main to origin · cleaned up the folder and branch\\.$`).test(allNote),
    allNote,
  );
  check('main has the commit, origin has main', git(ROOT, 'show', 'main:all.txt') === 'all' && bare('main') === git(ROOT, 'rev-parse', 'main'));
  check('the folder and branch are gone; the job stays done, with its agent', !existsSync(wt('job_all')) && !hasBranch('conductor/job_all') && kept('job_all'));
  const allCard = cardFor('job_all', 'merged');
  check('the information card lists all five, cleaned', allCard?.steps?.length === 5 && allCard.cleaned === true && allCard.stoppedAt === undefined && allCard.agentIds.join() === 'agt_job_all', JSON.stringify(allCard));
  await setTest(null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8 · a rejected push');
  execFileSync('git', ['clone', '-q', BARE, OTHER]);
  writeFileSync(join(OTHER, 'elsewhere.txt'), 'pushed from elsewhere\n');
  git(OTHER, 'add', '.');
  git(OTHER, 'commit', '-q', '-m', 'elsewhere');
  git(OTHER, 'push', '-q', 'origin', 'main');
  const remoteMain = bare('main');
  prepare('job_pr', { 'pr.txt': 'pr\n' });
  await run('job_pr', steps({ merge: true, push: true, cleanup: true }));
  const prNote = noteOf('agt_job_pr') ?? '';
  check('the push fails with git’s sentence, and clean up doesn’t run', /didn't push: the push was rejected — .*rejected.*\. Clean up didn't run\.$/.test(prNote) && !prNote.includes('hint:'), prNote);
  check('origin was not forced', bare('main') === remoteMain);
  const prCard = cardFor('job_pr', 'merged');
  check('the card: merged, stopped at push; nothing cleaned up', prCard?.stoppedAt === 'push' && prCard.cause === 'stopped at push' && prCard.cleaned === false && existsSync(wt('job_pr')), JSON.stringify(prCard));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · clean up: keeps the job and its agents; refuses an unmerged branch');
  prepare('job_cu', { 'cu.txt': 'cu\n' });
  await run('job_cu', steps({ cleanup: true }));
  check('an unmerged branch is refused, with the reason', noteOf('agt_job_cu') === "When done: didn't clean up: conductor/job_cu isn't merged into main (1 commit main doesn't have), so its folder and branch were kept.", noteOf('agt_job_cu'));
  check('its folder and branch stay', existsSync(wt('job_cu')) && hasBranch('conductor/job_cu'));
  prepare('job_h', { 'h.txt': 'h\n' });
  writeFileSync(join(wt('job_h'), 'scratch.txt'), 'left behind, untracked\n');
  await run('job_h', steps({ merge: true, cleanup: true }));
  check('merged, then an untracked file stops the clean up, saying so', git(ROOT, 'show', 'main:h.txt') === 'h' && /didn't clean up: .*1 uncommitted file/.test(noteOf('agt_job_h') ?? '') && existsSync(join(wt('job_h'), 'scratch.txt')), noteOf('agt_job_h'));
  prepare('job_cl', { 'cl.txt': 'cl\n' });
  await run('job_cl', steps({ merge: true, cleanup: true }));
  check('merge + clean up: folder and branch gone, `git branch -d`', !existsSync(wt('job_cl')) && !hasBranch('conductor/job_cl') && git(ROOT, 'show', 'main:cl.txt') === 'cl');
  check('the job and its agent are kept, still done; the transcript too', kept('job_cl') && eventsOf('agt_job_cl').length > 0);
  check('the note no longer says "this transcript stays"', !(noteOf('agt_job_cl') ?? '').includes('transcript'), noteOf('agt_job_cl'));
  const del = await send<BranchActionResult>('DELETE', `/api/jobs/job_cl`);
  check('Remove still deletes it', del.status < 300 && getJob(db, 'job_cl') === undefined, `${del.status}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n10 · a message after the clean up puts the folder back, and is sent');
  prepare('job_rs', { 'rs.txt': 'rs\n' });
  await run('job_rs', steps({ merge: true, cleanup: true }));
  check('(cleaned up)', !existsSync(wt('job_rs')) && kept('job_rs'));
  const before = launched;
  let answer: string;
  try {
    answer = sup.sendMessage('agt_job_rs', 'carry on, please');
  } catch (err) {
    answer = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  check('sendMessage takes it, not refused', answer === 'resumed', answer);
  check('the folder is back, on a new branch of the same name from main', (await until(() => existsSync(wt('job_rs')))) && hasBranch('conductor/job_rs') && git(ROOT, 'rev-parse', 'conductor/job_rs') === git(ROOT, 'rev-parse', 'main'));
  check('and the agent ran with the message', await until(() => launched > before));
  check(
    'its transcript says the folder was put back',
    eventsOf('agt_job_rs').some((e) => e.kind === 'user_text' && /was cleaned up when the job was done, and has been put back from main, on a new conductor\/job_rs/.test(e.text ?? '')),
  );
  await until(() => getJob(db, 'job_rs')?.status === 'done');
  await sup.finishing('job_rs');
  await settle(80);

  prepare('job_gone', { 'gone.txt': 'g\n' });
  await run('job_gone', DEFAULT_AUTONOMY);
  rmSync(wt('job_gone'), { recursive: true, force: true });
  let refused = '';
  try {
    sup.sendMessage('agt_job_gone', 'hello?');
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check('a folder that went missing by itself is still refused, not put back', refused.length > 0 && !existsSync(wt('job_gone')), refused);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · what gets no steps');
  await run('job_ip', steps({ commit: true, merge: true, cleanup: true }), { isolation: 'in_place' });
  check('a job in the project folder: no row, no note, no card', finishRows('job_ip') === 0 && noteOf('agt_job_ip') === undefined && !cardFor('job_ip', 'finished') && !cardFor('job_ip', 'merged'));
  prepare('job_off', { 'off.txt': 'off\n' });
  await run('job_off', DEFAULT_AUTONOMY);
  const offCard = cardFor('job_off', 'finished');
  check('none on, ahead: the plain "merge into main?" card, as before', offCard !== undefined && offCard.detail === undefined && offCard.steps === undefined && noteOf('agt_job_off') === undefined, JSON.stringify(offCard));
  const pre = await send<BranchMergePreview>('GET', `${URL}/preview?branch=${encodeURIComponent('conductor/job_off')}&into=main`);
  const cardMerge = await send<BranchActionResult>('POST', URL, { action: 'merge', branch: 'conductor/job_off' });
  check('the card’s preview and merge are the Branches ones', pre.body.reason === null && cardMerge.status === 200 && cardMerge.body.ok, JSON.stringify(cardMerge.body).slice(0, 160));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n12 · the same finish twice runs once');
  prepare('job_tw', { 'tw.txt': 'tw\n' });
  insertJob(db, { id: 'job_tw', projectId, prompt: 'twice', isolation: 'worktree', worktreePath: wt('job_tw'), branch: 'conductor/job_tw', status: 'working', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_job_tw', jobId: 'job_tw', projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: steps({ merge: true }),
  });
  setJobStatus(db, 'job_tw', 'done');
  const forget = async (): Promise<void> => undefined;
  const [one, two] = await Promise.all([finishJob(db, 'job_tw', forget), finishJob(db, 'job_tw', forget)]);
  check('two at once: one merges, the other says it already ran', one.outcome === 'merged' && two.outcome === 'none' && two.why === 'this finish already ran', `${JSON.stringify(one)} ${JSON.stringify(two)}`);
  const again = await finishJob(db, 'job_tw', forget);
  check('and later (as after a restart, from the row): still once', again.outcome === 'none' && finishRows('job_tw') === 1, JSON.stringify(again));
  check('main has one merge of it', git(ROOT, 'log', '--format=%s', 'main').split('\n').filter((s) => s.includes('conductor/job_tw')).length === 1);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · a finish the daemon stopped in the middle of');
  prepare('job_int', { 'int.txt': 'int\n' });
  insertJob(db, { id: 'job_int', projectId, prompt: 'interrupted', isolation: 'worktree', worktreePath: wt('job_int'), branch: 'conductor/job_int', status: 'done', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_job_int', jobId: 'job_int', projectId, role: 'builder', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: steps({ commit: true, test: true, merge: true }),
  });
  db.prepare(
    `INSERT INTO job_finishes (job_id, project_id, kind, branch, target, ahead, agent_ids, at, steps, state, current_step)
     VALUES ('job_int', ?, 'offer', 'conductor/job_int', 'main', 1, '["agt_job_int"]', ?, ?, 'running', 'test')`,
  ).run(projectId, new Date().toISOString(), JSON.stringify([{ step: 'commit', outcome: 'skipped', said: 'nothing to commit' }]));
  check('while it runs, it has no card', !cardFor('job_int', 'finished'));
  const mainInt = git(ROOT, 'rev-parse', 'main');
  const recovered = recoverFinishes(db);
  await settle(50);
  const intCard = cardFor('job_int', 'finished');
  check('on boot it is recorded "interrupted at test"', recovered === 1 && intCard?.stoppedAt === 'test' && intCard.steps?.at(-1) === 'interrupted at test', `${recovered} ${JSON.stringify(intCard)}`);
  check('with the offer card, saying nothing was run again', /nothing was run again/.test(intCard?.detail ?? '') && intCard?.cause === 'stopped at test');
  check('the transcript says so', /^When done: nothing to commit · interrupted at test: the daemon stopped while test ran; nothing was run again\.$/.test(noteOf('agt_job_int') ?? ''), noteOf('agt_job_int'));
  check('nothing was re-run: main did not move', git(ROOT, 'rev-parse', 'main') === mainInt);
  check('a second boot finds nothing', recoverFinishes(db) === 0);
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'session.ts'), 'utf8');
  check('boot calls it, after reconcile', /sup\.reconcile\(\);[\s\S]{0,400}recoverFinishes\(db\)/.test(src));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n14 · migration 390 on an older database');
  const old = new DatabaseSync(OLD_DB);
  old.exec('PRAGMA foreign_keys = ON');
  old.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((x) => x < '390')) {
    old.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    old.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
  }
  const colsOf = (t: string): string[] => (old.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  check('(before: no test_command, no steps)', !colsOf('projects').includes('test_command') && !colsOf('job_finishes').includes('steps'));
  old.prepare(
    `INSERT INTO job_finishes (job_id, project_id, kind, branch, target, ahead, agent_ids, sha, cleaned, at)
     VALUES ('job_old', 'prj_old', 'merged', 'conductor/job_old', 'main', 1, '["agt_old"]', 'abcdef1234567', 1, '2026-01-01T00:00:00.000Z')`,
  ).run();
  migrate(old);
  check('390 adds projects.test_command', colsOf('projects').includes('test_command'));
  check('and job_finishes’ steps, stopped_at, test_output, state, current_step, restored_at', ['steps', 'stopped_at', 'test_output', 'state', 'current_step', 'restored_at'].every((c) => colsOf('job_finishes').includes(c)), colsOf('job_finishes').join());
  const oldCard = finishAlerts(old).find((a) => a.jobId === 'job_old');
  check('an Amendment 144 row still reads as its card, with no steps', oldCard?.kind === 'merged' && oldCard.cause === 'merged and cleaned up' && oldCard.steps === undefined, JSON.stringify(oldCard));
  check('recorded once: migrate again does nothing', (() => { migrate(old); return (old.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE name = '390_finish_steps.sql'`).get() as { n: number }).n === 1; })());
  old.close();

  // ───────────────────────────────────────────────────────────────────────────
  await until(() => sup.slots.used === 0);
  await app.close();
  for (const p of [ROOT, BARE, OTHER, OLD_DB]) rmSync(p, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 219 finish: PASS — ${checks} checks: when a job is done its agents' steps run in order, commit, test, merge, push, clean up, each only after the one before worked or was off; a failing or missing test stops the rest with the output's tail on the card; the push goes to origin and is never forced; the clean-up keeps the job and its agents and refuses an unmerged branch, and a message afterwards puts the folder back; the old mergeWhenDone reads as merge + clean up; a finish runs once, and one a stop cut short is recorded interrupted on boot.\n`
      : `\nAmendment 219 finish: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  for (const p of [ROOT, BARE, OTHER, OLD_DB]) rmSync(p, { recursive: true, force: true });
  process.exit(1);
});
