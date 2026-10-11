/**
 * The terminals (Amendment 112): real shells on pseudo-terminals, one or more per agent,
 * in the agent's job folder. The Agent screen's terminal tab shows them with xterm.js.
 *
 * Each is a process plus the last 512 KB of what it printed. A page that attaches (a first
 * visit, a reload, a switch back from another screen) is sent that buffer first and then
 * the live output, so it finds the shell as it left it. A terminal is NOT killed when the
 * page closes; it ends when its shell exits, when it is closed, when its agent or job is
 * removed, or when the daemon stops. At most 16 are live at once.
 *
 * This file knows nothing of HTTP or sockets: `routes/term.ts` gives it viewers. That keeps
 * the rules (the cap, the buffer, who is killed with what) testable against a real shell
 * without a server.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { TermInfo } from '@conductor/shared';
import { loadPty, ptyStatus, type Pty } from './pty.js';
import { Ring } from './ring.js';
import { pickShell, terminalEnv } from './shell.js';

export const MAX_TERMINALS = 16;
/** An ended shell stays listed this long, with its output, for a page that still has it open. */
export const EXITED_KEPT_MS = 10 * 60 * 1000;
/** Past this many entries, ended shells are forgotten oldest first, whatever their age. */
const MAX_ENTRIES = 2 * MAX_TERMINALS;
/** A shell is asked to hang up; this long later it is killed. */
const KILL_AFTER_MS = 3000;
/** A socket this far behind pauses the shell until it has caught up to the low mark. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const FLOW_POLL_MS = 25;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export class TermError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One attached page. The route gives the terminal a socket as a Viewer. */
export interface Viewer {
  send(data: Buffer): void;
  /** Bytes queued to the page and not yet sent: how far behind it is. */
  backlog(): number;
  close(code: number, reason: string): void;
}

interface Live {
  info: TermInfo;
  agentId: string;
  jobId: string;
  pty: Pty | null;
  ring: Ring;
  viewers: Set<Viewer>;
  /** The page is behind and the shell is paused until it catches up. */
  flow: NodeJS.Timeout | null;
  forget: NodeJS.Timeout | null;
  /** Called when the shell has exited. */
  gone: (() => void)[];
}

/** A size from a page: a whole number of cells, never absurd. */
export function clampSize(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(500, Math.max(1, Math.round(n))) : fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TerminalManager {
  #terms = new Map<string, Live>();

  /** Whether a full terminal can start, and if not, why (shown as the runner's banner). */
  available(): { available: boolean; reason?: string } {
    const s = ptyStatus();
    return s.available ? { available: true } : { available: false, reason: s.reason };
  }

  /** An agent's terminals, oldest first. */
  list(agentId: string): TermInfo[] {
    return [...this.#terms.values()]
      .filter((t) => t.agentId === agentId)
      .map((t) => ({ ...t.info }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): TermInfo | null {
    const t = this.#terms.get(id);
    return t ? { ...t.info } : null;
  }

  /** Shells running now; an ended one does not count against the cap. */
  get live(): number {
    let n = 0;
    for (const t of this.#terms.values()) if (!t.info.exited) n += 1;
    return n;
  }

  create(o: { agentId: string; jobId: string; cwd: string; cols?: number; rows?: number }): TermInfo {
    const status = ptyStatus();
    const pty = loadPty();
    if (!status.available || !pty) {
      throw new TermError(503, status.available ? 'the terminal library did not load' : status.reason);
    }
    if (this.live >= MAX_TERMINALS) {
      throw new TermError(409, `${MAX_TERMINALS} terminals are open already. Close one first.`);
    }
    if (!existsSync(o.cwd)) throw new TermError(410, `${o.cwd} is not there any more`);

    const shell = pickShell(process.env, existsSync);
    let p: Pty;
    try {
      p = pty.spawn(shell.file, shell.args, {
        cols: clampSize(o.cols, DEFAULT_COLS),
        rows: clampSize(o.rows, DEFAULT_ROWS),
        cwd: o.cwd,
        env: terminalEnv(process.env),
      });
    } catch (err) {
      throw new TermError(500, `the shell ${shell.file} could not start: ${err instanceof Error ? err.message : String(err)}`);
    }

    const t: Live = {
      info: {
        id: `term_${randomBytes(6).toString('hex')}`,
        cwd: o.cwd,
        startedAt: new Date().toISOString(),
        exited: false,
        exitCode: null,
      },
      agentId: o.agentId,
      jobId: o.jobId,
      pty: p,
      ring: new Ring(),
      viewers: new Set(),
      flow: null,
      forget: null,
      gone: [],
    };
    this.#terms.set(t.info.id, t);
    p.onData((data) => this.#data(t, data));
    p.onExit(({ exitCode }) => this.#ended(t, exitCode));
    this.#prune();
    return { ...t.info };
  }

  /**
   * Attach a page: the buffer first, then everything after it, with nothing between (both
   * happen in one turn). Null for an id nobody has. An ended shell gets its buffer and is
   * then closed on.
   */
  attach(id: string, viewer: Viewer): { detach(): void } | null {
    const t = this.#terms.get(id);
    if (!t) return null;
    const replay = t.ring.snapshot();
    if (replay.length > 0) viewer.send(replay);
    if (t.info.exited) {
      viewer.close(1000, 'exited');
      return { detach: () => undefined };
    }
    t.viewers.add(viewer);
    return { detach: () => void t.viewers.delete(viewer) };
  }

  /** Keys and paste, from any attached page. */
  write(id: string, data: string): void {
    const t = this.#terms.get(id);
    if (!t?.pty || t.info.exited) return;
    try {
      t.pty.write(data);
    } catch {
      /* the shell went between the check and the write; its exit is on the way */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.#terms.get(id);
    if (!t?.pty || t.info.exited) return;
    try {
      t.pty.resize(clampSize(cols, DEFAULT_COLS), clampSize(rows, DEFAULT_ROWS));
    } catch {
      /* ditto */
    }
  }

  /**
   * End a terminal and forget it. The shell is asked to hang up, and killed if it has not
   * gone in three seconds; the promise resolves when it has. False for an id nobody has.
   */
  async close(id: string): Promise<boolean> {
    const t = this.#terms.get(id);
    if (!t) return false;
    this.#terms.delete(id);
    if (t.forget) clearTimeout(t.forget);
    for (const v of [...t.viewers]) v.close(1000, 'closed');
    t.viewers.clear();
    await this.#stop(t);
    return true;
  }

  /** An agent was removed: its terminals go with it. Not waited for. */
  closeAgent(agentId: string): number {
    return this.#closeWhere((t) => t.agentId === agentId);
  }

  /** A job was removed: so are the terminals of all its agents. */
  closeJob(jobId: string): number {
    return this.#closeWhere((t) => t.jobId === jobId);
  }

  /** The daemon is stopping: every shell is ended, and none is left behind. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#terms.keys()].map((id) => this.close(id)));
  }

  #closeWhere(test: (t: Live) => boolean): number {
    const ids = [...this.#terms.values()].filter(test).map((t) => t.info.id);
    for (const id of ids) void this.close(id).catch(() => undefined);
    return ids.length;
  }

  async #stop(t: Live): Promise<void> {
    if (t.flow) clearInterval(t.flow);
    t.flow = null;
    const p = t.pty;
    if (!p || t.info.exited) return;
    const gone = new Promise<void>((resolve) => t.gone.push(resolve));
    // A paused shell is not reading its terminal, and would not see the hang-up.
    try {
      p.resume();
    } catch {
      /* already closing */
    }
    try {
      p.kill('SIGHUP');
    } catch {
      /* it is going */
    }
    const hungUp = await Promise.race([gone.then(() => true), sleep(KILL_AFTER_MS).then(() => false)]);
    if (hungUp) return;
    try {
      p.kill('SIGKILL');
    } catch {
      /* gone meanwhile */
    }
    await Promise.race([gone, sleep(1000)]);
  }

  #data(t: Live, data: Buffer): void {
    t.ring.push(data);
    for (const v of t.viewers) {
      try {
        v.send(data);
      } catch {
        t.viewers.delete(v);
      }
    }
    this.#throttle(t);
  }

  /**
   * A page that cannot keep up (a `cat` of a huge file, a slow link) would let its socket's
   * queue grow without bound. Past a megabyte behind, the shell is paused and resumed once
   * every page is down to a quarter of that. The buffer is written either way.
   */
  #throttle(t: Live): void {
    if (t.flow || !t.pty) return;
    const behind = () => Math.max(0, ...[...t.viewers].map((v) => v.backlog()));
    if (behind() < HIGH_WATER) return;
    const p = t.pty;
    p.pause();
    t.flow = setInterval(() => {
      if (!t.info.exited && behind() >= LOW_WATER) return;
      if (t.flow) clearInterval(t.flow);
      t.flow = null;
      if (!t.info.exited) p.resume();
    }, FLOW_POLL_MS);
  }

  #ended(t: Live, exitCode: number): void {
    if (t.info.exited) return;
    t.info.exited = true;
    t.info.exitCode = exitCode;
    t.pty = null;
    if (t.flow) clearInterval(t.flow);
    t.flow = null;
    for (const v of [...t.viewers]) v.close(1000, 'exited');
    t.viewers.clear();
    for (const done of t.gone.splice(0)) done();
    // Closed already: it was forgotten then. Otherwise it stays, with its output, for a while.
    if (this.#terms.get(t.info.id) === t) {
      t.forget = setTimeout(() => this.#terms.delete(t.info.id), EXITED_KEPT_MS);
      t.forget.unref();
    }
  }

  /** Forget the oldest ended shells once there are more entries than anyone needs. */
  #prune(): void {
    if (this.#terms.size <= MAX_ENTRIES) return;
    const ended = [...this.#terms.values()].filter((t) => t.info.exited).sort((a, b) => a.info.startedAt.localeCompare(b.info.startedAt));
    for (const t of ended) {
      if (this.#terms.size <= MAX_ENTRIES) break;
      if (t.forget) clearTimeout(t.forget);
      this.#terms.delete(t.info.id);
    }
  }
}

let instance: TerminalManager | null = null;

/** The one set of terminals. */
export function terminals(): TerminalManager {
  instance ??= new TerminalManager();
  return instance;
}
