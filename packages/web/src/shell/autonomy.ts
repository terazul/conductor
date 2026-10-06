/**
 * Reading an agent's autonomy.  TRACK B.
 *
 * `Agent.autonomy` is a required field on the shared type as of Amendment 7, so
 * this reads it directly — the defensive shape-validation that used to live here
 * is gone. What remains are the two derivations the UI needs: what a tool will
 * actually do, and what spend will actually pause the agent.
 */

import type { Agent, Autonomy } from '@conductor/shared';

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
  spent: number;
  cap: number;
  fraction: number;
  over: boolean;
  /**
   * What `spent` and `cap` count (Amendment 80): dollars, or input plus output tokens for
   * an engine that can't say what a run cost (`Autonomy.budgetTokens`, Amendment 77).
   */
  unit: 'usd' | 'tokens';
}

/**
 * Spend against the cap that will actually pause this agent.
 *
 * Deliberately NOT a context-window percentage: CONTRACT §8 leaves that open
 * because it cannot yet be derived honestly, and "a misleading percentage is
 * worse than none". Budget is a real number with a real consequence, so the
 * meter measures that and the tokens are reported as tokens.
 *
 * The agent's own cap only. It used to fall back to the job's, but an uncapped agent
 * also uncaps its job (the daemon's `jobCap`), so no job figure ever pauses it and a
 * bar measuring one would be measuring nothing.
 */
export function budgetOf(agent: Agent): Budget | null {
  const cap = agent.autonomy.budgetUsd;
  if (cap !== null && cap > 0) {
    const fraction = Math.min(1, agent.costUsd / cap);
    return { spent: agent.costUsd, cap, fraction, over: agent.costUsd >= cap, unit: 'usd' };
  }
  // A token cap is the daemon's count too: input plus output, reached at ≥.
  const tokens = agent.autonomy.budgetTokens ?? null;
  if (tokens === null || tokens <= 0) return null;
  const spent = agent.inputTokens + agent.outputTokens;
  return { spent, cap: tokens, fraction: Math.min(1, spent / tokens), over: spent >= tokens, unit: 'tokens' };
}

/** The one-click raises beside the budget field. Raising is the common case. */
export const BUDGET_RAISES: readonly number[] = [10, 25];

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
