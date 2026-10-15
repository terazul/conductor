/**
 * The Conductor tools an agent calls — an MCP server over HTTP. (Amendments 51, 104)
 *
 * One endpoint per agent, `/mcp/agents/:agentId`, so the call names who is asking and
 * no tool argument can claim to be someone else. It speaks the few JSON-RPC methods a
 * client needs for tools — `initialize`, `tools/list`, `tools/call`, plus notifications,
 * answered with 202 — and replies with plain JSON, which the streamable-HTTP transport
 * allows. No streams, no sessions: every call is answered at once.
 *
 * An orchestrator gets `start_helper` and `list_helpers`; an agent that others wait for gets
 * `hand_off` (Amendment 104); one agent can be both. `toolsFor` says which, and `tools/list`
 * answers with that agent's own. A helper never gets `hand_off`: it hands its reply to the agent
 * that started it, and an orchestrated stack's orchestrator judges the result in its place
 * (Amendment 128).
 *
 * The orchestrator of an orchestrated stack (Amendment 128) has a `start_helper` that takes a
 * `role`, one of the roles it was launched with, and a cheaper `tier`; the schema it is given
 * names them. An ordinary orchestrator's is as it always was.
 *
 * Bound like everything else here: the daemon's localhost guard runs first, and a
 * CONDUCTOR_TOKEN, when set, is sent by the runner as a header.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { SEND_BACKS_MAX } from '@conductor/shared';
import { supervisor } from '../session/supervisor.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const HAND_OFF = 'hand_off';

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
  {
    name: HAND_OFF,
    description:
      'Hand your work on to the agents that wait for you. Call it when you are done, with a summary of what they need: ' +
      'what you did, what you decided and why, what is left, and the files to look at. They start after your turn ends, ' +
      'and are told this summary first, then your conversation. If your turn ends without calling it they do not start: ' +
      'you wait for the user to hand off for you.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What the next agents need from your work, said in full.' },
      },
      required: ['summary'],
    },
  },
];

/** A role an orchestrated stack's orchestrator may start, as its `start_helper` is told (Amendment 128). */
export interface ToolRole {
  id: string;
  /** The tier it was listed on, when the engine has tiers. */
  tier?: string;
  /** The exact model id its helpers run on. */
  model?: string;
  /** A reading role: its helpers cannot change files. */
  reads?: boolean;
}

/** What an agent is given of these: set when its run is built, and again by `tools/list`. */
export interface ToolAccess {
  /** An orchestrator's helper cap: any above 0 gives it `start_helper` and `list_helpers`. */
  helperCap?: number;
  /** Agents wait for it: it gets `hand_off`. */
  handOff?: boolean;
  /** Amendment 128: the roles its `start_helper` may name. Absent or empty: an ordinary orchestrator, with no role. */
  roles?: readonly ToolRole[];
}

/** One tool as the endpoint lists it, and as Copilot's and OpenRouter's in-process tools are defined from it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * `start_helper` for an orchestrator that was launched with roles (Amendment 128): it names a
 * `role` it must give, and may give a `tier` for a cheaper model. Built per orchestrator, so the
 * roles are in the schema the model reads. The check that a role is listed is the daemon's
 * (`Supervisor.startHelper`), not this text's.
 */
export function startHelperWithRoles(roles: readonly ToolRole[]): McpTool {
  const ids = roles.map((r) => r.id);
  const listed = roles
    .map((r) => `${r.id}${r.tier || r.reads ? ` (${[r.tier ? `on ${r.tier}` : '', r.reads ? 'reads only' : ''].filter(Boolean).join(', ')})` : ''}`)
    .join(', ');
  return {
    name: 'start_helper',
    description:
      `Start the next step of the pipeline as one of these roles: ${listed}. It works in this same folder with that ` +
      "role's own instructions, tools and model, and replies with what it did. Write the task in full: it does not see " +
      'this conversation. Give new work a new name; the same role with the same name again sends that work back, at ' +
      `most ${SEND_BACKS_MAX} times. Returns its role. Start one step, then end your turn; you are woken with what it did.`,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ids, description: `Which role does this step: ${ids.join(', ')}.` },
        task: { type: 'string', description: 'The brief for this step, said in full: what to do, which files, what done looks like, what the earlier steps found.' },
        tier: {
          type: 'string',
          enum: ['opus', 'sonnet', 'haiku'],
          description: 'A cheaper model than the one listed for the role, for an easy step. Optional; a dearer one than listed is refused.',
        },
        name: {
          type: 'string',
          description: `A short name for this piece of work, like "api" or "tests": its lane. A new name is new work; the same name again is a send-back, at most ${SEND_BACKS_MAX} times. Optional.`,
        },
      },
      required: ['role', 'task'],
    },
  };
}

/** The tools this agent is given, in the order of `MCP_TOOLS`. */
export function toolsFor(access: ToolAccess): McpTool[] {
  const roles = access.roles ?? [];
  return MCP_TOOLS.filter((t) => (t.name === HAND_OFF ? access.handOff === true : (access.helperCap ?? 0) > 0)).map((t) =>
    t.name === 'start_helper' && roles.length > 0 ? startHelperWithRoles(roles) : t,
  );
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export function callTool(agentId: string, name: string, args: Record<string, unknown>) {
  try {
    if (name === 'start_helper') {
      const task = typeof args['task'] === 'string' ? args['task'] : '';
      const nm = typeof args['name'] === 'string' ? args['name'] : undefined;
      // A role and a tier are for an orchestrated stack's orchestrator (Amendment 128). A value that
      // is not text is refused, not dropped: dropping it would start a helper with no role.
      for (const key of ['role', 'tier']) {
        const v = args[key];
        if (v !== undefined && v !== null && typeof v !== 'string') return text(`${key} is text: ${key === 'role' ? 'the name of one of the listed roles' : 'opus, sonnet or haiku'}.`, true);
      }
      const role = typeof args['role'] === 'string' && args['role'].trim() ? args['role'] : undefined;
      const tier = typeof args['tier'] === 'string' ? args['tier'] : undefined;
      const h = supervisor().startHelper(agentId, task, nm, role, tier);
      if (role) {
        return text(
          `Started ${h.role}. It is queued, and starts as soon as a slot is free. End your turn now: you will be woken with its ` +
            'whole conversation. Read it before you start the next step.',
        );
      }
      return text(`Started ${h.role}. It is queued, and starts as soon as a slot is free. End your turn when you have started the helpers you need; you'll be told what they report.`);
    }
    if (name === 'list_helpers') {
      const list = supervisor().listHelpers(agentId);
      if (list.length === 0) return text('No helpers started yet.');
      return text(list.map((h) => `${h.role}: ${h.status}${h.reply ? `\n${h.reply}` : ''}`).join('\n\n'));
    }
    if (name === HAND_OFF) {
      const summary = typeof args['summary'] === 'string' ? args['summary'] : '';
      const { waiting, missing } = supervisor().handOff(agentId, summary);
      // Kept either way; a summary short of its closing headings is told so at once.
      if (missing.length > 0) {
        return text(
          `Handed off, but your summary has no heading for ${missing.join(', ')}. It is saved, and ${waiting.join(' and ')} ` +
            'will be told it first once your turn ends. Call hand_off again with the whole summary, those headings ' +
            'included: the new one replaces this one.',
        );
      }
      return text(
        `Handed off. ${waiting.join(' and ')} will start once your turn ends, and will be told your summary first. ` +
          'End your turn now if you have nothing else to do.',
      );
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
        return answer(reply, body.id, { tools: toolsFor(supervisor().toolAccess(agentId)) });
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
