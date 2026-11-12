/**
 * Repeating jobs: when one runs again, the check on its rule, and the rule in words (Amendment 211).
 *
 * Pure, and here for the reason `stack.ts` gives: the daemon decides when a schedule is due
 * and the browser says when it will be, from one copy, so the two can't disagree.
 *
 * Times are wall-clock times on the local clock. "Every day at 09:00" is 09:00 on each day,
 * summer or winter: the next run is built from the local date and the time, not by adding 24
 * hours, so a change of clocks moves nothing. A time the clocks skip (02:30 on the night they go
 * forward) runs when the clock reaches it, an hour later; a time that happens twice runs once.
 */

import type { Every } from './wire.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The most hours "every N hours" can be: a week. */
export const MAX_EVERY_HOURS = 168;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The longest name a schedule can have: it heads each run's job name. */
export const RECURRING_NAME_MAX = 60;

/** What is wrong with a schedule's name, or null. */
export function recurringNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'a name is required';
  if (name.trim().length > RECURRING_NAME_MAX) return `a name is at most ${RECURRING_NAME_MAX} characters`;
  return null;
}

/** What is wrong with a rule, in words, or null when it is a rule. */
export function everyProblem(every: unknown): string | null {
  if (!every || typeof every !== 'object') return 'every must be a rule: daily, weekly or hours';
  const e = every as Record<string, unknown>;
  if (e['kind'] === 'hours') {
    const n = e['n'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_EVERY_HOURS) {
      return `every N hours needs a whole number of hours from 1 to ${MAX_EVERY_HOURS}`;
    }
    return null;
  }
  if (e['kind'] !== 'daily' && e['kind'] !== 'weekly') return 'every must be a rule: daily, weekly or hours';
  if (typeof e['at'] !== 'string' || !HHMM.test(e['at'])) return 'the time must be HH:MM, from 00:00 to 23:59';
  if (e['kind'] === 'weekly') {
    const days = e['days'];
    if (!Array.isArray(days) || days.length === 0) return 'pick at least one day of the week';
    if (!days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
      return 'days of the week are 0 (Sunday) to 6 (Saturday)';
    }
  }
  return null;
}

/** The rule as it is kept: only its own fields, a week's days sorted and once each. Check it first. */
export function normalEvery(every: Every): Every {
  switch (every.kind) {
    case 'daily':
      return { kind: 'daily', at: every.at };
    case 'weekly':
      return { kind: 'weekly', days: [...new Set(every.days)].sort((a, b) => a - b), at: every.at };
    case 'hours':
      return { kind: 'hours', n: every.n };
  }
}

/**
 * The first time the rule comes due after `after`, never at it. Every N hours is N hours on;
 * the others are the time on the next local day the rule names: today if it is still to come.
 */
export function nextRun(every: Every, after: Date): Date {
  if (every.kind === 'hours') return new Date(after.getTime() + every.n * 3_600_000);
  const [hh, mm] = every.at.split(':').map(Number) as [number, number];
  const y = after.getFullYear();
  const m = after.getMonth();
  const d = after.getDate();
  // Eight days: today's time may have passed, and a week's one day may be today's weekday.
  for (let i = 0; i <= 7; i++) {
    // The weekday from midday, which no change of clocks moves to another day.
    if (every.kind === 'weekly' && !every.days.includes(new Date(y, m, d + i, 12).getDay())) continue;
    const at = new Date(y, m, d + i, hh, mm);
    if (at.getTime() > after.getTime()) return at;
  }
  // Unreachable for a checked rule; a day on rather than a loop that never ends.
  return new Date(after.getTime() + 86_400_000);
}

/** A week's days in words: "weekday", "Monday", "Mon, Wed and Fri". */
function daysWords(days: readonly number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '0,1,2,3,4,5,6') return 'every day';
  if (key === '1,2,3,4,5') return 'every weekday';
  if (key === '0,6') return 'every Saturday and Sunday';
  if (set.length === 1) return `every ${DAY_NAMES[set[0]!]}`;
  // Monday first, as a week reads.
  const names = [...set.filter((d) => d !== 0), ...set.filter((d) => d === 0)].map((d) => DAY_SHORT[d]!);
  return `every ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The rule in words: "every day at 09:00", "every weekday at 09:00", "every 6 hours". */
export function everyWords(every: Every): string {
  switch (every.kind) {
    case 'daily':
      return `every day at ${every.at}`;
    case 'weekly':
      return `${daysWords(every.days)} at ${every.at}`;
    case 'hours':
      return every.n === 1 ? 'every hour' : `every ${every.n} hours`;
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A run's job name: the schedule's, and when it came due, "Nightly tests · 12 Nov 09:00". */
export function runName(name: string, at: Date): string {
  return `${name} · ${at.getDate()} ${MONTHS[at.getMonth()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * A run's branch, when the setup names one: the name and when it came due, "nightly-20261112-0900".
 * A branch is one job's, and a second run on the first one's would be refused.
 */
export function runBranch(branch: string, at: Date): string {
  return `${branch}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/**
 * The mark on a job a schedule started, by the schedule's name: "⟳ from Nightly tests"; a
 * cancelled schedule's jobs stay, and say so. Null for a job you launched.
 */
export function fromMark(
  recurringId: string | null | undefined,
  recurring: readonly { id: string; name: string }[],
): string | null {
  if (!recurringId) return null;
  const r = recurring.find((x) => x.id === recurringId);
  return r ? `⟳ from ${r.name}` : '⟳ from a cancelled schedule';
}

/** What a last result says, for a schedule's row. */
export type RecurringResult =
  | { kind: 'started'; held?: true }
  | { kind: 'skipped' }
  | { kind: 'sent'; queued?: true }
  | { kind: 'waiting'; reason: string }
  | { kind: 'failed'; reason: string };

export const RESULT_STARTED = 'started';
/** Run now while everything is paused: the job is made, and waits queued until the pause ends. */
export const RESULT_STARTED_HELD = 'started (waits for Pause all to end)';
export const RESULT_SKIPPED = 'skipped';
/** A repeating message went to its agent (Amendment 216). */
export const RESULT_SENT = 'sent';
/** It went, to wait for a slot: every one was taken (Amendment 168). */
export const RESULT_SENT_QUEUED = 'sent (waiting for a slot)';

/** Why run now ran nothing: the clock, or another run now, was already running it. */
export const BEING_RUN = 'it is being run now';

/** Why a helper gets no repeating message: its orchestrator directs it, and its finished helpers are cleared. */
export const HELPER_NOT_SCHEDULED = "a helper is its orchestrator's to direct; schedule a message to the orchestrator instead";

/** `waiting: <why>`: a message to an agent that cannot take one yet, tried again at each look. */
export function resultWaiting(reason: string): string {
  return `waiting: ${reason}`;
}

/** Why a job without its kept setup cannot be repeated (Amendment 216): the daemon's refusal, and the button's title. */
export const NOT_REPEATABLE =
  'this job was launched before Conductor kept its setup; set it up in Spawn and use repeat…';

/** `failed: <why>`, as kept. */
export function resultFailed(reason: string): string {
  return `failed: ${reason}`;
}

/** A kept last result, read; null before the first time. */
export function readResult(raw: string | null): RecurringResult | null {
  if (raw === null) return null;
  if (raw === RESULT_STARTED) return { kind: 'started' };
  if (raw === RESULT_STARTED_HELD) return { kind: 'started', held: true };
  if (raw === RESULT_SKIPPED) return { kind: 'skipped' };
  if (raw === RESULT_SENT) return { kind: 'sent' };
  if (raw === RESULT_SENT_QUEUED) return { kind: 'sent', queued: true };
  if (raw.startsWith('waiting: ')) return { kind: 'waiting', reason: raw.slice('waiting: '.length) };
  return { kind: 'failed', reason: raw.replace(/^failed:\s*/, '') };
}
