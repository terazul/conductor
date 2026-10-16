/**
 * Trying again when the model can't be reached.  TRACK A.  Amendment 123.
 *
 * The SDK retries a model call by itself first, and Conductor only reported that
 * (`api_retry`, Amendment 28). When the SDK gave up, the run ended with an error and the agent
 * was `failed` at once, and a failed agent fails its job. Now an agent whose run ended because
 * waiting can help (no network, throttled or overloaded, a server error) waits 5 s, 15 s,
 * 30 s, 60 s and 5 min (by default; `conductor.retryDelays` sets them, Amendment 140),
 * resuming its own session after each, and is `failed` only when the last try fails too.
 *
 * Everything that decides is in this file and takes no I/O, so session/verify.ts drives it
 * with a fake clock:
 *
 *   `classifyRetry`  why the model couldn't be reached (moved here from alerts.ts, which
 *                    re-exports it; alerts.ts needs the book below, so it could not stay)
 *   `decideRetry`    whether a run that just ended is tried again, and after how long
 *   `RetryBook`      the tries used and the waits in flight, on a clock it is given
 *
 * What it does NOT do: touch the database, the event log or any agent. The supervisor's
 * `#settle` asks it and acts on the answer; Alerts reads the waits to raise the card.
 */

import { RETRY_CARD_FROM, RETRY_DELAYS_DEFAULT_S, RETRY_DELAYS_KEY, parseRetryDelays, retryDelaysProblem, type RetryCause } from '@conductor/shared';
import { readSettings, settingRule } from '../settings.js';

/** How long to wait before each try with no setting: 5 s, 15 s, 30 s, 60 s, 5 min. Five tries, then the agent is `failed`. */
export const RETRY_DELAYS_MS: readonly number[] = RETRY_DELAYS_DEFAULT_S.map((s) => s * 1000);
/** How many tries with no setting. The setting's own count is `retryDelaysMs().length`. */
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * The schedule in force (Amendment 140): `conductor.retryDelays`, one to five delays in
 * seconds, else the default above. Read when each wait is decided, so a change applies to the
 * next failure; a wait already started keeps its time. The one place the settings file is
 * read in this file, and a cached read (settings.ts:46), so `decideRetry` stays a rule.
 */
export function retryDelaysMs(): readonly number[] {
  const s = parseRetryDelays(readSettings()[RETRY_DELAYS_KEY]);
  return s ? s.map((n) => n * 1000) : RETRY_DELAYS_MS;
}

settingRule(RETRY_DELAYS_KEY, retryDelaysProblem);

/**
 * The card in Needs You is there from the first retry (Amendment 140, Q3 of wave 10). It was
 * from the second (Amendment 123), the first being a 5 s blip; but with the delays a setting
 * the first can be long, and an agent that has stopped working is worth a look at once.
 */
export const RETRY_ALERT_FROM = RETRY_CARD_FROM;

// ── why it failed ───────────────────────────────────────────────────────────

/** SDK errors only someone with the login or the account can fix. */
const ACCOUNT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'cloud_credential_error',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
]);

/** Why the SDK is retrying, from its `api_retry` message. */
export function classifyRetry(httpStatus: number | null, error: string): RetryCause {
  if (ACCOUNT_ERRORS.has(error) || httpStatus === 401 || httpStatus === 403) return 'auth';
  if (error === 'rate_limit' || error === 'overloaded' || httpStatus === 429 || httpStatus === 529) {
    return 'throttled';
  }
  // No HTTP response at all: DNS, the VPN, or no network.
  if (httpStatus === null) return 'unreachable';
  return 'server';
}

/**
 * What the model API said when it stopped an engine's run, in the SDK's terms: the HTTP
 * status (null when there was no response at all) and its error tag. A backend sets it on
 * its outcome when the failure was the API's, and clears it when the model next replies.
 */
export interface ApiFailure {
  httpStatus: number | null;
  error: string;
}

/** Errors the model will answer the same way every time. */
const NEVER_BETTER: ReadonlySet<string> = new Set(['invalid_request', 'model_not_found', 'max_output_tokens']);

/**
 * The cause of a failure that is worth waiting out, or null when it is not the API's
 * trouble or waiting can't mend it. An `auth` failure is returned as `auth`: the caller
 * says why it is not retried.
 */
export function failureCause(f: ApiFailure | null | undefined): RetryCause | null {
  if (!f || NEVER_BETTER.has(f.error)) return null;
  // The assistant's own error tag says "server" without a status.
  if (f.error === 'server_error' && f.httpStatus === null) return 'server';
  const cause = classifyRetry(f.httpStatus, f.error);
  // A 4xx that is neither a throttle nor a login (a bad request, a missing model) fails the same again.
  if (cause === 'server' && f.httpStatus !== null && f.httpStatus < 500 && f.httpStatus !== 408) return null;
  return cause;
}

// ── whether to try again ────────────────────────────────────────────────────

/** Ended because something cut it short, not because the model failed. */
const CUT_SHORT_BY_US: ReadonlySet<string> = new Set(['aborted_streaming', 'aborted_tools']);

/**
 * Ended on a limit of the agent's own or a problem retrying can't touch: more waiting would
 * fail the same way, or (a launch that threw) isn't the model's doing.
 */
const NOT_THE_MODEL: ReadonlySet<string> = new Set([
  'blocking_limit',
  'prompt_too_long',
  'image_error',
  'max_turns',
  'malformed_tool_use_exhausted',
  'structured_output_retry_exhausted',
  'stop_hook_prevented',
  'hook_stopped',
  'rapid_refill_breaker',
  'tool_deferred_unavailable',
  'folder_gone',
  'launch_failed',
  'resume_failed',
]);

export type NoRetry =
  /** It did not end in error. */
  | 'not_an_error'
  /** You stopped or paused it. */
  | 'stopped'
  /** The run was interrupted, not failed. */
  | 'interrupted'
  /** The agent's own limit or a failure that is not the model's. */
  | 'not_the_model'
  /** It failed, but not as the API's trouble, or in a way waiting can't mend. */
  | 'not_api'
  /** The login or the account: a person has to fix it. */
  | 'needs_a_person'
  /** Five tries have failed. */
  | 'out_of_tries';

export type RetryVerdict =
  | { retry: true; cause: RetryCause; attempt: number; of: number; delayMs: number }
  | { retry: false; why: NoRetry };

/** What a run that just ended tells the decision. */
export interface EndedRun {
  isError: boolean;
  terminalReason: string | null;
  /** What the API said last, with no reply from the model since. */
  failure: ApiFailure | null | undefined;
  /** You paused it or stopped the daemon, or are stopping it. */
  userStopped: boolean;
  /** Tries already made since the model last answered this agent. */
  used: number;
  /** The delays to use; the setting's (`retryDelaysMs`) when not given. */
  delays?: readonly number[];
}

/**
 * Whether a run that just ended is tried again, and after how long. Pure.
 *
 * Retried: the API was unreachable, throttled or failing. Not retried: a login or billing
 * problem (needs a person), your own stop or pause, an interruption, one of
 * the agent's own limits, and anything that was not the API's doing. The sixth failure in a
 * row is not retried either: that is the agent `failed`, as it always was.
 */
export function decideRetry(r: EndedRun): RetryVerdict {
  const no = (why: NoRetry): RetryVerdict => ({ retry: false, why });
  if (r.userStopped) return no('stopped');
  if (!r.isError) return no('not_an_error');
  if (r.terminalReason !== null && CUT_SHORT_BY_US.has(r.terminalReason)) return no('interrupted');
  if (r.terminalReason !== null && NOT_THE_MODEL.has(r.terminalReason)) return no('not_the_model');
  const cause = failureCause(r.failure);
  if (cause === null) return no('not_api');
  if (cause === 'auth') return no('needs_a_person');
  const delays = r.delays ?? retryDelaysMs();
  if (r.used >= delays.length) return no('out_of_tries');
  return { retry: true, cause, attempt: r.used + 1, of: delays.length, delayMs: delays[r.used]! };
}

// ── words ───────────────────────────────────────────────────────────────────

/** "5 s", "60 s", "5 min": the delays as they are said. */
export function fmtDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s <= 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${min} min` : `${min} min ${rest} s`;
}

const WHY: Record<RetryCause, string> = {
  unreachable: "can't reach the model",
  auth: 'the model refused the login',
  throttled: 'the model is busy',
  server: 'the model is failing',
};

/** The transcript's line when an agent starts waiting. */
export function retryNote(cause: RetryCause, attempt: number, of: number, delayMs: number): string {
  return `${WHY[cause]} — trying again in ${fmtDelay(delayMs)} (${attempt} of ${of})`;
}

// ── the book ────────────────────────────────────────────────────────────────

/** The only clock the book reads, so a check can stand a fake one in. */
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The real one. Its timers are unref'd, so a waiting agent never keeps the daemon alive. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** One agent waiting for its next try. */
export interface RetryWait {
  agentId: string;
  projectId: string;
  jobId: string;
  cause: RetryCause;
  /** This retry, of `of`. */
  attempt: number;
  of: number;
  delayMs: number;
  /** When it started waiting, and when the try is. Epoch milliseconds, on the book's clock. */
  waitedAt: number;
  at: number;
  /** When this trouble began: the first wait since the model last answered the agent. */
  since: number;
  /** How the run that failed ended, for `stop retrying` to fail the agent as it would have been. */
  terminalReason: string | null;
  errorDetail: string | null;
}

export interface StartWait {
  agentId: string;
  projectId: string;
  jobId: string;
  terminalReason: string | null;
  errorDetail: string | null;
}

/**
 * The tries each agent has used and the waits in flight. In memory on purpose: a restart
 * resumes the agent as it does for any that was working, and the count starts again.
 *
 * `wait` takes a verdict from `decideRetry` that said retry, so the schedule has one home.
 * A try is used when the wait starts, not when it ends, so `retry now` and the timer cost the
 * same. A real reply from the model clears the count (`answered`).
 */
export class RetryBook {
  #clock: Clock;
  #due: (agentId: string) => void;
  #notify: () => void;
  #used = new Map<string, { n: number; since: number }>();
  #waits = new Map<string, { wait: RetryWait; timer: unknown }>();

  constructor(clock: Clock, due: (agentId: string) => void, notify: () => void) {
    this.#clock = clock;
    this.#due = due;
    this.#notify = notify;
  }

  /** Tries used since the model last answered this agent. */
  used(agentId: string): number {
    return this.#used.get(agentId)?.n ?? 0;
  }

  /** Start waiting for the next try, as the verdict says. */
  wait(v: Extract<RetryVerdict, { retry: true }>, who: StartWait): RetryWait {
    this.#drop(who.agentId);
    const now = this.#clock.now();
    const prior = this.#used.get(who.agentId);
    this.#used.set(who.agentId, { n: v.attempt, since: prior?.since ?? now });
    const wait: RetryWait = {
      ...who,
      cause: v.cause,
      attempt: v.attempt,
      of: v.of,
      delayMs: v.delayMs,
      waitedAt: now,
      at: now + v.delayMs,
      since: prior?.since ?? now,
    };
    const timer = this.#clock.setTimer(() => this.#fire(who.agentId), v.delayMs);
    this.#waits.set(who.agentId, { wait, timer });
    this.#notify();
    return wait;
  }

  waiting(agentId: string): RetryWait | undefined {
    return this.#waits.get(agentId)?.wait;
  }

  list(): RetryWait[] {
    return [...this.#waits.values()].map((e) => e.wait);
  }

  /** The wait is over now (`retry now`). False when it was not waiting. */
  now(agentId: string): boolean {
    if (!this.#waits.has(agentId)) return false;
    this.#fire(agentId);
    return true;
  }

  /**
   * Take the wait away without trying: someone else is starting the agent, or it is being
   * stopped. The tries used stay. Returns what it was waiting for.
   */
  cancel(agentId: string): RetryWait | undefined {
    const wait = this.#drop(agentId);
    if (wait) this.#notify();
    return wait;
  }

  /** The model replied: whatever it was retrying through is over, and the count starts again. */
  answered(agentId: string): void {
    this.#used.delete(agentId);
  }

  /** The agent's part in this is over: the wait and the count both go. */
  forget(agentId: string): void {
    const wait = this.#drop(agentId);
    this.#used.delete(agentId);
    if (wait) this.#notify();
  }

  /** Every timer off, for the daemon stopping. The counts stay: nothing reads them after. */
  clear(): void {
    let any = false;
    for (const id of [...this.#waits.keys()]) any = this.#drop(id) !== undefined || any;
    if (any) this.#notify();
  }

  #drop(agentId: string): RetryWait | undefined {
    const e = this.#waits.get(agentId);
    if (!e) return undefined;
    this.#clock.clearTimer(e.timer);
    this.#waits.delete(agentId);
    return e.wait;
  }

  #fire(agentId: string): void {
    if (this.#drop(agentId) === undefined) return;
    this.#notify();
    this.#due(agentId);
  }
}

// ── the daemon's book ───────────────────────────────────────────────────────

let dueHandler: ((agentId: string) => void) | null = null;
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const fn of [...listeners]) fn();
};

let book = new RetryBook(realClock, (id) => dueHandler?.(id), changed);

/** The one book the daemon uses. The supervisor acts on it; Alerts and the runner read it. */
export function retryBook(): RetryBook {
  return book;
}

/** Who starts an agent whose wait is over. The supervisor sets it; it survives a reset. */
export function onRetryDue(fn: ((agentId: string) => void) | null): void {
  dueHandler = fn;
}

/** Called whenever a wait starts or ends. Returns the way to stop listening. */
export function onRetryChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** For checks: a fresh, empty book on `clock`. Its handler and listeners are kept. */
export function resetRetryBook(clock: Clock = realClock): RetryBook {
  book.clear();
  book = new RetryBook(clock, (id) => dueHandler?.(id), changed);
  return book;
}
