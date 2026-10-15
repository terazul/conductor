/**
 * What an alert card offers, and the calls behind each button.  Amendment 28 (F10, F13).
 *
 * Track E owns this file.
 *
 * Kept apart from the card so the choice of buttons can be checked without a browser:
 * a card that offers **continue** to an agent with no session to continue fails only
 * when someone clicks it, which is the worst moment to find out.
 */

import { HANDOFF_SUMMARY_MAX, missingHeadings, waitersOf, type Agent, type Alert, type Event, type Project } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { handOffAgent, resumeAgent, sendMessage, setAutonomy } from '../agent/endpoints.js';
import { BUDGET_RAISES, TOKEN_RAISES, budgetOf, type Budget } from '../shell/autonomy.js';
import { alertTitle } from '../shell/describe.js';
import { branchAction, previewMerge } from '../branches/endpoints.js';
import { errorText } from '../lib/errors.js';

export type AlertAction =
  /**
   * Resume the agents. `retry` when the model API gave up on them, `resume` for one paused
   * behind a stopped agent (Amendment 88), `continue` otherwise. `role` when it isn't the
   * agent the card is about (Amendment 85).
   */
  | { id: 'continue'; label: 'continue' | 'retry' | 'resume'; agentIds: readonly string[]; role?: string }
  /**
   * Raise the budget to `to` (in `unit`, dollars when absent), then continue, unless
   * `onlyRaise`: the warning for an agent that is over its budget but not stopped
   * (Amendment 124) has nothing to continue.
   */
  | { id: 'raise'; agentId: string; by: number; to: number; unit?: 'tokens'; onlyRaise?: true }
  | { id: 'open'; agentId: string; role?: string }
  /**
   * Hand off for an agent that stopped without doing it (Amendment 104). Opens the summary
   * for editing, prefilled with its last reply; sending that is what hands off.
   */
  | { id: 'hand_off'; agentId: string; role?: string }
  | { id: 'preview'; jobId: string }
  /** Its job's folder was deleted (Amendment 114): recreate it, then continue. */
  | { id: 'restore'; jobId: string; agentId: string }
  /** A due note (Amendment 63): tick it done, or go to its project. */
  | { id: 'note_done'; projectId: string; noteId: string }
  | { id: 'project'; projectId: string }
  | { id: 'dismiss' }
  /**
   * An agent waiting to be tried again because the model couldn't be reached (Amendment 123):
   * try now, or give up and let it fail as it would have before retries.
   */
  | { id: 'retry_now'; agentId: string }
  | { id: 'stop_retrying'; agentId: string }
  /**
   * A job finished ahead of its target (Amendment 144). `merge_clean`: the merge, then Lane
   * J's delete with `forgetJob`, after a confirm. `merge`: the merge alone; the job, its
   * folder and its branch stay. `branches`: the project's Branches screen.
   */
  | { id: 'merge_clean'; projectId: string; branch: string; into: string; jobId: string }
  | { id: 'merge'; projectId: string; branch: string; into: string }
  | { id: 'branches'; projectId: string };

/** The daemon's own resume nudge, so a continue from here reads like one from the composer. */
export const CONTINUE_TEXT = 'Continue from where you stopped.';

/**
 * Whether there is anything to continue. A paused agent always resumes: with a session
 * it carries on, without one it is queued. A failed one needs its session.
 */
export function resumable(agent: Pick<Agent, 'status' | 'sdkSessionId'>): boolean {
  return agent.status === 'paused' || (agent.status === 'failed' && agent.sdkSessionId !== null);
}

/** The raises on offer for an agent's budget, in its unit: +$10 / +$25, or +100k / +500k tokens. */
function raisesFor(agent: Agent, b: Budget, onlyRaise: boolean): AlertAction[] {
  const rest = onlyRaise ? { onlyRaise: true as const } : {};
  return b.unit === 'tokens'
    ? TOKEN_RAISES.map((n) => ({ id: 'raise', agentId: agent.id, by: n, to: b.cap + n, unit: 'tokens', ...rest }))
    : BUDGET_RAISES.map((n) => ({ id: 'raise', agentId: agent.id, by: n, to: b.cap + n, ...rest }));
}

/**
 * Whose budget a job's warning raises (Amendment 124). The job's budget is the sum of its
 * agents', so raising any one raises it by as much: the one still spending that has spent
 * the most today, else the one that has spent the most today. Only agents with a dollar budget count
 * (the job's is in dollars). null when it has none this tab knows of.
 */
export function jobRaiseTarget(jobId: string | null, agents: readonly Agent[]): Agent | null {
  const mine = agents.filter((a) => a.jobId === jobId && budgetOf(a)?.unit === 'usd');
  const live = mine.filter((a) => a.status === 'working' || a.status === 'queued' || a.status === 'blocked');
  const pool = live.length > 0 ? live : mine;
  // The most spent TODAY, which is what the job's budget is read against (Amendment 129).
  const today = (a: Agent): number => budgetOf(a)?.spent ?? 0;
  return pool.reduce<Agent | null>((best, a) => (best === null || today(a) > today(best) ? a : best), null);
}

/** The buttons for one alert, the one that fixes it first. */
export function alertActions(alert: Alert, agents: readonly Agent[]): AlertAction[] {
  const mine = alert.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  const first = mine[0];
  const open: AlertAction[] = first ? [{ id: 'open', agentId: first.id }] : [];
  const dismiss: AlertAction = { id: 'dismiss' };

  switch (alert.kind) {
    case 'failed':
      // Its folder is gone: continuing alone would fail the same way, so the fix recreates it.
      if (alert.cause === 'folder_gone' && first) {
        return [{ id: 'restore', jobId: first.jobId, agentId: first.id }, ...open, dismiss];
      }
      return [
        ...(first && resumable(first)
          ? [{ id: 'continue', label: 'continue', agentIds: [first.id] } as const]
          : []),
        ...open,
        dismiss,
      ];

    case 'budget': {
      if (!first) return [dismiss];
      const b = budgetOf(first);
      // Still at its ceiling (twice its budget): continuing alone would be refused, so every way on raises it.
      const fix: AlertAction[] =
        b !== null && b.state === 'ceiling'
          ? raisesFor(first, b, false)
          : resumable(first)
            ? [{ id: 'continue', label: 'continue', agentIds: [first.id] }]
            : [];
      return [...fix, ...open, dismiss];
    }

    case 'budget_over': {
      // A warning (Amendment 124): the agent is still working or done, nothing is paused, so
      // the fix is the budget alone. A job's has no agent of its own: it raises the one that fits.
      const target = alert.cause === 'job_budget_over' ? jobRaiseTarget(alert.jobId, agents) : first;
      if (!target) return [dismiss];
      const b = budgetOf(target);
      const raises = b !== null && b.state !== 'ceiling' ? raisesFor(target, b, true) : [];
      const go: AlertAction[] = [{ id: 'open', agentId: target.id, ...(target === first ? {} : { role: target.role }) }];
      return [...raises, ...go, dismiss];
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

    case 'reconnecting':
      // It describes the present and clears when the try starts, so it is not put away: the two
      // ways to settle it are the buttons. A card for an agent this tab has not heard of can only
      // be put away.
      return first
        ? [{ id: 'retry_now', agentId: first.id }, { id: 'stop_retrying', agentId: first.id }, ...open]
        : [dismiss];

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

    case 'finished': {
      // Merge and clean up first: it is what the setting would have done (Amendment 144).
      const branches: AlertAction[] = alert.projectId ? [{ id: 'branches', projectId: alert.projectId }] : [];
      if (!alert.projectId || !alert.branch || !alert.into || !alert.jobId) return [...branches, dismiss];
      const at = { projectId: alert.projectId, branch: alert.branch, into: alert.into };
      return [{ id: 'merge_clean', ...at, jobId: alert.jobId }, { id: 'merge', ...at }, ...branches, dismiss];
    }

    case 'merged':
      // Information: what the setting merged. Its agent, when it is still there to open.
      return [...open, ...(alert.projectId ? [{ id: 'branches', projectId: alert.projectId } as const] : []), dismiss];
  }
}

/** The confirm before "merge and clean up" (Amendment 144): what goes, and that the agents can't be messaged after. */
export function finishedConfirm(a: Pick<Extract<AlertAction, { id: 'merge_clean' }>, 'branch' | 'into' | 'jobId'>): string {
  return `Merge ${a.branch} into ${a.into}, then remove job ${a.jobId}, its folder and its branch? Its agents can't be messaged afterwards; their transcripts stay.`;
}

/**
 * The card's merge (Amendment 144): Lane J's preview first, refused on what it says (a
 * reason, or conflicts, named), then the Branches screen's own merge into `into`. Answers
 * the merge commit. The job, its folder and its branch stay.
 */
export async function mergeFinished(a: { projectId: string; branch: string; into: string }): Promise<string> {
  const p = await previewMerge(a.projectId, a.branch, a.into);
  if (p.reason) throw new Error(p.reason);
  if (p.conflicts && p.conflicts.length > 0) throw new Error(`it would conflict with ${a.into} in ${p.conflicts.join(', ')} — merge it by hand`);
  if (p.ahead === 0) throw new Error(`nothing to merge — ${a.into} already has all of ${a.branch}`);
  const res = await branchAction(a.projectId, { action: 'merge', branch: a.branch, into: a.into });
  if (!res.ok || !res.sha) {
    throw new Error(res.conflict ? `it conflicted in ${res.conflict.files.join(', ')}, and the merge was undone` : 'the merge did not go in');
  }
  return res.sha;
}

/**
 * "merge and clean up": the merge, then the branch's delete with `forgetJob` (Amendment 143),
 * which removes the job as ✕ on the Project screen does, then its folder and branch. A refused
 * clean-up says the merge went in.
 */
export async function mergeAndClean(a: { projectId: string; branch: string; into: string }): Promise<string> {
  const sha = await mergeFinished(a);
  try {
    await branchAction(a.projectId, { action: 'delete', branch: a.branch, forgetJob: true });
  } catch (err) {
    throw new Error(`merged as ${sha.slice(0, 7)}, but not cleaned up: ${errorText(err)}`);
  }
  return sha;
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
  // A warning (Amendment 124): the agent is still working, so it is not asking for you.
  if (alert.kind === 'budget_over') return { title: within(`${head} is over its daily budget`), body: `${head} ${subject}` };
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
 * What the card warns of: "missing: …", the closing headings the agent's persona
 * asks for that the summary has none of, or null when it has them all, is empty, or the agent has
 * none. Only a warning: the summary can be sent without them, as the daemon takes it.
 */
export function handOffMissing(summary: string, agent: Pick<Agent, 'closingHeadings'>): string | null {
  if (summary.trim() === '') return null;
  const missing = missingHeadings(summary, agent.closingHeadings ?? []);
  return missing.length > 0 ? `missing: ${missing.join(', ')}` : null;
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

/**
 * Recreate a job's deleted folder, then continue the agent in its own session (Amendment
 * 114). The daemon refuses, with the sentence, when the folder can't be recreated.
 */
export async function restoreAndContinue(jobId: string, agent: Pick<Agent, 'id' | 'status'>): Promise<void> {
  await api(`/api/jobs/${encodeURIComponent(jobId)}/folder`, { method: 'POST', body: {} });
  await continueAgent(agent);
}

/** Only the budget; the route merges it into the rest of the agent's autonomy. */
export async function raiseBudget(agent: Pick<Agent, 'id'>, to: number, unit?: 'tokens'): Promise<void> {
  await setAutonomy(agent.id, { autonomy: unit === 'tokens' ? { budgetTokens: to } : { budgetUsd: to } });
}

export async function raiseAndContinue(agent: Pick<Agent, 'id' | 'status'>, to: number, unit?: 'tokens'): Promise<void> {
  await raiseBudget(agent, to, unit);
  await continueAgent(agent);
}

/** Stored by the daemon, so it stays put away after a reload. */
export function dismissAlert(alertId: string): Promise<unknown> {
  return api(`/api/alerts/${encodeURIComponent(alertId)}/dismiss`, { method: 'POST', body: {} });
}

// ─────────────────────────────────────────────────────────────────────────────
// The chip on Fleet's card and the Project lane (Amendment 120)
// ─────────────────────────────────────────────────────────────────────────────

/** What Fleet and the Project lane show of an agent held for not handing off. */
export interface HandOffChip {
  /** What it says: the state. */
  label: string;
  /** What pressing it does, said on the chip. */
  action: string;
  /** Hover text: why, who is waiting, and what pressing does. */
  title: string;
  /** The card to land on in Needs You, or null when there is none (its card was put away): then it opens the agent. */
  alertId: string | null;
}

/**
 * The chip for `agent`, or null when it is not held. The summary box is not repeated on a card
 * or a lane: they are small, and the whole card is one button. The chip says "not handed off"
 * and takes you to the card in Needs You, which has the box (`HandOffPanel`), or, when that
 * card was put away, to the agent, where a message works it again and it hands off when done.
 *
 * Held means what the wire says (`handoffHeld`, only while `done`) with an agent still waiting
 * for it: the daemon's rule for the alert, so the chip and the card appear and clear together.
 */
export function handOffChip(
  agent: Pick<Agent, 'id' | 'role' | 'status' | 'handoffHeld'>,
  agents: readonly Agent[],
  alerts: readonly Alert[],
): HandOffChip | null {
  if (agent.status !== 'done' || agent.handoffHeld !== true) return null;
  const waiting = waitingRoles(agent.id, agents);
  if (waiting.length === 0) return null;
  const card = alerts.find((a) => a.kind === 'handoff_held' && a.agentIds.includes(agent.id));
  const who = waiting.length === 1 ? waiting[0]! : `${waiting.slice(0, -1).join(', ')} and ${waiting.at(-1)}`;
  const why = `${agent.role} stopped without handing off, so ${who} ${waiting.length === 1 ? "hasn't" : "haven't"} started.`;
  return card
    ? { label: 'not handed off', action: 'hand off in Needs You', title: `${why} Open its card in Needs You to hand off.`, alertId: card.id }
    : {
        label: 'not handed off',
        action: 'open the agent',
        title: `${why} Its card in Needs You was put away. Open the agent and reply: it works again and hands off when it is done.`,
        alertId: null,
      };
}
