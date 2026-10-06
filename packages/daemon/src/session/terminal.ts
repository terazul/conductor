/**
 * A command runner in an agent's folder — the Agent screen's terminal.  TRACK A.
 * (Amendment 58)
 *
 * Chosen over a real terminal by the user: no new dependency, and nothing interactive.
 * Each command runs in `$SHELL -c` in the agent's job folder, with no input (a prompt
 * reads end-of-file), and its output streams to every tab as text, batched. It runs as
 * you, with your permissions, not an agent's: the localhost guard and CONDUCTOR_TOKEN
 * are what stand in front of it, and the panel says so.
 *
 * One command at a time per agent. Output is kept in memory, the last RUNS_KEPT runs per
 * agent, each capped at OUTPUT_CAP, so switching screens or reloading shows what ran; a
 * daemon restart forgets it, and stops what was running.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TerminalChunk, TerminalRun } from '@conductor/shared';

export const OUTPUT_CAP = 256 * 1024;
export const RUNS_KEPT = 20;
const FLUSH_MS = 50;
const KILL_AFTER_MS = 3000;

interface Live {
  run: TerminalRun;
  output: TerminalChunk[];
  size: number;
  child: ChildProcess | null;
  pending: TerminalChunk[];
  timer: NodeJS.Timeout | null;
}

export interface TerminalSink {
  run(run: TerminalRun): void;
  out(agentId: string, runId: string, chunk: TerminalChunk): void;
}

let seq = 0;

export class Terminal {
  #runs = new Map<string, Live[]>();
  #sink: TerminalSink;

  constructor(sink: TerminalSink) {
    this.#sink = sink;
  }

  /** What ran for an agent, oldest first, output included. */
  history(agentId: string): (TerminalRun & { output: TerminalChunk[] })[] {
    return (this.#runs.get(agentId) ?? []).map((l) => ({ ...l.run, output: l.output }));
  }

  running(agentId: string): TerminalRun | null {
    return this.#runs.get(agentId)?.find((l) => l.run.endedAt === null)?.run ?? null;
  }

  start(agentId: string, command: string, cwd: string): TerminalRun {
    const cmd = command.trim();
    if (!cmd) throw new TerminalError(400, 'type a command');
    if (!existsSync(cwd)) throw new TerminalError(410, `${cwd} is not there any more`);
    const busy = this.running(agentId);
    if (busy) throw new TerminalError(409, `"${busy.command}" is still running — stop it first`);

    const run: TerminalRun = {
      id: `term_${Date.now().toString(36)}_${(seq += 1)}`,
      agentId,
      command: cmd,
      cwd,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
    };
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' };
    // Conductor's own credential is not the command's business.
    delete env['CONDUCTOR_TOKEN'];
    // Its own process group, so a stop reaches what the shell started, not only the shell.
    const child = spawn(process.env['SHELL'] || '/bin/sh', ['-c', cmd], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const live: Live = { run, output: [], size: 0, child, pending: [], timer: null };
    const list = this.#runs.get(agentId) ?? [];
    list.push(live);
    while (list.length > RUNS_KEPT) list.shift();
    this.#runs.set(agentId, list);

    const take = (stream: 'out' | 'err') => (buf: Buffer) => this.#take(live, stream, buf.toString('utf8'));
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', (err) => {
      this.#take(live, 'err', `${err.message}\n`);
      this.#end(live, null, null);
    });
    child.on('close', (code, signal) => this.#end(live, code, signal));
    this.#sink.run(run);
    return run;
  }

  /** Ctrl-C: SIGINT to the whole group, then SIGKILL if it hasn't gone. */
  stop(runId: string): TerminalRun {
    const live = [...this.#runs.values()].flat().find((l) => l.run.id === runId);
    if (!live) throw new TerminalError(404, 'no such command');
    if (live.run.endedAt !== null || !live.child?.pid) return live.run;
    const pid = live.child.pid;
    const signal = (s: NodeJS.Signals): void => {
      try {
        process.kill(-pid, s);
      } catch {
        // Already gone.
      }
    };
    signal('SIGINT');
    setTimeout(() => {
      if (live.run.endedAt === null) signal('SIGKILL');
    }, KILL_AFTER_MS).unref();
    return live.run;
  }

  /** Forget an agent's runs — the clear button. Refused while one runs. */
  clear(agentId: string): void {
    if (this.running(agentId)) throw new TerminalError(409, 'a command is still running — stop it first');
    this.#runs.delete(agentId);
  }

  /** Stop everything — the daemon is going. */
  shutdown(): void {
    for (const l of [...this.#runs.values()].flat()) if (l.run.endedAt === null && l.child?.pid) {
      try {
        process.kill(-l.child.pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }

  #take(live: Live, stream: 'out' | 'err', text: string): void {
    if (live.run.cut) return;
    let t = text;
    if (live.size + t.length > OUTPUT_CAP) {
      t = t.slice(0, Math.max(0, OUTPUT_CAP - live.size));
      live.run = { ...live.run, cut: true };
    }
    live.size += t.length;
    if (t) {
      const last = live.output.at(-1);
      if (last && last.stream === stream) last.text += t;
      else live.output.push({ stream, text: t });
      const p = live.pending.at(-1);
      if (p && p.stream === stream) p.text += t;
      else live.pending.push({ stream, text: t });
    }
    live.timer ??= setTimeout(() => this.#flush(live), FLUSH_MS);
  }

  #flush(live: Live): void {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    for (const c of live.pending.splice(0)) this.#sink.out(live.run.agentId, live.run.id, c);
  }

  #end(live: Live, code: number | null, signal: NodeJS.Signals | null): void {
    if (live.run.endedAt !== null) return;
    this.#flush(live);
    live.child = null;
    live.run = { ...live.run, endedAt: new Date().toISOString(), exitCode: code, signal: signal ?? null };
    this.#sink.run(live.run);
  }
}

export class TerminalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
