/**
 * The retry delays, the budget ceiling and whether midnight continues a budget pause, as the
 * Settings tab edits them (Amendment 140). The rules are shared (`@conductor/shared`
 * retry.ts and budget.ts), and the daemon's settingRule is the one that decides; this only
 * lets each field say what is wrong before the daemon refuses it, in the slot field's words
 * (settings/slots.ts), and writes the default as nothing, so the file keeps only a choice.
 */

import {
  BUDGET_CEILING,
  BUDGET_CEILING_KEY,
  BUDGET_RESUME_KEY,
  RETRY_DELAYS_DEFAULT_S,
  RETRY_DELAYS_KEY,
  budgetCeilingProblem,
  parseBudgetCeiling,
  parseRetryDelays,
  resumesAtMidnight,
  retryDelaysProblem,
  retryDelaysText,
} from '@conductor/shared';

export { BUDGET_CEILING, BUDGET_CEILING_KEY, BUDGET_RESUME_KEY, RETRY_DELAYS_DEFAULT_S, RETRY_DELAYS_KEY };

/** "a number from 1 to 10" as the field says it: "A number from 1 to 10." */
function sentence(why: string | null): string | null {
  return why === null ? null : `${why[0]!.toUpperCase()}${why.slice(1)}.`;
}

/** Why the typed delays won't do, or null. */
export function retryDelaysFieldProblem(v: string): string | null {
  return sentence(retryDelaysProblem(v));
}

/** What to write for typed delays: `5, 15, 30` as the setting keeps them; null for the default. */
export function retryDelaysValue(v: string): string | null {
  const s = parseRetryDelays(v);
  if (!s) return null;
  return retryDelaysText(s) === retryDelaysText(RETRY_DELAYS_DEFAULT_S) ? null : retryDelaysText(s);
}

/** The delays the field shows: the setting's, else the default. */
export function retryDelaysShown(stored: string | null): string {
  return retryDelaysText(parseRetryDelays(stored) ?? RETRY_DELAYS_DEFAULT_S);
}

/** The delays in words for the hint: "5 s, 15 s, 30 s, 1 min, 5 min — five tries". */
export function retryDelaysWords(stored: string | null): string {
  const s = parseRetryDelays(stored) ?? [...RETRY_DELAYS_DEFAULT_S];
  const one = (n: number): string => (n % 60 === 0 ? `${n / 60} min` : `${n} s`);
  const tries = ['one try', 'two tries', 'three tries', 'four tries', 'five tries'][s.length - 1] ?? `${s.length} tries`;
  return `${s.map(one).join(', ')}: ${tries}, then the agent has failed`;
}

/** Why the typed ceiling won't do, or null. */
export function ceilingFieldProblem(v: string): string | null {
  return sentence(budgetCeilingProblem(v));
}

/** What to write for a typed ceiling: the number; null for the default of 2. */
export function ceilingValue(v: string): string | null {
  const n = parseBudgetCeiling(v);
  return n === BUDGET_CEILING ? null : String(n);
}

/** The ceiling the field shows. */
export function ceilingShown(stored: string | null): string {
  return String(parseBudgetCeiling(stored));
}

/** Whether midnight continues an agent paused only by the day's budget: on unless set off. */
export function midnightOn(stored: string | null): boolean {
  return resumesAtMidnight(stored);
}

/** What to write for the toggle: nothing for on, the default; `off` for off. */
export function midnightValue(on: boolean): string | null {
  return on ? null : 'off';
}
