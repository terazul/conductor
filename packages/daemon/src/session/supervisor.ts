/**
 * Supervisor — who runs, when, and with what rope.
 *
 * Owns three things the runner deliberately does not:
 *   • the slot semaphore. A slot is a LIVE PROCESS, so `held` agents consume one
 *     and `parked` agents do not. That asymmetry is the whole point of parking:
 *     a human who wanders off stops costing us a slot (PLAN.md §1 finding B).
 *   • dependsOn gating — the mockup's "starts now / parallel / after both".
 *   • budgets. An agent's is a figure PER DAY (what it spent today, back to zero at midnight)
 *     that warns when passed and stops it at twice the budget, checked before every launch and
 *     resume; a job's is the sum of its agents' budgets, with the same ceiling, checked before
 *     a queued agent starts (session/budget.ts, Amendments 124, 129).
 *
 * ISOLATION is delegated, not reimplemented. Track C's WorkspaceService owns
 * worktree lifecycle, so this calls `workspace().open(...)` IN-PROCESS for all
 * three isolations — its `/api/workspaces` endpoints are bootstrap-only and will
 * be gated. It also emits the `worktree` event and attaches the file watcher, so
 * neither is duplicated here.
 */

import { onSettingsChanged, readSettings } from '../settings.js';
import { BUDGET_CEILING_KEY, branchTargetKey } from '@conductor/shared';
import { branchExists, git, listWorktrees, repoRoot } from '../workspace/git.js';
import { canonicalRoot } from '../workspace/paths.js';
import { resolveTarget } from '../workspace/branches.js';
import { SLOTS_KEY, slotLimit } from '../slots.js';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Agent,
  AgentStatus,
  AgentSpec,
  Autonomy,
  CreateJobRequest,
  CreateJobResponse,
  Job,
  Project,
  Rewired,
  RerunResponse,
  Snapshot,
} from '@conductor/shared';
import {
  HANDOFF_BY_USER_NOTE,
  HANDOFF_HELD_NOTE,
  HANDOFF_SUMMARY_MAX,
  SEND_BACKS_MAX,
  ancestorsOf,
  createsCycle,
  helperModel,
  helperReads,
  helperSlug,
  isStuck,
  listedRole,
  missingHeadings,
  readOnlyRefusal,
  rerunPlan,
  rewireOnRemoval,
  roleRefusal,
  sendBackRefusal,
  waitersOf,
} from '@conductor/shared';
import { arbiter, type AgentControl } from '../arbiter/index.js';
import type { Db } from '../db/index.js';
import { onDayTurn } from '../daily.js';
import { eventLog } from '../eventlog.js';
import { hub, registerSnapshotContributor } from '../hub.js';
import { preview } from '../preview/index.js';
import { expand as expandPath } from '../workspace/browse.js';
import { workspace } from '../workspace/service.js';
import { terminals } from '../terminal/service.js';
import { LaunchBranchError } from '../workspace/worktree.js';
import { budgetChanged } from './alerts.js';
import { JOB_BUDGET_NOTE, budgetNote, budgetRefusal, continuations, jobBudgetState, newDayNote, renewals, resumeAtMidnight, type PausedForBudget } from './budget.js';
import {
  handOffLine,
  handoffCap,
  handoffSection,
  helperBrief,
  helperReport,
  inStack,
  orchestratorSection,
  pipelineHelperBrief,
  pipelineReportClosing,
  pipelineSection,
  stackLine,
  turnsFromEvents,
  type Upstream,
} from './handoff.js';
import type { ToolAccess, ToolRole } from '../routes/helpers.js';
import { rerunNote, rerunStatusNote } from './rerun.js';
import { recordRunEnd } from './metrics.js';
import type { AgentBackend } from './backend.js';
import { createBackend } from './backends/index.js';
import { decideRetry, onRetryDue, retryBook, retryNote, type ApiFailure } from './retry.js';
import {
  agentsForJob,
  agentsThatSpentOn,
  DEFAULT_AUTONOMY,
  spendFigures,
  defaultBranchIsSet,
  deleteAgent,
  deleteJob,
  deleteProject,
  getAgent,
  getAgentBrief,
  getJob,
  getProject,
  getRequest,
  getProjectByPath,
  addProjectDir,
  removeProjectDir,
  projectDirs,
  insertAgent,
  getAgentPersona,
  getAgentProvider,
  insertJob,
  insertProject,
  jobCostToday,
  jobsForProject,
  answeredSinceLastRun,
  lastDeferredTool,
  listAgents,
  listJobs,
  listProjects,
  newId,
  setAgentAutonomy,
  setAgentModel,
  setAgentStatus,
  setJobStatus,
  updateProject,
  helpersOf,
  getHelperRoles,
  startedInLane,
  markReported,
  setAgentDependsOn,
  unreportedHelpers,
  getWentWithout,
  setWentWithout,
  getHandoff,
  setHandoff,
  getRerunPending,
  setRerunPending,
  lastStatusNote,
  lastStatusDay,
  localDay,
  type AgentPersona,
} from './store.js';
import { reportedWindow } from './windows.js';
import { finishJob, type Finish } from './finish.js';
import { broadcastScheduled, deleteScheduled, failScheduled, nextWhenDone } from './schedule.js';

const exec = promisify(execFile);

export { DEFAULT_SLOTS, SLOTS_KEY, SLOTS_MAX, slotLimit } from '../slots.js';

/** A helper in one of these has ended: its orchestrator can be told. */
const ENDED: AgentStatus[] = ['done', 'failed', 'stopped'];

/** A stored persona as insertAgent takes it: only what is set (Amendment 68). */
function personaFields(p: AgentPersona): { persona?: string; systemPrompt?: string; skills?: string[] } {
  return {
    ...(p.persona ? { persona: p.persona } : {}),
    ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.skills?.length ? { skills: p.skills } : {}),
  };
}

/**
 * One agent's row from its spec — what `createJob` inserts for each spec and `addAgent` for
 * one more (ADR 0002), so the two can't copy a spec differently.
 */
function agentRow(
  spec: AgentSpec,
  at: { id: string; jobId: string; projectId: string; dependsOn: string[] },
): Parameters<typeof insertAgent>[1] {
  return {
    ...at,
    role: spec.role,
    model: spec.model,
    sdkSessionId: null,
    status: 'queued',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    autonomy: spec.autonomy,
    brief: spec.brief,
    ...(spec.helpers ? { helperCap: spec.helpers } : {}),
    // The roles an orchestrated stack's orchestrator may start, as resolved at launch (Amendment 128).
    ...(spec.helperRoles?.length ? { helperRoles: spec.helperRoles } : {}),
    // Copied, not referenced: the agent keeps these if the persona changes (Amendment 68).
    ...(spec.persona ? { persona: spec.persona } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.skills?.length ? { skills: spec.skills } : {}),
    ...(spec.provider && spec.provider !== 'claude' ? { provider: spec.provider } : {}),
  };
}

/** A stored persona as a runner's scope takes it: the persona's id stays on the row. */
function personaScope(p: AgentPersona): { systemPrompt?: string; skills?: string[] } {
  return {
    ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.skills?.length ? { skills: p.skills } : {}),
  };
}

/**
 * Why an agent waiting on a stopped one is paused (Amendment 88). It doesn't start by
 * itself: resuming it runs it without that one, and removing that one from the stack
 * points it at what that one waited on.
 */
export function strandNote(role: string | null): string {
  return role === null
    ? 'waits for an agent that was removed — resume to run without it'
    : `waits for ${role}, which was stopped — resume to run without it, or remove it`;
}

/**
 * Why an agent is paused while everything is (Amendment 111). Its own sentence, so the end
 * of the pause wakes exactly the agents it paused, after a restart too: the note is in the
 * event log, as `isStrandNote`'s is. One you paused yourself stays paused.
 */
export const HOLD_NOTE = 'paused with everything until the scheduled time — it carries on by itself then';

/**
 * Why an agent can't run: the folder its job works in is gone (Amendment 114). Removed by
 * hand, by `git worktree remove`, or a disk unmounted. Starting Claude Code there fails with
 * "native binary … failed to launch (ENOENT)", which reads as a broken install, so it is
 * checked first and said plainly.
 */
export const FOLDER_GONE = 'folder_gone';

/** The sentence for it, with what will fix it. */
export function folderGoneDetail(path: string, restorable: boolean): string {
  return restorable
    ? `its folder ${path} is gone — recreate it (Needs You → recreate folder) and continue; its conversation is kept`
    : `its folder ${path} is gone — put the folder back, or remove this job`;
}

/** A message refused because the agent's folder is gone; its message is the sentence. */
export class FolderGoneError extends Error {}

/** Whether a pause note is `strandNote`'s. */
export const isStrandNote = (note: string | null): boolean =>
  note !== null && note.startsWith('waits for ') && note.includes('resume to run without it');

/**
 * What an agent is told when a question it asked was put aside and you have answered it
 * since (Amendment 131). Parking ends the turn, and Claude Code records that as "the user
 * doesn't want to proceed … STOP what you are doing": told only "make that call again", the
 * agent read its question as rejected, or asked again after being told to stop. So it is
 * told what happened, and your answers themselves. Pure, so verify checks the wording.
 */
export function answeredNudge(
  questions: readonly { question: string }[],
  answers: Readonly<Record<string, string | string[]>>,
  response?: string,
): string {
  const lines: string[] = [];
  const asked = new Set(questions.map((q) => q.question));
  const say = (q: string, a: string | string[]) => lines.push(`- "${q}" → ${Array.isArray(a) ? a.join(', ') : a}`);
  for (const q of questions) if (answers[q.question] !== undefined) say(q.question, answers[q.question]!);
  for (const [q, a] of Object.entries(answers)) if (!asked.has(q)) say(q, a);
  if (response?.trim()) lines.push(`- And they added: ${response.trim()}`);
  return [
    'The user has answered the question you asked. It waited a while, so it was put to one side: that is why it',
    "came back as \"the user doesn't want to proceed\". Ignore that. Their answers:",
    ...(lines.length > 0 ? lines : ['- (no answer was given to any of the questions)']),
    'Carry on from where you stopped, with these answers. Do not ask this question again.',
  ].join('\n');
}

/** Nudge text for a park that came from interrupt() rather than `defer`. */
const RESUME_NUDGE =
  'Continue from where you stopped: the tool call you were waiting on has been decided.';

/**
 * Nudge for waking a paused agent, where nothing was decided and nothing is owed. A
 * pause stops a tool call that was still running, and the call reports nothing back,
 * so the model is told to look before it trusts one (Amendment 35).
 */
export const WAKE_NUDGE =
  'Continue from where you stopped. You were paused: if a tool call was still running ' +
  'then, it was stopped before it finished, so check what it did before relying on it.';

/**
 * What an agent the daemon's restart interrupted is told when it resumes on its own
 * (Amendment 53). Like a wake from pause, a tool call that was running got no result.
 */
export const RESTART_NUDGE =
  'Continue from where you stopped. Conductor restarted while you were working: if a tool ' +
  'call was still running then, it was stopped before it finished, so check what it did ' +
  'before relying on it. Anything you had running in the background, such as background ' +
  'agents or tasks you started yourself, was stopped with it and will not report back: do ' +
  'that work again yourself rather than wait for it, and do not end your turn until it is ' +
  'done (Amendment 119).';

/**
 * What an agent is told when it is tried again after the model couldn't be reached
 * (Amendment 123). Its run ended with the API failing, so a tool call that was running got no
 * result, and anything it had running in the background went with the run.
 */
export const RETRY_NUDGE =
  'Continue from where you stopped. The model could not be reached, so your last turn was ' +
  'cut off: if a tool call was still running then, it was stopped before it finished, so ' +
  'check what it did before relying on it. Anything you had running in the background, ' +
  'such as background agents or tasks you started yourself, was stopped with it and will ' +
  'not report back: do that work again yourself rather than wait for it.';

/**
 * What an agent the new day continued is told (Amendment 140): it was paused at its daily
 * budget's ceiling (or its job's), and nothing it ran then finished. A synthetic turn, shown
 * as `auto` like every resume prompt.
 */
export const NEW_DAY_NUDGE =
  'Continue from where you stopped. You were paused because you reached your daily budget; ' +
  "a new day's budget has begun, so you can carry on. If a tool call was still running when " +
  'you were paused, it was stopped before it finished, so check what it did before relying on it.';

/**
 * Sent once, on its own, to an agent that a restart interrupted and that then ended its
 * turn without calling `hand_off` while agents wait for it (Amendment 119). Without it the
 * agent is held and you are asked; most of the time what it needs is this sentence.
 */
export const HANDOFF_ASK =
  'You ended your turn without calling hand_off, and the agents after you cannot start ' +
  'until you have. Conductor restarted while you were working, so check what is really ' +
  'finished: anything you had running in the background was stopped and will not report ' +
  'back. Finish what is left yourself, then call hand_off with a summary for them.';

/** What `deleteProject` forgot, and what it left alone. Reported to the human. */
export interface ProjectRemoval {
  projectId: string;
  name: string;
  path: string;
  jobs: number;
  agents: number;
  /** Worktree directories Conductor walked away from. Still on disk, all of them. */
  keptOnDisk: string[];
}

/**
 * A project with a live agent in it. Carries the roles so the route can name
 * them — "2 agents are still running" is an instruction to go and look, whereas
 * "builder, validator" is one to go and stop something specific.
 */
/** Statuses from which an agent cannot be stopped, because it already has. */
const ENDED_STATUSES: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);

/** An agent at its cap. The message is the sentence the person reads (budget.ts). */
export class BudgetReachedError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'BudgetReachedError';
  }
}

/** A hand-off that can't be done, with the sentence that says why (Amendment 104). The route answers 409. */
export class HandOffRefusedError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'HandOffRefusedError';
  }
}

/**
 * A re-run that can't be done, with the sentence that says why (Amendment 102). The route
 * answers 409 with it, so the person reads the reason and not a status code.
 */
export class RerunRefusedError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'RerunRefusedError';
  }
}

/** `retry now` or `stop retrying` for an agent that is not waiting to retry (Amendment 123). */
export class RetryRefusedError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'RetryRefusedError';
  }
}

export class ProjectBusyError extends Error {
  readonly roles: string[];

  constructor(roles: string[]) {
    super(
      `${roles.join(', ')} ${roles.length === 1 ? 'is' : 'are'} still running — ` +
        'interrupt or pause them first, then remove the project',
    );
    this.name = 'ProjectBusyError';
    this.roles = roles;
  }
}

export class Supervisor implements AgentControl {
  #db: Db;
  #runners = new Map<string, AgentBackend>();
  /** Agents a restart interrupted, resumed with RESTART_NUDGE on their next run. */
  #restarted = new Set<string>();
  /**
   * Agents whose run in flight began as a restart resume, told RESTART_NUDGE (Amendment 119).
   * `#settle` takes the entry out whatever way the run ends, so it never outlives the run:
   * a run that ends held for not handing off is asked, once, before the hold.
   */
  #restartRuns = new Set<string>();
  /**
   * Agents whose run in flight began after a wait for the model (Amendment 123), told
   * RETRY_NUDGE. `#settle` takes the entry out whatever way the run ends, and sets it again
   * when the next wait starts. The tries used and the waits live in `retryBook()`.
   */
  #retryRuns = new Set<string>();
  /** Agents the new day continued (Amendment 140), told NEW_DAY_NUDGE on their next run. */
  #newDayRuns = new Set<string>();
  /*
   * Agents `rerunFrom` queued, with the roles whose reply changed, are resumed with `rerunNote`
   * on their next run (Amendment 102). That is kept in the agent's row (`rerun_pending`, set by
   * `setRerunPending`, migration 160), not here: it used to be a map in memory, and a restart
   * between the press and the run resumed the agent without the note (Amendment 120).
   */
  /** Jobs part-way through `rerunFrom`, which a second press must not interleave with. */
  #rerunning = new Set<string>();
  /** Agents whose run() is in flight, whether working or held. */
  #active = new Set<string>();
  /**
   * Agents answered while their previous run was still unwinding. A decision can
   * land in the window between interrupt() and the iterator finishing, and
   * relaunching then would collide with the run that is still closing down.
   */
  #resumeWanted = new Set<string>();
  /** Jobs part-way through `terminateJob`, which `pump` must not launch into. */
  #halting = new Set<string>();
  /**
   * Runs you ended, by pausing or by stopping the daemon, that haven't settled yet.
   * An interrupted run ends with an error result, and `#settle` used to read that as a
   * failure. `pauseAgent` wrote `paused` and then, if the run's own chain got there
   * second, `#settle` rewrote it `failed`, which F13 would have turned into an alert
   * for something you did on purpose.
   */
  #userStopped = new Set<string>();

  /** Everything is paused until a time (Amendment 111); `hold` and `release` set it. */
  #hold = false;

  constructor(db: Db) {
    this.#db = db;
    // A wait for the model is over, by its time or by `retry now` (Amendment 123): the agent is
    // queued, so pump starts it when there is a slot, as it starts any queued agent.
    onRetryDue(() => this.pump());
  }

  // ── snapshot ──────────────────────────────────────────────────────────────

  /**
   * Make the database agree with reality, once, at startup.
   *
   * Everything Conductor knows is in SQLite, so a restart remembers projects, jobs,
   * agents, transcripts, open requests, session rules and spend. What it cannot remember
   * is PROCESSES, and one kind of row lies about one:
   *
   * An agent left `working` with no runner. A graceful stop leaves one on purpose: the
   * `onClose` hook interrupts every runner and `#settle` leaves their status alone. On a
   * hard kill — `kill -9`,
   * an OOM, a reboot, a closed lid — the row survives untouched and claims to be working
   * forever: `pump()` only ever picks up `queued`, so nothing resumes it, and `isLive` is
   * false, so nothing else notices either. A phantom working agent, in the one status the
   * whole product reads as "leave it alone". `docs/MANUAL.md` has promised since I1 that
   * "agents mid-work are stopped and resumable"; this is what makes that true.
   *
   * MUST RUN AFTER `arbiter().recoverOrphans()`, which re-labels held requests as parked
   * and moves their agents to `blocked`. An agent that was working *and* owed an answer is
   * that track's to fix; by the time this runs its status is already `blocked`, so this
   * leaves it alone. Running in the other order would pause an agent that is answerable.
   *
   * Idempotent, and a no-op on a clean start.
   *
   * RESUMED, NOT PAUSED (Amendment 53). It used to pause them, and you pressed resume on
   * each. Now they are queued with their sessions, so `pump()` resumes them — into free
   * slots, within their budgets, like any queued agent — and each is told the restart
   * happened (`RESTART_NUDGE`). One with no session yet starts from its prompt.
   */
  reconcile(): number {
    let fixed = 0;
    for (const agent of listAgents(this.#db)) {
      if (agent.status !== 'working' || this.#runners.has(agent.id)) continue;
      setAgentStatus(this.#db, agent.id, 'queued');
      this.#restarted.add(agent.id);
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
        { kind: 'status', status: 'queued', error: 'the daemon restarted mid-run — resuming it' },
      );
      fixed += 1;
    }
    // One that was waiting to be tried again (Amendment 123) is queued with its session, and
    // pump() resumes it. The wait and its count are gone with the process, so it carries on as
    // an agent a restart interrupted does: told so, and with five tries again if it fails.
    for (const agent of listAgents(this.#db)) {
      if (agent.status !== 'queued' || !agent.sdkSessionId || this.#restarted.has(agent.id)) continue;
      const last = eventLog().forAgent(agent.id).filter((e) => e.payload.kind === 'status').at(-1);
      if (last?.payload.kind === 'status' && last.payload.status === 'queued' && last.payload.retry) {
        this.#restarted.add(agent.id);
      }
    }
    if (fixed > 0) {
      console.log(`[supervisor] reconciled ${fixed} agent(s) left working by a hard stop`);
    }
    // Queued behind a stopped or deleted agent by a build from before Amendment 88: paused
    // with the reason, rather than left waiting for good or started unasked.
    this.#strand(null);
    return fixed;
  }

  register(): void {
    // A new limit applies at once: a raised one starts what was waiting for a slot.
    onSettingsChanged((changed) => {
      // A new budget ceiling (Amendment 140): the warnings and stops are read again, and a job
      // whose agents were held at the old one may start. Nothing paused is woken by it, as
      // raising a budget wakes nothing.
      if (changed.includes(BUDGET_CEILING_KEY)) {
        budgetChanged();
        this.pump();
      }
      if (!changed.includes(SLOTS_KEY)) return;
      this.#pushSlots();
      this.pump();
    });
    registerSnapshotContributor((): Partial<Snapshot> => ({
      projects: listProjects(this.#db),
      jobs: listJobs(this.#db),
      agents: listAgents(this.#db),
      pending: arbiter().pending(),
      slots: this.slots,
      // Today's spend, the fleet's all-time total and each project's pair (Amendment 146).
      ...spendFigures(this.#db),
    }));
  }

  #pushEntities(o: { jobs?: Job[]; agents?: Agent[] }): void {
    hub().broadcast({ type: 'entities', ...o });
  }

  // ── projects ──────────────────────────────────────────────────────────────

  /**
   * Register a directory as a project.
   *
   * `existing: true` means the path was already registered and this returned the row
   * that holds it instead of making a second one. That answer USED TO BE
   * indistinguishable from a fresh create, and the silence was a real bug: adding a
   * folder you already had selected the old project, so the picker appeared to fill
   * itself with the wrong directory and nothing said why (Amendment 26). Dedupe is
   * still right — `projects.path` is UNIQUE — but it has to be reported.
   */
  async createProject(
    path: string,
    name?: string,
    dirs: string[] = [],
  ): Promise<{ project: Project; existing: boolean }> {
    // `~` and bare names read the way the completion list offered them (Amendment 45).
    const abs = resolve(expandPath(path.trim()));
    if (!existsSync(abs)) throw new Error(`no such directory: ${abs}`);

    // Every referenced folder is checked before anything is written: one bad path
    // refuses the project, rather than leaving it created with half its folders.
    const referenced: string[] = [];
    for (const d of dirs) {
      if (typeof d !== 'string' || !d.trim()) continue;
      const r = resolve(expandPath(d.trim()));
      let isDir = false;
      try {
        isDir = statSync(r).isDirectory();
      } catch {
        throw new Error(`no such directory: ${r}`);
      }
      if (!isDir) throw new Error(`${r} is a file, not a directory`);
      if (r !== abs && !referenced.includes(r)) referenced.push(r);
    }

    // An existing project is reported, never changed: its folders are edited on its
    // card, not by trying to create it again.
    const existing = getProjectByPath(this.#db, abs);
    if (existing) return { project: existing, existing: true };

    let defaultBranch = 'main';
    try {
      const { stdout } = await exec('git', ['-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD']);
      defaultBranch = stdout.trim() || 'main';
    } catch {
      // Not a git repo, or an empty one. `in_place` still works.
    }

    const inserted = insertProject(this.#db, {
      path: abs,
      name: name?.trim() || abs.split('/').filter(Boolean).pop() || abs,
      defaultBranch,
    });
    for (const r of referenced) addProjectDir(this.#db, inserted.id, r);
    const project = referenced.length > 0 ? getProject(this.#db, inserted.id)! : inserted;
    hub().broadcast({ type: 'entities', projects: [project] });
    return { project, existing: false };
  }

  /**
   * Edit a project's name and/or path. Bookkeeping only — no file moves.
   *
   * The path check is the same one `createProject` runs, for the same reason: a
   * project pointing at a directory that does not exist fails later, at launch,
   * with a message about git rather than about the path. Catching it here means
   * the edit is refused while the human is still looking at the field.
   *
   * Uniqueness is enforced because `projects.path` is `UNIQUE` — without this the
   * UPDATE throws a raw SQLITE_CONSTRAINT, which reaches the user as a stack
   * trace instead of "you already have a project there".
   */
  async editProject(
    projectId: string,
    patch: { name?: string; path?: string },
  ): Promise<ReturnType<typeof updateProject>> {
    const current = getProject(this.#db, projectId);
    if (!current) return undefined;

    let path: string | undefined;
    if (patch.path !== undefined && patch.path.trim().length > 0) {
      path = resolve(patch.path.trim());
      if (!existsSync(path)) throw new Error(`no such directory: ${path}`);
      const clash = getProjectByPath(this.#db, path);
      if (clash && clash.id !== projectId) {
        throw new Error(`${clash.name} already points at that directory`);
      }
    }

    // Made the first directory: it is not also one of the others (Amendment 39).
    if (path !== undefined) removeProjectDir(this.#db, projectId, path);
    const project = updateProject(this.#db, projectId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(path !== undefined ? { path } : {}),
    });
    if (project) hub().broadcast({ type: 'entities', projects: [project] });
    return project;
  }

  /**
   * Add a directory to a project (Amendment 39). Bookkeeping only — nothing is created,
   * copied or moved. Its agents can reach it from their next run, and the Files screen
   * shows it. Adding one the project already has is not an error; it says `existing`.
   */
  addProjectDir(projectId: string, path: string): { project: Project; existing: boolean } | undefined {
    const project = getProject(this.#db, projectId);
    if (!project) return undefined;
    // Read the way the completion list offered it: `~` is home, and so is a bare name.
    const abs = resolve(expandPath(path.trim()));
    let dir = false;
    try {
      dir = statSync(abs).isDirectory();
    } catch {
      throw new Error(`no such directory: ${abs}`);
    }
    if (!dir) throw new Error(`${abs} is a file, not a directory`);
    const existing = abs === project.path || (project.extraDirs ?? []).includes(abs);
    if (!existing) addProjectDir(this.#db, projectId, abs);
    const next = getProject(this.#db, projectId)!;
    if (!existing) hub().broadcast({ type: 'entities', projects: [next] });
    return { project: next, existing };
  }

  /**
   * Forget one of a project's directories. **Touches no files** — the directory and
   * everything in it stay exactly where they are; Conductor just stops showing it and
   * its agents stop being given it. The first directory can't be removed this way: it
   * is where the project's jobs start. Edit the project's path instead.
   */
  removeProjectDir(projectId: string, path: string): Project | undefined {
    const project = getProject(this.#db, projectId);
    if (!project) return undefined;
    if (path === project.path) {
      throw new Error("that is the project's first directory — change the project's path instead");
    }
    if (!removeProjectDir(this.#db, projectId, path)) throw new Error(`the project has no directory ${path}`);
    const next = getProject(this.#db, projectId)!;
    hub().broadcast({ type: 'entities', projects: [next] });
    return next;
  }

  /**
   * What an agent can reach besides its worktree: the project's other directories that
   * are still there. One that has gone is left out rather than failing the run — the
   * agent can still do the work that doesn't need it.
   */
  #reachable(projectId: string, worktreePath: string): string[] {
    return projectDirs(this.#db, projectId).filter((d) => d !== worktreePath && existsSync(d));
  }

  /**
   * Remove a project from Conductor. **Deletes bookkeeping; touches no files.**
   *
   * The whole feature is that boundary, so it is worth being explicit about both
   * sides of it. Gone: the project row and everything cascading off it (jobs,
   * agents, requests, session rules, run history), Track C's workspace rows and
   * file-change projection, Track D's dev-server rows and captured console.
   * Untouched: every file, every worktree directory under `.conductor/wt`, every
   * branch an agent created, the event log, and today's spend.
   *
   * Refuses while a process is alive. A running agent holds an SDK session, a
   * slot and a worktree; deleting its rows underneath it would leave a process
   * writing to a job the daemon can no longer describe. Stopping it is a
   * decision with consequences of its own, so it stays the human's — this only
   * says which agents are in the way.
   *
   * The cascade is emphatically not `close()`/`WorktreeMgr.remove()`, which
   * delete the worktree directory. See `WorkspaceService.forget`.
   */
  async deleteProject(projectId: string): Promise<ProjectRemoval> {
    const project = getProject(this.#db, projectId);
    if (!project) throw new Error(`no such project ${projectId}`);

    const jobs = jobsForProject(this.#db, projectId);
    const agents = listAgents(this.#db).filter((a) => a.projectId === projectId);

    // `#active` is the honest test, not `status`: a row saying 'working' after a
    // daemon restart is stale bookkeeping with no process behind it, and
    // refusing on it would make a dead project unremovable.
    const busy = agents.filter((a) => this.#active.has(a.id) || this.isLive(a.id));
    if (busy.length > 0) throw new ProjectBusyError(busy.map((a) => a.role));

    // Held promises and staged decisions live in memory, so the cascade cannot
    // reach them. Without this, answering a queued request for a project that no
    // longer exists would resolve a tool call for an agent row that is gone.
    for (const agent of agents) {
      arbiter().cancelForAgent(agent.id, 'project removed from Conductor');
      this.#resumeWanted.delete(agent.id);
    }

    terminals().closeProject(projectId); // the Terminal dock's shells, in its folder (Amendment 141)
    const keptOnDisk: string[] = [];
    for (const job of jobs) {
      terminals().closeJob(job.id); // Amendment 112
      const { path } = await workspace().forget(job.id);
      keptOnDisk.push(path ?? job.worktreePath);
      // Track D may not be initialised in a harness that builds only some
      // routes; a project still has to be removable there.
      try {
        preview().registry.forgetJob(job.id);
        preview().console.clear(job.id);
      } catch (err) {
        console.warn(`[supervisor] preview cleanup skipped for ${job.id}`, err);
      }
    }

    deleteProject(this.#db, projectId);

    /*
     * Workspaces whose job row is already gone.
     *
     * The loop above only reaches jobs the project still has, so a job removed earlier
     * left its `workspaces` row behind — and Track C republishes any such row as a
     * synthetic job and project, which then survives the project removal and cannot be
     * removed by anything. Sweeping by PROJECT rather than by job is what closes that
     * door for good; the loop above remains because it is the only thing that can report
     * `keptOnDisk` honestly.
     *
     * Removed workspaces are swept too (`forgetProject`, not `list()`), or a workspace
     * closed before the project was removed outlives it. Only a worktree that `close()`
     * actually deleted is left out of `keptOnDisk` — anything else is still on disk.
     */
    for (const ws of await workspace().forgetProject(projectId)) {
      if (ws.removedAt && ws.isolation === 'worktree') continue;
      if (!keptOnDisk.includes(ws.path)) keptOnDisk.push(ws.path);
    }

    // No frame describes a deletion, and inventing one would mean editing the
    // frozen wire contract for a case `resync` already covers: the client
    // refetches the snapshot and the project is simply not in it. Every
    // connected browser converges, not just the one that clicked.
    hub().broadcast({ type: 'resync' });

    return {
      projectId,
      name: project.name,
      path: project.path,
      jobs: jobs.length,
      agents: agents.length,
      keptOnDisk: [...new Set(keptOnDisk)],
    };
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async createJob(req: CreateJobRequest): Promise<CreateJobResponse> {
    const project = getProject(this.#db, req.projectId);
    if (!project) throw new Error(`no such project ${req.projectId}`);
    if (!req.prompt?.trim()) throw new Error('prompt is required');
    if (!req.agents?.length) throw new Error('at least one agent is required');

    const jobId = newId('job');

    // Isolation belongs to Track C's WorkspaceService. Called in-process, not
    // over its bootstrap HTTP endpoints, and it handles all three isolations —
    // including 'in_place', where it returns the repo root and still attaches
    // the watcher. It emits the `worktree` event itself, so this must not.
    //
    // Methodology (2), a branch you name (Amendment 115): only a worktree can be on one, and
    // a refusal (an invalid name 400, the default branch or one checked out elsewhere 409)
    // goes up as it is, so the route can answer with its status instead of a 400 for all.
    if (req.branch !== undefined && req.isolation !== 'worktree') {
      throw new LaunchBranchError(400, 'a branch can only be named for a worktree: it is the only isolation on a branch of its own');
    }
    let worktreePath: string;
    let branch: string;
    try {
      const ws = await workspace().open({
        jobId,
        projectId: project.id,
        repoPath: project.path,
        isolation: req.isolation,
        ...(req.branch !== undefined
          ? {
              branch: req.branch,
              named: true,
              recordedDefault: { branch: project.defaultBranch, chosen: defaultBranchIsSet(this.#db, project.id) },
            }
          : {}),
      });
      worktreePath = ws.path;
      branch = ws.branch;
    } catch (err) {
      if (err instanceof LaunchBranchError) throw err;
      throw new Error(`could not prepare a ${req.isolation} workspace: ${String(err)}`);
    }

    const job = insertJob(this.#db, {
      id: jobId,
      projectId: project.id,
      prompt: req.prompt.trim(),
      isolation: req.isolation,
      worktreePath,
      branch,
      status: 'queued',
      budgetUsd: req.budgetUsd ?? null,
    });

    // Roles resolve to ids in one pass so dependsOnRoles can point at siblings.
    const idByRole = new Map<string, string>();
    for (const spec of req.agents) idByRole.set(spec.role, newId('agt'));

    const agents: Agent[] = [];
    for (const spec of req.agents) {
      const id = idByRole.get(spec.role)!;
      const dependsOn = (spec.dependsOnRoles ?? [])
        .map((role) => idByRole.get(role))
        .filter((x): x is string => Boolean(x) && x !== id);

      agents.push(insertAgent(this.#db, agentRow(spec, { id, jobId, projectId: project.id, dependsOn })));
    }

    eventLog().emit(
      { projectId: project.id, jobId, agentId: null },
      { kind: 'status', status: 'queued' },
    );

    for (const a of agents) {
      eventLog().emit(
        { projectId: project.id, jobId, agentId: a.id },
        { kind: 'status', status: 'queued' },
      );
    }

    this.#pushEntities({ jobs: [job], agents });
    this.pump();
    return { job, agents };
  }

  /**
   * One more agent in a job that is running, or has finished (ADR 0002, Amendment 89).
   * The spec has been checked as a launch's is (routes/session.ts); this checks it against
   * the job. `feeds` are roles of agents that haven't started, which now wait for this one
   * as well — inserting it in the middle.
   *
   * Then as `startHelper` does: queued, the job reopened, every tab told, and `pump()`. Its
   * cap is one more agent's, so the job's cap — the sum of its agents' — grows by it.
   */
  addAgent(jobId: string, spec: AgentSpec, feeds: readonly string[] = []): { agent: Agent; fed: Agent[] } {
    const job = getJob(this.#db, jobId);
    if (!job) throw new Error(`no such job ${jobId}`);
    const siblings = agentsForJob(this.#db, jobId);
    const byRole = new Map(siblings.map((a) => [a.role, a]));

    if (byRole.has(spec.role)) {
      throw new Error(`${spec.role} is already in this job — agents wait for each other by role, so each role is there once`);
    }
    const dependsOn: string[] = [];
    for (const role of spec.dependsOnRoles ?? []) {
      const dep = byRole.get(role);
      if (!dep) throw new Error(`${spec.role} waits for ${role}, which is not in this job`);
      if (dep.status === 'stopped') throw new Error(`${spec.role} can't wait for ${role}: it was stopped, so it won't finish`);
      if (!dependsOn.includes(dep.id)) dependsOn.push(dep.id);
    }
    const fed: Agent[] = [];
    for (const role of feeds) {
      const f = byRole.get(role);
      if (!f) throw new Error(`${spec.role} feeds ${role}, which is not in this job`);
      if (f.parentId) throw new Error(`${role} is a helper: its orchestrator decides when it runs`);
      if (f.status !== 'queued' || f.sdkSessionId !== null) {
        throw new Error(`${role} has already started, so it can't be made to wait for ${spec.role}`);
      }
      if (!fed.includes(f)) fed.push(f);
    }
    if (createsCycle(siblings, dependsOn, fed.map((f) => f.id))) {
      throw new Error(`${spec.role} would wait for an agent that waits for it — a loop that nothing in it could start`);
    }

    // One engine per job, as Spawn launches it (Amendment 80).
    const provider = spec.provider ?? 'claude';
    const engines = new Set(siblings.filter((a) => !a.parentId).map((a) => a.provider ?? 'claude'));
    if (engines.size > 0 && !engines.has(provider)) {
      throw new Error(`this job runs on ${[...engines].join(' and ')}, so ${spec.role} must too, not ${provider}`);
    }
    if (spec.autonomy.budgetUsd === null && (spec.autonomy.budgetTokens ?? null) === null) {
      throw new Error(`${spec.role} needs a budget of its own — a cap per agent, as Spawn sets one`);
    }
    const readOnly = readOnlyRefusal(spec.role, spec.autonomy);
    if (readOnly) throw new Error(readOnly);

    const agent = insertAgent(this.#db, agentRow(spec, { id: newId('agt'), jobId, projectId: job.projectId, dependsOn }));
    for (const f of fed) setAgentDependsOn(this.#db, f.id, [...f.dependsOn, agent.id]);
    eventLog().emit(
      { projectId: agent.projectId, jobId, agentId: agent.id },
      { kind: 'status', status: 'queued' },
    );
    this.#reopenJob(jobId);
    const fedNow = fed.map((f) => getAgent(this.#db, f.id)!);
    this.#pushEntities({ agents: [agent, ...fedNow] });
    this.pump();
    // Behind something that can't move without you, it changes nothing: settled again.
    this.#rollUpJob(jobId);
    return { agent: getAgent(this.#db, agent.id) ?? agent, fed: fedNow };
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  /**
   * Start every agent that is eligible and fits in a slot. Called after any
   * state change; cheap enough to be unconditional.
   */
  pump(): void {
    // Everything is paused until a time (Amendment 111): nothing starts by itself.
    if (this.#hold) return;
    for (const agent of listAgents(this.#db)) {
      if (agent.status !== 'queued') continue;
      // Waiting for the model to come back (Amendment 123): it frees its slot while it waits
      // and starts when its time comes, like any queued agent.
      if (retryBook().waiting(agent.id)) continue;
      if (this.#slotsUsed() >= slotLimit()) return;
      if (this.#active.has(agent.id)) continue;
      if (this.#halting.has(agent.jobId)) continue;
      if (!this.#depsSatisfied(agent)) continue;

      const job = getJob(this.#db, agent.jobId);
      if (!job || job.status === 'paused' || job.status === 'failed') continue;
      if (this.#overBudget(job)) {
        this.#pause(agent.id, JOB_BUDGET_NOTE);
        continue;
      }

      /*
       * With its session, when it has one. A queued agent with a session is one that
       * was answered while every slot was taken (`resumeParked`), and launching it
       * fresh — which this used to — started a new session from the job prompt and
       * lost the whole conversation.
       */
      void this.#launch(agent.id, agent.sdkSessionId).catch((err) => console.error(`[supervisor] ${agent.id} launch threw`, err));
    }
  }

  #depsSatisfied(agent: Agent): boolean {
    for (const id of agent.dependsOn) {
      const dep = getAgent(this.#db, id);
      // Removed (Amendment 88). Its dependants that hadn't started were pointed elsewhere;
      // one that had, passed this gate already — an orchestrator whose helper was removed.
      if (!dep) {
        if (agent.sdkSessionId) continue;
        return false;
      }
      // A helper that failed or was stopped has still ended: its orchestrator is told
      // how, rather than waiting for it forever (Amendment 51).
      const ended = dep.parentId === agent.id && (dep.status === 'failed' || dep.status === 'stopped');
      if (dep.status !== 'done' && !ended) return false;
      // Done, but it ended its turn without handing off: they wait for a person to (Amendment 104).
      if (dep.status === 'done' && getHandoff(this.#db, dep.id).held) return false;
    }
    return true;
  }

  /**
   * What a queued agent that hasn't started waits on that will never finish: an agent that
   * was stopped (not its own helper, Amendment 51), or one whose row is gone. Null when
   * there is none. Its role, or null for a row that is gone.
   */
  #strandedBy(agent: Agent): { role: string | null } | null {
    for (const id of agent.dependsOn) {
      const dep = getAgent(this.#db, id);
      if (!dep) return { role: null };
      if (dep.status === 'stopped' && dep.parentId !== agent.id) return { role: dep.role };
    }
    return null;
  }

  /**
   * Pause every queued agent that hasn't started and waits on a stopped or removed one
   * (Amendment 88), in one job or, with null, in all of them. Paused, not started: nothing
   * spends money until you say so. Paused, not left queued: queued, it waited for good and
   * its job never settled. Resuming it runs it without that one.
   */
  #strand(jobId: string | null): void {
    const agents = jobId === null ? listAgents(this.#db) : agentsForJob(this.#db, jobId);
    for (const a of agents) {
      if (a.status !== 'queued' || a.sdkSessionId !== null) continue;
      const by = this.#strandedBy(a);
      if (by) this.#pause(a.id, strandNote(by.role));
    }
  }

  /**
   * At the job's CEILING: twice the sum of the agents' CURRENT budgets, not `job.budgetUsd`,
   * which stays the figure Spawn launched with. Comparing against that meant raising one
   * agent's budget still left its queued siblings paused at the old total. Between the sum
   * and twice it, the job is over its budget and only warned (Amendment 124): see Alerts.
   * Against what its agents spent TODAY, so it is under again at midnight (Amendment 129).
   */
  #overBudget(job: Job): boolean {
    return jobBudgetState(agentsForJob(this.#db, job.id), jobCostToday(this.#db, job.id)) === 'ceiling';
  }

  /**
   * The day changed (Amendment 129; `onDayTurn`, from the watch of Amendment 103). Budgets are
   * per day, so every agent's reads from zero now. This does four things:
   *  • an agent paused ONLY by its budget, at its ceiling or held for its job's, is CONTINUED,
   *    as ▶ resume continues it, and told so (Amendment 140, Q4 of wave 10; `#newDayFor`). Not
   *    a pause you made, a failure, or any other note. With `conductor.budgetResumeAtMidnight`
   *    off it stays paused instead, its pause rewritten to say its budget is renewed and that
   *    continue needs no raise (`renewals`, which was all Amendment 129 did);
   *  • every agent that spent anything yesterday is pushed afresh, so an open page redraws its
   *    bar at zero (the page also reads a stale day stamp as zero by itself);
   *  • the alerts are checked again, so the "over budget" warnings of yesterday clear;
   *  • pump(), within the slots, the job's budget and a pause of everything.
   * Returns how many pauses were continued or rewritten.
   */
  newDay(day: string, was: string): number {
    const paused = listAgents(this.#db)
      .filter((a) => a.status === 'paused')
      .map((agent) => this.#pausedForBudget(agent));
    const changed = this.#newDayFor(paused, day);

    const fresh = agentsThatSpentOn(this.#db, was)
      .filter((id) => !changed.has(id))
      .flatMap((id) => getAgent(this.#db, id) ?? []);
    if (fresh.length > 0) {
      try {
        this.#pushEntities({ agents: fresh });
      } catch {
        // No hub outside the daemon. Not fatal.
      }
    }
    budgetChanged();
    // A queued agent that was waiting on the job's figure goes, if the new day's figure allows it.
    this.pump();
    return changed.size;
  }

  /**
   * At start (Amendment 140): a daemon that was down at midnight saw no day turn, so a budget
   * pause written on an earlier day than today (`lastStatusDay`) is given what the turn would
   * have given it: continued, or with the setting off renewed. Amendment 129 left these as
   * they were until the next midnight. Run after the scheduler has put back a pause of
   * everything (routes/session.ts), so a continued agent waits for that as any queued one.
   * Returns how many pauses were continued or rewritten.
   */
  catchUpDay(): number {
    const today = localDay();
    const paused = listAgents(this.#db)
      .filter((a) => a.status === 'paused')
      .filter((a) => {
        const day = lastStatusDay(this.#db, a.id);
        return day !== null && day < today;
      })
      .map((agent) => this.#pausedForBudget(agent));
    const changed = this.#newDayFor(paused, today);
    if (changed.size > 0) {
      budgetChanged();
      console.log(`[supervisor] the day changed while the daemon was down: ${changed.size} budget pause(s) brought up to ${today}`);
    }
    return changed.size;
  }

  #pausedForBudget(agent: Agent): PausedForBudget {
    const job = getJob(this.#db, agent.jobId);
    return { agent, note: lastStatusNote(this.#db, agent.id) ?? undefined, jobAtCeiling: job !== undefined && this.#overBudget(job) };
  }

  /**
   * What a new day does to the budget pauses in `paused` (Amendment 140): with the setting on,
   * continues the ones only a budget paused and that have room today (`continuations`), each
   * queued as ▶ resume queues it, with `newDayNote` on its status and `NEW_DAY_NUDGE` for its
   * model. Queued, so the slots, the job's budget and a pause of everything (`#hold`, which
   * starts nothing until it ends) still decide when it runs. The rest, and all of them with the
   * setting off, are rewritten as renewed (`renewals`). Returns the agents it changed.
   */
  #newDayFor(paused: readonly PausedForBudget[], day: string): Set<string> {
    const changed = new Set<string>();
    if (resumeAtMidnight()) {
      for (const id of continuations(paused, day)) {
        const agent = getAgent(this.#db, id);
        if (!agent || agent.status !== 'paused') continue;
        if (agent.sdkSessionId) this.#newDayRuns.add(id);
        try {
          this.resumeAgent(id, newDayNote(day));
          changed.add(id);
        } catch (err) {
          this.#newDayRuns.delete(id);
          if (!(err instanceof BudgetReachedError)) throw err;
        }
      }
    }
    const rewrites = renewals(paused.filter((p) => !changed.has(p.agent.id)), day);
    for (const r of rewrites) {
      this.#pause(r.agentId, r.note);
      changed.add(r.agentId);
    }
    return changed;
  }

  #pause(agentId: string, note: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    // A pause of any kind ends the bout of waiting for the model (Amendment 123).
    this.#forgetRetries(agentId);
    // And whatever the new day's continue was going to tell it (Amendment 140).
    this.#newDayRuns.delete(agentId);
    setAgentStatus(this.#db, agentId, 'paused');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      { kind: 'status', status: 'paused', error: note },
    );
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
  }

  #autonomyFor(agentId: string): Autonomy {
    return getAgent(this.#db, agentId)?.autonomy ?? DEFAULT_AUTONOMY;
  }

  /**
   * What the agents before this one may take up of its prompt, in characters: a quarter of its
   * model's window, the real one where its engine has said (OpenRouter's `context_length`,
   * Copilot's and the gateway's lists, Amendment 120), else the floor in handoff.ts.
   */
  #handoffCapOf(agent: Agent): number {
    return handoffCap(agent.model, reportedWindow(getAgentProvider(this.#db, agent.id), agent.model));
  }

  /**
   * The prompt one agent sees: the job instruction, which is first and outside any cap,
   * what the agents it waited for did and said (Amendments 37, 101) with the summary each
   * handed off with on top (Amendment 104), for an agent in a stack how to ask (Amendment
   * 100) and, if agents wait for it, to hand off (Amendment 104), and its own brief — last,
   * so "the work described above" and "the root cause the debugger identified" both have
   * something above them.
   */
  #promptFor(agentId: string): string {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return '';
    const job = getJob(this.#db, agent.jobId);
    const brief = getAgentBrief(this.#db, agentId);
    // Each one's whole conversation as text (Amendment 101), not only its last reply.
    const heard = (id: string, role: string): Upstream => ({
      role,
      reply: eventLog().lastText(id),
      turns: turnsFromEvents(eventLog().conversation(id), job?.prompt ?? ''),
      // What it said about its own work when it handed off, on top of the conversation (Amendment 104).
      ...this.#summaryOf(id),
    });
    const wentWithout = getWentWithout(this.#db, agentId);
    const upstream: Upstream[] = [
      // Those further up, by their summaries, oldest first.
      ...this.#furtherUp(agent),
      ...agent.dependsOn.flatMap((id) => {
        const dep = getAgent(this.#db, id);
        return dep ? [heard(id, dep.role)] : [];
      }),
      // Ones you started it without (Amendment 88): what they said, marked stopped.
      ...wentWithout.map((w) => ({ ...heard(w.id, w.role), status: 'stopped' })),
    ];
    // About a quarter of this agent's model's window, shared by those it waited for.
    const handoff = handoffSection(upstream, this.#handoffCapOf(agent));
    // In a stack, it asks with the question tool, which holds it in Needs You (Amendment 100).
    const ask = stackLine(inStack(agentId, agentsForJob(this.#db, agent.jobId), wentWithout.length));
    // And one that others wait for is told to hand off, since they do not start until it does (Amendment 104).
    const hand = handOffLine(this.#hasWaiters(agent));
    const parts = [job?.prompt ?? ''];
    if (handoff) parts.push(`\n${handoff}`);
    if (ask) parts.push(`\n${ask}`);
    if (hand) parts.push(`\n${hand}`);
    if (brief?.trim()) parts.push(`\nYour role is ${agent.role}. ${brief.trim()}`);
    if (agent.helperCap) {
      // A pipeline is run one step at a time, not split into parallel parts (Amendment 128).
      const roles = this.#rolesScope(agent).roles;
      parts.push(`\n${roles ? pipelineSection(agent.role, agent.helperCap, roles, SEND_BACKS_MAX) : orchestratorSection(agent.role, agent.helperCap)}`);
    }
    return parts.join('\n').trim();
  }

  async #launch(agentId: string, resumeFrom?: string | null): Promise<void> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    const job = getJob(this.#db, agent.jobId);
    if (!job) return;

    // At its ceiling (twice its budget, Amendment 124): stop here and say so, rather than
    // start a run the SDK would end on its first turn. Reached from pump() and from
    // answering a parked request. Over the budget but under the ceiling it runs.
    if (budgetRefusal(agent)) {
      this.#pause(agentId, budgetNote(agent));
      return;
    }
    // Its folder is gone: failed with the reason, rather than a launch error (Amendment 114).
    if (this.#refuseGone(agentId, job)) return;

    // Started by pump when its wait ended, or by something else first: either way no longer waiting.
    retryBook().cancel(agentId);
    this.#active.add(agentId);
    this.#pushSlots();

    let outcome;
    const began = Date.now();
    // From the slot being taken, not from the run: whatever throws before the run begins
    // ends it as a failed launch and gives the slot back (Amendment 149).
    try {
      this.#openRun(agent);
      setAgentStatus(this.#db, agentId, 'working');
      // Queued, or settled while this one waited for you (Amendment 88): it is working now.
      if (job.status !== 'working') setJobStatus(this.#db, job.id, 'working');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'working' },
      );
      this.#pushEntities({ agents: [getAgent(this.#db, agentId)!], jobs: [getJob(this.#db, job.id)!] });

      // On the engine it was spawned on, which never changes: its session id is that
      // engine's, and no other's (Amendment 74).
      const runner = createBackend(getAgentProvider(this.#db, agentId), this.#db, {
        agentId,
        jobId: agent.jobId,
        projectId: agent.projectId,
        worktreePath: job.worktreePath,
        extraDirs: this.#reachable(agent.projectId, job.worktreePath),
        helperCap: agent.helperCap ?? 0,
        handOff: this.#hasWaiters(agent),
        ...this.#rolesScope(agent),
        model: agent.model,
        autonomy: this.#autonomyFor(agentId),
        spentUsd: agent.costUsd,
        // What its persona gave it at launch, on this run and every resume (Amendment 68).
        ...personaScope(getAgentPersona(this.#db, agentId)),
      });
      this.#runners.set(agentId, runner);

      const resuming = resumeFrom !== undefined && resumeFrom !== null;
      // A resume prompt is ours, not the human's: shown as `auto`, and not sent again
      // if the run has to be moved past a call it can't make.
      outcome = await runner.run({
        prompt: resuming ? this.#resumePrompt(agentId) : this.#promptFor(agentId),
        resume: resumeFrom ?? null,
        synthetic: resuming,
      });
    } catch (err) {
      outcome = {
        sessionId: null,
        terminalReason: 'launch_failed',
        deferredTool: null,
        isError: true,
        // On the one failed status #settle writes. This used to be a second one, before
        // it, which Needs You never saw: it reads the last.
        errorDetail: thrown(err),
        costUsd: 0,
      };
      console.error(`[supervisor] ${agentId} failed to launch`, err);
    } finally {
      this.#active.delete(agentId);
      this.#pushSlots();
      this.#runners.delete(agentId);
    }

    // Counted for the Metrics tab (Amendment 122); whether it failed is `#settle`'s to say.
    recordRunEnd(this.#db, agentId, Date.now() - began);
    this.#settle(agentId, outcome);

    // A decision that landed while this run was still unwinding.
    if (this.#resumeWanted.delete(agentId)) {
      const fresh = getAgent(this.#db, agentId);
      if (fresh?.sdkSessionId) {
        void this.#launch(agentId, fresh.sdkSessionId).catch((err) => console.error(`[supervisor] ${agentId} launch threw`, err));
        return;
      }
    }
    this.pump();
  }

  /**
   * A park that came from `defer` re-offers its call on resume with no prompt at
   * all (spike: 678 ms, no extra turn), so sending one would only invite the
   * model to reconsider. A park that came from interrupt() does NOT re-offer, so
   * it needs a nudge — and the nudge has to say what was decided, or the model
   * has no reason to believe retrying is wanted.
   */
  #resumePrompt(agentId: string): string {
    // Re-run from here (Amendment 102). First: its input changed, and that outranks a
    // question it was parked on, which `rerunFrom` has already cancelled.
    const rerun = this.#takeRerunNote(agentId);
    if (rerun) return rerun;

    if (lastDeferredTool(this.#db, agentId)) return '';

    // An orchestrator woken because its helpers finished: what they said (Amendment 51).
    const report = this.#takeHelperReport(agentId);
    if (report) return report;

    // Resumed on its own after a restart interrupted it (Amendment 53). Before a retry's words:
    // an agent that was waiting for the model when the daemon stopped is told the restart.
    if (this.#restarted.delete(agentId) && !arbiter().stagedFor(agentId)) {
      this.#restartRuns.add(agentId);
      return RESTART_NUDGE;
    }

    // Tried again after the model couldn't be reached (Amendment 123).
    if (this.#retryRuns.has(agentId) && !arbiter().stagedFor(agentId)) return RETRY_NUDGE;

    // Continued by the new day after its budget paused it (Amendment 140).
    if (this.#newDayRuns.delete(agentId) && !arbiter().stagedFor(agentId)) return NEW_DAY_NUDGE;

    const staged = arbiter().stagedFor(agentId);
    if (!staged) {
      // Queued with its session and nothing answered: woken from a pause while every
      // slot was taken. Told a call was decided, it went looking for one (Amendment 35).
      return answeredSinceLastRun(this.#db, agentId) ? RESUME_NUDGE : WAKE_NUDGE;
    }

    const tool = staged.toolName;
    // A question you answered while it was put aside: say the answers (Amendment 131).
    if (staged.decision.type === 'answer') {
      const request = getRequest(this.#db, staged.requestId);
      return answeredNudge(request?.questions ?? [], staged.decision.answers, staged.decision.response);
    }
    if (staged.decision.type === 'deny') {
      return (
        `Your ${tool} call was declined by the human` +
        `${staged.decision.message ? `: ${staged.decision.message}` : ''}. ` +
        `Do not retry it. Continue with the rest of the task, or stop if nothing else remains.`
      );
    }
    return (
      `Your ${tool} call was approved by the human. Make that exact call again now ` +
      `and carry on from where you stopped.`
    );
  }

  /** Decide what an ended run means for the agent's status. */
  #settle(
    agentId: string,
    outcome: {
      terminalReason: string | null;
      deferredTool: unknown;
      isError: boolean;
      errorDetail?: string | null;
      apiFailure?: ApiFailure | null;
    },
  ): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    // Whether this run began as a restart resume, which is over now whichever way it ended.
    const afterRestart = this.#restartRuns.delete(agentId);
    // And whether it began after a wait for the model (Amendment 123): over too.
    this.#retryRuns.delete(agentId);

    /*
     * A terminated agent's status is final. `terminateAgent` stops the runner and then
     * writes `stopped`, so it normally wins this race by ordering — but `stop()`
     * resolving does not prove the run's own async chain has reached here yet, and a
     * late settle would relabel a killed agent `done`. Cheap guard, and the difference
     * it protects is the difference between "I ended this" and "it finished".
     *
     * A run you paused is the same: whoever stopped it writes its status.
     */
    const byUser = this.#userStopped.delete(agentId);
    if (agent.status === 'stopped') return;
    if (byUser) {
      // Your own stop or pause is never retried (Amendment 123).
      this.#forgetRetries(agentId);
      arbiter().clearStaged(agentId);
      return;
    }

    const open = arbiter().openFor(agentId);
    if (open.length > 0) {
      // Still owed a human answer: parked, not finished. The request row is the
      // durable record, so this survives a daemon restart.
      setAgentStatus(this.#db, agentId, 'blocked', 'parked');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'blocked', blockMode: 'parked' },
      );
      this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
      return;
    }

    // Nothing outstanding, so any staged decision was not consumed by this run
    // (the model chose not to re-issue the call). Drop it rather than let it
    // approve some unrelated call of the same tool later.
    arbiter().clearStaged(agentId);

    /*
     * Out of budget is not broken. Nothing failed: it reached the cap you set, and
     * raising the cap continues the same session. So `paused`, with the reason, and
     * not `failed` — which painted it red and failed its whole job.
     */
    if (outcome.terminalReason === 'budget_exhausted') {
      this.#pause(agentId, budgetNote(getAgent(this.#db, agentId) ?? agent));
      this.#rollUpJob(agent.jobId);
      return;
    }

    /*
     * The model couldn't be reached (Amendment 123). Waiting can help, so instead of `failed`
     * the agent waits for its next try, queued, with its slot freed and its job still live.
     * Anything else ends the bout: failed, done or waiting on helpers all start the count again.
     */
    if (outcome.isError && outcome.terminalReason !== 'aborted_tools' && this.#waitToRetry(agent, outcome)) return;
    this.#forgetRetries(agentId);

    if (outcome.isError && outcome.terminalReason !== 'aborted_tools') {
      setAgentStatus(this.#db, agentId, 'failed');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        {
          kind: 'status',
          status: 'failed',
          error: outcome.terminalReason ?? 'error',
          ...(outcome.errorDetail ? { detail: outcome.errorDetail } : {}),
        },
      );
    } else if (this.#awaitHelpers(agent)) {
      // Ended its turn with helpers it hasn't heard back from: it waits for them, queued,
      // and pump() starts it again — with their replies — once they have all ended.
    } else {
      /*
       * Done — and, when agents are waiting for it and it never said it was ready, held
       * (Amendment 104): still `done`, so nothing about its status changes, but they stay
       * queued and it goes to Needs You as "stopped without handing off". The hold is
       * written before the status event so the alert it raises is there when the event is.
       */
      const held = this.#holdsHandoff(agent);
      // A restart is the likeliest reason it forgot: ask once, itself, before asking you (Amendment 119).
      if (held && afterRestart && this.#askToHandOff(agent)) return;
      setAgentStatus(this.#db, agentId, 'done');
      setHandoff(this.#db, agentId, { summary: getHandoff(this.#db, agentId).summary, held });
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'done', ...(held ? { error: HANDOFF_HELD_NOTE } : {}) },
      );
      // Before the roll-up, so a job whose agent is about to go again isn't finished (Amendment 157).
      this.#sendWhenDone(agent);
    }
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
    this.#rollUpJob(agent.jobId);
  }

  // ── a message queued for when the agent is done (Amendment 157) ───────────

  /** Agents whose turn ended `done` while everything was paused: `release` sends theirs. */
  #owedWhenDone = new Set<string>();

  /**
   * The agent's turn just ended `done`: the oldest message queued for then goes, as if you had
   * pressed send now, which starts its next turn. One per turn: the next waits for that turn
   * to end `done` too. Only `done` sends one: a question, a failure or a pause leave it
   * waiting. While everything is paused it waits for the pause to end (`release`).
   *
   * Refused as `sendMessage` refuses (its budget, its folder gone): the row keeps the reason,
   * like a timed one, and is not tried again. Not where the run is about to be relaunched
   * (`#resumeWanted`) or its job is being stopped, which would be a second run.
   */
  #sendWhenDone(agent: Agent): void {
    if (this.#resumeWanted.has(agent.id) || this.#halting.has(agent.jobId)) return;
    const m = nextWhenDone(this.#db, agent.id);
    if (!m) return;
    if (this.#hold) {
      this.#owedWhenDone.add(agent.id);
      return;
    }
    try {
      this.sendMessage(agent.id, m.text);
      deleteScheduled(this.#db, m.id);
    } catch (err) {
      // No session to take it: it waits for the next `done`, as a timed one waits for a session.
      if (!(err instanceof BudgetReachedError) && /cannot receive messages yet/.test(thrown(err))) return;
      failScheduled(this.#db, m.id, thrown(err));
    }
    broadcastScheduled(this.#db);
  }

  // ── trying again when the model can't be reached (Amendment 123) ──────────

  /** Its waits and its count both go, and the nudge it would have been told. */
  #forgetRetries(agentId: string): void {
    retryBook().forget(agentId);
    this.#retryRuns.delete(agentId);
  }

  /**
   * A run ended in error because the model couldn't be reached: wait for the next try
   * (5 s, 15 s, 30 s, 60 s, 5 min), then resume the agent's own session with RETRY_NUDGE.
   * False when it isn't a failure to wait out, or the fifth try has failed: the caller
   * fails the agent as it always did.
   *
   * The agent is `queued` while it waits, as one is for a slot or after a restart: no new
   * status. Its slot was freed when its run ended; `pump` skips it until its time, then
   * starts it like any queued agent. Its job stays live because a queued agent is not
   * settled. The status event carries the wait, which is what "Reconnecting in 30 s (3 of
   * 5)" is drawn from, on the agent and in Needs You.
   */
  #waitToRetry(
    agent: Agent,
    outcome: { terminalReason: string | null; isError: boolean; errorDetail?: string | null; apiFailure?: ApiFailure | null },
  ): boolean {
    const verdict = decideRetry({
      isError: outcome.isError,
      terminalReason: outcome.terminalReason,
      failure: outcome.apiFailure,
      // A run you ended returned before this.
      userStopped: false,
      used: retryBook().used(agent.id),
    });
    if (!verdict.retry) return false;
    // A job being stopped starts nothing by itself.
    if (this.#halting.has(agent.jobId) || !getJob(this.#db, agent.jobId)) return false;

    const wait = retryBook().wait(verdict, {
      agentId: agent.id,
      projectId: agent.projectId,
      jobId: agent.jobId,
      terminalReason: outcome.terminalReason,
      errorDetail: outcome.errorDetail ?? null,
    });
    this.#retryRuns.add(agent.id);
    setAgentStatus(this.#db, agent.id, 'queued');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
      {
        kind: 'status',
        status: 'queued',
        error: retryNote(wait.cause, wait.attempt, wait.of, wait.delayMs),
        retry: { cause: wait.cause, attempt: wait.attempt, of: wait.of, delayMs: wait.delayMs },
      },
    );
    this.#pushEntities({ agents: [getAgent(this.#db, agent.id)!] });
    return true;
  }

  /**
   * `retry now`: stop waiting and try again at once. The agent is queued, so it starts when a
   * slot is free. Refused, with a sentence, when it is not waiting, or while everything is
   * paused until a time.
   */
  retryNow(agentId: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error('no such agent');
    if (!retryBook().waiting(agentId)) throw new RetryRefusedError(`${agent.role} is not waiting to retry.`);
    if (this.#hold) throw new RetryRefusedError('Everything is paused until the scheduled time, so nothing starts yet.');
    // Fires the same handler as its timer: pump().
    retryBook().now(agentId);
  }

  /**
   * `stop retrying`: give up waiting. The agent ends `failed`, the way the run that failed
   * would have ended it before retries, with the same reason and what the SDK said. Refused,
   * with a sentence, when it is not waiting.
   */
  stopRetrying(agentId: string): Agent {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error('no such agent');
    const wait = retryBook().waiting(agentId);
    if (!wait) throw new RetryRefusedError(`${agent.role} is not waiting to retry.`);
    this.#forgetRetries(agentId);
    setAgentStatus(this.#db, agentId, 'failed');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      {
        kind: 'status',
        status: 'failed',
        error: wait.terminalReason ?? 'error',
        ...(wait.errorDetail ? { detail: wait.errorDetail } : {}),
      },
    );
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
    this.#rollUpJob(agent.jobId);
    return getAgent(this.#db, agentId)!;
  }

  // ── handing off (Amendment 104) ───────────────────────────────────────────

  /**
   * The agents that wait for this one: those its `hand_off` is for (not its orchestrator). A
   * helper has none, whoever is wired to wait for it: its reply goes to the agent that started
   * it, which judges it (Amendment 128), so a helper is never given `hand_off` and is never held.
   */
  #waiters(agent: Agent): Agent[] {
    if (agent.parentId) return [];
    return waitersOf(agent.id, agentsForJob(this.#db, agent.jobId));
  }

  /** Whether agents wait for it, which is what gives it the `hand_off` tool. */
  #hasWaiters(agent: Agent): boolean {
    return this.#waiters(agent).length > 0;
  }

  /** What an agent is given: asked by the MCP endpoint, which answers `tools/list` for one agent. */
  toolAccess(agentId: string): ToolAccess {
    const agent = getAgent(this.#db, agentId);
    return agent ? { helperCap: agent.helperCap ?? 0, handOff: this.#hasWaiters(agent), ...this.#rolesScope(agent) } : {};
  }

  /**
   * The roles an orchestrated stack's orchestrator may start, as its `start_helper` is told
   * them (Amendment 128): `{ roles }`, or nothing for every other agent, so their scope and tool
   * list are what they were.
   */
  #rolesScope(agent: Agent): { roles?: ToolRole[] } {
    if (!agent.pipelineRoles?.length) return {};
    return {
      roles: getHelperRoles(this.#db, agent.id).map((r) => ({
        id: r.id,
        ...(r.tier ? { tier: r.tier } : {}),
        model: r.model,
        ...(helperReads(r) ? { reads: true } : {}),
      })),
    };
  }

  /**
   * The agents further up than the ones this one waits for, as `Upstream`s that carry only their
   * summary, each "via" the role of the one it waits for that leads to it, in the order they ran
   * (`ancestorsOf`). One that never handed off has nothing to pass on and is left out, and so is
   * one it was started without (Amendment 88): it is still reached through another that waited
   * for it, but a first prompt gives it as stopped, and a re-run note does not give it at all.
   */
  #furtherUp(agent: Agent): (Upstream & { id: string })[] {
    const jobAgents = agentsForJob(this.#db, agent.jobId);
    const roleOf = new Map(jobAgents.map((a) => [a.id, a.role]));
    const without = new Set(getWentWithout(this.#db, agent.id).map((w) => w.id));
    return ancestorsOf(jobAgents, agent.id).flatMap(({ id, via }) => {
      const { summary } = this.#summaryOf(id);
      return id !== via && summary && !without.has(id) ? [{ id, role: roleOf.get(id) ?? id, reply: null, summary, via: roleOf.get(via) ?? via }] : [];
    });
  }

  /** `{ summary }` for an `Upstream`, or nothing when it has not handed off. */
  #summaryOf(agentId: string): { summary?: string } {
    const summary = getHandoff(this.#db, agentId).summary;
    return summary ? { summary } : {};
  }

  /**
   * A run begins. An agent that finished and is run again (you wrote to it, or `rerunFrom`)
   * starts without the summary of its last run, which was about work it is now changing, and
   * without the hold: it is working, not waiting to be handed off. One that was only paused,
   * parked or woken keeps its summary: it is the same run carrying on.
   */
  #openRun(agent: Agent): void {
    if (agent.status === 'done') setHandoff(this.#db, agent.id, { summary: null, held: false });
  }

  /**
   * Whether this agent, whose turn just ended, is held rather than handed on: agents are
   * waiting for it that have not run, and it did not call `hand_off` in this run. A chat
   * with an agent whose followers have all run holds nothing, and neither does the last
   * agent in a chain. Held, the agents after it, queued or paused before they began, wait.
   */
  #holdsHandoff(agent: Agent): boolean {
    if (getHandoff(this.#db, agent.id).summary !== null) return false;
    return this.#waiters(agent).some(
      (w) => w.status === 'queued' || (w.status === 'paused' && w.sdkSessionId === null),
    );
  }

  /**
   * An agent a restart interrupted ended its turn without handing off (Amendment 119): tell
   * it so, once, in its own session, instead of holding it for you. It stays `working` and
   * nothing after it starts. The next time it ends this way it is held as usual, because
   * that run did not begin as a restart resume.
   *
   * Not sent where nothing may start by itself (everything held until a time, a job paused,
   * halting or failed, a cap reached, a folder that is gone) or where there is no session
   * to resume: the hold stands and you are asked. True when it was sent.
   */
  #askToHandOff(agent: Agent): boolean {
    if (!agent.sdkSessionId || this.#hold || this.#halting.has(agent.jobId)) return false;
    const job = getJob(this.#db, agent.jobId);
    if (!job || job.status === 'paused' || job.status === 'failed' || !existsSync(job.worktreePath)) return false;
    if (budgetRefusal(agent)) return false;
    void this.#launchWithPrompt(agent.id, agent.sdkSessionId, HANDOFF_ASK, true).catch((err) => console.error(`[supervisor] ${agent.id} resume threw`, err));
    return true;
  }

  /**
   * The `hand_off` tool (routes/helpers.ts): the agent's summary for the agents after it.
   * It is kept, and what the next agents are told first is this; they start when the turn
   * ends, not now. Returns their roles, and the closing headings its persona asks for that the
   * summary has none of: it is kept all the same, and the reply asks the agent
   * to call again with them. Throws a sentence the agent reads.
   */
  handOff(agentId: string, summary: string): { waiting: string[]; missing: string[] } {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error('no such agent');
    const waiters = this.#waiters(agent);
    if (waiters.length === 0) {
      throw new Error('No agent waits for you, so there is no one to hand off to. Just finish.');
    }
    const text = summary.trim();
    if (!text) throw new Error('hand_off needs a summary: what the agents after you need from your work, said in full.');
    if (text.length > HANDOFF_SUMMARY_MAX) {
      throw new Error(
        `That summary is ${text.length.toLocaleString('en')} characters; the most a hand-off takes is ${HANDOFF_SUMMARY_MAX.toLocaleString('en')}. ` +
          'Shorten it to what they need, and call hand_off again.',
      );
    }
    setHandoff(this.#db, agentId, { summary: text, held: false });
    return { waiting: waiters.map((w) => w.role), missing: missingHeadings(text, agent.closingHeadings ?? []) };
  }

  /**
   * The person's hand-off for an agent that was held (Amendment 104): the summary they
   * edited, sent from Needs You. It releases the agents after it, which `pump` starts.
   * Refused, with a sentence and no change, when the agent is not held. A summary without the
   * closing headings is taken: the card has said which are missing, and there is
   * no agent to ask.
   */
  handOffByUser(agentId: string, summary: string): Agent {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error('no such agent');
    if (agent.status !== 'done' || !getHandoff(this.#db, agentId).held) {
      throw new HandOffRefusedError(
        `${agent.role} is not waiting to be handed off: it ${agent.status === 'done' ? 'handed off already' : `is ${agent.status}, not stopped`}.`,
      );
    }
    const text = summary.trim();
    if (!text) throw new HandOffRefusedError('A hand-off needs a summary: what the agents after it need from its work.');
    if (text.length > HANDOFF_SUMMARY_MAX) {
      throw new HandOffRefusedError(
        `That summary is ${text.length.toLocaleString('en')} characters; the most a hand-off takes is ${HANDOFF_SUMMARY_MAX.toLocaleString('en')}.`,
      );
    }
    // Cleared before the event, so the card is gone by the time the tabs hear of it.
    setHandoff(this.#db, agentId, { summary: text, held: false });
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      { kind: 'status', status: 'done', error: HANDOFF_BY_USER_NOTE },
    );
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
    this.pump();
    return getAgent(this.#db, agentId)!;
  }

  // ── orchestrators and helpers (Amendment 51) ──────────────────────────────

  /**
   * Start a helper for an orchestrator — the `start_helper` tool (routes/helpers.ts).
   * Same job, folder, model and autonomy as the orchestrator, including its per-agent
   * budget, so the job's cap grows by one agent's cap per helper, as for any agent.
   * Queued like any agent: it takes a slot when one is free.
   *
   * With a `role` (Amendment 128), for the orchestrator of an orchestrated stack, the helper
   * runs as that role instead: its persona's system prompt and skills, its model (the listed
   * tier, or a cheaper `tier` asked for), and its rope, which keeps a reading role read-only.
   * Only the roles the stack was launched with may be started, and one lane at most
   * `1 + SEND_BACKS_MAX` times, after which the orchestrator is told to ask the user. A lane
   * is the role and the `name` (Amendment 151): a new name is new work, the same name again is
   * a send-back, and no name is the role's unnamed lane. A
   * `role` on an orchestrator launched with none, and none on one launched with some, is
   * refused with a sentence; an ordinary orchestrator's helpers are as they always were.
   */
  startHelper(orchestratorId: string, task: string, name?: string, askedRole?: string, askedTier?: string): Agent {
    const orch = getAgent(this.#db, orchestratorId);
    if (!orch) throw new Error('no such agent');
    const cap = orch.helperCap ?? 0;
    if (cap === 0) throw new Error(`${orch.role} was not launched to orchestrate, so it has no helpers to start`);
    if (!task.trim()) throw new Error('a helper needs a task: the part of the work it should do');

    const listed = getHelperRoles(this.#db, orch.id);
    const refused = roleRefusal(askedRole, listed.map((r) => r.id), orch.role);
    if (refused) throw new Error(refused);
    const chosen = listedRole(askedRole, listed);
    if (!chosen && askedTier) throw new Error('tier goes with a role: a helper started without one runs on your model.');
    // Rule on the lane before the total, so the sentence that names it is the one it reads.
    const slug = helperSlug(name);
    if (chosen) {
      const again = sendBackRefusal(chosen.id, startedInLane(this.#db, orch.id, chosen.id, name), slug);
      if (again) throw new Error(again);
    }
    const mine = helpersOf(this.#db, orch.id);
    if (mine.length >= cap) {
      throw new Error(`${orch.role} may start ${cap} helper${cap === 1 ? '' : 's'}, and has started ${mine.length}. Wait for them, or do the rest yourself.`);
    }
    // What the role runs on and with, checked before anything is made.
    let model = orch.model;
    let autonomy = orch.autonomy;
    if (chosen) {
      const m = helperModel(chosen, askedTier);
      if ('why' in m) throw new Error(m.why);
      model = m.model;
      autonomy = chosen.autonomy;
      // A reading role stays read-only whatever the request that launched the stack held (Amendment 41, 89).
      const rope = readOnlyRefusal(chosen.id, autonomy);
      if (rope) throw new Error(`${rope}, so it was not started.`);
    }

    const taken = new Set(agentsForJob(this.#db, orch.jobId).map((a) => a.role));
    let role: string;
    if (chosen) {
      // Named for its role and lane (`developer`, or `developer-api` for the name "api"), then `-2`
      // when that lane is sent back, so the lanes read as the pipeline. `startedInLane` counts by it.
      const stem = slug ? `${chosen.id}-${slug}` : chosen.id;
      role = stem;
      for (let n = 2; taken.has(role); n += 1) role = `${stem}-${n}`;
    } else {
      role = slug ? `${orch.role}-${slug}` : `${orch.role}-helper-${mine.length + 1}`;
      for (let n = 2; taken.has(role); n += 1) role = `${slug ? `${orch.role}-${slug}` : `${orch.role}-helper`}-${n}`;
    }

    const helper = insertAgent(this.#db, {
      id: newId('agt'),
      jobId: orch.jobId,
      projectId: orch.projectId,
      role,
      model,
      sdkSessionId: null,
      status: 'queued',
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy,
      brief: chosen ? pipelineHelperBrief(orch.role, chosen.id, chosen.brief, task) : helperBrief(orch.role, task),
      parentId: orch.id,
      // A helper is more of its orchestrator, so it runs as the same persona (Amendment 68); started
      // as a role, it runs as that role's (Amendment 128).
      ...(chosen
        ? personaFields({ persona: chosen.id, systemPrompt: chosen.systemPrompt ?? null, skills: chosen.skills ?? null })
        : personaFields(getAgentPersona(this.#db, orch.id))),
      ...(chosen ? { helperRole: chosen.id } : {}),
      // And on the same engine (Amendment 74).
      ...(orch.provider ? { provider: orch.provider } : {}),
    });
    eventLog().emit(
      { projectId: helper.projectId, jobId: helper.jobId, agentId: helper.id },
      { kind: 'status', status: 'queued' },
    );
    this.#reopenJob(helper.jobId);
    this.#pushEntities({ agents: [helper] });
    this.pump();
    return helper;
  }

  /** Where an orchestrator's helpers are — the `list_helpers` tool. */
  listHelpers(orchestratorId: string): { role: string; status: AgentStatus; reply: string | null }[] {
    return helpersOf(this.#db, orchestratorId).map((h) => ({
      role: h.role,
      status: h.status,
      reply: ENDED.includes(h.status) ? eventLog().lastText(h.id) : null,
    }));
  }

  /**
   * An orchestrator ending its turn with helpers it hasn't heard back from waits for them:
   * queued, depending on them. True when it now waits.
   */
  #awaitHelpers(agent: Agent): boolean {
    if (!agent.helperCap) return false;
    const unheard = unreportedHelpers(this.#db, agent.id);
    if (unheard.length === 0) return false;
    const own = agent.dependsOn.filter((id) => !unheard.some((h) => h.id === id));
    setAgentDependsOn(this.#db, agent.id, [...own, ...unheard.map((h) => h.id)]);
    setAgentStatus(this.#db, agent.id, 'queued');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId: agent.id },
      { kind: 'status', status: 'queued' },
    );
    // Some may have ended already; if all have, it starts again at once.
    queueMicrotask(() => this.pump());
    return true;
  }

  /**
   * The report an orchestrator is woken with, once: its ended, unreported helpers' last
   * replies. Marks them reported and stops it depending on them. '' when there is none.
   */
  #takeHelperReport(agentId: string): string {
    const agent = getAgent(this.#db, agentId);
    if (!agent?.helperCap) return '';
    const done = unreportedHelpers(this.#db, agentId).filter((h) => ENDED.includes(h.status));
    if (done.length === 0) return '';
    markReported(this.#db, done.map((h) => h.id));
    setAgentDependsOn(this.#db, agentId, agent.dependsOn.filter((id) => !done.some((h) => h.id === id)));
    // Each one's whole conversation, shared out within a quarter of this orchestrator's window (Amendment 120).
    const jobPrompt = getJob(this.#db, agent.jobId)?.prompt ?? '';
    return helperReport(
      done.map((h) => ({
        role: h.role,
        status: h.status,
        reply: eventLog().lastText(h.id),
        turns: turnsFromEvents(eventLog().conversation(h.id), jobPrompt),
      })),
      this.#handoffCapOf(agent),
      // An orchestrated stack's orchestrator is told to judge the step and write the next brief (Amendment 128).
      agent.pipelineRoles?.length ? pipelineReportClosing(SEND_BACKS_MAX) : undefined,
    );
  }

  /** A job is done when none of its agents can still make progress. */
  #rollUpJob(jobId: string): void {
    const agents = agentsForJob(this.#db, jobId);
    const job = getJob(this.#db, jobId);
    if (!job || agents.length === 0) return;

    const anyFailed = agents.some((a) => a.status === 'failed');
    // `stopped` settles a job like `paused` does: the human ended it, so the job is no
    // longer waiting on anything. It is NOT counted as a failure — a deliberate stop is
    // not an error, and marking the job failed would put a red card on a decision.
    //
    // A queued agent that can't start without you — behind a paused, failed or stopped one —
    // is settled too (Amendment 88). Otherwise the job said "working" for good while nothing
    // in it could move; resuming or continuing what it waits on opens the job again.
    const allSettled = agents.every(
      (a) =>
        a.status === 'done' ||
        a.status === 'failed' ||
        a.status === 'paused' ||
        a.status === 'stopped' ||
        isStuck(a, agents),
    );
    if (!allSettled) return;

    const next = anyFailed ? 'failed' : 'done';
    setJobStatus(this.#db, jobId, next);
    this.#pushEntities({ jobs: [getJob(this.#db, jobId)!] });
    // Just finished (Amendment 144): merge and clean up if its agents asked, else offer it in
    // Needs You. Only on the way into `done`, so a roll-up that changes nothing asks nothing.
    if (next === 'done' && job.status !== 'done') this.#finished(jobId);
  }

  /** What each just-finished job's merge-or-offer is doing, while it runs (Amendment 144). */
  #finishing = new Map<string, Promise<Finish>>();

  #finished(jobId: string): void {
    const run = finishJob(this.#db, jobId, (id) => this.deleteJob(id)).finally(() => {
      if (this.#finishing.get(jobId) === run) this.#finishing.delete(jobId);
    });
    this.#finishing.set(jobId, run);
  }

  /** The finish of `jobId` in flight, if any: for the verify scripts, which wait on it. */
  finishing(jobId: string): Promise<Finish> | undefined {
    return this.#finishing.get(jobId);
  }

  // ── AgentControl, for the Arbiter ─────────────────────────────────────────

  isLive(agentId: string): boolean {
    return this.#runners.get(agentId)?.isLive ?? false;
  }

  /** A run in flight or a live session: `deleteProject`'s test, for one agent (Amendment 152). */
  isBusy(agentId: string): boolean {
    return this.#active.has(agentId) || this.isLive(agentId);
  }

  /**
   * Busy, or at a status it can still run from: what `DELETE /api/workspaces/:jobId` refuses on
   * (Amendment 152, review). Unlike `deleteProject`'s test, the status counts: an agent paused
   * at a ceiling, `queued` behind a cap or waiting to retry, or `blocked` on a parked request
   * has no run in flight, yet its work is in the worktree and it runs there again. The live
   * runner still counts too, because the status can lag a run that is just starting. Only
   * `done`, `failed` and `stopped` are over (`ENDED_STATUSES`).
   */
  hasUnfinishedWork(agentId: string): boolean {
    if (this.isBusy(agentId)) return true;
    const agent = getAgent(this.#db, agentId);
    return agent !== undefined && !ENDED_STATUSES.has(agent.status);
  }

  async interrupt(agentId: string): Promise<void> {
    await this.#runners.get(agentId)?.interrupt();
  }

  /** Answering a parked request brings its session back with options.resume. */
  resumeParked(agentId: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    if (this.#active.has(agentId)) {
      // Still winding down from the run we interrupted. Remember the intent;
      // #launch relaunches as soon as the iterator lets go.
      this.#resumeWanted.add(agentId);
      return;
    }
    if (!agent.sdkSessionId) {
      console.error(`[supervisor] cannot resume ${agentId}: no sdk session id`);
      // With its event, so the failure has a reason and reaches Needs You (F13).
      setAgentStatus(this.#db, agentId, 'failed');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'failed', error: 'resume_failed' },
      );
      this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
      return;
    }
    if (this.#slotsUsed() >= slotLimit()) {
      // No slot right now. Queue it; pump() picks it up as soon as one frees.
      this.#reopenJob(agent.jobId);
      setAgentStatus(this.#db, agentId, 'queued');
      this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
      return;
    }
    void this.#launch(agentId, agent.sdkSessionId).catch((err) => console.error(`[supervisor] ${agentId} launch threw`, err));
  }

  /**
   * An agent you brought back makes its job live again. pump() leaves a paused or
   * failed job's queued agents where they are, so one woken or answered while every
   * slot was taken — in a job you had paused — waited for a slot it was never given.
   */
  #reopenJob(jobId: string): void {
    const job = getJob(this.#db, jobId);
    if (!job || job.status === 'working' || job.status === 'queued') return;
    setJobStatus(this.#db, jobId, 'working');
    this.#pushEntities({ jobs: [getJob(this.#db, jobId)!] });
  }

  // ── user controls ─────────────────────────────────────────────────────────

  /** Mid-task message. Resumes a finished or parked agent if it is not live. */
  sendMessage(agentId: string, text: string, synthetic = false): 'sent' | 'resumed' {
    const runner = this.#runners.get(agentId);
    if (runner?.send(text, synthetic)) return 'sent';

    const agent = getAgent(this.#db, agentId);
    if (!agent?.sdkSessionId) throw new Error(`agent ${agentId} cannot receive messages yet`);

    // Refused, not launched: the status stays as it is and the sentence says why.
    const refusal = budgetRefusal(agent);
    if (refusal) throw new BudgetReachedError(refusal);
    const job = getJob(this.#db, agent.jobId);
    if (job && !existsSync(job.worktreePath)) {
      throw new FolderGoneError(`${agent.role}: ${folderGoneDetail(job.worktreePath, job.isolation === 'worktree')}`);
    }

    /*
     * No `user_text` emission here. This used to emit one and then hand the same text
     * to `#launchWithPrompt`, whose runner emits it again on the way in — so every
     * message to a PARKED agent was logged twice and appeared twice in the transcript.
     * A live agent took the `runner.send` path above and emitted once, which is why it
     * went unnoticed: only the resume path doubled.
     *
     * The runner is the single emitter now, which is the same rule Track C settled on
     * for file edits (see Watcher.touch): one place that writes the event, so nothing
     * has to know what anybody else already logged. `synthetic` travels with the text
     * so a resume nudge still renders as `auto` rather than as something you said.
     */
    void this.#launchWithPrompt(agentId, agent.sdkSessionId, text, synthetic).catch((err) => console.error(`[supervisor] ${agentId} resume threw`, err));
    return 'resumed';
  }

  // ── re-run from here (Amendment 102) ──────────────────────────────────────

  /**
   * Start the agents after one agent again, once you have changed what it said.
   *
   * Each goes back into its OWN session (`sdkSessionId`, as `pump` resumes any queued agent
   * that has one), told by `rerunNote` that its input changed and what the agents before it
   * said last. Nothing in the worktree is reset: they see what is there and fix it.
   *
   * ORDER. They are all queued at once, and `pump` does the ordering: an agent starts only
   * when every agent it waits for is `done`, so the ones that wait for the changed agent go
   * first and the ones behind them wait until those are done again. The note is built when
   * an agent starts, not when you pressed, so a later agent hears the NEW reply of the one
   * before it.
   *
   * RUNNING ONES ARE STOPPED FIRST. Their input is stale. Stopped the way `pauseAgent` stops
   * one (the session is kept), but a question it was parked on is cancelled, since it was
   * asked about input that has changed. A running agent's helpers are terminated with it;
   * the orchestrator hears them as stopped (Amendment 51).
   *
   * ALL OR NOTHING. Everything that can be refused is checked before the first agent is
   * stopped: the plan (`rerunPlan`), each agent's budget and the job's. A refusal carries
   * its reason and changes nothing.
   *
   * Not here: an agent that hasn't started (it reads the new reply when it does), one that
   * was stopped (refused: the ones behind it would wait for good), and the files.
   */
  async rerunFrom(agentId: string): Promise<RerunResponse> {
    const root = getAgent(this.#db, agentId);
    if (!root) throw new Error(`no such agent ${agentId}`);
    const jobId = root.jobId;
    if (this.#rerunning.has(jobId)) {
      throw new RerunRefusedError('The agents after it are still being stopped for a re-run. Wait a moment.');
    }
    // Held for not handing off (Amendment 104): none of the agents after it has started, so
    // there is nothing to run again. `rerunPlan` says so, from the agent's `handoffHeld` (Amendment
    // 120): the same call and the same sentence the Agent screen's button is disabled with.
    const plan = rerunPlan(agentsForJob(this.#db, jobId), agentId, { hasReply: eventLog().lastText(agentId) !== null });
    if (plan.refusal) throw new RerunRefusedError(plan.refusal);

    const going = plan.steps.filter((s) => s.action !== 'wait');
    for (const s of going) {
      const sentence = budgetRefusal(getAgent(this.#db, s.agentId)!);
      if (sentence) throw new RerunRefusedError(`${s.role} can't go again. ${sentence}`);
    }
    const job = getJob(this.#db, jobId);
    if (job && this.#overBudget(job)) {
      throw new RerunRefusedError("The job has reached its budget, so the agents can't go again. Raise a cap first.");
    }

    this.#rerunning.add(jobId);
    // Held out of `pump` while they stop: each stop frees a slot and pumps, and a sibling
    // not yet requeued would start on the old reply.
    const holding = !this.#halting.has(jobId);
    if (holding) this.#halting.add(jobId);
    try {
      for (const s of going) {
        for (const h of helpersOf(this.#db, s.agentId)) {
          if (!ENDED.includes(h.status)) await this.terminateAgent(h.id);
        }
        if (s.stops) await this.#stopForRerun(s.agentId);
      }
      const again = new Set(going.map((s) => s.agentId));
      const changedBy = new Set([agentId, ...again]);
      for (const s of going) {
        const a = getAgent(this.#db, s.agentId);
        if (!a) continue;
        // Its input changed, so its last summary was about work it is about to change (Amendment 104).
        setHandoff(this.#db, a.id, { summary: null, held: false });
        // And one waiting for the model goes now, with the note, not at its time (Amendment 123).
        this.#forgetRetries(a.id);
        // Only one with a session is resumed. One that failed before it had one starts
        // from its prompt, which carries the new reply already.
        if (s.action === 'resume') {
          const changed = a.dependsOn
            .filter((id) => changedBy.has(id))
            .flatMap((id) => (getAgent(this.#db, id) ? [getAgent(this.#db, id)!.role] : []));
          setRerunPending(this.#db, a.id, changed);
        }
        if (a.status !== 'queued') {
          setAgentStatus(this.#db, a.id, 'queued');
          eventLog().emit(
            { projectId: a.projectId, jobId, agentId: a.id },
            { kind: 'status', status: 'queued', error: rerunStatusNote(root.role) },
          );
        }
      }
      this.#reopenJob(jobId);
      this.#pushEntities({ agents: going.flatMap((s) => getAgent(this.#db, s.agentId) ?? []) });
    } finally {
      this.#rerunning.delete(jobId);
      if (holding) this.#halting.delete(jobId);
    }
    this.pump();
    return {
      from: root.role,
      agents: plan.steps.map((s) => ({ agentId: s.agentId, role: s.role, action: s.action, stopped: s.stops })),
    };
  }

  /** Stop a run whose input has changed: its session kept, its questions cancelled. */
  async #stopForRerun(agentId: string): Promise<void> {
    this.#resumeWanted.delete(agentId);
    arbiter().cancelForAgent(agentId, 'its input changed, so it is being re-run');
    const runner = this.#runners.get(agentId);
    if (runner) {
      this.#userStopped.add(agentId);
      await runner.stop();
    }
  }

  /**
   * The prompt a re-run agent resumes with, once. '' when it was not queued by `rerunFrom`.
   * Built now, from what the agents before it have said by now, plus the report of any
   * helpers that have ended (Amendment 51), which would otherwise be lost to this note.
   */
  #takeRerunNote(agentId: string): string {
    const changed = getRerunPending(this.#db, agentId);
    if (!changed) return '';
    setRerunPending(this.#db, agentId, null);
    const agent = getAgent(this.#db, agentId);
    if (!agent) return '';
    const jobPrompt = getJob(this.#db, agent.jobId)?.prompt ?? '';
    const upstream: Upstream[] = [
      // As in a first prompt: those further up by their summaries, as they stand now.
      ...this.#furtherUp(agent),
      ...agent.dependsOn.flatMap((id) => {
        const dep = getAgent(this.#db, id);
        return dep && dep.parentId !== agentId
          ? [{ role: dep.role, reply: eventLog().lastText(id), turns: turnsFromEvents(eventLog().conversation(id), jobPrompt), ...this.#summaryOf(id) }]
          : [];
      }),
    ];
    return [rerunNote(changed, upstream, this.#handoffCapOf(agent), this.#hasWaiters(agent)), this.#takeHelperReport(agentId)]
      .filter(Boolean)
      .join('\n\n');
  }

  async #launchWithPrompt(
    agentId: string,
    resume: string,
    prompt: string,
    synthetic = false,
  ): Promise<void> {
    const agent = getAgent(this.#db, agentId);
    const job = agent ? getJob(this.#db, agent.jobId) : undefined;
    if (!agent || !job) return;
    if (this.#refuseGone(agentId, job)) return;

    // You wrote to an agent that was waiting for the model: that is its try, with your words (Amendment 123).
    retryBook().cancel(agentId);
    this.#active.add(agentId);
    this.#pushSlots();

    let outcome;
    const began = Date.now();
    // As in #launch: a throw before the run begins is a failed resume, and frees the slot (Amendment 149).
    try {
      // Continuing a failed agent makes its job live again (Amendment 88): a job settled
      // `failed` behind it would otherwise keep its queued agents from ever starting.
      this.#reopenJob(agent.jobId);
      // Told something after it finished: that is a new run, and its last summary was the last run's.
      this.#openRun(agent);
      setAgentStatus(this.#db, agentId, 'working');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'working' },
      );

      // On the engine it was spawned on, which never changes: its session id is that
      // engine's, and no other's (Amendment 74).
      const runner = createBackend(getAgentProvider(this.#db, agentId), this.#db, {
        agentId,
        jobId: agent.jobId,
        projectId: agent.projectId,
        worktreePath: job.worktreePath,
        extraDirs: this.#reachable(agent.projectId, job.worktreePath),
        helperCap: agent.helperCap ?? 0,
        handOff: this.#hasWaiters(agent),
        ...this.#rolesScope(agent),
        model: agent.model,
        autonomy: this.#autonomyFor(agentId),
        spentUsd: agent.costUsd,
        // What its persona gave it at launch, on this run and every resume (Amendment 68).
        ...personaScope(getAgentPersona(this.#db, agentId)),
      });
      this.#runners.set(agentId, runner);

      outcome = await runner.run({ prompt, resume, synthetic });
    } catch (err) {
      outcome = {
        sessionId: null,
        terminalReason: 'resume_failed',
        deferredTool: null,
        isError: true,
        errorDetail: thrown(err),
        costUsd: 0,
      };
      console.error(`[supervisor] ${agentId} resume failed`, err);
    } finally {
      this.#active.delete(agentId);
      this.#pushSlots();
      this.#runners.delete(agentId);
    }
    recordRunEnd(this.#db, agentId, Date.now() - began);
    this.#settle(agentId, outcome);
    this.pump();
  }

  /** Write an agent's autonomy and tell every tab. Applies from its next run. */
  setAutonomy(agentId: string, autonomy: Autonomy): Agent | undefined {
    setAgentAutonomy(this.#db, agentId, autonomy);
    const agent = getAgent(this.#db, agentId);
    if (agent) this.#pushEntities({ agents: [agent] });
    // A raised budget clears the "over budget" warning, with no status change to say so (Amendment 124).
    budgetChanged();
    return agent;
  }

  /**
   * Change an agent's model. A live run switches for its next reply; otherwise the
   * column is what the next run is built from. The column is written only after a
   * live switch succeeded, so a refusal leaves both saying the same thing.
   *
   * The transcript gets a line saying so, so a change of tone mid-conversation has a
   * visible cause. It is a synthetic `user_text` — the frozen event union has no
   * better slot, and the transcript already labels those `auto`.
   */
  async setModel(agentId: string, model: string): Promise<'now' | 'next run'> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error(`no such agent ${agentId}`);
    const runner = this.#runners.get(agentId);
    if (agent.model === model) return runner?.isLive ? 'now' : 'next run';

    const now = runner ? await runner.setModel(model) : false;
    setAgentModel(this.#db, agentId, model);
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      { kind: 'user_text', text: `switched to ${model}`, synthetic: true },
    );
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
    return now ? 'now' : 'next run';
  }

  /**
   * Put an agent to sleep: it stops running and gives up its slot, and keeps its
   * transcript and session for `resumeAgent` to wake (Amendment 35).
   *
   * One waiting on your answer keeps its question. Held, the question is parked now
   * rather than after DEFER_AFTER, which ends the run and frees the slot; parked, it is
   * asleep already. Either way answering it is what wakes it. Pausing used to expire the
   * question, so one you had not got to yet was lost and a woken agent had to think to
   * ask again.
   */
  async pauseAgent(agentId: string, note = 'paused by the user'): Promise<void> {
    if (getAgent(this.#db, agentId)?.status === 'blocked' && (await arbiter().parkForAgent(agentId))) {
      return;
    }
    arbiter().cancelForAgent(agentId, note);
    const runner = this.#runners.get(agentId);
    if (runner) {
      this.#userStopped.add(agentId);
      await runner.stop();
    }
    this.#pause(agentId, note);
  }

  // ── a job whose folder is gone (Amendment 114) ───────────────────────────

  /**
   * True, having failed the agent with `folder_gone` and the sentence, when its job's folder
   * isn't there. Nothing is started, so there is nothing to undo.
   */
  #refuseGone(agentId: string, job: Job): boolean {
    if (existsSync(job.worktreePath)) return false;
    console.warn(`[supervisor] ${agentId}: its folder ${job.worktreePath} is gone; not starting it`);
    this.#settle(agentId, {
      terminalReason: FOLDER_GONE,
      deferredTool: null,
      isError: true,
      errorDetail: folderGoneDetail(job.worktreePath, job.isolation === 'worktree'),
    });
    return true;
  }

  /**
   * Put a job's worktree back where it was (Amendment 114), so its agents can carry on in
   * their own sessions: the conversation is kept by Claude Code, not in the folder. On its
   * own branch when that still exists, with whatever was committed there; otherwise on a new
   * branch of that name from the branch the Branches screen compares with (usually main).
   * Uncommitted work that was in the folder is gone with it, and this says so.
   *
   * Only a job with its own worktree: one working in the project's folder (branch or in
   * place isolation) can't be recreated from git, so that is refused with what to do.
   */
  async restoreFolder(jobId: string): Promise<{ path: string; branch: string; from: 'branch' | 'base'; base?: string }> {
    const job = getJob(this.#db, jobId);
    if (!job) throw new FolderGoneError('no such job');
    const project = getProject(this.#db, job.projectId);
    if (existsSync(job.worktreePath)) throw new FolderGoneError(`${job.worktreePath} is there already`);
    if (job.isolation !== 'worktree') {
      throw new FolderGoneError(`this job works in ${job.worktreePath} itself, not a worktree of its own — put that folder back`);
    }
    if (!project || !existsSync(project.path)) {
      throw new FolderGoneError(`the project's folder ${project?.path ?? '(unknown)'} is gone too — put it back first`);
    }
    const root = await repoRoot(project.path);
    // A removed worktree's registration can linger, and `worktree add` refuses its path.
    await git(root, ['worktree', 'prune']);
    // A branch can be checked out in one place at a time: say where, rather than pass on
    // git's refusal as a 500 (Amendment 139). The route answers a FolderGoneError with 409.
    const elsewhere = (await listWorktrees(root)).find(
      (w) => w.branch === job.branch && canonicalRoot(w.path) !== canonicalRoot(job.worktreePath),
    );
    if (elsewhere) {
      throw new FolderGoneError(
        `${job.branch} is checked out in ${elsewhere.path}; remove that worktree or check out another branch there, then recreate`,
      );
    }
    let result: { path: string; branch: string; from: 'branch' | 'base'; base?: string };
    if (await branchExists(root, job.branch)) {
      await git(root, ['worktree', 'add', '--', job.worktreePath, job.branch]);
      result = { path: job.worktreePath, branch: job.branch, from: 'branch' };
    } else {
      const { target } = await resolveTarget(root, project.defaultBranch, readSettings()[branchTargetKey(project.id)] ?? null);
      await git(root, ['worktree', 'add', '-b', job.branch, '--', job.worktreePath, target]);
      result = { path: job.worktreePath, branch: job.branch, from: 'base', base: target };
    }
    console.log(`[supervisor] recreated ${job.worktreePath} on ${job.branch} (${result.from === 'branch' ? 'its branch' : `new, from ${result.base}`})`);
    // Its agents' transcripts say so, and are told when they next run.
    for (const a of listAgents(this.#db).filter((x) => x.jobId === jobId)) {
      eventLog().emit(
        { projectId: a.projectId, jobId, agentId: a.id },
        {
          kind: 'user_text',
          synthetic: true,
          text:
            result.from === 'branch'
              ? `Your folder ${job.worktreePath} was deleted and has been recreated on ${job.branch}, with what was committed there. Anything that was not committed is gone: check before relying on it.`
              : `Your folder ${job.worktreePath} was deleted and has been recreated from ${result.base}, on a new ${job.branch}. Your own commits and uncommitted work are not in it: check what is there before relying on it.`,
        },
      );
    }
    return result;
  }

  // ── pause everything until a time (Amendment 111) ─────────────────────────

  /** Whether everything is paused until a time: then `pump()` starts nothing. */
  get held(): boolean {
    return this.#hold;
  }

  /**
   * Pause everything. Nothing starts by itself from now on, and every agent that is
   * working is paused the way ⏸ pauses it, with `HOLD_NOTE`: its conversation is kept, its
   * slot freed. Queued agents stay queued; an agent waiting on you keeps its question.
   * What you do yourself still happens: a message you send reaches its agent.
   * Idempotent. Returns how many it paused.
   */
  async hold(): Promise<number> {
    this.#hold = true;
    const working = listAgents(this.#db).filter((a) => a.status === 'working');
    for (const a of working) await this.pauseAgent(a.id, HOLD_NOTE);
    if (working.length > 0) console.log(`[supervisor] paused ${working.length} agent(s) until the scheduled time`);
    return working.length;
  }

  /**
   * The pause is over, or was never on (a restart after its time). Every agent `hold`
   * paused is woken as ▶ resume wakes it, and whatever was queued starts. One at its budget
   * stays paused, with the budget's reason. Returns how many it woke.
   */
  release(): number {
    this.#hold = false;
    let woke = 0;
    for (const a of listAgents(this.#db)) {
      if (a.status !== 'paused' || lastStatusNote(this.#db, a.id) !== HOLD_NOTE) continue;
      try {
        this.resumeAgent(a.id);
        woke += 1;
      } catch (err) {
        if (!(err instanceof BudgetReachedError)) throw err;
        this.#pause(a.id, budgetNote(a));
      }
    }
    // A turn that ended `done` during the pause: its queued message goes now (Amendment 157).
    for (const id of [...this.#owedWhenDone]) {
      this.#owedWhenDone.delete(id);
      const a = getAgent(this.#db, id);
      if (a?.status === 'done') this.#sendWhenDone(a);
    }
    this.pump();
    return woke;
  }

  /**
   * ▶ resume. `note`, when given, is said on the status event that queues it: the new day's
   * continue says why it went (Amendment 140); a person's resume says nothing.
   */
  resumeAgent(agentId: string, note?: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent || agent.status !== 'paused') return;

    const refusal = budgetRefusal(agent);
    if (refusal) throw new BudgetReachedError(refusal);

    this.#goWithout(agent);

    /*
     * Queued, and pump() starts it when a slot is free: with its session when it has
     * one, told to carry on (WAKE_NUDGE, via #resumePrompt), and from the job prompt when
     * the job cap paused it before it ever ran. Waking used to launch straight away
     * whatever the slots said, so a woken agent was one more than the limit (Amendment 35).
     * It used to requeue even further back than that, when pump() launched every queued
     * agent fresh and "paused, resumable" resumed nothing.
     */
    this.#reopenJob(agent.jobId);
    setAgentStatus(this.#db, agentId, 'queued');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      { kind: 'status', status: 'queued', ...(note ? { error: note } : {}) },
    );
    this.pump();
  }

  /**
   * Resuming is the say-so to run without what it waited on that won't finish (Amendment
   * 88): agents that were stopped, not its own helpers, or are gone. They leave its
   * `dependsOn`, so it no longer waits on them, and are kept in `went_without`, so its
   * first prompt still says what they wrote last, marked stopped.
   */
  #goWithout(agent: Agent): void {
    // One that has started is past waiting, and its first prompt has been sent.
    if (agent.sdkSessionId !== null) return;
    const without = getWentWithout(this.#db, agent.id);
    const keep: string[] = [];
    for (const id of agent.dependsOn) {
      const dep = getAgent(this.#db, id);
      if (dep && (dep.status !== 'stopped' || dep.parentId === agent.id)) keep.push(id);
      else if (!without.some((w) => w.id === id)) without.push({ id, role: dep?.role ?? 'an agent that was removed' });
    }
    if (keep.length === agent.dependsOn.length) return;
    setAgentDependsOn(this.#db, agent.id, keep);
    setWentWithout(this.#db, agent.id, without);
  }

  /**
   * End an agent. Deliberately, permanently, and without touching a single file.
   *
   * NOT `pauseAgent`. Pause means "stopped, resumable" and `resumeAgent` will pick it
   * back up; this is for when you are finished with an agent and want it out of the way.
   * The difference is the whole point of the separate `stopped` status: a paused agent is
   * waiting for you, a stopped one is not coming back.
   *
   * Five things happen, in this order, because the order matters:
   *  1. `#resumeWanted` is cleared FIRST. If the runner is mid-shutdown from an earlier
   *     interrupt, `#launch` consults that set when the iterator lets go and would
   *     relaunch the agent we are in the middle of ending.
   *  2. Its open requests are cancelled, so it leaves the attention queue. An agent you
   *     stopped must not still be asking you for permission.
   *  3. The runner is stopped and dropped. `stop()` interrupts the query; dropping the
   *     entry is what makes `isLive` false, which is what the project-removal refusal
   *     reads.
   *  4. Status `stopped` — NOT `done`. A terminated agent did not finish, and rendering
   *     it green next to agents that completed would be a lie the whole UI repeats.
   *  5. The job is re-settled, so a job whose every agent is now stopped stops claiming
   *     to be working.
   *
   * What it does NOT do: delete the agent, its transcript or its spend, and nothing on
   * disk. The worktree, the branch and every file an agent wrote are exactly where they
   * were — same promise as removing a project.
   */
  async terminateAgent(agentId: string): Promise<Agent> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error(`no such agent ${agentId}`);

    /*
     * Already ended: there is nothing to stop, and two things would go wrong if we
     * carried on. An agent that FINISHED would be relabelled `stopped`, rewriting what
     * actually happened to it — you cannot terminate something that already completed.
     * And every press would append another identical status transition to an append-only
     * log, so `deleteAgent` (which terminates first, unconditionally) would leave a trail
     * of events recording nothing.
     *
     * Idempotent and quiet, rather than idempotent and noisy.
     */
    if (ENDED_STATUSES.has(agent.status)) return agent;

    this.#resumeWanted.delete(agentId);
    setRerunPending(this.#db, agentId, null);
    this.#forgetRetries(agentId);
    arbiter().cancelForAgent(agentId, 'the agent was terminated');

    const runner = this.#runners.get(agentId);
    if (runner) {
      await runner.stop();
      this.#runners.delete(agentId);
    }
    this.#active.delete(agentId);
    this.#pushSlots();

    setAgentStatus(this.#db, agentId, 'stopped');
    eventLog().emit(
      { projectId: agent.projectId, jobId: agent.jobId, agentId },
      { kind: 'status', status: 'stopped' },
    );

    const stopped = getAgent(this.#db, agentId)!;
    this.#pushEntities({ agents: [stopped] });
    // The ones waiting on it are paused, with why, rather than left waiting for good
    // (Amendment 88). Not while the whole job is being stopped: they are next.
    if (!this.#halting.has(agent.jobId)) this.#strand(agent.jobId);
    this.#rollUpJob(agent.jobId);
    // A freed slot is a slot something queued can have.
    this.pump();
    return stopped;
  }

  /**
   * Terminate every agent in a job that has not already ended.
   *
   * The job is held out of `pump` until the last one is stopped. Each stop frees a slot
   * and pumps — here, and again when a live run's `#launch` unwinds — and a queued
   * sibling in this same job was the first thing waiting for it: launched, a real
   * process, only to be interrupted on the next pass of this loop.
   */
  async terminateJob(jobId: string): Promise<Agent[]> {
    const out: Agent[] = [];
    this.#halting.add(jobId);
    try {
      for (const agent of agentsForJob(this.#db, jobId)) {
        if (ENDED_STATUSES.has(agent.status)) continue;
        out.push(await this.terminateAgent(agent.id));
      }
    } finally {
      this.#halting.delete(jobId);
    }
    return out;
  }

  /**
   * Remove an agent from Conductor entirely — the row, not just its status.
   *
   * TERMINATE IS NOT REMOVE, and the difference is the whole reason this exists.
   * `terminateAgent` ends the work and leaves the agent on screen reading `stopped`,
   * which is right while you still care what it did and wrong once you don't: a
   * finished project accumulates lanes nobody will look at again and there was no way
   * to clear them.
   *
   * Terminates before deleting, unconditionally, so this is safe on a live agent: a row
   * deleted while its runner is mid-query would leave a process writing events for an
   * agent the database has never heard of.
   *
   * `resync` rather than an entity push, for the reason `deleteProject` uses it — the
   * store's `#applyEvent` never creates entities but it does update them, so pushing a
   * deleted agent could resurrect it in a browser that had it. A resync replaces the
   * collections wholesale and every connected tab converges.
   *
   * Touches no files. Keeps the event log and the day's spend.
   */
  async deleteAgent(agentId: string): Promise<Rewired[]> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error(`no such agent ${agentId}`);
    const jobId = agent.jobId;

    /*
     * REMOVED FROM THE STACK, NOT JUST DELETED (Amendment 88). Each agent that waited on
     * this one and hasn't started waits on what this one waited on instead — before, its
     * row was simply gone and they waited on nothing that would ever finish. Rewired
     * FIRST, so terminating below finds nobody to pause.
     */
    const rewired = rewireOnRemoval(agentsForJob(this.#db, jobId), agentId);
    for (const r of rewired) setAgentDependsOn(this.#db, r.agentId, r.dependsOn);

    await this.terminateAgent(agentId);
    this.#resumeWanted.delete(agentId);
    terminals().closeAgent(agentId); // its shells go with it (Amendment 112)
    deleteAgent(this.#db, agentId);

    // Paused only because this one was stopped: removing it is the say-so to go on.
    let requeued = false;
    for (const r of rewired) {
      const a = getAgent(this.#db, r.agentId);
      if (!a || a.status !== 'paused' || a.sdkSessionId !== null) continue;
      if (!isStrandNote(lastStatusNote(this.#db, a.id)) || this.#strandedBy(a)) continue;
      setAgentStatus(this.#db, a.id, 'queued');
      eventLog().emit({ projectId: a.projectId, jobId, agentId: a.id }, { kind: 'status', status: 'queued' });
      requeued = true;
    }

    /*
     * A job with no agents left cannot make progress, so it must stop saying it might.
     * `#rollUpJob` returns early on an empty agent list — correct for a job whose agents
     * have not been inserted yet, wrong for one whose agents have been removed — so the
     * last-agent case is settled here instead. Otherwise the job is open again if something
     * in it can now start, and settled if nothing can.
     */
    const left = agentsForJob(this.#db, jobId);
    if (left.length === 0) {
      setJobStatus(this.#db, jobId, 'done');
    } else if (requeued || left.some((a) => a.status === 'queued' && !isStuck(a, left))) {
      this.#reopenJob(jobId);
    } else {
      this.#rollUpJob(jobId);
    }

    hub().broadcast({ type: 'resync' });
    this.pump();
    return rewired;
  }

  /** The same for a job: its agents cascade, and the job row goes too. */
  async deleteJob(jobId: string): Promise<void> {
    if (!getJob(this.#db, jobId)) throw new Error(`no such job ${jobId}`);

    await this.terminateJob(jobId);
    for (const agent of agentsForJob(this.#db, jobId)) this.#resumeWanted.delete(agent.id);
    terminals().closeJob(jobId); // and its agents' shells (Amendment 112)

    /*
     * THE OTHER TRACKS' ROWS GO TOO, and leaving this out was a real bug rather than an
     * omission of tidiness.
     *
     * `workspaces` has no foreign key to `jobs`, so deleting the job row orphans it — and
     * Track C's snapshot contributor republishes any workspace that no `jobs` row
     * describes as a SYNTHETIC job, plus a synthetic project named after the repo
     * directory. So a removed job came back in every browser as a job nobody launched,
     * inside a project that did not exist, and neither could be removed again because
     * there was no row left to DELETE. The reported symptom was
     * "removing the project failed — no such project".
     *
     * `forget`, not `close`: close runs `git worktree remove`. Same distinction, and same
     * reason, as in `deleteProject`.
     */
    await workspace().forget(jobId);
    try {
      preview().registry.forgetJob(jobId);
      preview().console.clear(jobId);
    } catch (err) {
      console.warn(`[supervisor] preview cleanup skipped for ${jobId}`, err);
    }

    deleteJob(this.#db, jobId);

    hub().broadcast({ type: 'resync' });
    this.pump();
  }

  async stopJob(jobId: string): Promise<void> {
    for (const agent of agentsForJob(this.#db, jobId)) {
      if (agent.status === 'done' || agent.status === 'failed' || agent.status === 'stopped') {
        continue;
      }
      await this.pauseAgent(agent.id);
    }
    setJobStatus(this.#db, jobId, 'paused');
    this.#pushEntities({ jobs: [getJob(this.#db, jobId)!] });
  }

  /**
   * Interrupt every live agent — used on daemon shutdown. Their rows are left `working`
   * and the next start's `reconcile` pauses them, the same as after a hard stop. Settling
   * them here labelled every agent that was mid-run `failed`.
   */
  async shutdown(): Promise<void> {
    // Waits for the model are not saved: a restart resumes those agents as any other (Amendment 123).
    retryBook().clear();
    for (const id of this.#runners.keys()) this.#userStopped.add(id);
    await Promise.allSettled([...this.#runners.values()].map((r) => r.stop()));
  }

  get slots(): { used: number; total: number } {
    return { used: this.#slotsUsed(), total: slotLimit() };
  }

  /** Tell every tab the slot count — the status bar used to learn it only from a snapshot. */
  #pushSlots(): void {
    hub().broadcast({ type: 'slots', slots: this.slots });
  }

  /**
   * Live agents that count against the slot limit: every live run except one waiting on a
   * question it asked (Amendment 132). That one is held until you answer, however long you
   * take, and costs nothing meanwhile, so it doesn't keep queued work from starting. When
   * you answer it counts again, so for a moment there can be more live than the limit.
   */
  #slotsUsed(): number {
    let n = 0;
    for (const id of this.#active) if (!arbiter().waitingOnQuestion(id)) n += 1;
    return n;
  }

  /** The arbiter's word that a question started or stopped waiting (Amendment 132). */
  slotsChanged(): void {
    this.#pushSlots();
    this.pump();
  }
}

/** What a thrown launch or resume said, as a status event's `detail`. */
function thrown(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.trim().split('\n')[0] ?? '').slice(0, 400) || String(err).slice(0, 400);
}

let instance: Supervisor | null = null;
let offDay: (() => void) | null = null;

export function initSupervisor(db: Db): Supervisor {
  const made = new Supervisor(db);
  instance = made;
  // Budgets are per day: at the day change the new day's budgets are renewed (Amendment 129).
  offDay?.();
  offDay = onDayTurn((day, was) => made.newDay(day, was));
  return made;
}

export function supervisor(): Supervisor {
  if (!instance) throw new Error('Supervisor not initialised — call initSupervisor(db) first');
  return instance;
}
