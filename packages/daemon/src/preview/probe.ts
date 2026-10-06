/**
 * Port probing — the step that turns a guess into a fact.
 *
 * TRACK D OWNS THIS FILE.
 *
 * `detect.ts` proposes candidate ports from an agent's shell command. Nothing is
 * registered, and the proxy forwards nothing, until this module confirms that
 * something is really listening on loopback at that port.
 *
 * SECURITY. This is half of the SSRF guard (the other half is
 * `PreviewProxy`'s upstream resolution, which refuses any port not in the
 * registry). Two invariants hold here:
 *
 *   1. LOOPBACK ONLY. Every probe and every proxy target is one of the two
 *      loopback literals below. No hostname from a command, a request, or a
 *      config is ever resolved or dialled. A preview proxy that can be pointed
 *      at an arbitrary host is a hole straight through the user's network from a
 *      browser tab.
 *   2. NEVER OURSELVES. Proxying the daemon's own port is an infinite loop that
 *      exhausts the event loop, so the daemon's port is refused outright.
 *
 * WHY BOTH LOOPBACK FAMILIES
 * ──────────────────────────
 * Probing only `127.0.0.1` is the obvious implementation and it fails silently on
 * a large fraction of machines. A dev server told to listen on `localhost` binds
 * ONE address, and on macOS `/etc/hosts` maps `localhost` to both `127.0.0.1` and
 * `::1` — so Vite routinely ends up on `[::1]:5173` and nothing else. An IPv4-only
 * probe then reports "no dev server" for a server that is running perfectly, which
 * is indistinguishable from the bug this whole track exists to fix. So both
 * families are tried, and the one that answered is remembered and used as the
 * proxy target.
 */

import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { DEFAULT_PORT } from '@conductor/shared';

/**
 * The ONLY hosts this track ever connects to. Not configurable, deliberately —
 * this list is the SSRF boundary, so it is a constant and not an option.
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

/** Kept for readability at call sites that just want the default. */
export const LOOPBACK: LoopbackHost = '127.0.0.1';

export function isLoopbackHost(host: string): host is LoopbackHost {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/** `http://127.0.0.1:3000` or `http://[::1]:3000`. IPv6 needs the brackets. */
export function originFor(host: string, port: number): string {
  const safe = isLoopbackHost(host) ? host : LOOPBACK;
  return safe.includes(':') ? `http://[${safe}]:${port}` : `http://${safe}:${port}`;
}

const CONNECT_TIMEOUT_MS = 400;
const HTTP_TIMEOUT_MS = 1_500;

/** The daemon's own port, which must never become a proxy target. */
function ownPort(): number {
  return Number(process.env['CONDUCTOR_PORT'] ?? DEFAULT_PORT);
}

/**
 * Is this a port we are willing to talk to at all? Checked before probing and
 * again before proxying, because the registry is reachable from a route handler
 * and defence in depth is cheap here.
 */
export function isAllowedPort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (port === ownPort()) return false;
  return true;
}

/** TCP connect to one loopback family. Cheap, and enough to know it's bound. */
function connectTo(host: LoopbackHost, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Which loopback family has something bound to this port, if any.
 * Returns the host that answered so callers can dial the same one.
 */
export async function listeningHost(port: number): Promise<LoopbackHost | null> {
  if (!isAllowedPort(port)) return null;
  for (const host of LOOPBACK_HOSTS) {
    if (await connectTo(host, port)) return host;
  }
  return null;
}

/** Convenience for callers that only need the boolean. */
export async function isListening(port: number): Promise<boolean> {
  return (await listeningHost(port)) !== null;
}

export interface HttpProbe {
  ok: boolean;
  /** Which loopback family answered. The proxy must use this one. */
  host?: LoopbackHost;
  status?: number;
  /** `server` response header, when the upstream sends one. */
  server?: string;
}

/**
 * Confirm the listener speaks HTTP. A TCP-only check would happily register a
 * database or an SSH daemon, and the preview pane would then show a binary
 * blob. Any HTTP status counts — a dev server that 404s its root is still a dev
 * server worth proxying.
 */
export async function probeHttp(port: number): Promise<HttpProbe> {
  if (!isAllowedPort(port)) return { ok: false };

  for (const host of LOOPBACK_HOSTS) {
    if (!(await connectTo(host, port))) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${originFor(host, port)}/`, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'conductor-preview-probe' },
      });
      // Drain so the socket is released rather than left half-read.
      await res.arrayBuffer().catch(() => undefined);
      const serverHeader = res.headers.get('server');
      return {
        ok: true,
        host,
        status: res.status,
        ...(serverHeader ? { server: serverHeader } : {}),
      };
    } catch {
      // Bound but not speaking HTTP on this family — try the other.
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false };
}

/**
 * Which pid owns the listening socket.
 *
 * The Bash tool hands us a command, never a process, so the pid the UI needs
 * for "stop server" has to be recovered from the port. `lsof` is the portable
 * way to do that on macOS and Linux. Best-effort: a null pid only costs the
 * stop button, never the preview itself.
 */
export function pidForPort(port: number): Promise<number | null> {
  if (!isAllowedPort(port)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'lsof',
      // No -4/-6 filter: the server may be bound to either family, and we want
      // the pid regardless of which one answered the probe.
      ['-ti', `tcp:${port}`, '-sTCP:LISTEN'],
      { timeout: 2_000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // Several pids can share a listening socket (a forked master). The
        // lowest is the parent, which is the one worth signalling.
        const pids = stdout
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b);
        resolve(pids[0] ?? null);
      },
    );
  });
}

/**
 * Wait for one of `ports` to come up, then return it.
 *
 * A dev server takes seconds to bind — Vite is quick, Next and Webpack are not —
 * so a single probe at the moment the command starts would almost always miss.
 * We poll the whole candidate set until one answers or the budget runs out.
 */
export async function waitForAnyPort(
  ports: readonly number[],
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  const allowed = ports.filter(isAllowedPort);
  if (allowed.length === 0) return null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    for (const port of allowed) {
      const probe = await probeHttp(port);
      if (probe.ok) return port;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Signal a dev server. SIGTERM first so the framework can clean up; the caller
 * decides whether to escalate. Returns false when the pid is already gone.
 */
export function stopPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
