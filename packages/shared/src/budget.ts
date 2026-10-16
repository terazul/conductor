/**
 * Budgets: where an agent stands against the one it was given (Amendment 124).
 *
 * A budget is PER DAY (Amendment 129): it counts what the agent spent today, local time, and
 * goes back to zero at midnight. It was a lifetime cap (Amendments 77, 124). The agent's own
 * `costUsd` is still its lifetime spend and is shown as information, but no cap reads it:
 * every one reads `Agent.spentToday`, the day's figure with the day it is for.
 *
 * A budget WARNS, and only warns (Amendment 180): past it the agent keeps working and Needs
 * You asks to raise it. Nothing stops for a budget, the agent's or its job's; the ceiling at
 * twice it that used to (Amendments 124, 140) is gone. The threshold is here, pure, because
 * the daemon applies it (when to warn) and the browser says it before anything happens (the
 * composer's line, the alert, the bars) — one copy, so the two can't disagree.
 *
 * Both units go through the same threshold: an agent capped in dollars, and one
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

/**
 *  ok    under the budget.
 *  over  at or past it: a warning, and nothing stops (Amendment 180). There is no ceiling.
 */
export type BudgetState = 'ok' | 'over';

/** What a budget counts: dollars, or input plus output tokens. */
export type BudgetUnit = 'usd' | 'tokens';

/** Where `spent` stands against `budget`. null = no budget, so never anything. */
export function capState(spent: number, budget: number | null): BudgetState {
  return budget !== null && spent >= budget ? 'over' : 'ok';
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
