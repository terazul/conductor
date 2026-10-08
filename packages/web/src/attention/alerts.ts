/**
 * What an alert card offers, and the calls behind each button.  Amendment 28 (F10, F13).
 *
 * Track E owns this file.
 *
 * Kept apart from the card so the choice of buttons can be checked without a browser:
 * a card that offers **continue** to an agent with no session to continue fails only
 * when someone clicks it, which is the worst moment to find out.
 */

import { HANDOFF_SUMMARY_MAX, waitersOf, type Agent, type Alert, type Event, type Project } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { handOffAgent, resumeAgent, sendMessage, setAutonomy } from '../agent/endpoints.js';
import { BUDGET_RAISES } from '../shell/autonomy.js';
import { alertTitle } from '../shell/describe.js';

export type AlertAction =
  /**
   * Resume the agents. `retry` when the model API gave up on them, `resume` for one paused
   * behind a stopped agent (Amendment 88), `continue` otherwise. `role` when it isn't the
   * agent the card is about (Amendment 85).
   */
  | { id: 'continue'; label: 'continue' | 'retry' | 'resume'; agentIds: readonly string[]; role?: string }
  /** Raise the cap to `to`, then continue. */
  | { id: 'raise'; agentId: string; by: number; to: number }
  | { id: 'open'; agentId: string; role?: string }
  /**
   * Hand off for an agent that stopped without doing it (Amendment 104). Opens the summary
   * for editing, prefilled with its last reply; sending that is what hands off.
   */
  | { id: 'hand_off'; agentId: string; role?: string }
  | { id: 'preview'; jobId: string }
  /** A due note (Amendment 63): tick it done, or go to its project. */
  | { id: 'note_done'; projectId: string; noteId: string }
  | { id: 'project'; projectId: string }
  | { id: 'dismiss' };

/** The daemon's own resume nudge, so a continue from here reads like one from the composer. */
export const CONTINUE_TEXT = 'Continue from where you stopped.';

/**
 * Whether there is anything to continue. A paused agent always resumes: with a session
 * it carries on, without one it is queued. A failed one needs its session.
 */
export function resumable(agent: Pick<Agent, 'status' | 'sdkSessionId'>): boolean {
  return agent.status === 'paused' || (agent.status === 'failed' && agent.sdkSessionId !== null);
}

/** The buttons for one alert, the one that fixes it first. */
export function alertActions(alert: Alert, agents: readonly Agent[]): AlertAction[] {
  const mine = alert.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  const first = mine[0];
  const open: AlertAction[] = first ? [{ id: 'open', agentId: first.id }] : [];
  const dismiss: AlertAction = { id: 'dismiss' };

  switch (alert.kind) {
    case 'failed':
      return [
        ...(first && resumable(first)
          ? [{ id: 'continue', label: 'continue', agentIds: [first.id] } as const]
          : []),
        ...open,
        dismiss,
      ];

    case 'budget': {
      if (!first) return [dismiss];
      const cap = first.autonomy.budgetUsd;
      // Still at its cap: continuing alone would be refused, so every way on raises it.
      const fix: AlertAction[] =
        cap !== null && first.costUsd >= cap
          ? BUDGET_RAISES.map((n) => ({ id: 'raise', agentId: first.id, by: n, to: cap + n }))
          : resumable(first)
            ? [{ id: 'continue', label: 'continue', agentIds: [first.id] }]
            : [];
      return [...fix, ...open, dismiss];
    }

    case 'connection': {
      // While the SDK is still retrying there is nothing to press: the fix is the
      // network or the login, and the alert clears itself once the model answers.
      const stuck = alert.gaveUp ? mine.filter(resumable).map((a) => a.id) : [];
      return [
        ...(stuck.length > 0 ? [{ id: 'continue', label: 'retry', agentIds: stuck } as const] : []),
        ...open,
        dismiss,
      ];
    }

    case 'blocked_dep': {
      // The fix is the agent being waited on (Amendment 85): continue it if it can be,
      // and once it is done the waiting one starts. A stopped one isn't coming back, so
      // the waiting one, paused when it was stopped, is resumed to run without it (88).
      const by = agents.find((a) => a.id === alert.blockedBy);
      if (!by) return [...open, dismiss];
      if (by.status === 'stopped') {
        return [
          ...(first?.status === 'paused' ? [{ id: 'continue', label: 'resume', agentIds: [first.id] } as const] : []),
          { id: 'open', agentId: by.id, role: by.role },
          dismiss,
        ];
      }
      return [
        ...(resumable(by) ? [{ id: 'continue', label: 'continue', agentIds: [by.id], role: by.role } as const] : []),
        { id: 'open', agentId: by.id, role: by.role },
        dismiss,
      ];
    }

    case 'handoff_held':
      // The agent is done and the ones after it wait (Amendment 104). Handing off, with the
      // summary edited first, is the fix; replying to it, in the box on the card, is the other
      // way. A card whose agent this tab has not heard of can only be put away.
      return [...(first ? [{ id: 'hand_off', agentId: first.id } as const] : []), ...open, dismiss];

    case 'server_down':
      return [...(alert.jobId ? [{ id: 'preview', jobId: alert.jobId } as const] : []), dismiss];

    case 'daily_budget':
      // A warning (Amendment 59): nothing to fix from here but the budget, on Settings.
      return [dismiss];

    case 'note_due':
      return [
        ...(alert.projectId && alert.noteId ? [{ id: 'note_done', projectId: alert.projectId, noteId: alert.noteId } as const] : []),
        ...(alert.projectId ? [{ id: 'project', projectId: alert.projectId } as const] : []),
        dismiss,
      ];
  }
}

/** The project an alert is about, when it is about one. An outage can span several. */
export function alertProject(alert: Pick<Alert, 'projectId'>, projects: readonly Project[]): string | null {
  return alert.projectId === null ? null : (projects.find((p) => p.id === alert.projectId)?.name ?? null);
}

/** A desktop notification's title and body. */
export function alertNotice(
  alert: Alert,
  agents: readonly Agent[],
  projects: readonly Project[],
): { title: string; body: string } {
  const { head, subject } = alertTitle(alert, agents);
  const project = alertProject(alert, projects);
  const within = (t: string) => (project ? `${project} · ${t}` : t);
  // Worded like a request's notification, "demo · builder needs you", with the why below.
  if (alert.kind === 'budget' || alert.kind === 'failed' || alert.kind === 'blocked_dep' || alert.kind === 'handoff_held') {
    return { title: within(`${head} needs you`), body: `${head} ${subject}` };
  }
  return { title: within(head), body: subject };
}

/**
 * What the hand-off box starts with: the agent's last reply, which is what the agents after it
 * would have been told. '' for an agent that wrote none, and the box is then empty.
 */
export function handOffDraft(events: readonly Event[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const p = events[i]!.payload;
    if (p.kind === 'text' && p.text.trim() !== '') return p.text.trim();
  }
  return '';
}

/** Why this summary can't be sent yet, in a sentence, or null when it can. */
export function handOffProblem(summary: string): string | null {
  const n = summary.trim().length;
  if (n === 0) return 'Say what the agents after it need to know.';
  if (n > HANDOFF_SUMMARY_MAX) {
    return `${n.toLocaleString('en')} characters; the most a hand-off takes is ${HANDOFF_SUMMARY_MAX.toLocaleString('en')}.`;
  }
  return null;
}

/**
 * Who the hand-off is for, by role: the agents that wait for the held one and have not
 * started. The daemon's own rule (`waitersOf`), so the card names who the tool would have.
 */
export function waitingRoles(heldId: string, agents: readonly Agent[]): string[] {
  return waitersOf(heldId, agents)
    .filter((a) => a.status === 'queued' || a.status === 'paused')
    .map((a) => a.role);
}

/** Send the summary: it is what the agents after it are told first. */
export async function handOff(agent: Pick<Agent, 'id'>, summary: string): Promise<void> {
  await handOffAgent(agent.id, { summary: summary.trim() });
}

/** The same call the composer or the resume button would make, whichever fits. */
export async function continueAgent(agent: Pick<Agent, 'id' | 'status'>): Promise<void> {
  if (agent.status === 'paused') await resumeAgent(agent.id);
  else await sendMessage(agent.id, { text: CONTINUE_TEXT, synthetic: true });
}

/** Only the cap; the route merges it into the rest of the agent's autonomy. */
export async function raiseAndContinue(agent: Pick<Agent, 'id' | 'status'>, to: number): Promise<void> {
  await setAutonomy(agent.id, { autonomy: { budgetUsd: to } });
  await continueAgent(agent);
}

/** Stored by the daemon, so it stays put away after a reload. */
export function dismissAlert(alertId: string): Promise<unknown> {
  return api(`/api/alerts/${encodeURIComponent(alertId)}/dismiss`, { method: 'POST', body: {} });
}
