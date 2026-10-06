/**
 * SDK → EventPayload translation. Pure functions, no I/O, no SDK calls.
 *
 * Everything the UI renders is a projection of the event log (CONTRACT.md §5.2),
 * so this file is where an SDK message stops being an SDK message. Keeping it
 * pure also keeps the seam that PLAN.md §11.4 wants for non-Claude drivers: swap
 * the runner, keep the event model.
 *
 * Defensive by policy: tool inputs are model-authored and their shape varies by
 * tool and by SDK version. Nothing here may throw on a surprising payload.
 *
 * ONE SET OF FUNCTIONS FOR EVERY ENGINE (Amendment 76). GitHub Copilot names its tools
 * differently (`bash`, `view`, `edit`, `create`, `update_todo`) and shapes their input
 * differently (`path`, `old_str`, `file_text`, a markdown checklist). `normaliseTool`
 * turns one of its calls into the Claude call it is, and every function below starts
 * from that, so labels, write detection, file edits and todos are worked out once. A
 * Claude name is not in the map, so a Claude call passes through untouched.
 */

import { relative } from 'node:path';
import sanitize from 'sanitize-html';
import type {
  FileEditPayload,
  Question,
  QuestionOption,
  TodoPayload,
} from '@conductor/shared';

/** Narrow an unknown tool input to a bag we can read keys off. */
function bag(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/**
 * Worktree-relative POSIX path, per FileEditPayload's contract. A path outside the
 * worktree — one of the project's other directories (Amendment 39) — stays absolute:
 * "../../notes/a.md" names nothing a reader can find.
 */
export function relPath(worktreePath: string, absOrRel: string): string {
  if (!absOrRel) return absOrRel;
  const rel = absOrRel.startsWith('/') ? relative(worktreePath, absOrRel) : absOrRel;
  if (absOrRel.startsWith('/') && (rel === '..' || rel.startsWith('../') || rel.startsWith('/'))) {
    return absOrRel;
  }
  return rel.split('\\').join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// other engines' tool names (Amendment 76)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copilot's built-in tools, by the Claude tool each one is. From the runtime's strings
 * and session logs (docs/plans/multi-provider-findings.md, question 9); the definitive
 * list is only known at runtime, so a name missing here is shown as it came.
 * `str_replace_editor` is several tools in one, told apart by its `command`.
 */
export const COPILOT_TOOLS: Readonly<Record<string, string>> = {
  bash: 'Bash',
  powershell: 'Bash',
  view: 'Read',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  create: 'Write',
  update_todo: 'TodoWrite',
  ask_user: 'AskUserQuestion',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Task',
};

/**
 * The Copilot tools that are exactly one Claude tool, for Copilot's `excludedTools`.
 * `str_replace_editor` is left out: it reads and creates as well as edits, so excluding
 * it for "no Edit" would take away more than was asked.
 */
export function copilotToolsFor(claudeName: string): string[] {
  return Object.entries(COPILOT_TOOLS)
    .filter(([copilot, claude]) => claude === claudeName && copilot !== 'str_replace_editor')
    .map(([copilot]) => copilot);
}

/**
 * Another engine's tool call as the Claude call it is: the name, and the input in
 * Claude's keys (`file_path`, `old_string`, `content`, `todos: [...]`). Anything not in
 * the map — every Claude name, an MCP tool, an unknown one — comes back as it was.
 */
export function normaliseTool(tool: string, input: unknown): { tool: string; input: Record<string, unknown> } {
  const b = bag(input);
  const claude = COPILOT_TOOLS[tool];
  if (!claude) return { tool, input: b };
  const path = str(b['path']) ?? str(b['file_path']);
  const at = path !== undefined ? { file_path: path } : {};

  switch (tool) {
    case 'bash':
    case 'powershell':
      return { tool: 'Bash', input: { command: str(b['command']) ?? '', ...(str(b['description']) ? { description: b['description'] } : {}) } };
    case 'view':
      return { tool: 'Read', input: at };
    case 'edit':
      return { tool: 'Edit', input: { ...at, old_string: str(b['old_str']) ?? '', new_string: str(b['new_str']) ?? '' } };
    case 'create':
      return { tool: 'Write', input: { ...at, content: str(b['file_text']) ?? '' } };
    case 'str_replace_editor': {
      const command = str(b['command']);
      if (command === 'view') return { tool: 'Read', input: at };
      if (command === 'create') return { tool: 'Write', input: { ...at, content: str(b['file_text']) ?? '' } };
      // `insert` adds new_str after a line: nothing is replaced.
      const oldS = command === 'insert' ? '' : (str(b['old_str']) ?? '');
      return { tool: 'Edit', input: { ...at, old_string: oldS, new_string: str(b['new_str']) ?? '' } };
    }
    case 'update_todo':
      return { tool: 'TodoWrite', input: { todos: Array.isArray(b['todos']) ? b['todos'] : checklist(str(b['todos']) ?? '') } };
    case 'ask_user': {
      const question = str(b['question']) ?? '';
      const choices = Array.isArray(b['choices']) ? b['choices'].filter((c): c is string => typeof c === 'string') : [];
      return {
        tool: 'AskUserQuestion',
        input: { questions: [{ question, header: question, options: choices.map((label) => ({ label, description: '' })), multiSelect: false }] },
      };
    }
    case 'grep':
    case 'glob':
      return { tool: claude, input: { pattern: str(b['pattern']) ?? '', ...(path !== undefined ? { path } : {}) } };
    case 'task':
      return {
        tool: 'Task',
        input: {
          description: str(b['description']) ?? '',
          prompt: str(b['prompt']) ?? '',
          ...(str(b['agent_type']) ? { subagent_type: b['agent_type'] } : {}),
        },
      };
    default:
      // web_fetch and web_search already use Claude's keys (`url`, `query`).
      return { tool: claude, input: b };
  }
}

/**
 * A markdown checklist as TodoWrite's list. `[x]` is done; `[~]`, `[-]` and `[>]`,
 * which some models use for "doing now", are in progress; `[ ]` is pending. Lines that
 * are not checklist items are dropped.
 */
function checklist(md: string): Array<{ content: string; status: string }> {
  const out: Array<{ content: string; status: string }> = [];
  for (const line of md.split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX~>-])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const mark = m[1]!;
    out.push({ content: m[2]!, status: mark === 'x' || mark === 'X' ? 'completed' : mark === ' ' ? 'pending' : 'in_progress' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// labels — the one-line summary the activity feed and the queue both show
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Edit src/auth/token.ts`, `Bash rm -rf dist/`, `Read docs/PLAN.md`.
 * Used for ToolStartPayload.label and for a request's queue label, so the
 * attention card and the transcript agree on wording.
 */
export function toolLabel(rawTool: string, rawInput: unknown, worktreePath = ''): string {
  const { tool, input } = normaliseTool(rawTool, rawInput);
  const b = input;
  const path = str(b['file_path']) ?? str(b['path']) ?? str(b['notebook_path']);
  const rel = path ? relPath(worktreePath, path) : undefined;

  switch (tool) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = str(b['command']) ?? '';
      return `Bash · ${clip(cmd.replace(/\s+/g, ' ').trim(), 90)}`;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${tool} ${rel ?? '(unknown path)'}`;
    case 'Glob':
      return `Glob ${str(b['pattern']) ?? ''}`.trim();
    case 'Grep':
      return `Grep ${clip(str(b['pattern']) ?? '', 60)}`.trim();
    case 'WebFetch':
      return `WebFetch ${clip(str(b['url']) ?? '', 70)}`.trim();
    case 'WebSearch':
      return `WebSearch ${clip(str(b['query']) ?? '', 60)}`.trim();
    case 'TodoWrite':
      return 'TodoWrite · updated the plan';
    case 'AskUserQuestion': {
      const qs = extractQuestions(input);
      return qs[0] ? clip(qs[0].question, 90) : 'AskUserQuestion';
    }
    case 'Task':
      return `Task ${clip(str(b['description']) ?? '', 70)}`.trim();
    default: {
      // MCP tools arrive as mcp__server__tool; show the tool, not the plumbing.
      const short = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool;
      return rel ? `${short} ${rel}` : short;
    }
  }
}

/** Short result line: `6 passed, 1 xfail`, `clean · 2.4s`, `error: …`. */
export function toolSummary(
  tool: string,
  response: unknown,
  ok: boolean,
  durationMs?: number,
): string {
  const secs = durationMs !== undefined ? ` · ${(durationMs / 1000).toFixed(1)}s` : '';
  if (!ok) {
    const msg = firstText(response) ?? 'failed';
    return `error: ${clip(msg.replace(/\s+/g, ' ').trim(), 100)}`;
  }

  const text = firstText(response);
  if (text === undefined) return `ok${secs}`;

  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length === 0) return `ok${secs}`;

  // One line? Show it. Many lines? Count them — a 900-line Read is noise.
  const lines = trimmed.split('\n');
  if (lines.length === 1) return `${clip(lines[0]!.trim(), 100)}${secs}`;
  return `${lines.length} lines${secs}`;
}

/** Pull display text out of the many shapes a tool_response can take. */
function firstText(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    for (const part of response) {
      const t = firstText(part);
      if (t !== undefined) return t;
    }
    return undefined;
  }
  const b = bag(response);
  return (
    str(b['text']) ??
    str(b['stdout']) ??
    str(b['output']) ??
    str(b['content']) ??
    str(b['message']) ??
    str(b['error']) ??
    undefined
  );
}

/** Tool calls that mutate files, so the runner knows when to emit file_edit. */
export function isWriteTool(rawTool: string): boolean {
  const tool = COPILOT_TOOLS[rawTool] ?? rawTool;
  return tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit';
}

/**
 * Best-effort diffstat for one write, tagged `source: 'tool'`.
 *
 * Exact line accounting belongs to Track C's git-backed watcher; this exists so
 * the transcript shows a number immediately instead of waiting for a filesystem
 * event, and so the write has a real `agentId` attached — the watcher sees bytes,
 * not authors.
 *
 * `source` is what keeps the two channels from double-counting: `diffstat()`
 * resolves per path, preferring authoritative events and falling back to these
 * estimates only where no watcher event will ever arrive (Amendment 8). Absent
 * `source` means authoritative, so omitting it here would silently restore the
 * double count.
 */
export function fileEditFromTool(
  rawTool: string,
  rawInput: unknown,
  worktreePath: string,
): FileEditPayload | null {
  const { tool, input: b } = normaliseTool(rawTool, rawInput);
  const path = str(b['file_path']) ?? str(b['notebook_path']) ?? str(b['path']);
  if (!path) return null;
  // Outside the worktree: one of the project's other directories (Amendment 39). A
  // file_edit is worktree-relative by contract, and would badge a file in the job's
  // tree that isn't the one written, so none is emitted.
  if (relPath(worktreePath, path).startsWith('/')) return null;

  /**
   * A file ending in "\n" has N lines, not N+1. `'a\nb\n'.split('\n')` yields a
   * trailing empty element, so a naive length overcounts every written file by
   * one — measured against `git diff --numstat`, which is what the authoritative
   * watcher reports. Usually invisible because authoritative wins, but for
   * in_place jobs and worktrees past the watcher cap this estimate IS the number
   * the UI shows.
   */
  const countLines = (s: string): number => {
    if (s.length === 0) return 0;
    return s.replace(/\n$/, '').split('\n').length;
  };

  if (tool === 'Write') {
    return {
      kind: 'file_edit',
      path: relPath(worktreePath, path),
      added: countLines(str(b['content']) ?? ''),
      removed: 0,
      created: true,
      source: 'tool',
    };
  }

  if (tool === 'Edit') {
    // An Edit replaces old_string with new_string, possibly many times.
    const oldS = str(b['old_string']) ?? '';
    const newS = str(b['new_string']) ?? '';
    const times = b['replace_all'] === true ? 1 : 1;
    return {
      kind: 'file_edit',
      path: relPath(worktreePath, path),
      added: countLines(newS) * times,
      removed: countLines(oldS) * times,
      source: 'tool',
    };
  }

  return {
    kind: 'file_edit',
    path: relPath(worktreePath, path),
    added: 0,
    removed: 0,
    source: 'tool',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// todos
// ─────────────────────────────────────────────────────────────────────────────

/** TodoWrite's input, mapped onto the frozen TodoPayload states. */
export function todoFromInput(input: unknown): TodoPayload | null {
  const b = bag(input);
  // Copilot's update_todo sends a markdown checklist where TodoWrite sends a list.
  const raw = typeof b['todos'] === 'string' ? checklist(b['todos']) : b['todos'];
  if (!Array.isArray(raw)) return null;

  const items: TodoPayload['items'] = [];
  for (const entry of raw) {
    const e = bag(entry);
    const text = str(e['content']) ?? str(e['text']) ?? str(e['activeForm']);
    if (!text) continue;
    const status = str(e['status']) ?? 'pending';
    items.push({
      text,
      state: status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : 'pending',
    });
  }
  return items.length > 0 ? { kind: 'todo', items } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Previews are model-authored HTML — we asked for HTML by setting
 * toolConfig.askUserQuestion.previewFormat, so we own the sanitizing. Stored
 * sanitized, never sanitized-on-render, so a future renderer cannot forget.
 */
export function sanitizePreview(html: string): string {
  return sanitize(html, {
    allowedTags: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'kbd', 'small',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'span', 'div', 'hr', 'blockquote',
    ],
    allowedAttributes: { '*': ['class'] },
    // No href/src at all: a preview must not be able to phone home or navigate.
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
  });
}

/** Normalise AskUserQuestion's input into the frozen Question[] shape. */
export function extractQuestions(input: unknown): Question[] {
  const b = bag(input);
  const raw = b['questions'];
  if (!Array.isArray(raw)) return [];

  const out: Question[] = [];
  for (const entry of raw) {
    const e = bag(entry);
    const question = str(e['question']) ?? str(e['header']);
    if (!question) continue;

    const options: QuestionOption[] = [];
    const rawOptions = e['options'];
    if (Array.isArray(rawOptions)) {
      for (const o of rawOptions) {
        const ob = bag(o);
        const label = str(ob['label']) ?? str(ob['name']);
        if (!label) continue;
        const preview = str(ob['preview']);
        options.push({
          label,
          description: str(ob['description']) ?? '',
          ...(preview ? { preview: sanitizePreview(preview) } : {}),
        });
      }
    }

    out.push({
      question,
      header: str(e['header']) ?? question,
      options,
      multiSelect: e['multiSelect'] === true,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// reversibility — the permission card's "can I undo this?" line
// ─────────────────────────────────────────────────────────────────────────────

const IRREVERSIBLE = [
  { re: /\brm\s+(-[a-z]*\s+)*-?[rf]/i, why: 'deletes files' },
  { re: /\bgit\s+push\b/i, why: 'publishes commits to a remote' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'discards uncommitted work' },
  { re: /\bgit\s+clean\b/i, why: 'deletes untracked files' },
  { re: /\b(drop|truncate)\s+(table|database)\b/i, why: 'destroys database data' },
  { re: /\b(curl|wget)\b/i, why: 'reaches the network' },
  { re: /\bnpm\s+publish\b/i, why: 'publishes a package' },
  { re: /\b(kubectl|terraform)\s+(apply|delete|destroy)\b/i, why: 'changes live infrastructure' },
  { re: /\bsudo\b/i, why: 'runs as root' },
  { re: />\s*\/dev\/(sd|disk)/i, why: 'writes to a raw device' },
];

/**
 * Best-effort, and labelled as such on the card. A wrong "reversible" is worse
 * than no answer, so anything unrecognised is reported as unknown-but-cautious
 * rather than guessed safe.
 */
export function reversibility(
  rawTool: string,
  rawInput: unknown,
): { value: boolean; reason: string } {
  const { tool, input: b } = normaliseTool(rawTool, rawInput);

  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'WebSearch') {
    return { value: true, reason: 'read-only' };
  }
  if (isWriteTool(tool)) {
    return { value: true, reason: 'file change, recoverable from git' };
  }
  if (tool === 'Bash') {
    const cmd = str(b['command']) ?? '';
    for (const { re, why } of IRREVERSIBLE) {
      if (re.test(cmd)) return { value: false, reason: why };
    }
    return { value: true, reason: 'no known irreversible operation in this command' };
  }
  if (tool === 'WebFetch') return { value: true, reason: 'read-only network fetch' };

  return { value: false, reason: 'unrecognised tool — treated as irreversible' };
}

// ─────────────────────────────────────────────────────────────────────────────
// assistant text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Text blocks from one assistant message. `thinking` blocks are deliberately
 * dropped: the transcript shows what the agent did and said, and reasoning text
 * is both large and not ours to surface.
 */
export function assistantText(message: unknown): string[] {
  const b = bag(message);
  const content = b['content'];
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    const bb = bag(block);
    if (bb['type'] !== 'text') continue;
    const text = str(bb['text']);
    if (text && text.trim().length > 0) out.push(text);
  }
  return out;
}
