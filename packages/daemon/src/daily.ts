/**
 * The daily budget (Amendment 59). W0's: the status bar shows today's spend against it,
 * and reaching it is an alert in Needs You. It warns, by the user's choice: nothing is
 * stopped or paused. "Today" is local, midnight to midnight, as `cost_daily` counts it.
 */

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
