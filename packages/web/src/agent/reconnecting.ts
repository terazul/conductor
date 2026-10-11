/**
 * Waiting to be tried again, on the Agent screen.  Amendment 123.
 *
 * When the model can't be reached the daemon keeps the agent `queued` for 5 s, 15 s, 30 s,
 * 60 s and 5 min, trying again after each. Its last status event carries the wait, and the
 * line is worked out from that, here, so it can be checked without a browser.
 */

import type { Agent, Event } from '@conductor/shared';
import { reconnectLine, reconnectingNow, retryHead } from '../shell/describe.js';

export interface ReconnectBar {
  /** "Reconnecting in 30 s (3 of 5)". */
  text: string;
  /** What is wrong, in the words the outage card uses. */
  why: string;
  attempt: number;
  of: number;
  /** Amber, from the second retry: Needs You has the card too. */
  needs: boolean;
}

/** The banner for an agent that is waiting to be tried again, or null when it is not. */
export function reconnectBar(agent: Pick<Agent, 'status'>, events: readonly Event[], now: number): ReconnectBar | null {
  if (agent.status !== 'queued') return null;
  const r = reconnectingNow(events);
  if (!r) return null;
  return {
    text: reconnectLine(r, now),
    why: retryHead({ cause: r.cause, httpStatus: null }),
    attempt: r.attempt,
    of: r.of,
    needs: r.attempt >= 2,
  };
}
