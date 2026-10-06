/**
 * The feed — WebSocket client with a lossless cursor.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks B–E.
 *
 * Tracks do not talk to this directly; they read `store` (./store.ts). This
 * exists so there is exactly one implementation of the reconnect rule:
 *
 *   open → send {subscribe, since: cursor} → apply frames → on close, retry
 *   with backoff and the SAME cursor. A dropped socket replays; it never
 *   loses state. If the server says `resync`, refetch the snapshot.
 *
 * FIXTURE MODE. Tracks B and E build with no daemon at all:
 *   VITE_FIXTURE=session-basic  → replays fixtures/<name>.jsonl over the store
 * The replay path pushes through the identical reducer, so swapping to the live
 * feed at gate I2 is a config change, not a rewrite.
 */

import type { ClientFrame, ServerFrame, Snapshot } from '@conductor/shared';
import { WS_PATH } from '@conductor/shared';
import { ApiError } from './errors.js';

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'fixture' | 'error';

export interface FeedHandlers {
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: FeedStatus) => void;
}

const MAX_BACKOFF_MS = 5_000;

export class Feed {
  #socket: WebSocket | null = null;
  #cursor = 0;
  #backoff = 250;
  #closed = false;
  #handlers: FeedHandlers;
  /**
   * Re-entrancy guard. Amendment 7.
   *
   * `main.tsx` calls `store.connect()` from a `useEffect`, and under
   * `<StrictMode>` React invokes effects twice in development. Without this,
   * two sockets opened (or two fixture replays ran) concurrently and **every
   * event arrived twice** — which silently doubled `useSparkline()` and
   * `useJobDiffstat()` for every track, and duplicated React keys for anyone
   * keying a list on `seq`. Track B found it by watching two screens disagree
   * about the same diffstat (+212/−20 versus +106/−10).
   *
   * The store is independently idempotent on `seq` as well; this is the fix,
   * that is the belt.
   */
  #started = false;

  constructor(handlers: FeedHandlers) {
    this.#handlers = handlers;
  }

  /** Highest seq applied. Survives reconnects — that's the whole point. */
  get cursor(): number {
    return this.#cursor;
  }

  set cursor(v: number) {
    this.#cursor = Math.max(this.#cursor, v);
  }

  connect(): void {
    if (this.#closed) return;
    // Guard only the initial entry; internal reconnects go via #open().
    if (this.#started) return;
    this.#started = true;
    this.#open();
  }

  #open(): void {
    if (this.#closed) return;

    const fixture = import.meta.env['VITE_FIXTURE'];
    if (fixture) {
      void this.#replayFixture(String(fixture));
      return;
    }

    this.#handlers.onStatus(this.#cursor === 0 ? 'connecting' : 'reconnecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = import.meta.env['VITE_CONDUCTOR_TOKEN'];
    const qs = token ? `?token=${encodeURIComponent(String(token))}` : '';
    const socket = new WebSocket(`${proto}://${location.host}${WS_PATH}${qs}`);
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoff = 250;
      this.#handlers.onStatus('live');
      this.#send({ type: 'subscribe', since: this.#cursor });
    };

    socket.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'events' && frame.events.length > 0) {
        this.cursor = frame.events.at(-1)!.seq;
      } else if (frame.type === 'hello') {
        this.cursor = frame.seq;
      } else if (frame.type === 'resync') {
        void this.#refetchSnapshot();
        return;
      }
      this.#handlers.onFrame(frame);
    };

    socket.onclose = () => {
      this.#socket = null;
      if (this.#closed) return;
      this.#handlers.onStatus('reconnecting');
      setTimeout(() => this.#open(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    };

    socket.onerror = () => this.#handlers.onStatus('error');
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = null;
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  async #refetchSnapshot(): Promise<void> {
    try {
      const res = await fetch('/api/snapshot', { headers: authHeaders() });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snapshot = (await res.json()) as Snapshot;
      this.#cursor = snapshot.seq; // hard reset, not a max()
      this.#handlers.onFrame({ type: 'hello', seq: snapshot.seq, snapshot });
    } catch {
      this.#handlers.onStatus('error');
    }
  }

  /** Replay a recorded session so UI tracks need no daemon. */
  async #replayFixture(name: string): Promise<void> {
    this.#handlers.onStatus('fixture');
    try {
      const res = await fetch(`/fixtures/${name}.jsonl`);
      const text = await res.text();
      const frames = text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ServerFrame);

      for (const frame of frames) {
        if (frame.type === 'events' && frame.events.length > 0) {
          this.cursor = frame.events.at(-1)!.seq;
        }
        this.#handlers.onFrame(frame);
        // Paced so the UI animates like a real session rather than snapping.
        await new Promise((r) => setTimeout(r, 160));
      }
    } catch (err) {
      console.error('[feed] fixture replay failed', err);
      this.#handlers.onStatus('error');
    }
  }
}

export function authHeaders(): Record<string, string> {
  // `?.` so the verify can call api() under node, where there is no Vite to fill env in.
  const token = import.meta.env?.['VITE_CONDUCTOR_TOKEN'];
  return token ? { authorization: `Bearer ${String(token)}` } : {};
}

/** Every track uses this for commands so auth stays in one place. */
export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: {
      ...authHeaders(),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* body wasn't json */
    }
    throw new ApiError(init?.method ?? 'GET', path, res.status, body);
  }
  // No body to read. Parsing one threw, which made every 204 look like a failure.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
