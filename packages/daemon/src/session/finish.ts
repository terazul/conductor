/**
 * When a job finishes: merge its branch and clean up, or ask (Amendment 144, wave 10 Q6).
 *
 * Called by the supervisor when a job settles `done` (`#rollUpJob`, supervisor.ts). Only a
 * job isolated in a worktree of its own, whose branch is ahead of the branch the Branches
 * screen compares with, gets anything; every other job finishes as before.
 *
 *   - Any of its agents has "merge into main and clean up when done" (`Autonomy.mergeWhenDone`)
 *     on, every one of them is `done`, and Amendment 110's preview says the merge would run
 *     with no conflicts (so the target's checkout is clean too): it is merged the way the
 *     Branches screen merges it, then removed with Amendment 143's `delete` and `forgetJob`.
 *     That is the user's own opt-in, set on the agent. Each agent's transcript gets a note
 *     saying what was merged and removed, and Needs You an information card (`merged`).
 *   - Otherwise nothing moves (Q6: nothing happens by itself unless asked): Needs You offers
 *     **Finished: merge into <target>?** (`finished`), saying why it wasn't done by itself
 *     when the setting asked for that.
 *
 * Any step that refuses stops there. A refused merge falls back to the card; a merge that
 * went in and a clean-up that was refused is the information card, saying why the job, its
 * folder and its branch are still there (a card offering a merge already made would be wrong).
 * Pushing is never done here: it stays a confirmed action on the Branches screen.
 *
 * The cards are derived from `job_finishes` (migration 230), as the other derived alerts are
 * from what is stored, so a restart keeps them; only dismissals are stored elsewhere.
 */

import type { Agent, Alert } from '@conductor/shared';
import { rows, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub } from '../hub.js';
import { BranchError, branchAction, listBranches, previewMerge } from '../workspace/branches.js';
import { GitError } from '../workspace/git.js';
import { projectRepo } from '../workspace/project-repo.js';
import { agentsForJob, getJob } from './store.js';

/** What finishing a job came to. `none` is a job this doesn't apply to, with why. */
export type Finish =
  | { outcome: 'none'; why: string }
  | { outcome: 'offer'; why: string | null }
  | { outcome: 'merged'; sha: string; cleaned: boolean; why: string | null };

interface FinishRow {
  id: number;
  job_id: string;
  project_id: string;
  kind: 'offer' | 'merged';
  branch: string;
  target: string;
  ahead: number;
  agent_ids: string;
  sha: string | null;
  cleaned: number;
  why: string | null;
  at: string;
}

const listeners = new Set<() => void>();

/** Told after each row is written, so Needs You redraws (alerts.ts subscribes). */
export function onFinishesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function record(
  db: Db,
  r: Omit<FinishRow, 'id' | 'at' | 'agent_ids' | 'cleaned'> & { agentIds: string[]; cleaned: boolean },
): void {
  db.prepare(
    `INSERT INTO job_finishes (job_id, project_id, kind, branch, target, ahead, agent_ids, sha, cleaned, why, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.job_id, r.project_id, r.kind, r.branch, r.target, r.ahead, JSON.stringify(r.agentIds), r.sha, r.cleaned ? 1 : 0, r.why, new Date().toISOString());
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[finish] listener threw', err);
    }
  }
}

/** A refusal as one sentence, as the Branches screen shows it. */
function sentence(err: unknown): string {
  if (err instanceof BranchError) return err.detail ? `${err.message} — ${err.detail}` : err.message;
  if (err instanceof GitError) return `git failed: ${err.stderr.trim() || err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Why the setting couldn't merge it by itself, or null when it can go ahead. Every agent must be done: a paused one still needs its folder. */
function notAllDone(agents: Agent[]): string | null {
  const open = agents.find((a) => a.status !== 'done');
  return open ? `${open.role} is ${open.status}, not done, so it may still need the folder` : null;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * What to do now that `jobId` has settled `done`. `forgetJob` removes a job as DELETE
 * /api/jobs/:jobId does (`Supervisor.deleteJob`). Never throws: a failure is logged, and
 * the job is left as it is.
 */
export async function finishJob(db: Db, jobId: string, forgetJob: (jobId: string) => Promise<void>): Promise<Finish> {
  try {
    return await finish(db, jobId, forgetJob);
  } catch (err) {
    console.warn(`[finish] ${jobId}: ${sentence(err)}`);
    return { outcome: 'none', why: sentence(err) };
  }
}

async function finish(db: Db, jobId: string, forgetJob: (jobId: string) => Promise<void>): Promise<Finish> {
  const job = getJob(db, jobId);
  if (!job || job.status !== 'done') return { outcome: 'none', why: 'the job is not done' };
  if (job.isolation !== 'worktree') return { outcome: 'none', why: `the job works in ${job.isolation === 'in_place' ? 'the project folder' : 'a branch of the project folder'}, not a worktree of its own` };
  const repo = await projectRepo(db, job.projectId, forgetJob);
  if (!repo) return { outcome: 'none', why: 'no such project' };
  const state = await listBranches(repo);
  const b = state.branches.find((x) => x.name === job.branch);
  if (!b || b.isTarget) return { outcome: 'none', why: `${job.branch} isn't a branch other than the target` };
  if (b.ahead === 0) return { outcome: 'none', why: `${state.target} already has everything on ${b.name}` };

  const agents = agentsForJob(db, jobId);
  const base = { job_id: jobId, project_id: job.projectId, branch: b.name, target: state.target, ahead: b.ahead, agentIds: agents.map((a) => a.id) };
  const offer = (why: string | null): Finish => {
    record(db, { ...base, kind: 'offer', sha: null, cleaned: false, why });
    return { outcome: 'offer', why };
  };

  if (!agents.some((a) => a.autonomy.mergeWhenDone === true)) return offer(null);
  const open = notAllDone(agents);
  if (open) return offer(open);

  // Lane J's preview first: the sentence the merge would refuse with, and the conflicts.
  const preview = await previewMerge(repo, b.name, undefined);
  if (preview.reason) return offer(preview.reason);
  if (preview.conflicts === null) return offer("this git can't tell beforehand whether the merge would conflict, so it wasn't merged by itself");
  if (preview.conflicts.length > 0) return offer(`it would conflict with ${state.target} in ${preview.conflicts.join(', ')}`);

  let sha: string;
  try {
    const merged = await branchAction(repo, { action: 'merge', branch: b.name });
    if (!merged.ok || !merged.sha) {
      return offer(merged.conflict ? `the merge conflicted in ${merged.conflict.files.join(', ')} and was undone` : 'the merge did not go in');
    }
    sha = merged.sha;
  } catch (err) {
    return offer(sentence(err));
  } finally {
    broadcastBranches(job.projectId);
  }

  // Merged. Now the clean-up the setting asked for: the job first, then the folder and branch.
  let cleaned = false;
  let why: string | null = null;
  try {
    await branchAction(repo, { action: 'delete', branch: b.name, forgetJob: true });
    cleaned = true;
  } catch (err) {
    why = sentence(err);
  } finally {
    broadcastBranches(job.projectId);
  }

  // The transcripts are kept (the events table never loses a row), so each agent's says so.
  for (const a of agents) {
    eventLog().emit(
      { projectId: a.projectId, jobId, agentId: a.id },
      {
        kind: 'user_text',
        synthetic: true,
        text: cleaned
          ? `Your branch ${b.name} was merged into ${state.target} as ${short(sha)}, because "merge into main and clean up when done" was on. The job, its folder ${job.worktreePath} and the branch have been removed; this transcript stays.`
          : `Your branch ${b.name} was merged into ${state.target} as ${short(sha)}, because "merge into main and clean up when done" was on. It was not cleaned up: ${why}. The job, its folder and the branch are still there.`,
      },
    );
  }
  record(db, { ...base, kind: 'merged', sha, cleaned, why });
  return { outcome: 'merged', sha, cleaned, why };
}

function broadcastBranches(projectId: string): void {
  try {
    hub().broadcast({ type: 'branches', projectId });
  } catch {
    // No hub outside the daemon.
  }
}

/**
 * The cards (alerts.ts lists them with the rest). `finished`: the newest offer per job, while
 * that job is still there and `done` — a job that runs again asks again when it next finishes,
 * and one that was removed has nothing left to merge from here. `merged`: every one, until dismissed.
 */
export function finishAlerts(db: Db): Alert[] {
  const all = rows<FinishRow>(db.prepare('SELECT * FROM job_finishes ORDER BY id ASC').all());
  const newest = new Map<string, number>();
  for (const r of all) if (r.kind === 'offer') newest.set(r.job_id, r.id);
  const out: Alert[] = [];
  for (const r of all) {
    const common = { projectId: r.project_id, jobId: r.job_id, since: r.at, branch: r.branch, into: r.target, ahead: r.ahead };
    if (r.kind === 'offer') {
      if (newest.get(r.job_id) !== r.id) continue;
      const job = getJob(db, r.job_id);
      if (!job || job.status !== 'done') continue;
      out.push({
        id: `finished:${r.id}`,
        kind: 'finished',
        cause: 'finished',
        agentIds: agentsForJob(db, r.job_id).map((a) => a.id),
        ...common,
        ...(r.why ? { detail: r.why } : {}),
      });
    } else {
      const cleaned = r.cleaned === 1;
      out.push({
        id: `merged:${r.id}`,
        kind: 'merged',
        cause: cleaned ? 'merged and cleaned up' : 'merged',
        // Removed with the job when cleaned up; otherwise still there to open.
        agentIds: cleaned ? [] : agentsForJob(db, r.job_id).map((a) => a.id),
        ...common,
        cleaned,
        ...(r.sha ? { sha: r.sha } : {}),
        ...(r.why ? { detail: r.why } : {}),
      });
    }
  }
  return out;
}
