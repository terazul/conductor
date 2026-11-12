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
 *
 * A MESSAGE (Amendment 216): a row with `agent_id` and `text` instead of a request. Each time it
 * comes due the text goes to the agent through `Supervisor.sendMessage`, exactly as if you had
 * pressed send then: into its live run, or resuming a finished one. `sent`, `sent (waiting for a
 * slot)` when every slot was taken, or `failed: <why>`. There is no skip rule. An agent not yet
 * started ("cannot receive messages yet") is tried again at each look, as ⏲ later's messages
 * are, its next time not moved: `waiting: developer has not started yet`, recorded (and sent to
 * every tab) once, when it starts to wait. Pause all and missed times are as above.
 *
 * RUN NOW runs either kind once, at once (`runRecurringNow`): the last result is set, the next
 * time is not moved. A job still skips while its last run goes. Made while everything is paused,
 * it is `started (waits for Pause all to end)`: it waits queued until then.
 *
 * ONE AT A TIME: a schedule being run, by the clock or run now, is held in this process until
 * that run ends. The clock leaves it for its next look; run now runs nothing and says it is being
 * run now. Only a run that made a job writes `last_job_id`, so a skip or a failure never loses
 * the job the last run started.
 */

import type { CreateJobRequest, Every, Job, RecurringJob } from '@conductor/shared';
import {
  BEING_RUN,
  RESULT_SENT,
  RESULT_SENT_QUEUED,
  RESULT_SKIPPED,
  RESULT_STARTED,
  RESULT_STARTED_HELD,
  nextRun,
  resultFailed,
  resultWaiting,
  runBranch,
  runName,
} from '@conductor/shared';
import { rows, type Db } from '../db/index.js';
import { hub } from '../hub.js';
import { getAgent, getJob, newId } from './store.js';
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
  /** Amendment 216: a message's agent and text; NULL for a job. */
  agent_id: string | null;
  text: string | null;
}

const toRecurring = (r: Row): RecurringJob => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  ...(r.agent_id !== null
    ? { kind: 'message' as const, agentId: r.agent_id, text: r.text ?? '' }
    : { kind: 'job' as const, request: JSON.parse(r.request) as CreateJobRequest }),
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

/** What a schedule is of: a job's setup, or a message's agent (with its project) and text. */
export type RecurringOf = { request: CreateJobRequest } | { agentId: string; projectId: string; text: string };

/** A new schedule, next due by its rule from `now`. The request, agent, text and rule are checked by the route. */
export function insertRecurring(
  db: Db,
  r: { name: string; every: Every } & RecurringOf,
  now = new Date(),
): RecurringJob {
  const id = newId('rec');
  const job = 'request' in r;
  db.prepare(
    `INSERT INTO recurring_jobs (id, project_id, name, request, every, next_at, created_at, paused, agent_id, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    job ? r.request.projectId : r.projectId,
    r.name,
    // NOT NULL since 360: a message has none.
    job ? JSON.stringify(r.request) : '',
    JSON.stringify(r.every),
    nextRun(r.every, now).toISOString(),
    now.toISOString(),
    job ? null : r.agentId,
    job ? null : r.text,
  );
  return getRecurring(db, id)!;
}

/**
 * Its name, its rule, whether it is paused, and (Amendment 216) a message's text or a job's
 * request, the route having checked the new prompt. A new rule, or a resume, makes it next due
 * by the rule from `now`: a schedule resumed after a week does not launch for the week it missed.
 */
export function patchRecurring(
  db: Db,
  id: string,
  p: { name?: string; every?: Every; paused?: boolean; text?: string; request?: CreateJobRequest },
  now = new Date(),
): RecurringJob | null {
  const was = getRecurring(db, id);
  if (!was) return null;
  const every = p.every ?? was.every;
  const resumed = p.paused === false && was.paused;
  const nextAt = p.every !== undefined || resumed ? nextRun(every, now).toISOString() : was.nextAt;
  db.prepare('UPDATE recurring_jobs SET name = ?, every = ?, paused = ?, next_at = ?, text = ?, request = ? WHERE id = ?').run(
    p.name ?? was.name,
    JSON.stringify(every),
    (p.paused ?? was.paused) ? 1 : 0,
    nextAt,
    was.kind === 'message' ? (p.text ?? was.text ?? '') : null,
    was.kind === 'job' ? JSON.stringify(p.request ?? was.request) : '',
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
export function runRequest(r: { name: string; request: CreateJobRequest }, at: Date): CreateJobRequest {
  return {
    ...r.request,
    name: runName(r.name, at),
    ...(r.request.branch !== undefined ? { branch: runBranch(r.request.branch, at) } : {}),
  };
}

/** What the clock and run now need of the supervisor. */
type Runs = Pick<Supervisor, 'createJob' | 'sendMessage' | 'held'>;

/** Not started yet, so it has no session to take a message: tried again at the next look. */
const NOT_YET = /cannot receive messages yet/;

/**
 * The schedules being run in this process, by id: by the clock or by run now. Taken before any
 * await and given back in `finally`, so two runs of one schedule never go side by side: the
 * second finds it taken and runs nothing. A `next_at` claim alone cannot do this, since run now
 * leaves `next_at` where it is.
 */
const running = new Set<string>();

/** What one run did. `jobId` only when it made a job; `retry` for a message that cannot go yet. */
type Ran = { result: string; jobId?: string; retry?: true };

/**
 * One run of a schedule at `at`, by its kind, read fresh once it is claimed: a run that was going
 * when the caller read it may have recorded since. `busy` when it is already being run, `gone`
 * when it was cancelled.
 */
async function runOnce(db: Db, sup: Runs, id: string, at: Date): Promise<Ran | 'busy' | 'gone'> {
  if (running.has(id)) return 'busy';
  running.add(id);
  try {
    const r = getRecurring(db, id);
    if (!r) return 'gone';
    if (r.kind === 'message') {
      try {
        const how = sup.sendMessage(r.agentId!, r.text!);
        return { result: how === 'queued' ? RESULT_SENT_QUEUED : RESULT_SENT };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { result: resultFailed(why), ...(NOT_YET.test(why) ? { retry: true as const } : {}) };
      }
    }
    if (r.lastJobId !== null && stillGoing(getJob(db, r.lastJobId))) return { result: RESULT_SKIPPED };
    try {
      // Checked again as POST /api/jobs checks a launch: a schedule outlives what it was saved
      // with, and a model the engine no longer serves, or a persona gone, is refused here with
      // the reason, not started to fail at its first call. Imported late: routes/session.ts
      // imports the supervisor this file is driven by.
      const { parseCreateJob } = await import('../routes/session.js');
      const parsed = await parseCreateJob(r.request);
      if (!parsed.ok) throw new Error(parsed.detail ? `${parsed.error}: ${parsed.detail}` : parsed.error);
      // The job keeps the schedule's setup, not the run's name and branch (Amendment 216).
      const { job } = await sup.createJob(runRequest({ name: r.name, request: parsed.request }, at), r.id, parsed.request);
      // Made while everything is paused (run now), it waits queued for the pause to end.
      return { result: sup.held ? RESULT_STARTED_HELD : RESULT_STARTED, jobId: job.id };
    } catch (err) {
      return { result: resultFailed(err instanceof Error ? err.message : String(err)) };
    }
  } finally {
    running.delete(id);
  }
}

/**
 * Its last result, and the job only when this run made one: a skip or a failure keeps the job
 * the last run started. Cancelled while its launch ran, the update finds no row: the job it
 * started stays.
 */
function record(db: Db, id: string, iso: string, ran: Ran): void {
  db.prepare('UPDATE recurring_jobs SET last_at = ?, last_job_id = COALESCE(?, last_job_id), last_result = ? WHERE id = ?').run(
    iso,
    ran.jobId ?? null,
    ran.result,
    id,
  );
}

/** Why a message cannot go yet, in words: its agent, by role, has not started. */
function waitingWhy(db: Db, r: RecurringJob): string {
  return resultWaiting(`${getAgent(db, r.agentId!)?.role ?? 'its agent'} has not started yet`);
}

/**
 * Each schedule due at `now`, as THE RULES above say. The caller has checked the hold. True when
 * any row changed, so the list is sent.
 */
export async function runDueRecurring(db: Db, sup: Runs, now: number): Promise<boolean> {
  const at = new Date(now);
  const iso = at.toISOString();
  const due = rows<Row>(
    db.prepare('SELECT * FROM recurring_jobs WHERE paused = 0 AND next_at <= ? ORDER BY next_at').all(iso),
  ).map(toRecurring);
  let changed = false;
  for (const r of due) {
    // Being run now: left as it is, for the next look.
    if (running.has(r.id)) continue;
    // Claimed first, next due by its rule from now: a second clock that read the same row (a
    // restart's first look beside the old one's) finds it taken and launches nothing.
    const next = nextRun(r.every, at).toISOString();
    const claim = db.prepare('UPDATE recurring_jobs SET next_at = ? WHERE id = ? AND next_at = ?').run(next, r.id, r.nextAt);
    if (Number(claim.changes) === 0) continue;
    const ran = await runOnce(db, sup, r.id, at);
    if (ran === 'gone') continue;
    if (ran === 'busy') {
      // Not reached (nothing awaits between the check above and the claim), but given back if it is.
      db.prepare('UPDATE recurring_jobs SET next_at = ? WHERE id = ? AND next_at = ?').run(r.nextAt, r.id, next);
      continue;
    }
    if (ran.retry) {
      // Given back, still due: the next look tries again. Why it waits is said once, when it starts to.
      db.prepare('UPDATE recurring_jobs SET next_at = ? WHERE id = ? AND next_at = ?').run(r.nextAt, r.id, next);
      const waiting = waitingWhy(db, r);
      if (getRecurring(db, r.id)?.lastResult !== waiting) {
        record(db, r.id, iso, { result: waiting });
        changed = true;
      }
      continue;
    }
    record(db, r.id, iso, ran);
    changed = true;
  }
  return changed;
}

/**
 * Run now (Amendment 216): one run of either kind, at once, paused or not, its next time left
 * where it is. A job still skips while its last run goes, and its last result says so; a
 * message to an agent that cannot take one yet says that. One already being run (by the clock,
 * or another run now) runs nothing, and `skipped` says so: its last result is that run's. Null
 * for no such schedule.
 */
export async function runRecurringNow(
  db: Db,
  sup: Runs,
  id: string,
  now = Date.now(),
): Promise<{ recurring: RecurringJob; skipped?: string } | null> {
  if (!getRecurring(db, id)) return null;
  const at = new Date(now);
  const ran = await runOnce(db, sup, id, at);
  if (ran === 'busy') return { recurring: getRecurring(db, id)!, skipped: BEING_RUN };
  if (ran !== 'gone') record(db, id, at.toISOString(), ran);
  const recurring = getRecurring(db, id);
  return recurring ? { recurring } : null;
}
