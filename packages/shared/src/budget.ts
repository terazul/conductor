/**
 * Budgets: where an agent stands against the one it was given (Amendment 124).
 *
 * A budget is PER DAY (Amendment 129): it counts what the agent spent today, local time, and
 * goes back to zero at midnight. It was a lifetime cap (Amendments 77, 124). The agent's own
 * `costUsd` is still its lifetime spend and is shown as information, but no cap reads it:
 * every one reads `Agent.spentToday`, the day's figure with the day it is for.
 *
 * A budget WARNS. The agent keeps working past it, and Needs You asks to raise it; what
 * stops a runaway agent is a CEILING at twice the budget. The thresholds are here, pure,
 * because the daemon applies them (what the SDK may still spend, when to pause) and the
 * browser says what they will do before anything happens (the composer's line, the
 * alert's buttons, the bars) — one copy, so the two can't disagree.
 *
 * Both units go through the same two thresholds: an agent capped in dollars, and one
 * capped in tokens (input plus output, Amendment 77). A job's budget is the sum of its
 * agents' (`jobCap`, daemon) and goes through them too.
 */

import type { DaySpend, UsagePayload } from './events.js';
import type { Agent } from './wire.js';

/**
 * `YYYY-MM-DD` for `d` in the LOCAL time of whoever runs this, the day a budget is counted
 * over (Amendment 129). The daemon's own `localDay` (session/store.ts) writes the same
 * thing, with a clock a check can move; this is the browser's, and the default when a
 * caller doesn't pass the day.
 */
export function localDayOf(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The most an agent may spend, as a multiple of its budget, when no setting says otherwise. */
export const BUDGET_CEILING = 2;

/**
 * The ceiling is a setting (Amendment 140): `conductor.budgetCeiling`, a number from 1 to 10.
 * Each side keeps its own copy of the settings (the daemon its file, the page its map) and
 * says where through `readBudgetCeilingFrom`, so this file imports neither; `ceilingOf` reads
 * it on every call, so a change applies at the next check with nothing to restart.
 */
export const BUDGET_CEILING_KEY = 'conductor.budgetCeiling';
export const BUDGET_CEILING_MIN = 1;
export const BUDGET_CEILING_MAX = 10;

/** Why a value won't do for the ceiling, or null. The daemon's rule and the Settings field both say this. */
export function budgetCeilingProblem(v: string): string | null {
  const t = v.trim();
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && n >= BUDGET_CEILING_MIN && n <= BUDGET_CEILING_MAX
    ? null
    : `a number from ${BUDGET_CEILING_MIN} to ${BUDGET_CEILING_MAX}, such as 2 or 1.5`;
}

/** The setting's value as a multiple, or the default when it is absent or not one. */
export function parseBudgetCeiling(v: string | null | undefined): number {
  return v !== null && v !== undefined && budgetCeilingProblem(v) === null ? Number(v.trim()) : BUDGET_CEILING;
}

let ceilingSource: () => number = () => BUDGET_CEILING;

/** Where this side keeps the setting: the daemon's file, the page's settings map. */
export function readBudgetCeilingFrom(fn: () => number): void {
  ceilingSource = fn;
}

/** The ceiling in force: the setting, held to 1-10, else 2. */
export function budgetCeiling(): number {
  const n = ceilingSource();
  return Number.isFinite(n) && n >= BUDGET_CEILING_MIN && n <= BUDGET_CEILING_MAX ? n : BUDGET_CEILING;
}

/**
 * The ceiling in words, for a sentence: "twice" at 2, else "1.5×" (Amendment 140). So a line
 * that said "stopped at twice its $5 daily budget" still does at the default.
 */
export function ceilingWords(n: number = budgetCeiling()): string {
  return n === 2 ? 'twice' : `${n}×`;
}

/**
 * Whether an agent paused only by the day's budget or its ceiling is continued when the day
 * changes (Amendment 140): `on` unless the setting says `off`.
 */
export const BUDGET_RESUME_KEY = 'conductor.budgetResumeAtMidnight';

export function budgetResumeProblem(v: string): string | null {
  return v === 'on' || v === 'off' ? null : 'on or off';
}

export function resumesAtMidnight(v: string | null | undefined): boolean {
  return v !== 'off';
}

/**
 *  ok       under the budget.
 *  over     at or past the budget, under the ceiling: a warning, nothing stops.
 *  ceiling  at or past the ceiling (twice the budget unless set otherwise): the hard stop
 *           (paused, `budget_exhausted`).
 */
export type BudgetState = 'ok' | 'over' | 'ceiling';

/** What a budget counts: dollars, or input plus output tokens. */
export type BudgetUnit = 'usd' | 'tokens';

/**
 * The figure that stops an agent given `budget`: the budget times the ceiling in force
 * (`budgetCeiling`, 2 unless the setting says otherwise), or times `ceiling` when the caller
 * says. Rounded to a millionth, so 25 x 1.1 is 27.5 and not 27.500000000000004.
 */
export function ceilingOf(budget: number, ceiling: number = budgetCeiling()): number {
  return Math.round(budget * ceiling * 1e6) / 1e6;
}

/** Where `spent` stands against `budget`. null = no budget, so never anything. */
export function capState(spent: number, budget: number | null): BudgetState {
  if (budget === null) return 'ok';
  if (spent >= ceilingOf(budget)) return 'ceiling';
  return spent >= budget ? 'over' : 'ok';
}

/** What an agent has spent on `today`, in both units. An older stamp, or none, is nothing spent. */
export function spentOn(
  agent: Pick<Agent, 'spentToday'>,
  today: string = localDayOf(),
): { usd: number; tokens: number } {
  const s = agent.spentToday;
  return s && s.day === today ? { usd: s.usd, tokens: s.tokens } : { usd: 0, tokens: 0 };
}

/**
 * The agent's spend today after `u`, for a page that folds a usage event into its copy of the
 * agent. The event carries the daemon's own figure (`u.today`); one that doesn't (a recording,
 * an event from before Amendment 129) adds the growth of the lifetime figures to what the
 * agent had today. A shrinking figure adds nothing.
 */
export function spentAfterUsage(
  agent: Pick<Agent, 'costUsd' | 'inputTokens' | 'outputTokens' | 'spentToday'>,
  u: Pick<UsagePayload, 'costUsd' | 'inputTokens' | 'outputTokens' | 'today'>,
  today: string = localDayOf(),
): DaySpend {
  if (u.today) return u.today;
  const had = spentOn(agent, today);
  return {
    day: today,
    usd: had.usd + Math.max(0, u.costUsd - agent.costUsd),
    tokens: had.tokens + Math.max(0, u.inputTokens + u.outputTokens - (agent.inputTokens + agent.outputTokens)),
  };
}

/** The budget an agent has, in the unit its engine reports, with what it has spent TODAY in it. */
export interface AgentBudget {
  unit: BudgetUnit;
  spent: number;
  budget: number;
}

type Spend = Pick<Agent, 'spentToday' | 'autonomy'>;

/**
 * The agent's budget: the dollar one when it has one, else the token one, else null. `spent`
 * is what it spent on `today` (the local day of the machine running this unless the caller
 * says), so the same call gives 0 on the morning after (Amendment 129).
 */
export function agentBudget(agent: Spend, today: string = localDayOf()): AgentBudget | null {
  const spent = spentOn(agent, today);
  const usd = agent.autonomy.budgetUsd;
  if (usd !== null) return { unit: 'usd', spent: spent.usd, budget: usd };
  const tokens = agent.autonomy.budgetTokens ?? null;
  return tokens === null ? null : { unit: 'tokens', spent: spent.tokens, budget: tokens };
}

/** Where the agent stands against its own budget today. An agent with none is always ok. */
export function budgetState(agent: Spend, today: string = localDayOf()): BudgetState {
  const b = agentBudget(agent, today);
  return b === null ? 'ok' : capState(b.spent, b.budget);
}
