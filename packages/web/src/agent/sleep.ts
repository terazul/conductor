/**
 * What the ⏸ pause / ▶ resume button says, for an agent's status.  TRACK B.
 * (Amendment 35)
 *
 * Pause is how an agent is put to sleep: its run stops, its slot goes to someone else,
 * and its conversation is kept, so ▶ resume carries on in the same session. Resume
 * waits for a free slot like any launch, so it can say "queued" before it says
 * "working".
 *
 * A blocked agent keeps its question. Pausing it only lets go of the slot it was
 * holding while it waited; the question stays in Needs You, and answering it is what
 * wakes the agent. So for a blocked agent the button says that, rather than promising
 * a pause that would throw the question away.
 *
 * Pure and imports no CSS, so agent/verify.ts checks it under Node (Amendment 9).
 */

import type { AgentStatus } from '@conductor/shared';

export interface SleepControl {
  label: string;
  /** What 'Pausing' or 'Resuming' the busy line says while the call is out. */
  doing: 'Pausing' | 'Resuming';
  action: 'pause' | 'resume';
  title: string;
}

/** Statuses with nothing to pause or resume: the agent has ended. */
const ENDED: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);

export function sleepControl(status: AgentStatus): SleepControl | null {
  if (ENDED.has(status)) return null;
  if (status === 'paused') {
    return {
      label: '▶ resume',
      doing: 'Resuming',
      action: 'resume',
      title: 'Wake it in the same conversation — it waits for a free slot if all are busy',
    };
  }
  return {
    label: '⏸ pause',
    doing: 'Pausing',
    action: 'pause',
    title:
      status === 'blocked'
        ? 'Frees its slot and keeps your question — answering it is what wakes the agent'
        : 'Put it to sleep: frees its slot and keeps the conversation. A tool call still running is stopped',
  };
}
