/**
 * The one door to the native pseudo-terminal library (Amendment 112).
 *
 * `@lydell/node-pty` is a native module, prebuilt for darwin and linux on x64 and arm64, so
 * nothing is compiled. It can still fail to load (installed with `--no-optional`, a
 * `node_modules` copied from another machine), and a terminal that cannot start must not
 * take the daemon with it. So it is loaded here, lazily, and `loadPty()` returns null when it
 * will not: the Agent screen then shows the command runner, with `ptyStatus().reason` as the
 * banner. Swapping the library for another is a change to this file alone.
 *
 * Only macOS and Ubuntu are built and tested. On Windows the library would load, but nothing
 * here has run there, so it is reported unavailable and the runner is the terminal.
 */

import { createRequire } from 'node:module';

/** A running shell, narrowed to what the terminal uses. */
export interface Pty {
  readonly pid: number;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawn {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawn): Pty;
}

export type PtyStatus = { available: true } | { available: false; reason: string };

let loaded: { mod: PtyModule } | { reason: string } | null = null;
/** For verify: pretend the library will not load. */
let forced: string | null = null;
/** For verify: a stand-in for the library, so a suite can hold a shell without a real PTY. */
let stubbed: PtyModule | null = null;

/** The first line of what a failed load said, trimmed to something a banner can carry. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.trim().split('\n')[0] ?? '').slice(0, 300) || 'unknown error';
}

function load(): { mod: PtyModule } | { reason: string } {
  if (loaded) return loaded;
  try {
    const raw = createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty');
    loaded = {
      mod: {
        spawn(file, args, o) {
          // `encoding: null` hands output over as bytes: a UTF-8 character cut between two reads
          // stays whole in the browser's decoder instead of becoming two replacement marks here.
          const p = raw.spawn(file, args, {
            name: 'xterm-256color',
            cols: o.cols,
            rows: o.rows,
            cwd: o.cwd,
            env: o.env,
            encoding: null,
          });
          return {
            pid: p.pid,
            onData: (cb) => void p.onData((d) => cb(typeof d === 'string' ? Buffer.from(d, 'utf8') : (d as unknown as Buffer))),
            onExit: (cb) => void p.onExit(cb),
            write: (d) => p.write(d),
            resize: (c, r) => p.resize(c, r),
            kill: (s) => p.kill(s),
            pause: () => p.pause(),
            resume: () => p.resume(),
          };
        },
      },
    };
  } catch (err) {
    loaded = {
      reason: `The terminal library (@lydell/node-pty) did not load on ${process.platform}-${process.arch}: ${firstLine(err)}. Reinstall with pnpm install, without --no-optional`,
    };
  }
  return loaded;
}

/** Whether a full terminal can start here, and if not, the sentence that says why. */
export function ptyStatus(platform: string = process.platform): PtyStatus {
  if (forced !== null) return { available: false, reason: forced };
  if (stubbed) return { available: true };
  if (platform !== 'darwin' && platform !== 'linux') {
    return { available: false, reason: `A full terminal is built for macOS and Ubuntu, not ${platform}` };
  }
  const l = load();
  return 'mod' in l ? { available: true } : { available: false, reason: l.reason };
}

/** The library, or null when it will not load (or this is not macOS or Linux). */
export function loadPty(): PtyModule | null {
  if (forced !== null) return null;
  if (stubbed) return stubbed;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const l = load();
  return 'mod' in l ? l.mod : null;
}

/** For verify only: make the library read as not loading (a sentence), or put it back (null). */
export function forcePtyUnavailable(reason: string | null): void {
  forced = reason;
}

/** For verify only: spawn shells from `mod` instead of the library, or put it back (null). */
export function stubPty(mod: PtyModule | null): void {
  stubbed = mod;
}
