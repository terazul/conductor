/**
 * The inspector — the queue itself, the notification ladder, the key legend.
 *
 * Track E owns this file.
 *
 * Oldest first, because that is the order you should answer in and
 * `usePending()` already sorts that way. The aging bar is the whole point of
 * this panel: a twelve-minute wait has to look worse than a forty-second one
 * before you have read either label.
 *
 * Alerts (Amendment 28) are listed after the requests and counted with them. They
 * don't get an aging bar: a stopped agent is no worse at twelve minutes than at one.
 */

import type { Agent, Alert, PendingRequest, Project } from '@conductor/shared';
import type { Decisions } from './decisions.js';
import type { LadderPrefs } from './notify.js';
import { CHANNELS, channelHint, ladderActions } from './notify.js';
import { AgeBar } from './bits.jsx';
import { ageLabel, ageToken, ageTier, waitingMs } from './aging.js';
import { requestTitle } from './describe.js';
import { alertTitle, alertWord } from '../shell/describe.js';
import { alertProject } from './alerts.js';
import { QUEUE_PANEL, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';

export interface QueuePanelProps {
  pending: readonly PendingRequest[];
  alerts: readonly Alert[];
  agents: readonly Agent[];
  projects: readonly Project[];
  now: number;
  focusedId: string | null;
  focusedAlertId: string | null;
  decisions: Decisions;
  /**
   * Read-only view of the ladder's preferences. The ladder itself runs in
   * ./always.tsx; this panel only toggles it, so the tab badge has one owner.
   */
  ladderPrefs: LadderPrefs;
  onFocus: (requestId: string) => void;
  onFocusAlert: (alertId: string) => void;
}

export function QueuePanel({
  pending,
  alerts,
  agents,
  projects,
  now,
  focusedId,
  focusedAlertId,
  decisions,
  ladderPrefs,
  onFocus,
  onFocusAlert,
}: QueuePanelProps) {
  const oldestMs = pending.reduce((worst, r) => Math.max(worst, waitingMs(r.createdAt, now)), 0);
  const count = pending.length + alerts.length;
  // Drag its left edge (Amendment 34). Leftwards grows it, hence `grow={-1}`.
  const { size, handle } = usePanel(QUEUE_PANEL);

  return (
    <>
      <Splitter orientation="vertical" grow={-1} label="Resize the attention queue" {...handle} />
      <aside className="atn-insp" style={{ width: `${size}px` }}>
        <div className="atn-isec" data-need={count > 0}>
          <span className="atn-lab" style={count > 0 ? { color: 'var(--need)' } : undefined}>
            Attention queue · {count}
          </span>

          {count === 0 ? (
            <p style={{ marginTop: 8, fontSize: 'var(--fs-md)', color: 'var(--ink3)' }}>
              Nothing waiting on you.
            </p>
          ) : (
            <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pending.map((r) => {
                const ms = waitingMs(r.createdAt, now);
                const st = decisions.stateOf(r.requestId);
                const sent = st.phase === 'sent' || st.phase === 'submitting';
                return (
                  <button
                    key={r.requestId}
                    type="button"
                    className="atn-qrow"
                    data-focused={r.requestId === focusedId}
                    data-sent={sent}
                    onClick={() => onFocus(r.requestId)}
                  >
                    <span
                      style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}
                    >
                      <i className="atn-dot" />
                      <span
                        className="atn-lab"
                        style={{ color: r.requestId === focusedId ? 'var(--need)' : undefined }}
                      >
                        {r.projectName} · {r.agentRole}
                      </span>
                      <span className="atn-optnum" style={{ marginLeft: 'auto' }}>
                        {r.blockMode === 'held' ? 'held' : 'parked'}
                      </span>
                    </span>

                    <span className="atn-qmeta" style={{ display: 'block' }}>
                      {requestTitle(r)}
                    </span>

                    <span style={{ display: 'block', margin: '6px 0 3px' }}>
                      <AgeBar ms={ms} />
                    </span>

                    <span
                      className="atn-qage"
                      style={{ color: ageToken(ageTier(ms)), display: 'block' }}
                    >
                      {sent ? `${ageLabel(ms)} · sent, unconfirmed` : ageLabel(ms)}
                    </span>
                  </button>
                );
              })}

              {alerts.map((a) => {
                const { head, subject } = alertTitle(a, agents);
                const project = alertProject(a, projects);
                return (
                  <button
                    key={a.id}
                    type="button"
                    className="atn-qrow"
                    data-focused={a.id === focusedAlertId}
                    onClick={() => onFocusAlert(a.id)}
                  >
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
                      <i className="atn-dot" />
                      <span className="atn-lab" style={{ color: a.id === focusedAlertId ? 'var(--need)' : undefined }}>
                        {project ?? 'all projects'}
                      </span>
                      <span className="atn-optnum" style={{ marginLeft: 'auto' }}>
                        {alertWord(a)}
                      </span>
                    </span>
                    <span className="atn-qmeta" style={{ display: 'block' }}>
                      {head} {subject}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="atn-isec">
          <span className="atn-lab">Tell me how</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
            {CHANNELS.map((c) => {
              const on =
                c.id === 'tab'
                  ? true
                  : c.id === 'desktop'
                    ? ladderPrefs.desktopEnabled && ladderPrefs.desktopPermission === 'granted'
                    : c.id === 'sound'
                      ? ladderPrefs.soundEnabled
                      : false;

              const blocked = c.id === 'desktop' && ladderPrefs.desktopPermission === 'denied';
              const unsupported =
                c.id === 'desktop' && ladderPrefs.desktopPermission === 'unsupported';

              return (
                <button
                  key={c.id}
                  type="button"
                  className="atn-pill"
                  data-on={on}
                  disabled={!c.available || !c.toggleable || blocked || unsupported}
                  title={
                    blocked
                      ? 'Blocked in browser settings — re-allow notifications for this site.'
                      : unsupported
                        ? 'This browser has no Notification API.'
                        : !c.available
                          ? 'A later phase. Not wired up.'
                          : !c.toggleable
                            ? 'Always on.'
                            : 'Click to toggle'
                  }
                  onClick={() => {
                    if (c.id === 'desktop') {
                      if (on) ladderActions.disableDesktop();
                      else void ladderActions.enableDesktop(pending, alerts);
                    } else if (c.id === 'sound') {
                      ladderActions.toggleSound(pending, alerts);
                    }
                  }}
                >
                  <span>{on ? '◉' : '○'}</span>
                  <span>{c.label}</span>
                  <span className="hint">
                    {blocked ? 'blocked' : unsupported ? 'n/a' : channelHint(c, oldestMs)}
                  </span>
                </button>
              );
            })}
          </div>
          {ladderPrefs.desktopPermission === 'default' && (
            <p style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--ink3)', lineHeight: 1.45 }}>
              Desktop notifications are off until you ask for them — we don’t prompt on load.
            </p>
          )}
        </div>

        <div className="atn-isec">
          <span className="atn-lab">Keyboard</span>
          <div className="atn-keys">
            {[
              ['⏎', 'answer, then next blocked agent'],
              ['⇥', 'skip to next · ⇧⇥ previous'],
              ['⎋', 'deny, with a reason'],
              ['a', 'allow for the whole session'],
              ['e', 'edit & run (held only)'],
              ['↑↓', 'move between options'],
              ['␣', 'choose the option'],
              ['o', 'answer in your own words'],
              ['⌘⏎', 'commit a composer'],
            ].map(([k, what]) => (
              <div className="atn-keyrow" key={k}>
                <kbd>{k}</kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
