/**
 * Amendment 109 verify — the Branches API, end to end, against throwaway repos (ADR 0008 § Testing).
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/workspace/verify-branches.ts
 *
 * Needs no fixture. Everything it writes is under one folder in tmpdir(): a repo with a
 * bare `origin` beside it, a second clone of that origin (to make a push non-fast-forward),
 * and a folder that isn't a repo. All of it is removed at the end.
 *
 * If you interrupt it, the listener on 7811 stays up and the next run dies with
 * EADDRINUSE:  lsof -ti :7811 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BranchActionResult,
  BranchMergePreview,
  BranchesResponse,
  BranchInfo,
  ServerFrame,
} from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { DEFAULT_AUTONOMY, insertAgent, insertJob, insertProject } from '../session/store.js';
import { GitError, git } from './git.js';
import { resolveTarget } from './branches.js';
import { patchSettings } from '../settings.js';
import { branchTargetKey } from '@conductor/shared';

const PORT = 7811;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(label: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Reply<T> {
  status: number;
  body: T;
}
type Err = { error: string; detail?: string };

async function get<T>(path: string): Promise<Reply<T>> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(path: string, body: unknown): Promise<Reply<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

// ── scratch git, all inside ROOT ─────────────────────────────────────────────

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-branches-verify-')));
const REPO = join(ROOT, 'repo');
const ORIGIN = join(ROOT, 'origin.git');
const OTHER = join(ROOT, 'other');
const WT_ONE = join(ROOT, 'wt-one');
const WT_CLASH = join(ROOT, 'wt-clash');
const PLAIN = join(ROOT, 'not-a-repo');

/** Commits get one minute apart, so "oldest tip first" never ties on a second. */
let clock = Date.parse('2026-01-01T09:00:00Z');
function stamp(): Record<string, string> {
  clock += 60_000;
  const at = new Date(clock).toISOString();
  return { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Verify',
  GIT_AUTHOR_EMAIL: 'verify@example.invalid',
  GIT_COMMITTER_NAME: 'Verify',
  GIT_COMMITTER_EMAIL: 'verify@example.invalid',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY, ...stamp(), GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function shOk(cwd: string, ...args: string[]): boolean {
  try {
    sh(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function commitFile(cwd: string, file: string, text: string, subject: string): string {
  writeFileSync(join(cwd, file), text);
  sh(cwd, 'add', '--', file);
  sh(cwd, 'commit', '-q', '-m', subject);
  return sh(cwd, 'rev-parse', 'HEAD');
}

function onBranch(name: string, from = 'main'): void {
  sh(REPO, 'checkout', '-q', '-b', name, from);
}

// ── the scenario ─────────────────────────────────────────────────────────────

interface Fixture {
  base: string;
  oneTip: string;
}

function makeRepos(): Fixture {
  mkdirSync(PLAIN);
  sh(ROOT, 'init', '-q', '--bare', ORIGIN);
  sh(ROOT, 'init', '-q', '-b', 'main', REPO);
  sh(REPO, 'config', 'user.name', 'Verify');
  sh(REPO, 'config', 'user.email', 'verify@example.invalid');
  commitFile(REPO, 'a.txt', 'one\n', 'start');
  writeFileSync(join(REPO, 'conflict.txt'), 'base\n');
  const base = commitFile(REPO, 'two.txt', 'two\n', 'base');
  sh(REPO, 'remote', 'add', 'origin', ORIGIN);
  sh(REPO, 'push', '-q', '-u', 'origin', 'main');

  // feature/two: one commit, no worktree. Oldest tip of the lot.
  onBranch('feature/two', base);
  commitFile(REPO, 'two.txt', 'two, edited\n', 'edit two');

  // feature/one: two commits, then its own worktree with uncommitted work.
  onBranch('feature/one', base);
  commitFile(REPO, 'one.txt', 'first\n', 'one: first');
  const oneTip = commitFile(REPO, 'one.txt', 'first\nsecond\n', 'one: second');

  // Two branches that change conflict.txt differently: the second can't follow the first.
  onBranch('clash/a', base);
  commitFile(REPO, 'conflict.txt', 'from a\n', 'clash a');
  onBranch('clash/b', base);
  commitFile(REPO, 'conflict.txt', 'from b\n', 'clash b');

  // A job's branch with an agent working on it.
  onBranch('conductor/job_live', base);
  commitFile(REPO, 'live.txt', 'busy\n', 'live work');

  // The newest tip: merge_all must stop before reaching it.
  onBranch('late/after', base);
  commitFile(REPO, 'late.txt', 'late\n', 'late work');

  // main moves on after every branch forked, so each is one behind.
  sh(REPO, 'checkout', '-q', 'main');
  commitFile(REPO, 'a.txt', 'one\nmore\n', 'main moves on');

  sh(REPO, 'worktree', 'add', '-q', WT_ONE, 'feature/one');
  writeFileSync(join(WT_ONE, 'one.txt'), 'first\nsecond\nthird, uncommitted\n');
  writeFileSync(join(WT_ONE, 'new.txt'), 'untracked\n');

  return { base, oneTip };
}

function byName(r: BranchesResponse, name: string): BranchInfo | undefined {
  return r.branches.find((b) => b.name === name);
}

function parents(sha: string): string[] {
  return sh(REPO, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
}

function mergeInProgress(cwd: string): boolean {
  return shOk(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
}

// ── a subscriber, to see the `branches` frame ────────────────────────────────

function subscribe(): { frames: ServerFrame[]; close: () => void; ready: Promise<void> } {
  const frames: ServerFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ready = new Promise<void>((resolve) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', since: 0 }));
      setTimeout(resolve, 150);
    };
  });
  socket.onmessage = (m) => {
    try {
      frames.push(JSON.parse(String(m.data)) as ServerFrame);
    } catch {
      /* not ours */
    }
  };
  return { frames, close: () => socket.close(), ready };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  const fx = makeRepos();

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();

  const project = insertProject(db, { path: REPO, name: 'branches-verify', defaultBranch: 'main' });
  const plain = insertProject(db, { path: PLAIN, name: 'not-a-repo', defaultBranch: 'main' });
  insertJob(db, {
    id: 'job_live',
    projectId: project.id,
    prompt: 'keep busy',
    isolation: 'branch',
    worktreePath: REPO,
    branch: 'conductor/job_live',
    status: 'working',
    budgetUsd: null,
  });
  insertAgent(db, {
    id: 'agt_live',
    jobId: 'job_live',
    projectId: project.id,
    role: 'builder',
    model: 'claude-sonnet-5',
    sdkSessionId: null,
    status: 'working',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: DEFAULT_AUTONOMY,
  });
  // A finished job on feature/two: it has a jobId and is not live.
  insertJob(db, {
    id: 'job_done',
    projectId: project.id,
    prompt: 'edit two',
    isolation: 'branch',
    worktreePath: REPO,
    branch: 'feature/two',
    status: 'done',
    budgetUsd: null,
  });
  insertAgent(db, {
    id: 'agt_done',
    jobId: 'job_done',
    projectId: project.id,
    role: 'builder',
    model: 'claude-sonnet-5',
    sdkSessionId: null,
    status: 'done',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: DEFAULT_AUTONOMY,
  });

  const URL = `/api/projects/${project.id}/branches`;
  const act = (body: unknown) => post<BranchActionResult & Err>(URL, body);
  const ws = subscribe();
  await ws.ready;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · listing');
  const list = await get<BranchesResponse>(URL);
  check('GET → 200', list.status === 200, JSON.stringify(list.body).slice(0, 200));
  const L = list.body;
  check('target is the project default branch', L.target === 'main');
  check('remote is origin', L.remote === 'origin', String(L.remote));
  check(
    'targetCheckout is the repo, clean',
    L.targetCheckout?.path === REPO && L.targetCheckout.clean === true,
    JSON.stringify(L.targetCheckout),
  );
  check('every local branch is listed', L.branches.length === 7, L.branches.map((b) => b.name).join(','));
  check('the target comes first', L.branches[0]?.name === 'main' && L.branches[0].isTarget);
  const rest = L.branches.slice(1);
  check(
    'then by tip time, newest first',
    rest.every((b, i) => i === 0 || rest[i - 1]!.at >= b.at) &&
      rest[0]?.name === 'late/after' && rest[rest.length - 1]?.name === 'feature/two',
    rest.map((b) => b.name).join(','),
  );
  const one = byName(L, 'feature/one');
  check('feature/one: ahead 2, behind 1', one?.ahead === 2 && one.behind === 1, `${one?.ahead}/${one?.behind}`);
  check('feature/one: forked at the base commit', one?.forkedAt === fx.base);
  check('feature/one: head and subject are its tip', one?.head === fx.oneTip && one.subject === 'one: second');
  check(
    'feature/one: its commits, newest first',
    one?.commits.map((c) => c.subject).join('|') === 'one: second|one: first' && one.commits[0]?.sha === fx.oneTip,
  );
  check(
    'feature/one: its worktree, 2 uncommitted (a change and an untracked file)',
    one?.worktree?.path === WT_ONE && one.worktree.uncommitted === 2,
    JSON.stringify(one?.worktree),
  );
  check('feature/one: no upstream yet', one?.upstream === null);
  check('feature/one: no job, not live', one?.jobId === null && one.live === false);
  const mainB = byName(L, 'main');
  check(
    "main: its upstream, one ahead of origin/main",
    mainB?.upstream?.ref === 'origin/main' && mainB.upstream.ahead === 1 && mainB.upstream.behind === 0,
    JSON.stringify(mainB?.upstream),
  );
  check('main: ahead and behind 0, its worktree is the repo', mainB?.ahead === 0 && mainB.behind === 0 && mainB.worktree?.path === REPO);
  check('a branch with no checkout has no worktree', byName(L, 'feature/two')?.worktree === null);
  check('a job branch carries its jobId', byName(L, 'feature/two')?.jobId === 'job_done' && byName(L, 'feature/two')?.live === false);
  const liveB = byName(L, 'conductor/job_live');
  check('a working agent makes its branch live', liveB?.jobId === 'job_live' && liveB.live === true);
  check('at is ISO', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(one?.at ?? ''), one?.at);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · refusals: 404, 400');
  const noProj = await get<Err>('/api/projects/prj_nope/branches');
  check('GET an unknown project → 404', noProj.status === 404, String(noProj.status));
  const noProjPost = await post<Err>('/api/projects/prj_nope/branches', { action: 'fetch' });
  check('POST an unknown project → 404', noProjPost.status === 404, String(noProjPost.status));
  const notRepo = await get<Err>(`/api/projects/${plain.id}/branches`);
  check('a project that is not a repo → 400', notRepo.status === 400 && notRepo.body.error === 'not a git repo', JSON.stringify(notRepo.body));
  for (const name of ['-x', '--force', '--upload-pack=touch pwned']) {
    const m = await act({ action: 'merge', branch: name });
    const p = await act({ action: 'push', branch: name });
    check(`a branch named ${JSON.stringify(name)} → 400 (merge and push)`, m.status === 400 && p.status === 400, `${m.status} ${p.status}`);
  }
  check('no file was made by an option-shaped name', !existsSync(join(REPO, 'pwned')));
  const unknown = await act({ action: 'merge', branch: 'no/such' });
  check('an unknown branch → 400', unknown.status === 400 && unknown.body.error === 'no such branch', JSON.stringify(unknown.body));
  const emptyMsg = await act({ action: 'commit', branch: 'feature/one', message: '   ' });
  check('an empty commit message → 400', emptyMsg.status === 400, String(emptyMsg.status));
  const badAction = await act({ action: 'rebase', branch: 'feature/one' });
  check('an unknown action → 400', badAction.status === 400, String(badAction.status));
  const self = await act({ action: 'merge', branch: 'main' });
  check('merging the target into itself → 400', self.status === 400, String(self.status));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · refusals: live branch, dirty main');
  for (const body of [
    { action: 'merge', branch: 'conductor/job_live' },
    { action: 'commit', branch: 'conductor/job_live', message: 'x' },
    { action: 'push', branch: 'conductor/job_live' },
  ]) {
    const r = await act(body);
    check(`${body.action} on a live branch → 409`, r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
  }
  check('the live branch was not pushed', !shOk(ORIGIN, 'rev-parse', '--verify', '--quiet', 'refs/heads/conductor/job_live'));

  writeFileSync(join(REPO, 'stray.txt'), 'untracked in main\n');
  const withStray = await get<BranchesResponse>(URL);
  check('an untracked file leaves main clean for merging', withStray.body.targetCheckout?.clean === true);
  rmSync(join(REPO, 'stray.txt'));

  const mainHead = sh(REPO, 'rev-parse', 'HEAD');
  writeFileSync(join(REPO, 'a.txt'), 'dirty\n');
  const dirtyList = await get<BranchesResponse>(URL);
  check('a tracked change makes main dirty', dirtyList.body.targetCheckout?.clean === false);
  const dirtyMerge = await act({ action: 'merge', branch: 'feature/two' });
  check('merge into a dirty main → 409', dirtyMerge.status === 409, `${dirtyMerge.status} ${JSON.stringify(dirtyMerge.body)}`);
  const dirtyAll = await act({ action: 'merge_all' });
  check('merge_all into a dirty main → 409', dirtyAll.status === 409, String(dirtyAll.status));
  check('and main did not move', sh(REPO, 'rev-parse', 'HEAD') === mainHead);
  sh(REPO, 'checkout', '-q', '--', 'a.txt');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · merge');
  const twoHead = byName(L, 'feature/two')!.head;
  const before = ws.frames.length;
  const merged = await act({ action: 'merge', branch: 'feature/two' });
  check('merge → 200, ok', merged.status === 200 && merged.body.ok === true, JSON.stringify(merged.body).slice(0, 300));
  check('merged names it', merged.body.merged?.join(',') === 'feature/two');
  const msha = merged.body.sha ?? '';
  check('sha is main\'s new head', msha.length === 40 && sh(REPO, 'rev-parse', 'HEAD') === msha);
  const ps = parents(msha);
  check('a merge commit with two parents', ps.length === 2 && ps[0] === mainHead && ps[1] === twoHead, ps.join(' '));
  check(
    'its message names the branch and the target',
    sh(REPO, 'log', '-1', '--format=%s', msha) === "Merge branch 'feature/two' into main",
  );
  check('the result carries the fresh listing', byName(merged.body.branches, 'feature/two')?.ahead === 0);
  await settle();
  check(
    'a branches frame was broadcast',
    ws.frames.slice(before).some((f) => f.type === 'branches' && f.projectId === project.id),
  );
  const again = await act({ action: 'merge', branch: 'feature/two' });
  check('merging it again → 409 nothing to merge', again.status === 409, `${again.status} ${JSON.stringify(again.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · merge_all: oldest first, stops at the conflict');
  const preAll = sh(REPO, 'rev-parse', 'HEAD');
  const all = await act({ action: 'merge_all' });
  check('merge_all → 200, not ok', all.status === 200 && all.body.ok === false, JSON.stringify(all.body).slice(0, 300));
  check(
    'merged feature/one then clash/a, in tip order',
    all.body.merged?.join(',') === 'feature/one,clash/a',
    all.body.merged?.join(','),
  );
  check(
    'stopped at clash/b, naming the file',
    all.body.conflict?.branch === 'clash/b' && all.body.conflict.files.join(',') === 'conflict.txt',
    JSON.stringify(all.body.conflict),
  );
  const firstParents = sh(REPO, 'log', '--first-parent', '--format=%s', `${preAll}..HEAD`).split('\n');
  check(
    'main has one merge commit each, in that order',
    firstParents.join('|') === "Merge branch 'clash/a' into main|Merge branch 'feature/one' into main",
    firstParents.join('|'),
  );
  check('the live branch was skipped', (byName(all.body.branches, 'conductor/job_live')?.ahead ?? 0) > 0);
  check('the branch after the conflict was not merged', (byName(all.body.branches, 'late/after')?.ahead ?? 0) > 0);
  check('no merge left in progress', !mergeInProgress(REPO));
  check('main is clean', sh(REPO, 'status', '--porcelain', '-uno') === '');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · a single conflicting merge is undone');
  const preConflict = sh(REPO, 'rev-parse', 'HEAD');
  const conflict = await act({ action: 'merge', branch: 'clash/b' });
  check('merge → 200, not ok', conflict.status === 200 && conflict.body.ok === false, JSON.stringify(conflict.body).slice(0, 300));
  check(
    'conflict names the branch and its files',
    conflict.body.conflict?.branch === 'clash/b' && conflict.body.conflict.files.join(',') === 'conflict.txt',
  );
  check('nothing merged', conflict.body.merged?.length === 0);
  check('no MERGE_HEAD', !mergeInProgress(REPO));
  check('main is clean and where it was', sh(REPO, 'status', '--porcelain') === '' && sh(REPO, 'rev-parse', 'HEAD') === preConflict);
  check('the listing still says main is clean', conflict.body.branches.targetCheckout?.clean === true);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · commit');
  const noWt = await act({ action: 'commit', branch: 'late/after', message: 'x' });
  check('commit on a branch with no worktree → 409', noWt.status === 409, String(noWt.status));
  const committed = await act({ action: 'commit', branch: 'feature/one', message: 'wip from the screen' });
  check('commit → 200, ok', committed.status === 200 && committed.body.ok === true, JSON.stringify(committed.body).slice(0, 300));
  check('sha is the worktree\'s new head', committed.body.sha === sh(WT_ONE, 'rev-parse', 'HEAD'));
  check('with your message', sh(WT_ONE, 'log', '-1', '--format=%s') === 'wip from the screen');
  check('it took the change and the untracked file', sh(WT_ONE, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(',') === 'new.txt,one.txt');
  check('the worktree is clean after', sh(WT_ONE, 'status', '--porcelain') === '');
  check('the listing shows 0 uncommitted', byName(committed.body.branches, 'feature/one')?.worktree?.uncommitted === 0);
  const nothing = await act({ action: 'commit', branch: 'feature/one', message: 'again' });
  check('nothing to commit → 409', nothing.status === 409 && nothing.body.error === 'nothing to commit', JSON.stringify(nothing.body));
  // Conductor's own folder of job worktrees is never committed, ignored or not.
  mkdirSync(join(WT_ONE, '.conductor', 'wt'), { recursive: true });
  writeFileSync(join(WT_ONE, '.conductor', 'wt', 'state.txt'), 'ours\n');
  const onlyOurs = await act({ action: 'commit', branch: 'feature/one', message: 'only .conductor' });
  check('only .conductor/ changed → 409 nothing to commit', onlyOurs.status === 409, `${onlyOurs.status} ${JSON.stringify(onlyOurs.body)}`);
  check('and .conductor/ was not staged', sh(WT_ONE, 'diff', '--cached', '--name-only') === '');
  rmSync(join(WT_ONE, '.conductor'), { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8 · push and fetch');
  const pushed = await act({ action: 'push', branch: 'feature/one' });
  check('push → 200, ok', pushed.status === 200 && pushed.body.ok === true, JSON.stringify(pushed.body).slice(0, 300));
  check('with git\'s own words', (pushed.body.output ?? '').length > 0, pushed.body.output);
  const local = sh(REPO, 'rev-parse', 'refs/heads/feature/one');
  check('origin has the branch at its head', sh(ORIGIN, 'rev-parse', 'refs/heads/feature/one') === local);
  check('the upstream is set', sh(REPO, 'config', '--get', 'branch.feature/one.merge') === 'refs/heads/feature/one' && sh(REPO, 'config', '--get', 'branch.feature/one.remote') === 'origin');
  const up = byName(pushed.body.branches, 'feature/one')?.upstream;
  check('the listing shows origin/feature/one, level', up?.ref === 'origin/feature/one' && up.ahead === 0 && up.behind === 0, JSON.stringify(up));

  const pushMain = await act({ action: 'push', branch: 'main' });
  check('push main (has an upstream) → 200', pushMain.status === 200 && sh(ORIGIN, 'rev-parse', 'refs/heads/main') === sh(REPO, 'rev-parse', 'main'), JSON.stringify(pushMain.body).slice(0, 200));

  // Someone else pushes to feature/one; we commit on ours: the histories diverge.
  sh(ROOT, 'clone', '-q', ORIGIN, OTHER);
  sh(OTHER, 'checkout', '-q', 'feature/one');
  const theirs = commitFile(OTHER, 'theirs.txt', 'theirs\n', 'their commit');
  sh(OTHER, 'push', '-q', 'origin', 'feature/one');
  writeFileSync(join(WT_ONE, 'ours.txt'), 'ours\n');
  const ours = await act({ action: 'commit', branch: 'feature/one', message: 'our commit' });
  check('a local commit on top', ours.status === 200);
  // Even with a forcing refspec configured, the screen's push must not force.
  sh(REPO, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
  const rejected = await act({ action: 'push', branch: 'feature/one' });
  check('a non-fast-forward push → 409', rejected.status === 409 && rejected.body.error === 'the push was rejected', JSON.stringify(rejected.body));
  check('with git\'s stderr as detail', /rejected|fetch first|non-fast-forward/.test(rejected.body.detail ?? ''), rejected.body.detail);
  check('origin was not forced', sh(ORIGIN, 'rev-parse', 'refs/heads/feature/one') === theirs);
  sh(REPO, 'config', '--unset', 'remote.origin.push');

  const fetched = await act({ action: 'fetch' });
  check('fetch → 200, ok', fetched.status === 200 && fetched.body.ok === true, JSON.stringify(fetched.body).slice(0, 300));
  const after = byName(fetched.body.branches, 'feature/one')?.upstream;
  check('after fetch, feature/one is 1 ahead and 1 behind origin', after?.ahead === 1 && after.behind === 1, JSON.stringify(after));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · git() options: env and a timeout');
  let timedOut = false;
  const t0 = Date.now();
  try {
    await git(REPO, ['ls-remote', 'ssh://verify.invalid/repo.git'], {
      env: { GIT_SSH_COMMAND: 'sleep 5 #' },
      timeoutMs: 300,
    });
  } catch (err) {
    timedOut = err instanceof GitError && err.timedOut;
  }
  check('a call past timeoutMs is killed and says timedOut', timedOut && Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  let plainFail: GitError | null = null;
  try {
    await git(REPO, ['rev-parse', '--verify', 'refs/heads/no-such']);
  } catch (err) {
    plainFail = err instanceof GitError ? err : null;
  }
  check('an ordinary failure is not a timeout', plainFail !== null && !plainFail.timedOut);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n10 · merge into another branch, and the preview (Amendment 110)');
  const preview = (branch: string, into?: string) =>
    get<BranchMergePreview & Err>(
      `${URL}/preview?branch=${encodeURIComponent(branch)}${into === undefined ? '' : `&into=${encodeURIComponent(into)}`}`,
    );
  const mainBefore = sh(REPO, 'rev-parse', 'main');
  const oneBefore = sh(REPO, 'rev-parse', 'feature/one');

  const pv = await preview('late/after', 'feature/one');
  check('preview → 200', pv.status === 200, JSON.stringify(pv.body).slice(0, 300));
  check('it counts against the branch named, not main', pv.body.into === 'feature/one' && pv.body.ahead === 1 && pv.body.behind > 0, JSON.stringify(pv.body));
  check('with the commits that would move', pv.body.commits.map((c) => c.subject).join('|') === 'late work');
  check('no conflicts and no reason: it would run', JSON.stringify(pv.body.conflicts) === '[]' && pv.body.reason === null, JSON.stringify(pv.body));
  check('a preview changes nothing', sh(REPO, 'rev-parse', 'feature/one') === oneBefore && sh(WT_ONE, 'status', '--porcelain') === '');

  const pvMain = await preview('late/after');
  check('no into is the target, as before', pvMain.status === 200 && pvMain.body.into === 'main', JSON.stringify(pvMain.body).slice(0, 200));

  const pvClash = await preview('clash/b', 'clash/a');
  check('a conflict is found without a checkout', JSON.stringify(pvClash.body.conflicts) === '["conflict.txt"]', JSON.stringify(pvClash.body));
  check("and the reason says the branch isn't checked out", /isn't checked out/.test(pvClash.body.reason ?? ''), pvClash.body.reason ?? 'null');

  const pvSelf = await preview('feature/one', 'feature/one');
  check('preview into itself → 400', pvSelf.status === 400, String(pvSelf.status));
  const pvBad = await preview('late/after', '--upload-pack=x');
  check('preview into a name starting with - → 400', pvBad.status === 400, String(pvBad.status));
  const pvNone = await preview('late/after', 'no/such');
  check('preview into an unknown branch → 400', pvNone.status === 400 && pvNone.body.error === 'no such branch', JSON.stringify(pvNone.body));

  const badInto = await act({ action: 'merge', branch: 'late/after', into: '-x' });
  check('merge into a name starting with - → 400', badInto.status === 400, String(badInto.status));
  const notOut = await act({ action: 'merge', branch: 'clash/b', into: 'clash/a' });
  check("merge into a branch checked out nowhere → 409", notOut.status === 409 && /isn't checked out/.test(notOut.body.error), JSON.stringify(notOut.body));

  writeFileSync(join(WT_ONE, 'one.txt'), 'dirty, tracked\n');
  const dirtyInto = await act({ action: 'merge', branch: 'late/after', into: 'feature/one' });
  check("merge into a branch whose checkout has tracked changes → 409", dirtyInto.status === 409 && /has changes/.test(dirtyInto.body.error), JSON.stringify(dirtyInto.body));
  sh(WT_ONE, 'checkout', '--', 'one.txt');

  const intoOne = await act({ action: 'merge', branch: 'late/after', into: 'feature/one' });
  check('merge into feature/one → 200, ok', intoOne.status === 200 && intoOne.body.ok === true, JSON.stringify(intoOne.body).slice(0, 300));
  check('it says where it went', intoOne.body.into === 'feature/one' && intoOne.body.merged.join(',') === 'late/after');
  check('the merge commit is on feature/one, in its worktree, with two parents',
    intoOne.body.sha === sh(WT_ONE, 'rev-parse', 'HEAD') && parents(intoOne.body.sha ?? '').length === 2);
  check("with the message naming both", sh(WT_ONE, 'log', '-1', '--format=%s') === "Merge branch 'late/after' into feature/one");
  check('main did not move', sh(REPO, 'rev-parse', 'main') === mainBefore);
  const twice = await act({ action: 'merge', branch: 'late/after', into: 'feature/one' });
  check('merging it again → 409 nothing to merge', twice.status === 409 && twice.body.error === 'nothing to merge', JSON.stringify(twice.body));

  sh(REPO, 'worktree', 'add', '-q', WT_CLASH, 'clash/a');
  const clashBefore = sh(WT_CLASH, 'rev-parse', 'HEAD');
  const clashed = await act({ action: 'merge', branch: 'clash/b', into: 'clash/a' });
  check('a conflict merging into another branch → 200, not ok', clashed.status === 200 && clashed.body.ok === false, JSON.stringify(clashed.body).slice(0, 300));
  check('it names the branch, its files and where it went', clashed.body.conflict?.branch === 'clash/b' && clashed.body.conflict.files.join(',') === 'conflict.txt' && clashed.body.into === 'clash/a');
  check('and is undone there', !mergeInProgress(WT_CLASH) && sh(WT_CLASH, 'status', '--porcelain') === '' && sh(WT_CLASH, 'rev-parse', 'HEAD') === clashBefore);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · which branch everything is drawn against (Amendment 113)');
  const gone = await resolveTarget(REPO, 'cleanup', null);
  check('a recorded branch that was deleted falls back to main', gone.target === 'main' && gone.from === 'main', JSON.stringify(gone));
  const kept = await resolveTarget(REPO, 'feature/one', null);
  check('a recorded branch that exists is used', kept.target === 'feature/one' && kept.from === 'project', JSON.stringify(kept));
  const picked = await resolveTarget(REPO, 'cleanup', 'feature/two');
  check('the one you chose wins', picked.target === 'feature/two' && picked.from === 'chosen', JSON.stringify(picked));
  const stale = await resolveTarget(REPO, 'cleanup', 'deleted/since');
  check('a chosen branch that is gone is passed over', stale.target === 'main', JSON.stringify(stale));
  sh(REPO, 'fetch', '-q', 'origin');
  sh(REPO, 'remote', 'set-head', 'origin', 'main');
  const fromOrigin = await resolveTarget(REPO, 'feature/one', null);
  check("origin's default beats the recorded one", fromOrigin.target === 'main' && fromOrigin.from === 'origin', JSON.stringify(fromOrigin));

  // Through the route: the project was recorded on main; choose another, then clear it.
  patchSettings({ [branchTargetKey(project.id)]: 'feature/one' });
  const chosenList = await get<BranchesResponse>(URL);
  check('GET draws against the chosen branch', chosenList.body.target === 'feature/one' && chosenList.body.targetFrom === 'chosen', `${chosenList.body.target} ${chosenList.body.targetFrom}`);
  check('and counts against it', byName(chosenList.body, 'feature/one')?.isTarget === true && byName(chosenList.body, 'main')?.isTarget === false);
  check('a branches frame told the pages', ws.frames.some((f) => f.type === 'branches' && f.projectId === project.id));
  patchSettings({ [branchTargetKey(project.id)]: null });
  const back = await get<BranchesResponse>(URL);
  check('cleared, it is main again', back.body.target === 'main', back.body.target);

  // ───────────────────────────────────────────────────────────────────────────
  ws.close();
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 109 branches: PASS — ${checks} checks: listing, merge, merge_all, conflicts, commit, push, fetch, refusals, merge into any branch, preview.\n`
      : `\nAmendment 109 branches: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
