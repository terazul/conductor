/**
 * Terminals in tabs (Amendment 112): real shells, kept by the daemon.
 *
 * `TermPanel` is the Agent screen's terminal tab, in the agent's folder. If the daemon cannot
 * start a shell (no PTY library on this machine, or an OS that is not built), the old command
 * runner (Terminal.tsx, Amendment 58) is shown under a banner with the reason, so a failed
 * native load never leaves the tab empty.
 *
 * `TermTabs` is the tabs themselves, for either scope (Amendment 141): the Terminal dock under
 * every screen (terminal/dock.tsx) shows a project's with it. Its list is asked for on mount
 * and kept current by the hub's `terminals` frame (terminal/live.ts), so a terminal opened in
 * another browser tab appears here too.
 *
 * Leaving the tab, or the page, does not end a shell: the daemon keeps it, and coming back
 * attaches to it again. A tab's × is what ends one.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { termScopeKey, type Agent, type TermInfo, type TermScope } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { tildePath } from '../shell/ui.js';
import { onTerminals } from '../terminal/live.js';
import { TerminalPanel } from './Terminal.js';
import { XtermView, type TermLinks } from './Xterm.js';
import { closeTerminal, endedLine, fallbackBanner, listTerminals, nextSelected, openTerminal, tabLabel, tabTitle } from './term.js';

/** Scopes this page has opened a first terminal for, or found one already open: closing the last one stays closed. */
const autoOpened = new Set<string>();

export function TermPanel({ agent }: { agent: Agent }) {
  return (
    <TermTabs
      scope={{ kind: 'agent', agentId: agent.id }}
      // An agent's shells start in its job folder, and that is the root its paths stay inside.
      links={(t) => ({ cwd: t.cwd, root: t.cwd, filesRoot: agent.jobId })}
      fallback={<TerminalPanel agent={agent} />}
    />
  );
}

export function TermTabs({
  scope,
  links,
  fallback,
}: {
  scope: TermScope;
  /** Where a terminal's printed paths lead in Files. */
  links: (t: TermInfo) => TermLinks;
  /** What to show under the banner when no shell can start. */
  fallback?: ReactNode;
}) {
  const key = termScopeKey(scope);
  const [list, setList] = useState<{ available: boolean; reason?: string; terminals: TermInfo[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(key);
  current.current = key;

  const refresh = async (choose?: string): Promise<void> => {
    const asked = key;
    try {
      const r = await listTerminals(scope);
      if (current.current !== asked) return;
      // Terminals already there: this is not a first visit, so closing the last one leaves it closed.
      if (r.terminals.length > 0) autoOpened.add(asked);
      setList(r);
      setSelected((cur) => nextSelected(r.terminals, choose ?? cur));
    } catch (err) {
      if (current.current === asked) setError(errorText(err));
    }
  };

  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await openTerminal(scope);
      await refresh(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const close = async (id: string): Promise<void> => {
    setError(null);
    try {
      await closeTerminal(id);
    } catch (err) {
      setError(errorText(err));
    }
    await refresh();
  };

  useEffect(() => {
    setList(null);
    setSelected(null);
    setError(null);
    void refresh();
    // Opened, exited or closed anywhere, this tab included (Amendment 141).
    return onTerminals(scope, (terminals) => {
      if (terminals.length > 0) autoOpened.add(key);
      setList((l) => (l ? { ...l, terminals } : l));
      setSelected((cur) => nextSelected(terminals, cur));
    });
  }, [key]);

  // The first visit to a scope with nothing open opens one; a terminal you closed stays closed.
  useEffect(() => {
    if (list?.available && list.terminals.length === 0 && !autoOpened.has(key)) {
      autoOpened.add(key);
      void open();
    }
  }, [list, key]);

  if (list === null) {
    return <div className="ag-termx-wait">{error ?? 'opening the terminal…'}</div>;
  }
  if (!list.available) {
    return (
      <div className="ag-termx">
        <div className="ag-termx-banner" role="status">
          {fallback ? fallbackBanner(list.reason) : `${(list.reason ?? 'A terminal is not available on this machine').replace(/\.$/, '')}.`}
        </div>
        {fallback}
      </div>
    );
  }

  const shown = list.terminals.find((t) => t.id === selected) ?? null;
  return (
    <div className="ag-termx">
      <div className="ag-termx-bar" role="tablist" aria-label="Terminals">
        {list.terminals.map((t, i) => (
          <span key={t.id} className="ag-termx-tab" data-on={t.id === selected}>
            <button type="button" role="tab" aria-selected={t.id === selected} title={tabTitle(t)} onClick={() => setSelected(t.id)}>
              {tabLabel(t, i)}
            </button>
            <button
              type="button"
              className="ag-termx-x"
              aria-label={`Close ${tabLabel(t, i)}`}
              title={t.exited ? 'Close' : 'Close: ends this shell and anything running in it'}
              onClick={() => void close(t.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button type="button" className="ag-termx-new" disabled={busy} title="Open another terminal in this folder" aria-label="Open another terminal" onClick={() => void open()}>
          +
        </button>
        <span className="ag-termx-note">
          Runs as you{list.terminals[0] ? <>, in <code>{tildePath(list.terminals[0].cwd)}</code></> : null}. It keeps running if you leave.
        </span>
      </div>
      {shown ? (
        <XtermView key={shown.id} termId={shown.id} onEnded={() => void refresh()} links={links(shown)} />
      ) : (
        <div className="ag-termx-wait">
          No terminal is open.{' '}
          <button type="button" className="fl-btn is-ghost" disabled={busy} onClick={() => void open()}>
            open one
          </button>
        </div>
      )}
      {shown?.exited && (
        <div className="ag-termx-ended">
          {endedLine(shown)}{' '}
          <button type="button" className="fl-btn is-ghost" disabled={busy} onClick={() => void open()}>
            ↻ new terminal
          </button>
        </div>
      )}
      {error && <div className="ag-term-err">{error}</div>}
    </div>
  );
}
