/**
 * The Agent screen's tabs: one per agent in the project (Amendment 49). Pure, so
 * agent/verify.ts checks them.
 *
 * Grouped by job, newest job first — the one you just launched is the one you came to —
 * and in each job in the order its agents were made, which is the plan's order. A tab
 * that needs you says so, so a blocked agent isn't hidden behind the one in front. An
 * over-budget warning counts for its tab but does not stop it reading as it is: the agent
 * is working, and only the budget needs you (Amendment 124).
 */

import type { Agent, AgentStatus } from '@conductor/shared';
import { budgetOf, type Budget } from '../shell/autonomy.js';

export interface AgentTab {
  id: string;
  label: string;
  /** What the dot shows: blocked when something waits on you, whatever the row says. */
  status: AgentStatus;
  /** Requests and alerts waiting on you, for this agent. */
  needs: number;
  /** The first tab of a job that isn't the first job: where a divider goes. */
  newJob: boolean;
  /**
   * How full its budget is, in the colours of the status bar's daily meter (Amendment 125).
   * Null for an agent with no budget, or when the caller didn't give its spend.
   */
  budget: Pick<Budget, 'tone' | 'fraction' | 'pct' | 'state'> | null;
}

export function agentTabs(
  agents: (Pick<Agent, 'id' | 'projectId' | 'jobId' | 'role' | 'status'> &
    Partial<Pick<Agent, 'costUsd' | 'inputTokens' | 'outputTokens' | 'autonomy'>>)[],
  projectId: string,
  jobOrder: string[],
  pending: { agentId: string }[],
  alerts: { agentIds: string[]; kind?: string }[],
): AgentTab[] {
  const mine = agents.filter((a) => a.projectId === projectId);
  const rank = (jobId: string): number => {
    const i = jobOrder.indexOf(jobId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Stable: agents keep the order they were given in within a job.
  const ordered = mine.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.jobId) - rank(y.a.jobId) || x.i - y.i).map((x) => x.a);

  // A role that appears more than once is numbered, in order, so two builders read apart.
  const total = new Map<string, number>();
  for (const a of ordered) total.set(a.role, (total.get(a.role) ?? 0) + 1);
  const seen = new Map<string, number>();

  return ordered.map((a, i) => {
    const n = (seen.get(a.role) ?? 0) + 1;
    seen.set(a.role, n);
    const mine = alerts.filter((x) => x.agentIds.includes(a.id));
    const needs = pending.filter((p) => p.agentId === a.id).length + mine.length;
    // What stops it, as opposed to a warning that it is over its budget.
    const stops = needs - mine.filter((x) => x.kind === 'budget_over').length;
    const b = a.autonomy ? budgetOf({ costUsd: a.costUsd ?? 0, inputTokens: a.inputTokens ?? 0, outputTokens: a.outputTokens ?? 0, autonomy: a.autonomy }) : null;
    return {
      id: a.id,
      label: (total.get(a.role) ?? 1) > 1 ? `${a.role} ${n}` : a.role,
      status: stops > 0 ? 'blocked' : a.status,
      needs,
      newJob: i > 0 && a.jobId !== ordered[i - 1]!.jobId,
      budget: b === null ? null : { tone: b.tone, fraction: b.fraction, pct: b.pct, state: b.state },
    };
  });
}
