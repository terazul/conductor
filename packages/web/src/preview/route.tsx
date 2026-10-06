/**
 * Screen 6 — Preview. The agent's dev server, embedded.
 *
 * TRACK D OWNS THIS FILE.
 *
 * Registered by the web app's screen auto-registration (`main.tsx` globs
 * `src/＊/route.tsx`), which is why adding a screen collides with nobody. Slot 60,
 * hotkey `6`, reserved for this track in CONTRACT.md §3.
 *
 * THE ONE THING TO UNDERSTAND BEFORE EDITING
 * ──────────────────────────────────────────
 * The iframe's `src` is `server.proxyPath` — a path on the daemon's own origin.
 * It is NEVER `http://localhost:<port>`. Pointing it at the dev server directly
 * is the obvious thing to write and it does not work: dev servers ship
 * `X-Frame-Options` and `frame-ancestors` and the browser renders an empty box.
 * The daemon's `/preview/:jobId/*` proxy exists to strip those headers and to
 * rewrite the app's own root-absolute asset paths so they resolve under the
 * prefix. `DevServer.proxyPath` in the frozen wire contract carries a comment
 * saying exactly this. Believe it.
 *
 * `↗ real browser` is the deliberate exception: it opens the true dev-server URL
 * in a new tab, because the reason to leave the pane is devtools, and devtools
 * want the real origin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DevServer, SendConsoleToAgentResponse } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { api } from '../lib/feed.js';
import { errorText } from '../lib/errors.js';
import { currentRoute, onNavigate } from '../lib/nav.js';
import { useAgents, useJobs, useProjects, useServers } from '../lib/store.js';
import { Dock, type DockTab } from './Dock.jsx';
import { useConsoleLog } from './useConsoleLog.js';
import './preview.css';

type Device = '390' | '768' | 'full';

const DEVICES: Array<{ id: Device; label: string; glyph: string; hint: string }> = [
  { id: '390', label: '390', glyph: '▯', hint: 'phone width' },
  { id: '768', label: '768', glyph: '▭', hint: 'tablet width' },
  { id: 'full', label: 'full', glyph: '▬', hint: 'fill the pane' },
];

/** What the shim posts up when the previewed app navigates. */
interface PreviewMessage {
  source: 'conductor-preview';
  jobId: string;
  path: string;
}

function isPreviewMessage(data: unknown): data is PreviewMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === 'conductor-preview' &&
    typeof (data as { path?: unknown }).path === 'string' &&
    typeof (data as { jobId?: unknown }).jobId === 'string'
  );
}

function Preview() {
  const servers = useServers();
  const jobs = useJobs();
  const projects = useProjects();
  const agents = useAgents();

  // Live servers first; a dead one is still worth listing so the pane can say
  // "was on 3000" rather than silently forgetting.
  const ordered = useMemo(
    () => [...servers].sort((a, b) => Number(b.alive) - Number(a.alive) || a.port - b.port),
    [servers],
  );

  /**
   * Which job's server to show.
   *
   * Seeded from the route params (Amendment 3) so another screen can deep-link
   * here: `navigate('preview', { jobId })` is what the Fleet card's
   * "◈ localhost:3000" button should call. Without this the pane would open on
   * whichever server happens to sort first, which is the wrong one as soon as
   * two projects are running — and it would look like a bug in the card.
   */
  const [pinnedJob, setPinnedJob] = useState<string | null>(
    () => currentRoute().params['jobId'] ?? null,
  );
  const server: DevServer | null =
    ordered.find((s) => s.jobId === pinnedJob) ?? ordered[0] ?? null;
  const jobId = server?.jobId ?? null;

  const [device, setDevice] = useState<Device>('full');
  const [path, setPath] = useState('/');
  const [draft, setDraft] = useState('/');
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<DockTab>('console');
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'fail' } | null>(null);

  const log = useConsoleLog(jobId);

  const job = jobs.find((j) => j.id === jobId) ?? null;
  const project = projects.find((p) => p.id === job?.projectId) ?? null;
  const owner = agents.find((a) => a.id === server?.startedByAgentId) ?? null;
  /** Any agent on the job will do as a fallback recipient for the errors. */
  const recipient = owner ?? agents.find((a) => a.jobId === jobId) ?? null;

  // Reset the path when the selected server changes — a path from another app is
  // worse than the root. Unless navigation supplied one, in which case that wins:
  // `navigate('preview', { jobId, path })` sets both, and the reset would
  // otherwise wipe the path a moment after honouring the jobId.
  const lastJob = useRef<string | null>(null);
  const navPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastJob.current === jobId) return;
    lastJob.current = jobId;
    const next = navPathRef.current ?? '/';
    navPathRef.current = null;
    setPath(next);
    setDraft(next);
    setNotice(null);
  }, [jobId]);

  /**
   * React to being navigated to again while already mounted.
   *
   * The screen stays mounted across hash changes, so a second
   * `navigate('preview', { jobId })` from a different Fleet card would otherwise
   * change nothing at all — the most confusing possible outcome for a click.
   */
  useEffect(
    () =>
      onNavigate((id, params) => {
        if (id !== 'preview') return;
        const wanted = params['path'];
        if (wanted) {
          const next = wanted.startsWith('/') ? wanted : `/${wanted}`;
          navPathRef.current = next;
          setPath(next);
          setDraft(next);
        }
        if (params['jobId']) setPinnedJob(params['jobId']);
      }),
    [],
  );

  // The shim reports in-app navigation so the URL bar tracks it instead of
  // freezing on whatever we first loaded.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!isPreviewMessage(event.data)) return;
      if (jobId !== null && event.data.jobId !== jobId) return;
      setPath(event.data.path);
      setDraft(event.data.path);
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [jobId]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  /** Move the IFRAME to a path. Distinct from nav.ts's `navigate`, which moves
   *  the Conductor UI between screens. */
  const goToPath = useCallback((next: string) => {
    const clean = next.trim().length === 0 ? '/' : next.trim();
    const withSlash = clean.startsWith('/') ? clean : `/${clean}`;
    setPath(withSlash);
    setDraft(withSlash);
    setReloadKey((n) => n + 1);
  }, []);

  const onStop = useCallback(async () => {
    if (!server) return;
    setStopping(true);
    setNotice(null);
    try {
      await api(
        `/api/jobs/${encodeURIComponent(server.jobId)}/servers/${server.port}/stop`,
        { method: 'POST' },
      );
      setNotice({ text: `Stopped the dev server on port ${server.port}.`, tone: 'info' });
    } catch (err) {
      setNotice({
        text: `Could not stop it — ${errorText(err)}`,
        tone: 'fail',
      });
    } finally {
      setStopping(false);
    }
  }, [server]);

  /**
   * Hand the captured errors to the agent as a synthetic user turn.
   *
   * Track A owns the endpoint that receives it, so until integration the daemon
   * answers `delivered: false` rather than failing. That is reported honestly:
   * claiming the agent was notified when it was not is the worst outcome here,
   * because the human then stops watching.
   */
  const onSend = useCallback(async () => {
    if (!server || !recipient) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await api<SendConsoleToAgentResponse>(
        `/api/jobs/${encodeURIComponent(server.jobId)}/console/send`,
        {
          method: 'POST',
          body: {
            agentId: recipient.id,
            entries: log.entries.filter((e) => e.level === 'error'),
          },
        },
      );
      setNotice(
        res.delivered
          ? {
              text: `${res.count} error${res.count === 1 ? '' : 's'} sent to ${recipient.role}.`,
              tone: 'info',
            }
          : {
              text: `${res.count} error${res.count === 1 ? '' : 's'} composed, but the session engine did not accept them${res.detail ? ` (${res.detail})` : ''}. Nothing was lost — they are still in the log.`,
              tone: 'fail',
            },
      );
    } catch (err) {
      setNotice({
        text: `Could not send them — ${errorText(err)}`,
        tone: 'fail',
      });
    } finally {
      setSending(false);
    }
  }, [server, recipient, log.entries]);

  if (!server) return <NoServers />;

  /**
   * How to spell the upstream. IPv6 needs brackets in a URL.
   *
   * `server.host` arrived with Amendment 6. Before it the UI had to guess, and
   * both available guesses were wrong some of the time: `127.0.0.1` refuses to
   * connect for a `::1`-only server, and `localhost` leaves the browser to pick
   * a family that may not be the one listening. Now it is simply known.
   */
  const origin = server.host.includes(':')
    ? `[${server.host}]:${server.port}`
    : `${server.host}:${server.port}`;
  const src = `${server.proxyPath}${path}`;
  /** The real dev-server URL, for devtools. Exact, no resolution guesswork. */
  const directUrl = `http://${origin}${path}`;
  const serverLabel = server.alive ? 'dev server' : 'dev server (gone)';

  return (
    <div className="pv">
      <div className="pv-head">
        <span className="pv-crumb">
          {project?.name ?? job?.branch ?? server.jobId}
          <i>/</i>
          <b>preview</b>
        </span>

        <div className="pv-urlbar">
          <button type="button" className="pv-btn" onClick={reload} title="Reload the pane">
            ↺
          </button>
          <div className="pv-url">
            <span className="pv-dot" data-live={String(server.alive)} title={server.alive ? 'listening' : 'not listening'} />
            <span className="pv-origin">{origin}</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') goToPath(draft);
                if (e.key === 'Escape') setDraft(path);
              }}
              onBlur={() => setDraft(path)}
              spellCheck={false}
              aria-label="Path within the previewed app"
            />
          </div>
        </div>

        <div className="pv-actions">
          {ordered.length > 1 && (
            <select
              className="pv-select"
              value={server.jobId}
              onChange={(e) => {
                // A manual switch must not inherit a path parked by an earlier
                // navigate() — clear it before the job-change reset reads it.
                navPathRef.current = null;
                setPinnedJob(e.target.value);
              }}
              aria-label="Which dev server to preview"
            >
              {ordered.map((s) => {
                const label = projects.find(
                  (p) => p.id === jobs.find((j) => j.id === s.jobId)?.projectId,
                )?.name;
                return (
                  <option key={`${s.jobId}:${s.port}`} value={s.jobId}>
                    {label ?? s.jobId} :{s.port}
                    {s.alive ? '' : ' (gone)'}
                  </option>
                );
              })}
            </select>
          )}

          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              className="pv-btn"
              aria-pressed={device === d.id}
              onClick={() => setDevice(d.id)}
              title={d.hint}
            >
              {d.glyph} {d.label}
            </button>
          ))}

          <a
            className="pv-btn"
            href={directUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the real dev server in a new tab, for devtools"
          >
            ↗ real browser
          </a>
        </div>
      </div>

      <div className="pv-body">
        <div className="pv-stage" data-device={device}>
          {/*
            No `sandbox` attribute, deliberately, and it is a real trade-off.
            Same-origin proxying is what defeats the frame blockers and what lets
            the injected shim POST captured console output back without CORS —
            but it also means the previewed app shares this origin. For code the
            user's own agent wrote in the user's own repo, on a loopback-only
            daemon, that is an acceptable exposure; tightening it (opaque-origin
            sandbox + CORS on the console endpoint) is an I5 hardening item.
          */}
          <iframe
            key={`${server.jobId}:${server.port}:${path}:${reloadKey}`}
            className="pv-frame"
            src={src}
            title="Preview of the agent's dev server"
          />
          {device !== 'full' && (
            <div className="pv-devicelabel">{device}px · {DEVICES.find((d) => d.id === device)?.hint}</div>
          )}
        </div>
      </div>

      {notice && (
        <div className="pv-notice" data-tone={notice.tone === 'fail' ? 'fail' : undefined}>
          {notice.text}
        </div>
      )}

      <Dock
        tab={tab}
        onTab={setTab}
        log={log}
        server={server}
        serverLabel={serverLabel}
        ownerRole={recipient?.role ?? null}
        onStop={() => void onStop()}
        onSend={() => void onSend()}
        stopping={stopping}
        sending={sending}
        canSend={recipient !== null}
      />
    </div>
  );
}

/**
 * Shown when no dev server has been detected anywhere.
 *
 * Explicit about the mechanism, because the natural assumption when this pane is
 * empty is that the preview is broken. It isn't — there is simply nothing
 * listening, and knowing *how* detection works is what tells you what to do next.
 */
function NoServers() {
  return (
    <div className="pv">
      <div className="pv-head">
        <span className="pv-crumb">
          <b>preview</b>
        </span>
      </div>
      <div className="pv-empty">
        <div className="pv-empty-inner">
          <h2>No dev server yet</h2>
          <p>
            Conductor doesn't ask you for a port. It watches each agent's own{' '}
            <code>Bash</code> calls for something that looks like a dev-server
            launch — <code>npm run dev</code>, <code>vite</code>,{' '}
            <code>next dev</code>, <code>pnpm dev</code> — then confirms the guess
            by probing the port until something answers HTTP.
          </p>
          <p>Once one is up, this pane embeds it here:</p>
          <ul>
            <li>served through the daemon, so the dev server's frame-blocking headers can't blank it out</li>
            <li>device widths for responsive checks, and ↗ to open the real origin for devtools</li>
            <li>the app's console piped back, so an error can go to the agent in one click</li>
          </ul>
          <p style={{ color: 'var(--ink3)' }}>
            Nothing is listening right now. If a server <em>is</em> running and
            Conductor missed it, register it explicitly with{' '}
            <code>POST /api/jobs/&lt;jobId&gt;/servers</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'preview',
  label: 'Preview',
  hotkey: '6',
  order: 60,
  Component: Preview,
};
