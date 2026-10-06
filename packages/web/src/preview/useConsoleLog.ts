/**
 * Track D's console log source.
 *
 * TRACK D OWNS THIS FILE.
 *
 * Two sources have to be stitched together, and getting this wrong shows up as
 * either an empty pane or doubled lines:
 *
 *  • HISTORY. A fresh page load has no events — the snapshot carries entities,
 *    not the log — so anything captured before the reload has to come from
 *    `GET /api/jobs/:jobId/console`.
 *  • LIVE. Everything after that arrives as `console` events over the feed, the
 *    same way every other screen gets every other fact.
 *
 * The seam is the event cursor: we note the store's `seq` at the moment history
 * is fetched, and take only live events strictly after it. Filtering by
 * timestamp or by text instead would either drop a genuine repeat or duplicate
 * one, because the same error really can occur twice in the same millisecond.
 */

import { useEffect, useRef, useState } from 'react';
import type { ConsoleEntry, ConsoleLogResponse } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { useJobEvents, useStatusBar } from '../lib/store.js';

export interface ConsoleLog {
  entries: ConsoleEntry[];
  errorCount: number;
  warnCount: number;
  /** True once the history fetch has resolved, so the pane can say "…". */
  loaded: boolean;
  clear: () => Promise<void>;
  reload: () => void;
}

/** Keep the pane bounded; the daemon keeps the durable copy. */
const MAX_LINES = 600;

export function useConsoleLog(jobId: string | null): ConsoleLog {
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  const { seq } = useStatusBar();
  // Read through a ref so changing `seq` doesn't re-trigger the fetch effect —
  // it changes on every event, which would refetch history continuously.
  const seqRef = useRef(seq);
  seqRef.current = seq;

  useEffect(() => {
    if (jobId === null) {
      setHistory([]);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    // Take the cursor BEFORE the request, so an event that lands mid-flight is
    // picked up live rather than falling through the gap.
    const at = seqRef.current;
    void api<ConsoleLogResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/console?limit=${MAX_LINES}`,
    )
      .then((res) => {
        if (cancelled) return;
        setHistory(res.entries);
        setCursor(at);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // No daemon, or no console yet. An empty pane is the right answer.
        setHistory([]);
        setCursor(at);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, nonce]);

  const events = useJobEvents(jobId);
  const live: ConsoleEntry[] = [];
  for (const event of events) {
    if (event.seq <= cursor) continue;
    if (event.payload.kind !== 'console') continue;
    live.push({ level: event.payload.level, text: event.payload.text, at: event.ts });
  }

  const entries = [...history, ...live].slice(-MAX_LINES);

  return {
    entries,
    errorCount: entries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0),
    warnCount: entries.reduce((n, e) => (e.level === 'warn' ? n + 1 : n), 0),
    loaded,
    clear: async () => {
      if (jobId === null) return;
      await api(`/api/jobs/${encodeURIComponent(jobId)}/console`, { method: 'DELETE' }).catch(
        () => undefined,
      );
      setHistory([]);
      setCursor(seqRef.current);
    },
    reload: () => setNonce((n) => n + 1),
  };
}
