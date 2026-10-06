/**
 * The Agent screen's terminal over HTTP (Amendment 58). Track A's.
 *
 * GET the runs so far; POST a command; POST stop; DELETE to clear. Output and ends go to
 * every tab as `terminal_out` / `terminal_run` frames.
 */

import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { hub } from '../hub.js';
import { getAgent, getJob } from '../session/store.js';
import { Terminal, TerminalError } from '../session/terminal.js';

let instance: Terminal | null = null;

/** The one terminal, for verify. */
export function terminal(): Terminal {
  instance ??= new Terminal({
    run: (run) => hub().broadcast({ type: 'terminal_run', run }),
    out: (agentId, runId, chunk) => hub().broadcast({ type: 'terminal_out', agentId, runId, ...chunk }),
  });
  return instance;
}

export default async function terminalRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();
  const t = terminal();
  app.addHook('onClose', async () => t.shutdown());

  const cwdOf = (agentId: string): string | null => {
    const agent = getAgent(db, agentId);
    const job = agent ? getJob(db, agent.jobId) : undefined;
    return job?.worktreePath ?? null;
  };
  const failWith = (reply: import('fastify').FastifyReply, err: unknown) => {
    if (err instanceof TerminalError) return reply.code(err.status).send({ error: err.message });
    return reply.code(500).send({ error: 'the command could not start', detail: err instanceof Error ? err.message : String(err) });
  };

  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/terminal', async (req, reply) => {
    const cwd = cwdOf(req.params.agentId);
    if (!cwd) return reply.code(404).send({ error: 'no such agent' });
    return { cwd, runs: t.history(req.params.agentId) };
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/terminal', async (req, reply) => {
    const cwd = cwdOf(req.params.agentId);
    if (!cwd) return reply.code(404).send({ error: 'no such agent' });
    const command = (req.body as { command?: unknown } | undefined)?.command;
    try {
      return reply.code(201).send({ run: t.start(req.params.agentId, typeof command === 'string' ? command : '', cwd) });
    } catch (err) {
      return failWith(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>('/api/terminal/:runId/stop', async (req, reply) => {
    try {
      return { run: t.stop(req.params.runId) };
    } catch (err) {
      return failWith(reply, err);
    }
  });

  app.delete<{ Params: { agentId: string } }>('/api/agents/:agentId/terminal', async (req, reply) => {
    try {
      t.clear(req.params.agentId);
      return { cleared: true };
    } catch (err) {
      return failWith(reply, err);
    }
  });
}
