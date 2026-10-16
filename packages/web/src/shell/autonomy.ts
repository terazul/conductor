/**
 * Reading an agent's autonomy.  TRACK B.
 *
 * `Agent.autonomy` is a required field on the shared type as of Amendment 7, so
 * this reads it directly — the defensive shape-validation that used to live here
 * is gone. What remains are the two derivations the UI needs: what a tool will
 * actually do, and what spend it is warned about (a budget pauses nothing, Amendment 180).
 */

import { agentBudget, capState, type Agent, type Autonomy, type BudgetState } from '@conductor/shared';
import { tokenWords } from '../lib/providers.js';
import { toneOf, type SpendTone } from './spend.js';

export type ToolPolicy = 'denied' | 'asks' | 'allowed';

/**
 * A rule naming the whole tool — `'Bash'` — as opposed to a scoped one.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS TO MAKE. `'Bash(git push:*)'` and `'Bash'` are not
 * the same claim: the first is about one command, the second is about the tool. Both start
 * with `Bash`, and treating them alike is what made the inspector report bash as **denied**
 * for an agent that had bash — because "never push" puts `Bash(git push:*)` in
 * `disallowedTools`, and a prefix test read that as the whole tool being off.
 */
const namesWholeTool = (rules: readonly string[], tool: string): boolean =>
  rules.some((r) => r === tool);

/** Rules that constrain PART of a tool: `Bash(git push:*)` for `Bash`. */
export function scopedRules(rules: readonly string[], tool: string): string[] {
  return rules.filter((r) => r.startsWith(`${tool}(`));
}

/**
 * Whether a tool will stop and ask before running.
 *
 * Three states, decided only by rules naming the tool ITSELF:
 *  • denied  — `disallowedTools` names the tool. It is removed from the agent's context
 *              and survives every permission mode; this is the real safety net.
 *  • allowed — auto-approved before `canUseTool` is consulted.
 *  • asks    — the default, and the one the attention queue is built on. An explicit
 *              allow-list that omits the tool means it has to ask. ABSENT IS NOT DENIED.
 *
 * Scoped rules are exceptions within whichever of those three applies, and callers report
 * them separately via `scopedRules` — folding them into the headline is what produced a
 * confident one-word answer that was wrong.
 */
export function toolPolicy(autonomy: Autonomy, tool: string): ToolPolicy {
  if (namesWholeTool(autonomy.disallowedTools, tool)) return 'denied';
  if (autonomy.mode === 'bypassPermissions' || autonomy.mode === 'dontAsk') return 'allowed';
  if (autonomy.allowedTools.length === 0) return 'asks';
  return namesWholeTool(autonomy.allowedTools, tool) ? 'allowed' : 'asks';
}

export interface Budget {
  /** What it spent today, in `unit`. */
  spent: number;
  /** The daily budget: what the agent may spend today before it is warned (Amendments 124, 129). */
  cap: number;
  /** `spent / cap`, held at 1 once it is full: the bar never overflows. */
  fraction: number;
  /** `spent / cap` as a whole percent, past 100 when it is over. */
  pct: number;
  /** ok under the budget, over from it. */
  state: BudgetState;
  /**
   * The colour it reads in: the status bar's daily meter's thresholds and tokens
   * (Amendment 125), green, yellow from 75%, red from 95% and so from the budget on.
   */
  tone: SpendTone;
  /** At or past the budget. A warning, never a stop (Amendment 180). */
  over: boolean;
  /**
   * What `spent` and `cap` count (Amendment 80): dollars, or input plus output tokens for
   * an engine that can't say what a run cost (`Autonomy.budgetTokens`, Amendment 77).
   */
  unit: 'usd' | 'tokens';
}

/**
 * Today's spend against the daily budget that will warn about this agent (Amendments 124, 129);
 * nothing stops it (Amendment 180). `spent` is what it spent on `today` (the local day of
 * this browser unless the caller says): an agent whose day stamp is older reads 0, so a page
 * left open past midnight shows today's spend back at zero before the daemon pushes anything. The
 * agent's lifetime `costUsd` is not read here.
 *
 * Deliberately NOT a context-window percentage: CONTRACT §8 leaves that open
 * because it cannot yet be derived honestly, and "a misleading percentage is
 * worse than none". Budget is a real number with a real warning, so the
 * meter measures that and the tokens are reported as tokens.
 *
 * The agent's own budget only. It used to fall back to the job's, but an uncapped agent
 * also uncaps its job (the daemon's `jobCap`), so no job figure ever warns about it and a
 * bar measuring one would be measuring nothing.
 */
export function budgetOf(agent: Pick<Agent, 'spentToday' | 'autonomy'>, today?: string): Budget | null {
  const b = agentBudget(agent, today);
  if (b === null || b.budget <= 0) return null;
  return budgetFigures(b.spent, b.budget, b.unit);
}

function budgetFigures(spent: number, cap: number, unit: Budget['unit']): Budget {
  const ratio = spent / cap;
  const state = capState(spent, cap);
  return {
    spent,
    cap,
    fraction: Math.min(1, ratio),
    pct: Math.round(ratio * 100),
    state,
    tone: toneOf(ratio),
    over: state !== 'ok',
    unit,
  };
}

/**
 * A job's meter in the navigator (Amendment 140): what its agents with a budget spent today
 * against the sum of their budgets, in the same tones as each agent's (`toneOf`). Null when
 * none of them has a budget. Dollars when any budget is in dollars, and then only those: a
 * token figure added to dollars would be no figure at all. Only a picture of the agents'
 * own budgets, not the daemon's job budget (`jobCap`), which an uncapped agent lifts.
 */
export function sumBudgets(budgets: readonly (Budget | null)[]): Budget | null {
  const have = budgets.filter((b): b is Budget => b !== null);
  if (have.length === 0) return null;
  const unit: Budget['unit'] = have.some((b) => b.unit === 'usd') ? 'usd' : 'tokens';
  const same = have.filter((b) => b.unit === unit);
  return budgetFigures(
    same.reduce((n, b) => n + b.spent, 0),
    same.reduce((n, b) => n + b.cap, 0),
    unit,
  );
}

/** A budget figure in its own unit: `$50.00`, `1M tokens`. Tokens never read as dollars. */
export function budgetWords(unit: Budget['unit'], n: number): string {
  return unit === 'tokens' ? `${tokenWords(n)} tokens` : `$${n.toFixed(2)}`;
}

/** The one-click raises beside the budget field. Raising is the common case. */
export const BUDGET_RAISES: readonly number[] = [10, 25];

/** The same for a budget in tokens (Amendment 124): the engines that can't say dollars have no +$10. */
export const TOKEN_RAISES: readonly number[] = [100_000, 500_000];

/**
 * What was typed in the budget field. Empty is "no cap"; `$` is allowed because people
 * type it. Zero and negatives are refused rather than sent — the daemon stores anything
 * not above zero as NO cap, so "0" meaning "stop now" would silently mean the opposite.
 */
export function parseBudget(text: string): { cap: number | null } | { why: string } {
  const t = text.trim().replace(/^\$\s*/, '');
  if (t === '') return { cap: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { why: `"${text.trim()}" is not an amount — type dollars, like 25.` };
  if (n <= 0) return { why: 'A budget has to be more than $0. Clear the field for no cap.' };
  return { cap: Math.round(n * 100) / 100 };
}
