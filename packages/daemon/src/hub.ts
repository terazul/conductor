/**
 * WebSocket hub — the one place events reach the browser.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks A–E.
 *
 * Two things worth understanding before you use it:
 *
 * 1. COALESCING. Events are buffered and flushed at ~10 Hz. A busy agent can
 *    emit hundreds of events a second; React cannot usefully render that, and
 *    the daemon should never block on a slow socket. Content is never lost —
 *    only timing is smoothed. The `seq` cursor is the correctness guarantee.
 *
 * 2. SNAPSHOT CONTRIBUTORS. A fresh page load needs state the event log doesn't
 *    carry on its own (pending requests, live dev servers). Rather than have
 *    every track edit one shared snapshot function — a guaranteed merge
 *    conflict — each track registers a contributor from its own module:
 *
 *      registerSnapshotContributor(() => ({ pending: arbiter.pending() }));
 *
 *    Call it once during your track's init. Contributions are shallow-merged.
 */

import type { WebSocket } from 'ws';
import type {
  ClientFrame,
  Event,
  ServerFrame,
  Snapshot,
} from '@conductor/shared';
import { slotLimit } from './slots.js';
import { eventLog } from './eventlog.js';

const FLUSH_MS = 100; // ~10 Hz
const REPLAY_LIMIT = 5_000;

type SnapshotContributor = () => Partial<Snapshot>;

const contributors = new Set<SnapshotContributor>();

/**
 * Register a slice of the initial snapshot. Call from your track's init so no
 * two tracks ever edit the same function. Returns an unregister function.
 *
 * Array slices (projects, jobs, agents, pending, servers, alerts) COMPOSE — supply the
 * entities your track knows about and they accumulate with everyone else's,
 * merged by identity. You do not need to know who else contributes.
 *
 * Scalar slices (slots, costToday) are single-owner: last contributor wins, so
 * set them only from the track that owns the number. `seq` is never yours.
 */
export function registerSnapshotContributor(fn: SnapshotContributor): () => void {
  contributors.add(fn);
  return () => contributors.delete(fn);
}

function emptySnapshot(): Snapshot {
  return {
    projects: [],
    jobs: [],
    agents: [],
    pending: [],
    servers: [],
    alerts: [],
    seq: 0,
    slots: { used: 0, total: slotLimit() },
    costToday: 0,
  };
}

/**
 * Merge one array slice by identity.
 *
 * Amendment 2. This used to be a shallow spread, which meant two contributors
 * both supplying `jobs` silently discarded one of them — last registration won,
 * with no error and no log line. Track C found it and registered a deliberate
 * no-op contributor rather than race Track A for the slice.
 *
 * Contributors now COMPOSE: each supplies the entities it knows about and they
 * accumulate. Later contributors still win on a genuine id collision, which is
 * what you want when one owner has fresher state for the same entity.
 */
function mergeBy<T>(existing: T[], incoming: T[] | undefined, key: (x: T) => string): T[] {
  if (!incoming || incoming.length === 0) return existing;
  const map = new Map<string, T>();
  for (const x of existing) map.set(key(x), x);
  for (const x of incoming) map.set(key(x), x);
  return [...map.values()];
}

export function buildSnapshot(): Snapshot {
  const snap = emptySnapshot();

  for (const c of contributors) {
    let slice: Partial<Snapshot>;
    try {
      slice = c();
    } catch (err) {
      console.error('[hub] snapshot contributor threw', err);
      continue;
    }

    // Array slices accumulate by identity — see mergeBy.
    snap.projects = mergeBy(snap.projects, slice.projects, (p) => p.id);
    snap.jobs = mergeBy(snap.jobs, slice.jobs, (j) => j.id);
    snap.agents = mergeBy(snap.agents, slice.agents, (a) => a.id);
    snap.pending = mergeBy(snap.pending, slice.pending, (r) => r.requestId);
    snap.servers = mergeBy(snap.servers, slice.servers, (d) => `${d.jobId}:${d.port}`);
    snap.alerts = mergeBy(snap.alerts, slice.alerts, (a) => a.id);

    // Scalars are single-owner by convention: last contributor wins. Only set
    // them from the one track that actually owns the number.
    if (slice.slots !== undefined) snap.slots = slice.slots;
    if (slice.costToday !== undefined) snap.costToday = slice.costToday;
    if (slice.settings !== undefined) snap.settings = slice.settings;
    if (slice.scheduled !== undefined) snap.scheduled = slice.scheduled;
  }

  // Always authoritative — never a contributor's to set.
  snap.seq = eventLog().head();
  return snap;
}

interface Client {
  socket: WebSocket;
  /** Highest seq this client has been sent. */
  cursor: number;
  subscribed: boolean;
}

export class Hub {
  #clients = new Set<Client>();
  #buffer: Event[] = [];
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;

  start(): void {
    this.#unsubscribe = eventLog().subscribe((e) => {
      this.#buffer.push(e);
      this.#scheduleFlush();
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  add(socket: WebSocket): void {
    const client: Client = { socket, cursor: 0, subscribed: false };
    this.#clients.add(client);

    socket.on('message', (raw: Buffer | string) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        return; // ignore malformed input rather than killing the socket
      }
      this.#handle(client, frame);
    });

    const drop = () => this.#clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  #handle(client: Client, frame: ClientFrame): void {
    if (frame.type === 'ping') {
      send(client, { type: 'pong' });
      return;
    }

    if (frame.type === 'subscribe') {
      const log = eventLog();

      // A gap too large to replay: tell the client to refetch rather than
      // silently handing it an incomplete history.
      if (frame.since > 0 && log.hasGapAfter(frame.since, REPLAY_LIMIT)) {
        client.cursor = log.head();
        client.subscribed = true;
        send(client, { type: 'hello', seq: client.cursor, snapshot: buildSnapshot() });
        send(client, { type: 'resync' });
        return;
      }

      if (frame.since === 0) {
        const snapshot = buildSnapshot();
        client.cursor = snapshot.seq;
        client.subscribed = true;
        send(client, { type: 'hello', seq: snapshot.seq, snapshot });
        return;
      }

      // Reconnect: replay the gap, no snapshot needed.
      const missed = log.since(frame.since, REPLAY_LIMIT);
      client.cursor = missed.at(-1)?.seq ?? frame.since;
      client.subscribed = true;
      if (missed.length > 0) send(client, { type: 'events', events: missed });
      // The lists aren't in the log, so the gap can't carry them. Whatever was broadcast
      // while this socket was down — or before a daemon restart — would otherwise stay
      // on screen until a reload.
      sendLists(client, buildSnapshot());
    }
  }

  #scheduleFlush(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, FLUSH_MS);
  }

  #flush(): void {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    const top = batch.at(-1)!.seq;

    for (const client of this.#clients) {
      if (!client.subscribed) continue;
      // Only send what this client hasn't seen — a client mid-replay may be behind.
      const due = batch.filter((e) => e.seq > client.cursor);
      if (due.length === 0) continue;
      send(client, { type: 'events', events: due });
      client.cursor = Math.max(client.cursor, top);
    }
  }

  /**
   * Push a non-event frame (entity changes, pending queue, dev servers).
   * Sent immediately — these are low-volume and latency matters for them.
   */
  broadcast(frame: ServerFrame): void {
    for (const client of this.#clients) {
      if (!client.subscribed) continue;
      send(client, frame);
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }
}

function send(client: Client, frame: ServerFrame): void {
  if (client.socket.readyState !== 1 /* OPEN */) return;
  try {
    client.socket.send(JSON.stringify(frame));
  } catch (err) {
    console.error('[hub] send failed', err);
  }
}

/** The whole-list frames, as they stand now. Each replaces what the client holds. */
function sendLists(client: Client, snap: Snapshot): void {
  send(client, { type: 'pending', pending: snap.pending });
  send(client, { type: 'servers', servers: snap.servers });
  send(client, { type: 'alerts', alerts: snap.alerts });
}

let instance: Hub | null = null;

export function initHub(): Hub {
  instance = new Hub();
  instance.start();
  return instance;
}

export function hub(): Hub {
  if (!instance) throw new Error('Hub not initialised — call initHub() first');
  return instance;
}
