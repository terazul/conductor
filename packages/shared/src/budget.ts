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

// ── a monthly budget for each engine, and for each Claude route (Amendment 188) ──

/**
 * The setting that holds them: a JSON object of key → number. The keys are `claude`,
 * `claude/<route>`, `copilot` and `openrouter`. A key that is missing, or an empty object, is no
 * budget. Each is counted over the local month in its engine's unit, and, like every budget since
 * Amendment 180, it only warns.
 */
export const PROVIDER_BUDGETS_KEY = 'conductor.monthlyBudget.providers';

/**
 * The engines a monthly budget can be set for, and what each one counts. Claude reports dollars;
 * Copilot and OpenRouter report tokens only (input plus output), as their `costUsd: false`
 * capability says.
 */
export const BUDGET_ENGINES = { claude: 'usd', copilot: 'tokens', openrouter: 'tokens' } as const satisfies Record<string, BudgetUnit>;
export type BudgetEngine = keyof typeof BUDGET_ENGINES;

/** The most a budget may be, in each unit. */
export const PROVIDER_BUDGET_MAX: Readonly<Record<BudgetUnit, number>> = { usd: 1_000_000, tokens: 1e12 };

/** A route as a key may name it: what `claudeRoute` can return. */
const ROUTE = /^[a-z0-9_-]{1,40}$/;

/**
 * The route a Claude model goes by: the prefix before `.anthropic.` (`us`, `uk`, `eu`, `apac`,
 * `global`…), or `direct` when there is none. A `[1m]` suffix (or any `[…]`) is ignored. The
 * daemon groups spend by it and the browser names it with it, so this is the one place it's decided.
 * What is stored is the model; the route is read from it.
 */
export function claudeRoute(model: string): string {
  const m = model.trim().replace(/\[[^\]]*\]$/, '').toLowerCase();
  const at = m.indexOf('.anthropic.');
  // An inference-profile ARN ends in the model id: the route is the part after its last `/`.
  const prefix = at > 0 ? (m.slice(0, at).split('/').pop() ?? '') : '';
  return ROUTE.test(prefix) && prefix !== 'direct' ? prefix : 'direct';
}

/** The setting's key for an engine, or for one of Claude's routes. */
export function providerBudgetKey(provider: BudgetEngine, route?: string): string {
  return route === undefined ? provider : `${provider}/${route}`;
}

/** What a key's budget counts, or null when the key names no engine (or a route outside Claude). */
export function providerBudgetUnit(key: string): BudgetUnit | null {
  const [engine, route, more] = key.split('/');
  if (more !== undefined || !engine || !Object.hasOwn(BUDGET_ENGINES, engine)) return null;
  if (route !== undefined && (engine !== 'claude' || !ROUTE.test(route))) return null;
  return BUDGET_ENGINES[engine as BudgetEngine];
}

const ENGINE_NAMES: Readonly<Record<BudgetEngine, string>> = { claude: 'Claude', copilot: 'Copilot', openrouter: 'OpenRouter' };

/** A key as it is said: "Claude", "Claude · us", "Claude · no prefix", "Copilot", "OpenRouter". */
export function providerBudgetLabel(key: string): string {
  const [engine, route] = key.split('/');
  const name = ENGINE_NAMES[engine as BudgetEngine] ?? engine ?? key;
  return route === undefined ? name : `${name} · ${route === 'direct' ? 'no prefix' : route}`;
}

/** Why `n` can't be a budget in `unit`, or null when it can. */
export function providerBudgetValueProblem(n: unknown, unit: BudgetUnit): string | null {
  const max = PROVIDER_BUDGET_MAX[unit];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max
    ? null
    : `${unit === 'usd' ? 'dollars' : 'tokens'}, more than 0 and up to ${max.toLocaleString('en')}`;
}

/** Why the setting's value can't be stored, or null when it can: the daemon's rule, and the page's. */
export function providerBudgetsProblem(raw: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    v = undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'a JSON object of budgets, such as {"claude": 100, "copilot": 5000000}';
  for (const [key, n] of Object.entries(v)) {
    const unit = providerBudgetUnit(key);
    if (unit === null) return `${JSON.stringify(key).slice(0, 60)}: not an engine (claude, claude/<route>, copilot or openrouter)`;
    const why = providerBudgetValueProblem(n, unit);
    if (why) return `${key}: ${why}`;
  }
  return null;
}

/**
 * The budgets the setting holds, key → number. Unreadable, missing or empty is none; an entry that
 * isn't a budget is left out, so a value written by hand can't put a wrong one in front of you.
 */
export function parseProviderBudgets(raw: string | undefined | null): Record<string, number> {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(v)) {
    const unit = providerBudgetUnit(key);
    if (unit !== null && providerBudgetValueProblem(n, unit) === null) out[key] = n as number;
  }
  return out;
}
