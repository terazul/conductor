/**
 * Alerts — what needs a person that isn't a tool call waiting for an answer.
 *
 * TRACK A. Amendment 28 (F10, F13).
 *
 * Needs You used to count only pending requests. An agent that failed while you were on
 * another screen stayed silent until you went and looked, and a lost connection to the
 * model read as "working" for minutes. Four things raise an alert now:
 *
 *   failed       an agent ended `failed`
 *   budget       an agent stopped on its cap, or on its job's
 *   connection   the model API can't be reached or refuses the login, or the retries ran out
 *   server_down  a dev server stopped answering and nobody asked it to stop
 *   blocked_dep  an agent waits on one that failed or was stopped (Amendments 85, 88)
 *   handoff_held an agent others wait for ended its turn without calling `hand_off` (Amendment 104)
 *
 * Failures, budget stops and dead servers are DERIVED from what is stored: the agent's
 * status, the status event that set it, and the dev server's row. A reload or a restart
 * can't lose one, and each clears itself when what it describes changes. Only dismissals
 * are stored. Connection alerts are held in memory, because they describe the present.
 *
 * Driven off the event log, so nothing else has to remember to call in. The one
 * exception is `modelAnswered`, because an assistant message that is really an API error
 * reaches the log as ordinary `text` and can't be told apart there.
 */

import { HANDOFF_HELD_NOTE, waitersOf, type Alert, type Event, type RetryCause, type StatusPayload } from '@conductor/shared';
import { row, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub, registerSnapshotContributor } from '../hub.js';
import { preview } from '../preview/index.js';
import { onServersChanged } from '../preview/registry.js';
import { budgetStop } from './budget.js';
import { costToday, dueNotes, getAgent, heldHandoffs, listAgents, localDay } from './store.js';
import { DAILY_KEY, dailyBudget, onCostChanged, startDayWatch } from '../daily.js';
import { onSettingsChanged } from '../settings.js';

/** Causes a person has to fix: the network or the login is broken, not busy. */
const NEEDS_A_PERSON: ReadonlySet<RetryCause> = new Set(['unreachable', 'auth']);

/** One blip must not page anyone (§5.1: `--need` means a human is required). */
export const ALERT_FROM_ATTEMPT = 2;
/** …unless the first attempt has been failing this long. */
export const ALERT_AFTER_MS = 20_000;

/** SDK errors only someone with the login or the account can fix. */
const ACCOUNT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'cloud_credential_error',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
]);

/** Why the SDK is retrying, from its `api_retry` message. */
export function classifyRetry(httpStatus: number | null, error: string): RetryCause {
  if (ACCOUNT_ERRORS.has(error) || httpStatus === 401 || httpStatus === 403) return 'auth';
  if (error === 'rate_limit' || error === 'overloaded' || httpStatus === 429 || httpStatus === 529) {
    return 'throttled';
  }
  // No HTTP response at all: DNS, the VPN, or no network.
  if (httpStatus === null) return 'unreachable';
  return 'server';
}

/** One agent's retries since the model last answered it. */
export interface Retrying {
  agentId: string;
  projectId: string;
  jobId: string;
  cause: RetryCause;
  attempt: number;
  maxRetries: number;
  firstAt: number;
  lastAt: number;
  /** Its run ended without the model answering again. */
  gaveUp: boolean;
}

/** Whether these retries need a person yet. */
export function retryNeedsYou(r: Pick<Retrying, 'cause' | 'attempt' | 'firstAt' | 'gaveUp'>, now: number): boolean {
  if (r.gaveUp) return true;
  if (!NEEDS_A_PERSON.has(r.cause)) return false;
  return r.attempt >= ALERT_FROM_ATTEMPT || now - r.firstAt >= ALERT_AFTER_MS;
}

/** The host the SDK is calling, when the daemon can read one. */
export function endpointHost(raw = process.env.ANTHROPIC_BASE_URL): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).host || undefined;
  } catch {
    return undefined;
  }
}

/** The single value in `xs`, or null when they differ or there are none. */
function onlyOne(xs: string[]): string | null {
  const set = new Set(xs);
  return set.size === 1 ? [...set][0]! : null;
}

export class Alerts {
  #db: Db;
  #retrying = new Map<string, Retrying>();
  #timer: NodeJS.Timeout | null = null;
  /** What every tab was last sent, so an event that changes nothing sends nothing. */
  #sent = '';
  #off: Array<() => void> = [];

  constructor(db: Db) {
    this.#db = db;
  }

  start(): void {
    this.#off.push(eventLog().subscribe((e) => this.#onEvent(e)));
    // Not the `dev_server` event: forgetting a server that is already down has none.
    this.#off.push(onServersChanged(() => this.refresh()));
    // The daily budget (Amendment 59): checked when the spend grows or the budget moves.
    this.#off.push(onCostChanged(() => this.refresh()));
    this.#off.push(onSettingsChanged((changed) => changed.includes(DAILY_KEY) && this.refresh()));
    // A note due tomorrow is due today after midnight, with nothing else changing.
    this.#atMidnight();
    // And every open page is told the new day's spend, so it reads 0 (Amendment 103).
    this.#off.push(startDayWatch(this.#db));
    this.#off.push(registerSnapshotContributor(() => ({ alerts: this.list() })));
    this.#sent = JSON.stringify(this.list());
  }

  stop(): void {
    for (const off of this.#off.splice(0)) off();
    if (this.#midnight) clearTimeout(this.#midnight);
    this.#midnight = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Every open alert, connection alerts first, the rest oldest first. */
  list(now = Date.now()): Alert[] {
    const derived = [...this.#agentAlerts(), ...this.#blockedDeps(), ...this.#heldHandoffs(), ...this.#serversDown()].sort(
      (a, b) => a.since.localeCompare(b.since),
    );
    return [...this.#daily(), ...this.#notesDue(), ...this.#connection(now), ...derived].filter((a) => !this.#dismissed(a.id));
  }

  #midnight: NodeJS.Timeout | null = null;

  /** Refresh just after each local midnight, so due notes and the budget's day turn over. */
  #atMidnight(): void {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    this.#midnight = setTimeout(() => {
      this.refresh();
      this.#atMidnight();
    }, next.getTime() - now.getTime());
    this.#midnight.unref();
  }

  /**
   * Notes due today or late, not done (Amendment 63). One alert per note, and its id
   * carries today's date, so dismissing it lasts the day and it asks again tomorrow if
   * it's still open. Ticking it done, or moving its date, clears it.
   */
  #notesDue(): Alert[] {
    const today = localDay();
    return dueNotes(this.#db, today).map((n) => ({
      id: `note:${n.id}:${today}`,
      kind: 'note_due' as const,
      cause: n.due! < today ? 'note late' : 'note due today',
      projectId: n.projectId,
      jobId: null,
      agentIds: [],
      since: n.createdAt,
      noteId: n.id,
      noteText: n.text,
      due: n.due!,
      late: n.due! < today,
    }));
  }

  /** When today's spend first reached the budget, per day, so `since` holds still. */
  #dailySince = new Map<string, string>();

  /**
   * Today's spend has reached the daily budget (Amendment 59). A warning only: nothing
   * is paused. One per day — its id carries the date — so dismissing it lasts the day,
   * and tomorrow starts clean.
   */
  #daily(): Alert[] {
    const budget = dailyBudget();
    if (budget === null) return [];
    const spent = costToday(this.#db);
    if (spent < budget) return [];
    const day = localDay();
    if (!this.#dailySince.has(day)) this.#dailySince.set(day, new Date().toISOString());
    return [
      {
        id: `daily:${day}`,
        kind: 'daily_budget',
        cause: 'daily budget reached',
        projectId: null,
        jobId: null,
        agentIds: [],
        since: this.#dailySince.get(day)!,
        spent,
        budget,
      },
    ];
  }

  /** False when there is no such open alert. */
  dismiss(id: string): boolean {
    const alert = this.list().find((a) => a.id === id);
    if (!alert) return false;
    const ids = [id];
    // An outage that gave up is standing in for its agents' failures, which come back
    // once the daemon restarts and forgets the outage. Put away together.
    if (alert.kind === 'connection' && alert.gaveUp) {
      for (const a of this.#agentAlerts(true)) {
        if (a.kind === 'failed' && alert.agentIds.includes(a.agentIds[0]!)) ids.push(a.id);
      }
    }
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO alert_dismissals (alert_id, dismissed_at) VALUES (?, ?)',
    );
    const at = new Date().toISOString();
    for (const x of ids) insert.run(x, at);
    this.refresh();
    return true;
  }

  /**
   * The model replied to this agent, so whatever it was retrying through is over — for
   * every agent it hit, since one outage is one alert (F10). Agents whose runs already
   * gave up stay: they still need someone to continue them.
   */
  modelAnswered(agentId: string): void {
    const r = this.#retrying.get(agentId);
    if (!r) return;
    for (const [id, other] of this.#retrying) {
      if (other.cause === r.cause && !other.gaveUp) this.#retrying.delete(id);
    }
    this.refresh();
  }

  /** Send every tab the list, if it changed since they were last sent it. */
  refresh(): void {
    const alerts = this.list();
    const key = JSON.stringify(alerts);
    this.#schedule();
    if (key === this.#sent) return;
    this.#sent = key;
    try {
      hub().broadcast({ type: 'alerts', alerts });
    } catch {
      // No hub outside the daemon. Not fatal.
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #onEvent(e: Event): void {
    const p = e.payload;
    if (p.kind === 'api_retry' && e.agentId) {
      const prev = this.#retrying.get(e.agentId);
      const at = Date.parse(e.ts);
      // The same trouble carries on; a different one starts its own clock.
      const continues = prev !== undefined && !prev.gaveUp && prev.cause === p.cause;
      this.#retrying.set(e.agentId, {
        agentId: e.agentId,
        projectId: e.projectId,
        jobId: e.jobId,
        cause: p.cause,
        attempt: p.attempt,
        maxRetries: p.maxRetries,
        firstAt: continues ? prev.firstAt : at,
        lastAt: at,
        gaveUp: false,
      });
      this.refresh();
    } else if (p.kind === 'status') {
      const r = e.agentId ? this.#retrying.get(e.agentId) : undefined;
      // Ending `failed` while still retrying is giving up. Anything else — a new run, a
      // pause, a stop — ends this agent's part in the outage.
      if (r && p.status === 'failed') r.gaveUp = true;
      else if (r) this.#retrying.delete(r.agentId);
      this.refresh();
    }
  }

  /** Re-check when an attempt-1 retry reaches ALERT_AFTER_MS without another retry. */
  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const now = Date.now();
    let next = Infinity;
    for (const r of this.#retrying.values()) {
      if (NEEDS_A_PERSON.has(r.cause) && !retryNeedsYou(r, now)) {
        next = Math.min(next, r.firstAt + ALERT_AFTER_MS);
      }
    }
    if (next === Infinity) return;
    this.#timer = setTimeout(() => this.refresh(), Math.max(0, next - now) + 50);
    this.#timer.unref();
  }

  #dismissed(id: string): boolean {
    return (
      row(this.#db.prepare('SELECT 1 AS x FROM alert_dismissals WHERE alert_id = ?').get(id)) !==
      undefined
    );
  }

  /** One alert per cause, across every agent it has hit. */
  #connection(now: number): Alert[] {
    const byCause = new Map<RetryCause, Retrying[]>();
    for (const r of this.#retrying.values()) {
      // Removed from Conductor while it was retrying: no one left to alert about.
      if (!getAgent(this.#db, r.agentId)) {
        this.#retrying.delete(r.agentId);
        continue;
      }
      if (!retryNeedsYou(r, now)) continue;
      byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
    }

    const endpoint = endpointHost();
    return [...byCause].map(([cause, group]) => {
      const latest = group.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));
      const since = new Date(Math.min(...group.map((r) => r.firstAt))).toISOString();
      const gaveUp = group.every((r) => r.gaveUp);
      return {
        // Giving up is news, so it gets its own id: dismissing the retries doesn't hide it.
        id: `connection:${cause}:${since}${gaveUp ? ':gave-up' : ''}`,
        kind: 'connection',
        cause,
        projectId: onlyOne(group.map((r) => r.projectId)),
        jobId: onlyOne(group.map((r) => r.jobId)),
        agentIds: group.map((r) => r.agentId),
        since,
        ...(endpoint ? { endpoint } : {}),
        attempt: latest.attempt,
        maxRetries: latest.maxRetries,
        gaveUp,
      };
    });
  }

  /**
   * Failed agents, and paused ones whose note says they stopped on a cap. An agent whose
   * retries gave up is left out unless `withOutage`: its failure is already on the
   * outage's alert, so it isn't told twice.
   */
  #agentAlerts(withOutage = false): Alert[] {
    const onOutage = new Set(
      withOutage ? [] : [...this.#retrying.values()].filter((r) => r.gaveUp).map((r) => r.agentId),
    );
    const out: Alert[] = [];
    for (const agent of listAgents(this.#db)) {
      if (agent.status !== 'failed' && agent.status !== 'paused') continue;
      if (onOutage.has(agent.id)) continue;

      const last = row<{ seq: number; ts: string; payload: string }>(
        this.#db
          .prepare(
            `SELECT seq, ts, payload FROM events WHERE agent_id = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`,
          )
          .get(agent.id),
      );
      const status = last ? (JSON.parse(last.payload) as StatusPayload) : null;
      const matches = status?.status === agent.status;
      const note = matches ? status?.error : undefined;

      let kind: Alert['kind'];
      let cause: string;
      if (agent.status === 'failed') {
        cause = note ?? 'error';
        // Before L9 a budget stop ended `failed`. It still needs a cap, not a diagnosis.
        kind = cause === 'budget_exhausted' ? 'budget' : 'failed';
      } else {
        const stop = budgetStop(note);
        if (!stop) continue;
        kind = 'budget';
        cause = stop;
      }

      out.push({
        id: `${kind}:${agent.id}:${last?.seq ?? 0}`,
        kind,
        cause,
        projectId: agent.projectId,
        jobId: agent.jobId,
        agentIds: [agent.id],
        since: (matches ? last?.ts : undefined) ?? agent.endedAt ?? agent.startedAt ?? '',
        ...(kind === 'failed' && matches && status?.detail ? { detail: status.detail } : {}),
      });
    }
    return out;
  }

  /**
   * Queued agents waiting on one that failed or was stopped (Amendment 85). Before this
   * the reviewer after a failed developer sat `queued` with nothing saying why. Since
   * Amendment 88 the ones waiting on a stopped agent are paused instead, and still alerted:
   * resuming runs them without it.
   *
   * It stays queued rather than failing too: continue the failed one and, once it is
   * done, the waiting one starts. One alert per waiting agent and dependency, on the
   * waiting agent; the id carries the dependency's last status event, so a dismissal
   * lasts until that one ends badly again. Clears itself when the dependency runs again
   * or the waiting agent leaves `queued`.
   */
  #blockedDeps(): Alert[] {
    const all = listAgents(this.#db);
    const byId = new Map(all.map((a) => [a.id, a]));
    const out: Alert[] = [];
    for (const agent of all) {
      if (agent.status !== 'queued' && agent.status !== 'paused') continue;
      for (const depId of agent.dependsOn) {
        const dep = byId.get(depId);
        // A helper's orchestrator already goes on without it (Amendment 51).
        if (!dep || dep.parentId === agent.id) continue;
        if (dep.status !== 'failed' && dep.status !== 'stopped') continue;
        // Paused, it is about a stopped one only: that pause is the one stopping it made
        // (Amendment 88). One you paused yourself behind a failed one is yours to wake.
        if (agent.status === 'paused' && dep.status !== 'stopped') continue;
        const last = row<{ seq: number; ts: string }>(
          this.#db
            .prepare(`SELECT seq, ts FROM events WHERE agent_id = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`)
            .get(dep.id),
        );
        out.push({
          id: `blocked_dep:${agent.id}:${dep.id}:${last?.seq ?? 0}`,
          kind: 'blocked_dep',
          cause: dep.status,
          projectId: agent.projectId,
          jobId: agent.jobId,
          agentIds: [agent.id],
          since: last?.ts ?? dep.endedAt ?? agent.startedAt ?? '',
          blockedBy: dep.id,
        });
      }
    }
    return out;
  }

  /**
   * Agents that ended their turn without handing off, with agents waiting for them
   * (Amendment 104). They are `done`, so the other alerts say nothing; the agents after them
   * are queued and would wait for good. One alert per held agent. It is derived from the
   * `handoff_held` column, so a daemon restart keeps it, and its id carries the agent's last
   * status event: a dismissal lasts until the agent is held again. It clears itself when the
   * agent hands off, is handed off for, or works again, and while no agent is left waiting
   * for it (the job was stopped, or they were removed) there is nothing to hand off to.
   */
  #heldHandoffs(): Alert[] {
    const out: Alert[] = [];
    const held = heldHandoffs(this.#db);
    if (held.length === 0) return out;
    const all = listAgents(this.#db);
    for (const id of held) {
      const agent = all.find((a) => a.id === id);
      if (agent?.status !== 'done') continue;
      if (!waitersOf(id, all).some((w) => w.status === 'queued' || w.status === 'paused')) continue;
      const last = row<{ seq: number; ts: string }>(
        this.#db.prepare(`SELECT seq, ts FROM events WHERE agent_id = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`).get(id),
      );
      out.push({
        id: `handoff_held:${id}:${last?.seq ?? 0}`,
        kind: 'handoff_held',
        cause: HANDOFF_HELD_NOTE,
        projectId: agent.projectId,
        jobId: agent.jobId,
        agentIds: [id],
        since: last?.ts ?? agent.endedAt ?? agent.startedAt ?? '',
      });
    }
    return out;
  }

  /** Dev servers whose last word was an unexpected `down`, and that are still registered. */
  #serversDown(): Alert[] {
    let servers;
    try {
      servers = preview().registry.all();
    } catch {
      return []; // Track D isn't mounted.
    }
    const out: Alert[] = [];
    for (const s of servers) {
      if (s.alive) continue;
      const last = row<{ seq: number; ts: string; payload: string }>(
        this.#db
          .prepare(
            `SELECT seq, ts, payload FROM events
              WHERE job_id = ? AND kind = 'dev_server' AND json_extract(payload, '$.port') = ?
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(s.jobId, s.port),
      );
      if (!last) continue;
      const p = JSON.parse(last.payload) as { event?: string; unexpected?: boolean };
      if (p.event !== 'down' || p.unexpected !== true) continue;
      out.push({
        id: `server_down:${s.jobId}:${s.port}:${last.seq}`,
        kind: 'server_down',
        cause: 'down',
        projectId: s.projectId || null,
        jobId: s.jobId,
        agentIds: s.startedByAgentId ? [s.startedByAgentId] : [],
        since: last.ts,
        port: s.port,
      });
    }
    return out;
  }
}

let instance: Alerts | null = null;

export function initAlerts(db: Db): Alerts {
  instance?.stop();
  instance = new Alerts(db);
  instance.start();
  return instance;
}

export function alerts(): Alerts {
  if (!instance) throw new Error('Alerts not initialised — call initAlerts(db) first');
  return instance;
}

/** For the runner, which also runs where alerts were never started. */
export function modelAnswered(agentId: string): void {
  instance?.modelAnswered(agentId);
}
