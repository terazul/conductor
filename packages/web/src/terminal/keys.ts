/**
 * The keys a terminal takes for itself, per OS (Amendment 141; full-terminal.md §5.3).
 *
 *              macOS     Ubuntu (and Windows)
 *   find       ⌘F        Ctrl-Shift-F
 *   copy       ⌘C        Ctrl-Shift-C        (only with a selection; Ctrl-C is always SIGINT)
 *   paste      ⌘V        Ctrl-Shift-V, Shift-Insert
 *   clear      ⌘K        Ctrl-Shift-K
 *   the dock   Ctrl-`    Ctrl-`
 *
 * Everything else goes to the shell. On Ubuntu Ctrl-Shift-letter would otherwise reach the
 * shell as the bare control character (Ctrl-Shift-V as Ctrl-V, "insert the next key
 * literally"), so the page must take these before xterm.js does. Pure, so agent/verify.ts can
 * check both maps under node.
 */

export type TermAction = 'find' | 'copy' | 'paste' | 'clear';

export interface KeyLike {
  type: string;
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const LETTER: Record<string, TermAction> = { f: 'find', c: 'copy', v: 'paste', k: 'clear' };

/** What a key does in a terminal, or null when it is the shell's. */
export function termKey(e: KeyLike, mac: boolean): TermAction | null {
  if (e.type !== 'keydown') return null;
  const k = e.key.toLowerCase();
  if (mac) return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? (LETTER[k] ?? null) : null;
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Insert') return 'paste';
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey ? (LETTER[k] ?? null) : null;
}

/** Ctrl-` (Ctrl-backtick), on every OS: open or close the Terminal dock. */
export function dockKey(e: KeyLike): boolean {
  return e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote');
}

/** A Mac, by what the browser says it runs on. */
export function isMac(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

/** How the find key reads in a hint, on this OS. */
export function findHint(mac: boolean): string {
  return mac ? '⌘F' : 'Ctrl-Shift-F';
}
