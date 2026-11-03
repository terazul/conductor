/**
 * Waiting for the model to come back.  TRACK A.  Amendment 192.
 *
 * An agent whose short tries are spent (./retry.ts, `decideRetry`'s `'outage'`) used to end
 * `failed`, and fail its job. Now it is paused with a note (`modelWaitNote`) and joins its
 * provider's outage, here: one per provider, which asks the provider whether it answers at
 * 30 s, 1, 2, 5 and 15 min, then every 15 min, for as long as anyone waits. When it answers,
 * one agent (the canary) is resumed; once the model answers that agent, the rest follow, a few
 * seconds apart, so a fleet doesn't land on a provider that has just come back all at once.
 *
 * A check is also made at once on `checkNow` (retry now, Pause all released) and when the clock
 * has jumped: a laptop that slept through the schedule. Node's timers don't count the sleep, so a
 * heartbeat compares the clock with when it last beat. When the API said when to come back (a
 * `Retry-After`, a usage limit's reset), nothing is checked before then, unless you ask.
 *
 * What it does NOT do: touch the database, the event log or any agent. The supervisor joins
 * agents and is asked to resume them (`onOutageResume`); Alerts reads `list()` for the card.
 * In memory: after a restart `reconcile` joins every waiting agent again, from its status event.
 */

import type { RetryCause } from '@conductor/shared';
import { realClock, retryAfterSeconds, type Clock } from './retry.js';

/** When to check, after the outage began: 30 s, 1, 2, 5, 15 min. Then every `OUTAGE_EVERY_MS`. */
export const OUTAGE_CHECKS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 900_000];
export const OUTAGE_EVERY_MS = 900_000;
/** Between one agent resuming and the next, once the first has been answered. */
export const STAGGER_MS = 5_000;
/** How often the clock is looked at while an outage lasts, and the gap that says it jumped. */
export const HEARTBEAT_MS = 60_000;
export const JUMP_MS = 120_000;

/** What one check found. `retryAt`: the provider said when to come back (epoch ms). */
export interface ProbeResult {
  up: boolean;
  retryAt?: number;
}
export type Probe = () => Promise<ProbeResult>;

/**
 * Each provider's check, behind one indirection so session/verify.ts can answer for them, as
 * `modelSources` (./models.ts) is. A provider with none is taken as up: its first agent is the check.
 */
export const probes: Record<string, Probe> = {
  claude: async () => {
    const { probeGateway } = await import('./models.js');
    return probeGateway();
  },
  // Loaded when asked: copilot.ts imports the arbiter, and this file is imported by the supervisor and Alerts.
  copilot: async () => {
    const { copilotModels } = await import('./backends/copilot.js');
    return copilotModels(true).then(
      () => ({ up: true }),
      (err: unknown) => ({ up: false, ...retryAfterOf(err) }),
    );
  },
  openrouter: async () => {
    const { openRouterModels } = await import('./backends/copilot.js');
    return openRouterModels(true).then(
      () => ({ up: true }),
      (err: unknown) => ({ up: false, ...retryAfterOf(err) }),
    );
  },
};

/** "retry after 120" in an error's words, as a time; nothing when it doesn't say. */
function retryAfterOf(err: unknown): { retryAt?: number } {
  const s = retryAfterSeconds(err instanceof Error ? err.message : String(err));
  return s === null ? {} : { retryAt: Date.now() + s * 1000 };
}


/** One agent waiting in an outage. */
export interface OutageAgent {
  agentId: string;
  projectId: string;
  jobId: string;
  cause: RetryCause;
  /** When it began waiting, on the book's clock. */
  joinedAt: number;
}

/** A provider that isn't answering, and who waits for it. */
export interface Outage {
  provider: string;
  /** Why the first agent in it is waiting. */
  cause: RetryCause;
  /** When it began: the earliest agent's wait. */
  since: number;
  /** Who waits, oldest first. Not the canary, which is running. */
  agents: OutageAgent[];
  /** Checks made so far. */
  checks: number;
  /** When the next check is, or null while one runs or an agent is being tried. */
  nextCheckAt: number | null;
  /** No check before this, when the API said when to come back. */
  notBefore: number | null;
  /**
   * probing: checking on the schedule. canary: a check answered and one agent was resumed, to
   * see that the model answers it. releasing: it did, and the rest are resumed a few seconds apart.
   */
  state: 'probing' | 'canary' | 'releasing';
  canary: string | null;
}

/** What the supervisor did when asked to resume an agent. */
export type ResumeAnswer = 'resumed' | 'held' | 'gone';

export interface JoinOutage {
  provider: string;
  agentId: string;
  projectId: string;
  jobId: string;
  cause: RetryCause;
  /** When it began waiting, if before now: a restart rejoining it. */
  since?: number;
  /** When the API said to come back. */
  retryAt?: number;
}

interface Held extends Omit<Outage, 'agents'> {
  agents: Map<string, OutageAgent>;
  /** Index into OUTAGE_CHECKS_MS of the next check. */
  step: number;
  timer: unknown;
  checking: boolean;
}

export class OutageBook {
  #clock: Clock;
  #resume: (agentId: string) => ResumeAnswer;
  #notify: () => void;
  #outages = new Map<string, Held>();
  #beat: { timer: unknown; at: number } | null = null;

  constructor(clock: Clock, resume: (agentId: string) => ResumeAnswer, notify: () => void) {
    this.#clock = clock;
    this.#resume = resume;
    this.#notify = notify;
  }

  /**
   * The agent waits for its provider. A canary or a released agent that fails again is back in
   * it, and the outage goes back to checking on the schedule, a step on.
   */
  join(j: JoinOutage): void {
    const now = this.#clock.now();
    const was = this.of(j.agentId);
    if (was !== undefined && was !== j.provider) this.#remove(j.agentId);
    let o = this.#outages.get(j.provider);
    // A new outage, a step on, or a later `notBefore` moves the next check; another agent joining doesn't.
    let reschedule = true;
    if (!o) {
      o = {
        provider: j.provider,
        cause: j.cause,
        since: j.since ?? now,
        agents: new Map(),
        checks: 0,
        nextCheckAt: null,
        notBefore: null,
        state: 'probing',
        canary: null,
        step: 0,
        timer: null,
        checking: false,
      };
      this.#outages.set(j.provider, o);
    } else if (o.state !== 'probing') {
      // The model failed someone it had answered: it isn't back after all.
      o.state = 'probing';
      o.canary = null;
      o.step += 1;
    } else {
      reschedule = o.timer === null;
    }
    if (j.since !== undefined && j.since < o.since) o.since = j.since;
    const prior = o.agents.get(j.agentId);
    o.agents.set(j.agentId, {
      agentId: j.agentId,
      projectId: j.projectId,
      jobId: j.jobId,
      cause: j.cause,
      joinedAt: prior?.joinedAt ?? j.since ?? now,
    });
    if (j.retryAt !== undefined && j.retryAt > now && j.retryAt > (o.notBefore ?? 0)) {
      o.notBefore = j.retryAt;
      reschedule = true;
    }
    if (reschedule && !o.checking) this.#schedule(o);
    this.#heartbeat();
    this.#notify();
  }

  /** The agent no longer waits: stopped, failed by you, resumed by you, or gone. */
  leave(agentId: string): void {
    if (this.#remove(agentId)) this.#notify();
  }

  /**
   * The agent is starting: a message of yours, or its outage's own resume. One that waited
   * no longer does; the canary stays the canary, since its run is what shows the model is back.
   */
  started(agentId: string): void {
    for (const o of this.#outages.values()) {
      if (!o.agents.delete(agentId)) continue;
      this.#endIfEmpty(o);
      this.#notify();
      return;
    }
  }

  /** The model answered this agent. If it was the canary, the rest are resumed. */
  answered(agentId: string): void {
    for (const o of this.#outages.values()) {
      if (o.canary !== agentId) continue;
      o.canary = null;
      o.state = 'releasing';
      this.#release(o);
      this.#notify();
    }
  }

  /** Check now (retry now, Pause all released). False when nobody waits for that provider. */
  checkNow(provider: string): boolean {
    const o = this.#outages.get(provider);
    if (!o) return false;
    if (o.state === 'probing' && !o.checking) void this.#check(o);
    return true;
  }

  /** The provider an agent waits for, if it waits, or is that provider's canary. */
  of(agentId: string): string | undefined {
    for (const o of this.#outages.values()) if (o.agents.has(agentId) || o.canary === agentId) return o.provider;
    return undefined;
  }

  get(provider: string): Outage | undefined {
    const o = this.#outages.get(provider);
    return o ? view(o) : undefined;
  }

  list(): Outage[] {
    return [...this.#outages.values()].map(view);
  }

  /** Every timer off, for the daemon stopping. */
  clear(): void {
    for (const o of this.#outages.values()) this.#clock.clearTimer(o.timer);
    if (this.#beat) this.#clock.clearTimer(this.#beat.timer);
    this.#beat = null;
    const any = this.#outages.size > 0;
    this.#outages.clear();
    if (any) this.#notify();
  }

  // ── internals ────────────────────────────────────────────────────────────

  #remove(agentId: string): boolean {
    for (const o of this.#outages.values()) {
      if (o.agents.delete(agentId)) {
        this.#endIfEmpty(o);
        return true;
      }
      if (o.canary === agentId) {
        // Stopped or gone before the model answered it: nothing has shown the model is back.
        o.canary = null;
        o.state = 'probing';
        if (!this.#endIfEmpty(o)) this.#schedule(o);
        return true;
      }
    }
    return false;
  }

  #endIfEmpty(o: Held): boolean {
    if (o.agents.size > 0 || o.canary !== null) return false;
    this.#clock.clearTimer(o.timer);
    this.#outages.delete(o.provider);
    if (this.#outages.size === 0 && this.#beat) {
      this.#clock.clearTimer(this.#beat.timer);
      this.#beat = null;
    }
    return true;
  }

  /** The next check, on the schedule, not before `notBefore`. */
  #schedule(o: Held): void {
    this.#clock.clearTimer(o.timer);
    o.timer = null;
    if (o.state !== 'probing') {
      o.nextCheckAt = null;
      return;
    }
    const now = this.#clock.now();
    const delay = OUTAGE_CHECKS_MS[o.step] ?? OUTAGE_EVERY_MS;
    // The schedule counts from when the outage began, then from each check.
    const from = o.checks === 0 ? o.since : now;
    const at = Math.max(from + delay, o.notBefore ?? 0, now);
    o.nextCheckAt = at;
    o.timer = this.#clock.setTimer(() => void this.#check(o), at - now);
  }

  async #check(o: Held): Promise<void> {
    this.#clock.clearTimer(o.timer);
    o.timer = null;
    o.checking = true;
    o.nextCheckAt = null;
    o.checks += 1;
    this.#notify();
    let r: ProbeResult;
    try {
      r = await (probes[o.provider] ?? (async () => ({ up: true })))();
    } catch {
      r = { up: false };
    }
    o.checking = false;
    // It ended while the check ran: everyone left it.
    if (this.#outages.get(o.provider) !== o) return;
    const now = this.#clock.now();
    if (o.notBefore !== null && o.notBefore <= now) o.notBefore = null;
    if (r.retryAt !== undefined && r.retryAt > now) o.notBefore = Math.max(o.notBefore ?? 0, r.retryAt);
    if (r.up && o.state === 'probing') this.#tryOne(o);
    else {
      o.step += 1;
      this.#schedule(o);
    }
    this.#notify();
  }

  /** A check answered: resume the agent that has waited longest, to see the model answer it. */
  #tryOne(o: Held): void {
    for (const a of [...o.agents.values()].sort((x, y) => x.joinedAt - y.joinedAt)) {
      // The canary before it is resumed: resuming it starts it, and a start leaves the wait (`started`).
      o.agents.delete(a.agentId);
      o.canary = a.agentId;
      o.state = 'canary';
      o.nextCheckAt = null;
      const answer = this.#resume(a.agentId);
      if (answer === 'resumed') return;
      o.canary = null;
      o.state = 'probing';
      if (answer === 'gone') continue;
      o.agents.set(a.agentId, a);
      break;
    }
    if (this.#endIfEmpty(o)) return;
    // Held (Pause all): checked again on the schedule; releasing the pause checks at once.
    o.step += 1;
    this.#schedule(o);
  }

  /** The canary was answered: the next agent now, then one every STAGGER_MS. */
  #release(o: Held): void {
    this.#clock.clearTimer(o.timer);
    o.timer = null;
    if (this.#outages.get(o.provider) !== o || o.state !== 'releasing') return;
    for (const a of [...o.agents.values()].sort((x, y) => x.joinedAt - y.joinedAt)) {
      o.agents.delete(a.agentId);
      const answer = this.#resume(a.agentId);
      if (answer === 'held') {
        // Everything was paused until a time: wait for that, then start over with a check.
        o.agents.set(a.agentId, a);
        o.state = 'probing';
        this.#schedule(o);
        this.#notify();
        return;
      }
      if (answer === 'gone') continue;
      if (this.#endIfEmpty(o)) {
        this.#notify();
        return;
      }
      o.timer = this.#clock.setTimer(() => this.#release(o), STAGGER_MS);
      this.#notify();
      return;
    }
    this.#endIfEmpty(o);
    this.#notify();
  }

  /** While any outage lasts, look at the clock each minute: a jump means a sleep, so check now. */
  #heartbeat(): void {
    if (this.#beat || this.#outages.size === 0) return;
    const arm = (): void => {
      const at = this.#clock.now();
      this.#beat = { at, timer: this.#clock.setTimer(beat, HEARTBEAT_MS) };
    };
    const beat = (): void => {
      const last = this.#beat?.at ?? this.#clock.now();
      this.#beat = null;
      if (this.#outages.size === 0) return;
      if (this.#clock.now() - last > JUMP_MS) {
        for (const o of this.#outages.values()) if (o.state === 'probing' && !o.checking) void this.#check(o);
      }
      arm();
    };
    arm();
  }
}

function view(o: Held): Outage {
  return {
    provider: o.provider,
    cause: o.cause,
    since: o.since,
    agents: [...o.agents.values()].sort((x, y) => x.joinedAt - y.joinedAt),
    checks: o.checks,
    nextCheckAt: o.nextCheckAt,
    notBefore: o.notBefore,
    state: o.state,
    canary: o.canary,
  };
}

// ── the daemon's book ───────────────────────────────────────────────────────

let resumeHandler: ((agentId: string) => ResumeAnswer) | null = null;
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const fn of [...listeners]) fn();
};

let book = new OutageBook(realClock, (id) => resumeHandler?.(id) ?? 'gone', changed);

/** The one book the daemon uses. The supervisor joins agents to it; Alerts reads it. */
export function outages(): OutageBook {
  return book;
}

/** Who resumes an agent its outage lets go. The supervisor sets it; it survives a reset. */
export function onOutageResume(fn: ((agentId: string) => ResumeAnswer) | null): void {
  resumeHandler = fn;
}

/** Called whenever an outage starts, changes or ends. Returns the way to stop listening. */
export function onOutageChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** For checks: a fresh, empty book on `clock`. Its handler and listeners are kept. */
export function resetOutages(clock: Clock = realClock): OutageBook {
  book.clear();
  book = new OutageBook(clock, (id) => resumeHandler?.(id) ?? 'gone', changed);
  return book;
}
