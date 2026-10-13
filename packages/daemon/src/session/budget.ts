/**
 * Budgets — what an agent may still spend today, and what to say when it may not.
 *
 * A budget is PER DAY (Amendment 129): what the agent spent today, local time, against its
 * figure, back to zero at midnight. It was a LIFETIME cap (Amendments 77, 124), and this
 * replaces that. What it counts is `Agent.spentToday`, which the store keeps in
 * `agent_spend_daily` and grows by deltas as usage arrives; the agent's own `costUsd` is its
 * lifetime spend, still shown, and no cap reads it.
 *
 * The SDK's `maxBudgetUsd` counts only "the spend since this query() call started"
 * (sdk.d.ts, `total_cost_usd`), so it can't be handed the figure as it is: it is given what is
 * left of today's ceiling at launch (`runLimit`), which every message re-computes. The rules
 * are here, apart from the runner and the supervisor that apply them, so session/verify.ts can
 * check them (Amendment 9).
 *
 * An engine that can't say what a run cost in dollars is capped in tokens instead —
 * input plus output, never converted into dollars (Amendment 77). Each agent has one
 * unit: the one its engine reports.
 *
 * It WARNS, and a ceiling stops (Amendment 124). Past its budget an agent keeps working
 * and Needs You asks to raise it (session/alerts.ts); it is stopped, paused, at twice the
 * budget so a runaway can't spend without limit. Where those two lines are is in
 * `@conductor/shared` (`budgetState`), the one copy the screens read too. Everything here
 * that REFUSES, or hands the SDK a limit, is about the ceiling.
 *
 * At midnight an agent paused only by the day's budget or its ceiling is continued, as
 * ▶ resume continues it (`continuations`, Amendment 140), unless `conductor.budgetResumeAtMidnight`
 * is off; then it stays paused with its budget renewed (`renewals`), until you say continue.
 */

import {
  BUDGET_CEILING_KEY,
  BUDGET_RESUME_KEY,
  agentBudget as sharedAgentBudget,
  budgetCeilingProblem,
  budgetResumeProblem,
  budgetState as sharedBudgetState,
  capState,
  ceilingOf,
  parseBudgetCeiling,
  readBudgetCeilingFrom,
  resumesAtMidnight,
  type Agent,
  type AgentBudget,
  type Autonomy,
  type BudgetState,
} from '@conductor/shared';
import { readSettings, settingRule } from '../settings.js';
import { localDay } from './store.js';

export { BUDGET_CEILING, budgetCeiling, capState, ceilingOf } from '@conductor/shared';

/**
 * The ceiling is the daemon's `conductor.budgetCeiling` (Amendment 140), read on every
 * `ceilingOf` from the cached settings (settings.ts:46), so a change applies at the next check.
 */
readBudgetCeilingFrom(() => parseBudgetCeiling(readSettings()[BUDGET_CEILING_KEY]));
settingRule(BUDGET_CEILING_KEY, budgetCeilingProblem);
settingRule(BUDGET_RESUME_KEY, budgetResumeProblem);

/** Whether the day change continues agents paused only by the day's budget (Amendment 140). On unless set off. */
export function resumeAtMidnight(): boolean {
  return resumesAtMidnight(readSettings()[BUDGET_RESUME_KEY]);
}

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

/** What is left of a cap after `spent`. null = uncapped. Never negative. */
export function budgetLeft(cap: number | null, spent: number): number | null {
  return cap === null ? null : Math.max(0, cap - spent);
}

/**
 * What the SDK may still spend in this run: what is left of TODAY'S ceiling, twice the daily
 * budget (Amendments 124, 129), since its own `maxBudgetUsd` is the one hard stop. null = no
 * budget. `spentTodayUsd` is what the agent spent today when the run starts: the SDK counts
 * only this query's spend, so the limit is the ceiling less what was already spent. The budget
 * itself is only a warning and reaches the SDK not at all.
 *
 * Given once, at launch. A run that crosses midnight keeps the limit it started with; its
 * later spend is credited to the new day, and the next launch computes a fresh one.
 */
export function runLimit(budgetUsd: number | null, spentTodayUsd: number): number | null {
  return budgetLeft(budgetUsd === null ? null : ceilingOf(budgetUsd), spentTodayUsd);
}

/**
 * The agent's LIFETIME spend after a run that reported `reported`. The lifetime figure is
 * information now (the details panel's "lifetime"); no cap reads it (Amendment 129). The
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

type Spend = Pick<Agent, 'spentToday' | 'autonomy'>;

/**
 * Stopped on its ceiling, as the note on the status event and the header say it: what it
 * spent today, its daily budget, and that the budget alone would not have stopped it
 * (Amendments 124, 129). The prefix is what `budgetStop` reads.
 */
export function budgetNote(agent: Spend): string {
  const b = agentBudget(agent);
  if (b === null) return 'budget reached';
  return b.unit === 'usd'
    ? `budget reached for today — spent ${money(b.spent)} of its ${money(b.budget)} daily budget, which stops it at ${money(ceilingOf(b.budget))}`
    : `budget reached for today — spent ${tokens(b.spent)} of its ${tokens(b.budget)}-token daily budget, which stops it at ${tokens(ceilingOf(b.budget))}`;
}

/** Held before it started, because its job's agents had spent the job's cap today. */
export const JOB_BUDGET_NOTE = 'job budget reached for today';

const JOB_STOP = 'job budget reached';
const AGENT_STOP = 'budget reached';

/**
 * Which cap a paused agent's note says it stopped on, or null for any other pause.
 * Beside the notes it reads, so an alert can't disagree with what was written. It reads the
 * start of the note: the job's note was `job budget reached` before Amendment 129, and the
 * note a midnight rewrites is the same words and more.
 */
export function budgetStop(note: string | undefined): 'budget_exhausted' | 'job_budget_reached' | null {
  if (note?.startsWith(JOB_STOP)) return 'job_budget_reached';
  return note?.startsWith(AGENT_STOP) ? 'budget_exhausted' : null;
}

/** Whether a budget pause's note is the one a new day wrote: it says its budget is renewed. */
export function isRenewedNote(note: string | undefined): boolean {
  return budgetStop(note) !== null && /\brenewed for \d{4}-\d{2}-\d{2}/.test(note ?? '');
}

/**
 * What a budget pause says once the new day has renewed the budget (Amendment 129): still a
 * pause, still `budget reached` to everything that reads the prefix, and now saying that a
 * plain continue works, since nothing is spent today. Nothing resumes by itself.
 */
export function renewedNote(stop: 'budget_exhausted' | 'job_budget_reached', agent: Spend, day: string): string {
  if (stop === 'job_budget_reached') {
    return `job budget reached — the job's daily budget is renewed for ${day}; continue to carry on, no raise needed`;
  }
  const b = agentBudget(agent);
  const said = b === null ? 'budget' : b.unit === 'usd' ? `${money(b.budget)} daily budget` : `${tokens(b.budget)}-token daily budget`;
  return `budget reached — its ${said} is renewed for ${day}; continue to carry on, no raise needed`;
}

/** One paused agent the new day looks at, with what the rewrite needs to know about its job. */
export interface PausedForBudget {
  agent: Pick<Agent, 'id' | 'spentToday' | 'autonomy'>;
  /** The note on its last status event. */
  note: string | undefined;
  /** Its job, today, is at its ceiling (twice the sum of its agents' budgets). */
  jobAtCeiling: boolean;
}

/**
 * At the day change (Amendment 129): which paused agents' notes to rewrite, and to what.
 * Pure, so it tests directly. An agent paused at its ceiling, or held for its job's, stays
 * paused: NOTHING IS RESUMED, because that would spend with no one watching. Its note says its
 * budget is renewed for the new day and that continue needs no raise, and `budgetRefusal`,
 * which now reads today's spend, lets the continue through. It is left alone when it is not a
 * budget pause, when its note already says renewed, or when it is still at the ceiling today
 * (the clock moved back to a day it had spent on, say).
 */
export function renewals(paused: readonly PausedForBudget[], day: string): Array<{ agentId: string; note: string }> {
  const out: Array<{ agentId: string; note: string }> = [];
  for (const p of paused) {
    const stop = budgetStop(p.note);
    if (!stop || isRenewedNote(p.note)) continue;
    if (stop === 'job_budget_reached' ? p.jobAtCeiling : sharedBudgetState(p.agent, day) === 'ceiling') continue;
    out.push({ agentId: p.agent.id, note: renewedNote(stop, p.agent, day) });
  }
  return out;
}

/**
 * At the day change, which paused agents to CONTINUE (Amendment 140, Q4 of wave 10): the ones
 * paused only by a budget, their own ceiling (`budget_exhausted`) or their job's
 * (`job_budget_reached`), with room on `day`. Pure. A renewed note counts, since it is still
 * only a budget pause (one renewed while the setting was off, or while everything was paused).
 * Left alone: a pause you made, a hold, a failure, any other note, and one still at its ceiling
 * on `day` (or whose job still is). Whether the setting is on is the caller's to ask.
 */
export function continuations(paused: readonly PausedForBudget[], day: string): string[] {
  const out: string[] = [];
  for (const p of paused) {
    const stop = budgetStop(p.note);
    if (!stop) continue;
    if (stop === 'job_budget_reached' ? p.jobAtCeiling : sharedBudgetState(p.agent, day) === 'ceiling') continue;
    out.push(p.agent.id);
  }
  return out;
}

/**
 * What the transcript says of an agent the new day continued (Amendment 140), on the status
 * event that queues it. The words a person reads; `NEW_DAY_NUDGE` (supervisor.ts) is the model's.
 */
export function newDayNote(day: string): string {
  return `a new day's budget began (${day}) — continuing`;
}

/**
 * Why this agent may not run again, or null if it may. Checked before every launch
 * and every resume, so being at today's ceiling refuses with a sentence rather than starting
 * a run the SDK would end immediately. Past the budget but under the ceiling it may run:
 * that is the warning (Amendment 124). Tomorrow it may run again with nothing raised.
 */
export function budgetRefusal(agent: Pick<Agent, 'role'> & Spend): string | null {
  const who = agent.role.charAt(0).toUpperCase() + agent.role.slice(1);
  const b = agentBudget(agent);
  if (b === null || capState(b.spent, b.budget) !== 'ceiling') return null;
  return b.unit === 'usd'
    ? `The ${who} has spent ${money(b.spent)} of its ${money(b.budget)} daily budget today, which stops it at ${money(ceilingOf(b.budget))} — raise it to continue, or it renews at midnight.`
    : `The ${who} has spent ${tokens(b.spent)} of its ${tokens(b.budget)}-token daily budget today, which stops it at ${tokens(ceilingOf(b.budget))} — raise it to continue, or it renews at midnight.`;
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
 * A job's budget is PER DAY too (Amendment 129): the sum of its agents' CURRENT daily
 * budgets, against the sum of what they spent today (`jobCostToday`). It is not the figure
 * Spawn launched with. Otherwise raising one agent's budget would leave its queued siblings paused at
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

/**
 * Where a job stands against its budget, the sum of its agents' (Amendment 124): `over`
 * warns, `ceiling` is twice it, past which agents still waiting to start are held. The
 * ones already running are stopped by their own budgets and nothing else. ok when the job
 * has no dollar budget (`jobCap` is null). `spentUsd` is what the job's agents spent TODAY
 * (`jobCostToday`), so it is back to ok at midnight (Amendment 129).
 */
export function jobBudgetState(agents: readonly Pick<Agent, 'autonomy'>[], spentUsd: number): BudgetState {
  return capState(spentUsd, jobCap(agents));
}
