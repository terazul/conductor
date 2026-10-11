/**
 * The Agent screen's full terminal over HTTP and a socket (Amendment 112).
 *
 *   POST   /api/agents/:agentId/terminals   open a shell in the agent's folder  -> { id }
 *   GET    /api/agents/:agentId/terminals   { available, reason?, terminals }
 *   DELETE /api/terminals/:id               end it (404 for one nobody has)
 *   GET    /ws/term/:id                     the stream, upgraded
 *
 * The socket is registered on the same app as `/ws`, so the same hooks and the same
 * `verifyClient` stand in front of it: `index.ts` refuses a non-local Host or Origin before a
 * route is reached (on an upgrade it ends the raw socket), and the plugin's `?token=` check
 * runs on every upgrade. Nothing here re-implements either. A terminal is code execution as
 * you, so verify asserts that a foreign Origin is turned away.
 *
 * Server to page: binary frames of output, the buffer first. Page to server: JSON,
 * `{ t: 'in', d }` for keys and paste, `{ t: 'resize', cols, rows }`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TermClientFrame, TermCreateRequest, TermCreateResponse, TermListResponse } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { getAgent, getJob } from '../session/store.js';
import { TermError, terminals } from '../terminal/service.js';

/** The most one `in` frame may carry: a paste, not a file. */
const MAX_INPUT = 1024 * 1024;

/** Parse what a page sent; null for anything that is not one of the two frames. */
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
  if (o['t'] === 'resize' && typeof o['cols'] === 'number' && typeof o['rows'] === 'number') {
    return { t: 'resize', cols: o['cols'], rows: o['rows'] };
  }
  return null;
}

export default async function termRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();
  const mgr = terminals();
  // The daemon stopping ends every shell. Waiting here is what keeps one from outliving it.
  app.addHook('onClose', async () => mgr.shutdown());

  const where = (agentId: string): { cwd: string; jobId: string } | null => {
    const agent = getAgent(db, agentId);
    const job = agent ? getJob(db, agent.jobId) : undefined;
    return job ? { cwd: job.worktreePath, jobId: job.id } : null;
  };
  const failWith = (reply: FastifyReply, err: unknown) => {
    if (err instanceof TermError) return reply.code(err.status).send({ error: err.message });
    return reply.code(500).send({ error: 'the terminal could not start', detail: err instanceof Error ? err.message : String(err) });
  };

  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/terminals', async (req, reply): Promise<TermListResponse | void> => {
    if (!where(req.params.agentId)) return reply.code(404).send({ error: 'no such agent' });
    const status = mgr.available();
    // Without a PTY there are none to list, and the page shows the runner and says why.
    return status.available
      ? { available: true, terminals: mgr.list(req.params.agentId) }
      : { available: false, reason: status.reason, terminals: [] };
  });

  app.post<{ Params: { agentId: string }; Body: TermCreateRequest | undefined }>('/api/agents/:agentId/terminals', async (req, reply) => {
    const at = where(req.params.agentId);
    if (!at) return reply.code(404).send({ error: 'no such agent' });
    try {
      const t = mgr.create({ agentId: req.params.agentId, jobId: at.jobId, cwd: at.cwd, cols: req.body?.cols, rows: req.body?.rows });
      const body: TermCreateResponse = { id: t.id };
      return reply.code(201).send(body);
    } catch (err) {
      return failWith(reply, err);
    }
  });

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
      else mgr.resize(id, f.cols, f.rows);
    });
    socket.on('close', () => attached.detach());
    socket.on('error', () => attached.detach());
  });
}
