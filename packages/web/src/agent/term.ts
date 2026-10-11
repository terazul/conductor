/**
 * The Agent screen's full terminal, the parts that need no browser (Amendment 112).
 *
 * `Xterm.tsx` draws one terminal and `TermPanel.tsx` holds the tabs; everything either has to
 * decide lives here as a function, so `verify.ts` can test it without a DOM or xterm.js.
 */

import type { ITheme } from '@xterm/xterm';
import {
  TERM_WS_PREFIX,
  type TermClientFrame,
  type TermCreateRequest,
  type TermCreateResponse,
  type TermInfo,
  type TermListResponse,
} from '@conductor/shared';
import { api } from '../lib/feed.js';

// ── talking to the daemon ────────────────────────────────────────────────────

const termsPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/terminals`;

export function listTerminals(agentId: string): Promise<TermListResponse> {
  return api(termsPath(agentId));
}

export function openTerminal(agentId: string, body: TermCreateRequest = {}): Promise<TermCreateResponse> {
  return api(termsPath(agentId), { method: 'POST', body });
}

export function closeTerminal(id: string): Promise<unknown> {
  return api(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── the socket ───────────────────────────────────────────────────────────────

/**
 * Where a terminal's stream is. The same host as the page (Vite proxies `/ws` in
 * development), and `?token=` when the build has one, as the feed's socket does.
 */
export function termSocketUrl(id: string, loc: { protocol: string; host: string }, token?: string): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}://${loc.host}${TERM_WS_PREFIX}${encodeURIComponent(id)}${qs}`;
}

export const inputFrame = (d: string): string => JSON.stringify({ t: 'in', d } satisfies TermClientFrame);
export const resizeFrame = (cols: number, rows: number): string =>
  JSON.stringify({ t: 'resize', cols, rows } satisfies TermClientFrame);

/** 0.5, 1, 2, 4, 8 s, then every 10 s. The daemon replays on each attach, so a retry loses nothing. */
export function reconnectDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * Why a socket closed. 1000 is the daemon saying the shell ended or the terminal was closed;
 * 4404 is "no such terminal" (the daemon restarted, or it was closed elsewhere). Anything
 * else is a dropped connection, and worth retrying.
 */
export type SocketEnd = 'ended' | 'gone' | 'dropped';
export function socketEnd(code: number): SocketEnd {
  return code === 1000 ? 'ended' : code === 4404 ? 'gone' : 'dropped';
}

// ── the tabs ─────────────────────────────────────────────────────────────────

export function tabLabel(t: Pick<TermInfo, 'exited'>, index: number): string {
  return `terminal ${index + 1}${t.exited ? ' (exited)' : ''}`;
}

export function tabTitle(t: TermInfo): string {
  const code = t.exited ? `, exited${t.exitCode === null ? '' : ` with ${t.exitCode}`}` : '';
  return `${t.cwd} · started ${t.startedAt}${code}`;
}

/** The tab to show: the one chosen if it is still there, else the newest, else none. */
export function nextSelected(list: readonly TermInfo[], current: string | null): string | null {
  if (current !== null && list.some((t) => t.id === current)) return current;
  return list.at(-1)?.id ?? null;
}

/** Words for the strip above the command runner when the full terminal is not available. */
export function fallbackBanner(reason: string | undefined): string {
  const why = (reason ?? 'It is not available on this machine').trim().replace(/\.$/, '');
  return `${why}. This is the command runner instead: one command at a time, with no input.`;
}

/** How a finished shell reads under its output. */
export function endedLine(t: Pick<TermInfo, 'exitCode'>): string {
  return (t.exitCode ?? 0) === 0 ? 'The shell ended.' : `The shell ended with exit code ${t.exitCode}.`;
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * Copy on a Linux browser: Ctrl-Shift-C. (macOS copies with ⌘C, which xterm.js leaves to the
 * browser; Ctrl-C is the shell's interrupt everywhere and is never taken.)
 */
export function wantsCopy(e: { type: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return !mac && e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'c';
}

// ── colour ───────────────────────────────────────────────────────────────────

/** The tokens the terminal's palette is made from (shared/src/tokens.css). */
export const TERM_TOKENS = ['well', 'line', 'line2', 'ink', 'ink2', 'ink3', 'surf3', 'live', 'need', 'fail', 'done', 'queue', 'you'] as const;
export type TermToken = (typeof TERM_TOKENS)[number];
export type Tokens = Record<TermToken, string>;

/** `a` toward `b` by `t` (0 to 1), as `#rrggbb`. Both are `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * xterm.js's colours, from the app's tokens, so a terminal is in the theme it sits in. The
 * well is the background, as the old runner's was. The status tokens are the ANSI colours
 * (every one is 4.5:1 or better on the well in both themes, which `lib/verify.ts` checks), and
 * the bright ones are those moved a quarter of the way toward the text colour. Black and white
 * follow what they mean rather than the theme: a dark black and a light white in both, so a
 * program that prints white on a coloured bar, or black on one, still reads. Bright white on a
 * light theme is a dark grey, for the same reason as bright black: it has to be seen.
 */
export function xtermTheme(t: Tokens, theme: 'dark' | 'light'): ITheme {
  const bright = (c: string) => mix(c, t.ink, 0.25);
  const dark = theme === 'dark';
  return {
    background: t.well,
    foreground: t.ink,
    cursor: t.live,
    cursorAccent: t.well,
    selectionBackground: t.line2,
    selectionInactiveBackground: t.line,
    black: dark ? t.surf3 : t.ink,
    red: t.fail,
    green: t.done,
    yellow: t.need,
    blue: t.queue,
    magenta: t.you,
    cyan: t.live,
    white: dark ? t.ink2 : t.surf3,
    brightBlack: t.ink3,
    brightRed: bright(t.fail),
    brightGreen: bright(t.done),
    brightYellow: bright(t.need),
    brightBlue: bright(t.queue),
    brightMagenta: bright(t.you),
    brightCyan: bright(t.live),
    brightWhite: dark ? t.ink : t.ink2,
  };
}
