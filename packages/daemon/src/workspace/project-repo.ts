/**
 * A project's repo as `workspace/branches.ts` wants it, built from the store (Amendments 109,
 * 113, 117, 143). Moved out of `routes/branches.ts` so the Branches routes and the
 * finished-job merge (Amendment 144, `session/finish.ts`) open a project's branches the
 * same way: the same target, the same "live", the same jobs.
 *
 * `forgetJob` is how a job is removed for `delete`'s `forgetJob`: the caller passes
 * `Supervisor.deleteJob`, so it is exactly what DELETE /api/jobs/:jobId does.
 */

import type { AgentStatus, Project } from '@conductor/shared';
import { branchTargetKey } from '@conductor/shared';
import type { Db } from '../db/index.js';
import { hub } from '../hub.js';
import { readSettings } from '../settings.js';
import { agentsForJob, defaultBranchIsSet, getProject, jobsForProject, setDefaultBranch } from '../session/store.js';
import { openRepo, type BranchJob, type BranchLookup, type BranchRepo } from './branches.js';

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

/** The repo of `projectId`, or null for no such project. A path that isn't a repo is openRepo's 400. */
export async function projectRepo(
  db: Db,
  projectId: string,
  forgetJob: (jobId: string) => Promise<void>,
): Promise<BranchRepo | null> {
  const project = getProject(db, projectId);
  if (!project) return null;
  const chosen = readSettings()[branchTargetKey(project.id)] ?? null;
  const defaultBranchSet = defaultBranchIsSet(db, project.id);
  const rootLive = jobsForProject(db, project.id).some(
    (job) =>
      (job.isolation === 'in_place' || job.isolation === 'branch') &&
      agentsForJob(db, job.id).some((a) => LIVE.has(a.status)),
  );
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
