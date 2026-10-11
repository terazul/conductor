/**
 * Budgets: where an agent stands against the one it was given (Amendment 124).
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

import type { Agent } from './wire.js';

/** The most an agent may spend, as a multiple of its budget. */
export const BUDGET_CEILING = 2;

/**
 *  ok       under the budget.
 *  over     at or past the budget, under the ceiling: a warning, nothing stops.
 *  ceiling  at or past twice the budget: the hard stop (paused, `budget_exhausted`).
 */
export type BudgetState = 'ok' | 'over' | 'ceiling';

/** What a budget counts: dollars, or input plus output tokens. */
export type BudgetUnit = 'usd' | 'tokens';

/** The figure that stops an agent given `budget`. Exact: doubling loses nothing. */
export function ceilingOf(budget: number): number {
  return budget * BUDGET_CEILING;
}

/** Where `spent` stands against `budget`. null = no budget, so never anything. */
export function capState(spent: number, budget: number | null): BudgetState {
  if (budget === null) return 'ok';
  if (spent >= ceilingOf(budget)) return 'ceiling';
  return spent >= budget ? 'over' : 'ok';
}

/** Input plus output: what a token budget counts. Cache reads are the backend's business. */
export function tokensSpent(agent: Pick<Agent, 'inputTokens' | 'outputTokens'>): number {
  return agent.inputTokens + agent.outputTokens;
}

/** The budget an agent has, in the unit its engine reports, with what it has spent in it. */
export interface AgentBudget {
  unit: BudgetUnit;
  spent: number;
  budget: number;
}

type Spend = Pick<Agent, 'costUsd' | 'inputTokens' | 'outputTokens' | 'autonomy'>;

/** The agent's budget: the dollar one when it has one, else the token one, else null. */
export function agentBudget(agent: Spend): AgentBudget | null {
  const usd = agent.autonomy.budgetUsd;
  if (usd !== null) return { unit: 'usd', spent: agent.costUsd, budget: usd };
  const tokens = agent.autonomy.budgetTokens ?? null;
  return tokens === null ? null : { unit: 'tokens', spent: tokensSpent(agent), budget: tokens };
}

/** Where the agent stands against its own budget. An agent with none is always ok. */
export function budgetState(agent: Spend): BudgetState {
  const b = agentBudget(agent);
  return b === null ? 'ok' : capState(b.spent, b.budget);
}
