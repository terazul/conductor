/**
 * What the "re-run after this" button says, and when it is there.  TRACK B.
 * (Amendment 102)
 *
 * A button on an agent in a stack: start the agents after it again, each back in its own
 * conversation, told that this agent's reply changed. Manual on purpose, so a chat with the
 * architect doesn't re-run the whole stack on every message.
 *
 * It is there only when the agent HAS agents after it. When something is in the way (it is
 * still working, an agent after it was stopped) it is there and says why it can't be pressed,
 * so the reason is read where the button is rather than learned from a refusal.
 *
 * The plan is `rerunPlan` in shared, the one the daemon applies, so what this says it will
 * do is what the daemon will do. Pure and imports no CSS, so agent/verify.ts checks it under
 * Node (Amendment 9).
 */

import { rerunPlan, type Agent, type RerunPlan, type RerunResponse } from '@conductor/shared';

/** "a", "a and b", "a, b and c". */
export function roleList(roles: readonly string[]): string {
  if (roles.length <= 1) return roles[0] ?? '';
  return `${roles.slice(0, -1).join(', ')} and ${roles.at(-1)}`;
}

const is = (n: number): string => (n === 1 ? 'is' : 'are');

/**
 * What pressing it will do, in words, before it does anything: who goes again, who is
 * stopped first, that the folder is left as it is.
 */
export function rerunSentence(plan: RerunPlan): string {
  const from = plan.from.role;
  const go = plan.steps.filter((s) => s.action !== 'wait');
  const waiting = plan.steps.filter((s) => s.action === 'wait');
  const stopped = go.filter((s) => s.stops);
  const helpers = go.flatMap((s) => s.stopsHelpers);
  const ordered = go.filter((s) => s.after.length > 0);

  const out: string[] = [];
  if (go.length > 0) {
    out.push(
      `${roleList(go.map((s) => s.role))} will go again, each back in its own conversation and told that ${from} changed what it said.`,
    );
    for (const s of ordered) out.push(`${s.role} starts once ${roleList(s.after)} ${is(s.after.length)} done again.`);
    if (stopped.length > 0) {
      out.push(
        `${roleList(stopped.map((s) => s.role))} ${is(stopped.length)} working now, so ${stopped.length === 1 ? 'it is' : 'they are'} stopped first: ${stopped.length === 1 ? 'its' : 'their'} input is out of date.`,
      );
    }
    if (helpers.length > 0) out.push(`Helpers still working (${roleList(helpers)}) are stopped too.`);
    out.push('Nothing in the folder is reset: they see what is there and fix it.');
  }
  if (waiting.length > 0) {
    out.push(
      `${roleList(waiting.map((s) => s.role))} ${waiting.length === 1 ? "hasn't" : "haven't"} started, so ${waiting.length === 1 ? 'it is' : 'they are'} left alone and will read the new reply when ${waiting.length === 1 ? 'it does' : 'they do'}.`,
    );
  }
  return out.join(' ');
}

export interface RerunControl {
  /** The button. */
  label: string;
  /** Hover text when it can be pressed. */
  title: string;
  /** Why it can't be pressed now, or null. Shown as the hover text, and as the reason. */
  blocked: string | null;
  /** What it will do, said under the header once armed. */
  explain: string;
  /** The question in the header once armed. */
  question: string;
  /** The button that commits. */
  confirm: string;
  /** Roles that go again, in order. */
  going: string[];
  plan: RerunPlan;
}

/**
 * The control for `agentId`, or null when it has no agents after it (or is a helper, which
 * has no place in a stack). `hasReply` is whether it has written any prose.
 */
export function rerunControl(agents: readonly Agent[], agentId: string, hasReply: boolean): RerunControl | null {
  const plan = rerunPlan(agents, agentId, { hasReply });
  if (plan.steps.length === 0) return null;
  const going = plan.steps.filter((s) => s.action !== 'wait').map((s) => s.role);
  const n = going.length;
  return {
    label: '↻ re-run after this',
    title: `Start the agents after ${plan.from.role} again, now that you've changed what it said`,
    blocked: plan.refusal,
    explain: plan.refusal ? plan.refusal : rerunSentence(plan),
    question: `Re-run ${n === 1 ? going[0] : `${n} agents`} after ${plan.from.role}?`,
    confirm: `↻ re-run ${n === 1 ? going[0] : `${n} agents`}`,
    going,
    plan,
  };
}

/** What the notice says once the daemon has done it. */
export function rerunDone(done: RerunResponse): string {
  const go = done.agents.filter((a) => a.action !== 'wait');
  const stopped = go.filter((a) => a.stopped);
  return (
    `Re-running after ${done.from}: ${roleList(go.map((a) => a.role))} ${go.length === 1 ? 'goes' : 'go'} again` +
    (stopped.length > 0 ? `, ${roleList(stopped.map((a) => a.role))} stopped first` : '') +
    '.'
  );
}
