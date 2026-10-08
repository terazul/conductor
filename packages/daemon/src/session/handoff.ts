/**
 * What an agent is told about the agents it waited for.  TRACK A.  (Amendments 37, 101)
 *
 * `dependsOn` used to be timing only: a reviewer started once the builder was done,
 * with the same job prompt and its own brief, and found the builder's work only because
 * they share a worktree. The files arrived; what the builder said about them did not —
 * the cause a debugger found, the tests a validator saw fail. So the first prompt of an
 * agent that waited carries what the agents before it said (Amendment 37).
 *
 * That was the last reply only, cut at 8,000 characters, and a stack handed on "I'll wait"
 * and nothing else. Now it is each agent's WHOLE conversation as text (Amendment 101): what
 * the user told it, what it replied, and one line for each tool call. What the tools
 * returned is left out. It comes from the event log, so it is the same for Claude, Copilot
 * and OpenRouter, and for an agent that waited for several.
 *
 * It is capped at about a quarter of the next model's context window (`handoffCap`),
 * shared between the agents it waited for. Over the cap the OLDEST goes first and the last
 * reply stays whole. The job instruction is not part of it: `#promptFor` puts that first,
 * and it is not counted. It goes in once, at launch: a resume continues a session that
 * already has it.
 *
 * Pure, so session/verify.ts checks the wording and the cap directly.
 */

import type { Event as LogEvent } from '@conductor/shared';

// ─────────────────────────────────────────────────────────────────────────────
// How big the next agent's model can take (Amendment 101)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context windows, in tokens, as a floor: a model with a bigger window than the table says
 * is only given less than it could take. The repo did not know any (nothing reads one from
 * Claude Code, Copilot or OpenRouter's lists), so this is the whole table. First match wins,
 * on the id with any `vendor/` in front of it removed (OpenRouter's `anthropic/claude-…`).
 */
const WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  // Claude Code's `[1m]` suffix asks for the 1M window of the model before it.
  [/\[1m\]/i, 1_000_000],
  // Claude, by id or by the nicknames Spawn takes. 200k whichever it turns out to be.
  [/claude|^(default|best|opus|sonnet|haiku|opusplan)$/i, 200_000],
  // Families whose smallest host window is 128k.
  [/^(gpt-|o\d|gemini)/i, 128_000],
];

/** A model the table does not know: small enough that a quarter of it fits anywhere likely. */
export const DEFAULT_WINDOW_TOKENS = 64_000;

/** What an upstream conversation may take up of the next model's window. */
export const HANDOFF_SHARE = 0.25;

/** Characters to a token, low on purpose: code and paths run to 3, prose to 4. */
export const CHARS_PER_TOKEN = 3;

export function contextWindow(model: string): number {
  const id = model.trim().replace(/^[^/]+\//, '');
  return WINDOWS.find(([re]) => re.test(id))?.[1] ?? DEFAULT_WINDOW_TOKENS;
}

/** In characters, for all the upstream conversations together: a quarter of `model`'s window. */
export function handoffCap(model: string): number {
  return Math.floor(contextWindow(model) * HANDOFF_SHARE * CHARS_PER_TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────
// The conversation as text (Amendment 101)
// ─────────────────────────────────────────────────────────────────────────────

/** One thing in an agent's conversation. */
export interface Turn {
  /** `user` is the person (or the launch prompt's own part), `agent` its prose, `tool` a call. */
  kind: 'user' | 'agent' | 'tool';
  text: string;
}

/** Stands in for the job instruction at the start of an upstream's launch prompt. */
const JOB_PLACEHOLDER = '(the job instruction, as above)';

/** The question tool, under the name both engines' calls are given (copilot's `ask_user` is translated to it). */
const ASK_TOOL = 'AskUserQuestion';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The turns of one agent from its log events (`eventLog().conversation`), oldest first.
 *
 *  - Its launch prompt — the first message — keeps the job instruction out, when it begins
 *    with it: every agent in the job has it, and the next agent has it at the top. The line
 *    about asking (Amendment 100) goes too. What follows stays, which is that agent's own
 *    handoff and its role brief.
 *  - A message Conductor wrote (a resume nudge, "switched to opus") is not the user's, and
 *    is left out.
 *  - A tool is one line, its label. A failed call says so. A question asked with the
 *    question tool carries the answer, which is all the log keeps of it: the tool's own
 *    one-line result, short and not the tool's output in any other sense.
 */
export function turnsFromEvents(events: readonly LogEvent[], jobPrompt: string): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, { turn: Turn; asked: boolean }>();
  const job = jobPrompt.trim();
  let launched = false;
  for (const e of events) {
    const p = e.payload;
    switch (p.kind) {
      case 'user_text': {
        if (p.synthetic) break;
        let text = p.text.trim();
        if (!launched) {
          launched = true;
          // Neither the job instruction nor the line about asking (Amendment 100) is repeated:
          // the next agent has the first at the top and is given the second for itself.
          text = text.replace(STACK_ASK_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
          if (job && text.startsWith(job)) {
            const rest = text.slice(job.length).trim();
            text = rest ? `${JOB_PLACEHOLDER}\n\n${rest}` : '';
          }
        }
        if (text) turns.push({ kind: 'user', text });
        break;
      }
      case 'text': {
        const text = p.text.trim();
        if (text) turns.push({ kind: 'agent', text });
        break;
      }
      case 'tool_start': {
        const asked = p.tool === ASK_TOOL;
        const label = oneLine(p.label) || p.tool;
        const turn: Turn = { kind: 'tool', text: asked ? `asked the user · ${label}` : label };
        turns.push(turn);
        calls.set(p.toolUseId, { turn, asked });
        break;
      }
      case 'tool_end': {
        const call = calls.get(p.toolUseId);
        if (!call) break;
        if (!p.ok) call.turn.text += ' (failed)';
        else if (call.asked && oneLine(p.summary)) call.turn.text += ` → ${oneLine(p.summary)}`;
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

const LABELS: Record<Turn['kind'], string> = { user: 'User: ', agent: 'Agent: ', tool: 'Tool: ' };

const blockOf = (t: Turn): string => `${LABELS[t.kind]}${t.text}`;

/** Tool lines sit together; everything else is set apart by a blank line. */
function renderTurns(turns: readonly Turn[]): string {
  let out = '';
  turns.forEach((t, i) => {
    const prev = turns[i - 1];
    out += (prev ? (prev.kind === 'tool' && t.kind === 'tool' ? '\n' : '\n\n') : '') + blockOf(t);
  });
  return out;
}

/** What a turn takes up in the text: its block and the separator before it. */
const costOf = (t: Turn): number => blockOf(t).length + 2;

/**
 * The turns that fit in `allowance` characters: the newest, back as far as they go, so the
 * oldest go first. The last reply is never cut and never dropped, whatever the allowance.
 */
export function fitTurns(turns: readonly Turn[], allowance: number): { kept: readonly Turn[]; dropped: number } {
  let start = turns.length;
  let used = 0;
  while (start > 0 && used + costOf(turns[start - 1]!) <= allowance) {
    used += costOf(turns[start - 1]!);
    start--;
  }
  const lastReply = turns.findLastIndex((t) => t.kind === 'agent');
  if (lastReply >= 0) start = Math.min(start, lastReply);
  return { kept: turns.slice(start), dropped: start };
}

/**
 * `total` characters shared by agents that each need some: an equal share each, and what one
 * does not need goes to the rest. Three agents needing 10, 500 and 900 of 600 get 10, 295 and 295.
 */
export function shareCap(total: number, needs: readonly number[]): number[] {
  const shares = needs.map(() => 0);
  let left = Math.max(0, total);
  [...needs.keys()]
    .sort((a, b) => needs[a]! - needs[b]!)
    .forEach((i, k) => {
      shares[i] = Math.min(needs[i]!, Math.floor(left / (needs.length - k)));
      left -= shares[i]!;
    });
  return shares;
}

export interface Upstream {
  role: string;
  /** Its last prose, or null when it finished without writing any. */
  reply: string | null;
  /**
   * How it ended, when not `done`: an agent it was started without because it was stopped
   * (Amendment 88), or a helper that failed (Amendment 51).
   */
  status?: string;
  /** Its whole conversation, oldest first (Amendment 101). Absent or empty: `reply` is all there is. */
  turns?: readonly Turn[];
  /**
   * What the agent said about its own work when it handed off, printed before its text,
   * whole and outside the cap. The seam for the `hand_off` tool, which nothing sets yet.
   */
  summary?: string;
}

/** What `handoffSection` has of one upstream: its turns, or its last reply as the one turn. */
function turnsOf(u: Upstream): readonly Turn[] {
  if (u.turns && u.turns.length > 0) return u.turns;
  const reply = u.reply?.trim();
  return reply ? [{ kind: 'agent', text: reply }] : [];
}

/** What to say of an agent that wrote nothing, as its status says why. */
function noReply(u: Upstream): string {
  return u.status === 'stopped' ? '(It was stopped before it wrote a reply.)' : '(It finished without a written reply.)';
}

/** `[role]`, or `[role — stopped, so it may not have finished its part]`, as a helper's report says it. */
function head(u: Upstream): string {
  return !u.status || u.status === 'done' ? `[${u.role}]` : `[${u.role} — ${u.status}, so it may not have finished its part]`;
}

/** One upstream under its heading: its summary, what was left out, its conversation, and a note if it wrote no reply. */
function upstreamBody(u: Upstream, allowance: number): string {
  const all = turnsOf(u);
  const { kept, dropped } = fitTurns(all, allowance);
  const parts: string[] = [];
  if (u.summary?.trim()) parts.push(`Its summary of its work:\n${u.summary.trim()}`);
  if (dropped > 0) parts.push(`… (the first ${dropped.toLocaleString('en')} of ${all.length.toLocaleString('en')} entries are left out to fit)`);
  if (kept.length > 0) parts.push(renderTurns(kept));
  if (!all.some((t) => t.kind === 'agent')) parts.push(noReply(u));
  return parts.join('\n\n');
}

/**
 * The section to put in a first prompt, or '' when the agent waited for nobody. An agent
 * resumed without one that was stopped (Amendment 88) hears that one too, marked stopped.
 * `cap` is for all the conversations together, in characters (`handoffCap`); the agents
 * share it, and an agent that needs less than its share gives the rest to the others.
 */
/**
 * `opening` replaces the first sentence ("You started after the agent before you
 * finished."), for a caller whose reader did not just start: a re-run (Amendment 102).
 */
export function handoffSection(upstream: readonly Upstream[], cap: number, opening?: string): string {
  if (upstream.length === 0) return '';
  const who = upstream.length === 1 ? 'the agent' : 'the agents';
  const all = upstream.every((u) => !u.status || u.status === 'done');
  const allowance = shareCap(
    cap,
    upstream.map((u) => turnsOf(u).reduce((n, t) => n + costOf(t), 0)),
  );
  return [
    (opening ??
      (all
        ? `You started after ${who} before you finished.`
        : `You were started without waiting for every agent before you to finish.`)) +
      ` They worked in this same folder, so what they changed is already here. What each was told and said, in ` +
      `order, with a line for each tool it called (what the tools returned is left out):`,
    ...upstream.map((u, i) => `\n${head(u)}\n${upstreamBody(u, allowance[i]!)}`),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking from inside a stack (Amendment 100)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this agent in a stack: does it wait for another, or does another wait for it?
 * `wentWithout` is how many it was started without (Amendment 88), which still counts as
 * having waited. Pure, so session/verify.ts checks both sides directly.
 */
export function inStack(
  agentId: string,
  jobAgents: readonly { id: string; dependsOn: readonly string[] }[],
  wentWithout = 0,
): boolean {
  const me = jobAgents.find((a) => a.id === agentId);
  return (me?.dependsOn.length ?? 0) > 0 || wentWithout > 0 || jobAgents.some((a) => a.dependsOn.includes(agentId));
}

/**
 * The one line an agent in a stack is told about asking. A question left in its reply ends
 * its turn, and everything waiting on it starts without an answer; the question tool holds
 * it in Needs You and starts nothing after it until you reply. Claude's tool is called
 * AskUserQuestion and Copilot's (and so OpenRouter's) is ask_user, so both are named.
 * It does not replace ending a turn with "I'll wait": that still works as it did.
 */
export const STACK_ASK_LINE =
  'You are one agent in a stack, and some agents wait for others to finish. When you need an answer from ' +
  'the user, ask with the question tool (AskUserQuestion, or ask_user), not in your reply: a question in your ' +
  'reply ends your turn and the agents after you start without the answer, while the question tool holds you, ' +
  'and them, until the user has answered.';

/** The line for a first prompt, or '' for an agent that is on its own. */
export function stackLine(stacked: boolean): string {
  return stacked ? STACK_ASK_LINE : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrators and helpers (Amendment 51)
// ─────────────────────────────────────────────────────────────────────────────

/** What an orchestrator is told about the job it runs, on top of the prompt and brief. */
export function orchestratorSection(role: string, cap: number): string {
  return [
    `You orchestrate this ${role} work. You may start up to ${cap} helper agent${cap === 1 ? '' : 's'} with the ` +
      '`start_helper` tool, each with its own part of the task. They work in this same folder, at the same time, ' +
      'with the same model and permissions you have.',
    'Split the work into parts that can run in parallel without touching the same files, start a helper for each, ' +
      "and then end your turn. When they have all finished you'll be told what each one reported; then check their " +
      'work, combine it, and start more if something is left. `list_helpers` shows where they are. Do the parts ' +
      'that do not split yourself.',
  ].join('\n');
}

/** A helper's brief: its part, and what to hand back. */
export function helperBrief(orchestrator: string, task: string): string {
  return (
    `You are one of the ${orchestrator}'s helpers. Do only this part of the task: ${task.trim()}\n` +
    `Other helpers are working in this folder at the same time, so stay inside your part. When you are done, ` +
    `reply with what you changed and anything the ${orchestrator} must know.`
  );
}

/** A helper's report is cut at this many characters; the rest is in its transcript. */
const HELPER_REPLY_CAP = 8_000;

function helperBody(u: Upstream): string {
  const reply = u.reply?.trim();
  if (!reply && u.status === 'stopped') return '(It was stopped before it wrote a reply.)';
  if (!reply) return '(It finished without a written reply.)';
  if (reply.length <= HELPER_REPLY_CAP) return reply;
  return (
    `${reply.slice(0, HELPER_REPLY_CAP)}\n` +
    `… (cut at ${HELPER_REPLY_CAP.toLocaleString('en')} of ${reply.length.toLocaleString('en')} characters)`
  );
}

/** What an orchestrator is told when its helpers have finished: each one's last reply, as before Amendment 101. */
export function helperReport(helpers: readonly (Upstream & { status: string })[]): string {
  return [
    `Your helper${helpers.length === 1 ? ' has' : 's have'} finished. What each said last:`,
    ...helpers.map((h) => `\n${head(h)}\n${helperBody(h)}`),
    '\nCheck their work, combine it, and carry on. Start more helpers if something is left.',
  ].join('\n');
}
