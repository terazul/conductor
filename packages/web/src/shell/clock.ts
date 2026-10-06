/**
 * Reference time, and activity bars.  TRACK B.
 *
 * WHY THIS EXISTS.  Both `sparkline()` and every elapsed-time readout compare
 * event timestamps against "now".  Live, that is wall clock and it is exactly
 * right.  Under `VITE_FIXTURE` the recording carries the timestamps it was
 * generated with (fixtures/generate.mjs pins T0 = 2026-09-21T14:18:00Z), so by
 * the time you open the page the whole session sits outside sparkline's 120s
 * trailing window.  Wall clock would then report every agent as flat-lined and
 * every elapsed time in hours — i.e. it would say "stuck" about an agent that
 * the very same fixture shows working.  A false "stalled" is as misleading as a
 * false amber, so we anchor to the newest event we have actually seen instead.
 *
 * This is NOT a second implementation of the sparkline. Per-agent bars go through
 * `useSparkline(agentId, now?)` — W0 added the `now` seam in Amendment 7 for
 * exactly this — and the job-scoped variant calls the same shared `sparkline()`
 * that hook calls. Live mode passes `undefined`, so production behaviour is the
 * contract, untouched.
 */

import { useEffect, useMemo, useState } from 'react';
import { sparkline, type Event } from '@conductor/shared';
import {
  useAgentEvents,
  useFeedStatus,
  useJobEvents,
  useSparkline,
} from '../lib/store.js';

/** Re-render on an interval so elapsed times tick. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function newestMs(events: readonly Event[], kind?: Event['payload']['kind']): number | null {
  let best: number | null = null;
  for (const e of events) {
    if (kind && e.payload.kind !== kind) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

/**
 * How long an agent has been running, or null when we cannot know.
 *
 * Null is a real answer here. A recorded snapshot with no events (the
 * permission-requests fixture is exactly that) gives us a `startedAt` from
 * months ago and nothing to measure it against; subtracting wall clock would
 * announce that an agent has been working for nine hours. An em dash is true.
 */
export function useElapsedMs(
  startedAt: number | null,
  endedAt: string | null,
  events: readonly Event[],
): number | null {
  const status = useFeedStatus();
  const wall = useNow();

  if (startedAt === null) return null;

  const ended = endedAt ? Date.parse(endedAt) : null;
  if (ended !== null && Number.isFinite(ended)) return Math.max(0, ended - startedAt);

  if (status === 'fixture') {
    const anchor = newestMs(events);
    return anchor === null ? null : Math.max(0, anchor - startedAt);
  }
  return Math.max(0, wall - startedAt);
}

export interface Activity {
  /** Tool calls per 15s bucket, oldest first. */
  bars: number[];
  /** False when nothing ran in the window — the "stuck, not working" signal. */
  moving: boolean;
}

/**
 * Tool-call activity for an agent. `moving: false` means flat bars, which means
 * thinking or stuck — never dress it up as working.
 *
 * The reference clock rides in through `useSparkline`'s `now` parameter, so the
 * bars are still reduced inside the store, off the store's own event map. There
 * is no second copy of this stream anywhere in Track B.
 */
export function useActivity(agentId: string | null): Activity {
  const status = useFeedStatus();
  const events = useAgentEvents(agentId);
  const anchor = useMemo(
    () => (status === 'fixture' ? newestMs(events, 'tool_start') : null),
    [status, events],
  );
  const bars = useSparkline(agentId, anchor ?? undefined);
  return { bars, moving: bars.some((n) => n > 0) };
}

/**
 * The same histogram for a whole job — every agent in it.
 *
 * A Fleet card stands for a job, not one agent, so its bars have to be the
 * job's combined tool traffic. There is no job-scoped hook in the store, so
 * this calls the shared `sparkline()` directly; it is the identical function
 * `useSparkline` uses, over the identical event stream, which is what keeps the
 * card and the lanes consistent.
 */
export function useJobActivity(jobId: string | null): Activity {
  const status = useFeedStatus();
  const events = useJobEvents(jobId);
  const wall = useNow(2000);

  const bars = useMemo(() => {
    const anchor = status === 'fixture' ? newestMs(events, 'tool_start') : null;
    return sparkline(events, anchor ?? wall);
  }, [status, events, wall]);

  return { bars, moving: bars.some((n) => n > 0) };
}
