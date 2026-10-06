/**
 * Which finished jobs you have seen (Amendment 87).
 *
 * A job is FINISHED when the daemon has rolled it up to `done` or `failed` and given it an
 * end time (`#rollUpJob`): none of its agents can still make progress. An agent waiting on
 * a failed one is still `queued` (Amendment 85), so its job hasn't finished. Until you see
 * a finished job, its Fleet card, its group on the Project screen and its group in the
 * navigator say **finished**, the tab badge counts it, and a desktop notification fires if
 * those are on.
 *
 * SEEN means you opened its project, or one of its agents. It is kept in Settings
 * (`conductor.seenJobs`), so it is the same in every browser, as
 * `{ since, jobs: { <jobId>: <endedAt seen> } }`:
 *
 *  - `since` is when this browser first kept it. Nothing that ended before then is unseen,
 *    so the first load after this change doesn't light every job you ever ran. Before the
 *    key exists nothing is unseen; `startSeen` writes it once the settings have arrived.
 *  - Each job is kept with the end time you saw. A job you continue and that finishes
 *    again has a later end time, so it is unseen again.
 *  - Jobs that no longer exist drop out whenever it is written, so it doesn't grow.
 *
 * The rules are pure, for lib/verify.ts; the hooks at the bottom read the store.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { Agent, Job } from '@conductor/shared';
import { readSetting, useSetting, whenSettingsLoaded, writeSetting } from './settings.js';
import { useAgents, useJobs } from './store.js';

export const SEEN_KEY = 'conductor.seenJobs';

export interface SeenState {
  /** ISO time it was first kept; null before then, when nothing is unseen. */
  since: string | null;
  /** Each job seen, with the end time it had when you saw it. */
  jobs: Record<string, string>;
}

/** The stored value. Missing or broken is "not kept yet": nothing is unseen. */
export function parseSeen(raw: string | null): SeenState {
  const none: SeenState = { since: null, jobs: {} };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return none;
    const o = v as { since?: unknown; jobs?: unknown };
    if (typeof o.since !== 'string' || Number.isNaN(Date.parse(o.since))) return none;
    const jobs: Record<string, string> = {};
    if (o.jobs && typeof o.jobs === 'object' && !Array.isArray(o.jobs)) {
      for (const [k, t] of Object.entries(o.jobs)) if (typeof t === 'string') jobs[k] = t;
    }
    return { since: o.since, jobs };
  } catch {
    return none;
  }
}

export function serializeSeen(s: SeenState): string {
  return JSON.stringify({ since: s.since, jobs: s.jobs });
}

/** Kept from now: what is already finished counts as seen. */
export function startSeen(nowIso: string): SeenState {
  return { since: nowIso, jobs: {} };
}

/** Rolled up to done or failed, with an end time. */
export function isFinished(job: Pick<Job, 'status' | 'endedAt'>): boolean {
  return (job.status === 'done' || job.status === 'failed') && job.endedAt !== null;
}

/**
 * The finished jobs you haven't seen, in the order given. A job needs an agent: one whose
 * last agent was removed is settled `done` by the daemon, but there is nothing to see.
 */
export function unseenFinished<J extends Pick<Job, 'id' | 'status' | 'endedAt'>>(
  jobs: readonly J[],
  agents: readonly Pick<Agent, 'jobId'>[],
  seen: SeenState,
): J[] {
  if (seen.since === null) return [];
  const since = Date.parse(seen.since);
  return jobs.filter((j) => {
    if (!isFinished(j) || !agents.some((a) => a.jobId === j.id)) return false;
    const ended = Date.parse(j.endedAt!);
    const saw = seen.jobs[j.id];
    return ended > since && (saw === undefined || ended > Date.parse(saw));
  });
}

/**
 * `ids` marked seen at the end time each has now, and every job not in `jobs` dropped.
 * Null when nothing would change, so a caller writes only a real change.
 */
export function markSeen(
  seen: SeenState,
  ids: readonly string[],
  jobs: readonly Pick<Job, 'id' | 'endedAt'>[],
): SeenState | null {
  if (seen.since === null) return null;
  const known = new Set(jobs.map((j) => j.id));
  const next: Record<string, string> = {};
  for (const [id, t] of Object.entries(seen.jobs)) if (known.has(id)) next[id] = t;
  for (const id of ids) {
    const ended = jobs.find((j) => j.id === id)?.endedAt;
    if (ended) next[id] = ended;
  }
  const out = { since: seen.since, jobs: next };
  return serializeSeen(out) === serializeSeen(seen) ? null : out;
}

/**
 * The unseen jobs the Agent screen sees: the open agent's own job. (The Project screen
 * marks its own project's, since only it knows which project it is showing.)
 */
export function seenOnAgent(
  agentId: string | undefined,
  agents: readonly Pick<Agent, 'id' | 'jobId'>[],
  unseen: readonly Pick<Job, 'id'>[],
): string[] {
  const jobId = agentId ? agents.find((a) => a.id === agentId)?.jobId : undefined;
  return jobId && unseen.some((j) => j.id === jobId) ? [jobId] : [];
}

// ── the live state ──────────────────────────────────────────────────────────

/** Write `since` once the daemon's settings arrive, if no browser has yet. */
export function startSeenOnce(): void {
  whenSettingsLoaded(() => {
    if (readSetting(SEEN_KEY) === null) writeSetting(SEEN_KEY, serializeSeen(startSeen(new Date().toISOString())));
  });
}

/** Mark these jobs seen, read from the settings now so two quick marks both land. */
export function markJobsSeen(ids: readonly string[], jobs: readonly Pick<Job, 'id' | 'endedAt'>[]): void {
  if (ids.length === 0) return;
  const next = markSeen(parseSeen(readSetting(SEEN_KEY)), ids, jobs);
  if (next) writeSetting(SEEN_KEY, serializeSeen(next));
}

/** Every finished job you haven't seen, in every project. */
export function useUnseenJobs(): Job[] {
  const jobs = useJobs();
  const agents = useAgents();
  const raw = useSetting(SEEN_KEY);
  return useMemo(() => unseenFinished(jobs, agents, parseSeen(raw)), [jobs, agents, raw]);
}

function onVisibility(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
}

const visibleNow = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Whether the tab is in front: a job that ends behind it isn't seen until you come back. */
export function useTabVisible(): boolean {
  return useSyncExternalStore(onVisibility, visibleNow, visibleNow);
}
