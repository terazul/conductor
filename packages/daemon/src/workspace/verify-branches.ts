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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_AUTONOMY, addProjectDir, getJob, getProject, insertAgent, insertJob, insertProject, setAgentStatus } from '../session/store.js';
import { projectRepo } from './project-repo.js';
import type { AgentStatus, Isolation } from '@conductor/shared';
import { readFileSync } from 'node:fs';
import { EventLog } from '../eventlog.js';
import { GitError, git } from './git.js';
import { FORCE_SENTENCE, resolveTarget } from './branches.js';
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
// Amendment 117's own repo, kept apart from REPO above: its `job_live` is permanently
// live, which would make every checkout refused for the wrong reason.
const REPO2 = join(ROOT, 'repo2');
const ORIGIN2 = join(ROOT, 'origin2.git');
const WT2 = join(ROOT, 'wt2');
// Amendment 143's own repo: the project folder on a branch of its own, main in a worktree.
const REPO3 = join(ROOT, 'repo3');
const ORIGIN3 = join(ROOT, 'origin3.git');
const WT3_MAIN = join(ROOT, 'wt3-main');
const WT3_MERGED = join(ROOT, 'wt3-merged');
const WT3_DIRTY = join(ROOT, 'wt3-dirty');
const WT3_LIVE = join(ROOT, 'wt3-live');
const WT3_DONE = join(ROOT, 'wt3-done');
const WT3_C2 = join(ROOT, 'wt3-c2');
const WT3_C3 = join(ROOT, 'wt3-c3');
// N3's repo: main in the project folder, each branch in a worktree of its own, an origin,
// and a second clone of that origin that moves origin's branches on.
const REPO4 = join(ROOT, 'repo4');
const ORIGIN4 = join(ROOT, 'origin4.git');
const OTHER4 = join(ROOT, 'other4');
const wt4 = (name: string): string => join(ROOT, `wt4-${name.replace(/\//g, '-')}`);
// N4's project: a repo with a clone nested in it (and one nested in that), an extra
// directory that is a repo, one that isn't but has a repo in it, and one inside the repo.
const REPO5 = join(ROOT, 'repo5');
const ORIGIN5 = join(ROOT, 'origin5.git');
const NESTED5 = join(REPO5, 'inner');
const DEEPER5 = join(NESTED5, 'deeper');
const ORIGIN5N = join(ROOT, 'origin5n.git');
const WT5N = join(ROOT, 'wt5n-same');
const EXTRA5 = join(ROOT, 'extra5');
const EXTRA5_PLAIN = join(ROOT, 'extra5-plain');
const EXTRA5_DEEP = join(EXTRA5_PLAIN, 'deep');

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

/**
 * A second, simpler repo for Amendment 117's `set_default`: `main`, two more local branches
 * (`alt`, `other`), `other` checked out in its own worktree, and an `origin` whose HEAD is
 * `main` — so a test that beats origin/HEAD actually has one to beat.
 */
function makeRepo2(): void {
  sh(ROOT, 'init', '-q', '--bare', ORIGIN2);
  sh(ROOT, 'init', '-q', '-b', 'main', REPO2);
  sh(REPO2, 'config', 'user.name', 'Verify');
  sh(REPO2, 'config', 'user.email', 'verify@example.invalid');
  commitFile(REPO2, 'r.txt', 'one\n', 'start');
  sh(REPO2, 'remote', 'add', 'origin', ORIGIN2);
  sh(REPO2, 'push', '-q', '-u', 'origin', 'main');
  sh(REPO2, 'remote', 'set-head', 'origin', 'main');
  sh(REPO2, 'branch', 'alt', 'main');
  sh(REPO2, 'branch', 'other', 'main');
  sh(REPO2, 'worktree', 'add', '-q', WT2, 'other');
}

/**
 * Amendment 143's repo. The project folder (REPO3) has `on/root` checked out and `main` is in
 * its own worktree, so "the project folder's own branch" is a branch that isn't the target.
 * Every `merged/*` branch is merged into main by a merge commit; `unmerged` isn't;
 * `merged/pushed` is on origin too, and `merged/unpushed` has a commit its upstream lacks.
 */
function makeRepo3(): void {
  sh(ROOT, 'init', '-q', '--bare', ORIGIN3);
  sh(ROOT, 'init', '-q', '-b', 'main', REPO3);
  sh(REPO3, 'config', 'user.name', 'Verify');
  sh(REPO3, 'config', 'user.email', 'verify@example.invalid');
  commitFile(REPO3, 's.txt', 'start\n', 'start');
  sh(REPO3, 'remote', 'add', 'origin', ORIGIN3);
  sh(REPO3, 'push', '-q', '-u', 'origin', 'main');
  const mergeIn = (name: string, subject: string): void => {
    sh(REPO3, 'checkout', '-q', 'main');
    sh(REPO3, 'merge', '-q', '--no-ff', '--no-edit', '-m', subject, name);
  };
  for (const name of ['merged/plain', 'merged/wt', 'merged/dirty', 'merged/live', 'conductor/job_done3', 'on/root', 'c/one', 'c/two', 'c/three']) {
    sh(REPO3, 'checkout', '-q', '-b', name, 'main');
    commitFile(REPO3, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `work on ${name}`);
    mergeIn(name, `Merge ${name}`);
  }
  sh(REPO3, 'checkout', '-q', '-b', 'merged/pushed', 'main');
  commitFile(REPO3, 'pushed.txt', 'p\n', 'pushed work');
  sh(REPO3, 'push', '-q', '-u', 'origin', 'merged/pushed');
  mergeIn('merged/pushed', 'Merge pushed');
  sh(REPO3, 'checkout', '-q', '-b', 'merged/unpushed', 'main');
  commitFile(REPO3, 'unpushed.txt', 'u\n', 'unpushed base');
  sh(REPO3, 'push', '-q', '-u', 'origin', 'merged/unpushed');
  commitFile(REPO3, 'unpushed.txt', 'u2\n', 'unpushed more');
  mergeIn('merged/unpushed', 'Merge unpushed');
  sh(REPO3, 'push', '-q', 'origin', 'main');
  sh(REPO3, 'checkout', '-q', '-b', 'unmerged', 'main');
  commitFile(REPO3, 'unmerged.txt', 'not yet\n', 'unmerged work');
  // The folder goes to on/root; main moves to a worktree of its own.
  sh(REPO3, 'checkout', '-q', 'on/root');
  sh(REPO3, 'worktree', 'add', '-q', WT3_MAIN, 'main');
  sh(REPO3, 'worktree', 'add', '-q', WT3_MERGED, 'merged/wt');
  sh(REPO3, 'worktree', 'add', '-q', WT3_DIRTY, 'merged/dirty');
  writeFileSync(join(WT3_DIRTY, 'scratch.txt'), 'untracked only\n');
  sh(REPO3, 'worktree', 'add', '-q', WT3_LIVE, 'merged/live');
  sh(REPO3, 'worktree', 'add', '-q', WT3_DONE, 'conductor/job_done3');
  sh(REPO3, 'worktree', 'add', '-q', WT3_C2, 'c/two');
  sh(REPO3, 'worktree', 'add', '-q', WT3_C3, 'c/three');
  writeFileSync(join(WT3_C3, 'c-three.txt'), 'edited, not committed\n');
}

/**
 * N3's repo. `pull/*` and `rb/pushed` are on origin and track it; `rb/plain`, `rb/clash`,
 * `rb/live` and `side` are local only. Every branch but `side` has its own worktree, and
 * each `rb/*` has a commit of its own. Then main moves on, changing c.txt, which `rb/clash`
 * changes too.
 */
function makeRepo4(): void {
  sh(ROOT, 'init', '-q', '--bare', ORIGIN4);
  sh(ROOT, 'init', '-q', '-b', 'main', REPO4);
  sh(REPO4, 'config', 'user.name', 'Verify');
  sh(REPO4, 'config', 'user.email', 'verify@example.invalid');
  commitFile(REPO4, 'c.txt', 'base\n', 'start');
  sh(REPO4, 'remote', 'add', 'origin', ORIGIN4);
  sh(REPO4, 'push', '-q', '-u', 'origin', 'main');
  for (const name of ['pull/ff', 'pull/div', 'pull/dirty', 'rb/pushed', 'rb/plain', 'rb/clash', 'rb/live', 'side']) {
    sh(REPO4, 'branch', name, 'main');
  }
  for (const name of ['pull/ff', 'pull/div', 'pull/dirty', 'rb/plain', 'rb/clash', 'rb/live', 'rb/pushed']) {
    sh(REPO4, 'worktree', 'add', '-q', wt4(name), name);
  }
  commitFile(wt4('rb/pushed'), 'pushed.txt', 'p\n', 'pushed work');
  for (const name of ['pull/ff', 'pull/div', 'pull/dirty', 'rb/pushed']) sh(REPO4, 'push', '-q', '-u', 'origin', name);
  commitFile(wt4('rb/plain'), 'plain.txt', 'p\n', 'plain work');
  commitFile(wt4('rb/clash'), 'c.txt', 'from clash\n', 'clash work');
  commitFile(wt4('rb/live'), 'live.txt', 'l\n', 'live work');
  commitFile(REPO4, 'c.txt', 'from main\n', 'main moves on');
  sh(ROOT, 'clone', '-q', ORIGIN4, OTHER4);
  sh(OTHER4, 'config', 'user.name', 'Other');
  sh(OTHER4, 'config', 'user.email', 'other@example.invalid');
}

function makeRepo5(): void {
  const init = (dir: string): void => {
    sh(ROOT, 'init', '-q', '-b', 'main', dir);
    sh(dir, 'config', 'user.name', 'Verify');
    sh(dir, 'config', 'user.email', 'verify@example.invalid');
  };
  // The project's own repo: `same` pushed, then one commit behind what origin has of it.
  sh(ROOT, 'init', '-q', '--bare', ORIGIN5);
  init(REPO5);
  mkdirSync(join(REPO5, 'sub'));
  commitFile(REPO5, 'sub/s.txt', 'sub\n', 'outer start');
  sh(REPO5, 'remote', 'add', 'origin', ORIGIN5);
  sh(REPO5, 'push', '-q', '-u', 'origin', 'main');
  sh(REPO5, 'checkout', '-q', '-b', 'same');
  commitFile(REPO5, 'o.txt', 'outer same\n', 'outer same');
  commitFile(REPO5, 'o.txt', 'outer same, more\n', 'outer same more');
  sh(REPO5, 'push', '-q', '-u', 'origin', 'same');
  sh(REPO5, 'checkout', '-q', 'main');
  sh(REPO5, 'branch', '-q', '-f', 'same', 'same~1');
  sh(REPO5, 'branch', '-q', 'outer/only');
  symlinkSync(REPO, join(REPO5, 'link'));

  // The nested clone, untracked by the outer one, with an origin of its own.
  sh(ROOT, 'init', '-q', '--bare', ORIGIN5N);
  init(NESTED5);
  commitFile(NESTED5, 'n.txt', 'inner\n', 'inner start');
  sh(NESTED5, 'remote', 'add', 'origin', ORIGIN5N);
  sh(NESTED5, 'push', '-q', '-u', 'origin', 'main');
  sh(NESTED5, 'checkout', '-q', '-b', 'same');
  commitFile(NESTED5, 'same.txt', 'inner same\n', 'inner same');
  sh(NESTED5, 'push', '-q', '-u', 'origin', 'same');
  sh(NESTED5, 'checkout', '-q', '-b', 'feat/n', 'main');
  commitFile(NESTED5, 'feat.txt', 'feat\n', 'inner feat');
  sh(NESTED5, 'checkout', '-q', 'main');
  sh(NESTED5, 'worktree', 'add', '-q', WT5N, 'same');
  init(DEEPER5);
  commitFile(DEEPER5, 'd.txt', 'deeper\n', 'deeper start');

  init(EXTRA5);
  commitFile(EXTRA5, 'x.txt', 'extra\n', 'extra start');
  sh(EXTRA5, 'branch', '-q', 'x/one');
  mkdirSync(EXTRA5_PLAIN);
  writeFileSync(join(EXTRA5_PLAIN, 'loose.txt'), 'not in a repo\n');
  init(EXTRA5_DEEP);
  commitFile(EXTRA5_DEEP, 'deep.txt', 'deep\n', 'deep start');
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
  makeRepo2();
  makeRepo3();
  makeRepo4();
  makeRepo5();

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();

  const project = insertProject(db, { path: REPO, name: 'branches-verify', defaultBranch: 'main' });
  const project2 = insertProject(db, { path: REPO2, name: 'default-branch-verify', defaultBranch: 'main' });
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
  const badAction = await act({ action: 'squash', branch: 'feature/one' });
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
  console.log("\n12 · a project's default branch, and checking it out (Amendment 117)");
  const URL2 = `/api/projects/${project2.id}/branches`;
  const act2 = (body: unknown) => post<BranchActionResult & Err>(URL2, body);

  const start = await get<BranchesResponse>(URL2);
  check('starts on main, folder clean, nothing live', start.body.rootBranch === 'main' && start.body.rootClean === true && start.body.rootLive === false, JSON.stringify(start.body));
  check("before it's set, origin/HEAD still decides the target", start.body.target === 'main' && start.body.targetFrom === 'origin', `${start.body.target} ${start.body.targetFrom}`);

  const setAlt = await act2({ action: 'set_default', branch: 'alt', checkout: false });
  check('set_default (no checkout) → 200, ok', setAlt.status === 200 && setAlt.body.ok === true, JSON.stringify(setAlt.body));
  check('the folder did not move', setAlt.body.branches.rootBranch === 'main');
  check('the target follows it, beating origin/HEAD', setAlt.body.branches.target === 'alt' && setAlt.body.branches.targetFrom === 'project', `${setAlt.body.branches.target} ${setAlt.body.branches.targetFrom}`);
  check("it's written to the project", getProject(db, project2.id)?.defaultBranch === 'alt', getProject(db, project2.id)?.defaultBranch);
  check(
    'an entities frame told the pages',
    ws.frames.some((f) => f.type === 'entities' && f.projects?.some((p) => p.id === project2.id && p.defaultBranch === 'alt')),
  );

  const checkoutAlt = await act2({ action: 'set_default', branch: 'alt', checkout: true });
  check('set_default with checkout → 200, ok', checkoutAlt.status === 200 && checkoutAlt.body.ok === true, JSON.stringify(checkoutAlt.body));
  check('checkout switches the folder', sh(REPO2, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'alt');
  check('rootBranch is right', checkoutAlt.body.branches.rootBranch === 'alt', String(checkoutAlt.body.branches.rootBranch));

  writeFileSync(join(REPO2, 'r.txt'), 'dirty\n');
  const dirtyCheckout = await act2({ action: 'set_default', branch: 'main', checkout: true });
  check('a dirty folder gives 409', dirtyCheckout.status === 409, `${dirtyCheckout.status} ${JSON.stringify(dirtyCheckout.body)}`);
  check('and it did not move', sh(REPO2, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'alt');
  sh(REPO2, 'checkout', '-q', '--', 'r.txt');

  const job3 = insertJob(db, {
    id: 'job_root_live',
    projectId: project2.id,
    prompt: 'stay busy',
    isolation: 'in_place',
    worktreePath: REPO2,
    branch: 'alt',
    status: 'working',
    budgetUsd: null,
  });
  const agt3 = insertAgent(db, {
    id: 'agt_root_live',
    jobId: job3.id,
    projectId: project2.id,
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
  const liveCheckout = await act2({ action: 'set_default', branch: 'main', checkout: true });
  check('a live in_place job gives 409', liveCheckout.status === 409, `${liveCheckout.status} ${JSON.stringify(liveCheckout.body)}`);
  check('and it still did not move', sh(REPO2, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'alt');
  setAgentStatus(db, agt3.id, 'done');

  const elsewhere = await act2({ action: 'set_default', branch: 'other', checkout: true });
  check('a branch checked out elsewhere gives 409', elsewhere.status === 409, `${elsewhere.status} ${JSON.stringify(elsewhere.body)}`);
  check('and it still did not move', sh(REPO2, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'alt');

  const unknownDefault = await act2({ action: 'set_default', branch: 'no/such', checkout: false });
  check('an unknown branch → 400', unknownDefault.status === 400, `${unknownDefault.status} ${JSON.stringify(unknownDefault.body)}`);
  const dashDefault = await act2({ action: 'set_default', branch: '--evil', checkout: false });
  check("a name starting with '-' → 400", dashDefault.status === 400, `${dashDefault.status} ${JSON.stringify(dashDefault.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · deleting merged branches, never a folder an agent can resume in (Amendment 143)');
  {
    const project3 = insertProject(db, { path: REPO3, name: 'delete-verify', defaultBranch: 'main' });
    const URL3 = `/api/projects/${project3.id}/branches`;
    const act3 = (body: unknown) => post<BranchActionResult & Err>(URL3, body);
    const log = new EventLog(db);
    const jobOn = (id: string, branch: string, path: string, status: AgentStatus, isolation: Isolation = 'worktree'): void => {
      insertJob(db, { id, projectId: project3.id, prompt: `work on ${branch}`, isolation, worktreePath: path, branch, status, budgetUsd: null });
      insertAgent(db, {
        id: `agt_${id}`,
        jobId: id,
        projectId: project3.id,
        role: 'builder',
        model: 'claude-sonnet-5',
        sdkSessionId: null,
        status,
        blockMode: null,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        dependsOn: [],
        autonomy: DEFAULT_AUTONOMY,
      });
      log.emit({ projectId: project3.id, jobId: id, agentId: `agt_${id}` }, { kind: 'user_text', text: `do ${branch}` });
    };
    const eventsOf = (jobId: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id = ?').get(jobId) as { n: number }).n;
    const hasBranch = (name: string): boolean => shOk(REPO3, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
    const originRefs = (): string => sh(ORIGIN3, 'for-each-ref', '--format=%(refname) %(objectname)');
    jobOn('job_live3', 'merged/live', WT3_LIVE, 'working');
    jobOn('job_done3', 'conductor/job_done3', WT3_DONE, 'done');
    jobOn('job_c2', 'c/two', WT3_C2, 'stopped');
    const originBefore = originRefs();

    const listed = await get<BranchesResponse>(URL3);
    check('the repo reads: main is the target, the folder is on on/root', listed.body.target === 'main' && listed.body.rootBranch === 'on/root', `${listed.body.target} ${listed.body.rootBranch}`);

    const refused = async (label: string, body: unknown, pattern: RegExp, still: string): Promise<void> => {
      const r = await act3(body);
      check(`${label} → 409, with its sentence`, r.status === 409 && pattern.test(r.body.error), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      check(`  and ${still} is still there`, hasBranch(still));
    };
    await refused('the target', { action: 'delete', branch: 'main' }, /is the branch everything is compared with/, 'main');
    await refused("the project folder's own branch", { action: 'delete', branch: 'on/root' }, /checked out in the project's own folder/, 'on/root');
    await refused('a branch not merged into the target', { action: 'delete', branch: 'unmerged' }, /has 1 commit main doesn't; it isn't merged, and git branch -d would refuse it/, 'unmerged');
    await refused('a merged branch with a commit its upstream lacks (git branch -d judges by the upstream)', { action: 'delete', branch: 'merged/unpushed' }, /origin\/merged\/unpushed doesn't, and git branch -d checks against it/, 'merged/unpushed');
    await refused('a folder with only an untracked file', { action: 'delete', branch: 'merged/dirty' }, /wt3-dirty has 1 uncommitted file \(untracked ones count\)/, 'merged/dirty');
    check('  and its folder too', existsSync(join(WT3_DIRTY, 'scratch.txt')));
    await refused('a job with a live agent, even with forgetJob', { action: 'delete', branch: 'merged/live', forgetJob: true }, /an agent is working on merged\/live \(job job_live3\)/, 'merged/live');
    check('  and the live job is untouched', getJob(db, 'job_live3') !== undefined && existsSync(WT3_LIVE));
    await refused(
      "a done job's branch without forgetJob",
      { action: 'delete', branch: 'conductor/job_done3' },
      /^job job_done3's agents can still be messaged, and they need this folder; remove the job, or choose 'forget the job too'$/,
      'conductor/job_done3',
    );
    check('  and the done job and its folder are untouched', getJob(db, 'job_done3') !== undefined && existsSync(WT3_DONE));
    const bad = await act3({ action: 'delete', branch: 'merged/plain', forgetJob: 'yes' });
    check('forgetJob that is not a boolean → 400', bad.status === 400, `${bad.status}`);
    const dash = await act3({ action: 'delete', branch: '-D' });
    check("a name starting with '-' → 400", dash.status === 400, `${dash.status}`);
    const none = await act3({ action: 'delete', branch: 'no/such' });
    check('an unknown branch → 400', none.status === 400, `${none.status}`);

    const plainDel = await act3({ action: 'delete', branch: 'merged/plain' });
    check('a merged branch with no folder and no job → 200, removed', plainDel.status === 200 && plainDel.body.ok && plainDel.body.removed?.join() === 'merged/plain', JSON.stringify(plainDel.body).slice(0, 300));
    check('  the branch is gone, and git said "Deleted branch"', !hasBranch('merged/plain') && /Deleted branch merged\/plain/.test(plainDel.body.output ?? ''), plainDel.body.output);
    check('  and the listing after it lacks it', !byName(plainDel.body.branches, 'merged/plain'));

    const wt = await act3({ action: 'delete', branch: 'merged/wt' });
    check('a merged branch with a clean folder → removed', wt.status === 200 && wt.body.removed?.join() === 'merged/wt', JSON.stringify(wt.body).slice(0, 300));
    check('  its folder and its branch are both gone', !existsSync(WT3_MERGED) && !hasBranch('merged/wt'));
    check('  and git no longer lists the worktree', !sh(REPO3, 'worktree', 'list', '--porcelain').includes(WT3_MERGED));

    const pushed = await act3({ action: 'delete', branch: 'merged/pushed' });
    check('a merged branch that is on origin → removed locally', pushed.status === 200 && !hasBranch('merged/pushed'), JSON.stringify(pushed.body).slice(0, 200));
    check('  and origin still has it', shOk(ORIGIN3, 'rev-parse', '--verify', '--quiet', 'refs/heads/merged/pushed'));

    const eventsBefore = eventsOf('job_done3');
    const forgot = await act3({ action: 'delete', branch: 'conductor/job_done3', forgetJob: true });
    check("a done job's branch with forgetJob → removed", forgot.status === 200 && forgot.body.removed?.join() === 'conductor/job_done3' && forgot.body.forgotJobs?.join() === 'job_done3', JSON.stringify(forgot.body).slice(0, 300));
    check('  the job row is gone, its agent with it', getJob(db, 'job_done3') === undefined && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get('agt_job_done3'));
    check('  its transcript is still in the events table', eventsBefore > 0 && eventsOf('job_done3') === eventsBefore, `${eventsBefore} → ${eventsOf('job_done3')}`);
    check('  its folder and its branch are gone', !existsSync(WT3_DONE) && !hasBranch('conductor/job_done3'));

    const code = readFileSync(new globalThis.URL('./branches.ts', import.meta.url), 'utf8');
    check(
      "the code deletes with 'branch', '-d' and never '-D' or a forced worktree remove",
      /\['branch', '-d', '--'/.test(code) && !/'-D'/.test(code) && !/'worktree', 'remove', '--force'/.test(code) && !/'worktree', 'remove', '-f'/.test(code),
    );

    // clean_merged: c/one (plain), c/two (a stopped job owns it), c/three (uncommitted), and
    // what still stands from above: merged/dirty, merged/live, merged/unpushed, on/root.
    const first = await act3({ action: 'clean_merged' });
    const keptWhy = (r: typeof first, b: string): string => r.body.kept?.find((k) => k.branch === b)?.why ?? '';
    check('clean_merged → 200, ok', first.status === 200 && first.body.ok, JSON.stringify(first.body).slice(0, 300));
    check('  removed only c/one', first.body.removed?.join() === 'c/one', JSON.stringify(first.body.removed));
    check("  kept c/two with the job's sentence", /^job job_c2's agents can still be messaged/.test(keptWhy(first, 'c/two')), keptWhy(first, 'c/two'));
    check('  kept c/three: uncommitted', /uncommitted file/.test(keptWhy(first, 'c/three')), keptWhy(first, 'c/three'));
    check(
      '  kept merged/live, merged/dirty, merged/unpushed and on/root, each with why',
      /agent is working/.test(keptWhy(first, 'merged/live')) && /uncommitted/.test(keptWhy(first, 'merged/dirty')) && /checks against it/.test(keptWhy(first, 'merged/unpushed')) && /project's own folder/.test(keptWhy(first, 'on/root')),
      JSON.stringify(first.body.kept),
    );
    check('  never lists the target or an unmerged branch', !first.body.kept?.some((k) => k.branch === 'main' || k.branch === 'unmerged'));
    check('  the stopped job, its folder and its branch stay', getJob(db, 'job_c2') !== undefined && existsSync(WT3_C2) && hasBranch('c/two'));

    // An older tip than c/two's: removed before it.
    sh(REPO3, 'branch', 'c/zero', 'refs/heads/main~5'); // Merge on/root, before c/one and c/two
    const second = await act3({ action: 'clean_merged', forgetJobs: true });
    const order = second.body.removed ?? [];
    check('clean_merged with forgetJobs removes the job-owned one too', second.status === 200 && order.includes('c/two') && second.body.forgotJobs?.join() === 'job_c2', JSON.stringify(second.body).slice(0, 300));
    check('  oldest tip first: c/zero before c/two', order.indexOf('c/zero') > -1 && order.indexOf('c/zero') < order.indexOf('c/two'), JSON.stringify(order));
    check('  job_c2 is gone, its folder and branch too, its transcript kept', getJob(db, 'job_c2') === undefined && !existsSync(WT3_C2) && !hasBranch('c/two') && eventsOf('job_c2') > 0);
    check('  the live one still stays, with its job', hasBranch('merged/live') && getJob(db, 'job_live3') !== undefined && /agent is working/.test(keptWhy(second, 'merged/live')));
    check('  the uncommitted edit in c/three is still there', readFileSync(join(WT3_C3, 'c-three.txt'), 'utf8').startsWith('edited'));
    check('origin is exactly as it was', originRefs() === originBefore, `${originBefore}\n→\n${originRefs()}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n14 · pull and rebase, never forced (N3)');
  {
    const project4 = insertProject(db, { path: REPO4, name: 'pull-rebase-verify', defaultBranch: 'main' });
    const URL4 = `/api/projects/${project4.id}/branches`;
    const act4 = (body: unknown) => post<BranchActionResult & Err>(URL4, body);
    insertJob(db, { id: 'job_live4', projectId: project4.id, prompt: 'keep busy', isolation: 'worktree', worktreePath: wt4('rb/live'), branch: 'rb/live', status: 'working', budgetUsd: null });
    insertAgent(db, {
      id: 'agt_live4',
      jobId: 'job_live4',
      projectId: project4.id,
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
    const tip = (name: string): string => sh(REPO4, 'rev-parse', `refs/heads/${name}`);
    const originTip = (name: string): string => sh(ORIGIN4, 'rev-parse', `refs/heads/${name}`);
    const refusedWith = (r: Reply<BranchActionResult & Err>, status: number, pattern: RegExp): boolean =>
      r.status === status && pattern.test(`${r.body.error} — ${r.body.detail ?? ''}`);
    const show = (r: Reply<BranchActionResult & Err>): string => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

    // Origin moves on: one commit on pull/ff, one on pull/div (and one of ours there too).
    sh(OTHER4, 'checkout', '-q', 'pull/ff');
    const theirsFf = commitFile(OTHER4, 'ff.txt', 'theirs\n', 'theirs on ff');
    sh(OTHER4, 'push', '-q', 'origin', 'pull/ff');
    sh(OTHER4, 'checkout', '-q', 'pull/div');
    const theirsDiv = commitFile(OTHER4, 'div.txt', 'theirs\n', 'theirs on div');
    sh(OTHER4, 'push', '-q', 'origin', 'pull/div');
    const oursDiv = commitFile(wt4('pull/div'), 'div-ours.txt', 'ours\n', 'ours on div');

    const ff = await act4({ action: 'pull', branch: 'pull/ff' });
    check('a pull that fast-forwards → 200, ok', ff.status === 200 && ff.body.ok === true, show(ff));
    check('  pull/ff is at what origin has, with no merge commit', tip('pull/ff') === theirsFf && ff.body.sha === theirsFf, `${tip('pull/ff')} ${theirsFf}`);
    check('  its checkout has the file', existsSync(join(wt4('pull/ff'), 'ff.txt')));
    check('  and the listing has it level with origin', (() => {
      const up = byName(ff.body.branches, 'pull/ff')?.upstream;
      return up?.ahead === 0 && up.behind === 0;
    })(), JSON.stringify(byName(ff.body.branches, 'pull/ff')?.upstream));
    const again = await act4({ action: 'pull', branch: 'pull/ff' });
    check('pulling it again → 409 nothing to pull', refusedWith(again, 409, /^nothing to pull — pull\/ff already has every commit on origin\/pull\/ff/), show(again));

    const div = await act4({ action: 'pull', branch: 'pull/div' });
    check('a diverged pull → 409 "diverged — merge or rebase"', refusedWith(div, 409, /^diverged — merge or rebase — pull\/div has 1 commit origin\/pull\/div doesn't, and origin\/pull\/div has 1 commit it doesn't/), show(div));
    check('  pull/div is where it was, and origin too', tip('pull/div') === oursDiv && originTip('pull/div') === theirsDiv);

    const noUp = await act4({ action: 'pull', branch: 'rb/plain' });
    check('a pull with no upstream → 409', refusedWith(noUp, 409, /^rb\/plain has no upstream/), show(noUp));
    const nowhere = await act4({ action: 'pull', branch: 'side' });
    check("a pull of a branch that isn't checked out → 409", refusedWith(nowhere, 409, /^side isn't checked out/), show(nowhere));
    writeFileSync(join(wt4('pull/dirty'), 'c.txt'), 'edited, not committed\n');
    const dirty = await act4({ action: 'pull', branch: 'pull/dirty' });
    check('a pull with tracked changes → 409', refusedWith(dirty, 409, /^pull\/dirty's checkout has changes/), show(dirty));
    check('  and the change is still there', readFileSync(join(wt4('pull/dirty'), 'c.txt'), 'utf8').startsWith('edited'));
    const dirtyRb = await act4({ action: 'rebase', branch: 'pull/dirty' });
    check('a rebase with tracked changes → 409', refusedWith(dirtyRb, 409, /^pull\/dirty's checkout has changes/), show(dirtyRb));

    const livePull = await act4({ action: 'pull', branch: 'rb/live' });
    const liveRb = await act4({ action: 'rebase', branch: 'rb/live' });
    const liveTip = tip('rb/live');
    check('a live agent → 409, for pull and for rebase', refusedWith(livePull, 409, /an agent is working on this branch/) && refusedWith(liveRb, 409, /an agent is working on this branch/), `${show(livePull)} | ${show(liveRb)}`);
    check('  and rb/live did not move', tip('rb/live') === liveTip);

    const plainBefore = tip('rb/plain');
    const rb = await act4({ action: 'rebase', branch: 'rb/plain' });
    check('a rebase onto main (the default) → 200, ok', rb.status === 200 && rb.body.ok === true && rb.body.into === 'main', show(rb));
    check('  rb/plain now sits on main, one commit on top, rewritten', sh(REPO4, 'rev-parse', `${tip('rb/plain')}^`) === tip('main') && tip('rb/plain') !== plainBefore && rb.body.sha === tip('rb/plain'));
    check('  its checkout is clean and on rb/plain', sh(wt4('rb/plain'), 'status', '--porcelain') === '' && sh(wt4('rb/plain'), 'symbolic-ref', '--short', 'HEAD') === 'rb/plain');
    check('  and nothing has it marked rebased (it was never pushed)', !byName(rb.body.branches, 'rb/plain')?.rebased);
    const rbAgain = await act4({ action: 'rebase', branch: 'rb/plain' });
    check('rebasing it again → 409 nothing to rebase', refusedWith(rbAgain, 409, /^nothing to rebase — rb\/plain already has every commit on main/), show(rbAgain));
    const onSide = await act4({ action: 'rebase', branch: 'rb/plain', onto: 'side' });
    check('onto another branch it already has → 409 nothing to rebase', refusedWith(onSide, 409, /already has every commit on side/), show(onSide));
    const self = await act4({ action: 'rebase', branch: 'rb/plain', onto: 'rb/plain' });
    check('onto itself → 400', self.status === 400, show(self));
    const dash = await act4({ action: 'rebase', branch: 'rb/plain', onto: '--onto' });
    check("onto a name starting with '-' → 400", dash.status === 400, show(dash));

    const clashBefore = tip('rb/clash');
    const clash = await act4({ action: 'rebase', branch: 'rb/clash' });
    check('a rebase that conflicts → 200, ok: false, with the files', clash.status === 200 && clash.body.ok === false && clash.body.conflict?.branch === 'rb/clash' && clash.body.conflict.files.join() === 'c.txt', show(clash));
    const rebaseDir = sh(wt4('rb/clash'), 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge');
    check('  the tree is clean, no rebase is in progress, and rb/clash is where it was', sh(wt4('rb/clash'), 'status', '--porcelain') === '' && !existsSync(rebaseDir) && tip('rb/clash') === clashBefore && sh(wt4('rb/clash'), 'symbolic-ref', '--short', 'HEAD') === 'rb/clash');
    check('  and its file is its own again', readFileSync(join(wt4('rb/clash'), 'c.txt'), 'utf8') === 'from clash\n');

    const pushedOrigin = originTip('rb/pushed');
    const before = await get<BranchesResponse>(URL4);
    check('a pushed branch is not marked rebased before it is', before.status === 200 && byName(before.body, 'rb/pushed')?.rebased === undefined && byName(before.body, 'rb/pushed')?.upstream !== null);
    const rbPushed = await act4({ action: 'rebase', branch: 'rb/pushed' });
    check('a pushed branch rebases → 200, ok', rbPushed.status === 200 && rbPushed.body.ok === true && sh(REPO4, 'rev-parse', `${tip('rb/pushed')}^`) === tip('main'), show(rbPushed));
    const marked = byName(rbPushed.body.branches, 'rb/pushed');
    check('  the listing marks it rebased, diverged from its upstream', marked?.rebased === true && marked.upstream?.ahead === 2 && marked.upstream.behind === 1, JSON.stringify(marked));
    const forced = await act4({ action: 'push', branch: 'rb/pushed' });
    check('  and its next push → 409, saying it needs a force Conductor never does', refusedWith(forced, 409, /^rb\/pushed was rebased after it was pushed/) && forced.body.detail === FORCE_SENTENCE, show(forced));
    check('  origin was not touched', originTip('rb/pushed') === pushedOrigin);

    const code = readFileSync(new globalThis.URL('./branches.ts', import.meta.url), 'utf8');
    check("the code never forces: no '--force', '--force-with-lease', '-f' or '+' refspec", !/'--force/.test(code) && !/'-f'/.test(code) && !/`\+\$\{/.test(code));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n15 · every repo Files shows, on Branches (N4)");
  {
    const project5 = insertProject(db, { path: REPO5, name: 'repos-verify', defaultBranch: 'main' });
    for (const dir of [EXTRA5, EXTRA5_PLAIN, join(REPO5, 'sub')]) addProjectDir(db, project5.id, dir);
    const URL5 = `/api/projects/${project5.id}/branches`;
    const q = (repo: string): string => `?repo=${encodeURIComponent(repo)}`;
    const in5 = (repo: string, body: unknown) => post<BranchActionResult & Err>(`${URL5}${q(repo)}`, body);
    const show = (r: Reply<unknown>): string => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
    const tipIn = (dir: string, name: string): string => sh(dir, 'rev-parse', `refs/heads/${name}`);
    const refs = (dir: string): string => sh(dir, 'for-each-ref', '--format=%(refname) %(objectname)');

    const own = await get<BranchesResponse>(URL5);
    const paths = (own.body.repos ?? []).map((r) => r.path);
    check('the listing names its repo, and lists every repo: own, nested, nested in that, extra, nested in an extra', own.status === 200 && own.body.repo === REPO5 && paths.join() === [REPO5, NESTED5, DEEPER5, EXTRA5, EXTRA5_DEEP].join(), show(own));
    check('  only the own folder is main, and each is named by folder and path', (own.body.repos ?? []).map((r) => `${r.name}${r.main ? '*' : ''}`).join() === 'repo5*,repo5/inner,repo5/inner/deeper,extra5,extra5-plain/deep', JSON.stringify(own.body.repos));
    check("  an extra directory inside the project's repo is that repo, not another", !paths.includes(join(REPO5, 'sub')));
    check('  without ?repo it is the own folder, as before', !!byName(own.body, 'outer/only') && !byName(own.body, 'feat/n'));
    const explicit = await get<BranchesResponse>(`${URL5}${q(REPO5)}`);
    check('?repo= the own folder is the same listing', explicit.status === 200 && explicit.body.branches.map((b) => b.name).join() === own.body.branches.map((b) => b.name).join());

    const nested = await get<BranchesResponse>(`${URL5}${q(NESTED5)}`);
    check('the nested repo lists its own branches, none of the outer ones', nested.status === 200 && nested.body.repo === NESTED5 && !!byName(nested.body, 'feat/n') && !byName(nested.body, 'outer/only') && nested.body.target === 'main', show(nested));
    check('  and carries the same choices', (nested.body.repos ?? []).map((r) => r.path).join() === paths.join());
    check('  its jobs are none: no branch has a jobId', nested.body.branches.every((b) => b.jobId === null && !b.live));
    check("  same-named branches stay each repo's own", byName(nested.body, 'same')?.head === tipIn(NESTED5, 'same') && byName(own.body, 'same')?.head === tipIn(REPO5, 'same') && tipIn(NESTED5, 'same') !== tipIn(REPO5, 'same'));
    const extra = await get<BranchesResponse>(`${URL5}${q(EXTRA5)}`);
    check('the extra directory lists its branches', extra.status === 200 && !!byName(extra.body, 'x/one') && !byName(extra.body, 'feat/n'), show(extra));
    const deep = await get<BranchesResponse>(`${URL5}${q(DEEPER5)}`);
    const plainDeep = await get<BranchesResponse>(`${URL5}${q(EXTRA5_DEEP)}`);
    check('the repo nested in the nested one, and the one in a plain extra directory, list too', deep.status === 200 && deep.body.branches.length === 1 && plainDeep.status === 200 && plainDeep.body.branches.length === 1, `${show(deep)} | ${show(plainDeep)}`);

    const outside = [REPO, join(REPO5, 'link'), join(NESTED5, '..', '..', 'repo'), join(REPO5, 'sub'), EXTRA5_PLAIN, join(ROOT, 'no-such'), 'repo5'];
    const refusedAll = await Promise.all(outside.map((r) => get<Err>(`${URL5}${q(r)}`)));
    check('a repo outside the set → 400: another project, a symlink to it, a .. path, a plain folder, a missing one, a relative path', refusedAll.every((r) => r.status === 400 && /not one of repos-verify's repos/.test(r.body.error)), refusedAll.map(show).join(' | '));
    const before = refs(REPO);
    const postOut = await in5(REPO, { action: 'merge', branch: 'feature/two' });
    const previewOut = await get<Err>(`${URL5}/preview?branch=feature/two&into=main&repo=${encodeURIComponent(REPO)}`);
    check('  POST and the preview too, and the other repo is untouched', postOut.status === 400 && previewOut.status === 400 && refs(REPO) === before, `${show(postOut)} | ${show(previewOut)}`);
    const emptyRepo = await get<BranchesResponse>(`${URL5}?repo=`);
    check('  an empty ?repo= is the own folder', emptyRepo.status === 200 && emptyRepo.body.repo === REPO5);

    const outerRefs = refs(REPO5);
    const extraRefs = refs(EXTRA5);
    const prev = await get<BranchMergePreview>(`${URL5}/preview?branch=feat/n&into=main&repo=${encodeURIComponent(NESTED5)}`);
    check("the preview reads the nested repo's branches", prev.status === 200 && prev.body.ahead === 1 && prev.body.reason === null, show(prev));
    const merged = await in5(NESTED5, { action: 'merge', branch: 'feat/n' });
    check('merging in the nested repo → 200, into its own main', merged.status === 200 && merged.body.ok === true && merged.body.branches.repo === NESTED5 && (merged.body.branches.repos ?? []).length === paths.length, show(merged));
    check('  its main has the commit; the outer repo and the extra one are untouched', sh(NESTED5, 'merge-base', '--is-ancestor', 'refs/heads/feat/n', 'refs/heads/main') === '' && refs(REPO5) === outerRefs && refs(EXTRA5) === extraRefs);
    const originOuter = refs(ORIGIN5);
    const pushed = await in5(NESTED5, { action: 'push', branch: 'feat/n' });
    check("pushing in the nested repo → 200, to the nested repo's origin only", pushed.status === 200 && tipIn(ORIGIN5N, 'feat/n') === tipIn(NESTED5, 'feat/n') && refs(ORIGIN5) === originOuter && refs(REPO5) === outerRefs, show(pushed));

    const rebased = await in5(NESTED5, { action: 'rebase', branch: 'same' });
    check("rebasing the nested repo's pushed `same` marks it rebased there", rebased.status === 200 && rebased.body.ok === true && byName(rebased.body.branches, 'same')?.rebased === true, show(rebased));
    const ownAfter = await get<BranchesResponse>(URL5);
    check("  and not the outer repo's `same`, behind its own upstream", byName(ownAfter.body, 'same')?.upstream?.behind === 1 && byName(ownAfter.body, 'same')?.rebased === undefined, JSON.stringify(byName(ownAfter.body, 'same')));
    const outerPush = await post<BranchActionResult & Err>(URL5, { action: 'push', branch: 'same' });
    check("  so the outer `same` isn't refused for the nested one's rebase", !/rebased after it was pushed/.test(`${outerPush.body.error ?? ''}`), show(outerPush));

    const setDef = await in5(NESTED5, { action: 'set_default', branch: 'feat/n' });
    check("set_default in the nested repo → 400: only the project's own folder has a default", setDef.status === 400 && /only the project's own folder has a default branch/.test(setDef.body.error) && getProject(db, project5.id)?.defaultBranch === 'main', show(setDef));

    const viaFinish = await projectRepo(db, project5.id, async () => {});
    check("projectRepo (the finished-job merge's) still opens the project's own folder", viaFinish?.root === REPO5 && viaFinish.path === REPO5);

    // An agent working in place reaches the nested repo: what it has checked out is live.
    insertJob(db, { id: 'job_inplace5', projectId: project5.id, prompt: 'in place', isolation: 'in_place', worktreePath: REPO5, branch: 'main', status: 'working', budgetUsd: null });
    insertAgent(db, {
      id: 'agt_inplace5',
      jobId: 'job_inplace5',
      projectId: project5.id,
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
    sh(NESTED5, 'checkout', '-q', '-b', 'feat/m');
    commitFile(NESTED5, 'm.txt', 'm\n', 'inner m');
    sh(NESTED5, 'checkout', '-q', 'main');
    const busy = await get<BranchesResponse>(`${URL5}${q(NESTED5)}`);
    const intoLive = await in5(NESTED5, { action: 'merge', branch: 'feat/m' });
    check('while an in_place agent works, the nested repo\'s checked-out branch is live, and a merge into it → 409', byName(busy.body, 'main')?.live === true && byName(busy.body, 'feat/m')?.live === false && intoLive.status === 409, show(intoLive));

    // Every agent is given the extra directories, a worktree job's too: in a repo there (or
    // one nested in a plain one) what is checked out is live while it works. A repo nested
    // only in the project's folder isn't in its worktree, nor given to it.
    setAgentStatus(db, 'agt_inplace5', 'done');
    insertJob(db, { id: 'job_wt5', projectId: project5.id, prompt: 'in a worktree', isolation: 'worktree', worktreePath: join(ROOT, 'wt5-job'), branch: 'conductor/job_wt5', status: 'working', budgetUsd: null });
    insertAgent(db, {
      id: 'agt_wt5',
      jobId: 'job_wt5',
      projectId: project5.id,
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
    sh(EXTRA5, 'checkout', '-q', 'x/one');
    commitFile(EXTRA5, 'one.txt', 'one\n', 'extra one');
    sh(EXTRA5, 'checkout', '-q', 'main');
    const extraRefs2 = refs(EXTRA5);
    const extraBusy = await get<BranchesResponse>(`${URL5}${q(EXTRA5)}`);
    const deepBusy = await get<BranchesResponse>(`${URL5}${q(EXTRA5_DEEP)}`);
    check("while a worktree job's agent works, the extra directory's checked-out branch is live, and only it", byName(extraBusy.body, 'main')?.live === true && byName(extraBusy.body, 'x/one')?.live === false && extraBusy.body.rootLive === true, show(extraBusy));
    check('  and the one nested in a plain extra directory', byName(deepBusy.body, 'main')?.live === true, show(deepBusy));
    const busyReplies = await Promise.all([
      in5(EXTRA5, { action: 'pull', branch: 'main' }),
      in5(EXTRA5, { action: 'rebase', branch: 'main', onto: 'x/one' }),
      in5(EXTRA5, { action: 'merge', branch: 'x/one' }),
      in5(EXTRA5_DEEP, { action: 'pull', branch: 'main' }),
    ]);
    check('  pull, rebase and merge into it → 409, as on a job\'s live branch, and nothing moves', busyReplies.every((r) => r.status === 409 && /an agent is working on this branch/.test(r.body.error)) && refs(EXTRA5) === extraRefs2, busyReplies.map(show).join(' | '));
    const nestedFree = await get<BranchesResponse>(`${URL5}${q(NESTED5)}`);
    const intoFree = await in5(NESTED5, { action: 'merge', branch: 'feat/m' });
    check("  the repo nested only in the project's folder isn't live for it: a merge into its main → 200", byName(nestedFree.body, 'main')?.live === false && nestedFree.body.rootLive === false && intoFree.status === 200 && intoFree.body.ok === true, show(intoFree));
    setAgentStatus(db, 'agt_wt5', 'done');
    const extraFree = await get<BranchesResponse>(`${URL5}${q(EXTRA5)}`);
    check('  once it has finished, the extra directory\'s branch is free again', byName(extraFree.body, 'main')?.live === false && extraFree.body.rootLive === false, show(extraFree));
  }

  // ───────────────────────────────────────────────────────────────────────────
  ws.close();
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 109 branches: PASS — ${checks} checks: listing, merge, merge_all, conflicts, commit, push, fetch, refusals, merge into any branch, preview, default branch (Amendment 117), deleting merged branches (Amendment 143), pull and rebase (N3), every repo Files shows (N4).\n`
      : `\nAmendment 109 branches: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
