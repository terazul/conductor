/**
 * What a project, or a job, says when nothing is going on in it (Amendment 130).
 *
 * "Finished" is a thing to REVIEW: a job ended and you haven't looked since (Amendment 87).
 * Amendment 93 then made the rolled-up `done` status read `finished` too, in the same filled
 * green tag, so a project you reviewed last week looked exactly like one that ended a minute
 * ago, and a project with no agents at all (an empty roll-up is `done`) looked finished
 * too. Every card said FINISHED and none of them said which one to open.
 *
 * So the loud, filled **finished** is only the unseen one. A project at rest says something
 * quiet: **done** once you've seen it, **no agents** when it never ran anything. Anything
 * else (working, needs you, failed, queued, paused, stopped) is as it was. Pure, so
 * lib/verify.ts checks the rule and the screens only draw it.
 */

import type { AgentStatus } from '@conductor/shared';

/**
 *  empty   it has no agents: nothing ran, nothing finished.
 *  done    it ran and ended, and you have seen how: a quiet word, not the review mark.
 *  status  anything else: the status as it is, in its own colour.
 */
export type Rest = 'empty' | 'done' | 'status';

/**
 * How a project (or job) at `status`, with `agentCount` agents, reads when it has no
 * unseen finished job. `unseenFinished` keeps the status word as it was: the loud tag is
 * drawn beside or in place of it by the screen, and the stripe stays green.
 */
export function restOf(status: AgentStatus, agentCount: number, unseenFinished: boolean): Rest {
  if (agentCount === 0) return 'empty';
  if (status === 'done' && !unseenFinished) return 'done';
  return 'status';
}

/** The word for a rest that is not a status, or null for `status`. */
export function restWord(rest: Rest): string | null {
  return rest === 'empty' ? 'no agents' : rest === 'done' ? 'done' : null;
}
