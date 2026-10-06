/**
 * Budgets — what an agent may still spend, and what to say when it may not.
 *
 * A budget is a LIFETIME cap per agent. It used to be passed straight to the SDK as
 * `maxBudgetUsd`, which counts only "the spend since this query() call started"
 * (sdk.d.ts, `total_cost_usd`), so every message you sent bought a fresh cap and
 * "stop each agent after $5" was not what happened. The rules are here, apart from
 * the runner and the supervisor that apply them, so session/verify.ts can check them
 * (Amendment 9).
 *
 * An engine that can't say what a run cost in dollars is capped in tokens instead —
 * input plus output, never converted into dollars (Amendment 77). Each agent has one
 * unit: the one its engine reports.
 */

import type { Agent, Autonomy } from '@conductor/shared';

/** `$25`, `$25.10`. Whole dollars stay whole, because that is how people type caps. */
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

/** Input plus output: what a token cap counts. Cache reads are the backend's business. */
export function tokensSpent(agent: Pick<Agent, 'inputTokens' | 'outputTokens'>): number {
  return agent.inputTokens + agent.outputTokens;
}

/** What is left of a cap after `spent`. null = uncapped. Never negative. */
export function budgetLeft(cap: number | null, spent: number): number | null {
  return cap === null ? null : Math.max(0, cap - spent);
}

/**
 * The agent's lifetime spend after a run that reported `reported`.
 *
 * The first result of a resumed session already carries the session's earlier spend
 * — "a resumed or forked session continues from the total its transcript saved, when
 * it has one". When the transcript saved none, it starts again from zero. A continued
 * total can never be below what was stored, so a smaller one means the latter.
 */
export function lifetimeCost(stored: number, reported: number): number {
  return reported >= stored ? reported : stored + reported;
}

type Spend = Pick<Agent, 'costUsd' | 'inputTokens' | 'outputTokens' | 'autonomy'>;

/** Stopped on its cap, as the note on the status event and the header say it. */
export function budgetNote(agent: Spend): string {
  const cap = agent.autonomy.budgetUsd;
  if (cap !== null) return `budget reached — spent ${money(agent.costUsd)} of its ${money(cap)} budget`;
  const capTokens = agent.autonomy.budgetTokens ?? null;
  return capTokens === null
    ? 'budget reached'
    : `budget reached — spent ${tokens(tokensSpent(agent))} of its ${tokens(capTokens)}-token budget`;
}

/** Held before it started, because its job's agents had spent the job's cap. */
export const JOB_BUDGET_NOTE = 'job budget reached';

/**
 * Which cap a paused agent's note says it stopped on, or null for any other pause.
 * Beside the two notes it reads, so an alert can't disagree with what was written.
 */
export function budgetStop(note: string | undefined): 'budget_exhausted' | 'job_budget_reached' | null {
  if (note === JOB_BUDGET_NOTE) return 'job_budget_reached';
  return note?.startsWith('budget reached') ? 'budget_exhausted' : null;
}

/**
 * Why this agent may not run again, or null if it may. Checked before every launch
 * and every resume, so being at the cap refuses with a sentence rather than starting
 * a run the SDK would end immediately.
 */
export function budgetRefusal(agent: Pick<Agent, 'role'> & Spend): string | null {
  const who = agent.role.charAt(0).toUpperCase() + agent.role.slice(1);
  const cap = agent.autonomy.budgetUsd;
  if (cap !== null && agent.costUsd >= cap) {
    return `The ${who} has spent ${money(agent.costUsd)} of its ${money(cap)} budget — raise it to continue.`;
  }
  const capTokens = agent.autonomy.budgetTokens ?? null;
  const spent = tokensSpent(agent);
  if (capTokens !== null && spent >= capTokens) {
    return `The ${who} has spent ${tokens(spent)} of its ${tokens(capTokens)}-token budget — raise it to continue.`;
  }
  return null;
}

/**
 * Why `autonomy` asks for a cap its engine can't enforce, or null. An engine that reports
 * no dollars would never reach a dollar cap, so one would be a promise that nothing keeps;
 * and Claude's caps stay in dollars, which is what its runs report.
 */
export function budgetUnitRefusal(provider: string, costUsd: boolean, autonomy: Autonomy): string | null {
  if (!costUsd && autonomy.budgetUsd !== null) {
    return `${provider} doesn't report what a run costs in dollars, so a dollar budget can't be kept — cap it in tokens with budgetTokens instead`;
  }
  if (costUsd && (autonomy.budgetTokens ?? null) !== null) {
    return `${provider} reports what a run costs in dollars, so its budget is budgetUsd, not budgetTokens`;
  }
  return null;
}

/**
 * A job's cap is the sum of its agents' CURRENT caps, not the figure Spawn launched
 * with. Otherwise raising one agent's cap would leave its queued siblings paused at
 * the old total. One uncapped agent uncaps the job, since its spend has no bound.
 *
 * It stays in dollars. An agent capped in tokens has no dollar cap, and its dollars are
 * not known rather than zero (OpenRouter still bills them), so it uncaps the job's
 * dollar cap like any agent without one; its own token cap still stops it. Tokens are
 * never added to dollars, here or in today's spend.
 */
export function jobCap(agents: readonly Pick<Agent, 'autonomy'>[]): number | null {
  let sum = 0;
  for (const a of agents) {
    if (a.autonomy.budgetUsd === null) return null;
    sum += a.autonomy.budgetUsd;
  }
  return agents.length === 0 ? null : sum;
}
