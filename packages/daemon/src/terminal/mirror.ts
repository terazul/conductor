/**
 * The headless mirror (Amendment 141): a terminal emulator in the daemon, fed everything the
 * shell prints, so a page that attaches is sent the SCREEN rather than the last 512 KB of bytes.
 *
 * The raw replay (ring.ts) is right for a shell prompt and wrong for anything full-screen: a
 * page that reattached mid-`vim` got whatever slice of redraws fell in the last 512 KB, which
 * started mid-sequence and drew garbage until the program repainted. `@xterm/headless` keeps
 * the screen, the alternate screen, the cursor, the modes and the scrollback as xterm.js would,
 * and `@xterm/addon-serialize` writes them out as one string of escape sequences that draws
 * the same screen in an empty terminal. That string is what a page gets first.
 *
 * Loaded lazily and through `createRequire`, as pty.ts loads the PTY: if the packages are
 * missing or fail to load, `createMirror` returns null and the terminal keeps using the ring.
 *
 * Writes into the emulator are parsed later, in batches, not when `write` returns. So a
 * snapshot waits for every write before it (`write('', cb)` calls back once all earlier
 * writes are parsed, and before any later one is), and what the snapshot shows is exactly the
 * output up to the moment it was asked for. service.ts holds back what arrives meanwhile.
 */

import { createRequire } from 'node:module';

export interface Mirror {
  write(data: Buffer): void;
  /**
   * Bytes written and not yet parsed. A shell that prints faster than the emulator reads
   * (`yes`, with nobody watching) is paused on this as on a slow page, since xterm.js drops
   * what is queued past 50 MB.
   */
  backlog(): number;
  resize(cols: number, rows: number): void;
  /** The screen as escape sequences, scrollback included, as of now; null if serializing failed. */
  snapshot(cb: (screen: string | null) => void): void;
  dispose(): void;
}

interface HeadlessTerminal {
  write(data: string | Uint8Array, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
}
interface HeadlessModule {
  Terminal: new (o: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => HeadlessTerminal;
}
interface SerializeModule {
  SerializeAddon: new () => { serialize(o?: { scrollback?: number }): string };
}

let loaded: { headless: HeadlessModule; serialize: SerializeModule } | { reason: string } | null = null;
/** For verify: pretend the packages will not load. */
let forced = false;

function load(): { headless: HeadlessModule; serialize: SerializeModule } | { reason: string } {
  if (loaded) return loaded;
  try {
    const req = createRequire(import.meta.url);
    loaded = {
      headless: req('@xterm/headless') as HeadlessModule,
      serialize: req('@xterm/addon-serialize') as SerializeModule,
    };
  } catch (err) {
    loaded = { reason: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
  }
  return loaded;
}

/** Whether the mirror loads here, and if not, why. */
export function mirrorStatus(): { available: true } | { available: false; reason: string } {
  if (forced) return { available: false, reason: 'forced off by verify' };
  const l = load();
  return 'reason' in l ? { available: false, reason: l.reason } : { available: true };
}

/** A mirror at the shell's size, or null when the packages will not load. */
export function createMirror(cols: number, rows: number, scrollback: number): Mirror | null {
  if (forced) return null;
  const l = load();
  if ('reason' in l) return null;
  let term: HeadlessTerminal;
  let ser: InstanceType<SerializeModule['SerializeAddon']>;
  try {
    term = new l.headless.Terminal({ cols, rows, scrollback, allowProposedApi: true });
    ser = new l.serialize.SerializeAddon();
    term.loadAddon(ser);
  } catch {
    return null;
  }
  let disposed = false;
  let pending = 0;
  return {
    write(data) {
      if (disposed) return;
      pending += data.length;
      term.write(data, () => void (pending -= data.length));
    },
    backlog: () => (disposed ? 0 : pending),
    resize(c, r) {
      if (disposed) return;
      try {
        term.resize(c, r);
      } catch {
        /* a size the emulator will not take; the next resize corrects it */
      }
    },
    snapshot(cb) {
      if (disposed) return cb(null);
      term.write('', () => {
        if (disposed) return cb(null);
        try {
          cb(ser.serialize());
        } catch {
          cb(null);
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        term.dispose();
      } catch {
        /* already gone */
      }
    },
  };
}

/** For verify only: make the mirror read as not loading (true), or put it back (false). */
export function forceMirrorUnavailable(on: boolean): void {
  forced = on;
}
