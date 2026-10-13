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

/** Why `b` can't become the project's default, or null (Amendment 117): only when it already is. */
export function makeDefaultReason(defaultBranch: string, b: BranchInfo): string | null {
  return b.name === defaultBranch ? 'already the default' : null;
}

/**
 * Why `b`'s checkout can't run, beyond `makeDefaultReason` (Amendment 117): the project's
 * own folder has tracked changes, or something is already working in it. A branch checked
 * out in another worktree isn't pre-checked here; the daemon's 409 says so after.
 */
export function checkoutReason(resp: BranchesResponse, defaultBranch: string, b: BranchInfo): string | null {
  return (
    makeDefaultReason(defaultBranch, b) ??
    (resp.rootClean === false ? 'the project folder has uncommitted changes — commit or discard them first' : null) ??
    (resp.rootLive ? 'an agent is working in the project folder — wait for it to finish or stop it' : null)
  );
}

/** The header's line about the default branch and what the folder has checked out (Amendment 117). */
export function rootLine(defaultBranch: string, rootBranch: string | null | undefined): { text: string; warn: boolean } {
  if (rootBranch === undefined) return { text: `default: ${defaultBranch}`, warn: false };
  const folder = rootBranch === null ? 'nothing — detached' : rootBranch;
  return { text: `default: ${defaultBranch} · folder on ${folder}`, warn: rootBranch !== defaultBranch };
}

/** The confirm before "Make default and check out" (Amendment 117): it moves this folder. */
export function checkoutConfirm(path: string, branch: string): string {
  return `This switches ${path} to ${branch}. Anything running from that folder — Conductor itself, if this is its repo — runs the new branch's code.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deleting merged branches (Amendment 143)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The jobs that own `b`: the listing's `jobId` and every job of the project on that branch.
 * A done job's agents can still be messaged, and they need its folder, so each of these
 * keeps the branch unless you choose to forget the job too.
 */
export function ownersOf(b: BranchInfo, jobs: Pick<Job, 'id' | 'branch' | 'projectId'>[], projectId: string): string[] {
  const ids = jobs.filter((j) => j.projectId === projectId && j.branch === b.name).map((j) => j.id);
  if (b.jobId && !ids.includes(b.jobId)) ids.unshift(b.jobId);
  return ids;
}

/** The daemon's sentence for a branch a job owns (`ownedSentence`, daemon workspace/branches.ts). */
export function ownedReason(jobId: string): string {
  return `job ${jobId}'s agents can still be messaged, and they need this folder; remove the job, or choose 'forget the job too'`;
}

/**
 * Why `b` can't be deleted, or null (Amendment 143). The daemon's refusals in its order:
 * the target, the project folder's own branch, not merged (`git branch -d` would refuse it),
 * a commit its upstream lacks (`-d` judges by that), uncommitted files, a live agent, and a
 * job that owns it unless `forget`.
 */
export function deleteReason(resp: BranchesResponse, b: BranchInfo, owners: string[], forget: boolean): string | null {
  if (b.isTarget) return `this is ${resp.target}, the branch everything is compared with`;
  if (resp.rootBranch === b.name) return "it is checked out in the project's own folder — switch that folder to another branch first";
  if (b.forkedAt === null) return `it shares no history with ${resp.target}, so it isn't merged into it`;
  if (b.ahead > 0) {
    return `${plural(b.ahead, 'commit')} on it ${b.ahead === 1 ? "isn't" : "aren't"} in ${resp.target} — it isn't merged, and git branch -d would refuse it`;
  }
  if (b.upstream && b.upstream.ahead > 0) {
    return `${plural(b.upstream.ahead, 'commit')} on it ${b.upstream.ahead === 1 ? "isn't" : "aren't"} on ${b.upstream.ref}, and git branch -d checks against it — push it first`;
  }
  const n = b.worktree?.uncommitted ?? 0;
  if (n > 0) return `its folder has ${plural(n, 'uncommitted file')} (untracked ones count) — commit or discard ${n === 1 ? 'it' : 'them'} first`;
  if (b.live) return 'an agent is working on it — wait for it to finish';
  const owner = owners[0];
  if (owner && !forget) return ownedReason(owner);
  return null;
}

/** The checkbox beside Delete and in Clean up merged's confirm: offered when a job owns what would go. */
export const FORGET_LABEL = 'forget its job too (its transcripts stay)';

/** The confirm before a delete: the branch, its folder and its job, and what happens to each. */
export function deleteConfirm(b: BranchInfo, owners: string[], forget: boolean): string {
  const folder = b.worktree ? `its folder ${b.worktree.path} is removed (git worktree remove, never forced)` : 'it has no folder';
  const one = owners.length === 1;
  const jobs =
    owners.length > 0 && forget
      ? ` ${one ? `Job ${owners[0]} is` : `Jobs ${owners.join(', ')} are`} removed first: ${one ? 'its' : 'their'} agents can't be messaged afterwards, and ${one ? 'its' : 'their'} transcripts stay.`
      : '';
  return `Delete ${b.name}? It is merged; ${folder}, and the branch goes with git branch -d. Origin keeps its copy, if it has one.${jobs}`;
}

/** What "Clean up merged" would do: every merged branch but the target, oldest tip first, split by `deleteReason`. */
export function cleanState(
  resp: BranchesResponse,
  ownersFor: (b: BranchInfo) => string[],
  forget: boolean,
): { go: BranchInfo[]; stay: { branch: string; why: string }[]; reason: string | null } {
  const merged = resp.branches
    .filter((b) => !b.isTarget && b.ahead === 0 && b.forkedAt !== null)
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.name.localeCompare(b.name)));
  const go: BranchInfo[] = [];
  const stay: { branch: string; why: string }[] = [];
  for (const b of merged) {
    const why = deleteReason(resp, b, ownersFor(b), forget);
    if (why) stay.push({ branch: b.name, why });
    else go.push(b);
  }
  const reason = merged.length === 0 ? `nothing to clean up — no branch is merged into ${resp.target}` : null;
  return { go, stay, reason };
}

/** One line of Clean up merged's confirm: the branch, its folder, its job. */
export function cleanLine(b: BranchInfo, owners: string[]): string {
  const folder = b.worktree ? b.worktree.path : 'no folder';
  const job = owners.length === 0 ? 'no job' : `job ${owners.join(', ')}`;
  return `${b.name} · ${folder} · ${job}`;
}

/** The ask at the top of Clean up merged's confirm. */
export function cleanConfirm(count: number, forget: boolean, jobs: number): string {
  const head = `Delete ${plural(count, 'merged branch', 'merged branches')}, oldest first, each with its folder? Each goes with git worktree remove and git branch -d, never forced; origin is not touched.`;
  if (!forget || jobs === 0) return head;
  return `${head} ${plural(jobs, 'job')} ${jobs === 1 ? 'is' : 'are'} removed with them: ${jobs === 1 ? 'its' : 'their'} agents can't be messaged afterwards, and the transcripts stay.`;
}

/** What delete or Clean up merged did, in words. */
export function removedText(removed: string[], forgot: string[]): string {
  if (removed.length === 0) return 'Nothing was removed.';
  const jobs = forgot.length > 0 ? ` Forgot ${forgot.length === 1 ? `job ${forgot[0]}` : `jobs ${forgot.join(', ')}`}; the transcripts stay.` : '';
  return `Removed ${removed.join(', ')}, with ${removed.length === 1 ? 'its folder' : 'their folders'}.${jobs}`;
}
