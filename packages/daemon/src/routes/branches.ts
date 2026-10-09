/**
 * The Branches screen's endpoints (Amendment 109, ADR 0008).
 *
 *   GET  /api/projects/:projectId/branches  → BranchesResponse
 *   POST /api/projects/:projectId/branches  ← BranchAction → BranchActionResult
 *   GET  /api/projects/:projectId/branches/preview?branch=&into=  → BranchMergePreview
 *        (Amendment 110: what merging `branch` into `into` would do; reads only, no lock)
 *
 * Auto-registered by index.ts like every file here. The git lives in
 * workspace/branches.ts; this file only finds the project, tells the git side which
 * branches belong to a job with an agent on it, maps refusals to their codes, and
 * broadcasts `{ type: 'branches', projectId }` after each POST so another open tab redraws.
 *
 * Errors are `{ error, detail? }`: 404 no such project; 400 not a git repo, an unknown
 * branch, a name starting with '-', an empty message; 409 live branch, target not checked
 * out or dirty, nothing to commit or merge, a rejected push; 504 push or fetch timed out;
 * 500 git failed (its stderr in detail).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentStatus, Project } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { hub } from '../hub.js';
import { agentsForJob, getProject, jobsForProject } from '../session/store.js';
import { GitError } from '../workspace/git.js';
import {
  BranchError,
  branchAction,
  listBranches,
  openRepo,
  parseBranchAction,
  previewMerge,
  type BranchLookup,
} from '../workspace/branches.js';

const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['working', 'blocked', 'queued']);

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BranchError) {
    return reply.code(err.status).send(err.detail ? { error: err.message, detail: err.detail } : { error: err.message });
  }
  if (err instanceof GitError) {
    return reply.code(500).send({ error: 'git failed', detail: err.stderr.trim() || err.message });
  }
  return reply.code(500).send({ error: 'branches error', detail: err instanceof Error ? err.message : String(err) });
}

export default async function branchesRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  /** The project's jobs by branch, read once per request: newest job first, a live one preferred. */
  function lookupFor(project: Project): BranchLookup {
    const byBranch = new Map<string, { jobId: string; live: boolean }>();
    for (const job of jobsForProject(db, project.id)) {
      const live = agentsForJob(db, job.id).some((a) => LIVE.has(a.status));
      const seen = byBranch.get(job.branch);
      if (!seen || (live && !seen.live)) byBranch.set(job.branch, { jobId: job.id, live });
    }
    return (branch) => byBranch.get(branch) ?? { jobId: null, live: false };
  }

  async function repoFor(projectId: string) {
    const project = getProject(db, projectId);
    if (!project) return null;
    return openRepo(project.id, project.path, project.defaultBranch, lookupFor(project));
  }

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/branches', async (req, reply) => {
    try {
      const repo = await repoFor(req.params.projectId);
      if (!repo) return reply.code(404).send({ error: 'no such project' });
      return await listBranches(repo);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { branch?: string; into?: string } }>(
    '/api/projects/:projectId/branches/preview',
    async (req, reply) => {
      try {
        const repo = await repoFor(req.params.projectId);
        if (!repo) return reply.code(404).send({ error: 'no such project' });
        return await previewMerge(repo, req.query.branch ?? '', req.query.into || undefined);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/branches', async (req, reply) => {
    const { projectId } = req.params;
    try {
      const repo = await repoFor(projectId);
      if (!repo) return reply.code(404).send({ error: 'no such project' });
      const action = parseBranchAction(req.body);
      try {
        return await branchAction(repo, action);
      } finally {
        // A refused or failed action can still have changed something (a fetch that half
        // ran); a redraw costs one GET.
        hub().broadcast({ type: 'branches', projectId });
      }
    } catch (err) {
      return fail(reply, err);
    }
  });
}
