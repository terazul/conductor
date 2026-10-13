/**
 * One terminal, drawn by xterm.js and fed by the daemon's socket (Amendment 112).
 *
 * Mounting attaches: the daemon sends the screen as it is now (the headless mirror's, with its
 * scrollback, Amendment 141; the last 512 KB of output where the mirror is off), then
 * everything after it, so a reload, or coming back from another screen, finds the shell as it
 * was, mid-`vim` included. Unmounting only lets go; the shell keeps running until it is closed.
 * Keys go down as `{ t: 'in', d }`, bytes that are not text (mouse reports) as `{ t: 'bin', d }`,
 * and the panel's size as `{ t: 'resize', cols, rows }`, sent when the socket opens and
 * whenever the fitted size changes.
 *
 * A dropped connection retries (0.5 s, doubling to 10 s) and resets the screen on each attach,
 * since the replay brings it back whole. A close the daemon meant (the shell ended, or the
 * terminal is gone) is not retried.
 *
 * Amendment 141 also gives it: the font size and scrollback from Settings (a change applies to
 * an open terminal, and the font re-fits it); find (⌘F, or Ctrl-Shift-F off a Mac; Esc closes);
 * URLs that open in a new browser tab; OSC 52, so `vim` and `tmux` can copy to the clipboard
 * (write only, never read); wide characters and emoji at their real width (Unicode 11); the
 * WebGL renderer, with the DOM renderer when there is no WebGL or the context is lost; and file
 * paths that open in Files at their line (`links`, terminal/paths.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import '../terminal/terminal.css';
import { useTheme } from '../shell/theme.js';
import { navigate } from '../lib/nav.js';
import { readSetting, useSetting } from '../lib/settings.js';
import { SCREEN } from '../shell/nav.js';
import { TERM_FONT_SIZE, TERM_SCROLLBACK, fontSizeOf, scrollbackOf } from '../terminal/prefs.js';
import { dockKey, findHint, isMac, termKey } from '../terminal/keys.js';
import { findPathLinks, termFileTarget } from '../terminal/paths.js';
import {
  TERM_TOKENS,
  binaryFrame,
  inputFrame,
  reconnectDelay,
  resizeFrame,
  socketEnd,
  termSocketUrl,
  xtermTheme,
  type Tokens,
} from './term.js';

/** The token values now in force: `data-theme` on <html> changes what these read. */
function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(TERM_TOKENS.map((n) => [n, css.getPropertyValue(`--${n}`).trim()])) as Tokens;
}

const FIT_DEBOUNCE_MS = 50;

/**
 * Where a terminal's paths lead: the folder it started in, the worktree or project folder a
 * path must stay inside, and that folder's root id in Files (a job's id, or a `dirRoot`).
 */
export interface TermLinks {
  cwd: string;
  root: string;
  filesRoot: string;
}

/** OSC 52 may write the clipboard; reading it is refused, so a program cannot see what you copied elsewhere. */
const writeOnly: IClipboardProvider = {
  readText: () => '',
  writeText: (_which, text) => navigator.clipboard?.writeText(text),
};

export function XtermView({
  termId,
  onEnded,
  links,
}: {
  termId: string;
  onEnded: (why: 'ended' | 'gone') => void;
  links?: TermLinks;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => undefined);
  const search = useRef<SearchAddon | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const { theme } = useTheme();
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'ended' | 'gone'>('connecting');
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('dom');
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [missed, setMissed] = useState(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const linksRef = useRef(links);
  linksRef.current = links;
  const fontSize = fontSizeOf(useSetting(TERM_FONT_SIZE.key));
  const scrollback = scrollbackOf(useSetting(TERM_SCROLLBACK.key));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize: fontSizeOf(readSetting(TERM_FONT_SIZE.key)),
      scrollback: scrollbackOf(readSetting(TERM_SCROLLBACK.key)),
      // Unicode 11's widths are a proposed API in xterm.js 6.
      allowProposedApi: true,
      theme: xtermTheme(readTokens(), document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'),
    });
    const fit = new FitAddon();
    const finder = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(finder);
    t.loadAddon(new WebLinksAddon((_e, uri) => void window.open(uri, '_blank', 'noopener,noreferrer')));
    t.loadAddon(new ClipboardAddon(undefined, writeOnly));
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
    t.open(el);
    search.current = finder;
    // WebGL after open, as it needs the canvas. No WebGL (some VMs and remote desktops), or a
    // context the GPU took back: xterm.js falls back to its DOM renderer once the addon goes.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
        setRenderer('dom');
      });
      t.loadAddon(gl);
      setRenderer('webgl');
    } catch {
      setRenderer('dom');
    }
    term.current = t;
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        /* the panel has no size yet (hidden, or mid-layout); the next observation fits it */
      }
    };
    refitRef.current = refit;
    refit();

    // Paths printed in the terminal open in Files, at their line (terminal/paths.ts).
    const pathLinks = t.registerLinkProvider({
      provideLinks(y, callback) {
        const at = linksRef.current;
        const line = at ? t.buffer.active.getLine(y - 1) : undefined;
        if (!at || !line) return callback(undefined);
        // The text, and the cell each of its characters is in: a wide character is two cells.
        let text = '';
        const cellOf: number[] = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) break;
          if (cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let k = 0; k < chars.length; k++) cellOf.push(x);
          text += chars;
        }
        const found: ILink[] = [];
        for (const hit of findPathLinks(text)) {
          const path = termFileTarget(hit.path, at.cwd, at.root);
          if (path === null) continue;
          found.push({
            range: { start: { x: (cellOf[hit.start] ?? 0) + 1, y }, end: { x: (cellOf[hit.end - 1] ?? 0) + 1, y } },
            text: text.slice(hit.start, hit.end),
            decorations: { underline: true, pointerCursor: true },
            activate: () =>
              navigate(SCREEN.files, { jobId: at.filesRoot, path, ...(hit.line ? { line: String(hit.line) } : {}) }),
          });
        }
        callback(found.length > 0 ? found : undefined);
      },
    });

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
    // Mouse reports in the X10 encoding are bytes, not text (shared/src/wire.ts TermClientFrame).
    const bytes = t.onBinary((d) => send(binaryFrame(d)));
    const sized = t.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)));
    const mac = isMac(navigator.platform);
    t.attachCustomKeyEventHandler((e) => {
      // Read as a keydown, so the keypress and keyup of a key taken here are not the shell's either.
      const k = { type: 'keydown', key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
      // Ctrl-` is the dock's (terminal/dock.tsx): let it reach the window, not the shell.
      if (dockKey(k)) return false;
      const action = termKey(k, mac);
      if (!action) return true;
      if (e.type !== 'keydown') return false;
      if (action === 'copy') {
        if (t.hasSelection()) void navigator.clipboard?.writeText(t.getSelection());
        e.preventDefault();
      } else if (action === 'find') {
        e.preventDefault();
        setFinding(true);
        // Already open: put the cursor back in it.
        findInput.current?.focus();
        findInput.current?.select();
      } else if (action === 'clear') {
        e.preventDefault();
        t.clear();
      }
      // `paste`: not prevented, so the browser pastes into xterm.js, which bracket-pastes it.
      return false;
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
      bytes.dispose();
      sized.dispose();
      pathLinks.dispose();
      socket?.close();
      t.dispose();
      term.current = null;
      search.current = null;
    };
  }, [termId]);

  // The theme can change under a terminal that is open.
  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(readTokens(), theme);
  }, [theme]);

  // So can the settings: a new font size re-fits, so the shell is told its new size.
  useEffect(() => {
    const t = term.current;
    if (!t || t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    refitRef.current();
  }, [fontSize]);
  useEffect(() => {
    if (term.current) term.current.options.scrollback = scrollback;
  }, [scrollback]);

  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);

  const find = (back: boolean, incremental = false): void => {
    const s = search.current;
    if (!s || query === '') return setMissed(false);
    setMissed(!(back ? s.findPrevious(query) : s.findNext(query, { incremental })));
  };
  const closeFind = (): void => {
    setFinding(false);
    setMissed(false);
    search.current?.clearDecorations();
    term.current?.focus();
  };

  return (
    <div className="ag-xterm-wrap" data-renderer={renderer}>
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
      {finding && (
        <div className="tm-find" role="search">
          <input
            ref={findInput}
            value={query}
            placeholder="find"
            aria-label="Find in the terminal"
            spellCheck={false}
            data-missed={missed}
            onChange={(e) => {
              const q = e.target.value;
              setQuery(q);
              const s = search.current;
              setMissed(q !== '' && s !== null && !s.findNext(q, { incremental: true }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                find(e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <button type="button" title="Previous (Shift-Enter)" aria-label="Previous match" onClick={() => find(true)}>
            ↑
          </button>
          <button type="button" title="Next (Enter)" aria-label="Next match" onClick={() => find(false)}>
            ↓
          </button>
          <button type="button" title={`Close (Esc). Open with ${findHint(isMac(navigator.platform))}`} aria-label="Close find" onClick={closeFind}>
            ×
          </button>
          {missed && <span className="tm-find-none">not found</span>}
        </div>
      )}
      <div className="ag-xterm" ref={host} data-state={state} />
    </div>
  );
}
