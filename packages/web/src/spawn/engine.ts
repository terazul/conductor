/**
 * Launching on an engine that isn't Claude (Amendment 80).  Screen 7.
 *
 * Spawn builds every launch the way it always has — `toAgentSpecs` — and this turns
 * those specs into ones for the chosen engine. For Claude it hands back the very same
 * array, so a Claude launch sends exactly what it sent before. For any other engine:
 *  - each spec names the provider, and runs on the one model id picked for the launch
 *    (free-form, from that engine's list — Amendment 78);
 *  - the budget is in tokens where the engine reports no dollars (Amendment 77). A
 *    dollar figure is never sent there: the daemon refuses one rather than run uncapped;
 *  - what the engine can't do is left out rather than sent to do nothing: effort, helpers,
 *    and plan mode, which becomes "ask me" — still nothing done unasked.
 *
 * Pure, so spawn/verify.ts checks it under Node.
 */

import type { AgentSpec, Autonomy } from '@conductor/shared';
import { CLAUDE, offersMode, type Capabilities } from '../lib/providers.js';

export interface EngineLaunch {
  provider: string;
  caps: Capabilities;
  /** The exact id every agent of the launch runs on. Unused for Claude, whose rows pick their own. */
  model: string;
  /** Tokens per agent, input plus output, for an engine without dollars. Null is uncapped. */
  budgetTokens: number | null;
}

/**
 * Each agent's lifetime cap in tokens, unless you say otherwise. A cap rather than none,
 * as the dollar default is: an engine whose spend can't be seen in dollars is the last
 * one to leave unbounded.
 */
export const DEFAULT_BUDGET_TOKENS = 5_000_000;

/** The mode a launch sends: plan mode, on an engine without it, asks you instead. */
export function modeOn(mode: Autonomy['mode'], caps: Capabilities): Autonomy['mode'] {
  return offersMode(mode, caps) ? mode : 'default';
}

/** One agent's autonomy on the engine. Claude's is returned as it is. */
export function autonomyOn(a: Autonomy, l: EngineLaunch): Autonomy {
  if (l.provider === CLAUDE) return a;
  const { effort, budgetTokens: _dropped, ...rest } = a;
  return {
    ...rest,
    mode: modeOn(a.mode, l.caps),
    ...(l.caps.costUsd
      ? { budgetUsd: a.budgetUsd }
      : { budgetUsd: null, ...(l.budgetTokens !== null ? { budgetTokens: l.budgetTokens } : {}) }),
    ...(l.caps.effort && effort ? { effort } : {}),
  };
}

/** The specs for the engine. Claude's are the same array, untouched. */
export function specsOn(specs: AgentSpec[], l: EngineLaunch): AgentSpec[] {
  if (l.provider === CLAUDE) return specs;
  return specs.map(({ helpers, ...s }) => ({
    ...s,
    model: l.model,
    ...(l.caps.helperTools && helpers ? { helpers } : {}),
    autonomy: autonomyOn(s.autonomy, l),
    provider: l.provider,
  }));
}

/** The job's dollar cap: the agents' caps summed, and none where they aren't in dollars. */
export function jobBudgetUsd(perAgent: number | null, agents: number, caps: Capabilities): number | null {
  return caps.costUsd && perAgent !== null ? perAgent * agents : null;
}
