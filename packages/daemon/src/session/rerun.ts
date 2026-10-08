/**
 * What an agent is told when it is re-run (Amendment 102).  TRACK A.
 *
 * "Re-run from here" (supervisor.ts `rerunFrom`) puts the agents after one agent back into
 * their own sessions. They have already read their input once; this is the note that says
 * it changed, and carries what the agents before them said last.
 *
 * Pure, so session/verify.ts checks the wording directly.
 *
 * THE ONE PLACE THIS CALLS `handoffSection`. A first prompt gets the agents' replies from
 * that function, and so does this note, so the two say it the same way. If the handoff is
 * reshaped, this call is the only line here that changes.
 */

import { handoffSection, type Upstream } from './handoff.js';

/** Replaces "You started after …": a re-run agent has already started. */
const RERUN_OPENING = 'Here is what the agents before you said, as it stands now.';

/**
 * Why a re-run agent is queued, as its status line says it: the person reading the
 * transcript sees the reason before the agent has said anything.
 */
export function rerunStatusNote(from: string): string {
  return `re-running after ${from}, whose reply changed`;
}

/**
 * The prompt a re-run agent resumes with.
 *
 * `changed` are the roles of the agents it waits for that went again, or whose reply is new
 * for another reason; `upstream` is every agent it waits for, with what each said last. The
 * worktree is not touched, and the note says so, because "start again" can be read as "start
 * over" and an agent that thinks it must redo everything will.
 */
export function rerunNote(changed: readonly string[], upstream: readonly Upstream[], cap: number): string {
  const who = changed.length === 0 ? 'An agent before you' : changed.join(', ');
  const verb = changed.length > 1 ? 'have' : 'has';
  return [
    `Your input changed. ${who} ${verb} said something new since you last worked, so you are being run again.`,
    'Nothing was reset: the files in this folder are exactly as you left them, plus whatever the agents before you changed since. ' +
      'Look at what is here, compare it with their new reply, and fix whatever no longer fits. ' +
      'Leave alone what still does.',
    handoffSection(upstream, cap, RERUN_OPENING),
  ]
    .filter(Boolean)
    .join('\n\n');
}
