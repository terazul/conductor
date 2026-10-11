/**
 * Copilot session events → EventPayload.  TRACK A. (Amendment 76)
 *
 * The Copilot engine's half of what translate.ts is for Claude: where one of its events
 * stops being an SDK event. No I/O and no SDK calls, so session/verify.ts drives it
 * with recorded events. The one piece of state is the calls in flight, because
 * `tool.execution_complete` does not say which tool it was (findings, question 5): it
 * is matched to its `tool.execution_start` by `toolCallId`.
 *
 * Tool names and inputs go through translate.ts's `normaliseTool`, so the transcript,
 * the activity feed, the queue and the arbiter's rules all see `Bash`, `Edit` and
 * `file_path`, whichever engine made the call.
 *
 * Defensive like translate.ts: events come from a runtime newer than these types may
 * know, so nothing here throws on a surprising one. Unknown events are dropped.
 */

import type { PermissionRequest, SessionEvent } from '@github/copilot-sdk';
import type { EventPayload } from '@conductor/shared';
import { fileEditFromTool, isWriteTool, normaliseTool, todoFromInput, toolLabel, toolSummary } from '../translate.js';
import type { ApiFailure } from '../retry.js';

/** A call that has started and not yet ended. */
export interface CallInfo {
  /** Claude's name for it (`Bash`, `Edit`), or its own when it has none. */
  tool: string;
  input: Record<string, unknown>;
  startedAt: number;
}

/**
 * How a turn ended, from the root agent's events. An error carries what `session.error` said
 * besides its message (Amendment 123): `apiFailureOf` reads it, to tell the model being
 * unreachable from an error retrying can't mend.
 */
export type TurnEnd =
  | { kind: 'idle' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string; errorType?: string; statusCode?: number };

/** What one event means. Most mean nothing; a few mean several things. */
export interface Step {
  payloads: EventPayload[];
  /** One model call's tokens. `assistant.usage` is per call, so the backend adds them up. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** Amendment 122: the model that call was made on, and how long it took, when the runtime says. */
  call?: { model?: string; durationMs?: number };
  /** The model replied, which ends any outage it was retrying through. */
  replied?: boolean;
  end?: TurnEnd;
}

const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class CopilotEvents {
  #worktreePath: string;
  #now: () => number;
  #calls = new Map<string, CallInfo>();

  constructor(worktreePath: string, now: () => number = Date.now) {
    this.#worktreePath = worktreePath;
    this.#now = now;
  }

  /** A call in flight, for the permission callback to name what it is asked about. */
  call(toolCallId: string | undefined): CallInfo | undefined {
    return toolCallId ? this.#calls.get(toolCallId) : undefined;
  }

  /** Calls that started and never ended — what a stop cut short. */
  open(): string[] {
    return [...this.#calls.keys()];
  }

  forget(toolCallId: string): void {
    this.#calls.delete(toolCallId);
  }

  take(event: SessionEvent): Step {
    const step: Step = { payloads: [] };
    // Events of a sub-agent (Copilot's `task`) carry its id. Its tool calls and its spend
    // are this agent's work; its words and its idling are not this agent's turn.
    const root = !(event as { agentId?: unknown }).agentId;
    try {
      switch (event.type) {
        case 'assistant.message': {
          if (!root) break;
          const text = typeof event.data.content === 'string' ? event.data.content : '';
          if (text.trim()) step.payloads.push({ kind: 'text', text });
          step.replied = true;
          break;
        }

        case 'tool.execution_start': {
          const { toolCallId } = event.data;
          const { tool, input } = normaliseTool(event.data.toolName, event.data.arguments);
          this.#calls.set(toolCallId, { tool, input, startedAt: this.#now() });
          step.payloads.push({
            kind: 'tool_start',
            toolUseId: toolCallId,
            tool,
            input,
            label: toolLabel(tool, input, this.#worktreePath),
          });
          // The agent's own plan, when it publishes one.
          if (tool === 'TodoWrite') {
            const todo = todoFromInput(input);
            if (todo) step.payloads.push(todo);
          }
          break;
        }

        case 'tool.execution_complete': {
          const { toolCallId } = event.data;
          const call = this.#calls.get(toolCallId);
          // An end with no start is a call from before this run (a resume): nothing to close.
          if (!call) break;
          this.#calls.delete(toolCallId);
          const ok = event.data.success === true;
          const durationMs = Math.max(0, this.#now() - call.startedAt);
          const response = ok ? (event.data.result?.content ?? '') : { error: event.data.error?.message ?? 'failed' };
          step.payloads.push({
            kind: 'tool_end',
            toolUseId: toolCallId,
            ok,
            summary: toolSummary(call.tool, response, ok, durationMs),
            durationMs,
          });
          if (ok && isWriteTool(call.tool)) {
            const edit = fileEditFromTool(call.tool, call.input, this.#worktreePath);
            if (edit) step.payloads.push(edit);
          }
          break;
        }

        case 'assistant.usage': {
          const d = bag(event.data);
          step.usage = {
            inputTokens: num(d['inputTokens']),
            outputTokens: num(d['outputTokens']),
            cacheReadTokens: num(d['cacheReadTokens']),
          };
          step.call = {
            ...(typeof d['model'] === 'string' && d['model'] ? { model: d['model'] } : {}),
            ...(num(d['duration']) > 0 ? { durationMs: num(d['duration']) } : {}),
          };
          break;
        }

        case 'session.idle':
          // `autopilot` idles between its own steps; the SDK's sendAndWait ignores those too.
          if (root && event.data.mode !== 'autopilot') step.end = event.data.aborted ? { kind: 'aborted' } : { kind: 'idle' };
          break;

        case 'abort':
          if (root) step.end = { kind: 'aborted' };
          break;

        case 'session.error':
          if (root) {
            step.end = {
              kind: 'error',
              message: event.data.message || event.data.errorType || 'error',
              ...(event.data.errorType ? { errorType: event.data.errorType } : {}),
              ...(typeof event.data.statusCode === 'number' ? { statusCode: event.data.statusCode } : {}),
            };
          }
          break;

        default:
          // Deltas, reasoning, hooks, MCP status and the rest carry nothing the frozen
          // event union models. Dropped, as claude.ts drops what it can't place.
          break;
      }
    } catch (err) {
      console.error('[copilot] could not translate an event', event.type, err);
    }
    return step;
  }
}

/** A message that says the connection itself failed, as Node and fetch word it. */
const CONNECTION_LOST =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket hang up|fetch failed|network error|getaddrinfo|timed? ?out|connection (?:error|reset|refused|closed)/i;

/**
 * What the Copilot runtime said when a run ended in error, in the SDK's terms (Amendment 123),
 * so Copilot and OpenRouter retry the way Claude does. Null for an error that is not the
 * model API's, or that waiting can't mend: a full context, a bad query, or one we can't place.
 * Pure, so session/verify.ts drives it with the errors the runtime sends.
 *
 * `errorType` is the runtime's category ("authentication", "authorization", "quota",
 * "rate_limit", "context_limit", "query"); `statusCode` the upstream HTTP status. With neither,
 * the message has to say the connection failed, or it is not treated as the model's.
 */
export function apiFailureOf(e: { message: string; errorType?: string; statusCode?: number }): ApiFailure | null {
  const type = (e.errorType ?? '').toLowerCase();
  const status = typeof e.statusCode === 'number' ? e.statusCode : null;
  if (type === 'authentication' || type === 'authorization' || status === 401 || status === 403) {
    return { httpStatus: status, error: 'authentication_failed' };
  }
  if (type === 'quota' || status === 402) return { httpStatus: status, error: 'billing_error' };
  if (type === 'rate_limit' || status === 429) return { httpStatus: status ?? 429, error: 'rate_limit' };
  if (type === 'context_limit' || type === 'query') return { httpStatus: status, error: 'invalid_request' };
  if (status !== null) return { httpStatus: status, error: status >= 500 ? 'server_error' : 'invalid_request' };
  return CONNECTION_LOST.test(e.message) ? { httpStatus: null, error: 'unknown' } : null;
}

/**
 * What a permission request is asking about, as a Claude tool call: the name the
 * arbiter, the rules and the queue go by, and its input in Claude's keys.
 *
 * The request's own fields decide — `fullCommandText` is exactly the command that will
 * run — and the call it belongs to, when its `tool.execution_start` has been seen, fills
 * in the rest (an edit's old and new text, so the card can show what changes).
 */
export function askFromPermission(req: PermissionRequest, started?: CallInfo): { tool: string; input: Record<string, unknown> } {
  const from = started?.input ?? {};
  switch (req.kind) {
    case 'shell':
      return { tool: 'Bash', input: { ...from, command: req.fullCommandText, ...(req.intention ? { description: req.intention } : {}) } };
    case 'write': {
      const tool = started && (started.tool === 'Write' || started.tool === 'Edit') ? started.tool : req.newFileContents !== undefined ? 'Write' : 'Edit';
      const extra = tool === 'Write' && req.newFileContents !== undefined && from['content'] === undefined ? { content: req.newFileContents } : {};
      return { tool, input: { ...from, ...extra, file_path: req.fileName } };
    }
    case 'read':
      return { tool: started?.tool === 'Grep' || started?.tool === 'Glob' ? started.tool : 'Read', input: { ...from, file_path: req.path } };
    case 'url':
      return { tool: 'WebFetch', input: { ...from, url: req.url } };
    case 'mcp':
      return { tool: `mcp__${req.serverName}__${req.toolName}`, input: bag(req.args) };
    case 'custom-tool':
      return { tool: req.toolName, input: bag(req.args) };
    case 'hook':
      return normaliseTool(req.toolName, req.toolArgs);
    default:
      // memory, extension and workflow requests: named for what they are.
      return { tool: started?.tool ?? `copilot:${req.kind}`, input: { ...from, ...bag(req) } };
  }
}
