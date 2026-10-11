/**
 * One terminal, drawn by xterm.js and fed by the daemon's socket (Amendment 112).
 *
 * Mounting attaches: the daemon sends what the shell printed last (up to 512 KB), then
 * everything after it, so a reload, or coming back from another screen, finds the shell as it
 * was. Unmounting only lets go; the shell keeps running until it is closed. Keys go down as
 * `{ t: 'in', d }`, and the panel's size as `{ t: 'resize', cols, rows }`, sent when the socket
 * opens and whenever the fitted size changes.
 *
 * A dropped connection retries (0.5 s, doubling to 10 s) and resets the screen on each attach,
 * since the replay brings it back whole. A close the daemon meant (the shell ended, or the
 * terminal is gone) is not retried.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../shell/theme.js';
import {
  TERM_TOKENS,
  inputFrame,
  reconnectDelay,
  resizeFrame,
  socketEnd,
  termSocketUrl,
  wantsCopy,
  xtermTheme,
  type Tokens,
} from './term.js';

/** The token values now in force: `data-theme` on <html> changes what these read. */
function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(TERM_TOKENS.map((n) => [n, css.getPropertyValue(`--${n}`).trim()])) as Tokens;
}

const FIT_DEBOUNCE_MS = 50;

export function XtermView({ termId, onEnded }: { termId: string; onEnded: (why: 'ended' | 'gone') => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const { theme } = useTheme();
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'ended' | 'gone'>('connecting');
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: xtermTheme(readTokens(), document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        /* the panel has no size yet (hidden, or mid-layout); the next observation fits it */
      }
    };
    refit();

    let socket: WebSocket | null = null;
    let attempt = 0;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (frame: string): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    };

    const connect = (): void => {
      const token = import.meta.env['VITE_CONDUCTOR_TOKEN'];
      const s = new WebSocket(termSocketUrl(termId, location, token ? String(token) : undefined));
      s.binaryType = 'arraybuffer';
      socket = s;
      s.onopen = () => {
        attempt = 0;
        // The replay that follows is the whole screen, so what is drawn now would be doubled.
        t.reset();
        setState('live');
        refit();
        send(resizeFrame(t.cols, t.rows));
      };
      s.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) t.write(new Uint8Array(e.data));
      };
      s.onclose = (e) => {
        if (disposed || socket !== s) return;
        const why = socketEnd(e.code);
        if (why !== 'dropped') {
          setState(why);
          ended.current(why);
          return;
        }
        setState('reconnecting');
        retry = setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };
    connect();

    const typed = t.onData((d) => send(inputFrame(d)));
    const sized = t.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)));
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    t.attachCustomKeyEventHandler((e) => {
      if (wantsCopy(e, mac) && t.hasSelection()) {
        void navigator.clipboard?.writeText(t.getSelection());
        return false;
      }
      return true;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refit, FIT_DEBOUNCE_MS);
    });
    watch.observe(el);
    t.focus();

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(timer);
      watch.disconnect();
      typed.dispose();
      sized.dispose();
      socket?.close();
      t.dispose();
      term.current = null;
    };
  }, [termId]);

  // The theme can change under a terminal that is open.
  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(readTokens(), theme);
  }, [theme]);

  return (
    <div className="ag-xterm-wrap">
      {state === 'reconnecting' && (
        <div className="ag-xterm-bar" role="status">
          reconnecting…
        </div>
      )}
      {state === 'gone' && (
        <div className="ag-xterm-bar is-fail" role="status">
          This terminal is gone: the daemon restarted, or it was closed elsewhere.
        </div>
      )}
      <div className="ag-xterm" ref={host} data-state={state} />
    </div>
  );
}
