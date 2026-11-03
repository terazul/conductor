/**
 * What a set of agents' statuses read as, rolled up.  (Amendment 192; its own file since Amendment 194)
 *
 * In lib/store.ts until the navigator's tree (shell/navtree.ts, pure) needed it too: the store
 * re-exports it, and its hooks still use it. No React and no store here.
 */

import type { Agent, AgentStatus, Alert } from '@conductor/shared';

/**
 * The statuses a rollup reads (Amendment 192): an agent paused while it waits in its provider's
 * outage (named in an outage alert, one that counts `waiting`) is still at work, so its job and
 * project read as running. Its own row still says paused, waiting for the model.
 */
export function rollupStatuses(agents: readonly Pick<Agent, 'id' | 'status'>[], alerts: readonly Pick<Alert, 'kind' | 'waiting' | 'agentIds'>[]): AgentStatus[] {
  const waiting = new Set(alerts.filter((a) => a.kind === 'connection' && a.waiting !== undefined).flatMap((a) => a.agentIds));
  return agents.map((a) => (a.status === 'paused' && waiting.has(a.id) ? 'working' : a.status));
}
