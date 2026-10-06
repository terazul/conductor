/**
 * The preview dock — captured console output, and the facts about the server.
 *
 * TRACK D OWNS THIS FILE.
 *
 * The console pane is the reason the injected shim exists: the previewed app runs
 * in an iframe, and nothing in the parent frame can read that frame's console.
 * So the shim forwards it to the daemon, the daemon emits `console` events, and
 * this pane renders them off the same feed every other screen reads.
 *
 * The second tab shows the registry's own view of the dev server instead of the
 * mockup's "network" and "server log" tabs. Those two have no data source in this
 * track — the proxy sees requests but the agent's stdout belongs to Track A's
 * session engine — and a tab that renders nothing is worse than a tab that isn't
 * there. What the registry knows (port, pid, the command it matched, when it was
 * last seen) is real, and it is exactly what you want when the pane is empty and
 * you are trying to work out why.
 */

import { useEffect, useRef } from 'react';
import type { ConsoleEntry, DevServer } from '@conductor/shared';
import type { ConsoleLog } from './useConsoleLog.js';
import { PREVIEW_DOCK, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';

export type DockTab = 'console' | 'server';

const GLYPH: Record<ConsoleEntry['level'], string> = {
  error: '⨯',
  warn: '!',
  log: '·',
};

function clockOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--:--:--';
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

export interface DockProps {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  log: ConsoleLog;
  server: DevServer | null;
  /** Command / framework the registry matched, for the "vite · pid …" line. */
  serverLabel: string;
  /** Role of the agent that started it, when known. */
  ownerRole: string | null;
  onStop: () => void;
  onSend: () => void;
  stopping: boolean;
  sending: boolean;
  /** Set when we know which agent to hand errors to. */
  canSend: boolean;
}

export function Dock(props: DockProps) {
  const { log, server } = props;
  // Drag its top edge (Amendment 34). Upwards grows it, hence `grow={-1}`.
  const { size, handle } = usePanel(PREVIEW_DOCK);

  return (
    <>
      <Splitter orientation="horizontal" grow={-1} label="Resize the dock" {...handle} />
      <div className="pv-dock" style={{ height: `${size}px` }}>
        <div className="pv-docktabs">
          <button
            type="button"
            className={props.tab === 'console' ? 'on' : ''}
            onClick={() => props.onTab('console')}
          >
            ▸ console
            {log.errorCount > 0 && (
              <span className="pv-tag" data-kind="fail">
                {log.errorCount}
              </span>
            )}
            {log.errorCount === 0 && log.entries.length > 0 && (
              <span className="pv-tag">{log.entries.length}</span>
            )}
          </button>
          <button
            type="button"
            className={props.tab === 'server' ? 'on' : ''}
            onClick={() => props.onTab('server')}
          >
            ▤ server
          </button>

          <div className="pv-dockright">
            {server && (
              <span className="pv-meta">
                {props.serverLabel} · pid {server.pid ?? '—'}
                {props.ownerRole && (
                  <>
                    {' · owned by '}
                    <b>{props.ownerRole}</b>
                  </>
                )}
              </span>
            )}
            <button
              type="button"
              className="pv-btn"
              onClick={() => void log.clear()}
              disabled={log.entries.length === 0}
              title="Clear the captured console"
            >
              ⌫ clear
            </button>
            <button
              type="button"
              className="pv-btn"
              onClick={props.onStop}
              disabled={!server || server.pid === null || props.stopping}
              title={
                server && server.pid === null
                  ? 'Conductor could not determine the pid — stop it from the terminal that started it'
                  : 'Send SIGTERM to the dev server'
              }
            >
              {props.stopping ? '… stopping' : '⏹ stop server'}
            </button>
            <button
              type="button"
              className="pv-btn pv-send"
              onClick={props.onSend}
              disabled={log.errorCount === 0 || !props.canSend || props.sending}
              title={
                log.errorCount === 0
                  ? 'No captured errors to send'
                  : !props.canSend
                    ? 'No agent is associated with this job yet'
                    : 'Turn the captured errors into a message for the agent'
              }
            >
              {props.sending
                ? '… sending'
                : `⇪ send ${log.errorCount > 0 ? `${log.errorCount} error${log.errorCount === 1 ? '' : 's'}` : 'errors'} to agent`}
            </button>
          </div>
        </div>

        {props.tab === 'console' ? (
          <ConsoleBody log={log} />
        ) : (
          <ServerBody server={server} label={props.serverLabel} ownerRole={props.ownerRole} />
        )}
      </div>
    </>
  );
}

function ConsoleBody({ log }: { log: ConsoleLog }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Follow the tail, but stop following the moment the human scrolls up — an
  // autoscroll that fights you while you are reading an error is infuriating.
  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [log.entries.length]);

  if (log.entries.length === 0) {
    return (
      <div className="pv-dockbody" style={{ color: 'var(--ink3)' }}>
        {log.loaded
          ? 'No console output captured yet. Anything the previewed app logs — or throws — appears here.'
          : 'loading…'}
      </div>
    );
  }

  return (
    <div className="pv-dockbody" ref={ref} onScroll={onScroll}>
      {log.entries.map((entry, i) => (
        <div className="pv-line" data-level={entry.level} key={`${entry.at}:${i}`}>
          <time>{clockOf(entry.at)}</time>
          <span className="pv-glyph">{GLYPH[entry.level]}</span>
          <span>{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

function ServerBody({
  server,
  label,
  ownerRole,
}: {
  server: DevServer | null;
  label: string;
  ownerRole: string | null;
}) {
  if (!server) {
    return (
      <div className="pv-dockbody" style={{ color: 'var(--ink3)' }}>
        No dev server registered for this job.
      </div>
    );
  }
  return (
    <div className="pv-dockbody">
      <dl className="pv-kv">
        <dt>detected</dt>
        <dd>{label}</dd>
        <dt>port</dt>
        {/* `host` is on the wire as of Amendment 6, so this can state the real
            origin instead of hedging. Which family a dev server bound is exactly
            the fact that costs an hour when it's hidden. */}
        <dd>
          {server.host.includes(':') ? `[${server.host}]` : server.host}:{server.port}
        </dd>
        <dt>pid</dt>
        <dd>{server.pid ?? 'unknown (stop must come from the terminal that started it)'}</dd>
        <dt>started by</dt>
        <dd>{ownerRole ?? server.startedByAgentId ?? 'not attributed'}</dd>
        <dt>detected at</dt>
        <dd>{clockOf(server.detectedAt)}</dd>
        <dt>state</dt>
        <dd style={{ color: server.alive ? 'var(--live)' : 'var(--fail)' }}>
          {server.alive ? 'listening' : 'gone'}
        </dd>
        <dt>proxied at</dt>
        <dd>{server.proxyPath}</dd>
      </dl>
    </div>
  );
}
