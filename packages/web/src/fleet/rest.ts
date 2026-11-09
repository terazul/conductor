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

import { rollupStatus, type AgentStatus, type Job } from '@conductor/shared';
import { STATUS_KEY, STATUS_WORD, type Tone } from '../shell/status.js';

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

/** One tag of a headline: its word and the tone it is drawn in. */
export interface HeadTag {
  word: string;
  tone: Tone;
}

/**
 * The tags a project, or a stack, heads with (Amendment 194): the Fleet card's headline, which
 * the navigator's project row and stack row now draw too, so the three can't disagree.
 *
 *   `statuses`  its agents' statuses as a rollup reads them (`rollupStatuses`, lib/rollup.ts):
 *               an agent waiting for the model counts as working (Amendment 192).
 *   `blocked`   a request of its waits on you.
 *   `unseen`    its jobs that finished and you haven't seen (lib/seen.ts, Amendment 87).
 *
 * Amber only when a human is actually required: **needs you**. Else **N working** while any
 * agent works. Either way, **finished** beside it when a job finished unseen, red when one of
 * them failed. With neither, **finished** alone, or the rest's quiet word (`restOf`): **no
 * agents**, **done**, or the rolled-up status in its own colour (failed, queued…).
 *
 * **N paused**, filled in `--idle` (Amendment 205), whenever any agent of it is paused: after
 * the lead and before finished, or beside a loud rest (failed, queued). It is the rest when
 * paused is the worst there is, in place of the plain word. An agent paused waiting for the
 * model isn't counted: the rollup has it working.
 */
export function headlineTags(
  statuses: readonly AgentStatus[],
  blocked: boolean,
  unseen: readonly Pick<Job, 'status'>[],
): HeadTag[] {
  const finished: HeadTag | null =
    unseen.length > 0 ? { word: 'finished', tone: unseen.some((j) => j.status === 'failed') ? 'fail' : 'done' } : null;
  const working = statuses.filter((s) => s === 'working').length;
  const lead: HeadTag | null = blocked
    ? { word: 'needs you', tone: 'need' }
    : working > 0
      ? { word: `${working} working`, tone: 'live' }
      : null;
  const n = statuses.filter((s) => s === 'paused').length;
  const paused: HeadTag | null = n > 0 ? { word: `${n} paused`, tone: 'pause' } : null;
  const of = (...tags: (HeadTag | null)[]): HeadTag[] => tags.filter((t): t is HeadTag => t !== null);
  if (lead || finished) return of(lead, paused, finished);
  const status = rollupStatus(statuses);
  if (status === 'paused') return of(paused);
  const rest = restOf(status, statuses.length, false);
  return of({ word: restWord(rest) ?? STATUS_WORD[status], tone: rest === 'status' ? STATUS_KEY[status] : 'idle' }, paused);
}
