/**
 * Budgets — what an agent has spent today against its figure, and what to say about it.
 *
 * A budget is PER DAY (Amendment 129): what the agent spent today, local time, against its
 * figure, back to zero at midnight. It was a LIFETIME cap (Amendments 77, 124), and this
 * replaces that. What it counts is `Agent.spentToday`, which the store keeps in
 * `agent_spend_daily` and grows by deltas as usage arrives; the agent's own `costUsd` is its
 * lifetime spend, still shown, and no budget reads it. The rules are here, apart from the
 * supervisor and the alerts that apply them, so session/verify.ts can check them (Amendment 9).
 *
 * An engine that can't say what a run cost in dollars is budgeted in tokens instead —
 * input plus output, never converted into dollars (Amendment 77). Each agent has one
 * unit: the one its engine reports.
 *
 * It only WARNS (Amendment 180). Past its budget an agent keeps working and Needs You asks to
 * raise it (session/alerts.ts); nothing is refused, paused or handed the SDK as a limit for a
 * budget, the agent's or its job's. The ceiling at twice the budget that stopped it
 * (Amendments 124, 129, 140) is gone. Where the line is is in `@conductor/shared`
 * (`budgetState`), the one copy the screens read too.
 */

import {
  agentBudget as sharedAgentBudget,
  budgetState as sharedBudgetState,
  type Agent,
  type AgentBudget,
  type Autonomy,
  type BudgetState,
} from '@conductor/shared';
import { localDay } from './store.js';

export { capState } from '@conductor/shared';

/**
 * The daemon's reading of the shared rule: today is the daemon's day (`localDay`, which a
 * check can move with `setDayClock`), not the clock of whoever imported this.
 */
export function agentBudget(agent: Pick<Agent, 'spentToday' | 'autonomy'>): AgentBudget | null {
  return sharedAgentBudget(agent, localDay());
}

export function budgetState(agent: Pick<Agent, 'spentToday' | 'autonomy'>): BudgetState {
  return sharedBudgetState(agent, localDay());
}

/** `$25`, `$25.10`. Whole dollars stay whole, because that is how people type budgets. */
export function money(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** `950`, `12.5k`, `500k`, `1.2M`: tokens as people say them. Never decreases as `n` grows. */
export function tokens(n: number): string {
  // Rounded down, in whole tenths, so a figure never reads as more than was spent.
  const short = (unit: number, suffix: string): string =>
    `${n >= unit * 100 ? Math.floor(n / unit) : Math.floor(n / (unit / 10)) / 10}${suffix}`;
  if (n < 1_000) return String(Math.floor(n));
  return n < 1_000_000 ? short(1_000, 'k') : short(1_000_000, 'M');
}

/**
 * The agent's LIFETIME spend after a run that reported `reported`. The lifetime figure is
 * information now (the details panel's "lifetime"); no budget reads it (Amendment 129). The
 * growth of it, never negative, is what each run adds to today's spend.
 *
 * The first result of a resumed session already carries the session's earlier spend
 * — "a resumed or forked session continues from the total its transcript saved, when
 * it has one". When the transcript saved none, it starts again from zero. A continued
 * total can never be below what was stored, so a smaller one means the latter.
 */
export function lifetimeCost(stored: number, reported: number): number {
  return reported >= stored ? reported : stored + reported;
}

const JOB_STOP = 'job budget reached';
const AGENT_STOP = 'budget reached';

/**
 * Which budget a paused agent's note says it stopped on, or null for any other pause. Nothing
 * pauses for a budget since Amendment 180; this reads the notes the ceiling wrote before then
 * (`budget reached…`, `job budget reached…`, and a midnight's `…renewed for` rewrite of
 * either), so an agent still paused by one is a card in Needs You that says continue works.
 */
export function budgetStop(note: string | undefined): 'budget_exhausted' | 'job_budget_reached' | null {
  if (note?.startsWith(JOB_STOP)) return 'job_budget_reached';
  return note?.startsWith(AGENT_STOP) ? 'budget_exhausted' : null;
}

/**
 * Why `autonomy` asks for a budget its engine can't count, or null. An engine that reports
 * no dollars would never reach a dollar budget, so one would be a warning that never comes;
 * and Claude's budgets stay in dollars, which is what its runs report.
 */
export function budgetUnitRefusal(provider: string, costUsd: boolean, autonomy: Autonomy): string | null {
  if (!costUsd && autonomy.budgetUsd !== null) {
    return `${provider} doesn't report what a run costs in dollars, so a dollar budget can't be kept — set it in tokens with budgetTokens instead`;
  }
  if (costUsd && (autonomy.budgetTokens ?? null) !== null) {
    return `${provider} reports what a run costs in dollars, so its budget is budgetUsd, not budgetTokens`;
  }
  return null;
}

/**
 * A job's budget is PER DAY too (Amendment 129): the sum of its agents' CURRENT daily
 * budgets, against the sum of what they spent today (`jobCostToday`). It is not the figure
 * Spawn launched with, so raising one agent's budget raises the job's. One agent without a
 * budget leaves the job without one, since its spend has no bound. Past it, Needs You warns
 * (session/alerts.ts) and nothing is held (Amendment 180).
 *
 * It stays in dollars. An agent budgeted in tokens has no dollar budget, and its dollars are
 * not known rather than zero (OpenRouter still bills them), so it leaves the job without a
 * dollar budget like any agent without one. Tokens are never added to dollars, here or in
 * today's spend.
 */
export function jobCap(agents: readonly Pick<Agent, 'autonomy'>[]): number | null {
  let sum = 0;
  for (const a of agents) {
    if (a.autonomy.budgetUsd === null) return null;
    sum += a.autonomy.budgetUsd;
  }
  return agents.length === 0 ? null : sum;
}
