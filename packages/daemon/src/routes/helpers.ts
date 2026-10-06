/**
 * The Conductor tools an orchestrator calls — an MCP server over HTTP. (Amendment 51)
 *
 * One endpoint per agent, `/mcp/agents/:agentId`, so the call names who is asking and
 * no tool argument can claim to be someone else. It speaks the few JSON-RPC methods a
 * client needs for tools — `initialize`, `tools/list`, `tools/call`, plus notifications,
 * answered with 202 — and replies with plain JSON, which the streamable-HTTP transport
 * allows. No streams, no sessions: every call is answered at once.
 *
 * Bound like everything else here: the daemon's localhost guard runs first, and a
 * CONDUCTOR_TOKEN, when set, is sent by the runner as a header.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { supervisor } from '../session/supervisor.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const MCP_TOOLS = [
  {
    name: 'start_helper',
    description:
      'Start a helper agent on one part of the task. It works in this same folder, at the same time, with your model and ' +
      'permissions, and replies with what it did. Returns its role. Give each helper a part that does not touch the ' +
      'same files as another.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The part of the work this helper does, said in full.' },
        name: { type: 'string', description: 'A short name for it, like "api" or "tests". Optional.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_helpers',
    description: "Your helpers: each one's role and status, and its last reply once it has ended.",
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export function callTool(agentId: string, name: string, args: Record<string, unknown>) {
  try {
    if (name === 'start_helper') {
      const task = typeof args['task'] === 'string' ? args['task'] : '';
      const nm = typeof args['name'] === 'string' ? args['name'] : undefined;
      const h = supervisor().startHelper(agentId, task, nm);
      return text(`Started ${h.role}. It is queued, and starts as soon as a slot is free. End your turn when you have started the helpers you need; you'll be told what they report.`);
    }
    if (name === 'list_helpers') {
      const list = supervisor().listHelpers(agentId);
      if (list.length === 0) return text('No helpers started yet.');
      return text(list.map((h) => `${h.role}: ${h.status}${h.reply ? `\n${h.reply}` : ''}`).join('\n\n'));
    }
    return text(`No tool called ${name}.`, true);
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

export default async function helperRoutes(app: FastifyInstance): Promise<void> {
  const answer = (reply: FastifyReply, id: RpcRequest['id'], result: unknown) =>
    reply.send({ jsonrpc: '2.0', id: id ?? null, result });
  const error = (reply: FastifyReply, id: RpcRequest['id'], code: number, message: string) =>
    reply.send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  app.post<{ Params: { agentId: string } }>('/mcp/agents/:agentId', async (req, reply) => {
    const body = (req.body ?? {}) as RpcRequest;
    const { agentId } = req.params;
    if (typeof body.method !== 'string') return error(reply.code(400), body.id, -32600, 'not a JSON-RPC request');
    // A notification has no id and wants no answer.
    if (body.id === undefined || body.method.startsWith('notifications/')) return reply.code(202).send();

    switch (body.method) {
      case 'initialize':
        return answer(reply, body.id, {
          protocolVersion: typeof body.params?.['protocolVersion'] === 'string' ? body.params['protocolVersion'] : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'conductor', version: '1' },
        });
      case 'ping':
        return answer(reply, body.id, {});
      case 'tools/list':
        return answer(reply, body.id, { tools: MCP_TOOLS });
      case 'tools/call': {
        const name = typeof body.params?.['name'] === 'string' ? body.params['name'] : '';
        const args = (body.params?.['arguments'] ?? {}) as Record<string, unknown>;
        return answer(reply, body.id, callTool(agentId, name, args));
      }
      default:
        return error(reply, body.id, -32601, `method not found: ${body.method}`);
    }
  });

  // No server-to-client stream: a client that asks for one is told so, per the transport.
  app.get('/mcp/agents/:agentId', async (_req, reply) => reply.code(405).header('allow', 'POST').send());
}
