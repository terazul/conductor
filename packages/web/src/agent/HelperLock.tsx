/**
 * A helper's message box, shut (Amendment 209).
 *
 * A helper is started and briefed by its orchestrator, which reads what it did and writes its
 * next brief. A message typed straight to the helper goes round the orchestrator, which then
 * plans on a helper doing something it never asked for. So on a helper's Agent screen the
 * composer is shut, and the line in its place says who directs it, opens that agent, and
 * unlocks the box for this helper until you leave its screen (agent.tsx holds that; nothing
 * is kept). Display only: the daemon still takes a message to a helper, and the transcript,
 * ⏸ and the stop controls are where they were.
 *
 * Here and loading no stylesheet, so lib/verify.ts renders it under Node; `.ag-lock` is in agent.css.
 */

import type { Agent } from '@conductor/shared';

/** The orchestrator that directs `agent`, or null: not a helper, or one whose orchestrator is gone. */
export function directedBy(agent: Pick<Agent, 'parentId'>, agents: readonly Agent[]): Agent | null {
  if (!agent.parentId) return null;
  return agents.find((a) => a.id === agent.parentId) ?? null;
}

/** Whose line takes the composer's place: the orchestrator, unless this is the helper you unlocked. */
export function lockedBy(agent: Pick<Agent, 'id' | 'parentId'>, agents: readonly Agent[], unlocked: string | null): Agent | null {
  return unlocked === agent.id ? null : directedBy(agent, agents);
}

/** What the orchestrator is called where it is named: its name, else its role, as its tab. */
export const orchestratorLabel = (a: Pick<Agent, 'name' | 'role'>): string => a.name || a.role;

export function HelperLock({ orchestrator, onOpen, onUnlock }: { orchestrator: Agent; onOpen: () => void; onUnlock: () => void }) {
  const who = orchestratorLabel(orchestrator);
  return (
    <div className="ag-composer ag-lock" role="note">
      <p className="ag-lock-line">
        <b>{who}</b> directs this helper — message the orchestrator instead
        <span className="ag-lock-sep" aria-hidden="true">·</span>
        <button type="button" className="ag-lock-act" onClick={onOpen} title={`Open ${who}, the agent that briefs this one`}>
          open {who}
        </button>
        <span className="ag-lock-sep" aria-hidden="true">·</span>
        <button type="button" className="ag-lock-act" onClick={onUnlock} title="Type to this helper yourself, until you leave its screen">
          unlock
        </button>
      </p>
    </div>
  );
}
