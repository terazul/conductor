/**
 * Diagnostics — W0's screen. Owned by W0, useful to every track.
 *
 * This is the I1 smoke test made permanent: if this screen renders live data,
 * then the glob registration, the feed cursor, the store projection and the
 * shared derived helpers are all working. When a track's screen misbehaves,
 * check here first to see whether the problem is the data or the UI.
 */

import {
  useAgents,
  useFeedStatus,
  useJobs,
  usePending,
  useProjects,
  useServers,
  useSparkline,
  useStatusBar,
  useAgentEvents,
} from '../lib/store.js';
import type { ScreenDef } from '../lib/screens.js';
import type { EventPayload } from '@conductor/shared';
import { useEffect, useState } from 'react';
import { errorText } from '../lib/errors.js';
import { behindLine, buildTag, fmtWhen, getBuild, type Build } from './build.js';
import { cleanUp, confirmLine, doneLine, getStorage, storageLine, type Storage } from './storage.js';

function Diagnostics() {
  const status = useFeedStatus();
  const { seq, slots, costToday } = useStatusBar();
  const projects = useProjects();
  const jobs = useJobs();
  const agents = useAgents();
  const pending = usePending();
  const servers = useServers();

  const [inspect, setInspect] = useState<string | null>(null);
  const focused = inspect ?? agents[0]?.id ?? null;
  const events = useAgentEvents(focused);
  const spark = useSparkline(focused);

  return (
    <div style={{ padding: 20, display: 'grid', gap: 18, maxWidth: 1100 }}>
      <BuildSection />

      <section>
        <h2 style={h2}>Feed</h2>
        <div style={grid}>
          <Kv k="status" v={status} />
          <Kv k="cursor seq" v={String(seq)} />
          <Kv k="slots" v={`${slots.used}/${slots.total}`} />
          <Kv k="cost today" v={`$${costToday.toFixed(2)}`} />
        </div>
      </section>

      <section>
        <h2 style={h2}>Entities</h2>
        <div style={grid}>
          <Kv k="projects" v={String(projects.length)} />
          <Kv k="jobs" v={String(jobs.length)} />
          <Kv k="agents" v={String(agents.length)} />
          <Kv k="pending" v={String(pending.length)} />
          <Kv k="dev servers" v={String(servers.length)} />
        </div>
      </section>

      <StorageSection />

      <section>
        <h2 style={h2}>Agents</h2>
        {agents.length === 0 ? (
          <Empty>
            No agents. Run with <code>VITE_FIXTURE=session-basic</code> to replay a
            recorded session, or start the daemon and spawn a job.
          </Empty>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                {['role', 'status', 'block', 'cost', 'tokens', 'session', ''].map((h) => (
                  <th key={h} style={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} style={a.id === focused ? { background: 'var(--surf2)' } : undefined}>
                  <td style={td}>{a.role}</td>
                  <td style={{ ...td, color: `var(--status-${a.status})` }}>{a.status}</td>
                  <td style={td}>{a.blockMode ?? '—'}</td>
                  <td style={td}>${a.costUsd.toFixed(3)}</td>
                  <td style={td}>
                    {a.inputTokens}/{a.outputTokens}
                  </td>
                  <td style={{ ...td, color: 'var(--ink3)' }}>
                    {a.sdkSessionId ? `${a.sdkSessionId.slice(0, 8)}…` : '—'}
                  </td>
                  <td style={td}>
                    <button type="button" style={btn} onClick={() => setInspect(a.id)}>
                      inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={h2}>Sparkline · derived from tool_start</h2>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 34 }}>
          {spark.map((n, i) => (
            <div
              key={i}
              title={`${n} calls`}
              style={{
                width: 9,
                height: `${Math.min(100, n * 20)}%`,
                minHeight: 2,
                background: n > 0 ? 'var(--live)' : 'var(--idle)',
                borderRadius: 2,
              }}
            />
          ))}
          <span style={{ marginLeft: 10, color: 'var(--ink3)', fontFamily: 'var(--mono)' }}>
            {spark.join(' ')}
          </span>
        </div>
      </section>

      <section>
        <h2 style={h2}>Event tail · {events.length} held</h2>
        <pre style={pre}>
          {events.length === 0
            ? '(none)'
            : events
                .slice(-40)
                .map((e) => `${String(e.seq).padStart(5)}  ${e.payload.kind.padEnd(12)} ${summarise(e.payload)}`)
                .join('\n')}
        </pre>
      </section>

      {pending.length > 0 && (
        <section>
          <h2 style={{ ...h2, color: 'var(--need)' }}>Attention queue</h2>
          <pre style={pre}>
            {pending
              .map(
                (p) =>
                  `${p.projectName} · ${p.agentRole}  [${p.blockMode}]  ${p.toolName}  ${p.createdAt}`,
              )
              .join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}

/** What the daemon is running, and since when (Amendment 38). */
function BuildSection() {
  const [build, setBuild] = useState<Build | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    getBuild().then(setBuild, (err: unknown) => setNote(errorText(err)));
  }, []);
  return (
    <section>
      <h2 style={h2}>Build</h2>
      {build ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={grid}>
            <Kv k="version" v={build.version} />
            <Kv k="commit" v={buildTag(build)} />
            <Kv k="committed" v={fmtWhen(build.committedAt)} />
            <Kv k="daemon started" v={fmtWhen(build.startedAt)} />
            <Kv k="node" v={build.node} />
          </div>
          {build.dirty && (
            <div style={{ color: 'var(--ink3)', fontSize: 'var(--fs-base)' }}>
              * the daemon started with uncommitted changes, so the commit is not the whole story.
            </div>
          )}
          {build.behind && <div style={{ color: 'var(--need)', fontSize: 'var(--fs-base)' }}>{behindLine(build)}</div>}
        </div>
      ) : (
        <Empty>{note ?? 'Asking the daemon…'}</Empty>
      )}
    </section>
  );
}

/**
 * The database, and the cleanup button (Amendment 36). Confirmed the same two-step way
 * as removing a project — the first press arms, the second deletes — because deleting
 * from the log is not undoable, even though nothing it deletes can be shown.
 */
function StorageSection() {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = (): void => {
    getStorage().then(setStorage, (err: unknown) => setNote(errorText(err)));
  };
  useEffect(load, []);

  const clean = async (): Promise<void> => {
    setBusy(true);
    try {
      const done = await cleanUp();
      setStorage(done);
      setNote(doneLine(done.removed));
      setArmed(false);
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const line = storage ? storageLine(storage) : null;
  return (
    <section>
      <h2 style={h2}>Storage</h2>
      {storage && line ? (
        <div style={{ display: 'grid', gap: 8, fontSize: 'var(--fs-base)' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', color: 'var(--ink3)' }}>
            {storage.path}
          </div>
          <div style={{ color: 'var(--ink2)' }}>{line.text}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {armed ? (
              <>
                <span style={{ color: 'var(--ink2)' }}>{confirmLine(storage)}</span>
                <button type="button" style={dangerBtn} disabled={busy} onClick={() => void clean()}>
                  {busy ? 'clearing…' : '✕ clear them'}
                </button>
                <button type="button" style={btn} disabled={busy} onClick={() => setArmed(false)}>
                  cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  style={line.canClean ? btn : { ...btn, opacity: 0.5, cursor: 'default' }}
                  disabled={!line.canClean}
                  onClick={() => {
                    setNote(null);
                    setArmed(true);
                  }}
                  title="Delete the events of jobs and agents you removed"
                >
                  ⌫ clean up
                </button>
                <button type="button" style={btn} onClick={load} title="Count again">
                  ↻
                </button>
              </>
            )}
            {note && <span style={{ color: 'var(--ink3)' }}>{note}</span>}
          </div>
        </div>
      ) : (
        <Empty>{note ?? 'Reading the database…'}</Empty>
      )}
    </section>
  );
}

function summarise(p: EventPayload): string {
  if ('label' in p) return p.label;
  if ('text' in p) return p.text.slice(0, 90).replace(/\n/g, '⏎');
  if ('path' in p) return p.path;
  if ('status' in p) return p.status;
  if ('summary' in p) return p.summary;
  return JSON.stringify(p).slice(0, 90);
}

const h2: React.CSSProperties = {
  fontFamily: 'var(--disp)',
  fontSize: 'var(--fs-xs)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
  marginBottom: 8,
};
const grid: React.CSSProperties = { display: 'flex', gap: 22, flexWrap: 'wrap' };
const table: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontFamily: 'var(--mono)',
  fontSize: 'var(--fs-md)',
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '5px 9px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--ink3)',
  fontWeight: 400,
};
const td: React.CSSProperties = { padding: '5px 9px', borderBottom: '1px solid var(--line)' };
const pre: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--fs-md)',
  lineHeight: 1.7,
  background: 'var(--well)',
  border: '1px solid var(--line)',
  borderRadius: 7,
  padding: '10px 13px',
  overflowX: 'auto',
  color: 'var(--ink2)',
};
const btn: React.CSSProperties = {
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  background: 'var(--surf)',
  border: '1px solid var(--line2)',
  borderRadius: 5,
  color: 'var(--ink2)',
  padding: '2px 8px',
  cursor: 'pointer',
};

const dangerBtn: React.CSSProperties = { ...btn, color: 'var(--fail)', borderColor: 'var(--fail)' };

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-md)' }}>
      <div style={{ color: 'var(--ink3)', fontSize: 'var(--fs-sm)' }}>{k}</div>
      <div>{v}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: 'var(--ink3)', fontSize: 'var(--fs-base)' }}>
      {children}
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'diagnostics',
  label: 'Diagnostics',
  hotkey: '0',
  order: 99,
  Component: Diagnostics,
};
