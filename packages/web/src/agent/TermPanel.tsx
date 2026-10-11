/**
 * The Agent screen's terminal tab (Amendment 112): real shells in the agent's folder, in tabs.
 *
 * The daemon says whether it can start one. If it cannot (no PTY library on this machine, or
 * an OS that is not built), the old command runner (Terminal.tsx, Amendment 58) is shown
 * under a banner with the reason, so a failed native load never leaves the tab empty.
 *
 * Leaving the tab, or the page, does not end a shell: the daemon keeps it, and coming back
 * attaches to it again. A tab's × is what ends one.
 */

import { useEffect, useRef, useState } from 'react';
import type { Agent, TermInfo } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { tildePath } from '../shell/ui.js';
import { TerminalPanel } from './Terminal.js';
import { XtermView } from './Xterm.js';
import { closeTerminal, endedLine, fallbackBanner, listTerminals, nextSelected, openTerminal, tabLabel, tabTitle } from './term.js';

/** Agents this page has opened a first terminal for, or found one already open: closing the last one stays closed. */
const autoOpened = new Set<string>();

export function TermPanel({ agent }: { agent: Agent }) {
  const [list, setList] = useState<{ available: boolean; reason?: string; terminals: TermInfo[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(agent.id);
  current.current = agent.id;

  const refresh = async (choose?: string): Promise<void> => {
    const asked = agent.id;
    try {
      const r = await listTerminals(asked);
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
      const { id } = await openTerminal(agent.id);
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
  }, [agent.id]);

  // The first visit to an agent with nothing open opens one; a terminal you closed stays closed.
  useEffect(() => {
    if (list?.available && list.terminals.length === 0 && !autoOpened.has(agent.id)) {
      autoOpened.add(agent.id);
      void open();
    }
  }, [list, agent.id]);

  if (list === null) {
    return <div className="ag-termx-wait">{error ?? 'opening the terminal…'}</div>;
  }
  if (!list.available) {
    return (
      <div className="ag-termx">
        <div className="ag-termx-banner" role="status">
          {fallbackBanner(list.reason)}
        </div>
        <TerminalPanel agent={agent} />
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
        <XtermView key={shown.id} termId={shown.id} onEnded={() => void refresh()} />
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
