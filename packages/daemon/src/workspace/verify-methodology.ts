/**
 * Amendment 115 verify — a git methodology per launch, end to end, against a throwaway repo
 * (ADR 0009 §4): the default branch in the folder (`in_place`), a branch you name (a
 * worktree on it), a new branch per launch (as before).
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/workspace/verify-methodology.ts
 *
 * Needs no fixture and starts no agent: everything is held (`supervisor().hold()`) and the
 * SDK throws if anything reaches it. All of it is under one folder in tmpdir(), removed at
 * the end.
 *
 * If you interrupt it, the listener on 7816 stays up and the next run dies with
 * EADDRINUSE:  lsof -ti :7816 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BranchesResponse, CreateJobResponse } from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { modelSources } from '../session/models.js';
import { sdk } from '../session/runner.js';
import { insertProject, listJobs, setDefaultBranch } from '../session/store.js';
import { supervisor } from '../session/supervisor.js';
import { listWorktrees } from './git.js';
import { branchNameProblem, branchRefusal } from './worktree.js';
import { remoteOnlyNames } from './branches.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7816;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-methodology-verify-')));
const REPO = join(ROOT, 'repo');
const ELSEWHERE = join(ROOT, 'elsewhere');
const PLAIN = join(ROOT, 'not-a-repo');
const ORIGIN = join(ROOT, 'origin.git');
const CLONE = join(ROOT, 'clone');

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

async function post<T>(path: string, body: unknown): Promise<Reply<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=v@example.invalid', '-c', 'user.name=Verify', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(cwd: string, file: string, text: string, subject: string): string {
  writeFileSync(join(cwd, file), text);
  sh(cwd, 'add', '--', file);
  sh(cwd, 'commit', '-q', '-m', subject);
  return sh(cwd, 'rev-parse', 'HEAD');
}

const branchExists = (name: string): boolean => {
  try {
    sh(REPO, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
};

const OPUS = 'claude-opus-4-1';

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  mkdirSync(PLAIN);
  sh(ROOT, 'init', '-q', '-b', 'main', REPO);
  const first = commitFile(REPO, 'a.txt', 'one\n', 'start');
  // topic/kept: two commits main does not have. A `-B` would move it onto main.
  sh(REPO, 'switch', '-q', '-c', 'topic/kept');
  commitFile(REPO, 'kept.txt', 'mine\n', 'kept: first');
  const keptTip = commitFile(REPO, 'kept.txt', 'mine\nand more\n', 'kept: second');
  sh(REPO, 'switch', '-q', 'main');
  const mainTip = commitFile(REPO, 'a.txt', 'one\nmain moves on\n', 'main moves on');
  sh(REPO, 'branch', 'alt', 'main');
  // A branch another worktree, outside Conductor's own folder, already has.
  sh(REPO, 'branch', 'side', 'main');
  sh(REPO, 'worktree', 'add', '-q', ELSEWHERE, 'side');

  sdk.query = (() => {
    throw new Error('verify started a real agent');
  }) as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  // Nothing starts: a launch is a job and its queued agents, and that is all this checks.
  await supervisor().hold();

  const project = insertProject(db, { path: REPO, name: 'methodology-verify', defaultBranch: 'main' });
  const plain = insertProject(db, { path: PLAIN, name: 'not-a-repo', defaultBranch: 'main' });
  const agents = [{ role: 'developer', model: OPUS }];
  const launch = (extra: Record<string, unknown>, projectId = project.id) =>
    post<CreateJobResponse & Err>('/api/jobs', { projectId, prompt: 'do it', agents, ...extra });
  const jobsNow = (): number => listJobs(db).length;
  const trees = async (): Promise<number> => (await listWorktrees(REPO)).length;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the pure rules');
  check('a good name has no problem', (await branchNameProblem(REPO, 'feature/refresh-tokens')) === null);
  for (const bad of ['', '  ', 'two words', 'a..b', '-x', '--evil', '@', '@{-1}', 'HEAD', 'x.lock', 'x/', '/x', 'x//y', '.x', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'refs/heads/x']) {
    check(`"${bad}" is not a name`, (await branchNameProblem(REPO, bad)) !== null);
  }
  const wts = [
    { path: REPO, branch: 'main', head: null, locked: false, prunable: false },
    { path: ELSEWHERE, branch: 'side', head: null, locked: false, prunable: false },
  ];
  check('a default branch is refused, naming it', /default branch/.test(branchRefusal('main', ['main'], wts, REPO) ?? ''));
  check('a default branch is refused even when no worktree has it', branchRefusal('alt', ['alt'], wts, REPO) !== null);
  check('a branch another worktree has is refused, naming where', (branchRefusal('side', ['main'], wts, REPO) ?? '').includes(ELSEWHERE));
  check("the project's own folder is called that", /project's own folder/.test(branchRefusal('main', [], wts, REPO) ?? ''));
  check('an existing branch nobody has, and a new one, are not refused', branchRefusal('alt', ['main'], wts, REPO) === null && branchRefusal('brand/new', ['main'], wts, REPO) === null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · (3) a new branch per launch is as before');
  const per = await launch({ isolation: 'worktree' });
  check('201', per.status === 201, JSON.stringify(per.body));
  check('on conductor/<jobId>', per.body.job?.branch === `conductor/${per.body.job?.id}`, per.body.job?.branch);
  check('in its own worktree under .conductor/wt', per.body.job?.worktreePath === join(REPO, '.conductor', 'wt', per.body.job?.id ?? '') && existsSync(per.body.job?.worktreePath ?? ''));
  check('whose branch is checked out there', sh(per.body.job!.worktreePath, 'branch', '--show-current') === per.body.job?.branch);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · (2) a branch you name: a new one');
  const treesBefore = await trees();
  check('it does not exist yet', !branchExists('feature/refresh'));
  const named = await launch({ isolation: 'worktree', branch: 'feature/refresh' });
  check('201', named.status === 201, JSON.stringify(named.body));
  check('the job is on that branch, as a worktree', named.body.job?.branch === 'feature/refresh' && named.body.job.isolation === 'worktree', JSON.stringify(named.body.job));
  const namedPath = named.body.job?.worktreePath ?? '';
  check('in its own folder under .conductor/wt, not the project folder', namedPath === join(REPO, '.conductor', 'wt', named.body.job?.id ?? '') && existsSync(namedPath));
  check('the branch exists now, and is checked out in that folder', branchExists('feature/refresh') && sh(namedPath, 'branch', '--show-current') === 'feature/refresh');
  check('cut from the folder\'s HEAD (main as it is now)', sh(namedPath, 'rev-parse', 'HEAD') === mainTip && mainTip !== first);
  check("the project folder is untouched: still on main", sh(REPO, 'branch', '--show-current') === 'main');
  check('one more worktree', (await trees()) === treesBefore + 1);
  check('its agent is queued', named.body.agents?.length === 1 && named.body.agents[0]?.status === 'queued');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · (2) a branch you name: one that exists keeps its commits');
  check('topic/kept has its own commits, not main\'s', sh(REPO, 'rev-parse', 'refs/heads/topic/kept') === keptTip && keptTip !== mainTip);
  const kept = await launch({ isolation: 'worktree', branch: 'topic/kept' });
  check('201', kept.status === 201, JSON.stringify(kept.body));
  check('the job is on it', kept.body.job?.branch === 'topic/kept');
  const keptPath = kept.body.job?.worktreePath ?? '';
  check('the branch was not moved: no -B', sh(REPO, 'rev-parse', 'refs/heads/topic/kept') === keptTip);
  check('the worktree is at its tip, with its commits in it', sh(keptPath, 'rev-parse', 'HEAD') === keptTip && readFileSync(join(keptPath, 'kept.txt'), 'utf8') === 'mine\nand more\n');
  check('and a branch git already has is not "created" again', sh(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/topic/').split('\n').join() === 'topic/kept');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · an invalid name gives 400, and nothing is made');
  const jobsBefore = jobsNow();
  const wtBefore = await trees();
  const refsBefore = sh(REPO, 'for-each-ref', '--format=%(refname)', 'refs/heads');
  for (const bad of ['two words', 'a..b', '-x', '@{-1}', 'HEAD', 'x.lock', 'x/', '@', 'refs/heads/x']) {
    const r = await launch({ isolation: 'worktree', branch: bad });
    check(`"${bad}" → 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  }
  const why = await launch({ isolation: 'worktree', branch: 'two words' });
  check('and says why', /not a branch name/.test(why.body.detail ?? ''), JSON.stringify(why.body));
  for (const [what, extra] of [
    ['an empty name', { branch: '' }],
    ['a name that is not a string', { branch: 7 }],
    ['a name with in_place', { isolation: 'in_place', branch: 'feature/x' }],
    ["a name with 'branch' isolation", { isolation: 'branch', branch: 'feature/x' }],
  ] as const) {
    const r = await launch({ isolation: 'worktree', ...extra });
    check(`${what} → 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  }
  check('no job, no worktree, no branch was made by any of them', jobsNow() === jobsBefore && (await trees()) === wtBefore && sh(REPO, 'for-each-ref', '--format=%(refname)', 'refs/heads') === refsBefore);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · a branch checked out elsewhere gives 409');
  const again = await launch({ isolation: 'worktree', branch: 'feature/refresh' });
  check("one a job's worktree has → 409", again.status === 409, `${again.status} ${JSON.stringify(again.body)}`);
  check('naming where it is', (again.body.detail ?? '').includes(namedPath), again.body.detail);
  const side = await launch({ isolation: 'worktree', branch: 'side' });
  check('one a worktree of your own has → 409', side.status === 409 && (side.body.detail ?? '').includes(ELSEWHERE), `${side.status} ${JSON.stringify(side.body)}`);
  sh(REPO, 'switch', '-q', '-c', 'wip');
  const inFolder = await launch({ isolation: 'worktree', branch: 'wip' });
  check("one the project's own folder is on → 409, and says so", inFolder.status === 409 && /project's own folder/.test(inFolder.body.detail ?? ''), `${inFolder.status} ${JSON.stringify(inFolder.body)}`);
  sh(REPO, 'switch', '-q', 'main');
  check('none of them made a job or a worktree', jobsNow() === jobsBefore + 0 && (await trees()) === wtBefore);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n7 · the project's default branch is refused (409)");
  const def = await launch({ isolation: 'worktree', branch: 'main' });
  check('main, the recorded default → 409', def.status === 409 && /default branch/.test(def.body.detail ?? ''), `${def.status} ${JSON.stringify(def.body)}`);
  check('even when the folder is on another branch', await (async () => {
    sh(REPO, 'switch', '-q', 'alt');
    try {
      const r = await launch({ isolation: 'worktree', branch: 'main' });
      return r.status === 409 && /default branch/.test(r.body.detail ?? '');
    } finally {
      sh(REPO, 'switch', '-q', 'main');
    }
  })());
  setDefaultBranch(db, project.id, 'alt');
  const chosen = await launch({ isolation: 'worktree', branch: 'alt' });
  check('a default chosen on the Branches screen (Amendment 117) is refused too', chosen.status === 409 && /default branch/.test(chosen.body.detail ?? ''), `${chosen.status} ${JSON.stringify(chosen.body)}`);
  setDefaultBranch(db, project.id, 'main');
  const nowOk = await launch({ isolation: 'worktree', branch: 'alt' });
  check('and once it is not the default, it can be named', nowOk.status === 201 && nowOk.body.job?.branch === 'alt', `${nowOk.status} ${JSON.stringify(nowOk.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8 · two launches naming one new branch at once: one wins, the other is a 409');
  const [x, y] = await Promise.all([
    launch({ isolation: 'worktree', branch: 'race/one' }),
    launch({ isolation: 'worktree', branch: 'race/one' }),
  ]);
  const codes = [x.status, y.status].sort().join();
  check('201 and 409', codes === '201,409', `${x.status} ${JSON.stringify(x.body)} / ${y.status} ${JSON.stringify(y.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · (1) the default branch, in the folder: in_place is unchanged');
  const wtMid = await trees();
  const jobsMid = jobsNow();
  const inPlace = await launch({ isolation: 'in_place' });
  check('201', inPlace.status === 201, JSON.stringify(inPlace.body));
  check("works in the project's own folder, on what is checked out there", inPlace.body.job?.worktreePath === REPO && inPlace.body.job.branch === 'main' && inPlace.body.job.isolation === 'in_place', JSON.stringify(inPlace.body.job));
  check('no worktree and no branch was made', (await trees()) === wtMid && !branchExists(`conductor/${inPlace.body.job?.id}`) && jobsNow() === jobsMid + 1);
  const plainJob = await launch({ isolation: 'in_place' }, plain.id);
  check('and still needs no git at all', plainJob.status === 201 && plainJob.body.job?.worktreePath === realpathSync(PLAIN), JSON.stringify(plainJob.body));
  const plainNamed = await launch({ isolation: 'worktree', branch: 'feature/x' }, plain.id);
  check('a name in a folder with no git → 400 (not a repo), as a worktree always was', plainNamed.status === 400, `${plainNamed.status} ${JSON.stringify(plainNamed.body)}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n10 · the API still accepts 'branch' isolation");
  const inPlaceBranch = await launch({ isolation: 'branch' });
  check('201, on a new conductor/<jobId> in the folder', inPlaceBranch.status === 201 && inPlaceBranch.body.job?.branch === `conductor/${inPlaceBranch.body.job?.id}` && inPlaceBranch.body.job.worktreePath === REPO, `${inPlaceBranch.status} ${JSON.stringify(inPlaceBranch.body)}`);
  sh(REPO, 'switch', '-q', 'main');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · a branch only on origin is tracked, and listed for the picker (Amendment 139)');
  // A bare origin with main and two branches the project has never had locally; fetched
  // once, and then one of them moves on origin without another fetch.
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  sh(REPO, 'remote', 'add', 'origin', ORIGIN);
  sh(REPO, 'push', '-q', 'origin', 'main');
  sh(ROOT, 'clone', '-q', ORIGIN, CLONE);
  sh(CLONE, 'switch', '-q', '-c', 'remote/only');
  const originTip = commitFile(CLONE, 'remote.txt', 'from origin\n', 'remote: first');
  sh(CLONE, 'push', '-q', 'origin', 'remote/only');
  sh(CLONE, 'switch', '-q', '-c', 'remote/other', 'main');
  commitFile(CLONE, 'other.txt', 'other\n', 'other: first');
  sh(CLONE, 'push', '-q', 'origin', 'remote/other');
  sh(REPO, 'fetch', '-q', 'origin');
  sh(REPO, 'remote', 'set-head', 'origin', 'main');
  sh(CLONE, 'switch', '-q', 'remote/only');
  const unfetched = commitFile(CLONE, 'remote.txt', 'from origin\nnot fetched yet\n', 'remote: second');
  sh(CLONE, 'push', '-q', 'origin', 'remote/only');
  check('remote/only is on origin and not a local branch', !branchExists('remote/only') && sh(REPO, 'rev-parse', 'refs/remotes/origin/remote/only') === originTip);

  const getBranches = async (): Promise<BranchesResponse> =>
    (await fetch(`${BASE}/api/projects/${project.id}/branches`)).json() as Promise<BranchesResponse>;
  const listed = await getBranches();
  check("the listing has remoteOnly: origin's branches with no local one, sorted", JSON.stringify(listed.remoteOnly) === JSON.stringify(['remote/only', 'remote/other']), JSON.stringify(listed.remoteOnly));
  check('origin/HEAD and main (which has a local branch) are not in it', !(listed.remoteOnly ?? []).includes('HEAD') && !(listed.remoteOnly ?? []).includes('main'));
  check('remoteOnlyNames is that rule, pure', remoteOnlyNames(['b', 'a', 'main', 'a'], ['main']).join() === 'a,b' && remoteOnlyNames([], ['main']).length === 0);

  const tracked = await launch({ isolation: 'worktree', branch: 'remote/only' });
  check('a launch naming it → 201', tracked.status === 201, `${tracked.status} ${JSON.stringify(tracked.body)}`);
  const trackedPath = tracked.body.job?.worktreePath ?? '';
  check('the job is on remote/only, in its own worktree', tracked.body.job?.branch === 'remote/only' && existsSync(trackedPath) && sh(trackedPath, 'branch', '--show-current') === 'remote/only');
  check('a local branch now, whose upstream is origin/remote/only', branchExists('remote/only') && sh(REPO, 'rev-parse', '--abbrev-ref', 'remote/only@{upstream}') === 'origin/remote/only');
  check("at origin's tip as last fetched, with origin's file in it, not cut from main", sh(trackedPath, 'rev-parse', 'HEAD') === originTip && readFileSync(join(trackedPath, 'remote.txt'), 'utf8') === 'from origin\n' && originTip !== mainTip);
  check('nothing was fetched: the later push to origin is not here', sh(REPO, 'rev-parse', 'refs/remotes/origin/remote/only') === originTip && unfetched !== originTip);
  check('the listing no longer has it as origin-only', JSON.stringify((await getBranches()).remoteOnly) === JSON.stringify(['remote/other']));
  const twice = await launch({ isolation: 'worktree', branch: 'remote/only' });
  check('naming it again is the usual 409, naming where', twice.status === 409 && (twice.body.detail ?? '').includes(trackedPath), `${twice.status} ${JSON.stringify(twice.body)}`);
  check('a bad name is still 400 first', (await launch({ isolation: 'worktree', branch: 'remote..only' })).status === 400);
  check('the default branch is still refused, though origin has it too', (await launch({ isolation: 'worktree', branch: 'main' })).status === 409);
  const fresh = await launch({ isolation: 'worktree', branch: 'nowhere/yet' });
  const noUpstream = (() => {
    try {
      sh(REPO, 'rev-parse', '--abbrev-ref', 'nowhere/yet@{upstream}');
      return false;
    } catch {
      return true;
    }
  })();
  check('a name neither has is still cut from HEAD, with no upstream', fresh.status === 201 && sh(fresh.body.job!.worktreePath, 'rev-parse', 'HEAD') === mainTip && noUpstream, `${fresh.status} ${JSON.stringify(fresh.body)}`);

  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 115 methodology: PASS — ${checks} checks: a branch you name (new, or existing with its commits kept), invalid names 400, a default branch or one checked out elsewhere 409, a new branch per launch and in_place unchanged; a branch only on origin tracked from it, unfetched, and listed as remoteOnly (Amendment 139).\n`
      : `\nAmendment 115 methodology: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
