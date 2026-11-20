/**
 * When a job finishes: the steps its agents asked for, in order, or an offer (Amendments 144, 219).
 *
 * Called by the supervisor when a job settles `done` (`#rollUpJob`, supervisor.ts). Only a job
 * isolated in a worktree of its own gets anything; every other job finishes as before.
 *
 *   - With no step on (`Autonomy.whenDone`, read through `whenDoneOf`, so Amendment 144's
 *     `mergeWhenDone: true` is merge and clean up), nothing moves (wave 10 Q6): a branch ahead
 *     of the target gets Needs You's **Finished: merge into <target>?** (`finished`).
 *   - With any on, for any of its agents, the steps run in order: commit → test → merge → push →
 *     clean up. Each runs only when the one before it went in, was skipped (nothing to do) or
 *     is off; the first that can't run stops the rest. Every agent must be done first: a paused
 *     one may still need the folder, and that stops the first step.
 *       commit   `branchAction` commit, the message from `whenDoneCommitMessage`. Nothing
 *                uncommitted is skipped, not a failure.
 *       test     the project's `testCommand` in the worktree, in the login shell the terminal
 *                uses, for at most `TEST_TIMEOUT_MS`; exit 0 passes. The last
 *                `TEST_TAIL_LINES` lines are kept for the card when it fails.
 *       merge    as Amendment 144 did: Amendment 110's preview first, a clean merge only.
 *       push     the target after a merge (merge on), else the job's branch. Never forced.
 *       cleanup  only a branch the target already has (merged now or before): its folder and
 *                branch go (`cleanUpMerged`: `git worktree remove`, `git branch -d`), the job
 *                and its agents stay, done. A message to one of them puts the folder back
 *                (`Supervisor.restoreFolder`).
 *     Each agent's transcript gets one note, "When done: …", and Needs You a card: the
 *     information card (`merged`) when nothing stopped, or one saying where it stopped and why,
 *     which still offers the merge (`finished`) when the branch is still ahead.
 *
 * A finish runs once: `finishing` is checked and filled before the first await, and a row
 * already written for this settling (`at` after the job's `endedAt`) is never run again. While
 * the steps run the row says `state = 'running'` and which step; a daemon stopped then finds it
 * on boot (`recoverFinishes`) and records it **interrupted at <step>**, running nothing again.
 *
 * The cards are derived from `job_finishes` (migrations 230, 390), as the other derived alerts
 * are from what is stored, so a restart keeps them; only dismissals are stored elsewhere.
 */

import { spawn } from 'node:child_process';
import type { Agent, Alert, Job, WhenDone, WhenDoneResult, WhenDoneStep } from '@conductor/shared';
import { WHEN_DONE_LABELS, durationWords, jobWhenDone, stepsOn, whenDoneCommitMessage } from '@conductor/shared';
import { row, rows, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub } from '../hub.js';
import { chosenShell } from '../terminal/prefs.js';
import { terminalEnv } from '../terminal/shell.js';
import {
  BranchError,
  branchAction,
  cleanUpMerged,
  listBranches,
  previewMerge,
  type BranchRepo,
} from '../workspace/branches.js';
import { GitError } from '../workspace/git.js';
import { projectRepo } from '../workspace/project-repo.js';
import { agentsForJob, getJob, getProject } from './store.js';

/** The longest a test command runs before it is stopped and Test fails. */
export const TEST_TIMEOUT_MS = 30 * 60 * 1000;
/** How much of a failed test's output the card keeps. */
export const TEST_TAIL_LINES = 200;
/** What Test says, and the web pill's title, when the project has no test command. */
export const NO_TEST_COMMAND = "set a test command on the project's Edit first";

/** What finishing a job came to. `none` is a job this doesn't apply to, with why. */
export type Finish =
  | { outcome: 'none'; why: string }
  | { outcome: 'offer'; why: string | null; steps: WhenDoneResult[]; stoppedAt: WhenDoneStep | null }
  | {
      outcome: 'merged';
      sha: string | null;
      cleaned: boolean;
      why: string | null;
      steps: WhenDoneResult[];
      stoppedAt: WhenDoneStep | null;
    };

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
  steps: string | null;
  stopped_at: WhenDoneStep | null;
  test_output: string | null;
  state: 'running' | null;
  current_step: WhenDoneStep | null;
  restored_at: string | null;
}

const listeners = new Set<() => void>();

/** Told after each row is written, so Needs You redraws (alerts.ts subscribes). */
export function onFinishesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[finish] listener threw', err);
    }
  }
}

interface RowStart {
  job_id: string;
  project_id: string;
  branch: string;
  target: string;
  ahead: number;
  agentIds: string[];
}

interface RowEnd {
  kind: 'offer' | 'merged';
  sha: string | null;
  cleaned: boolean;
  why: string | null;
  steps: WhenDoneResult[] | null;
  stoppedAt: WhenDoneStep | null;
  testOutput: string | null;
}

function insert(db: Db, r: RowStart, end: RowEnd | null): number {
  const res = db
    .prepare(
      `INSERT INTO job_finishes (job_id, project_id, kind, branch, target, ahead, agent_ids, sha, cleaned, why, at,
                                 steps, stopped_at, test_output, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.job_id,
      r.project_id,
      end?.kind ?? 'offer',
      r.branch,
      r.target,
      r.ahead,
      JSON.stringify(r.agentIds),
      end?.sha ?? null,
      end?.cleaned ? 1 : 0,
      end?.why ?? null,
      new Date().toISOString(),
      end?.steps ? JSON.stringify(end.steps) : JSON.stringify([]),
      end?.stoppedAt ?? null,
      end?.testOutput ?? null,
      end ? null : 'running',
    );
  if (end) changed();
  return Number(res.lastInsertRowid);
}

function progress(db: Db, id: number, steps: WhenDoneResult[], current: WhenDoneStep | null): void {
  db.prepare('UPDATE job_finishes SET steps = ?, current_step = ? WHERE id = ?').run(JSON.stringify(steps), current, id);
}

function settle(db: Db, id: number, ahead: number, end: RowEnd): void {
  db.prepare(
    `UPDATE job_finishes SET kind = ?, ahead = ?, sha = ?, cleaned = ?, why = ?, steps = ?, stopped_at = ?,
                             test_output = ?, state = NULL, current_step = NULL
     WHERE id = ?`,
  ).run(
    end.kind,
    ahead,
    end.sha,
    end.cleaned ? 1 : 0,
    end.why,
    JSON.stringify(end.steps ?? []),
    end.stoppedAt,
    end.testOutput,
    id,
  );
  changed();
}

/** A refusal as one sentence, as the Branches screen shows it. */
function sentence(err: unknown): string {
  if (err instanceof BranchError) return err.detail ? `${err.message} — ${gitSaid(err.detail)}` : err.message;
  if (err instanceof GitError) return `git failed: ${err.stderr.trim() || err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** What git printed, on one line, without its hints: the transcript note is one sentence. */
function gitSaid(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('hint:')).join(' ');
}

/** Why the steps can't run by themselves, or null when they can. Every agent must be done: a paused one still needs its folder. */
function notAllDone(agents: Agent[]): string | null {
  const open = agents.find((a) => a.status !== 'done');
  return open ? `${open.role} is ${open.status}, not done, so it may still need the folder` : null;
}

const short = (sha: string): string => sha.slice(0, 7);

/** Each settling of a job finishes once (Amendment 219): `<jobId>@<endedAt>`. */
const finishing = new Set<string>();

/**
 * What to do now that `jobId` has settled `done`. `forgetJob` removes a job as DELETE
 * /api/jobs/:jobId does (`Supervisor.deleteJob`); the steps never call it, but the repo's
 * Branches screen paths take it. Never throws: a failure is logged, and the job is left as it is.
 */
export async function finishJob(db: Db, jobId: string, forgetJob: (jobId: string) => Promise<void>): Promise<Finish> {
  // Before any await, so a second call for the same settling sees the first (as Amendment 216's pump does).
  const job = getJob(db, jobId);
  if (!job || job.status !== 'done') return { outcome: 'none', why: 'the job is not done' };
  const key = `${jobId}@${job.endedAt ?? ''}`;
  if (finishing.has(key)) return { outcome: 'none', why: 'this finish already ran' };
  finishing.add(key);
  try {
    if (job.endedAt && alreadyFinished(db, jobId, job.endedAt)) return { outcome: 'none', why: 'this finish already ran' };
    return await finish(db, job, forgetJob);
  } catch (err) {
    console.warn(`[finish] ${jobId}: ${sentence(err)}`);
    return { outcome: 'none', why: sentence(err) };
  }
}

/** A row written since the job last settled: that settling was finished, here or before a restart. */
function alreadyFinished(db: Db, jobId: string, endedAt: string): boolean {
  return row(db.prepare('SELECT 1 AS one FROM job_finishes WHERE job_id = ? AND at >= ? LIMIT 1').get(jobId, endedAt)) !== undefined;
}

async function finish(db: Db, job: Job, forgetJob: (jobId: string) => Promise<void>): Promise<Finish> {
  if (job.isolation !== 'worktree') {
    return { outcome: 'none', why: `the job works in ${job.isolation === 'in_place' ? 'the project folder' : 'a branch of the project folder'}, not a worktree of its own` };
  }
  const repo = await projectRepo(db, job.projectId, forgetJob);
  if (!repo) return { outcome: 'none', why: 'no such project' };
  const state = await listBranches(repo);
  const b = state.branches.find((x) => x.name === job.branch);
  if (!b || b.isTarget) return { outcome: 'none', why: `${job.branch} isn't a branch other than the target` };

  const agents = agentsForJob(db, job.id);
  const want = jobWhenDone(agents);
  const start: RowStart = { job_id: job.id, project_id: job.projectId, branch: b.name, target: state.target, ahead: b.ahead, agentIds: agents.map((a) => a.id) };

  if (stepsOn(want).length === 0) {
    if (b.ahead === 0) return { outcome: 'none', why: `${state.target} already has everything on ${b.name}` };
    insert(db, start, { kind: 'offer', sha: null, cleaned: false, why: null, steps: null, stoppedAt: null, testOutput: null });
    return { outcome: 'offer', why: null, steps: [], stoppedAt: null };
  }

  const id = insert(db, start, null);
  const run = await runSteps(db, id, job, repo, want, agents);

  const after = (await listBranches(repo)).branches.find((x) => x.name === b.name);
  const ahead = after?.ahead ?? 0;
  const mergedNow = run.steps.some((s) => s.step === 'merge' && s.outcome === 'done');
  const cleaned = run.steps.some((s) => s.step === 'cleanup' && s.outcome === 'done');
  // Still ahead and not merged here: the card offers the merge. Otherwise it only says what was done.
  const kind: 'offer' | 'merged' = !mergedNow && ahead > 0 ? 'offer' : 'merged';
  const end: RowEnd = { kind, sha: run.sha, cleaned, why: run.why, steps: run.steps, stoppedAt: run.stoppedAt, testOutput: run.testOutput };
  note(job, agents, run.steps, run.stoppedAt, want);
  settle(db, id, ahead, end);
  return kind === 'offer'
    ? { outcome: 'offer', why: run.why, steps: run.steps, stoppedAt: run.stoppedAt }
    : { outcome: 'merged', sha: run.sha, cleaned, why: run.why, steps: run.steps, stoppedAt: run.stoppedAt };
}

interface Run {
  steps: WhenDoneResult[];
  stoppedAt: WhenDoneStep | null;
  why: string | null;
  sha: string | null;
  testOutput: string | null;
}

async function runSteps(db: Db, id: number, job: Job, repo: BranchRepo, want: WhenDone, agents: Agent[]): Promise<Run> {
  const run: Run = { steps: [], stoppedAt: null, why: null, sha: null, testOutput: null };
  const open = notAllDone(agents);
  for (const step of stepsOn(want)) {
    if (open) {
      run.steps.push({ step, outcome: 'failed', said: `didn't ${WHEN_DONE_LABELS[step]}: ${open}` });
      run.stoppedAt = step;
      run.why = open;
      break;
    }
    progress(db, id, run.steps, step);
    let r: WhenDoneResult;
    try {
      r = await STEPS[step]({ db, job, repo, want, agents, run });
    } catch (err) {
      r = { step, outcome: 'failed', said: `didn't ${WHEN_DONE_LABELS[step]}: ${sentence(err)}` };
    } finally {
      broadcastBranches(job.projectId);
    }
    run.steps.push(r);
    progress(db, id, run.steps, null);
    if (r.outcome === 'failed') {
      run.stoppedAt = step;
      run.why = r.said;
      break;
    }
  }
  return run;
}

interface StepCtx {
  db: Db;
  job: Job;
  repo: BranchRepo;
  want: WhenDone;
  agents: Agent[];
  run: Run;
}

const STEPS: Record<WhenDoneStep, (c: StepCtx) => Promise<WhenDoneResult>> = {
  async commit({ db, job, repo }) {
    const b = (await listBranches(repo)).branches.find((x) => x.name === job.branch);
    if (!b?.worktree || b.worktree.uncommitted === 0) return { step: 'commit', outcome: 'skipped', said: 'nothing to commit' };
    const message = whenDoneCommitMessage(job.name ?? job.prompt, lastReply(db, job.id));
    try {
      const out = await branchAction(repo, { action: 'commit', branch: b.name, message });
      return { step: 'commit', outcome: 'done', said: out.sha ? `committed ${short(out.sha)}` : 'committed' };
    } catch (err) {
      if (err instanceof BranchError && err.message === 'nothing to commit') return { step: 'commit', outcome: 'skipped', said: 'nothing to commit' };
      throw err;
    }
  },

  async test({ db, job, run }) {
    const command = getProject(db, job.projectId)?.testCommand?.trim();
    if (!command) return { step: 'test', outcome: 'failed', said: `didn't test: ${NO_TEST_COMMAND}` };
    const t = await runTestCommand(command, job.worktreePath);
    if (t.code === 0 && !t.timedOut) return { step: 'test', outcome: 'done', said: `tests passed (${command}, ${durationWords(t.ms)})` };
    run.testOutput = t.tail;
    return {
      step: 'test',
      outcome: 'failed',
      said: t.timedOut
        ? `tests timed out (${command}, stopped after ${durationWords(TEST_TIMEOUT_MS)})`
        : t.error
          ? `tests didn't run (${command}: ${t.error})`
          : `tests failed (${command}, exit ${t.code ?? t.signal ?? '?'}, ${durationWords(t.ms)})`,
    };
  },

  async merge({ job, repo, run }) {
    const state = await listBranches(repo);
    const b = state.branches.find((x) => x.name === job.branch);
    if (!b || b.ahead === 0) return { step: 'merge', outcome: 'skipped', said: `nothing to merge into ${state.target}` };
    // Lane J's preview first: the sentence the merge would refuse with, and the conflicts.
    const preview = await previewMerge(repo, b.name, undefined);
    const no = (why: string): WhenDoneResult => ({ step: 'merge', outcome: 'failed', said: `didn't merge: ${why}` });
    if (preview.reason) return no(preview.reason);
    if (preview.conflicts === null) return no("this git can't tell beforehand whether the merge would conflict, so it wasn't merged by itself");
    if (preview.conflicts.length > 0) return no(`it would conflict with ${state.target} in ${preview.conflicts.join(', ')}`);
    const merged = await branchAction(repo, { action: 'merge', branch: b.name });
    if (!merged.ok || !merged.sha) {
      return no(merged.conflict ? `the merge conflicted in ${merged.conflict.files.join(', ')} and was undone` : 'the merge did not go in');
    }
    run.sha = merged.sha;
    return { step: 'merge', outcome: 'done', said: `merged into ${state.target} as ${short(merged.sha)}` };
  },

  async push({ job, repo, want }) {
    const state = await listBranches(repo);
    const which = want.merge ? state.target : job.branch;
    if (!state.remote) return { step: 'push', outcome: 'failed', said: `didn't push ${which}: the project has no remote called origin to push to` };
    await branchAction(repo, { action: 'push', branch: which });
    return { step: 'push', outcome: 'done', said: `pushed ${which} to ${state.remote}` };
  },

  async cleanup({ job, repo }) {
    const state = await listBranches(repo);
    const b = state.branches.find((x) => x.name === job.branch);
    if (!b) return { step: 'cleanup', outcome: 'skipped', said: `${job.branch} is already gone` };
    if (b.ahead > 0 || b.forkedAt === null) {
      return {
        step: 'cleanup',
        outcome: 'failed',
        said: `didn't clean up: ${b.name} isn't merged into ${state.target}${b.ahead > 0 ? ` (${b.ahead} commit${b.ahead === 1 ? '' : 's'} ${state.target} doesn't have)` : ''}, so its folder and branch were kept`,
      };
    }
    await cleanUpMerged(repo, b.name);
    return { step: 'cleanup', outcome: 'done', said: 'cleaned up the folder and branch' };
  },
};

/** The newest thing any agent of the job said, for the commit message. */
function lastReply(db: Db, jobId: string): string | null {
  const found = row<{ payload: string }>(
    db.prepare(`SELECT payload FROM events WHERE job_id = ? AND kind = 'text' ORDER BY seq DESC LIMIT 1`).get(jobId),
  );
  if (!found) return null;
  const p = JSON.parse(found.payload) as { kind: string; text?: string };
  return p.kind === 'text' && typeof p.text === 'string' ? p.text : null;
}

/** One note per agent: what each step came to, where it stopped, and what didn't run. */
function note(job: Job, agents: Agent[], steps: WhenDoneResult[], stoppedAt: WhenDoneStep | null, want: WhenDone): void {
  eventsFor(job, agents, whenDoneSentence(steps, stoppedAt, want));
}

/** "When done: committed a1b2c3d · tests passed (make test, 2m 10s) · …", and on a stop, what didn't run. */
export function whenDoneSentence(steps: WhenDoneResult[], stoppedAt: WhenDoneStep | null, want: WhenDone): string {
  const said = `When done: ${steps.map((s) => s.said).join(' · ')}`;
  if (!stoppedAt) return `${said}.`;
  const on = stepsOn(want);
  const rest = on.slice(on.indexOf(stoppedAt) + 1).map((s) => WHEN_DONE_LABELS[s]);
  if (rest.length === 0) return `${said}.`;
  const list = rest.length === 1 ? rest[0]! : `${rest.slice(0, -1).join(', ')} and ${rest[rest.length - 1]}`;
  return `${said}. ${list[0]!.toUpperCase()}${list.slice(1)} didn't run.`;
}

function eventsFor(job: Pick<Job, 'id'>, agents: Agent[], text: string): void {
  for (const a of agents) {
    eventLog().emit({ projectId: a.projectId, jobId: job.id, agentId: a.id }, { kind: 'user_text', synthetic: true, text });
  }
}

function broadcastBranches(projectId: string): void {
  try {
    hub().broadcast({ type: 'branches', projectId });
  } catch {
    // No hub outside the daemon.
  }
}

/** What a test command came to. */
export interface TestRun {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Spawning the shell failed. */
  error?: string;
  /** The last `TEST_TAIL_LINES` lines of its output, colours taken out. */
  tail: string;
  ms: number;
}

// CSI, OSC and the two-byte escapes: what a coloured test runner writes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Output as the card shows it: no colours, a carriage-return redraw as its last state, the last `lines` lines. */
export function outputTail(raw: string, lines = TEST_TAIL_LINES): string {
  const clean = raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1));
  while (clean.length > 0 && clean[clean.length - 1]!.trim() === '') clean.pop();
  return clean.slice(-lines).join('\n');
}

/**
 * Run `command` in `cwd` with the login shell the terminal uses (`chosenShell`, its env as
 * `terminalEnv` makes it), in a process group of its own so a timeout stops everything it started.
 */
export function runTestCommand(command: string, cwd: string, timeoutMs = TEST_TIMEOUT_MS): Promise<TestRun> {
  const shell = chosenShell();
  const started = Date.now();
  // Enough bytes for the tail and not the whole run: cut from the front when it grows.
  const KEEP = 512 * 1024;
  let out = '';
  const take = (chunk: Buffer): void => {
    out += chunk.toString('utf8');
    if (out.length > KEEP * 2) out = out.slice(-KEEP);
  };
  return new Promise((resolve) => {
    let timedOut = false;
    let done = false;
    const child = spawn(shell.file, [...shell.args, '-c', command], {
      cwd,
      env: terminalEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const group = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), 5000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const end = (r: Omit<TestRun, 'tail' | 'ms' | 'timedOut'>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, timedOut, tail: outputTail(out), ms: Date.now() - started });
    };
    child.on('error', (err) => end({ code: null, signal: null, error: err.message }));
    child.on('close', (code, signal) => end({ code, signal }));
  });
}

/**
 * On boot: a finish whose steps were running when the daemon stopped is recorded as
 * **interrupted at <step>**, with a card, and nothing is run again — a half-run step is the
 * person's to look at, not something to repeat.
 */
export function recoverFinishes(db: Db): number {
  const stuck = rows<FinishRow>(db.prepare(`SELECT * FROM job_finishes WHERE state = 'running'`).all());
  for (const r of stuck) {
    const steps = parseSteps(r.steps);
    const step: WhenDoneStep = r.current_step ?? 'commit';
    steps.push({ step, outcome: 'interrupted', said: `interrupted at ${WHEN_DONE_LABELS[step]}` });
    const merged = steps.some((s) => s.step === 'merge' && s.outcome === 'done');
    const why = `the daemon stopped while ${WHEN_DONE_LABELS[step]} ran; nothing was run again`;
    db.prepare(
      `UPDATE job_finishes SET kind = ?, why = ?, steps = ?, stopped_at = ?, state = NULL, current_step = NULL WHERE id = ?`,
    ).run(merged ? 'merged' : 'offer', why, JSON.stringify(steps), step, r.id);
    const job = getJob(db, r.job_id);
    if (job) eventsFor(job, agentsForJob(db, r.job_id), `When done: ${steps.map((s) => s.said).join(' · ')}: ${why}.`);
  }
  if (stuck.length > 0) changed();
  return stuck.length;
}

function parseSteps(raw: string | null): WhenDoneResult[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as WhenDoneResult[]) : [];
  } catch {
    return [];
  }
}

/**
 * Whether `jobId`'s folder was taken away by its own clean-up step and not put back since: the
 * newest finish row says it cleaned up, and nothing restored it. Only then does a message to one
 * of its agents put the folder back by itself; a folder that went missing any other way is refused.
 */
export function cleanedByFinish(db: Db, jobId: string): boolean {
  const r = row<{ cleaned: number; restored_at: string | null }>(
    db.prepare('SELECT cleaned, restored_at FROM job_finishes WHERE job_id = ? AND state IS NULL ORDER BY id DESC LIMIT 1').get(jobId),
  );
  return r !== undefined && r.cleaned === 1 && r.restored_at === null;
}

/** The folder a clean-up took away is back: messages go on as for any other folder. */
export function markRestored(db: Db, jobId: string): void {
  db.prepare(
    `UPDATE job_finishes SET restored_at = ? WHERE id = (SELECT id FROM job_finishes WHERE job_id = ? ORDER BY id DESC LIMIT 1)`,
  ).run(new Date().toISOString(), jobId);
}

/**
 * The cards (alerts.ts lists them with the rest). `finished`: the newest offer per job, while
 * that job is still there and `done` — a job that runs again asks again when it next finishes,
 * and one that was removed has nothing left to merge from here. `merged`: every one, until
 * dismissed. A finish still running has no card yet.
 */
export function finishAlerts(db: Db): Alert[] {
  const all = rows<FinishRow>(db.prepare('SELECT * FROM job_finishes WHERE state IS NULL ORDER BY id ASC').all());
  const newest = new Map<string, number>();
  for (const r of all) if (r.kind === 'offer') newest.set(r.job_id, r.id);
  const out: Alert[] = [];
  for (const r of all) {
    const steps = parseSteps(r.steps);
    const common = {
      projectId: r.project_id,
      jobId: r.job_id,
      since: r.at,
      branch: r.branch,
      into: r.target,
      ahead: r.ahead,
      ...(steps.length > 0 ? { steps: steps.map((s) => s.said) } : {}),
      ...(r.stopped_at ? { stoppedAt: r.stopped_at } : {}),
      ...(r.test_output ? { testOutput: r.test_output } : {}),
    };
    if (r.kind === 'offer') {
      if (newest.get(r.job_id) !== r.id) continue;
      const job = getJob(db, r.job_id);
      if (!job || job.status !== 'done') continue;
      out.push({
        id: `finished:${r.id}`,
        kind: 'finished',
        cause: r.stopped_at ? `stopped at ${WHEN_DONE_LABELS[r.stopped_at]}` : 'finished',
        agentIds: agentsForJob(db, r.job_id).map((a) => a.id),
        ...common,
        ...(r.why ? { detail: r.why } : {}),
      });
    } else {
      const cleaned = r.cleaned === 1;
      out.push({
        id: `merged:${r.id}`,
        kind: 'merged',
        cause: r.stopped_at
          ? `stopped at ${WHEN_DONE_LABELS[r.stopped_at]}`
          : steps.length > 0
            ? 'when done'
            : cleaned
              ? 'merged and cleaned up'
              : 'merged',
        // Amendment 219 keeps the job and its agents; Amendment 144's clean-up removed them, so an old row lists none.
        agentIds: agentsForJob(db, r.job_id).map((a) => a.id),
        ...common,
        cleaned,
        ...(r.sha ? { sha: r.sha } : {}),
        ...(r.why ? { detail: r.why } : {}),
      });
    }
  }
  return out;
}
