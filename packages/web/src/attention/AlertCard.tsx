/**
 * The alert card: an agent that stopped, or an outage.  Amendment 28 (F10, F13).
 *
 * Track E owns this file.
 *
 * There is nothing to approve here, so the card says what happened, what to check, and
 * offers first the one button that fixes it. Which buttons it offers is decided in
 * ./alerts.ts, where it can be checked.
 *
 * A button that works does not remove the card. The daemon clears the alert once the
 * agent is running again, so a continue that was accepted and then refused again stays
 * on screen instead of vanishing on the strength of a 200.
 */

import { useEffect, useRef, useState } from 'react';
import type { Agent, Alert, AlertKind, Project } from '@conductor/shared';
import { useCommand } from '../agent/endpoints.js';
import { navigate } from '../lib/nav.js';
import { alertTitle, retryHint } from '../shell/describe.js';
import { fmtMoney } from '../shell/ui.js';
import { editNote } from '../fleet/endpoints.js';
import { Kv } from './bits.jsx';
import { HandOffPanel } from './HandOff.jsx';
import {
  alertActions,
  alertProject,
  continueAgent,
  dismissAlert,
  raiseAndContinue,
  waitingRoles,
  type AlertAction,
} from './alerts.js';

const KIND: Record<AlertKind, { label: string; tone: string }> = {
  failed: { label: 'Agent failed', tone: 'var(--fail)' },
  budget: { label: 'Budget reached', tone: 'var(--need)' },
  connection: { label: 'Model API', tone: 'var(--need)' },
  server_down: { label: 'Dev server down', tone: 'var(--fail)' },
  daily_budget: { label: 'Daily budget', tone: 'var(--fail)' },
  note_due: { label: 'Note due', tone: 'var(--need)' },
  blocked_dep: { label: 'Waiting', tone: 'var(--need)' },
  handoff_held: { label: 'Not handed off', tone: 'var(--need)' },
};

/** What the strip says once a fix was accepted, until the daemon clears the card. */
const SENT = 'sent — this clears once the agent is running again';

export interface AlertCardProps {
  alert: Alert;
  agents: readonly Agent[];
  projects: readonly Project[];
  focused: boolean;
  /**
   * Shown on that agent's own Agent screen, in its Needs you panel (Amendment 108): "open"
   * for the alert's own agent would go where you already are, so it isn't offered. An open
   * for another agent, such as the one a waiting agent waits on, still is.
   */
  onAgentScreen?: boolean;
}

export function AlertCard({ alert, agents, projects, focused, onAgentScreen = false }: AlertCardProps) {
  const cmd = useCommand();
  const ref = useRef<HTMLDivElement | null>(null);
  // The hand-off summary box (Amendment 104). A new hold is a new alert, so it closes with it.
  const [handingOff, setHandingOff] = useState(false);
  const kind = KIND[alert.kind];
  const { head, subject } = alertTitle(alert, agents);
  const project = alertProject(alert, projects);
  const mine = alert.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  const first = mine[0];
  const actions = alertActions(alert, agents).filter(
    (a) => !(onAgentScreen && a.id === 'open' && alert.agentIds.includes(a.agentId)),
  );

  // Arriving from a notification: the card it was about, in view.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  const press = (a: AlertAction) => {
    switch (a.id) {
      case 'continue': {
        // Every agent, not only the card's: a blocked one's fix is the agent it waits on.
        const who = agents.filter((m) => a.agentIds.includes(m.id));
        void cmd.run(
          a.label === 'retry' ? 'Retrying' : 'Continuing',
          () => Promise.all(who.map((m) => continueAgent(m))),
          SENT,
        );
        return;
      }
      case 'raise': {
        const agent = mine.find((m) => m.id === a.agentId);
        if (agent) void cmd.run('Raising the budget', () => raiseAndContinue(agent, a.to), SENT);
        return;
      }
      case 'open':
        navigate('agent', { agentId: a.agentId });
        return;
      case 'hand_off':
        setHandingOff((open) => !open);
        return;
      case 'preview':
        navigate('preview', { jobId: a.jobId });
        return;
      case 'note_done':
        void cmd.run('Ticking the note', () => editNote(a.projectId, a.noteId, { done: true }), 'Done.');
        return;
      case 'project':
        navigate('project', { projectId: a.projectId });
        return;
      case 'dismiss':
        void cmd.run('Dismissing', () => dismissAlert(alert.id));
    }
  };

  const cap = first?.autonomy.budgetUsd ?? null;
  const roles = mine.map((m) => m.role).join(' · ');
  const blocker = alert.blockedBy === undefined ? undefined : agents.find((a) => a.id === alert.blockedBy);

  return (
    <div
      ref={ref}
      id={`alert-${alert.id}`}
      className="atn-card atn-alert"
      data-kind={alert.kind}
      data-focused={focused}
    >
      <div className="atn-cardhead">
        <i className="atn-dot" />
        <span className="atn-lab" style={{ color: kind.tone }}>
          {kind.label}
        </span>
        {project !== null && <span className="atn-tag">{project}</span>}
        <span className="atn-wait" title={alert.since}>
          since {clock(alert.since)}
        </span>
      </div>

      <div className="atn-cardbody">
        <div className="atn-alerttitle">
          {head} <b>{subject}</b>
        </div>

        {roles !== '' && <Kv k={mine.length > 1 ? 'agents' : 'agent'} v={roles} />}
        {alert.kind === 'budget' && first && cap !== null && (
          <Kv k="spent" v={`${fmtMoney(first.costUsd)} of ${fmtMoney(cap)}`} tone="var(--need)" />
        )}
        {alert.kind === 'failed' && <Kv k="reason" v={alert.cause} />}
        {alert.kind === 'blocked_dep' && blocker && <Kv k="waiting on" v={`${blocker.role} · ${alert.cause}`} />}
        {alert.kind === 'handoff_held' && first && waitingRoles(first.id, agents).length > 0 && (
          <Kv k="waiting" v={waitingRoles(first.id, agents).join(' · ')} />
        )}
        {alert.detail !== undefined && <Kv k="sdk said" v={alert.detail} />}
        {alert.endpoint !== undefined && <Kv k="endpoint" v={alert.endpoint} />}
        {alert.port !== undefined && <Kv k="port" v={String(alert.port)} />}
        {alert.kind === 'note_due' && alert.noteText !== undefined && (
          <Kv k={alert.late ? 'late' : 'due'} v={alert.noteText} tone={alert.late ? 'var(--fail)' : 'var(--need)'} />
        )}
        {alert.kind === 'daily_budget' && alert.spent !== undefined && alert.budget !== undefined && (
          <Kv k="today" v={`${fmtMoney(alert.spent)} of ${fmtMoney(alert.budget)}`} tone="var(--fail)" />
        )}

        <div className="atn-actions">
          {actions.map((a, i) => (
            <button
              key={`${a.id}-${i}`}
              type="button"
              className={`atn-btn${i === 0 && isFix(a) ? ' primary' : a.id === 'dismiss' ? ' ghost' : ''}`}
              disabled={cmd.busy}
              title={titleOf(a)}
              onClick={() => press(a)}
            >
              {labelOf(a)}
            </button>
          ))}
        </div>

        {alert.kind === 'handoff_held' && first && (
          <>
            <HandOffPanel agent={first} editing={handingOff} onClose={() => setHandingOff(false)} cmd={cmd} />
            <div className="atn-note">
              It ended its turn without calling hand_off, so the agents after it have not started. Hand off to start them
              with a summary you can edit first, or reply and it works again.
            </div>
          </>
        )}
        {alert.kind === 'connection' && (
          <div className="atn-note">
            <b>{retryHint(alert.cause, alert.gaveUp === true)}</b>
            <br />
            {alert.gaveUp
              ? 'Every affected run has ended; retry once it is fixed.'
              : 'It clears on its own once the model answers.'}
          </div>
        )}
        {alert.kind === 'blocked_dep' && (
          <div className="atn-note">
            {alert.cause === 'stopped'
              ? 'It is paused, since a stopped agent is not coming back. Resume it to run without that one, or remove that one from the stack on its Agent screen and this waits on what it waited on.'
              : 'It stays queued: continue the failed one, and this starts once that is done.'}
          </div>
        )}
        {alert.kind === 'server_down' && (
          <div className="atn-note">
            It stopped without being asked to. The preview can start it again.
          </div>
        )}
        {alert.kind === 'daily_budget' && (
          <div className="atn-note">
            A warning only: agents keep going. Raise the budget on Settings (9), or stop agents yourself. It resets at
            midnight.
          </div>
        )}
      </div>

      {cmd.busy ? (
        <div className="atn-status" data-phase="submitting">
          <i className="atn-spin" />
          sending…
        </div>
      ) : (
        cmd.notice && (
          <div
            className="atn-status"
            data-phase={cmd.notice.tone === 'ok' ? 'sent' : 'error'}
            onClick={cmd.dismiss}
          >
            {cmd.notice.tone === 'ok' ? '✓' : '✕'} {cmd.notice.text}
          </div>
        )
      )}
    </div>
  );
}

/** Something that makes the problem go away, as opposed to looking at it. */
function isFix(a: AlertAction): boolean {
  return a.id === 'continue' || a.id === 'raise' || a.id === 'note_done' || a.id === 'hand_off';
}

function labelOf(a: AlertAction): string {
  switch (a.id) {
    case 'continue':
      if (a.role !== undefined) return `${a.label} ${a.role}`;
      return a.label === 'retry' && a.agentIds.length > 1 ? `retry ${a.agentIds.length} agents` : a.label;
    case 'raise':
      return `+$${a.by} and continue`;
    case 'open':
      return a.role !== undefined ? `open ${a.role}` : 'open agent';
    case 'hand_off':
      return 'hand off';
    case 'preview':
      return 'open preview';
    case 'note_done':
      return '✓ mark done';
    case 'project':
      return 'open project';
    case 'dismiss':
      return 'dismiss';
  }
}

function titleOf(a: AlertAction): string | undefined {
  switch (a.id) {
    case 'raise':
      return `Raise the cap to ${fmtMoney(a.to)}, then continue`;
    case 'hand_off':
      return 'Edit the summary the agents after it are told, then send it';
    case 'dismiss':
      return 'Put it away. It comes back only if this happens again.';
    default:
      return undefined;
  }
}

/** When it started, as a time of day: it doesn't need a ticking clock to stay right. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
