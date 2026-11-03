/**
 * Waiting to be tried again, on the Agent screen.  Amendment 123.
 *
 * When the model can't be reached the daemon keeps the agent `queued` for 5 s, 15 s, 30 s,
 * 60 s and 5 min (by default; `conductor.retryDelays`, Amendment 140), trying again after each. Its last status event carries the wait, and the
 * line is worked out from that, here, so it can be checked without a browser.
 *
 * Once the short tries are spent it is paused, waiting for the model to come back (Amendment 192),
 * and the same bar says so, with retry now (a check of its provider now) and stop waiting.
 */

import { RETRY_CARD_FROM, type Agent, type Event } from '@conductor/shared';
import { reconnectLine, reconnectingNow, retryHead, waitingForModel } from '../shell/describe.js';
import { providerLabel } from '../lib/providers.js';

export interface ReconnectBar {
  /** "Reconnecting in 30 s (3 of 5)". */
  text: string;
  /** What is wrong, in the words the outage card uses. */
  why: string;
  attempt: number;
  of: number;
  /** Amber, from the first retry: Needs You has the card too (Amendment 140). */
  needs: boolean;
  /** Paused, waiting for the model to come back (Amendment 192): its buttons say stop waiting. */
  waiting: boolean;
}

/** The banner for an agent that is waiting to be tried again, or null when it is not. */
export function reconnectBar(agent: Pick<Agent, 'status'>, events: readonly Event[], now: number): ReconnectBar | null {
  if (agent.status === 'paused') {
    const wait = waitingForModel(events);
    if (!wait) return null;
    return {
      text: `Waiting for ${providerLabel(wait.provider)} to come back`,
      why: `${retryHead({ cause: wait.cause, httpStatus: null })} — it carries on by itself when it answers`,
      attempt: 0,
      of: 0,
      needs: true,
      waiting: true,
    };
  }
  if (agent.status !== 'queued') return null;
  const r = reconnectingNow(events);
  if (!r) return null;
  return {
    text: reconnectLine(r, now),
    why: retryHead({ cause: r.cause, httpStatus: null }),
    attempt: r.attempt,
    of: r.of,
    // Amber from the first retry, as Needs You has the card (Amendment 140; it was the second).
    needs: r.attempt >= RETRY_CARD_FROM,
    waiting: false,
  };
}
