/**
 * A project's repo as `workspace/branches.ts` wants it, built from the store (Amendments 109,
 * 113, 117, 143). Moved out of `routes/branches.ts` so the Branches routes and the
 * finished-job merge (Amendment 144, `session/finish.ts`) open a project's branches the
 * same way: the same target, the same "live", the same jobs.
 *
 * `forgetJob` is how a job is removed for `delete`'s `forgetJob`: the caller passes
 * `Supervisor.deleteJob`, so it is exactly what DELETE /api/jobs/:jobId does.
 *
 * N4: the project's other repos — its extra directories that are repos, and the repos
 * nested in either, as Files shows them — open here too, by `projectRepoOf`. Only one
 * found by `projectRepos` can be opened: a path is matched by its real path, never used
 * as given.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { AgentStatus, BranchRepoChoice, FileNode, Project } from '@conductor/shared';
import { branchTargetKey } from '@conductor/shared';
import type { Db } from '../db/index.js';
import { hub } from '../hub.js';
import { readSettings } from '../settings.js';
import { agentsForJob, defaultBranchIsSet, getProject, jobsForProject, setDefaultBranch } from '../session/store.js';
import { BranchError, openRepo, type BranchJob, type BranchLookup, type BranchRepo } from './branches.js';
import type { ChangeSet } from './changes.js';
import { git, isRepo, repoRoot } from './git.js';
import { buildTree } from './tree.js';

/** An agent in one of these is on its branch: nothing may move that branch under it. */
export const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['working', 'blocked', 'queued']);

/**
 * The project's jobs, read from the store each time they're asked for: `clean_merged`
 * removes jobs between one branch and the next, and each answer must see that.
 */
function jobsOf(db: Db, projectId: string): BranchJob[] {
  return jobsForProject(db, projectId).map((job) => ({
    id: job.id,
    branch: job.branch,
    worktreePath: job.worktreePath,
    live: agentsForJob(db, job.id).some((a) => LIVE.has(a.status)),
  }));
}

/**
 * By branch: the newest job first, a live one preferred (Amendment 109). Read once, and
 * again after `forget()`: a listing asks for every branch, and `clean_merged` removes
 * jobs between one listing and the next.
 */
function lookupFor(db: Db, project: Project): { lookup: BranchLookup; forget: () => void } {
  let byBranch: Map<string, { jobId: string; live: boolean }> | null = null;
  const lookup: BranchLookup = (branch) => {
    if (!byBranch) {
      byBranch = new Map();
      for (const job of jobsOf(db, project.id)) {
        const seen = byBranch.get(job.branch);
        if (!seen || (job.live && !seen.live)) byBranch.set(job.branch, { jobId: job.id, live: job.live });
      }
    }
    return byBranch.get(branch) ?? { jobId: null, live: false };
  };
  return { lookup, forget: () => (byBranch = null) };
}

/** Whether an `in_place` or `branch` job of the project has a live agent (Amendment 117); with `any`, a job of any isolation. */
function rootLiveOf(db: Db, project: Project, any = false): boolean {
  return jobsForProject(db, project.id).some(
    (job) =>
      (any || job.isolation === 'in_place' || job.isolation === 'branch') &&
      agentsForJob(db, job.id).some((a) => LIVE.has(a.status)),
  );
}

/** Whether `a` is `b` or inside it, both real paths. */
const within = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);

/**
 * Whether the repo at real path `top` shares any folder with one of the project's extra
 * directories: is one, is in one, or has one in it. Every agent of the project is given
 * those, whatever its job's isolation (`Supervisor.#reachable`), so any of them can write there.
 */
function reachedByAll(project: Project, top: string): boolean {
  return (project.extraDirs ?? []).some((dir) => {
    const real = realOf(dir);
    return real !== null && (within(top, real) || within(real, top));
  });
}

/** The repo of `projectId`, or null for no such project. A path that isn't a repo is openRepo's 400. */
export async function projectRepo(
  db: Db,
  projectId: string,
  forgetJob: (jobId: string) => Promise<void>,
): Promise<BranchRepo | null> {
  const project = getProject(db, projectId);
  return project ? openOwn(db, project, forgetJob) : null;
}

/** The project's own folder, as it always opened: its default branch, its target, its jobs. */
async function openOwn(db: Db, project: Project, forgetJob: (jobId: string) => Promise<void>): Promise<BranchRepo> {
  const chosen = readSettings()[branchTargetKey(project.id)] ?? null;
  const defaultBranchSet = defaultBranchIsSet(db, project.id);
  const rootLive = rootLiveOf(db, project);
  const setDefault = (branch: string) => {
    const updated = setDefaultBranch(db, project.id, branch);
    if (updated) hub().broadcast({ type: 'entities', projects: [updated] });
  };
  const { lookup, forget } = lookupFor(db, project);
  return openRepo(project.id, project.path, project.defaultBranch, lookup, chosen, defaultBranchSet, rootLive, setDefault, {
    jobs: () => jobsOf(db, project.id),
    forgetJob: async (jobId) => {
      try {
        await forgetJob(jobId);
      } finally {
        forget();
      }
    },
  });
}

/**
 * One of the project's other repos (N4). Jobs branch from the project's own folder, so none
 * is matched here, and there is no default branch to keep or target to choose: it is drawn
 * against origin's default, else what it has checked out, else main or master. While an
 * agent that can reach this repo is live, the branch it has checked out counts as live, as a
 * job's would. Every agent is given the project's extra directories, so in or around one of
 * those any live agent counts. A repo nested only in the project's folder is reached by
 * `in_place` and `branch` jobs, which work in that folder; a `worktree` job's checkout has
 * no nested repo in it (they're untracked) and it isn't given the project's folder.
 */
async function openOther(db: Db, project: Project, path: string): Promise<BranchRepo> {
  const top = realOf(await repoRoot(path).catch(() => path)) ?? path;
  const rootLive = rootLiveOf(db, project, reachedByAll(project, top));
  const own = (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  const lookup: BranchLookup = (branch) => ({ jobId: null, live: rootLive && own !== '' && branch === own });
  const setDefault = () => {
    throw new BranchError(400, "only the project's own folder has a default branch", path);
  };
  return openRepo(project.id, path, own || 'main', lookup, null, false, rootLive, setDefault);
}

/** Files' own tree, with no changes to mark: only its nested-repo folders are read from it. */
const NO_CHANGES: ChangeSet = { byPath: new Map(), files: 0, added: 0, removed: 0 };

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function nestedIn(node: FileNode, out: string[]): void {
  if (node.repo && node.path) out.push(node.path);
  for (const child of node.children ?? []) if (child.type === 'dir') nestedIn(child, out);
}

/**
 * Every repo of the project the Branches screen can open (N4), its own folder first: that
 * folder, each extra directory that is a repo, and the repos nested in either, found by
 * Files' own `buildTree` so the two screens always agree (nested up to four deep, Amendment
 * 90). One repo is listed once, by its top level's real path: an extra directory inside the
 * project's repo is that repo.
 */
export async function projectRepos(project: Project): Promise<BranchRepoChoice[]> {
  const out: BranchRepoChoice[] = [];
  const seen = new Set<string>();
  const add = async (path: string, name: string, main: boolean): Promise<void> => {
    const top = await repoRoot(path).catch(() => null);
    const key = top && realOf(top);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ path, name, main });
  };
  for (const dir of [project.path, ...(project.extraDirs ?? [])]) {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // A directory that's gone has no repos.
    }
    if (!isDir) continue;
    const label = basename(dir) || dir;
    if (await isRepo(dir)) await add(dir, label, dir === project.path);
    const nested: string[] = [];
    nestedIn((await buildTree(dir, label, NO_CHANGES)).root, nested);
    for (const rel of nested) await add(join(dir, rel), `${label}/${rel}`, false);
  }
  return out;
}

/**
 * The repo `repo` names, one of `projectRepos`, or the project's own folder when it names
 * none (N4); null for no such project. A path that isn't one of them — matched by real
 * path, so a symlink or `..` can't reach outside — is a 400. `choices` comes back when it
 * was read (always, with `list`), so a listing can say what else could be opened.
 */
export async function projectRepoOf(
  db: Db,
  projectId: string,
  forgetJob: (jobId: string) => Promise<void>,
  repo: string | undefined,
  list = false,
): Promise<{ repo: BranchRepo; path: string; choices: BranchRepoChoice[] | null } | null> {
  const project = getProject(db, projectId);
  if (!project) return null;
  const choices = list || repo ? await projectRepos(project) : null;
  const want = repo ? realOf(repo) : null;
  if (repo && want !== realOf(project.path)) {
    const choice = want ? choices!.find((c) => !c.main && realOf(c.path) === want) : undefined;
    if (!choice) throw new BranchError(400, `not one of ${project.name}'s repos`, repo);
    return { repo: await openOther(db, project, choice.path), path: choice.path, choices };
  }
  return { repo: await openOwn(db, project, forgetJob), path: project.path, choices };
}
