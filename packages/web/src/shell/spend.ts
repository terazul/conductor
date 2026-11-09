/**
 * Today's spend against the daily budget, in words and colours (Amendment 59). Pure, so
 * lib/verify.ts checks them.
 *
 * Green while there's room, yellow from 75%, red from 95% — the user's thresholds. Past
 * 100% the bar stays full and red: nothing stops, by the user's choice, so the number
 * keeps going and says so.
 *
 * Each agent's spend against its own budget reads the same way, through the same
 * `toneOf` (Amendment 125): green, yellow from 75%, red from 95%, and from 100% it is
 * over, which the line says in words.
 */

import {
  MONTH_CORRECTION_MAX,
  PROVIDER_BUDGET_MAX,
  localDayOf,
  parseProviderBudgets,
  spentOn,
  type Agent,
  type BudgetUnit,
  type MonthCorrection,
  type ProjectSpend,
} from '@conductor/shared';
import { parseTokens, tokenWords } from '../lib/providers.js';
import { fmtStamp } from '../lib/when.js';

export const DAILY_KEY = 'conductor.dailyBudget';
/** The fleet's monthly budget (Amendment 182), beside the daily one and read the same way. */
export const MONTHLY_KEY = 'conductor.monthlyBudget';
export const WARN_AT = 0.75;
export const OVER_AT = 0.95;

export type SpendTone = 'ok' | 'warn' | 'over';

/** The colour a fraction of a budget reads in: the daily meter's, and every agent's. */
export function toneOf(fraction: number): SpendTone {
  return fraction >= OVER_AT ? 'over' : fraction >= WARN_AT ? 'warn' : 'ok';
}

export function parseBudget(raw: string | null): number | null {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : null;
}

export function dailyMeter(spent: number, budget: number): { fraction: number; tone: SpendTone; label: string; title: string } {
  const fraction = budget > 0 ? spent / budget : 0;
  const tone = toneOf(fraction);
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const pct = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, Math.max(0, fraction)),
    tone,
    label: `${money(spent)} of ${money(budget)} today`,
    title:
      fraction >= 1
        ? `${pct}% of today's budget — ${money(spent - budget)} over. Agents keep going; it only warns.`
        : `${pct}% of today's budget, ${money(budget - spent)} left. Resets at midnight.`,
  };
}

/**
 * This local month's spend against the monthly budget (Amendment 182): the daily meter's colours
 * and words, for the month. It only warns, as the daily one does.
 */
export function monthMeter(spent: number, budget: number): { fraction: number; tone: SpendTone; label: string; title: string } {
  const fraction = budget > 0 ? spent / budget : 0;
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const pct = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, Math.max(0, fraction)),
    tone: toneOf(fraction),
    label: `${money(spent)} of ${money(budget)} this month`,
    title:
      fraction >= 1
        ? `${pct}% of this month's budget — ${money(spent - budget)} over. Agents keep going; it only warns.`
        : `${pct}% of this month's budget, ${money(budget - spent)} left. Resets on the 1st.`,
  };
}

/** The status bar's month with no monthly budget set, after today's figure: `· $40.10 this month`. */
export function monthWords(spent: number): string {
  return `· $${spent.toFixed(2)} this month`;
}

/** What the status bar's month means, on hover. */
export const MONTH_TITLE = 'spent by every agent this month, from the 1st, in local time';

/** A budget as the Settings field says it: empty is none. Why not, or null. */
export function budgetProblem(v: string): string | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? null : 'Dollars, more than 0.';
}

/**
 * A project's monthly budget as its Fleet card's edit form sends it (Amendment 182): undefined
 * when the field says what the project has (nothing to send), null when it was emptied (none),
 * dollars otherwise, or why not.
 */
export function monthlyDraft(draft: string, current: number | null | undefined): { send: number | null | undefined } | { problem: string } {
  const problem = budgetProblem(draft);
  if (problem !== null) return { problem };
  const next = draft.trim() === '' ? null : Number(draft);
  return { send: next === (current ?? null) ? undefined : next };
}

// ── the fleet's month set to the AI gateway's (Amendment 206) ───────────────

/** The status bar's mark beside a month that is corrected. */
export const MONTH_CORRECTED_MARK = '*';

/** A correction's dollars with their sign: `+$12.40`, `−$3.00`. */
export function signedMoney(usd: number): string {
  return `${usd < 0 ? '−' : '+'}$${Math.abs(usd).toFixed(2)}`;
}

/** What the mark says on hover: `corrected +$12.40 to match the AI gateway, set 9 Nov 14:05`. */
export function monthCorrectionTitle(c: MonthCorrection, now: Date = new Date()): string {
  return `corrected ${signedMoney(c.usd)} to match the AI gateway, set ${fmtStamp(c.at, now)}`;
}

/** A month's hover, and on the line under it what the correction is, when there is one. */
export function monthTitle(base: string, c: MonthCorrection | null, now: Date = new Date()): string {
  return c === null ? base : `${base}\n${monthCorrectionTitle(c, now)}`;
}

/**
 * The month under Settings' monthly budget: `this month $52.40`, and with a correction
 * `this month $52.40 (corrected +$12.40 from $40.00 counted, set 9 Nov 14:05)`. What was counted
 * is the month less the correction, so it is what Conductor has counted by now.
 */
export function monthCorrectionWords(costMonth: number, c: MonthCorrection | null, now: Date = new Date()): string {
  const month = `this month $${costMonth.toFixed(2)}`;
  if (c === null) return month;
  const counted = Math.max(0, costMonth - c.usd);
  return `${month} (corrected ${signedMoney(c.usd)} from $${counted.toFixed(2)} counted, set ${fmtStamp(c.at, now)})`;
}

/** Under the tables by provider, while the fleet's month is corrected: they are not. */
export function providerCorrectionNote(c: MonthCorrection): string {
  return `The fleet's month is corrected ${signedMoney(c.usd)} to match the gateway; the rows below are as counted.`;
}

/** The gateway's figure as typed (`52.40`, `$1,052.40`): the dollars, or why not. */
export function gatewayDraft(draft: string): { gatewayUsd: number } | { problem: string } {
  const t = draft.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n) || n < 0 || n > MONTH_CORRECTION_MAX) {
    return { problem: `The gateway's figure for this month, in dollars from 0 up to ${MONTH_CORRECTION_MAX.toLocaleString('en-US')}.` };
  }
  return { gatewayUsd: n };
}

// ── a monthly budget by provider (Amendment 188) ──────────────────────────────

/**
 * An engine's or a Claude route's monthly budget as its Settings row sends it: dollars as the
 * fleet's field takes them (`budgetProblem`), tokens as an agent's token budget does (`500k`,
 * `2M`, `parseTokens`). Null is none, from an emptied field; or why not.
 */
export function providerBudgetDraft(draft: string, unit: BudgetUnit): { value: number | null } | { problem: string } {
  if (unit === 'usd') {
    const problem = budgetProblem(draft);
    return problem !== null ? { problem } : { value: draft.trim() === '' ? null : Number(draft.trim()) };
  }
  const t = parseTokens(draft);
  if ('why' in t) return { problem: t.why };
  if (t.cap !== null && t.cap > PROVIDER_BUDGET_MAX.tokens) return { problem: `Tokens, up to ${PROVIDER_BUDGET_MAX.tokens.toLocaleString('en-US')}.` };
  return { value: t.cap };
}

/** The setting after one row's change: the object with `key` set, or taken out; null when none is left. */
export function withProviderBudget(raw: string | null, key: string, value: number | null): string | null {
  const next = { ...parseProviderBudgets(raw) };
  if (value === null) delete next[key];
  else next[key] = value;
  return Object.keys(next).length === 0 ? null : JSON.stringify(next);
}

/** A figure in a budget's unit: `$4.27`, `1.2M tokens`. */
export function unitWords(n: number, unit: BudgetUnit): string {
  return unit === 'usd' ? `$${n.toFixed(2)}` : `${tokenWords(n)} tokens`;
}

/** A row's month: `$4.27 this month`, or against its budget, `1.2M tokens of 5M tokens this month · 24%`. */
export function providerMonthWords(spent: number, budget: number | null, unit: BudgetUnit): string {
  if (budget === null) return `${unitWords(spent, unit)} this month`;
  const pct = Math.floor((spent / budget) * 100);
  return `${unitWords(spent, unit)} of ${unitWords(budget, unit)} this month · ${pct}%${spent >= budget ? ', over' : ''}`;
}

// ── today and in total (Amendment 146) ─────────────────────────────────────────

/** One figure in its unit: dollars, or tokens where the engine reports no dollars. */
function figure(usd: number, tokens: number, dollars: boolean): string {
  return dollars ? `$${usd.toFixed(2)}` : `${tokenWords(tokens)} tok`;
}

/**
 * A project's figures, **today $a · month $c · total $b** (Amendment 146; the month, Amendment
 * 182). Dollars; tokens beside them where its agents ran on engines that report only tokens
 * (`today $1.20 + 3k tok · total …`), and tokens alone where nothing reported dollars. `month` is
 * undefined when the daemon said no month (one from before Amendment 182), and then it is left out.
 */
export function projectPairWords(
  p: Pick<ProjectSpend, 'today' | 'total' | 'tokensToday' | 'tokensTotal' | 'month' | 'tokensMonth'>,
): {
  today: string;
  month: string | undefined;
  total: string;
} {
  const usd = p.total > 0 || p.tokensTotal === 0;
  const tok = p.tokensTotal > 0;
  const one = (d: number, t: number): string =>
    usd && tok ? `${figure(d, t, true)} + ${figure(d, t, false)}` : figure(d, t, usd);
  return {
    today: `today ${one(p.today, p.tokensToday)}`,
    month: p.month === undefined ? undefined : `month ${one(p.month, p.tokensMonth ?? 0)}`,
    total: `total ${one(p.total, p.tokensTotal)}`,
  };
}

/**
 * One project's spend, from what the daemon said (`Snapshot.projectSpend`). A daemon from before
 * Amendment 146 says nothing; then it is read from the project's current agents, as it was:
 * their lifetime `costUsd` and today's `spentToday`, which lose what removed agents spent.
 */
export function projectSpendOf(
  list: readonly ProjectSpend[] | null,
  projectId: string,
  agents: readonly Pick<Agent, 'projectId' | 'provider' | 'costUsd' | 'inputTokens' | 'outputTokens' | 'spentToday'>[],
  today: string = localDayOf(),
): ProjectSpend {
  const said = list?.find((p) => p.projectId === projectId);
  if (said) return said;
  const out: ProjectSpend = { projectId, today: 0, total: 0, tokensToday: 0, tokensTotal: 0 };
  for (const a of agents) {
    if (a.projectId !== projectId) continue;
    const t = spentOn(a, today);
    out.today += t.usd;
    out.total += a.costUsd;
    out.tokensToday += t.tokens;
    // Claude's token columns are its last run's, not its life's (Amendment 129); its dollars are.
    if (a.provider !== undefined && a.provider !== 'claude') out.tokensTotal += a.inputTokens + a.outputTokens;
  }
  return out;
}

/**
 * An agent's pair: what it spent today (what its budget reads) and over its whole life
 * (`costUsd`). In dollars, or in tokens on an engine that reports none (`capabilitiesOf(…).costUsd`),
 * where the lifetime is its input plus output tokens.
 */
export function agentPairWords(
  agent: Pick<Agent, 'costUsd' | 'inputTokens' | 'outputTokens' | 'spentToday'>,
  dollars: boolean,
  today: string = localDayOf(),
): { today: string; total: string } {
  const t = spentOn(agent, today);
  return {
    today: `today ${figure(t.usd, t.tokens, dollars)}`,
    total: `total ${figure(agent.costUsd, agent.inputTokens + agent.outputTokens, dollars)}`,
  };
}
