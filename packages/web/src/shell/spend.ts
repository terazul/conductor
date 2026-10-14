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

import { localDayOf, spentOn, type Agent, type ProjectSpend } from '@conductor/shared';
import { tokenWords } from '../lib/providers.js';

export const DAILY_KEY = 'conductor.dailyBudget';
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

/** A budget as the Settings field says it: empty is none. Why not, or null. */
export function budgetProblem(v: string): string | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? null : 'Dollars, more than 0.';
}

// ── today and in total (Amendment 146) ─────────────────────────────────────────

/** The status bar's total, after today's figure: `· $12.40 total`. */
export function totalWords(total: number): string {
  return `· $${total.toFixed(2)} total`;
}

/** What the status bar's total means, on hover. */
export const TOTAL_TITLE = 'spent by every agent since Conductor started counting, kept when agents are removed';

/** One figure in its unit: dollars, or tokens where the engine reports no dollars. */
function figure(usd: number, tokens: number, dollars: boolean): string {
  return dollars ? `$${usd.toFixed(2)}` : `${tokenWords(tokens)} tok`;
}

/**
 * A project's pair, **today $a · total $b** (Amendment 146). Dollars; tokens beside them where
 * its agents ran on engines that report only tokens (`today $1.20 + 3k tok · total …`), and
 * tokens alone where nothing reported dollars.
 */
export function projectPairWords(p: Pick<ProjectSpend, 'today' | 'total' | 'tokensToday' | 'tokensTotal'>): {
  today: string;
  total: string;
} {
  const usd = p.total > 0 || p.tokensTotal === 0;
  const tok = p.tokensTotal > 0;
  const one = (d: number, t: number): string =>
    usd && tok ? `${figure(d, t, true)} + ${figure(d, t, false)}` : figure(d, t, usd);
  return { today: `today ${one(p.today, p.tokensToday)}`, total: `total ${one(p.total, p.tokensTotal)}` };
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
