/**
 * The store — one projection of the event log, shared by every UI track.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks B–E.
 *
 * This exists to remove four cross-track dependencies. Without it, Track B
 * would own the reducer and C, D and E would all have to wait on it. Instead
 * every track reads the same hooks and builds only its own screens.
 *
 * Built on React's useSyncExternalStore — no state library, no extra dep.
 *
 * Derived values (status rollup, sparklines, diffstats) come from
 * @conductor/shared so the daemon and every screen compute them identically.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  diffstat,
  rollupStatus,
  sparkline,
  type Agent,
  type AgentStatus,
  type Alert,
  type DevServer,
  type DiffStat,
  type Event,
  type Job,
  type PendingRequest,
  type Project,
  type ScheduledMessage,
  type ServerFrame,
  type Snapshot,
} from '@conductor/shared';
import { api, Feed, type FeedStatus } from './feed.js';
import { receiveSettings } from './settings.js';
import { receiveTerminalOut, receiveTerminalRun } from './terminal.js';
import { receiveBranches } from '../branches/live.js';

/** Per-agent transcript cap. Older events stay in SQLite, not in the tab. */
const MAX_EVENTS_PER_AGENT = 2_000;
const MAX_EVENTS_PER_JOB = MAX_EVENTS_PER_AGENT * 4;

interface State {
  status: FeedStatus;
  seq: number;
  /** Bumped by every snapshot, so history hooks know to backfill again. */
  generation: number;
  projects: Project[];
  jobs: Job[];
  agents: Agent[];
  pending: PendingRequest[];
  servers: DevServer[];
  /** What needs you besides a pending request, as the daemon last said. Amendment 28. */
  alerts: Alert[];
  slots: { used: number; total: number };
  costToday: number;
  /** Messages waiting for their time (Amendment 111), soonest first. */
  scheduled: ScheduledMessage[];
  eventsByAgent: Map<string, Event[]>;
  eventsByJob: Map<string, Event[]>;
}

function initialState(): State {
  return {
    status: 'connecting',
    seq: 0,
    generation: 0,
    projects: [],
    jobs: [],
    agents: [],
    pending: [],
    servers: [],
    alerts: [],
    slots: { used: 0, total: 7 },
    costToday: 0,
    scheduled: [],
    eventsByAgent: new Map(),
    eventsByJob: new Map(),
  };
}

class Store {
  #state = initialState();
  #version = 0;
  #listeners = new Set<() => void>();
  #cache = new Map<string, { version: number; value: unknown }>();
  #feed: Feed;

  constructor() {
    this.#feed = new Feed({
      onFrame: (f) => this.apply(f),
      onStatus: (s) => {
        this.#state.status = s;
        this.#bump();
      },
    });
  }

  connect(): void {
    this.#feed.connect();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  #bump(): void {
    this.#version += 1;
    for (const l of this.#listeners) l();
  }

  /**
   * Memoised selector. Returns a stable reference until the store changes,
   * which is what keeps useSyncExternalStore from looping.
   */
  select<T>(key: string, compute: (s: State) => T): T {
    const hit = this.#cache.get(key);
    if (hit && hit.version === this.#version) return hit.value as T;
    const value = compute(this.#state);
    this.#cache.set(key, { version: this.#version, value });
    return value;
  }

  get version(): number {
    return this.#version;
  }

  // ── the reducer ──────────────────────────────────────────────────────────
  apply(frame: ServerFrame): void {
    const s = this.#state;

    switch (frame.type) {
      case 'hello':
        this.#applySnapshot(frame.snapshot);
        break;

      case 'events':
        // #applyEvent owns s.seq now — it is the idempotence gate.
        for (const e of frame.events) this.#applyEvent(e);
        break;

      case 'entities':
        if (frame.projects) s.projects = mergeById(s.projects, frame.projects);
        if (frame.jobs) s.jobs = mergeById(s.jobs, frame.jobs);
        if (frame.agents) s.agents = mergeById(s.agents, frame.agents);
        break;

      case 'pending':
        s.pending = frame.pending;
        break;

      case 'servers':
        s.servers = frame.servers;
        break;

      case 'alerts':
        s.alerts = frame.alerts;
        break;

      case 'terminal_run':
        // The terminal keeps its own store (lib/terminal.ts), like settings.
        receiveTerminalRun(frame.run);
        return;

      case 'terminal_out':
        receiveTerminalOut(frame);
        return;

      case 'slots':
        // Before Amendment 47 the status bar learned this only from a snapshot.
        s.slots = frame.slots;
        break;

      case 'cost':
        // So did today's spend, before Amendment 59.
        s.costToday = frame.costToday;
        break;

      case 'settings':
        // Settings keep their own store (lib/settings.ts); nothing here re-renders on them.
        receiveSettings(frame.settings);
        return;

      case 'scheduled':
        // The whole list each time (Amendment 111): one was added, sent, failed or cancelled.
        s.scheduled = frame.scheduled;
        break;

      case 'branches':
        // The Branches screen re-reads its own (Amendment 109); nothing here to project.
        receiveBranches(frame.projectId);
        return;

      case 'pong':
      case 'resync':
        return; // Feed handles resync; nothing to project
    }

    this.#bump();
  }

  #applySnapshot(snap: Snapshot): void {
    const s = this.#state;
    if (snap.settings) receiveSettings(snap.settings);
    s.projects = snap.projects;
    s.jobs = snap.jobs;
    s.agents = snap.agents;
    s.pending = snap.pending;
    s.servers = snap.servers;
    // A daemon from before Amendment 28 sends none.
    s.alerts = snap.alerts ?? [];
    s.slots = snap.slots;
    s.costToday = snap.costToday;
    // A daemon from before Amendment 111 sends none.
    s.scheduled = snap.scheduled ?? [];
    s.seq = snap.seq;
    s.generation += 1;
  }

  // ── history ──────────────────────────────────────────────────────────────
  /**
   * The snapshot carries entities, not events, and the feed only replays a gap
   * for a cursor it already holds. So a fresh tab — a reload, a reopened tab,
   * an HMR reload of this module — knows every agent and what it cost but has
   * no transcript at all. The event hooks ask for history on first read; this
   * fetches it once per id per snapshot. Amendment 27.
   */
  #asked = new Map<string, number>();

  backfill(kind: 'agent' | 'job', id: string): void {
    const s = this.#state;
    // Wait for the snapshot, so a deep link doesn't fetch twice. Fixtures have no daemon.
    if (s.generation === 0 || s.status === 'fixture') return;
    const key = `${kind}:${id}`;
    if (this.#asked.get(key) === s.generation) return;
    this.#asked.set(key, s.generation);
    const path =
      kind === 'agent'
        ? `/api/agents/${encodeURIComponent(id)}/events`
        : `/api/jobs/${encodeURIComponent(id)}`;
    api<{ events: Event[] }>(path).then(
      (r) => this.applyHistory(r.events),
      () => this.#asked.delete(key), // asked again on the next mount
    );
  }

  /**
   * Merge events fetched over HTTP. Not a feed frame: it neither moves `seq`
   * nor folds payloads, because the snapshot's entities are already newer than
   * any history. Idempotent against the live feed in either order — history
   * landing after live events, or live events that history already brought.
   */
  applyHistory(events: Event[]): void {
    if (events.length === 0) return;
    const s = this.#state;
    const byAgent = new Map<string, Event[]>();
    const byJob = new Map<string, Event[]>();
    for (const e of events) {
      if (e.agentId) group(byAgent, e.agentId).push(e);
      group(byJob, e.jobId).push(e);
    }
    for (const [id, evs] of byAgent) {
      s.eventsByAgent.set(id, mergeBySeq(s.eventsByAgent.get(id) ?? [], evs, MAX_EVENTS_PER_AGENT));
    }
    for (const [id, evs] of byJob) {
      s.eventsByJob.set(id, mergeBySeq(s.eventsByJob.get(id) ?? [], evs, MAX_EVENTS_PER_JOB));
    }
    this.#bump();
  }

  #applyEvent(e: Event): void {
    const s = this.#state;

    /**
     * Idempotence on seq. Amendment 7.
     *
     * Belt to the Feed's re-entrancy guard: `seq` is globally monotonic and
     * events arrive in order, so anything at or below the high-water mark has
     * already been applied. Without this, a duplicate delivery from any source
     * doubles `useSparkline()` and `useJobDiffstat()` silently — which is how
     * Track B found the StrictMode double-connect, by watching two screens
     * disagree about one diffstat.
     */
    if (e.seq <= s.seq) return;
    s.seq = e.seq;

    /**
     * Arrays are REPLACED, never mutated. Amendment 7.
     *
     * These used to push onto the existing array and re-`set()` it, so array
     * identity never changed and any `useMemo(..., [events])` froze at its first
     * value. Every UI track would have hit that, and the symptom — a list that
     * renders once and then stops updating while the data is plainly arriving —
     * looks like a React bug rather than a store bug. Track B hit it and worked
     * around it by keying memos on `seq` instead.
     *
     * The copy is O(n) per event, which at ~5 events/sec against a 2,000-event
     * cap is irrelevant next to being able to trust referential equality.
     */
    if (e.agentId) {
      const prev = s.eventsByAgent.get(e.agentId) ?? [];
      s.eventsByAgent.set(e.agentId, appendBySeq(prev, e, MAX_EVENTS_PER_AGENT));
    }

    const prevJob = s.eventsByJob.get(e.jobId) ?? [];
    s.eventsByJob.set(e.jobId, appendBySeq(prevJob, e, MAX_EVENTS_PER_JOB));

    // Fold the payloads that change entity state, so the UI doesn't need a
    // round-trip for the common cases.
    const p = e.payload;
    if (p.kind === 'status' && e.agentId) {
      s.agents = s.agents.map((a) =>
        a.id === e.agentId
          ? { ...a, status: p.status, blockMode: p.blockMode ?? null }
          : a,
      );
    } else if (p.kind === 'usage' && e.agentId) {
      s.agents = s.agents.map((a) =>
        a.id === e.agentId
          ? {
              ...a,
              costUsd: p.costUsd,
              inputTokens: p.inputTokens,
              outputTokens: p.outputTokens,
            }
          : a,
      );
    } else if (p.kind === 'resolved') {
      s.pending = s.pending.filter((r) => r.requestId !== p.requestId);
    }
  }
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const map = new Map(existing.map((x) => [x.id, x]));
  for (const x of incoming) map.set(x.id, x);
  return [...map.values()];
}

function group(map: Map<string, Event[]>, key: string): Event[] {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  return list;
}

/**
 * The live path. Nearly always a plain append, but history fetched over HTTP
 * can already hold this event or a newer one; then it is merged, not doubled.
 */
function appendBySeq(prev: Event[], e: Event, cap: number): Event[] {
  const last = prev.at(-1);
  if (last && last.seq >= e.seq) return mergeBySeq(prev, [e], cap);
  const next = [...prev, e];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

/** Union by seq, oldest first, newest `cap` kept. Returns `prev` itself when nothing is new. */
function mergeBySeq(prev: Event[], incoming: Event[], cap: number): Event[] {
  const seen = new Set(prev.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return prev;
  const next = [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export const store = new Store();

// ─────────────────────────────────────────────────────────────────────────────
// Hooks — the entire public surface for Tracks B, C, D, E
// ─────────────────────────────────────────────────────────────────────────────

function useSelect<T>(key: string, compute: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => store.select(key, compute),
    () => store.select(key, compute),
  );
}

export function useFeedStatus(): FeedStatus {
  return useSelect('status', (s) => s.status);
}

export function useProjects(): Project[] {
  return useSelect('projects', (s) => s.projects);
}

export function useJobs(projectId?: string): Job[] {
  return useSelect(`jobs:${projectId ?? '*'}`, (s) =>
    projectId ? s.jobs.filter((j) => j.projectId === projectId) : s.jobs,
  );
}

export function useAgents(jobId?: string): Agent[] {
  return useSelect(`agents:${jobId ?? '*'}`, (s) =>
    jobId ? s.agents.filter((a) => a.jobId === jobId) : s.agents,
  );
}

export function useAgent(agentId: string | null): Agent | undefined {
  return useSelect(`agent:${agentId}`, (s) =>
    agentId ? s.agents.find((a) => a.id === agentId) : undefined,
  );
}

/** Fetch an id's history once the snapshot is in, and again after a resync. */
function useBackfill(kind: 'agent' | 'job', id: string | null): void {
  const generation = useSelect('generation', (s) => s.generation);
  useEffect(() => {
    if (id) store.backfill(kind, id);
  }, [kind, id, generation]);
}

export function useAgentEvents(agentId: string | null): Event[] {
  useBackfill('agent', agentId);
  return useSelect(`events:agent:${agentId}`, (s) =>
    agentId ? (s.eventsByAgent.get(agentId) ?? []) : [],
  );
}

export function useJobEvents(jobId: string | null): Event[] {
  useBackfill('job', jobId);
  return useSelect(`events:job:${jobId}`, (s) =>
    jobId ? (s.eventsByJob.get(jobId) ?? []) : [],
  );
}

/** The attention queue, oldest first — the order you should answer in. */
export function usePending(): PendingRequest[] {
  return useSelect('pending', (s) =>
    [...s.pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
  );
}

/**
 * Failures, budget stops, outages and dead servers (F10, F13), in the daemon's order:
 * outages first, the rest oldest first. The daemon derives them, so there is nothing
 * to fold here — each `alerts` frame is the whole list.
 */
/** Every scheduled message (Amendment 111), soonest first. Filter by agent where you show them. */
export function useScheduled(): ScheduledMessage[] {
  return useSelect('scheduled', (s) => s.scheduled);
}

export function useAlerts(): Alert[] {
  return useSelect('alerts', (s) => s.alerts);
}

export function useServers(jobId?: string): DevServer[] {
  return useSelect(`servers:${jobId ?? '*'}`, (s) =>
    jobId ? s.servers.filter((d) => d.jobId === jobId) : s.servers,
  );
}

/** Worst status among a project's agents. Drives the Fleet card stripe. */
export function useProjectStatus(projectId: string): AgentStatus {
  return useSelect(`projstatus:${projectId}`, (s) =>
    rollupStatus(s.agents.filter((a) => a.projectId === projectId).map((a) => a.status)),
  );
}

export function useJobStatus(jobId: string): AgentStatus {
  return useSelect(`jobstatus:${jobId}`, (s) =>
    rollupStatus(s.agents.filter((a) => a.jobId === jobId).map((a) => a.status)),
  );
}

/**
 * Tool calls per 15s bucket. Flat bars mean stuck, not working — which is the
 * whole reason this exists, and the reason the `now` seam matters.
 *
 * Amendment 7. Pass `now` when the newest event is not near wall-clock time: a
 * fixture recorded at a past timestamp otherwise falls entirely outside the
 * trailing window and renders a busy agent as flat, i.e. "stuck". Reporting the
 * opposite of the truth is worse than reporting nothing. Track B hit this and
 * anchored to the newest event in fixture mode.
 *
 *   useSparkline(id)                       // live
 *   useSparkline(id, newestEventTimeMs)    // replaying a recording
 */
export function useSparkline(agentId: string | null, now?: number): number[] {
  return useSelect(`spark:${agentId}:${now ?? 'live'}`, (s) =>
    sparkline(agentId ? (s.eventsByAgent.get(agentId) ?? []) : [], now),
  );
}

export function useJobDiffstat(jobId: string | null): DiffStat {
  useBackfill('job', jobId);
  return useSelect(`diff:${jobId}`, (s) =>
    diffstat(jobId ? (s.eventsByJob.get(jobId) ?? []) : []),
  );
}

export function useStatusBar(): { slots: State['slots']; costToday: number; seq: number } {
  return useSelect('statusbar', (s) => ({
    slots: s.slots,
    costToday: s.costToday,
    seq: s.seq,
  }));
}
