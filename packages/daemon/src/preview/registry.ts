/**
 * ServerRegistry — the daemon's knowledge of which dev servers are running.
 *
 * TRACK D OWNS THIS FILE.
 *
 * WHY THIS IS NOT JUST A CONFIG FIELD
 * ───────────────────────────────────
 * Nobody tells Conductor the port. The agent decides it — by running
 * `npm run dev`, or `vite --port 4000`, or whatever the repo's script happens to
 * do — and it can change between runs when a port is already taken. Asking the
 * human to type it in defeats the point of the screen, which is to see the change
 * land without alt-tabbing or guessing.
 *
 * So the registry learns it, from three sources in descending order of certainty:
 *
 *   1. The agent's own shell commands. Track A emits `tool_start` for every Bash
 *      call (PLAN.md §1 finding A: the async PreToolUse hook sees auto-approved
 *      calls, so this works under `acceptEdits` where `canUseTool` would be
 *      silent). `detect.ts` turns a command into candidate ports.
 *   2. A live probe. A candidate is only ever a guess; `probe.ts` confirms
 *      something is listening and speaking HTTP before anything is registered.
 *   3. Explicit registration, for the case where detection missed and for driving
 *      the track before Track A lands.
 *
 * WHAT IT GUARANTEES THE PROXY
 * ────────────────────────────
 * `upstreamFor(jobId, port)` is the proxy's only source of targets, and it returns
 * one only for a (job, port) pair that was detected for THAT job and confirmed
 * alive. That is the SSRF guard: a request for `/preview/<job>/…` cannot reach a
 * port the job never opened, and no request can name a host at all.
 */

import type { DevServer } from '@conductor/shared';
import { eventLog } from '../eventlog.js';
import { hub } from '../hub.js';
import { rows, type Db } from '../db/index.js';
import { commandFromToolInput, detectLaunch } from './detect.js';
import {
  isAllowedPort,
  isLoopbackHost,
  listeningHost,
  originFor,
  pidForPort,
  probeHttp,
  stopPid,
  waitForAnyPort,
  type LoopbackHost,
} from './probe.js';

/** How often live servers are re-checked. */
const LIVENESS_INTERVAL_MS = 5_000;

/** How long to keep probing candidate ports after a launch command. */
const LAUNCH_WAIT_MS = 45_000;

interface ServerRow {
  job_id: string;
  port: number;
  host: string;
  pid: number | null;
  started_by_agent_id: string | null;
  project_id: string;
  command: string | null;
  kind: string | null;
  detected_at: string;
  last_seen_at: string;
  alive: number;
}

/** Everything the registry knows about one server. Superset of the wire type. */
export interface RegisteredServer extends DevServer {
  projectId: string;
  command: string | null;
  kind: string | null;
  lastSeenAt: string;
  /** The loopback family that answered the probe. The proxy must dial this one. */
  host: LoopbackHost;
}

export function proxyPathFor(jobId: string): string {
  return `/preview/${encodeURIComponent(jobId)}`;
}

function toRegistered(r: ServerRow): RegisteredServer {
  return {
    jobId: r.job_id,
    port: r.port,
    pid: r.pid,
    proxyPath: proxyPathFor(r.job_id),
    startedByAgentId: r.started_by_agent_id,
    detectedAt: r.detected_at,
    alive: r.alive === 1,
    projectId: r.project_id,
    command: r.command,
    kind: r.kind,
    lastSeenAt: r.last_seen_at,
    host: isLoopbackHost(r.host) ? r.host : '127.0.0.1',
  };
}

export interface RegisterInput {
  jobId: string;
  projectId?: string;
  port: number;
  /** Normally discovered by the probe; only set when re-confirming a known row. */
  host?: LoopbackHost;
  startedByAgentId?: string | null;
  command?: string | null;
  kind?: string | null;
}

export class ServerRegistry {
  #db: Db;
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  /** jobIds with a launch probe in flight, so a retried command doesn't stack. */
  #probing = new Set<string>();

  constructor(db: Db) {
    this.#db = db;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Subscribe to the event log, re-probe anything persisted from a previous run,
   * and start the liveness loop.
   *
   * The re-probe matters: the daemon can restart while the agent's `npm run dev`
   * keeps running. Without it the Preview screen would go blank on every daemon
   * restart even though the server is perfectly healthy.
   */
  start(): void {
    this.#unsubscribe = eventLog().subscribe((event) => {
      const payload = event.payload;
      if (payload.kind !== 'tool_start') return;
      if (payload.tool !== 'Bash' && payload.tool !== 'BashOutput') return;
      const command = commandFromToolInput(payload.input);
      if (!command) return;
      const launch = detectLaunch(command);
      if (!launch) return;

      void this.#onLaunchDetected({
        jobId: event.jobId,
        projectId: event.projectId,
        agentId: event.agentId,
        ports: launch.candidatePorts,
        command: launch.command,
        kind: launch.kind,
      });
    });

    void this.#resurrect();

    this.#timer = setInterval(() => void this.#sweep(), LIVENESS_INTERVAL_MS);
    this.#timer.unref?.();
  }

  /** Detach from the event log and stop the liveness loop. Daemon shutdown. */
  shutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Every known server. Dead ones are included so the UI can say "was on 3000". */
  all(): RegisteredServer[] {
    return rows<ServerRow>(
      this.#db.prepare(`SELECT * FROM dev_servers ORDER BY job_id, port`).all(),
    ).map(toRegistered);
  }

  forJob(jobId: string): RegisteredServer[] {
    return rows<ServerRow>(
      this.#db
        .prepare(`SELECT * FROM dev_servers WHERE job_id = ? ORDER BY alive DESC, port`)
        .all(jobId),
    ).map(toRegistered);
  }

  /** The wire shape, live servers first. Feeds the snapshot and the REST route. */
  wire(jobId?: string): DevServer[] {
    const list = jobId ? this.forJob(jobId) : this.all();
    return list.map((s) => ({
      jobId: s.jobId,
      port: s.port,
      // Amendment 6 put this on the wire. The registry always knew which
      // loopback family answered the probe; before the amendment the UI had to
      // guess, and guessing `127.0.0.1` is wrong for every `::1`-only server.
      host: s.host,
      pid: s.pid,
      proxyPath: s.proxyPath,
      startedByAgentId: s.startedByAgentId,
      detectedAt: s.detectedAt,
      alive: s.alive,
    }));
  }

  /**
   * THE SECURITY GATE. The proxy's only way to learn a target.
   *
   * Returns an origin only when the (job, port) pair is registered AND alive AND
   * the port passes the loopback/self checks. Everything else returns null and
   * the proxy answers 404. No caller can supply a host.
   */
  upstreamFor(jobId: string, port?: number): string | null {
    const live = this.forJob(jobId).filter((s) => s.alive);
    const chosen =
      port === undefined ? live[0] : live.find((s) => s.port === port);
    if (!chosen) return null;
    if (!isAllowedPort(chosen.port)) return null;
    // `originFor` re-validates the host against the loopback allow-list, so a
    // bad row cannot widen the target even though the schema also CHECKs it.
    return originFor(chosen.host, chosen.port);
  }

  /** The (host, port) the proxy would dial, for header rewriting and the UI. */
  activeTarget(jobId: string): { host: LoopbackHost; port: number } | null {
    const chosen = this.forJob(jobId).find((s) => s.alive);
    return chosen ? { host: chosen.host, port: chosen.port } : null;
  }

  /** The port the proxy would use for this job, for building URLs in the UI. */
  activePort(jobId: string): number | null {
    return this.activeTarget(jobId)?.port ?? null;
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Register a confirmed server. Idempotent on (jobId, port): a server that was
   * marked dead and came back is revived rather than duplicated, and only a
   * genuine transition emits a `dev_server` event.
   */
  async register(input: RegisterInput): Promise<RegisteredServer | null> {
    if (!isAllowedPort(input.port)) return null;
    // The probe is what turns a candidate into a fact, AND what tells us which
    // loopback family to dial. Never trust a caller-supplied host over it.
    const http = await probeHttp(input.port);
    if (!http.ok) return null;
    const host: LoopbackHost = http.host ?? input.host ?? '127.0.0.1';

    const pid = await pidForPort(input.port);
    const now = new Date().toISOString();

    const existing = rows<ServerRow>(
      this.#db
        .prepare(`SELECT * FROM dev_servers WHERE job_id = ? AND port = ?`)
        .all(input.jobId, input.port),
    )[0];

    const wasAlive = existing?.alive === 1;

    this.#db
      .prepare(
        `INSERT INTO dev_servers
           (job_id, port, host, pid, started_by_agent_id, project_id, command, kind,
            detected_at, last_seen_at, alive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(job_id, port) DO UPDATE SET
           host = excluded.host,
           pid = excluded.pid,
           started_by_agent_id = COALESCE(excluded.started_by_agent_id, dev_servers.started_by_agent_id),
           project_id = CASE WHEN excluded.project_id <> '' THEN excluded.project_id ELSE dev_servers.project_id END,
           command = COALESCE(excluded.command, dev_servers.command),
           kind = COALESCE(excluded.kind, dev_servers.kind),
           last_seen_at = excluded.last_seen_at,
           alive = 1`,
      )
      .run(
        input.jobId,
        input.port,
        host,
        pid,
        input.startedByAgentId ?? null,
        input.projectId ?? existing?.project_id ?? '',
        input.command ?? null,
        input.kind ?? null,
        existing?.detected_at ?? now,
        now,
      );

    const server = this.forJob(input.jobId).find((s) => s.port === input.port) ?? null;

    if (server && !wasAlive) {
      eventLog().emit(
        {
          projectId: server.projectId || (input.projectId ?? ''),
          jobId: input.jobId,
          // A dev server belongs to the job, not to one agent — the frozen
          // contract says agentId is null for job-scoped events.
          agentId: null,
        },
        {
          kind: 'dev_server',
          event: 'up',
          port: input.port,
          ...(pid !== null ? { pid } : {}),
          ...(input.startedByAgentId ? { startedByAgentId: input.startedByAgentId } : {}),
        },
      );
      this.#broadcast();
    }

    return server;
  }

  /**
   * Mark a server dead and announce it. No-op when it was already dead.
   *
   * `unexpected` only from the liveness sweep: it stopped answering and nobody asked it
   * to stop, which raises an alert (F13). A stop, a forget or a boot-time re-probe is not
   * news to anyone.
   */
  markDown(jobId: string, port: number, unexpected = false): void {
    const existing = this.forJob(jobId).find((s) => s.port === port);
    if (!existing || !existing.alive) return;

    this.#db
      .prepare(`UPDATE dev_servers SET alive = 0, last_seen_at = ? WHERE job_id = ? AND port = ?`)
      .run(new Date().toISOString(), jobId, port);

    eventLog().emit(
      { projectId: existing.projectId, jobId, agentId: null },
      {
        kind: 'dev_server',
        event: 'down',
        port,
        ...(existing.pid !== null ? { pid: existing.pid } : {}),
        ...(existing.startedByAgentId ? { startedByAgentId: existing.startedByAgentId } : {}),
        ...(unexpected ? { unexpected: true } : {}),
      },
    );
    this.#broadcast();
  }

  /**
   * Stop a server on the human's behalf. SIGTERM, then verify: a dev server that
   * ignores the signal must not leave the UI claiming it was stopped.
   */
  async stop(jobId: string, port: number): Promise<{ stopped: boolean; reason?: string }> {
    const server = this.forJob(jobId).find((s) => s.port === port);
    if (!server) return { stopped: false, reason: 'not registered for this job' };
    if (server.pid === null) {
      return { stopped: false, reason: 'pid unknown — stop it from the terminal that started it' };
    }
    if (!stopPid(server.pid, 'SIGTERM')) {
      // Already gone. Reconcile rather than report a failure.
      this.markDown(jobId, port);
      return { stopped: true };
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if ((await listeningHost(port)) === null) {
        this.markDown(jobId, port);
        return { stopped: true };
      }
    }
    return { stopped: false, reason: 'still listening after SIGTERM' };
  }

  /**
   * Drop every row for a job without saying anything about the processes.
   *
   * `forget(jobId, port)` marks the server down first, because a human clicking
   * "forget" has decided it is gone. This is the other caller: a project being
   * removed from Conductor while its dev server may still be happily listening.
   * Emitting `down` would put a false statement into an append-only log, and
   * SIGTERM-ing it would be exactly the "reaches onto your machine" that the
   * remove-project contract promises not to do. So: rows out, one broadcast,
   * process untouched. If it is still serving, the next launch detection finds
   * it again.
   */
  forgetJob(jobId: string): number {
    const { changes } = this.#db.prepare(`DELETE FROM dev_servers WHERE job_id = ?`).run(jobId);
    this.#probing.delete(jobId);
    const dropped = Number(changes);
    if (dropped > 0) this.#broadcast();
    return dropped;
  }

  forget(jobId: string, port: number): void {
    this.markDown(jobId, port);
    this.#db.prepare(`DELETE FROM dev_servers WHERE job_id = ? AND port = ?`).run(jobId, port);
    this.#broadcast();
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #onLaunchDetected(args: {
    jobId: string;
    projectId: string;
    agentId: string | null;
    ports: readonly number[];
    command: string;
    kind: string;
  }): Promise<void> {
    // Already serving this job? A repeated `pnpm dev` is usually a restart of
    // the same thing; the liveness sweep will notice if the port moved.
    const key = `${args.jobId}`;
    if (this.#probing.has(key)) return;
    this.#probing.add(key);
    try {
      const port = await waitForAnyPort(args.ports, { timeoutMs: LAUNCH_WAIT_MS });
      if (port === null) return;
      await this.register({
        jobId: args.jobId,
        projectId: args.projectId,
        port,
        startedByAgentId: args.agentId,
        command: args.command,
        kind: args.kind,
      });
    } finally {
      this.#probing.delete(key);
    }
  }

  /** Re-confirm everything persisted from a previous daemon run. */
  async #resurrect(): Promise<void> {
    for (const server of this.all()) {
      const http = await probeHttp(server.port);
      if (http.ok) {
        await this.register({
          jobId: server.jobId,
          projectId: server.projectId,
          port: server.port,
          host: server.host,
          startedByAgentId: server.startedByAgentId,
          command: server.command,
          kind: server.kind,
        });
      } else if (server.alive) {
        this.markDown(server.jobId, server.port);
      }
    }
  }

  /** Periodic liveness. Cheap TCP connect; only transitions cost anything. */
  async #sweep(): Promise<void> {
    const now = new Date().toISOString();
    for (const server of this.all()) {
      const up = (await listeningHost(server.port)) !== null;
      if (up && !server.alive) {
        await this.register({
          jobId: server.jobId,
          projectId: server.projectId,
          port: server.port,
          host: server.host,
          startedByAgentId: server.startedByAgentId,
          command: server.command,
          kind: server.kind,
        });
      } else if (up) {
        this.#db
          .prepare(`UPDATE dev_servers SET last_seen_at = ? WHERE job_id = ? AND port = ?`)
          .run(now, server.jobId, server.port);
      } else if (server.alive) {
        this.markDown(server.jobId, server.port, true);
      }
    }
  }

  #broadcast(): void {
    for (const fn of changeListeners) fn();
    try {
      hub().broadcast({ type: 'servers', servers: this.wire() });
    } catch {
      // The hub isn't up during unit-style use of the registry. Not fatal.
    }
  }
}

const changeListeners = new Set<() => void>();

/**
 * Called whenever the server list changes, including a forget, which has no event.
 * Module-level rather than on the instance so a caller need not be started after Track D.
 */
export function onServersChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

let instance: ServerRegistry | null = null;

export function initServerRegistry(db: Db): ServerRegistry {
  instance = new ServerRegistry(db);
  instance.start();
  return instance;
}

export function serverRegistry(): ServerRegistry {
  if (!instance) throw new Error('ServerRegistry not initialised — call initServerRegistry(db)');
  return instance;
}
