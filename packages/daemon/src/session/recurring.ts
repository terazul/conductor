/**
 * Jobs that repeat (Amendment 211). TRACK A.
 *
 * A row in `recurring_jobs` is a saved Spawn setup — the exact `CreateJobRequest` Spawn would
 * send — and a rule for when to launch it again (`Every`, shared/recurring.ts). It stays until
 * you cancel it. Each time it comes due the clock (`Scheduler`, schedule.ts) launches it as a new
 * job through `Supervisor.createJob`, so each run starts fresh, named for the schedule and the
 * time: "Nightly tests · 12 Nov 09:00".
 *
 * THE RULES, each time one is due:
 *   - Paused, it is never due. While Pause all holds, nothing launches: it stays due, and
 *     launches once when the hold ends.
 *   - If the job its last run started has not ended (done, failed or stopped), this run is
 *     skipped, never run beside it: `skipped`, and the time it was due.
 *   - Otherwise it launches: `started` and the job, or `failed: <why>` when the launch is
 *     refused (the project's folder gone, a model gone).
 *   - Then it is next due by its rule from now. So times missed while the daemon was down
 *     launch once, on the first look, not once for each.
 *
 * A setup that names a branch runs each time on that name and the time (`runBranch`): a branch
 * is one job's, and the second run on the first one's would be refused.
 */

import type { CreateJobRequest, Every, Job, RecurringJob } from '@conductor/shared';
import {
  RESULT_SKIPPED,
  RESULT_STARTED,
  nextRun,
  resultFailed,
  runBranch,
  runName,
} from '@conductor/shared';
import { rows, type Db } from '../db/index.js';
import { hub } from '../hub.js';
import { getJob, newId } from './store.js';
import type { Supervisor } from './supervisor.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  request: string;
  every: string;
  next_at: string;
  last_at: string | null;
  last_job_id: string | null;
  last_result: string | null;
  created_at: string;
  paused: number;
}

const toRecurring = (r: Row): RecurringJob => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  request: JSON.parse(r.request) as CreateJobRequest,
  every: JSON.parse(r.every) as Every,
  nextAt: r.next_at,
  lastAt: r.last_at,
  lastJobId: r.last_job_id,
  lastResult: r.last_result,
  createdAt: r.created_at,
  paused: r.paused === 1,
});

/** Every schedule, soonest due first. */
export function listRecurring(db: Db): RecurringJob[] {
  return rows<Row>(db.prepare('SELECT * FROM recurring_jobs ORDER BY next_at, created_at').all()).map(toRecurring);
}

export function getRecurring(db: Db, id: string): RecurringJob | null {
  const r = db.prepare('SELECT * FROM recurring_jobs WHERE id = ?').get(id) as Row | undefined;
  return r ? toRecurring(r) : null;
}

/** A new schedule, next due by its rule from `now`. The request and rule are checked by the route. */
export function insertRecurring(
  db: Db,
  r: { name: string; every: Every; request: CreateJobRequest },
  now = new Date(),
): RecurringJob {
  const id = newId('rec');
  db.prepare(
    `INSERT INTO recurring_jobs (id, project_id, name, request, every, next_at, created_at, paused)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    r.request.projectId,
    r.name,
    JSON.stringify(r.request),
    JSON.stringify(r.every),
    nextRun(r.every, now).toISOString(),
    now.toISOString(),
  );
  return getRecurring(db, id)!;
}

/**
 * Its name, its rule or whether it is paused. A new rule, or a resume, makes it next due by
 * the rule from `now`: a schedule resumed after a week does not launch for the week it missed.
 */
export function patchRecurring(
  db: Db,
  id: string,
  p: { name?: string; every?: Every; paused?: boolean },
  now = new Date(),
): RecurringJob | null {
  const was = getRecurring(db, id);
  if (!was) return null;
  const every = p.every ?? was.every;
  const resumed = p.paused === false && was.paused;
  const nextAt = p.every !== undefined || resumed ? nextRun(every, now).toISOString() : was.nextAt;
  db.prepare('UPDATE recurring_jobs SET name = ?, every = ?, paused = ?, next_at = ? WHERE id = ?').run(
    p.name ?? was.name,
    JSON.stringify(every),
    (p.paused ?? was.paused) ? 1 : 0,
    nextAt,
    id,
  );
  return getRecurring(db, id);
}

/** Cancelled. The jobs it started stay. */
export function deleteRecurring(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM recurring_jobs WHERE id = ?').run(id).changes) > 0;
}

/** Every open page is told the whole list: from the clock or a route. */
export function broadcastRecurring(db: Db): void {
  try {
    hub().broadcast({ type: 'recurring', recurring: listRecurring(db) });
  } catch {
    // No hub outside the daemon. Not fatal.
  }
}

const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'stopped']);

/** The last run's job is still going: there, and not ended. A removed job has ended. */
function stillGoing(job: Job | undefined): boolean {
  return job !== undefined && !ENDED.has(job.status);
}

/** What a run launches: the saved request, named for the schedule and the time, on a branch of its own. */
export function runRequest(r: Pick<RecurringJob, 'name' | 'request'>, at: Date): CreateJobRequest {
  return {
    ...r.request,
    name: runName(r.name, at),
    ...(r.request.branch !== undefined ? { branch: runBranch(r.request.branch, at) } : {}),
  };
}

/**
 * Each schedule due at `now`, as THE RULES above say. The caller has checked the hold. True when
 * any row changed, so the list is sent.
 */
export async function runDueRecurring(db: Db, sup: Pick<Supervisor, 'createJob'>, now: number): Promise<boolean> {
  const at = new Date(now);
  const iso = at.toISOString();
  const due = rows<Row>(
    db.prepare('SELECT * FROM recurring_jobs WHERE paused = 0 AND next_at <= ? ORDER BY next_at').all(iso),
  ).map(toRecurring);
  for (const r of due) {
    // Claimed first, next due by its rule from now: a second clock that read the same row (a
    // restart's first look beside the old one's) finds it taken and launches nothing.
    const claim = db
      .prepare('UPDATE recurring_jobs SET next_at = ? WHERE id = ? AND next_at = ?')
      .run(nextRun(r.every, at).toISOString(), r.id, r.nextAt);
    if (Number(claim.changes) === 0) continue;
    let result: string;
    let jobId = r.lastJobId;
    if (r.lastJobId !== null && stillGoing(getJob(db, r.lastJobId))) {
      result = RESULT_SKIPPED;
    } else {
      try {
        const { job } = await sup.createJob(runRequest(r, at), r.id);
        result = RESULT_STARTED;
        jobId = job.id;
      } catch (err) {
        result = resultFailed(err instanceof Error ? err.message : String(err));
      }
    }
    // Cancelled while its launch ran, the update finds no row: the job it started stays.
    db.prepare('UPDATE recurring_jobs SET last_at = ?, last_job_id = ?, last_result = ? WHERE id = ?').run(
      iso,
      jobId,
      result,
      r.id,
    );
  }
  return due.length > 0;
}
