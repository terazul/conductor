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
 * An HTML page and the files it loads by relative URL (Amendment 198), under a token only the
 * app can mint, bound to the one root it was minted for (workspace/pages.ts). The file's path
 * is in the URL's path rather than a query, because a relative `href="style.css"` drops the
 * query. Nothing names a page by its job or project, so a page can't name another's:
 *   POST /api/pages  ← { jobId, path } | { projectId, dir, path } → { token, url } (201)
 *   GET  /api/pages/:token/<path>
 *
 * New folders, renames and deletes (Amendment 138), for either kind of root, through the
 * same gate and lock as a write (service.ts, "folders, renames and deletes"):
 *   POST   …/folders  ← CreateFolderRequest → CreateFolderResponse (201)
 *   POST   …/rename   ← RenameRequest       → RenameResponse
 *   GET    …/entry?path=                    → EntryResponse
 *   DELETE …/entry?path=[&recursive=1]      → DeleteEntryResponse
 * `folders`, plural: `POST /api/jobs/:jobId/folder` is already Amendment 114's (put back a
 * job's deleted worktree, routes/session.ts), and a new folder is one more in the list.
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
 * runs the same WorktreeMgr — not over HTTP. Nothing in the frozen four depends on them.
 *
 * **Gated at I4 (Amendment 152), not removed: the Files screen still lists and opens through
 * them.** A `jobId` has the daemon's own shape; the project must exist (404), named or found
 * by `repoPath`; `repoPath` must be its path or one of its directories, by `dirRoot`'s rule;
 * `branch` and `baseRef` pass `git check-ref-format`; a folder git cannot use is a 400; a
 * `jobId` whose workspace is another project's is a 409. A DELETE is 404 for a job with no
 * workspace and 409 while one of its agents is busy or not yet done, failed or stopped, and
 * reads `force` as strictly as `recursive`. GET takes `?projectId=`.
 *
 * This file contains no `fs` import on purpose. Every path crosses
 * workspace/paths.ts inside the service, and that single door is the only reason
 * the containment guarantee is worth anything. Do not add a second one.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CreateFolderRequest,
  Isolation,
  RenameRequest,
  WriteFileRequest,
} from '@conductor/shared';
import type { WorkspaceRecord } from '../workspace/service.js';
import { initWorkspace, WorkspaceError, workspace } from '../workspace/service.js';
import { PathEscape } from '../workspace/paths.js';
import type { PageRoot } from '../workspace/pages.js';
import { GitError } from '../workspace/git.js';
import {
  JobElsewhereError,
  LaunchBranchError,
  RepoUnfitError,
  baseRefProblem,
  branchNameProblem,
} from '../workspace/worktree.js';
import { openDb } from '../db/index.js';
import { agentsForJob, getProject, getProjectByPath, newId } from '../session/store.js';
import { supervisor } from '../session/supervisor.js';

interface JobParams {
  jobId: string;
}

interface DirParams {
  projectId: string;
}

interface DirQuery {
  dir?: string;
  path?: string;
  recursive?: string;
}

interface PathQuery {
  path?: string;
  recursive?: string;
}

interface OpenBody {
  jobId?: string;
  projectId?: string;
  repoPath?: string;
  isolation?: Isolation;
  branch?: string;
  baseRef?: string;
}

/** `POST /api/pages`: a job's page, or a project folder's. */
interface PageBody {
  jobId?: unknown;
  projectId?: unknown;
  dir?: unknown;
  path?: unknown;
}

const PAGE_BAD = 'send { jobId, path } or { projectId, dir, path }';

const ISOLATIONS = new Set<Isolation>(['worktree', 'branch', 'in_place']);

/**
 * What a job id can look like (`job_` and twelve characters, from store.ts's newId), loosely:
 * no `/` and no `.`, so `<repo>/.conductor/wt/<jobId>` stays under `wt` (Amendment 152).
 */
const JOB_ID = /^job_[A-Za-z0-9_-]{1,64}$/;
const JOB_ID_BAD = 'jobId must be job_ followed by letters, digits, _ or -';

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
  if (err instanceof LaunchBranchError) {
    // Same shape `POST /api/jobs` answers (Amendment 115), so a refusal reads as a sentence
    // with its 400 or 409, not as a 500 (Amendment 139).
    return reply.code(err.status).send({ error: 'could not use that branch', detail: err.message });
  }
  if (err instanceof JobElsewhereError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof RepoUnfitError) {
    return reply.code(err.status).send({ error: 'could not open the workspace', detail: err.message });
  }
  if (err instanceof GitError) {
    return reply.code(500).send({ error: 'git failed', detail: err.message });
  }
  return reply
    .code(500)
    .send({ error: 'workspace error', detail: err instanceof Error ? err.message : String(err) });
}

/**
 * `createOnly` is a flag that protects a file, so anything but a boolean is refused rather
 * than ignored: a client that sent the string "true" and had it taken for "absent" would
 * replace the file it meant to protect (Amendment 121).
 */
const CREATE_ONLY_BAD = 'createOnly must be true or false';
const createOnlyOk = (v: unknown): boolean => v === undefined || typeof v === 'boolean';

/**
 * `recursive` on a delete, read as strictly as `createOnly` and for the same reason: it is
 * the flag that takes a whole folder, so `recursive=yes` is a 400, not a guess either way.
 * `force` on a workspace's teardown is read the same way: it discards uncommitted work.
 */
function recursiveOf(v: unknown): boolean | null {
  if (v === undefined || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  return null;
}
const RECURSIVE_BAD = 'recursive must be 1 or 0';
const FORCE_BAD = 'force must be true or false';

const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

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

/**
 * The policy every response from the page route carries (Amendment 198), for the token it was
 * served under. The page's scripts run, so charts and interactive reports work, and what keeps
 * them from Conductor is this, with the iframe's own `sandbox` attribute (files/FilePane.tsx)
 * and the guard (guard.ts):
 *
 *  - `sandbox allow-scripts` — sandboxed even when the URL is opened in a tab of its own, not
 *    only inside the pane's frame. No `allow-same-origin`, so the page's origin is opaque: it
 *    can't read the app's storage or DOM, and anything it does send carries `Origin: null`,
 *    which the guard refuses. No `allow-forms`, `allow-top-navigation` or `allow-popups`: a
 *    window it opened could escape the sandbox at the app's own origin, so `target=_blank`
 *    and `window.open` do nothing, and the frame's attribute leaves popups out to match.
 *  - `*:*\/api/pages/<token>/` where another policy would say `'self'` — the files beside the
 *    page, under its own token, and nothing else this origin serves. `'self'` would be the
 *    whole origin: on Vite's 5173 that is `/@fs/` (any file in the repo Vite runs from, which
 *    holds this project's own worktrees) and on either port `/preview/<jobId>/` (another job's
 *    dev server), both of which answer a `<script src>` with JavaScript. The host is `*`
 *    because the daemon can't know which local host and port the browser used (Vite's proxy
 *    rewrites Host); the path is what pins it, and an http host is no more than `https:` is.
 *  - `https: data: blob:` — CDN assets, and what exported reports inline.
 *  - `script-src … 'unsafe-inline' 'unsafe-eval'` — a report's inline script, and the libraries
 *    that compile templates; they run inside the sandbox, which is what makes that safe.
 *  - `connect-src 'none'` — no `fetch`, XHR, WebSocket or EventSource, to us or anywhere.
 *  - `form-action 'none'` — no form submits, even if a sandbox flag were added later.
 *  - `frame-ancestors 'self'` — only the app may frame it.
 *  - `base-uri 'self'` — a `<base>` can't point its relative URLs at another host.
 */
export function pageCsp(token: string): string {
  const own = `*:*/api/pages/${token}/`;
  return (
    `sandbox allow-scripts; default-src ${own} https: data: blob:; ` +
    `script-src ${own} 'unsafe-inline' 'unsafe-eval' https: blob:; ` +
    `style-src ${own} 'unsafe-inline' https:; img-src ${own} https: data: blob:; ` +
    `font-src ${own} https: data:; connect-src 'none'; form-action 'none'; ` +
    "frame-ancestors 'self'; base-uri 'self'"
  );
}

/** A page's file and its headers. */
function sendPage(reply: FastifyReply, token: string, file: { buf: Buffer; mime: string }): FastifyReply {
  return reply
    .type(file.mime)
    // The declared type is the only one: a .txt can't be sniffed into a script.
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', pageCsp(token))
    // An agent rewrites the page; the pane reloads it and must not get the old one.
    .header('Cache-Control', 'no-store')
    // A link out of the page doesn't tell the site which job's file it came from.
    .header('Referrer-Policy', 'no-referrer')
    .send(file.buf);
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

  /**
   * A page's token (Amendment 198). Only the app mints one: a page's own fetch is
   * `connect-src 'none'`, and anything it sends says `Origin: null`, which the guard refuses,
   * as it refuses a foreign page's Origin. The root and the path pass the same gate as a read,
   * and the file must be `.html` or `.htm`.
   */
  app.post<{ Body: PageBody }>('/api/pages', async (req, reply) => {
    const body = req.body ?? {};
    if (!isName(body.path)) return reply.code(400).send({ error: PAGE_BAD });
    let root: PageRoot;
    if (isName(body.jobId) && body.projectId === undefined && body.dir === undefined) {
      root = { kind: 'job', jobId: body.jobId };
    } else if (isName(body.projectId) && isName(body.dir) && body.jobId === undefined) {
      root = { kind: 'dir', projectId: body.projectId, dir: body.dir };
    } else {
      return reply.code(400).send({ error: PAGE_BAD });
    }
    try {
      return reply.code(201).send(workspace().mintPage(root, body.path));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * A page's files, under its token. A GET with no Origin, which is how the frame loads the
   * page and how its `<link>`, `<script>` and `<img>` load the rest, passes the guard as any
   * GET does. A `type="module"` script or an `@font-face` from beside the page is a CORS
   * request, sent with `Origin: null`, and the guard refuses it: CDN copies of both work.
   */
  app.get<{ Params: { token: string; '*': string } }>('/api/pages/:token/*', async (req, reply) => {
    const path = req.params['*'];
    if (!path) return reply.code(400).send({ error: 'a file path is required after the token' });
    try {
      return sendPage(reply, req.params.token, workspace().pageByToken(req.params.token, path));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: JobParams; Body: WriteFileRequest }>(
    '/api/jobs/:jobId/file',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
        return reply.code(400).send({ error: 'body must be { path: string, content: string }' });
      }
      if (!createOnlyOk(body.createOnly)) return reply.code(400).send({ error: CREATE_ONLY_BAD });
      try {
        return await workspace().write(
          req.params.jobId,
          body.path,
          body.content,
          body.createOnly === true,
        );
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

  // ── folders, renames and deletes (Amendment 138) ─────────────────────────
  //
  // One handler per verb, given the root: a job's (`workspace().resolve`) or a project
  // folder's (`root()` below). The two route trees differ only in how they name it.

  type RootOf = (
    req: { params: JobParams & DirParams; query: DirQuery },
    reply: FastifyReply,
  ) => WorkspaceRecord | null;
  const verbs = (prefix: string, rootOf: RootOf): void => {
    app.post<{ Params: JobParams & DirParams; Querystring: DirQuery; Body: CreateFolderRequest }>(
      `${prefix}/folders`,
      async (req, reply) => {
        if (!req.body || !isName(req.body.path)) {
          return reply.code(400).send({ error: 'body must be { path: string }' });
        }
        try {
          const ws = rootOf(req, reply);
          return ws ? reply.code(201).send(await workspace().mkdirOf(ws, req.body.path)) : reply;
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.post<{ Params: JobParams & DirParams; Querystring: DirQuery; Body: RenameRequest }>(
      `${prefix}/rename`,
      async (req, reply) => {
        if (!req.body || !isName(req.body.from) || !isName(req.body.to)) {
          return reply.code(400).send({ error: 'body must be { from: string, to: string }' });
        }
        try {
          const ws = rootOf(req, reply);
          return ws ? await workspace().renameOf(ws, req.body.from, req.body.to) : reply;
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.get<{ Params: JobParams & DirParams; Querystring: DirQuery }>(
      `${prefix}/entry`,
      async (req, reply) => {
        if (!isName(req.query.path)) {
          return reply.code(400).send({ error: 'path query parameter is required' });
        }
        try {
          const ws = rootOf(req, reply);
          return ws ? await workspace().entryOf(ws, req.query.path) : reply;
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.delete<{ Params: JobParams & DirParams; Querystring: DirQuery }>(
      `${prefix}/entry`,
      async (req, reply) => {
        if (!isName(req.query.path)) {
          return reply.code(400).send({ error: 'path query parameter is required' });
        }
        const recursive = recursiveOf(req.query.recursive);
        if (recursive === null) return reply.code(400).send({ error: RECURSIVE_BAD });
        try {
          const ws = rootOf(req, reply);
          return ws ? await workspace().removeOf(ws, req.query.path, recursive) : reply;
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  };

  verbs('/api/jobs/:jobId', (req) => workspace().resolve(req.params.jobId));

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
      if (!createOnlyOk(body.createOnly)) return reply.code(400).send({ error: CREATE_ONLY_BAD });
      try {
        const ws = root(req, reply);
        return ws
          ? await workspace().writeOf(ws, body.path, body.content, body.createOnly === true)
          : reply;
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

  verbs('/api/projects/:projectId/dir', root);

  // ── bootstrap: gated at I4 (Amendment 152) ──────────────────────────────

  const db = openDb();
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

  app.get<{ Querystring: { projectId?: string } }>('/api/workspaces', async (req, reply) => {
    const { projectId } = req.query;
    if (projectId === undefined) return { workspaces: workspace().list() };
    if (typeof projectId !== 'string') return reply.code(400).send({ error: 'projectId must be one id' });
    if (!getProject(db, projectId)) return reply.code(404).send({ error: `no such project ${projectId}` });
    return { workspaces: workspace().list().filter((w) => w.projectId === projectId) };
  });

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
    if (body.jobId !== undefined && (typeof body.jobId !== 'string' || !JOB_ID.test(body.jobId))) {
      return reply.code(400).send({ error: JOB_ID_BAD });
    }
    if (![body.projectId, body.branch, body.baseRef].every(optionalString)) {
      return reply.code(400).send({ error: 'projectId, branch and baseRef must be strings' });
    }

    // Named, or the project whose folder `repoPath` is: the Files screen sends only the path.
    const projectId = body.projectId ?? getProjectByPath(db, body.repoPath)?.id;
    if (projectId === undefined) {
      return reply
        .code(404)
        .send({ error: `no project at ${body.repoPath} — add it as a project first` });
    }
    const jobId = body.jobId ?? newId('job');
    try {
      // 404 for a project that does not exist or a folder that is not one of its own, 410 for
      // one that is gone. By exact path, so `..` or a link inside the folder is not its own.
      workspace().dirRoot(projectId, body.repoPath);
      const bad =
        (body.branch ? await branchNameProblem(body.repoPath, body.branch) : null) ??
        (body.baseRef ? await baseRefProblem(body.repoPath, body.baseRef) : null);
      if (bad) return reply.code(400).send({ error: bad });
      const ws = await workspace().open({
        jobId,
        projectId,
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
      const { jobId } = req.params;
      if (!JOB_ID.test(jobId)) return reply.code(400).send({ error: JOB_ID_BAD });
      const force = recursiveOf(req.query.force);
      if (force === null) return reply.code(400).send({ error: FORCE_BAD });
      // Not only a run in flight: an agent paused, queued or blocked comes back to this
      // worktree, so removing it would lose that work (Amendment 152, review).
      const busy = agentsForJob(db, jobId).filter((a) => supervisor().hasUnfinishedWork(a.id));
      if (busy.length > 0) {
        const who = busy.map((a) => `${a.role} (${a.status})`).join(', ');
        return reply.code(409).send({
          error: `job ${jobId} has agents that are not finished in this workspace: ${who}`,
          detail: who,
        });
      }
      // A workspace left by a project that is gone, or by a request from before the gate, is
      // outside every known project: not removed over HTTP.
      const ws = workspace().list().find((w) => w.jobId === jobId);
      if (ws && !getProject(db, ws.projectId)) {
        return reply.code(404).send({ error: `no such project ${ws.projectId}` });
      }
      try {
        return await workspace().close(jobId, force);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
