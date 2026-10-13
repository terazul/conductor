/**
 * The full terminal over HTTP and a socket (Amendment 112; a project's, the shells and the
 * hub frame, Amendment 141).
 *
 *   POST   /api/agents/:agentId/terminals     open a shell in the agent's folder   -> { id }
 *   GET    /api/agents/:agentId/terminals     { available, reason?, terminals }
 *   POST   /api/projects/:projectId/terminals open a shell in the project folder   -> { id }
 *   GET    /api/projects/:projectId/terminals { available, reason?, terminals }
 *   GET    /api/terminals/shells              { shells, default }, for Settings
 *   DELETE /api/terminals/:id                 end it (404 for one nobody has)
 *   GET    /ws/term/:id                       the stream, upgraded
 *
 * Every change to a scope's list is broadcast on the hub as `{ type: 'terminals', scope,
 * terminals }`, so a terminal opened in one browser tab is listed in the others.
 *
 * The socket is registered on the same app as `/ws`, so the same hooks and the same
 * `verifyClient` stand in front of it: `index.ts` refuses a non-local Host or Origin before a
 * route is reached (on an upgrade it ends the raw socket), and the plugin's `?token=` check
 * runs on every upgrade. Nothing here re-implements either. A terminal is code execution as
 * you, so verify asserts that a foreign Origin is turned away.
 *
 * Server to page: binary frames, the screen first (service.ts), then the output. Page to
 * server: JSON, `{ t: 'in', d }` for keys and paste, `{ t: 'bin', d }` for bytes that are not
 * text (base64), `{ t: 'resize', cols, rows }`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  TermClientFrame,
  TermCreateRequest,
  TermCreateResponse,
  TermListResponse,
  TermScope,
  TermShellsResponse,
} from '@conductor/shared';
import { openDb } from '../db/index.js';
import { hub } from '../hub.js';
import { getAgent, getJob, getProject } from '../session/store.js';
import { defaultShell, shells } from '../terminal/prefs.js';
import { TermError, terminals } from '../terminal/service.js';

/** The most one `in` frame may carry: a paste, not a file. */
const MAX_INPUT = 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Parse what a page sent; null for anything that is not one of the three frames. */
export function parseClientFrame(raw: string): TermClientFrame | null {
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof f !== 'object' || f === null) return null;
  const o = f as Record<string, unknown>;
  if (o['t'] === 'in' && typeof o['d'] === 'string' && o['d'].length <= MAX_INPUT) return { t: 'in', d: o['d'] };
  if (o['t'] === 'bin' && typeof o['d'] === 'string' && o['d'].length <= MAX_INPUT && o['d'].length % 4 === 0 && BASE64.test(o['d'])) {
    return { t: 'bin', d: o['d'] };
  }
  if (o['t'] === 'resize' && typeof o['cols'] === 'number' && typeof o['rows'] === 'number') {
    return { t: 'resize', cols: o['cols'], rows: o['rows'] };
  }
  return null;
}

export default async function termRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();
  const mgr = terminals();
  // Every tab's list stays current. The hub is not there in a harness that builds only routes.
  const unwatch = mgr.onChange((scope) => {
    try {
      hub().broadcast({ type: 'terminals', scope, terminals: mgr.list(scope) });
    } catch {
      /* no hub */
    }
  });
  // The daemon stopping ends every shell. Waiting here is what keeps one from outliving it.
  app.addHook('onClose', async () => {
    await mgr.shutdown();
    unwatch();
  });

  type Where = { scope: TermScope; cwd: string; jobId: string | null; projectId: string };
  const agentAt = (agentId: string): Where | null => {
    const agent = getAgent(db, agentId);
    const job = agent ? getJob(db, agent.jobId) : undefined;
    return agent && job ? { scope: { kind: 'agent', agentId }, cwd: job.worktreePath, jobId: job.id, projectId: agent.projectId } : null;
  };
  const projectAt = (projectId: string): Where | null => {
    const project = getProject(db, projectId);
    return project ? { scope: { kind: 'project', projectId }, cwd: project.path, jobId: null, projectId } : null;
  };
  const failWith = (reply: FastifyReply, err: unknown) => {
    if (err instanceof TermError) return reply.code(err.status).send({ error: err.message });
    return reply.code(500).send({ error: 'the terminal could not start', detail: err instanceof Error ? err.message : String(err) });
  };

  const listOf = (at: Where): TermListResponse => {
    const status = mgr.available();
    // Without a PTY there are none to list, and the page says why.
    return status.available ? { available: true, terminals: mgr.list(at.scope) } : { available: false, reason: status.reason, terminals: [] };
  };
  const openAt = (at: Where, body: TermCreateRequest | undefined, reply: FastifyReply) => {
    try {
      const t = mgr.create({ scope: at.scope, jobId: at.jobId, projectId: at.projectId, cwd: at.cwd, cols: body?.cols, rows: body?.rows });
      const out: TermCreateResponse = { id: t.id };
      return reply.code(201).send(out);
    } catch (err) {
      return failWith(reply, err);
    }
  };

  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/terminals', async (req, reply): Promise<TermListResponse | void> => {
    const at = agentAt(req.params.agentId);
    return at ? listOf(at) : reply.code(404).send({ error: 'no such agent' });
  });

  app.post<{ Params: { agentId: string }; Body: TermCreateRequest | undefined }>('/api/agents/:agentId/terminals', async (req, reply) => {
    const at = agentAt(req.params.agentId);
    return at ? openAt(at, req.body, reply) : reply.code(404).send({ error: 'no such agent' });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/terminals', async (req, reply): Promise<TermListResponse | void> => {
    const at = projectAt(req.params.projectId);
    return at ? listOf(at) : reply.code(404).send({ error: 'no such project' });
  });

  app.post<{ Params: { projectId: string }; Body: TermCreateRequest | undefined }>('/api/projects/:projectId/terminals', async (req, reply) => {
    const at = projectAt(req.params.projectId);
    return at ? openAt(at, req.body, reply) : reply.code(404).send({ error: 'no such project' });
  });

  app.get('/api/terminals/shells', async (): Promise<TermShellsResponse> => ({ shells: shells(), default: defaultShell() }));

  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (req, reply) => {
    if (!(await mgr.close(req.params.id))) return reply.code(404).send({ error: 'no such terminal' });
    return { closed: true };
  });

  app.get<{ Params: { id: string } }>('/ws/term/:id', { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const attached = mgr.attach(id, {
      send: (data) => socket.send(data, { binary: true }),
      backlog: () => socket.bufferedAmount,
      close: (code, reason) => socket.close(code, reason),
    });
    if (!attached) {
      socket.close(4404, 'no such terminal');
      return;
    }
    socket.on('message', (raw) => {
      const f = parseClientFrame(raw.toString());
      if (!f) return;
      if (f.t === 'in') mgr.write(id, f.d);
      else if (f.t === 'bin') mgr.write(id, Buffer.from(f.d, 'base64'));
      else mgr.resize(id, f.cols, f.rows);
    });
    socket.on('close', () => attached.detach());
    socket.on('error', () => attached.detach());
  });
}
