/**
 * Track D's route file — dev servers, console capture, and the preview proxy.
 *
 * TRACK D OWNS THIS FILE.
 *
 * Discovered by the daemon's route auto-registration (`src/index.ts` globs
 * `src/routes/*.ts`), which is why adding endpoints here collides with nobody.
 * It also doubles as Track D's boot hook: `initPreview` mounts the proxy and
 * starts the registry.
 *
 * Endpoints, per the ownership comment in `shared/src/wire.ts`:
 *
 *   GET    /api/jobs/:jobId/servers            → DevServersResponse
 *   POST   /api/jobs/:jobId/servers            → register a port explicitly
 *   POST   /api/jobs/:jobId/servers/:port/stop → stop it (needs a known pid)
 *   DELETE /api/jobs/:jobId/servers/:port      → forget it
 *   GET    /api/jobs/:jobId/console            → { entries } for a fresh load
 *   POST   /api/jobs/:jobId/console            → PostConsoleRequest, from the shim
 *   DELETE /api/jobs/:jobId/console            → clear the pane
 *   POST   /api/jobs/:jobId/console/send       → SendConsoleToAgentRequest
 *   GET    /preview/:jobId/*                   → the reverse proxy
 */

import type { FastifyInstance } from 'fastify';
import type {
  ConsoleEntry,
  ConsoleLogResponse,
  DevServersResponse,
  PostConsoleRequest,
  SendConsoleToAgentRequest,
  SendConsoleToAgentResponse,
} from '@conductor/shared';
import { composeAgentMessage } from '../preview/console.js';
import { initPreview } from '../preview/index.js';
import { isAllowedPort } from '../preview/probe.js';

/**
 * Where Track A's session engine listens — which is to say, where we listen.
 *
 * Read from the actual bound socket rather than from `CONDUCTOR_PORT`, because
 * the env var is the *requested* port and the two diverge (the smoke test and
 * the verify script both listen on ports the env var doesn't name). Guessing
 * here would send the handoff into the void on exactly the setups used to test
 * it.
 */
function selfOrigin(app: FastifyInstance): string {
  const address = app.server.address();
  if (address !== null && typeof address === 'object') {
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    // A wildcard bind is reachable on loopback; say so explicitly.
    const safe = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : host;
    return `http://${safe}:${address.port}`;
  }
  return `http://127.0.0.1:${process.env['CONDUCTOR_PORT'] ?? 7777}`;
}

interface JobParams {
  jobId: string;
}

interface JobPortParams {
  jobId: string;
  port: string;
}

/** Trim what the shim sends to something the log and the agent can live with. */
function sanitiseEntries(input: unknown): ConsoleEntry[] {
  if (typeof input !== 'object' || input === null) return [];
  const entries = (input as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  const out: ConsoleEntry[] = [];
  for (const raw of entries.slice(0, 200)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const level = record['level'];
    const text = record['text'];
    if (typeof text !== 'string' || text.length === 0) continue;
    out.push({
      level: level === 'error' || level === 'warn' ? level : 'log',
      text,
      at: typeof record['at'] === 'string' ? record['at'] : new Date().toISOString(),
    });
  }
  return out;
}

export default async function previewRoutes(app: FastifyInstance): Promise<void> {
  const { registry, console: consoleStore } = await initPreview(app);

  // ── dev servers ──────────────────────────────────────────────────────────

  app.get<{ Params: JobParams }>('/api/jobs/:jobId/servers', async (request) => {
    const response: DevServersResponse = { servers: registry.wire(request.params.jobId) };
    return response;
  });

  /**
   * Register a port by hand.
   *
   * Two real uses. Detection is a heuristic over shell commands, so it will miss
   * launches nobody anticipated — a Makefile target, a docker-compose service, a
   * server started in a terminal outside Conductor. And until Track A is emitting
   * `tool_start` events, this is how the track is driven at all.
   *
   * It is NOT an escape hatch from the security model: the port still has to be
   * listening on loopback and answering HTTP before it is registered, and the
   * proxy still only forwards to registered ports.
   */
  app.post<{ Params: JobParams; Body: { port?: number; command?: string; agentId?: string } }>(
    '/api/jobs/:jobId/servers',
    async (request, reply) => {
      const port = Number(request.body?.port);
      if (!isAllowedPort(port)) {
        return reply.code(400).send({ error: 'bad_port', detail: 'expected a port we may proxy to' });
      }
      const server = await registry.register({
        jobId: request.params.jobId,
        port,
        command: request.body?.command ?? 'registered manually',
        kind: 'manual',
        startedByAgentId: request.body?.agentId ?? null,
      });
      if (!server) {
        return reply
          .code(502)
          .send({ error: 'not_listening', detail: `nothing answering HTTP on 127.0.0.1:${port}` });
      }
      const response: DevServersResponse = { servers: registry.wire(request.params.jobId) };
      return response;
    },
  );

  app.post<{ Params: JobPortParams }>(
    '/api/jobs/:jobId/servers/:port/stop',
    async (request, reply) => {
      const port = Number(request.params.port);
      if (!Number.isInteger(port)) return reply.code(400).send({ error: 'bad_port' });
      const result = await registry.stop(request.params.jobId, port);
      if (!result.stopped) {
        return reply.code(409).send({ error: 'not_stopped', detail: result.reason ?? '' });
      }
      const response: DevServersResponse = { servers: registry.wire(request.params.jobId) };
      return response;
    },
  );

  app.delete<{ Params: JobPortParams }>('/api/jobs/:jobId/servers/:port', async (request, reply) => {
    const port = Number(request.params.port);
    if (!Number.isInteger(port)) return reply.code(400).send({ error: 'bad_port' });
    registry.forget(request.params.jobId, port);
    const response: DevServersResponse = { servers: registry.wire(request.params.jobId) };
    return reply.send(response);
  });

  // ── console capture ──────────────────────────────────────────────────────

  /**
   * Where the injected shim posts the previewed app's console output.
   *
   * Answers 204 unconditionally, even on bad input. This endpoint is called from
   * inside the user's own app: a 4xx here would surface as a console error in
   * that app, which would be captured, which would be posted… A telemetry sink
   * that can start a feedback loop in the thing it observes is not worth the
   * validation feedback.
   */
  app.post<{ Params: JobParams; Body: PostConsoleRequest }>(
    '/api/jobs/:jobId/console',
    async (request, reply) => {
      const entries = sanitiseEntries(request.body);
      if (entries.length > 0) {
        const jobId = request.params.jobId;
        const servers = registry.forJob(jobId);
        consoleStore.record(
          {
            projectId: servers[0]?.projectId ?? '',
            jobId,
            agentId: servers[0]?.startedByAgentId ?? null,
          },
          entries,
        );
      }
      return reply.code(204).send();
    },
  );

  /** A fresh page load needs the history the event feed won't replay for it. */
  app.get<{ Params: JobParams; Querystring: { limit?: string } }>(
    '/api/jobs/:jobId/console',
    async (request) => {
      const limit = Math.min(1_000, Math.max(1, Number(request.query.limit ?? 500) || 500));
      const response: ConsoleLogResponse = {
        entries: consoleStore.recent(request.params.jobId, limit),
      };
      return response;
    },
  );

  app.delete<{ Params: JobParams }>('/api/jobs/:jobId/console', async (request, reply) => {
    consoleStore.clear(request.params.jobId);
    return reply.code(204).send();
  });

  /**
   * "Send errors to the agent" — the click that replaces copy-paste.
   *
   * Track A owns the endpoint that turns this into a synthetic user turn, so this
   * WILL 404 until integration. That is handled rather than propagated: the
   * entries are real and already in the log, so we report `delivered: false` with
   * the composed message and let the UI say "queued, agent not reachable yet"
   * instead of throwing. Degrading is the whole requirement here.
   */
  app.post<{ Params: JobParams; Body: SendConsoleToAgentRequest }>(
    '/api/jobs/:jobId/console/send',
    async (request, reply) => {
      const jobId = request.params.jobId;
      const agentId = request.body?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return reply.code(400).send({ error: 'agent_required' });
      }

      const entries =
        Array.isArray(request.body?.entries) && request.body.entries.length > 0
          ? sanitiseEntries(request.body)
          : consoleStore.errors(jobId);

      if (entries.length === 0) {
        return reply.code(400).send({ error: 'nothing_to_send' });
      }

      const text = composeAgentMessage(entries);

      // Track A's endpoint, per the ownership table in shared/src/wire.ts.
      // Called over HTTP rather than imported because Track A's module does not
      // exist yet and this track must not depend on its shape. An in-process
      // seam would be better once it lands — see the escalation note in the
      // handback report.
      const target = `${selfOrigin(app)}/api/agents/${encodeURIComponent(agentId)}/message`;
      let delivered = false;
      let detail = '';
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env['CONDUCTOR_TOKEN']
              ? { authorization: `Bearer ${process.env['CONDUCTOR_TOKEN']}` }
              : {}),
          },
          body: JSON.stringify({ text, synthetic: true }),
          signal: AbortSignal.timeout(5_000),
        });
        delivered = res.ok;
        if (!res.ok) detail = `session engine answered ${res.status}`;
      } catch (err) {
        detail = err instanceof Error ? err.message : 'unreachable';
      }

      if (!delivered) {
        request.log.info(
          { agentId, count: entries.length, detail },
          'preview: console→agent handoff not delivered (Track A endpoint pending)',
        );
      }

      const response: SendConsoleToAgentResponse = {
        delivered,
        count: entries.length,
        text,
        ...(delivered ? {} : { detail: detail || 'agent endpoint unavailable' }),
      };
      return reply.send(response);
    },
  );
}
