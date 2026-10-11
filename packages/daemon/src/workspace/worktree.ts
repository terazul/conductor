/**
 * WorktreeMgr — create, reuse and destroy the checkout a job works in.
 *
 * TRACK C owns this file.
 *
 * ONE WORKTREE PER JOB, NOT PER AGENT. Decided in CONTRACT.md §7 and encoded in
 * the `Isolation` type; this file is downstream of that decision, not a place to
 * revisit it. Agents inside a job are coordinated — sequential handoff, or
 * disjoint file scopes enforced by an Edit(path) deny rule. Worktree-per-agent
 * makes merge conflicts the product.
 *
 * Three isolations, and the difference matters because two of them are operating
 * on a checkout a human may also be sitting in:
 *
 *   worktree   `<repo>/.conductor/wt/<jobId>` on its own branch. The default and
 *              the only one that is fully safe: the human's checkout is untouched
 *              and `remove()` may delete the directory.
 *   branch     the repo itself, on a new branch. No new directory, so `remove()`
 *              must NOT delete anything — it only stops watching.
 *   in_place   the directory itself, on whatever branch it is already on. No git
 *              mutation at all — and no git *requirement* either: this is the
 *              isolation for a scratch folder that was never `git init`ed.
 *              `remove()` is bookkeeping only.
 *
 * Every mutation runs under the per-worktree lock, and every transition emits a
 * `worktree` event so the UI never has to poll to find out where a job lives.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Isolation } from '@conductor/shared';
import { eventLog } from '../eventlog.js';
import { resolveTarget } from './branches.js';
import {
  GitError,
  branchExists,
  currentBranch,
  git,
  hasHead,
  isRepo,
  listWorktrees,
  repoRoot,
  type WorktreeEntry,
} from './git.js';
import { KeyedLock } from './lock.js';
import { canonicalRoot } from './paths.js';
import type { WorkspaceRecord, WorkspaceStore } from './store.js';

/** Worktrees live under the repo so `git worktree list` stays the index of truth. */
export const WT_DIR = join('.conductor', 'wt');

/**
 * What `branch` says for an `in_place` workspace in a directory that is not a git
 * repository. A parenthesised non-branch, exactly like the `(detached)` that
 * `currentBranch` already returns for a detached HEAD — the UI renders it as-is
 * and nothing treats `branch` as a ref after creation.
 *
 * Deliberately NOT `null`: widening the field would mean a migration rebuilding
 * two NOT NULL columns, a change to the frozen `Job` wire type, and a fallback at
 * seven render sites, all to express something this string already says.
 */
export const NO_GIT_BRANCH = '(no git)';

export interface EnsureRequest {
  jobId: string;
  projectId: string;
  /** Absolute path to the repo root. */
  repoPath: string;
  isolation: Isolation;
  /** Branch to create/use. Defaults to `conductor/<jobId>` for worktree|branch. */
  branch?: string;
  /** Commit-ish the worktree is cut from. Defaults to HEAD. */
  baseRef?: string;
  /**
   * `branch` is one the user named at launch — methodology (2) (Amendment 115), `worktree`
   * only. The name is checked with git, a default branch or one checked out elsewhere is
   * refused, an existing branch is added as it is and a new one is cut from `baseRef`
   * (HEAD). Absent, `branch` keeps its old meaning: a name of Conductor's own, whose
   * leftover from an earlier attempt `-B` resets.
   */
  named?: boolean;
  /**
   * The project's recorded default branch and whether it was chosen on purpose (Amendment
   * 117), so a named branch can be refused when it is the default. Only read with `named`.
   */
  recordedDefault?: { branch: string; chosen: boolean };
}

/**
 * A named branch was refused (Amendment 115): 400 when the name is not one git accepts, 409
 * when it is the project's default branch or already checked out somewhere. `message` is the
 * sentence the person sees.
 */
export class LaunchBranchError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = 'LaunchBranchError';
    this.status = status;
  }
}

/**
 * Whether `name` is a branch name git accepts, by git's own rule (`check-ref-format
 * --branch`), or the sentence that says why not. The name must come back from git unchanged:
 * `--branch` also expands `@{-1}` to the previous branch's name, which is not a name anyone
 * typed on purpose. `@` alone and a leading `refs/` pass git's rule and are refused too:
 * the first is the ref HEAD's shorthand and the second makes `refs/heads/refs/heads/…`.
 */
export async function branchNameProblem(cwd: string, name: string): Promise<string | null> {
  if (name.trim().length === 0) return 'the branch needs a name';
  if (name === '@' || name.startsWith('refs/')) return `"${name}" is not a branch name`;
  try {
    const out = (await git(cwd, ['check-ref-format', '--branch', name])).trim();
    return out === name ? null : `"${name}" is not a branch name`;
  } catch (err) {
    if (err instanceof GitError && err.code === 128) return `"${name}" is not a branch name git accepts`;
    throw err;
  }
}

/**
 * Why a named branch cannot get a worktree of its own, or null when it can (Amendment 115).
 * Pure: `defaults` are the branches the project treats as its default, `worktrees` what
 * `git worktree list` says, the project's own folder (`root`) included.
 *
 * The default branch is refused even when nothing has it checked out: a named launch is for
 * work you want kept apart, and the default is what the folder is for (methodology 1). A
 * branch some worktree has checked out is refused because git would refuse it anyway, but
 * with a sentence that says where.
 */
export function branchRefusal(
  branch: string,
  defaults: readonly string[],
  worktrees: readonly WorktreeEntry[],
  root: string,
): string | null {
  if (defaults.includes(branch)) {
    return `${branch} is this project's default branch. Choose "default branch, in the folder" to work on it, or name a different branch.`;
  }
  const taken = worktrees.find((w) => w.branch === branch);
  if (taken) {
    const where = canonicalRoot(taken.path) === root ? "the project's own folder" : taken.path;
    return `${branch} is already checked out in ${where}. A branch can be checked out in one place at a time: name another, or finish the work there first.`;
  }
  return null;
}

export interface EnsureResult {
  workspace: WorkspaceRecord;
  /** 'created' the first time, 'reused' every time after. */
  event: 'created' | 'reused';
}

export class WorktreeMgr {
  #store: WorkspaceStore;
  #lock: KeyedLock;

  constructor(store: WorkspaceStore, lock: KeyedLock) {
    this.#store = store;
    this.#lock = lock;
  }

  /**
   * Idempotent. Call it on every job start: the second call reuses, it does not
   * fail, because a daemon restart mid-job must not orphan the checkout.
   */
  async ensure(req: EnsureRequest): Promise<EnsureResult> {
    return this.#lock.run(`job:${req.jobId}`, () => this.#ensureLocked(req));
  }

  async #ensureLocked(req: EnsureRequest): Promise<EnsureResult> {
    const repo = canonicalRoot(req.repoPath);
    const inRepo = await isRepo(repo);

    // Only two of the three isolations need git. `in_place` mutates nothing, so
    // demanding a repo there rejected the one mode that exists for scratch
    // directories — which is what the manual has always pointed people at.
    if (!inRepo && req.isolation !== 'in_place') {
      throw new Error(`${repo} is not a git repository`);
    }

    // A path inside a repo is not the same thing as the repo root, and a worktree
    // created from a subdirectory lands somewhere surprising. With no repo there
    // is no root to find: the directory the human named is the workspace.
    const root = inRepo ? canonicalRoot(await repoRoot(repo)) : repo;
    const branch = req.branch ?? `conductor/${req.jobId}`;

    const existing = this.#store.get(req.jobId);
    if (existing && !existing.removedAt && existsSync(existing.path)) {
      // Trust but verify: for worktree isolation the directory existing is not
      // enough, git has to still know about it.
      const stillRegistered =
        existing.isolation !== 'worktree' ||
        (await listWorktrees(root)).some((w) => canonicalRoot(w.path) === existing.path);
      if (stillRegistered) {
        this.#emit(existing, 'reused');
        return { workspace: existing, event: 'reused' };
      }
    }

    const result =
      req.isolation === 'worktree'
        ? await this.#ensureWorktree(req, root, branch)
        : req.isolation === 'branch'
          ? await this.#ensureBranch(req, root, branch)
          : await this.#ensureInPlace(req, root);

    this.#store.upsert(result.workspace);
    this.#emit(result.workspace, result.event);
    return result;
  }

  async #ensureWorktree(
    req: EnsureRequest,
    root: string,
    branch: string,
  ): Promise<EnsureResult> {
    const path = join(root, WT_DIR, req.jobId);
    const registered = await listWorktrees(root);
    const already = registered.find((w) => canonicalRoot(w.path) === canonicalRoot(path));

    let event: 'created' | 'reused' = 'created';

    if (already && existsSync(path)) {
      event = 'reused';
    } else {
      if (already) {
        // Registered but the directory is gone — a `rm -rf` outside git. Clear
        // the stale registration or `worktree add` refuses the path.
        await git(root, ['worktree', 'prune']);
      }
      mkdirSync(join(root, WT_DIR), { recursive: true });
      const baseRef = req.baseRef ?? ((await hasHead(root)) ? 'HEAD' : null);
      if (!baseRef) {
        throw new Error(
          `${root} has no commits yet — commit once before cutting a worktree from it`,
        );
      }
      if (req.named) {
        await this.#addNamed(req, root, branch, path, baseRef);
      } else {
        // -B so a leftover branch from a previous attempt is reset, not fatal.
        await git(root, ['worktree', 'add', '-B', branch, path, baseRef]);
      }
    }

    const real = canonicalRoot(path);
    return {
      event,
      workspace: {
        jobId: req.jobId,
        projectId: req.projectId,
        repoPath: root,
        path: real,
        branch,
        isolation: 'worktree',
        baseRef: await headSha(real),
        createdAt: new Date().toISOString(),
        removedAt: null,
      },
    };
  }

  /**
   * A worktree on a branch the user named (Amendment 115, methodology 2). Refused first, in
   * this order: a name git rejects (400), the project's default branch (409), a branch some
   * worktree already has checked out (409). Then an existing branch is added as it is, and
   * a new one is cut from `baseRef`.
   *
   * NEVER `-B`: it would move an existing branch to `baseRef` and lose its commits.
   * `-b` refuses a name that exists, so a race with a branch created since the check fails
   * loudly instead of resetting anything.
   *
   * The check and the add run under one lock for the repo, since two launches naming the
   * same branch hold different job locks: the second one sees the first's worktree and is
   * refused with the sentence, not with git's.
   */
  async #addNamed(
    req: EnsureRequest,
    root: string,
    branch: string,
    path: string,
    baseRef: string,
  ): Promise<void> {
    const bad = await branchNameProblem(root, branch);
    if (bad) throw new LaunchBranchError(400, bad);
    await this.#lock.run(`repo:${root}`, async () => {
      const defaults = new Set<string>();
      if (req.recordedDefault) {
        defaults.add(req.recordedDefault.branch);
        defaults.add(
          (await resolveTarget(root, req.recordedDefault.branch, null, req.recordedDefault.chosen))
            .target,
        );
      }
      const refusal = branchRefusal(branch, [...defaults], await listWorktrees(root), root);
      if (refusal) throw new LaunchBranchError(409, refusal);
      if (await branchExists(root, branch)) {
        await git(root, ['worktree', 'add', '--', path, branch]);
      } else {
        await git(root, ['worktree', 'add', '-b', branch, '--', path, baseRef]);
      }
    });
  }

  async #ensureBranch(req: EnsureRequest, root: string, branch: string): Promise<EnsureResult> {
    const on = await currentBranch(root);
    let event: 'created' | 'reused' = 'created';

    if (on === branch) {
      event = 'reused';
    } else if (await branchExists(root, branch)) {
      await git(root, ['checkout', branch]);
      event = 'reused';
    } else {
      await git(root, ['checkout', '-b', branch]);
    }

    return {
      event,
      workspace: {
        jobId: req.jobId,
        projectId: req.projectId,
        repoPath: root,
        path: root,
        branch,
        isolation: 'branch',
        baseRef: await headSha(root),
        createdAt: new Date().toISOString(),
        removedAt: null,
      },
    };
  }

  async #ensureInPlace(req: EnsureRequest, root: string): Promise<EnsureResult> {
    // The only isolation that runs without git at all, so it is the only one that
    // has to describe a workspace with no branch and no base commit.
    const inRepo = await isRepo(root);

    // Nothing is created and nothing is switched: the agent writes where the
    // human is standing. 'reused' is the honest event.
    return {
      event: 'reused',
      workspace: {
        jobId: req.jobId,
        projectId: req.projectId,
        repoPath: root,
        path: root,
        branch: inRepo ? await currentBranch(root) : NO_GIT_BRANCH,
        isolation: 'in_place',
        baseRef: inRepo ? await headSha(root) : null,
        createdAt: new Date().toISOString(),
        removedAt: null,
      },
    };
  }

  /**
   * Tear down. Only `worktree` isolation deletes anything — for `branch` and
   * `in_place` the directory is the user's own checkout, and a tidy-up that
   * deletes a human's working copy is the worst bug this daemon could have.
   *
   * `force` discards uncommitted work in the worktree. Without it, a dirty
   * worktree is left on disk and reported, because losing an agent's output
   * silently is worse than leaking a directory.
   */
  async remove(jobId: string, opts: { force?: boolean } = {}): Promise<{
    removed: boolean;
    reason?: string;
  }> {
    return this.#lock.run(`job:${jobId}`, async () => {
      const ws = this.#store.get(jobId);
      if (!ws) return { removed: false, reason: 'no workspace recorded for this job' };

      let removed = false;
      let reason: string | undefined;

      if (ws.isolation === 'worktree' && existsSync(ws.path)) {
        const args = ['worktree', 'remove', ws.path];
        if (opts.force) args.push('--force');
        try {
          await git(ws.repoPath, args);
          removed = true;
        } catch (err) {
          reason = err instanceof Error ? err.message : String(err);
        }
        await git(ws.repoPath, ['worktree', 'prune']).catch(() => undefined);
      } else {
        reason =
          ws.isolation === 'worktree'
            ? 'directory already gone'
            : `${ws.isolation} isolation shares the user's checkout — nothing deleted`;
        removed = ws.isolation !== 'worktree';
      }

      const at = new Date().toISOString();
      this.#store.markRemoved(jobId, at);
      this.#emit(ws, 'removed');
      return reason === undefined ? { removed } : { removed, reason };
    });
  }

  /** Where does this job work? Falls back to Track A's jobs row. */
  resolve(jobId: string): WorkspaceRecord | undefined {
    const ws = this.#store.get(jobId);
    if (ws && !ws.removedAt) return ws;

    const fromJob = this.#store.jobWorktree(jobId);
    if (!fromJob) return ws; // possibly a removed workspace; caller reports it
    return {
      jobId,
      projectId: fromJob.projectId,
      repoPath: fromJob.path,
      path: canonicalRoot(fromJob.path),
      branch: fromJob.branch,
      isolation: 'worktree',
      baseRef: null,
      createdAt: new Date(0).toISOString(),
      removedAt: null,
    };
  }

  #emit(ws: WorkspaceRecord, event: 'created' | 'reused' | 'removed'): void {
    eventLog().emit(
      // Worktree events are job-scoped: no single agent owns them.
      { projectId: ws.projectId, jobId: ws.jobId, agentId: null },
      { kind: 'worktree', event, path: ws.path, branch: ws.branch },
    );
  }
}

async function headSha(cwd: string): Promise<string | null> {
  if (!(await hasHead(cwd))) return null;
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}
