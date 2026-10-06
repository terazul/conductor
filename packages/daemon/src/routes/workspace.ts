/**
 * Track C's route file — the workspace endpoints.
 *
 * Auto-registered by daemon/src/index.ts (it globs src/routes/*.ts), which is
 * why this file is a plain default-exported Fastify plugin and why no shared
 * route table needed editing to add it.
 *
 * FROZEN SHAPES (shared/src/wire.ts):
 *   GET  /api/jobs/:jobId/tree            → FileTreeResponse
 *   GET  /api/jobs/:jobId/file?path=      → FileContentResponse
 *   PUT  /api/jobs/:jobId/file            ← WriteFileRequest → FileContentResponse
 *   GET  /api/jobs/:jobId/diff[?path=]    → DiffResponse
 *
 * The same for a project's directories (Amendment 39), `dir` being the project's
 * path or one of its other directories, absolute. Same shapes, same path gate; never
 * watched, so the screen re-reads them on request rather than on file_edit:
 *   GET  /api/projects/:projectId/dir/{tree,file,image,diff}?dir=…[&path=…]
 *   PUT  /api/projects/:projectId/dir/file?dir=…
 *
 * Plus three BOOTSTRAP endpoints that are this track's own and are deliberately
 * NOT in the frozen contract (ruled on in CONTRACT.md Amendment 2 — enshrining a
 * temporary in `wire.ts` is worse than leaving it clearly marked):
 *   GET  /api/workspaces                  list live worktrees
 *   POST /api/workspaces                  open one
 *   DELETE /api/workspaces/:jobId         tear one down
 *
 * They exist so screen 5 is demonstrable and testable before Track A ships job
 * creation. Track A creates jobs IN-PROCESS via `workspace().open(...)`, which
 * runs the same WorktreeMgr — not over HTTP. **Expect these to be gated or
 * removed at I4.** Nothing in the frozen four depends on them.
 *
 * This file contains no `fs` import on purpose. Every path crosses
 * workspace/paths.ts inside the service, and that single door is the only reason
 * the containment guarantee is worth anything. Do not add a second one.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Isolation, WriteFileRequest } from '@conductor/shared';
import { initWorkspace, WorkspaceError, workspace } from '../workspace/service.js';
import { PathEscape } from '../workspace/paths.js';
import { GitError } from '../workspace/git.js';

interface JobParams {
  jobId: string;
}

interface DirParams {
  projectId: string;
}

interface DirQuery {
  dir?: string;
  path?: string;
}

interface PathQuery {
  path?: string;
}

interface OpenBody {
  jobId?: string;
  projectId?: string;
  repoPath?: string;
  isolation?: Isolation;
  branch?: string;
  baseRef?: string;
}

const ISOLATIONS = new Set<Isolation>(['worktree', 'branch', 'in_place']);

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PathEscape) {
    // Deliberately terse: the resolved path is not echoed back, because the
    // difference between "outside the worktree" and "does not exist" is exactly
    // the oracle a prober wants.
    return reply.code(400).send({ error: 'invalid path', detail: err.message });
  }
  if (err instanceof WorkspaceError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof GitError) {
    return reply.code(500).send({ error: 'git failed', detail: err.message });
  }
  return reply
    .code(500)
    .send({ error: 'workspace error', detail: err instanceof Error ? err.message : String(err) });
}

/** `image` and its headers, for either kind of root. */
function sendImage(reply: FastifyReply, img: { buf: Buffer; mime: string }): FastifyReply {
  return reply
    .type(img.mime)
    // nosniff so the declared type is the only one that can apply, and a
    // null CSP so an SVG opened directly cannot execute what it carries.
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    // Worktree files change under the user; a cached image would show the old
    // one after an agent rewrote it.
    .header('Cache-Control', 'no-store')
    .send(img.buf);
}

export default async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // Boot the service here rather than in daemon/src/index.ts, which is W0's.
  const svc = initWorkspace();
  app.addHook('onClose', async () => {
    await svc.stop();
  });

  // ── the frozen four ──────────────────────────────────────────────────────

  app.get<{ Params: JobParams }>('/api/jobs/:jobId/tree', async (req, reply) => {
    try {
      return await workspace().tree(req.params.jobId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: JobParams; Querystring: PathQuery }>(
    '/api/jobs/:jobId/file',
    async (req, reply) => {
      const path = req.query.path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'path query parameter is required' });
      }
      try {
        return await workspace().file(req.params.jobId, path);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  /**
   * An image's bytes, for `<img src>` in the Files pane (CONTRACT Amendment 25).
   *
   * A separate route rather than base64 inside `FileContentResponse`: base64 is a
   * third larger, it would sit in the JSON the pane already caches per path, and the
   * browser cannot stream or cache it as an image. A URL is what `<img>` wants.
   *
   * Extension allowlist, NOT a binary sniff. The feature is "view images", and a
   * route that serves whatever bytes a path holds is a different, larger thing —
   * `looksBinary` returning true says only that the file is not text.
   */
  app.get<{ Params: JobParams; Querystring: PathQuery }>(
    '/api/jobs/:jobId/image',
    async (req, reply) => {
      const path = req.query.path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'path query parameter is required' });
      }
      try {
        return sendImage(reply, await workspace().image(req.params.jobId, path));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{ Params: JobParams; Body: WriteFileRequest }>(
    '/api/jobs/:jobId/file',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
        return reply.code(400).send({ error: 'body must be { path: string, content: string }' });
      }
      try {
        return await workspace().write(req.params.jobId, body.path, body.content);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: JobParams; Querystring: PathQuery }>(
    '/api/jobs/:jobId/diff',
    async (req, reply) => {
      try {
        return await workspace().diff(req.params.jobId, req.query.path);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ── a project's directories (Amendment 39) ───────────────────────────────

  /** The directory a request names, or a 400 already sent. */
  const root = (req: { params: DirParams; query: DirQuery }, reply: FastifyReply) => {
    const dir = req.query.dir;
    if (typeof dir !== 'string' || dir.length === 0) {
      void reply.code(400).send({ error: 'dir query parameter is required' });
      return null;
    }
    return workspace().dirRoot(req.params.projectId, dir);
  };
  const needPath = (path: unknown, reply: FastifyReply): path is string => {
    if (typeof path === 'string' && path.length > 0) return true;
    void reply.code(400).send({ error: 'path query parameter is required' });
    return false;
  };

  app.get<{ Params: DirParams; Querystring: DirQuery }>(
    '/api/projects/:projectId/dir/tree',
    async (req, reply) => {
      try {
        const ws = root(req, reply);
        return ws ? await workspace().treeOf(ws) : reply;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: DirParams; Querystring: DirQuery }>(
    '/api/projects/:projectId/dir/file',
    async (req, reply) => {
      try {
        const ws = root(req, reply);
        if (!ws) return reply;
        const path = req.query.path;
        return needPath(path, reply) ? await workspace().fileOf(ws, path) : reply;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: DirParams; Querystring: DirQuery }>(
    '/api/projects/:projectId/dir/image',
    async (req, reply) => {
      try {
        const ws = root(req, reply);
        if (!ws) return reply;
        const path = req.query.path;
        return needPath(path, reply) ? sendImage(reply, await workspace().imageOf(ws, path)) : reply;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{ Params: DirParams; Querystring: DirQuery; Body: WriteFileRequest }>(
    '/api/projects/:projectId/dir/file',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
        return reply.code(400).send({ error: 'body must be { path: string, content: string }' });
      }
      try {
        const ws = root(req, reply);
        return ws ? await workspace().writeOf(ws, body.path, body.content) : reply;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: DirParams; Querystring: DirQuery }>(
    '/api/projects/:projectId/dir/diff',
    async (req, reply) => {
      try {
        const ws = root(req, reply);
        return ws ? await workspace().diffOf(ws, req.query.path) : reply;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ── bootstrap: expected to be gated or removed at I4 ─────────────────────

  app.get('/api/workspaces', async () => ({ workspaces: workspace().list() }));

  app.post<{ Body: OpenBody }>('/api/workspaces', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.repoPath !== 'string' || body.repoPath.length === 0) {
      return reply.code(400).send({ error: 'repoPath is required (absolute path to a git repo)' });
    }
    const isolation: Isolation = body.isolation ?? 'worktree';
    if (!ISOLATIONS.has(isolation)) {
      return reply
        .code(400)
        .send({ error: `isolation must be one of ${[...ISOLATIONS].join(', ')}` });
    }

    const jobId = body.jobId ?? `job_${Math.random().toString(36).slice(2, 10)}`;
    try {
      const ws = await workspace().open({
        jobId,
        projectId: body.projectId ?? `prj_${jobId}`,
        repoPath: body.repoPath,
        isolation,
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.baseRef ? { baseRef: body.baseRef } : {}),
      });
      return reply.code(201).send({ workspace: ws });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: JobParams; Querystring: { force?: string } }>(
    '/api/workspaces/:jobId',
    async (req, reply) => {
      try {
        return await workspace().close(req.params.jobId, req.query.force === 'true');
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
