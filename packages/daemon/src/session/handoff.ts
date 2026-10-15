/**
 * What an agent is told about the agents it waited for.  TRACK A.  (Amendments 37, 101, 104)
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
 * On top of that comes what the agent said about its own work when it handed off, with its
 * `hand_off` tool (Amendment 104), or what a person sent for it from Needs You: the summary,
 * printed first, whole, outside the cap. An agent further up than the ones it waited for is
 * passed on by that summary alone, "via" the one it came through, and counted against the cap
 * (`Upstream.via`): a chain's first stage would otherwise reach its last only quoted in the
 * second's launch prompt, which is the first thing the cap drops.
 *
 * It is capped at about a quarter of the next model's context window (`handoffCap`),
 * shared between the agents it waited for. Over the cap the OLDEST goes first and the last
 * reply stays whole. Text the agents already gave each other is dropped before the cap is
 * spent on it (`dropRepeats`, Amendment 120). The job instruction is not part of it: `#promptFor` puts that first,
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
 * is only given less than it could take. This is what stands in when the engine has not
 * reported the real window (session/windows.ts, Amendment 120: OpenRouter's `context_length`,
 * Copilot's `max_context_window_tokens`, the gateway's `max_input_tokens`). First match wins,
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

/**
 * Characters to a token, low on purpose: code and paths run to 3, prose to 4.
 *
 * THIS IS AN ESTIMATE, AND IT IS NOT A COUNT. The cap is in characters because nothing here can
 * count tokens: there is no tokenizer in the repo, and none that runs offline for every engine
 * (each model has its own). The window is the engine's real one where it reported one
 * (Amendment 120); the characters-per-token figure is a guess that errs small.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * `model`'s window in tokens: `reported`, when the engine said what it is (session/windows.ts),
 * else the floor in the table above. Pure; the caller looks the report up.
 */
export function contextWindow(model: string, reported?: number): number {
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 1) return Math.floor(reported);
  const id = model.trim().replace(/^[^/]+\//, '');
  return WINDOWS.find(([re]) => re.test(id))?.[1] ?? DEFAULT_WINDOW_TOKENS;
}

/** In characters, for all the upstream conversations together: a quarter of `model`'s window. */
export function handoffCap(model: string, reported?: number): number {
  return Math.floor(contextWindow(model, reported) * HANDOFF_SHARE * CHARS_PER_TOKEN);
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
 *    with it: every agent in the job has it, and the next agent has it at the top. The lines
 *    about asking (Amendment 100) and handing off (Amendment 104) go too. What follows stays, which is that agent's own
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
          // Neither the job instruction nor the lines about asking (Amendment 100) and handing
          // off (Amendment 104) are repeated: the next agent has the first at the top and is
          // given the others for itself.
          text = text
            .replace(STACK_ASK_LINE, '')
            .replace(AMENDMENT_100_ASK_LINE, '')
            .replace(HAND_OFF_LINE, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
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
   * whole and outside the cap. From its `hand_off` call, or from a person's edit of it in
   * Needs You (Amendment 104).
   */
  summary?: string;
  /**
   * The role of the agent it was reached through, for one further up than those the reader
   * waited for (Amendment 155): only its summary is passed on, headed `[role, via <this>]`, and
   * it is counted against the cap like a conversation.
   */
  via?: string;
}

/** What `handoffSection` has of one upstream: its turns, or its last reply as the one turn. None for one further up. */
function turnsOf(u: Upstream): readonly Turn[] {
  if (u.via) return [];
  if (u.turns && u.turns.length > 0) return u.turns;
  const reply = u.reply?.trim();
  return reply ? [{ kind: 'agent', text: reply }] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Text that would be said twice (Amendment 120)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A run of repeated paragraphs STARTS only at one this long: "(the job instruction, as above)"
 * and "Done." are said twice for good reason, and a paragraph is only worth a marker when it
 * is worth the line. Once a run has started, the shorter paragraphs that were also said above
 * go with it, so a quoted conversation is one gap and not a gap for each of its short replies.
 */
const MIN_REPEAT = 60;

/** Stands where a run of paragraphs was left out because the section says them above. */
export const REPEAT_MARKER = '(repeated from above, left out here)';

/** A paragraph as it is compared: without the `[role]` heading line that opens an agent's part. */
const keyOf = (p: string): string => p.replace(/^\[[^\]\n]*\]\n/, '').trim();

const paragraphs = (text: string): string[] => text.split(/\n{2,}/);

/**
 * What an upstream says in its own voice, as paragraphs the way the section sets them out: its
 * summary (Amendment 104), its replies, and its tool calls (consecutive ones are one
 * paragraph). Not its user turns: those are where another agent's part turns up inside a
 * launch prompt.
 */
function ownVoice(u: Upstream): string[] {
  const turns = turnsOf(u);
  const out: string[] = u.summary?.trim() ? paragraphs(`${SUMMARY_HEAD}${u.summary.trim()}`) : [];
  let tools: string[] = [];
  const flush = (): void => {
    if (tools.length > 0) out.push(tools.join('\n'));
    tools = [];
  };
  for (const t of turns) {
    if (t.kind === 'tool') {
      tools.push(blockOf(t));
      continue;
    }
    flush();
    if (t.kind === 'agent') out.push(...paragraphs(blockOf(t)));
  }
  flush();
  return out;
}

/**
 * The upstreams with the text they repeat taken out, before the cap is spent on it.
 *
 * An agent's launch prompt holds what the agents before it said (Amendment 101: "a chain A, B,
 * C hands C everything B knew, A's part included"). So when one agent waits for several, the
 * same text comes in more than once: a reviewer waiting for three agents that share a parent
 * sees the parent's part in each of their launch prompts, and again as its own part if it waits
 * for the parent too. The cap drops the oldest first, which is the repeated part, but only
 * after it has been counted and a share of the cap has gone on it.
 *
 * Only the user turns are looked at, because that is where a part is quoted. A paragraph of one
 * is left out, and one marker stands where a run of them was, when it was said above:
 *  - by another upstream in its own voice (its replies and tool lines), wherever that upstream
 *    is in the list, or
 *  - in an earlier upstream's user turns (the first copy stays).
 * A run starts at a paragraph of 60 characters or more (`MIN_REPEAT`) and takes the shorter
 * ones said above along with it. An agent's own replies are never touched, and nor is an
 * upstream's text that only it said. A chain where the third agent waits only for the second
 * has nothing to drop: A's part is there once, inside B's.
 */
export function dropRepeats(upstream: readonly Upstream[]): Upstream[] {
  // paragraph → the upstreams that say it in their own voice
  const voice = new Map<string, Set<number>>();
  upstream.forEach((u, i) => {
    for (const p of ownVoice(u)) {
      const owners = voice.get(p) ?? new Set<number>();
      owners.add(i);
      voice.set(p, owners);
    }
  });
  // what earlier upstreams' user turns already show
  const shown = new Set<string>();

  return upstream.map((u, i) => {
    if (!u.turns || u.turns.length === 0) return u;
    const fresh: string[] = [];
    let changed = false;
    const turns = u.turns.map((t): Turn => {
      if (t.kind !== 'user') return t;
      const out: string[] = [];
      let dropping = false;
      paragraphs(t.text).forEach((p, at) => {
        const key = keyOf(p);
        const saidAbove = shown.has(key) || [...(voice.get(key) ?? [])].some((o) => o !== i);
        if (saidAbove && (dropping || key.length >= MIN_REPEAT)) {
          if (!dropping) out.push(REPEAT_MARKER);
          dropping = true;
          changed = true;
          return;
        }
        dropping = false;
        out.push(p);
        fresh.push(key);
        // As the section will set it down: the turn's first paragraph carries the `User: ` label.
        if (at === 0) fresh.push(`${LABELS.user}${p}`);
      });
      return { kind: 'user', text: out.join('\n\n') };
    });
    // Registered once the upstream is done, so none of its own paragraphs repeat another of its own.
    for (const k of fresh) shown.add(k);
    return changed ? { ...u, turns } : u;
  });
}

/** What to say of an agent that wrote nothing, as its status says why. */
function noReply(u: Upstream): string {
  return u.status === 'stopped' ? '(It was stopped before it wrote a reply.)' : '(It finished without a written reply.)';
}

/** `[role]`, `[role, via role]`, or `[role — stopped, so it may not have finished its part]`, as a helper's report says it. */
function head(u: Upstream): string {
  if (u.via) return `[${u.role}, via ${u.via}]`;
  return !u.status || u.status === 'done' ? `[${u.role}]` : `[${u.role} — ${u.status}, so it may not have finished its part]`;
}

/** What an upstream's summary (Amendment 104) is printed under. */
const SUMMARY_HEAD = 'Its summary of its work:\n';

/** What one further up needs of the cap: its summary as the section sets it down. */
const viaCost = (u: Upstream): number => (u.summary?.trim() ? SUMMARY_HEAD.length + u.summary.trim().length + 2 : 0);

/** The summary of one further up, in `allowance` characters: its beginning, and how much of it is left out. */
function viaBody(u: Upstream, allowance: number): string {
  const summary = u.summary?.trim() ?? '';
  if (viaCost(u) <= allowance) return `${SUMMARY_HEAD}${summary}`;
  const kept = summary.slice(0, Math.max(0, allowance - SUMMARY_HEAD.length - 2));
  const left = (summary.length - kept.length).toLocaleString('en');
  return kept
    ? `${SUMMARY_HEAD}${kept}\n… (the last ${left} characters of its summary are left out to fit)`
    : `(Its summary, ${left} characters, is left out to fit.)`;
}

/** One upstream under its heading: its summary, what was left out, its conversation, and a note if it wrote no reply. */
function upstreamBody(u: Upstream, allowance: number): string {
  if (u.via) return viaBody(u, allowance);
  const all = turnsOf(u);
  const { kept, dropped } = fitTurns(all, allowance);
  const parts: string[] = [];
  if (u.summary?.trim()) parts.push(`${SUMMARY_HEAD}${u.summary.trim()}`);
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
  const who = upstream.filter((u) => !u.via).length === 1 ? 'the agent' : 'the agents';
  const all = upstream.every((u) => !u.status || u.status === 'done');
  // What one upstream quotes of another is said once, before any of it is counted against the cap (Amendment 120).
  const parts = dropRepeats(upstream);
  const allowance = shareCap(
    cap,
    parts.map((u) => (u.via ? viaCost(u) : turnsOf(u).reduce((n, t) => n + costOf(t), 0))),
  );
  // Ones further up are there by their summary alone.
  const via = upstream.filter((u) => u.via).length;
  const further =
    via === 0
      ? ''
      : via === 1
        ? ' The agent further up, marked "via" the agent that waited for it, is given only by its summary.'
        : ' The agents further up, marked "via" the agent that waited for them, are given only by their summaries.';
  return [
    (opening ??
      (all
        ? `You started after ${who} before you finished.`
        : `You were started without waiting for every agent before you to finish.`)) +
      ` They worked in this same folder, so what they changed is already here. What each was told and said, in ` +
      `order, with a line for each tool it called (what the tools returned is left out):` +
      further,
    ...parts.map((u, i) => `\n${head(u)}\n${upstreamBody(u, allowance[i]!)}`),
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
 * The one line an agent in a stack is told about asking. A question left in its reply is only
 * the end of its turn: nobody is asked. Since `hand_off` (Amendment 104) an agent that others
 * wait for is HELD when its turn ends without handing off, not finished, so they do not start
 * "without the answer" as this line said under Amendment 100: it waits in Needs You as "not
 * handed off", with a question nobody was asked in its last reply. The question tool puts the
 * question in Needs You and holds it, and what waits for it, until the user has answered.
 * Claude's tool is called AskUserQuestion and Copilot's (and so OpenRouter's) is ask_user, so
 * both are named. The line is also read by an agent that nobody waits for (the last in the
 * chain), for whom the end of a turn is simply the end, so it says only what is true of both.
 */
export const STACK_ASK_LINE =
  'You are one agent in a stack, and some agents wait for others to finish. When you need an answer from ' +
  'the user, ask with the question tool (AskUserQuestion, or ask_user), not in your reply. A question in your ' +
  'reply is only the end of your turn: it is not put to anyone, and if agents wait for you, you are held as ' +
  'not handed off. The question tool puts it in Needs You and holds you, and the agents after you, until the ' +
  'user has answered.';

/**
 * The line as Amendment 100 worded it, which agents launched before Amendment 120 had in their
 * first prompt. Never sent again; only taken out of such a prompt when the next agent is given
 * that agent's conversation, so the old wording is not passed on as if it were its brief.
 */
const AMENDMENT_100_ASK_LINE =
  'You are one agent in a stack, and some agents wait for others to finish. When you need an answer from ' +
  'the user, ask with the question tool (AskUserQuestion, or ask_user), not in your reply: a question in your ' +
  'reply ends your turn and the agents after you start without the answer, while the question tool holds you, ' +
  'and them, until the user has answered.';

/** The line for a first prompt, or '' for an agent that is on its own. */
export function stackLine(stacked: boolean): string {
  return stacked ? STACK_ASK_LINE : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Handing off (Amendment 104)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The line an agent that others wait for is told about handing off. Without the call the
 * agents after it do not start, and it waits in Needs You for a person to hand off for it,
 * so it is told that too: an agent that knows what happens if it forgets does not forget.
 * It does not replace ending a turn: the call is made, then the turn ends as usual.
 */
export const HAND_OFF_LINE =
  'Other agents wait for you to finish. When you have, call the hand_off tool with a summary for them: what you ' +
  'did, what you decided and why, what is left, and the files they should look at. They start only once you ' +
  'have, and they are told your summary first. If your turn ends without it they do not start, and you wait in ' +
  'Needs You for the user to hand off for you.';

/** The line for a prompt, or '' for an agent nobody waits for. */
export function handOffLine(waited: boolean): string {
  return waited ? HAND_OFF_LINE : '';
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

/**
 * What an orchestrator is told when its helpers have finished (Amendment 51): each one's whole
 * conversation as text, as the next agent in a stack is given it (Amendment 120). It was each
 * helper's last reply cut at 8,000 characters. Now a helper's launch prompt (its task), its
 * replies and one line for each tool it called are shared out between the helpers within `cap`
 * (`handoffCap` of the orchestrator's model), the oldest going first and the last reply never
 * cut. A helper that failed or was stopped is marked, as in Amendment 51.
 */
export function helperReport(
  helpers: readonly (Upstream & { status: string })[],
  cap: number,
  /** Replaces the last line, for an orchestrated stack's (`PIPELINE_REPORT_CLOSING`, Amendment 128). */
  closing?: string,
): string {
  const shown = dropRepeats(helpers) as (Upstream & { status: string })[];
  const allowance = shareCap(
    cap,
    shown.map((h) => turnsOf(h).reduce((n, t) => n + costOf(t), 0)),
  );
  return [
    `Your helper${helpers.length === 1 ? ' has' : 's have'} finished. What each was told and said, in order, with a line ` +
      'for each tool it called (what the tools returned is left out):',
    ...shown.map((h, i) => `\n${head(h)}\n${upstreamBody(h, allowance[i]!)}`),
    closing ?? '\nCheck their work, combine it, and carry on. Start more helpers if something is left.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrated stacks (Amendment 128)
// ─────────────────────────────────────────────────────────────────────────────

/** A role the orchestrator may start, as its prompt names it. */
export interface ListedRole {
  id: string;
  tier?: string;
  /** A reading role: the helper cannot change files. */
  reads?: boolean;
}

/**
 * What an orchestrator of an orchestrated stack is told, in place of `orchestratorSection`
 * (Amendment 128). That one is written for parallel work: split it into parts that do not touch
 * the same files. A pipeline is the opposite: the steps run in order, the orchestrator reads each
 * result before it writes the next brief, asks the user when it is unsure, and sends work back
 * when a step fails. It says which roles it may start and how often it may send a lane back: a
 * role and a name, so new work is a new name and a send-back reuses one (Amendment 151).
 */
export function pipelineSection(role: string, cap: number, roles: readonly ListedRole[], sendBacks = 2): string {
  const named = roles
    .map((r) => `${r.id}${r.tier || r.reads ? ` (${[r.tier ? `on ${r.tier}` : '', r.reads ? 'reads only' : ''].filter(Boolean).join(', ')})` : ''}`)
    .join(', ');
  return [
    `You orchestrate this ${role} pipeline. You do not do its steps yourself: you start one agent for each, with the ` +
      '`start_helper` tool, one at a time and in order. Each works in this same folder, with the instructions, tools and ' +
      `model of its role. You may start these roles and no others: ${named}. Say which with \`role\`; ` +
      'a `tier` asks for a cheaper model than the one listed, and is worth it only for an easy step.',
    '1. Plan the steps from the job instruction, then start the first. A helper is told the job instruction and the ' +
      '`task` you give it, and sees the folder. It does not see this conversation or what the other helpers did, so ' +
      'write the `task` in full: what to do, which files, what done looks like, and what the earlier steps found, ' +
      'quoted where it needs the words.',
    '2. End your turn after you start a helper. You are woken with its whole conversation: what it was told, what it ' +
      'said, and a line for each tool it called. Read it before you decide anything. A step that stopped is not a step ' +
      'that is ready: start the next when the result does what was asked and its checks passed.',
    `3. Give each new piece of work its own \`name\` (a lane, like "api" or "parser"). When a step fails (a review that ` +
      'finds a fault, a test that does not pass), send the work back: start the role that must fix it again, with the ' +
      `same \`name\` and a new \`task\` that quotes what failed. You may send a lane's work back at most ${sendBacks} ` +
      `times (one role with one name is started at most ${1 + sendBacks} times in all; a start after that is refused). ` +
      'When the same step keeps failing, ask the user before you get that far.',
    '4. When you are unsure (a choice that is the user\'s, a result you cannot judge, a step that keeps failing), ask the ' +
      'user with the question tool (AskUserQuestion, or ask_user), not in your reply: a question in your reply only ends ' +
      'your turn and nobody is asked.',
    `5. Your helpers have no hand_off tool: your judgement of each result replaces it. You may start up to ${cap} ` +
      'helpers in all; `list_helpers` shows where they are. When the last step is ready, finish with a short summary ' +
      'for the user: what each role did, what was decided, and what is left.',
  ].join('\n');
}

/**
 * A helper's brief in an orchestrated stack: its role's own (the persona's), then the brief the
 * orchestrator wrote for this step, and what to reply with. It is not told other helpers are at
 * work beside it, as `helperBrief` says: the steps run one after another.
 */
export function pipelineHelperBrief(orchestrator: string, role: string, roleBrief: string | undefined, task: string): string {
  return (
    `You are the ${role} in a pipeline the ${orchestrator} runs, one step at a time. ` +
    (roleBrief?.trim() ? `${roleBrief.trim()}\n\n` : '') +
    `The ${orchestrator} wrote this brief for your step:\n\n${task.trim()}\n\n` +
    'Do this step only: the steps before it are done, and the ones after wait for you. When you are done, reply with ' +
    'what you did, what you decided and why, what is left, and the files to look at. The ' +
    `${orchestrator} reads your whole conversation, then decides whether the step is ready and what comes next.`
  );
}

/** The last line of what an orchestrator of an orchestrated stack is woken with. */
export function pipelineReportClosing(sendBacks = 2): string {
  return (
    '\nRead what each did before you decide anything. If the step is ready, write the next brief in full and start the ' +
    'next role, with a new `name` for new work. If it is not (a review that found a fault, a test that fails), send the ' +
    'work back: start the role that must fix it, with the same `name` and a new brief that says what failed. A lane\'s ' +
    `work may be sent back at most ${sendBacks} times; after ` +
    'that, ask the user with the question tool (AskUserQuestion, or ask_user). When the last step is ready, finish with ' +
    'a short summary for the user.'
  );
}
