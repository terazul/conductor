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
import { type Agent, type Alert, type AlertKind, type Project } from '@conductor/shared';
import { retryNowAgent, stopRetryingAgent, useCommand } from '../agent/endpoints.js';
import { navigate } from '../lib/nav.js';
import { openBranches } from '../shell/nav.js';
import { alertTitle, reconnectLine, retryHead, retryHint } from '../shell/describe.js';
import { tokenWords } from '../lib/providers.js';
import { budgetOf, budgetWords } from '../shell/autonomy.js';
import { useNow } from './useNow.js';
import { fmtMoney } from '../shell/ui.js';
import { editNote } from '../fleet/endpoints.js';
import { Kv } from './bits.jsx';
import { HandOffPanel } from './HandOff.jsx';
import {
  alertActions,
  alertProject,
  continueAgent,
  finishedConfirm,
  mergeAndClean,
  monthlyNote,
  mergeFinished,
  restoreAndContinue,
  dismissAlert,
  raiseAndContinue,
  raiseBudget,
  waitingRoles,
  type AlertAction,
} from './alerts.js';

const KIND: Record<AlertKind, { label: string; tone: string }> = {
  failed: { label: 'Agent failed', tone: 'var(--fail)' },
  budget: { label: 'Paused by its budget', tone: 'var(--need)' },
  connection: { label: 'Model API', tone: 'var(--need)' },
  server_down: { label: 'Dev server down', tone: 'var(--fail)' },
  daily_budget: { label: 'Daily budget', tone: 'var(--fail)' },
  monthly_budget: { label: 'Monthly budget', tone: 'var(--fail)' },
  note_due: { label: 'Note due', tone: 'var(--need)' },
  blocked_dep: { label: 'Waiting', tone: 'var(--need)' },
  handoff_held: { label: 'Not handed off', tone: 'var(--need)' },
  reconnecting: { label: 'Reconnecting', tone: 'var(--need)' },
  budget_over: { label: 'Over its daily budget', tone: 'var(--need)' },
  finished: { label: 'Finished', tone: 'var(--need)' },
  merged: { label: 'Merged', tone: 'var(--done)' },
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
  // The countdown on a card waiting to retry (Amendment 123): one tick a second, only then.
  const now = useNow(alert.kind === 'reconnecting');
  // The hand-off summary box (Amendment 104). A new hold is a new alert, so it closes with it.
  const [handingOff, setHandingOff] = useState(false);
  // "merge and clean up" asks first (Amendment 144): its agents can't be messaged after.
  const [confirmClean, setConfirmClean] = useState<Extract<AlertAction, { id: 'merge_clean' }> | null>(null);
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
        // A job's warning raises an agent the card is not about, so look in all of them.
        const agent = agents.find((m) => m.id === a.agentId);
        if (!agent) return;
        if (a.onlyRaise) void cmd.run('Raising the budget', () => raiseBudget(agent, a.to, a.unit), 'budget raised — the warning clears');
        else void cmd.run('Raising the budget', () => raiseAndContinue(agent, a.to, a.unit), SENT);
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
      case 'restore': {
        const agent = mine.find((m) => m.id === a.agentId);
        if (agent) void cmd.run('Recreating the folder', () => restoreAndContinue(a.jobId, agent), SENT);
        return;
      }
      case 'note_done':
        void cmd.run('Ticking the note', () => editNote(a.projectId, a.noteId, { done: true }), 'Done.');
        return;
      case 'project':
        navigate('project', { projectId: a.projectId });
        return;
      case 'merge_clean':
        setConfirmClean(a);
        return;
      case 'merge':
        void cmd.run(
          'Merging',
          async () => {
            const sha = await mergeFinished(a);
            await dismissAlert(alert.id);
            return sha;
          },
          (sha: string) => `merged into ${a.into} as ${sha.slice(0, 7)}; the job, its folder and its branch stay`,
        );
        return;
      case 'branches':
        openBranches(a.projectId);
        return;
      case 'dismiss':
        void cmd.run('Dismissing', () => dismissAlert(alert.id));
        return;
      case 'retry_now':
        void cmd.run('Retrying now', () => retryNowAgent(a.agentId), 'trying again now');
        return;
      case 'stop_retrying':
        void cmd.run('Stopping the retries', () => stopRetryingAgent(a.agentId), 'stopped retrying — it is failed');
    }
  };

  const cleanUp = (a: Extract<AlertAction, { id: 'merge_clean' }>) => {
    setConfirmClean(null);
    void cmd.run(
      'Merging and cleaning up',
      async () => {
        const sha = await mergeAndClean(a);
        // The job is gone, so the card goes with it; put it away in case this tab hears first.
        await dismissAlert(alert.id).catch(() => undefined);
        return sha;
      },
      (sha: string) => `merged into ${a.into} as ${sha.slice(0, 7)}, and cleaned up`,
    );
  };

  const roles = mine.map((m) => m.role).join(' · ');
  const blocker = alert.blockedBy === undefined ? undefined : agents.find((a) => a.id === alert.blockedBy);
  // "Reconnecting in 30 s (3 of 5)", counted down from when the daemon will try (Amendment 123).
  const reconnect =
    alert.kind === 'reconnecting' && alert.retryAt !== undefined
      ? {
          cause: alert.cause as 'unreachable' | 'auth' | 'throttled' | 'server',
          attempt: alert.attempt ?? 1,
          of: alert.maxRetries ?? 5,
          at: Date.parse(alert.retryAt),
        }
      : null;

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
        {reconnect ? (
          <div className="atn-alerttitle">
            <b>{reconnectLine(reconnect, now)}</b> · {retryHead({ cause: reconnect.cause, httpStatus: null })}
          </div>
        ) : (
          <div className="atn-alerttitle">
            {head} <b>{subject}</b>
          </div>
        )}

        {roles !== '' && <Kv k={mine.length > 1 ? 'agents' : 'agent'} v={roles} />}
        {alert.kind === 'budget' && first && budgetOf(first) !== null && (
          <Kv k="today" v={spentOf(first)} />
        )}
        {alert.kind === 'budget_over' && alert.spent !== undefined && alert.budget !== undefined && (
          <Kv k="today" v={`${said(alert.spent, alert.unit)} of ${said(alert.budget, alert.unit)}`} tone="var(--need)" />
        )}
        {alert.kind === 'failed' && <Kv k="reason" v={alert.cause} />}
        {alert.kind === 'blocked_dep' && blocker && <Kv k="waiting on" v={`${blocker.role} · ${alert.cause}`} />}
        {alert.kind === 'handoff_held' && first && waitingRoles(first.id, agents).length > 0 && (
          <Kv k="waiting" v={waitingRoles(first.id, agents).join(' · ')} />
        )}
        {(alert.kind === 'finished' || alert.kind === 'merged') && alert.branch !== undefined && (
          <Kv k="branch" v={alert.ahead !== undefined ? `${alert.branch} · ${alert.ahead} commit${alert.ahead === 1 ? '' : 's'}` : alert.branch} />
        )}
        {alert.kind === 'merged' && alert.sha !== undefined && <Kv k="merge" v={alert.sha.slice(0, 7)} />}
        {alert.kind === 'finished' && alert.detail !== undefined && <Kv k="not merged by itself" v={alert.detail} tone="var(--need)" />}
        {alert.kind === 'merged' && alert.detail !== undefined && <Kv k="not cleaned up" v={alert.detail} tone="var(--need)" />}
        {alert.detail !== undefined && alert.kind !== 'finished' && alert.kind !== 'merged' && <Kv k="sdk said" v={alert.detail} />}
        {alert.endpoint !== undefined && <Kv k="endpoint" v={alert.endpoint} />}
        {alert.port !== undefined && <Kv k="port" v={String(alert.port)} />}
        {alert.kind === 'note_due' && alert.noteText !== undefined && (
          <Kv k={alert.late ? 'late' : 'due'} v={alert.noteText} tone={alert.late ? 'var(--fail)' : 'var(--need)'} />
        )}
        {alert.kind === 'daily_budget' && alert.spent !== undefined && alert.budget !== undefined && (
          <Kv k="today" v={`${fmtMoney(alert.spent)} of ${fmtMoney(alert.budget)}`} tone="var(--fail)" />
        )}
        {alert.kind === 'monthly_budget' && alert.spent !== undefined && alert.budget !== undefined && (
          <Kv k="this month" v={`${fmtMoney(alert.spent)} of ${fmtMoney(alert.budget)}`} tone="var(--fail)" />
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

        {confirmClean && (
          <div className="atn-note" role="alertdialog" aria-label="confirm merge and clean up">
            {finishedConfirm(confirmClean)}{' '}
            <button type="button" className="atn-btn primary" disabled={cmd.busy} onClick={() => cleanUp(confirmClean)}>
              merge and clean up
            </button>{' '}
            <button type="button" className="atn-btn ghost" onClick={() => setConfirmClean(null)}>
              cancel
            </button>
          </div>
        )}
        {alert.kind === 'finished' && !confirmClean && (
          <div className="atn-note">
            Its job is done and its branch has commits {alert.into ?? 'main'} lacks. Merge keeps the job, its folder and its branch, so
            its agents can still be messaged; merge and clean up removes them, keeping the transcripts. Pushing stays on the Branches
            screen.
          </div>
        )}
        {alert.kind === 'merged' && (
          <div className="atn-note">
            Its agent had "merge into main and clean up when done" on.{' '}
            {alert.cleaned
              ? 'The job, its folder and its branch were removed; the transcripts stay. Nothing was pushed.'
              : 'The job, its folder and its branch are still there. Nothing was pushed.'}
          </div>
        )}
        {alert.kind === 'handoff_held' && first && (
          <>
            <HandOffPanel agent={first} editing={handingOff} onClose={() => setHandingOff(false)} cmd={cmd} />
            <div className="atn-note">
              It ended its turn without calling hand_off, so the agents after it have not started. Hand off to start them
              with a summary you can edit first, or reply and it works again.
            </div>
          </>
        )}
        {alert.kind === 'reconnecting' && (
          <div className="atn-note">
            <b>{retryHint(alert.cause, false)}</b>
            <br />
            It is waiting, not working: its slot is free. Retry now tries at once; stop retrying ends it as failed.
          </div>
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
        {alert.kind === 'budget' && (
          <div className="atn-note">
            It was paused when a budget still stopped agents. A budget only warns now, so continue carries it on as it is, with
            no raise first. Nothing continues it by itself.
          </div>
        )}
        {alert.kind === 'budget_over' && (
          <div className="atn-note">
            A warning only: {alert.cause === 'job_budget_over' ? 'the agents keep going' : 'it keeps working'}, however far past
            it goes. Raise the budget to quiet it, or leave it; it starts again at midnight.
          </div>
        )}
        {alert.kind === 'daily_budget' && (
          <div className="atn-note">
            A warning only: agents keep going. Raise the budget on Settings (9), or stop agents yourself. It resets at
            midnight.
          </div>
        )}
        {alert.kind === 'monthly_budget' && <div className="atn-note">{monthlyNote(project)}</div>}
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

/** A figure in the alert's unit: dollars, or tokens as people say them. */
function said(n: number, unit: Alert['unit']): string {
  return budgetWords(unit === 'tokens' ? 'tokens' : 'usd', n);
}

/** What a stopped agent has spent against its budget, in its own unit. */
function spentOf(agent: Agent): string {
  const b = budgetOf(agent);
  return b === null ? '' : `${budgetWords(b.unit, b.spent)} of ${budgetWords(b.unit, b.cap)}`;
}

/** Something that makes the problem go away, as opposed to looking at it. */
function isFix(a: AlertAction): boolean {
  return (
    a.id === 'continue' ||
    a.id === 'raise' ||
    a.id === 'note_done' ||
    a.id === 'hand_off' ||
    a.id === 'restore' ||
    a.id === 'retry_now' ||
    a.id === 'merge_clean'
  );
}

function labelOf(a: AlertAction): string {
  switch (a.id) {
    case 'continue':
      if (a.role !== undefined) return `${a.label} ${a.role}`;
      return a.label === 'retry' && a.agentIds.length > 1 ? `retry ${a.agentIds.length} agents` : a.label;
    case 'raise': {
      const by = a.unit === 'tokens' ? `+${tokenWords(a.by)} tokens` : `+$${a.by}`;
      return a.onlyRaise ? by : `${by} and continue`;
    }
    case 'open':
      return a.role !== undefined ? `open ${a.role}` : 'open agent';
    case 'hand_off':
      return 'hand off';
    case 'preview':
      return 'open preview';
    case 'restore':
      return 'recreate folder and continue';
    case 'note_done':
      return '✓ mark done';
    case 'project':
      return 'open project';
    case 'dismiss':
      return 'dismiss';
    case 'retry_now':
      return 'retry now';
    case 'stop_retrying':
      return 'stop retrying';
    case 'merge_clean':
      return 'merge and clean up';
    case 'merge':
      return 'merge';
    case 'branches':
      return 'open Branches';
  }
}

function titleOf(a: AlertAction): string | undefined {
  switch (a.id) {
    case 'raise': {
      const to = a.unit === 'tokens' ? `${tokenWords(a.to)} tokens` : fmtMoney(a.to);
      return a.onlyRaise ? `Raise the budget to ${to}` : `Raise the budget to ${to}, then continue`;
    }
    case 'hand_off':
      return 'Edit the summary the agents after it are told, then send it';
    case 'restore':
      return "Put the job's worktree back on its branch (or from main if the branch is gone), then continue in the same session";
    case 'dismiss':
      return 'Put it away. It comes back only if this happens again.';
    case 'retry_now':
      return 'Try the model again now instead of waiting';
    case 'stop_retrying':
      return 'Give up: the agent ends failed, as it would have before retries';
    case 'merge_clean':
      return `Merge ${a.branch} into ${a.into}, then remove its job, folder and branch (asks first)`;
    case 'merge':
      return `Merge ${a.branch} into ${a.into}; the job, its folder and its branch stay`;
    default:
      return undefined;
  }
}

/** When it started, as a time of day: it doesn't need a ticking clock to stay right. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
