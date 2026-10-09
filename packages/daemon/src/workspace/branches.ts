/**
 * A project's branches: list them against the default branch, merge them into it, commit
 * a branch's uncommitted work, push, fetch (Amendment 109, ADR 0008).
 *
 * The first code in the daemon that writes history and talks to a remote, so it is
 * deliberately narrow:
 *   - every call goes through `git()` (execFile, never a shell), with fixed argument lists;
 *   - a branch name is used only after it is found in `for-each-ref refs/heads`, a name
 *     starting with '-' is refused before that, and every ref is passed fully qualified
 *     (`refs/heads/<name>`) and after `--` where git takes it, so no name can become an option;
 *   - nothing is ever forced: push names an explicit `src:dst` refspec without '+', so a
 *     configured `remote.origin.push = +…` is never used, and there is no `--force` anywhere;
 *   - fetch never prunes;
 *   - every mutating action holds `branches:<repoRoot>` so two never interleave.
 *
 * Nothing newer than git 2.30 is used.
 */

import type {
  BranchTargetSource,
  BranchAction,
  BranchActionResult,
  BranchCommit,
  BranchesResponse,
  BranchInfo,
  BranchMergePreview,
} from '@conductor/shared';
import { GitError, git, gitBoth, gitOk, isRepo, listWorktrees, repoRoot } from './git.js';
import { KeyedLock } from './lock.js';

/** Push and fetch give up after this long: a remote that never answers is a 504. */
export const REMOTE_TIMEOUT_MS = 60_000;

/** `log target..branch` is cut at this many commits. */
const COMMITS_MAX = 20;

/** Git calls in flight at once while listing. A repo can have a hundred job branches. */
const LIST_CONCURRENCY = 8;

/** A refusal with its HTTP status, `{ error, detail }` on the wire. */
export class BranchError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'BranchError';
    this.status = status;
    this.detail = detail;
  }
}

/** What the store knows of a branch: the job it belongs to, and whether an agent is on it. */
export type BranchLookup = (branch: string) => { jobId: string | null; live: boolean };

export interface BranchRepo {
  projectId: string;
  /** The repo's top level. */
  root: string;
  /** The branch everything is drawn against: `resolveTarget`'s answer. */
  target: string;
  /** Where it came from. */
  targetFrom?: BranchTargetSource;
  lookup: BranchLookup;
}

const locks = new KeyedLock();

/**
 * The repo a project's path is in, or a 400, with the branch to draw against resolved.
 * `recorded` is the project's `defaultBranch`; `chosen` is the one you picked on the screen.
 */
export async function openRepo(
  projectId: string,
  path: string,
  recorded: string,
  lookup: BranchLookup,
  chosen: string | null = null,
): Promise<BranchRepo> {
  if (!(await isRepo(path))) throw new BranchError(400, 'not a git repo', path);
  const root = await repoRoot(path);
  const { target, from } = await resolveTarget(root, recorded, chosen);
  return { projectId, root, target, targetFrom: from, lookup };
}

/**
 * Which branch to draw everything against (Amendment 113). The project's `defaultBranch` is
 * whatever was checked out when it was added, and is never updated: a feature branch, or one
 * deleted since, which drew every other branch as unrelated to a branch that wasn't there.
 * So, the first of these that exists as a local branch:
 *
 *   1. the one you chose on the screen (`chosen`);
 *   2. origin's default branch, from `refs/remotes/origin/HEAD` (set by clone, or by
 *      `git remote set-head origin -a`);
 *   3. the one recorded when the project was added;
 *   4. `main`, then `master`;
 *   5. what the repo's own folder has checked out.
 *
 * With no local branch at all (a repo with no commits) it is the recorded one, from `project`.
 */
export async function resolveTarget(
  root: string,
  recorded: string,
  chosen: string | null,
): Promise<{ target: string; from: BranchTargetSource }> {
  const local = new Set(
    (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (chosen && local.has(chosen)) return { target: chosen, from: 'chosen' };
  const originHead = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  const fromOrigin = originHead.startsWith('origin/') ? originHead.slice('origin/'.length) : '';
  if (fromOrigin && local.has(fromOrigin)) return { target: fromOrigin, from: 'origin' };
  if (local.has(recorded)) return { target: recorded, from: 'project' };
  for (const name of ['main', 'master']) if (local.has(name)) return { target: name, from: 'main' };
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (head && local.has(head)) return { target: head, from: 'head' };
  const any = [...local][0];
  return any ? { target: any, from: 'head' } : { target: recorded, from: 'project' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing the request
// ─────────────────────────────────────────────────────────────────────────────

/** A `BranchAction` from a request body, or a 400 saying what is wrong with it. */
export function parseBranchAction(raw: unknown): BranchAction {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const action = body['action'];
  const branchOf = (): string => {
    const b = body['branch'];
    if (typeof b !== 'string' || b.length === 0) throw new BranchError(400, 'branch is required');
    if (b.startsWith('-')) throw new BranchError(400, 'not a branch name', b);
    return b;
  };
  switch (action) {
    case 'merge': {
      const branch = branchOf();
      const into = body['into'];
      if (into === undefined || into === null) return { action, branch };
      if (typeof into !== 'string' || into.length === 0) throw new BranchError(400, 'into must be a branch name');
      if (into.startsWith('-')) throw new BranchError(400, 'not a branch name', into);
      return { action, branch, into };
    }
    case 'push':
      return { action, branch: branchOf() };
    case 'commit': {
      const branch = branchOf();
      const message = body['message'];
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new BranchError(400, 'a commit needs a message');
      }
      return { action, branch, message: message.trim() };
    }
    case 'merge_all':
    case 'fetch':
      return { action };
    default:
      throw new BranchError(
        400,
        'unknown action',
        'one of merge, merge_all, commit, push, fetch',
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────

interface Ref {
  name: string;
  head: string;
  at: string;
  /** Full ref, `refs/remotes/origin/x`; '' when none is configured. */
  upstream: string;
  upstreamShort: string;
  subject: string;
}

const heads = (name: string): string => `refs/heads/${name}`;

function iso(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

async function readRefs(root: string): Promise<Ref[]> {
  const out = await git(root, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(upstream)%00%(upstream:short)%00%(subject)',
    'refs/heads',
  ]);
  const refs: Ref[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [refname = '', head = '', at = '', upstream = '', upstreamShort = '', ...rest] =
      line.split('\0');
    if (!refname.startsWith('refs/heads/')) continue;
    refs.push({
      name: refname.slice('refs/heads/'.length),
      head,
      at: iso(at),
      upstream,
      upstreamShort,
      subject: rest.join('\0'),
    });
  }
  return refs;
}

/** `rev-list --left-right --count a...b` → [left only, right only]. */
async function leftRight(root: string, a: string, b: string): Promise<[number, number]> {
  const out = (await git(root, ['rev-list', '--left-right', '--count', `${a}...${b}`, '--'])).trim();
  const [l = '0', r = '0'] = out.split(/\s+/);
  return [Number(l) || 0, Number(r) || 0];
}

async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(root, ['merge-base', a, b])).trim() || null;
  } catch {
    return null; // unrelated histories
  }
}

async function commitsOn(root: string, target: string, b: string): Promise<BranchCommit[]> {
  const out = await git(root, [
    'log',
    '--format=%H%x00%cI%x00%s',
    '-n',
    String(COMMITS_MAX),
    `${target}..${b}`,
    '--',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', at = '', ...subject] = line.split('\0');
      return { sha, at: iso(at), subject: subject.join('\0') };
    });
}

/** Files changed and not committed, untracked included; null when the checkout is unreadable. */
async function uncommitted(path: string): Promise<number | null> {
  try {
    return (await git(path, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/** No tracked changes: what a merge needs. Untracked files don't count; git won't overwrite them. */
async function trackedClean(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain', '-uno'])).trim().length === 0;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Where each branch is checked out. Prunable entries (the folder is gone) are skipped. */
async function checkouts(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const w of await listWorktrees(root)) {
    if (w.branch && !w.prunable && !map.has(w.branch)) map.set(w.branch, w.path);
  }
  return map;
}

export async function listBranches(repo: BranchRepo): Promise<BranchesResponse> {
  const { root, target } = repo;
  const [refs, where, remotes] = await Promise.all([
    readRefs(root),
    checkouts(root),
    git(root, ['remote']),
  ]);
  const hasTarget = refs.some((r) => r.name === target);
  const targetRef = heads(target);

  const branches = await mapLimit(refs, LIST_CONCURRENCY, async (r): Promise<BranchInfo> => {
    const ref = heads(r.name);
    const isTarget = r.name === target;
    let ahead = 0;
    let behind = 0;
    let forkedAt: string | null = null;
    let commits: BranchCommit[] = [];
    if (hasTarget && !isTarget) {
      [[behind, ahead], forkedAt, commits] = await Promise.all([
        leftRight(root, targetRef, ref),
        mergeBase(root, targetRef, ref),
        commitsOn(root, targetRef, ref),
      ]);
    } else if (isTarget) {
      forkedAt = r.head;
    }

    let upstream: BranchInfo['upstream'] = null;
    // A configured upstream whose remote branch is gone reads as "not on origin".
    if (r.upstream && (await gitOk(root, ['rev-parse', '--verify', '--quiet', r.upstream]))) {
      const [a, b] = await leftRight(root, ref, r.upstream);
      upstream = { ref: r.upstreamShort || r.upstream, ahead: a, behind: b };
    }

    const path = where.get(r.name);
    const count = path ? await uncommitted(path) : null;
    const { jobId, live } = repo.lookup(r.name);
    return {
      name: r.name,
      head: r.head,
      subject: r.subject,
      at: r.at,
      isTarget,
      ahead,
      behind,
      forkedAt,
      commits,
      worktree: path && count !== null ? { path, uncommitted: count } : null,
      jobId,
      live,
      upstream,
    };
  });

  branches.sort((a, b) => {
    if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const targetPath = hasTarget ? where.get(target) : undefined;
  let targetCheckout: BranchesResponse['targetCheckout'] = null;
  if (targetPath) {
    try {
      targetCheckout = { path: targetPath, clean: await trackedClean(targetPath) };
    } catch {
      targetCheckout = null;
    }
  }

  return {
    projectId: repo.projectId,
    target,
    ...(repo.targetFrom ? { targetFrom: repo.targetFrom } : {}),
    remote: remotes.split('\n').some((l) => l.trim() === 'origin') ? 'origin' : null,
    targetCheckout,
    branches,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

function known(state: BranchesResponse, name: string): BranchInfo {
  if (name.startsWith('-')) throw new BranchError(400, 'not a branch name', name);
  const b = state.branches.find((x) => x.name === name);
  if (!b) throw new BranchError(400, 'no such branch', name);
  return b;
}

function refuseLive(b: BranchInfo): void {
  if (b.live) {
    throw new BranchError(409, 'an agent is working on this branch', `${b.name}: wait for it to finish or stop it`);
  }
}

/** Where a merge runs, or the reason it can't. */
function mergeCheckout(state: BranchesResponse): string {
  const target = state.branches.find((b) => b.isTarget);
  if (!target || !state.targetCheckout) {
    throw new BranchError(409, `${state.target} isn't checked out`, `check out ${state.target} somewhere first`);
  }
  // An agent working in place on the target would have the merge land under it.
  refuseLive(target);
  if (!state.targetCheckout.clean) {
    throw new BranchError(
      409,
      `${state.target}'s checkout has changes`,
      `commit or discard the tracked changes in ${state.targetCheckout.path} first`,
    );
  }
  return state.targetCheckout.path;
}

/**
 * Where a merge into `into` would run, or the reason it can't (Amendment 110). The target
 * is `mergeCheckout`. Any other branch merges in the worktree it is checked out in: a
 * branch checked out nowhere is refused rather than checked out for the occasion, so a
 * merge never moves anyone's files but the branch's own.
 */
async function intoCheckout(state: BranchesResponse, into: BranchInfo): Promise<string> {
  if (into.isTarget) return mergeCheckout(state);
  if (!into.worktree) {
    throw new BranchError(409, `${into.name} isn't checked out`, `a merge lands in a checkout: check ${into.name} out somewhere first`);
  }
  refuseLive(into);
  if (!(await trackedClean(into.worktree.path))) {
    throw new BranchError(
      409,
      `${into.name}'s checkout has changes`,
      `commit or discard the tracked changes in ${into.worktree.path} first`,
    );
  }
  return into.worktree.path;
}

/** The branch a merge goes into: `into` when named, else the target. */
function intoOf(state: BranchesResponse, into: string | undefined): BranchInfo {
  if (into !== undefined) return known(state, into);
  const target = state.branches.find((b) => b.isTarget);
  if (!target) throw new BranchError(409, `${state.target} isn't checked out`, `there is no branch called ${state.target}`);
  return target;
}

interface MergePlan {
  from: BranchInfo;
  into: BranchInfo;
  ahead: number;
  behind: number;
  related: boolean;
}

/**
 * What a merge of `branch` into `into` checks before it needs a checkout, in the order the
 * refusals are given. The POST and the preview both come here, so the preview's reason is
 * the sentence the merge would answer with.
 */
async function planMerge(
  root: string,
  state: BranchesResponse,
  branch: string,
  intoName: string | undefined,
): Promise<MergePlan> {
  const from = known(state, branch);
  const into = intoOf(state, intoName);
  if (from.name === into.name) throw new BranchError(400, `can't merge ${into.name} into itself`);
  refuseLive(from);
  // Against the target the listing has counted already; against any other branch, count now.
  if (into.isTarget) return { from, into, ahead: from.ahead, behind: from.behind, related: from.forkedAt !== null };
  const [[behind, ahead], base] = await Promise.all([
    leftRight(root, heads(into.name), heads(from.name)),
    mergeBase(root, heads(into.name), heads(from.name)),
  ]);
  return { from, into, ahead, behind, related: base !== null };
}

/** The refusals that come after the checkout's: nothing to merge, nothing in common. */
function refuseEmpty(p: MergePlan): void {
  if (p.ahead === 0) throw new BranchError(409, 'nothing to merge', `${p.into.name} already has every commit on ${p.from.name}`);
  if (!p.related) throw new BranchError(409, 'unrelated histories', `${p.from.name} shares no history with ${p.into.name}`);
}

/**
 * The files merging `from` into `into` would conflict in, worked out in the object store
 * with `merge-tree --write-tree` (git 2.38): no checkout, no index, nothing to undo. [] for
 * a clean merge; null when this git is older and can't say. Only the preview uses it, so
 * the merge itself still needs nothing newer than 2.30.
 */
async function conflictsOf(root: string, into: string, from: string): Promise<string[] | null> {
  try {
    await git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', heads(into), heads(from)]);
    return [];
  } catch (err) {
    // Exit 1 is "it would conflict": the tree id, then one conflicted path per line.
    if (err instanceof GitError && err.code === 1 && err.stdout) {
      const files: string[] = [];
      for (const line of err.stdout.split('\n').slice(1)) {
        if (!line) break;
        if (!files.includes(line)) files.push(line);
      }
      return files;
    }
    return null;
  }
}

/** What merging `branch` into `into` (the target when absent) would do (Amendment 110). Reads only. */
export async function previewMerge(
  repo: BranchRepo,
  branch: string,
  into: string | undefined,
): Promise<BranchMergePreview> {
  if (!branch) throw new BranchError(400, 'branch is required');
  if (branch.startsWith('-')) throw new BranchError(400, 'not a branch name', branch);
  if (into !== undefined && into.startsWith('-')) throw new BranchError(400, 'not a branch name', into);
  const state = await listBranches(repo);
  const p = await planMerge(repo.root, state, branch, into || undefined);
  const commits = p.into.isTarget ? p.from.commits : await commitsOn(repo.root, heads(p.into.name), heads(p.from.name));
  let reason: string | null = null;
  try {
    await intoCheckout(state, p.into);
    refuseEmpty(p);
  } catch (err) {
    if (!(err instanceof BranchError)) throw err;
    reason = err.detail ? `${err.message} — ${err.detail}` : err.message;
  }
  const conflicts = p.ahead === 0 ? [] : p.related ? await conflictsOf(repo.root, p.into.name, p.from.name) : null;
  return { branch: p.from.name, into: p.into.name, ahead: p.ahead, behind: p.behind, commits, conflicts, reason };
}

type MergeOutcome = { sha: string } | { conflict: string[] };

async function mergeOne(cwd: string, target: string, branch: string): Promise<MergeOutcome> {
  try {
    await git(cwd, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge branch '${branch}' into ${target}`,
      '--',
      heads(branch),
    ]);
  } catch (err) {
    const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n')
      .filter(Boolean);
    // Undo whatever the merge left, conflict or not, so the checkout is as it was.
    if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) {
      await git(cwd, ['merge', '--abort']);
    }
    if (files.length > 0) return { conflict: files };
    throw err;
  }
  return { sha: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
}

/** Commits on `branch` that the target doesn't have, counted now (an earlier merge may include them). */
async function aheadNow(root: string, target: string, branch: string): Promise<number> {
  return (await leftRight(root, heads(target), heads(branch)))[1];
}

function sshEnv(): Record<string, string> {
  // SSH must not stop to ask for a passphrase; keys come from the agent, as in a terminal.
  return process.env['GIT_SSH_COMMAND'] ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

function remoteOf(state: BranchesResponse): string {
  if (!state.remote) throw new BranchError(409, 'the repo has no origin', 'add a remote called origin first');
  return state.remote;
}

const REJECTED = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to push/;

/** A push or fetch failure, in the ADR's codes. */
function remoteFailure(err: unknown, what: 'push' | 'fetch'): never {
  if (err instanceof GitError) {
    if (err.timedOut) {
      throw new BranchError(504, `${what} timed out`, `no answer from the remote in ${REMOTE_TIMEOUT_MS / 1000}s`);
    }
    if (what === 'push' && REJECTED.test(err.stderr)) {
      throw new BranchError(409, 'the push was rejected', err.stderr.trim());
    }
  }
  throw err;
}

function said(out: { stdout: string; stderr: string }): string {
  return [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join('\n');
}

/** Run one action under the repo's lock, and answer with the state after it. */
export async function branchAction(repo: BranchRepo, action: BranchAction): Promise<BranchActionResult> {
  return locks.run(`branches:${repo.root}`, async () => {
    const before = await listBranches(repo);
    const result = await act(repo, before, action);
    return { ...result, branches: await listBranches(repo) };
  });
}

async function act(
  repo: BranchRepo,
  state: BranchesResponse,
  action: BranchAction,
): Promise<Omit<BranchActionResult, 'branches'>> {
  const { root, target } = repo;

  switch (action.action) {
    case 'merge': {
      const p = await planMerge(root, state, action.branch, action.into);
      const cwd = await intoCheckout(state, p.into);
      refuseEmpty(p);
      const into = p.into.name;
      const out = await mergeOne(cwd, into, p.from.name);
      if ('conflict' in out) return { ok: false, merged: [], into, conflict: { branch: p.from.name, files: out.conflict } };
      return { ok: true, merged: [p.from.name], into, sha: out.sha };
    }

    case 'merge_all': {
      const cwd = mergeCheckout(state);
      const queue = state.branches
        .filter((b) => !b.isTarget && !b.live && b.ahead > 0 && b.forkedAt !== null)
        .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.name.localeCompare(b.name)));
      const merged: string[] = [];
      let sha: string | undefined;
      for (const b of queue) {
        if ((await aheadNow(root, target, b.name)) === 0) continue;
        const out = await mergeOne(cwd, target, b.name);
        if ('conflict' in out) {
          return { ok: false, merged, conflict: { branch: b.name, files: out.conflict }, ...(sha ? { sha } : {}) };
        }
        merged.push(b.name);
        sha = out.sha;
      }
      return { ok: true, merged, ...(sha ? { sha } : {}) };
    }

    case 'commit': {
      const b = known(state, action.branch);
      refuseLive(b);
      if (!b.worktree) throw new BranchError(409, `${b.name} isn't checked out`, 'there is no worktree to commit from');
      const message = action.message.trim();
      if (!message) throw new BranchError(400, 'a commit needs a message');
      const cwd = b.worktree.path;
      if (b.worktree.uncommitted === 0) throw new BranchError(409, 'nothing to commit', `${b.name} has no uncommitted changes`);
      // `add -A` respects .gitignore. Conductor's own folder of job worktrees is never added:
      // in a repo that doesn't ignore it, it would go in as embedded repositories.
      await git(cwd, ['add', '-A', '--', '.', ':(top,exclude).conductor']);
      if (await gitOk(cwd, ['diff', '--cached', '--quiet'])) {
        throw new BranchError(409, 'nothing to commit', `${b.name} has no changes git would commit`);
      }
      await git(cwd, ['commit', '-m', message]);
      return { ok: true, merged: [], sha: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
    }

    case 'push': {
      const b = known(state, action.branch);
      refuseLive(b);
      const remote = remoteOf(state);
      const ref = heads(b.name);
      const args = ['push', ...(b.upstream ? [] : ['-u']), '--', remote, `${ref}:${ref}`];
      try {
        const out = await gitBoth(root, args, { env: sshEnv(), timeoutMs: REMOTE_TIMEOUT_MS });
        return { ok: true, merged: [], output: said(out) };
      } catch (err) {
        remoteFailure(err, 'push');
      }
    }

    case 'fetch': {
      const remote = remoteOf(state);
      try {
        const out = await gitBoth(root, ['fetch', '--no-prune', '--', remote], {
          env: sshEnv(),
          timeoutMs: REMOTE_TIMEOUT_MS,
        });
        return { ok: true, merged: [], output: said(out) || 'Already up to date.' };
      } catch (err) {
        remoteFailure(err, 'fetch');
      }
    }
  }
}
