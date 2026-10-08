/**
 * The daily budget (Amendment 59). W0's: the status bar shows today's spend against it,
 * and reaching it is an alert in Needs You. It warns, by the user's choice: nothing is
 * stopped or paused. "Today" is local, midnight to midnight, as `cost_daily` counts it.
 */

import type { Db } from './db/index.js';
import { hub } from './hub.js';
import { costToday, localDay } from './session/store.js';
import { readSettings, settingRule } from './settings.js';

export const DAILY_KEY = 'conductor.dailyBudget';
export const DAILY_MAX = 1_000_000;

/** Dollars, or null when none is set. */
export function dailyBudget(): number | null {
  const n = Number(readSettings()[DAILY_KEY]);
  return Number.isFinite(n) && n > 0 && n <= DAILY_MAX ? n : null;
}

settingRule(DAILY_KEY, (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= DAILY_MAX ? null : `dollars, more than 0 and up to ${DAILY_MAX.toLocaleString('en')}`;
});

const listeners = new Set<() => void>();

/** Told whenever today's spend grows. */
export function onCostChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function costChanged(): void {
  for (const l of listeners) l();
}

/** How often the day is looked at. Short, because a machine that sleeps through midnight wakes late. */
export const DAY_CHECK_MS = 30_000;

/**
 * Notices the day changing (Amendment 103). The daemon already counts the day right, one
 * `cost_daily` row per local day, but an open page is told today's spend only when it
 * connects and when a run's spend grows; a tab left open past midnight kept yesterday's
 * figure. So the day is looked at on a short interval and compared with the last one
 * seen, rather than waiting on one long timer to midnight: a machine that sleeps through
 * midnight fires that timer late, and a clock moved by hand fires it never.
 *
 * "The day" is the daemon process's local one, as `localDay` reads it. Nothing sets `TZ`.
 */
export class DayWatch {
  #seen: string;
  #timer: NodeJS.Timeout | null = null;

  /**
   * `onTurn` hears the new day and the one before, the first time a look finds them
   * different. `today` is the clock, for a check that has to move the day.
   */
  constructor(
    private readonly onTurn: (day: string, was: string) => void,
    private readonly today: () => string = localDay,
  ) {
    this.#seen = today();
  }

  /** Look once. True when the day was not the one last seen: then it is, and `onTurn` ran. */
  check(): boolean {
    const day = this.today();
    if (day === this.#seen) return false;
    const was = this.#seen;
    this.#seen = day;
    this.onTurn(day, was);
    return true;
  }

  /** Look every `everyMs`. The timer never keeps the daemon alive. */
  start(everyMs = DAY_CHECK_MS): void {
    this.stop();
    this.#timer = setInterval(() => this.check(), everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

let watch: DayWatch | null = null;

/**
 * Every open page is told the new day's total (0, at midnight), and the daily budget's
 * alert is checked against it. Returns the way to stop. Called by `Alerts.start`, which
 * also refreshes at midnight for notes due.
 */
export function startDayWatch(db: Db): () => void {
  watch?.stop();
  const mine = new DayWatch(() => {
    try {
      hub().broadcast({ type: 'cost', costToday: costToday(db) });
    } catch {
      // No hub outside the daemon. Not fatal.
    }
    costChanged();
  });
  watch = mine;
  mine.start();
  return () => {
    mine.stop();
    if (watch === mine) watch = null;
  };
}

/** The running watch, for a check that drives the clock. Null when none is started. */
export function dayWatch(): DayWatch | null {
  return watch;
}
