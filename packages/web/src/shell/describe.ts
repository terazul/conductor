/**
 * Turning the event log into English.  TRACK B.
 *
 * The Fleet card rows and the Project lane tails both have to answer one
 * question — *what is this agent literally doing right now* — from nothing but
 * the event stream. That derivation lives here once so the two screens can
 * never drift apart, and so neither of them has to guess.
 *
 * Everything is defensive. `ToolStartPayload.input` is typed `unknown` on
 * purpose (its shape varies per tool, and a future tool will have a shape we
 * have never seen); a card must degrade to a plainer sentence, never throw.
 */

import type {
  Agent,
  Alert,
  Event,
  FileEditPayload,
  Job,
  PendingRequest,
  TodoPayload,
} from '@conductor/shared';

// ── picking the record a screen should show ──────────────────────────────────

/**
 * How many things in this project need you: requests waiting on an answer, and alerts
 * nobody has dismissed. The projects list marks a row by this rather than by the agents'
 * status rollup, which reads status fields that may not have been moved yet — a row
 * must be amber whenever the queue holds something for its project. (It was the rail's
 * rule; the rail is gone, Amendment 43.)
 */
export function projectNeeds(
  projectId: string,
  pending: Pick<PendingRequest, 'projectId'>[],
  alerts: Pick<Alert, 'projectId'>[],
): number {
  return (
    pending.filter((q) => q.projectId === projectId).length +
    alerts.filter((a) => a.projectId === projectId).length
  );
}

/**
 * The job a project's card and header should describe.
 *
 * A project can hold several jobs; the one worth showing is the live one.
 * Unfinished beats finished, then newest wins.
 */
export function primaryJob(jobs: readonly Job[]): Job | null {
  if (jobs.length === 0) return null;
  const score = (j: Job) => (j.endedAt === null ? 1 : 0);
  return jobs.reduce((best, j) => {
    const d = score(j) - score(best);
    if (d !== 0) return d > 0 ? j : best;
    return Date.parse(j.createdAt) > Date.parse(best.createdAt) ? j : best;
  });
}

/** Resolve `dependsOn` agent ids to readable role names. */
export function dependencyNames(agent: Agent, all: readonly Agent[]): string[] {
  return agent.dependsOn.map((id) => all.find((a) => a.id === id)?.role ?? id);
}

/**
 * The status to PAINT an agent with.
 *
 * Identical to `agent.status` except that a live request forces `blocked`, so a
 * dot, tag or stripe can never be teal while a human is waiting to answer it.
 * One colour, one job — and the colour follows the request, not the projection.
 */
export function shownStatus(
  agent: Agent,
  pending: readonly PendingRequest[],
): Agent['status'] {
  return pending.some((p) => p.agentId === agent.id) ? 'blocked' : agent.status;
}

// ── defensive readers for `unknown` tool input ──────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** First string-valued key that is present, else null. */
export function pickString(input: unknown, ...keys: string[]): string | null {
  const rec = asRecord(input);
  if (!rec) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * A one-line description, split so the interesting half can be emphasised.
 * `head` is the verb or tool ("Edit", "wants to run"); `subject` is the target.
 */
export interface Action {
  head: string;
  subject: string;
  /** Which status colour this line should read as, if any. */
  tone: 'live' | 'need' | 'fail' | 'done' | 'queue' | 'idle';
}

/** `Edit src/auth/token.ts` → head `Edit`, subject `src/auth/token.ts`. */
function splitLabel(label: string): { head: string; subject: string } {
  const i = label.indexOf(' ');
  if (i < 0) return { head: label, subject: '' };
  return { head: label.slice(0, i), subject: label.slice(i + 1) };
}

/** What a human is being asked for. */
export function describeRequest(p: PendingRequest): Action {
  if (p.kind === 'question') {
    const q = p.questions?.[0]?.question;
    return { head: 'asks', subject: q ?? 'a question', tone: 'need' };
  }
  const cmd = pickString(p.input, 'command');
  if (cmd) return { head: 'wants to run', subject: cmd, tone: 'need' };
  const path = pickString(p.input, 'file_path', 'path', 'url');
  return {
    head: 'wants to',
    subject: path ? `${p.toolName} ${path}` : p.toolName,
    tone: 'need',
  };
}

/** The last event of a given kind, or null. */
function lastOf<K extends Event['payload']['kind']>(
  events: readonly Event[],
  kind: K,
): Extract<Event['payload'], { kind: K }> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const p = events[i]?.payload;
    if (p && p.kind === kind) return p as Extract<Event['payload'], { kind: K }>;
  }
  return null;
}

/** Tool ids that have reported an end. Anything else is still in flight. */
function finishedToolIds(events: readonly Event[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.payload.kind === 'tool_end') done.add(e.payload.toolUseId);
  }
  return done;
}

/**
 * What this agent is doing, right now, in one line.
 *
 * Priority: a human is blocking it > it is waiting on something > the tool it
 * is mid-way through > the last thing it said.
 *
 * The pending request is checked BEFORE `agent.status`, deliberately. A request
 * in the queue is the ground truth that a human is needed; the agent's status
 * field is a projection that may not have been transitioned yet (the
 * permission-requests fixture has exactly that shape — a live request against an
 * agent still marked `working`). Trusting the request means the amber never lags
 * behind the thing it is reporting.
 */
export function currentAction(
  agent: Agent,
  events: readonly Event[],
  pending: readonly PendingRequest[],
  dependencyNames: readonly string[] = [],
  now = Date.now(),
): Action {
  const mine = pending.find((p) => p.agentId === agent.id);
  if (mine) return describeRequest(mine);

  if (agent.status === 'blocked') {
    const req = lastOf(events, 'request');
    const { head, subject } = splitLabel(req?.label ?? 'needs a decision');
    return { head, subject, tone: 'need' };
  }

  if (agent.status === 'queued') {
    if (dependencyNames.length > 0) {
      return {
        head: 'waiting on',
        subject: dependencyNames.join(' · '),
        tone: 'queue',
      };
    }
    return { head: 'waiting', subject: 'for a slot', tone: 'queue' };
  }

  if (agent.status === 'failed') {
    // Why, as Needs You says it. No head: every row that shows this line already starts
    // with the role, and the sentence is written to follow it.
    const st = lastOf(events, 'status');
    return { head: '', subject: failureSentence(st?.error, agent), tone: 'fail' };
  }

  if (agent.status === 'paused') {
    const tokens = agent.inputTokens + agent.outputTokens;
    return {
      head: 'paused',
      subject: tokens > 0 ? `context preserved — resumable` : 'resumable',
      tone: 'idle',
    };
  }

  // Still trying to reach the model: say so, instead of a bare "working" (F10).
  const retry = agent.status === 'working' ? retryingNow(events) : null;
  if (retry) return { head: retryHead(retry.payload), subject: retryTail(retry, now), tone: retryTone(retry.payload) };

  // working / done — prefer a tool still in flight, then the newest tool, then prose.
  const finished = finishedToolIds(events);
  let newestStart: { label: string; open: boolean } | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const p = events[i]?.payload;
    if (p?.kind === 'tool_start') {
      newestStart = { label: p.label, open: !finished.has(p.toolUseId) };
      break;
    }
    // Prose after the last tool call means it has moved on to talking.
    if (p?.kind === 'text') break;
  }

  if (newestStart) {
    const { head, subject } = splitLabel(newestStart.label);
    return { head, subject, tone: agent.status === 'done' ? 'done' : 'live' };
  }

  const text = lastOf(events, 'text');
  if (text) {
    return {
      head: '',
      subject: firstLine(text.text),
      tone: agent.status === 'done' ? 'done' : 'live',
    };
  }

  return agent.status === 'done'
    ? { head: 'finished', subject: '', tone: 'done' }
    : { head: 'starting', subject: '', tone: 'live' };
}

export function firstLine(text: string, max = 130): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ── failures and outages, in sentences (F10, F13) ───────────────────────────
//
// The Agent header and the Needs You card say the same thing about the same failure,
// because both come from here.

/** Each follows the agent's role: "Builder filled its context window". */
const FAILURES: Record<string, string> = {
  blocking_limit: 'filled its context window',
  prompt_too_long: 'sent a prompt too long for the model',
  rapid_refill_breaker: 'kept refilling its context, so the SDK stopped it',
  image_error: "sent an image the model couldn't read",
  model_error: 'got an error from the model',
  api_error: "couldn't get an answer from the model API",
  malformed_tool_use_exhausted: "kept making tool calls the SDK couldn't read",
  structured_output_retry_exhausted: "couldn't produce the output it was asked for",
  max_turns: 'ran out of turns',
  stop_hook_prevented: 'was stopped by a hook',
  hook_stopped: 'was stopped by a hook',
  tool_deferred_unavailable: 'was waiting on a tool that is no longer there',
  turn_setup_failed: "couldn't start its turn",
  aborted_streaming: 'was cut off mid-reply',
  iteration_error: 'lost the SDK mid-run',
  launch_failed: "couldn't be launched",
  resume_failed: 'had no session to resume',
  job_budget_reached: "reached its job's budget",
};

/**
 * Why an agent stopped, as the rest of a sentence that starts with its role. A reason
 * with no sentence yet is shown as itself, so it is never hidden behind a guess.
 */
export function failureSentence(
  reason: string | undefined,
  agent?: Pick<Agent, 'autonomy' | 'costUsd'>,
): string {
  if (reason === 'budget_exhausted') {
    const cap = agent?.autonomy.budgetUsd;
    if (!cap) return 'reached its budget';
    // Raised since it stopped: the old figure would be wrong, and continuing is all that's left.
    return agent.costUsd >= cap
      ? `spent its ${usd(cap)} budget`
      : `stopped on its budget, now raised to ${usd(cap)}`;
  }
  if (!reason || reason === 'error') return 'ended with an error — see the transcript';
  return FAILURES[reason] ?? `${reason} — see the transcript`;
}

function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

type Retry = Extract<Event['payload'], { kind: 'api_retry' }>;

/**
 * The retry the agent is still inside: an `api_retry` with nothing from the model after
 * it. Any reply, tool call or change of status ends it.
 */
export function retryingNow(events: readonly Event[]): { payload: Retry; ts: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e) continue;
    const p = e.payload;
    if (p.kind === 'api_retry') return { payload: p, ts: e.ts };
    if (p.kind === 'text' || p.kind === 'tool_start' || p.kind === 'tool_end' || p.kind === 'status') {
      return null;
    }
  }
  return null;
}

/** What is wrong with the model API, by cause. */
export function retryHead(p: Pick<Retry, 'cause' | 'httpStatus'>): string {
  switch (p.cause) {
    case 'unreachable':
      return "can't reach the model API";
    case 'auth':
      return 'the model API refused the login';
    case 'throttled':
      return 'the model API is busy';
    case 'server':
      return p.httpStatus ? `the model API answered ${p.httpStatus}` : 'the model API is failing';
  }
}

/** "retry 3/10 in 12s", counted down from when the retry was announced. */
export function retryTail(r: { payload: Pick<Retry, 'attempt' | 'maxRetries' | 'delayMs'>; ts: string }, now: number): string {
  const { attempt, maxRetries, delayMs } = r.payload;
  const of = maxRetries > 0 ? `${attempt}/${maxRetries}` : String(attempt);
  const left = Math.ceil((Date.parse(r.ts) + delayMs - now) / 1000);
  return Number.isFinite(left) && left > 0 ? `retry ${of} in ${left}s` : `retry ${of} now`;
}

/**
 * Amber only for what a person has to fix, and not for one blip (§5.1). The daemon's
 * alert adds a 20 s rule this line doesn't need: it is redrawn by the next retry.
 */
function retryTone(p: Pick<Retry, 'cause' | 'attempt'>): Action['tone'] {
  return (p.cause === 'unreachable' || p.cause === 'auth') && p.attempt >= 2 ? 'need' : 'live';
}

/** What to check, for an outage's card. */
export function retryHint(cause: string, gaveUp: boolean): string {
  switch (cause) {
    case 'unreachable':
      return 'no answer at all — is the VPN up, or the network?';
    case 'auth':
      return 'check the login, the API key or the account';
    case 'throttled':
      return gaveUp ? 'it stayed busy — try again in a few minutes' : 'it is busy; the SDK is waiting it out';
    default:
      return gaveUp ? 'it kept failing — try again in a few minutes' : 'the SDK is retrying';
  }
}

/** One line for an alert card: what happened, with the role filled in. */
export function alertTitle(alert: Alert, agents: readonly Agent[]): { head: string; subject: string } {
  const who = alert.agentIds.map((id) => agents.find((a) => a.id === id)?.role ?? id);
  const one = agents.find((a) => a.id === alert.agentIds[0]);
  switch (alert.kind) {
    case 'connection': {
      const head = retryHead({ cause: alert.cause as Retry['cause'], httpStatus: null });
      const count = alert.gaveUp
        ? `gave up after ${alert.attempt ?? '?'} attempts`
        : `retry ${alert.attempt ?? '?'}${alert.maxRetries ? `/${alert.maxRetries}` : ''}`;
      return { head, subject: `${count} · ${who.join(' · ')}` };
    }
    case 'server_down':
      return { head: `dev server :${alert.port ?? '?'}`, subject: 'stopped answering' };
    case 'daily_budget':
      return { head: "today's spend", subject: 'reached the daily budget' };
    case 'note_due':
      return { head: 'a note', subject: alert.late ? `is late (due ${alert.due ?? '?'})` : 'is due today' };
    case 'blocked_dep': {
      const by = agents.find((a) => a.id === alert.blockedBy)?.role ?? 'an agent';
      return {
        head: who[0] ?? 'an agent',
        subject: `is waiting on ${by}, which ${alert.cause === 'stopped' ? 'was stopped' : 'failed'}`,
      };
    }
    case 'budget':
    case 'failed':
      return { head: who[0] ?? 'an agent', subject: failureSentence(alert.cause, one) };
  }
}

/** A word or two for where there is no room for the sentence: the top bar. */
export function alertWord(alert: Pick<Alert, 'kind' | 'cause' | 'gaveUp' | 'late'>): string {
  switch (alert.kind) {
    case 'failed':
      return 'failed';
    case 'budget':
      return 'at its budget';
    case 'server_down':
      return 'server down';
    case 'daily_budget':
      return 'over daily budget';
    case 'note_due':
      return alert.late ? 'note late' : 'note due';
    case 'blocked_dep':
      return alert.cause === 'stopped' ? 'waiting on a stopped agent' : 'waiting on a failed agent';
    case 'connection':
      if (alert.gaveUp) return 'model API gave up';
      return alert.cause === 'auth' ? 'model API login' : 'no model API';
  }
}

// ── lane tail ───────────────────────────────────────────────────────────────

export interface TailLine {
  key: string;
  text: string;
  /** `tool` = a call, `result` = its outcome, `text` = prose. */
  kind: 'tool' | 'result' | 'text';
  ok?: boolean;
}

/**
 * The last few lines of an agent's stream — enough to know it is on track
 * without reading everything.
 */
export function tailLines(events: readonly Event[], limit = 4): TailLine[] {
  const out: TailLine[] = [];
  for (const e of events) {
    const p = e.payload;
    if (p.kind === 'tool_start') {
      out.push({ key: `s${e.seq}`, kind: 'tool', text: p.label });
    } else if (p.kind === 'tool_end') {
      if (p.summary) {
        out.push({ key: `s${e.seq}`, kind: 'result', text: p.summary, ok: p.ok });
      }
    } else if (p.kind === 'text') {
      out.push({ key: `s${e.seq}`, kind: 'text', text: firstLine(p.text, 90) });
    }
  }
  return out.slice(-limit);
}

// ── aggregates for the inspector ────────────────────────────────────────────

export interface TouchedFile {
  path: string;
  added: number;
  removed: number;
  created: boolean;
}

/**
 * Which `file_edit` source to believe, per path.  Amendment 8.
 *
 * Two channels report every write and they know different things: Track A's
 * PostToolUse knows the author but estimates the line counts, Track C's watcher
 * has `git diff --numstat` counts but no author. `diffstat()` resolves that per
 * path inside @conductor/shared; anything of ours that walks `file_edit` payloads
 * itself has to resolve it the same way or it double-counts every change — a
 * wrong number nobody questions, because it looks plausible.
 *
 * Authoritative wins where it exists. Absent `source` counts as authoritative,
 * so the fixtures and every pre-amendment event keep their meaning. The `'tool'`
 * estimate is the fallback for paths a watcher will never see: `in_place` jobs,
 * and worktrees past the watcher cap.
 */
export function countingSource(events: readonly Event[]): Map<string, 'watcher' | 'tool'> {
  const winner = new Map<string, 'watcher' | 'tool'>();
  for (const e of events) {
    const p = e.payload;
    if (p.kind !== 'file_edit') continue;
    if (p.source === 'tool') {
      if (!winner.has(p.path)) winner.set(p.path, 'tool');
    } else {
      winner.set(p.path, 'watcher');
    }
  }
  return winner;
}

/** True when this payload is the one that counts for its path. */
export function counts(
  p: FileEditPayload,
  winner: Map<string, 'watcher' | 'tool'>,
): boolean {
  return (p.source === 'tool' ? 'tool' : 'watcher') === winner.get(p.path);
}

export function filesTouched(events: readonly Event[]): TouchedFile[] {
  const winner = countingSource(events);
  const byPath = new Map<string, TouchedFile>();
  for (const e of events) {
    const p = e.payload;
    if (p.kind !== 'file_edit') continue;
    const prev = byPath.get(p.path);
    // A path always appears, even if only the losing source reported a count —
    // "touched" is about the file existing in the diff, not about the number.
    const keep = counts(p, winner);
    byPath.set(p.path, {
      path: p.path,
      added: (prev?.added ?? 0) + (keep ? p.added : 0),
      removed: (prev?.removed ?? 0) + (keep ? p.removed : 0),
      created: (prev?.created ?? false) || p.created === true,
    });
  }
  return [...byPath.values()];
}

export function latestTodo(events: readonly Event[]): TodoPayload | null {
  return lastOf(events, 'todo');
}

/** When the agent actually began, preferring the entity's own timestamp. */
export function startedMs(agent: Agent, events: readonly Event[]): number | null {
  if (agent.startedAt) {
    const t = Date.parse(agent.startedAt);
    if (Number.isFinite(t)) return t;
  }
  const first = events[0];
  if (!first) return null;
  const t = Date.parse(first.ts);
  return Number.isFinite(t) ? t : null;
}

export { lastOf };
