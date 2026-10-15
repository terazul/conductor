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
 * out or dirty, nothing to commit or merge, a rejected push, or (Amendment 117) a
 * `set_default` checkout refused because the project folder is dirty, something is working
 * in it, or the branch is checked out elsewhere; (Amendment 143) a `delete` refused, with its
 * sentence — the target, the folder's own branch, not merged, uncommitted files, a live
 * agent, or a job that owns it without `forgetJob`; (N3) a `pull` or `rebase` refused — not
 * checked out, tracked changes, no upstream, nothing to pull or rebase, "diverged — merge or
 * rebase", unrelated histories — and a push of a pushed branch Conductor rebased, which
 * would need a force; 504 push or fetch timed out;
 * 500 git failed (its stderr in detail).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { branchTargetKey } from '@conductor/shared';
import { onSettingsChanged } from '../settings.js';
import { openDb } from '../db/index.js';
import { hub } from '../hub.js';
import { supervisor } from '../session/supervisor.js';
import { GitError } from '../workspace/git.js';
import { BranchError, branchAction, listBranches, parseBranchAction, previewMerge } from '../workspace/branches.js';
import { projectRepo } from '../workspace/project-repo.js';

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

  // The repo is built from the store as the finished-job merge builds it (project-repo.ts);
  // a job forgotten for `delete` goes exactly as DELETE /api/jobs/:jobId removes it.
  const repoFor = (projectId: string) => projectRepo(db, projectId, (jobId) => supervisor().deleteJob(jobId));

  // Choosing what to compare with is a setting (Amendment 113): every open page re-reads.
  const PREFIX = branchTargetKey('');
  const off = onSettingsChanged((changed) => {
    for (const k of changed) {
      if (k.startsWith(PREFIX)) hub().broadcast({ type: 'branches', projectId: k.slice(PREFIX.length) });
    }
  });
  app.addHook('onClose', async () => off());

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
