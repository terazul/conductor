/**
 * Submitting a decision, honestly.
 *
 * Track E owns this file.
 *
 * The rule this file exists to enforce: **the UI never implies an agent is
 * unblocked before the daemon says so.** A request leaves the queue when a
 * `resolved` event arrives and the store drops it from `pending` — never because
 * we optimistically hid it.
 *
 * So a submitted request stays visible, marked `sent`, until the daemon confirms.
 * If the POST fails — including the 404 we expect until Track A ships
 * `/api/requests/:requestId/decide` — the card says so and stays answerable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Decision, DecideRequest, PendingRequest } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { errorText } from '../lib/errors.js';

export type SubmitPhase = 'idle' | 'submitting' | 'sent' | 'error';

export interface SubmitState {
  phase: SubmitPhase;
  /** What we sent, so the card can say "denied — waiting for confirmation". */
  decision?: Decision;
  /** Present on 'error'. Shown verbatim; guessing helps nobody here. */
  message?: string;
}

const IDLE: SubmitState = { phase: 'idle' };

export interface Decisions {
  stateOf: (requestId: string) => SubmitState;
  submit: (requestId: string, decision: Decision) => Promise<boolean>;
  /** Clear an error so the user can try a different answer. */
  reset: (requestId: string) => void;
  /** requestIds that have been sent and are awaiting the daemon's confirmation. */
  awaiting: ReadonlySet<string>;
}

export function useDecisions(pending: readonly PendingRequest[]): Decisions {
  const [states, setStates] = useState<ReadonlyMap<string, SubmitState>>(new Map());

  // Forget requests the daemon has confirmed and removed. Without this the map
  // would grow for the lifetime of the tab.
  const liveIds = pending.map((p) => p.requestId).join('\u0000');
  useEffect(() => {
    const live = new Set(liveIds.split('\u0000').filter((s) => s.length > 0));
    setStates((prev) => {
      let changed = false;
      const next = new Map<string, SubmitState>();
      for (const [id, st] of prev) {
        if (live.has(id)) next.set(id, st);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [liveIds]);

  const put = useCallback((requestId: string, st: SubmitState) => {
    setStates((prev) => new Map(prev).set(requestId, st));
  }, []);

  // Guards against a double-fire from a key repeat submitting twice.
  const inFlight = useRef<Set<string>>(new Set());

  const submit = useCallback(
    async (requestId: string, decision: Decision): Promise<boolean> => {
      if (inFlight.current.has(requestId)) return false;
      inFlight.current.add(requestId);
      put(requestId, { phase: 'submitting', decision });

      const body: DecideRequest = { decision };
      try {
        await api<unknown>(`/api/requests/${encodeURIComponent(requestId)}/decide`, {
          method: 'POST',
          body,
        });
        put(requestId, { phase: 'sent', decision });
        return true;
      } catch (err) {
        put(requestId, {
          phase: 'error',
          decision,
          message: errorText(err),
        });
        return false;
      } finally {
        inFlight.current.delete(requestId);
      }
    },
    [put],
  );

  const reset = useCallback(
    (requestId: string) => {
      put(requestId, IDLE);
    },
    [put],
  );

  const stateOf = useCallback(
    (requestId: string): SubmitState => states.get(requestId) ?? IDLE,
    [states],
  );

  // Memoised so the identity is stable between store ticks. The keyboard
  // handler's dependencies hang off this; a fresh Set every second would
  // re-register the window listener on every clock tick.
  const awaiting = useMemo(() => {
    const set = new Set<string>();
    for (const [id, st] of states) {
      if (st.phase === 'submitting' || st.phase === 'sent') set.add(id);
    }
    return set;
  }, [states]);

  return useMemo(
    () => ({ stateOf, submit, reset, awaiting }),
    [stateOf, submit, reset, awaiting],
  );
}

/** Past-tense wording for a decision we've sent but the daemon hasn't confirmed. */
export function decisionVerb(decision: Decision | undefined): string {
  switch (decision?.type) {
    case 'allow_once':
      return 'allowed once';
    case 'allow_always':
      return 'allowed for the session';
    case 'allow_edited':
      return 'allowed with an edited command';
    case 'deny':
      return 'denied';
    case 'answer':
      return 'answered';
    default:
      return 'answered';
  }
}
