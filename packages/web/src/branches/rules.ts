/**
 * What the Branches screen lets you do, and why not when it doesn't (Amendment 109).
 *
 * Pure: a `BranchesResponse` in, a sentence or null out. The daemon refuses the same
 * things (ADR 0008 § Routes) and its 409 is the word that counts; these say so before you
 * click, so a button that can't work is disabled with its reason next to it rather than
 * failing after.
 */

import type { BranchInfo, BranchMergePreview, BranchTargetSource, BranchesResponse, Job } from '@conductor/shared';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be merged into the target at all, or null when it can. */
export function targetReason(resp: BranchesResponse): string | null {
  if (!resp.targetCheckout) return `${resp.target} isn't checked out anywhere — check it out first`;
  if (!resp.targetCheckout.clean) {
    return `${resp.target}'s checkout (${resp.targetCheckout.path}) has uncommitted changes — commit or discard them first`;
  }
  return null;
}

/**
 * The branches "merge all" would merge: not the target, not live, with commits main lacks.
 * Not one that shares no history with main either: git refuses to merge unrelated
 * histories without being told to, and nothing here tells it to.
 */
export function mergeable(resp: BranchesResponse): BranchInfo[] {
  return resp.branches.filter((b) => !b.isTarget && !b.live && b.ahead > 0 && b.forkedAt !== null);
}

/** "Merge all into main": how many it would merge, and why it can't, or null. */
export function mergeAllState(resp: BranchesResponse): { count: number; reason: string | null } {
  const count = mergeable(resp).length;
  const blocked = targetReason(resp);
  if (blocked) return { count, reason: blocked };
  if (count === 0) return { count, reason: `nothing to merge — every branch is already in ${resp.target}, or live` };
  return { count, reason: null };
}

/** Why one branch can't be merged into the target, or null. */
export function mergeReason(resp: BranchesResponse, b: BranchInfo): string | null {
  if (b.isTarget) return `this is ${resp.target}`;
  if (b.live) return 'an agent is working on it — wait for it to finish';
  if (b.ahead === 0) return `nothing to merge — ${resp.target} already has all of it`;
  if (b.forkedAt === null) return `it shares no history with ${resp.target}, and git won't merge unrelated histories`;
  return targetReason(resp);
}

/**
 * The branches `b` can be merged into (Amendment 110): every other local branch, the target
 * first. The daemon answers for the ones that can't take it; these are just the choices.
 */
export function intoChoices(resp: BranchesResponse, b: BranchInfo): BranchInfo[] {
  return resp.branches.filter((x) => x.name !== b.name);
}

/** The branch "merge into" starts on: the target, or nothing for the target itself. */
export function defaultInto(resp: BranchesResponse, b: BranchInfo): string {
  return b.isTarget ? '' : resp.target;
}

/**
 * Why `b` can't be merged into `into`, from what the screen knows, or null. Into the target
 * this is `mergeReason`, as before. Into any other branch the counts aren't in the listing,
 * so what the preview said decides the rest; while it is on its way, nothing is refused.
 */
export function intoReason(
  resp: BranchesResponse,
  b: BranchInfo,
  into: BranchInfo | null,
  preview: BranchMergePreview | null,
): string | null {
  if (!into) return 'choose a branch to merge into';
  if (into.isTarget) return mergeReason(resp, b) ?? conflictReason(preview, into.name);
  if (b.live) return 'an agent is working on it — wait for it to finish';
  if (into.live) return `an agent is working on ${into.name} — wait for it to finish`;
  if (!into.worktree) return `${into.name} isn't checked out anywhere — check it out first`;
  if (preview && preview.into === into.name && preview.branch === b.name && preview.reason) return preview.reason;
  return conflictReason(preview, into.name);
}

/** Known conflicts refuse the merge: git would stop, and the screen would only undo it. */
function conflictReason(preview: BranchMergePreview | null, into: string): string | null {
  if (!preview || preview.into !== into || !preview.conflicts || preview.conflicts.length === 0) return null;
  const n = preview.conflicts.length;
  return `it would conflict with ${into} in ${plural(n, 'file')} — merge it by hand in a terminal`;
}

/** The line under the picker: what the merge would bring, and whether it would conflict. */
export function previewLine(p: BranchMergePreview): string {
  if (p.ahead === 0) return `nothing to merge — ${p.into} already has all of ${p.branch}`;
  const what = `${plural(p.ahead, 'commit')} from ${p.branch}`;
  const behind = p.behind > 0 ? ` · ${p.into} has ${plural(p.behind, 'commit')} ${p.branch} doesn't` : '';
  const clash =
    p.conflicts === null
      ? ' · conflicts unknown until it runs'
      : p.conflicts.length === 0
        ? ' · no conflicts'
        : ` · conflicts in ${p.conflicts.join(', ')}`;
  return `${what}${behind}${clash}`;
}

/** Whether "Commit…" is offered at all: only where there is uncommitted work. */
export function showCommit(b: BranchInfo): boolean {
  return (b.worktree?.uncommitted ?? 0) > 0;
}

/** Why its uncommitted work can't be committed, or null. */
export function commitReason(b: BranchInfo): string | null {
  if (b.live) return 'an agent is working on it — wait for it to finish';
  if (!b.worktree) return "it isn't checked out anywhere";
  if (b.worktree.uncommitted === 0) return 'nothing to commit';
  return null;
}

/** Whether "Push to origin" is offered: there is a remote, and origin lacks something or the branch. */
export function showPush(resp: BranchesResponse, b: BranchInfo): boolean {
  return resp.remote !== null && (b.upstream === null || b.upstream.ahead > 0);
}

/** Why it can't be pushed, or null. */
export function pushReason(resp: BranchesResponse, b: BranchInfo): string | null {
  if (resp.remote === null) return 'this repo has no origin';
  if (b.live) return 'an agent is working on it — wait for it to finish';
  if (b.upstream && b.upstream.ahead === 0) return `nothing to push — ${resp.remote} has all of it`;
  return null;
}

/** The confirm before a merge: the branch, its commits, and what will be left behind. */
export function mergeConfirm(
  resp: BranchesResponse,
  b: BranchInfo,
  into: string = resp.target,
  ahead: number = b.ahead,
): { ask: string; warn: string | null } {
  const ask = `Merge ${b.name} (${plural(ahead, 'commit')}) into ${into}, as one merge commit?`;
  const n = b.worktree?.uncommitted ?? 0;
  const warn =
    n > 0
      ? `Its ${plural(n, 'uncommitted file')} in ${b.worktree?.path ?? 'its worktree'} won't be merged — commit ${n === 1 ? 'it' : 'them'} first to include ${n === 1 ? 'it' : 'them'}.`
      : null;
  return { ask, warn };
}

/** The confirm before a push. Push is the one action that leaves this machine. */
export function pushConfirm(resp: BranchesResponse, b: BranchInfo): string {
  const remote = resp.remote ?? 'origin';
  if (!b.upstream) return `Push ${b.name} to ${remote}? It isn't there yet; this creates it and tracks it.`;
  return `Push ${plural(b.upstream.ahead, 'commit')} on ${b.name} to ${remote}? Never forced.`;
}

/** The commit message to start from: the first line of the job's prompt, when it's a job's branch. */
export function defaultMessage(b: BranchInfo, jobs: Pick<Job, 'id' | 'prompt'>[]): string {
  if (!b.jobId) return '';
  const prompt = jobs.find((j) => j.id === b.jobId)?.prompt ?? '';
  const first = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.trim().slice(0, 120);
}

/** Why this branch is the one everything is drawn against, beside the picker (Amendment 113). */
export function targetFromWords(from: BranchTargetSource): string {
  switch (from) {
    case 'chosen':
      return 'chosen by you';
    case 'origin':
      return "origin's default branch";
    case 'project':
      return 'checked out when the project was added';
    case 'main':
      return 'the repo has no origin default; main is used';
    case 'head':
      return 'checked out in the project folder';
  }
}
