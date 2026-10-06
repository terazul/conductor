/**
 * Supervisor — who runs, when, and with what rope.
 *
 * Owns three things the runner deliberately does not:
 *   • the slot semaphore. A slot is a LIVE PROCESS, so `held` agents consume one
 *     and `parked` agents do not. That asymmetry is the whole point of parking:
 *     a human who wanders off stops costing us a slot (PLAN.md §1 finding B).
 *   • dependsOn gating — the mockup's "starts now / parallel / after both".
 *   • budget caps. An agent's is a lifetime cap, checked before every launch and
 *     resume; a job's is the sum of its agents' caps, checked before a queued agent
 *     starts (session/budget.ts).
 *
 * ISOLATION is delegated, not reimplemented. Track C's WorkspaceService owns
 * worktree lifecycle, so this calls `workspace().open(...)` IN-PROCESS for all
 * three isolations — its `/api/workspaces` endpoints are bootstrap-only and will
 * be gated. It also emits the `worktree` event and attaches the file watcher, so
 * neither is duplicated here.
 */

import { onSettingsChanged } from '../settings.js';
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
  Snapshot,
} from '@conductor/shared';
import { arbiter, type AgentControl } from '../arbiter/index.js';
import type { Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub, registerSnapshotContributor } from '../hub.js';
import { preview } from '../preview/index.js';
import { expand as expandPath } from '../workspace/browse.js';
import { workspace } from '../workspace/service.js';
import { JOB_BUDGET_NOTE, budgetNote, budgetRefusal, jobCap } from './budget.js';
import { handoffSection, helperBrief, helperReport, orchestratorSection } from './handoff.js';
import type { AgentBackend } from './backend.js';
import { createBackend } from './backends/index.js';
import {
  agentsForJob,
  DEFAULT_AUTONOMY,
  costToday,
  deleteAgent,
  deleteJob,
  deleteProject,
  getAgent,
  getAgentBrief,
  getJob,
  getProject,
  getProjectByPath,
  addProjectDir,
  removeProjectDir,
  projectDirs,
  insertAgent,
  getAgentPersona,
  getAgentProvider,
  insertJob,
  insertProject,
  jobCost,
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
  markReported,
  setAgentDependsOn,
  unreportedHelpers,
  type AgentPersona,
} from './store.js';

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

/** A stored persona as a runner's scope takes it: the persona's id stays on the row. */
function personaScope(p: AgentPersona): { systemPrompt?: string; skills?: string[] } {
  return {
    ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.skills?.length ? { skills: p.skills } : {}),
  };
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
  'before relying on it.';

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

  constructor(db: Db) {
    this.#db = db;
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
    if (fixed > 0) {
      console.log(`[supervisor] reconciled ${fixed} agent(s) left working by a hard stop`);
    }
    return fixed;
  }

  register(): void {
    // A new limit applies at once: a raised one starts what was waiting for a slot.
    onSettingsChanged((changed) => {
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
      costToday: costToday(this.#db),
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

    const keptOnDisk: string[] = [];
    for (const job of jobs) {
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
    let worktreePath: string;
    let branch: string;
    try {
      const ws = await workspace().open({
        jobId,
        projectId: project.id,
        repoPath: project.path,
        isolation: req.isolation,
      });
      worktreePath = ws.path;
      branch = ws.branch;
    } catch (err) {
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

      agents.push(
        insertAgent(this.#db, {
          id,
          jobId,
          projectId: project.id,
          role: spec.role,
          model: spec.model,
          sdkSessionId: null,
          status: 'queued',
          blockMode: null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          dependsOn,
          autonomy: spec.autonomy,
          brief: spec.brief,
          ...(spec.helpers ? { helperCap: spec.helpers } : {}),
          // Copied, not referenced: the agent keeps these if the persona changes (Amendment 68).
          ...(spec.persona ? { persona: spec.persona } : {}),
          ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
          ...(spec.skills?.length ? { skills: spec.skills } : {}),
          ...(spec.provider && spec.provider !== 'claude' ? { provider: spec.provider } : {}),
        }),
      );
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

  // ── scheduling ────────────────────────────────────────────────────────────

  /**
   * Start every agent that is eligible and fits in a slot. Called after any
   * state change; cheap enough to be unconditional.
   */
  pump(): void {
    for (const agent of listAgents(this.#db)) {
      if (agent.status !== 'queued') continue;
      if (this.#active.size >= slotLimit()) return;
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
      void this.#launch(agent.id, agent.sdkSessionId);
    }
  }

  #depsSatisfied(agent: Agent): boolean {
    for (const id of agent.dependsOn) {
      const dep = getAgent(this.#db, id);
      if (!dep) return false;
      // A helper that failed or was stopped has still ended: its orchestrator is told
      // how, rather than waiting for it forever (Amendment 51).
      const ended = dep.parentId === agent.id && (dep.status === 'failed' || dep.status === 'stopped');
      if (dep.status !== 'done' && !ended) return false;
    }
    return true;
  }

  /**
   * Against the sum of the agents' CURRENT caps, not `job.budgetUsd`, which stays the
   * figure Spawn launched with. Comparing against that meant raising one agent's cap
   * still left its queued siblings paused at the old total.
   */
  #overBudget(job: Job): boolean {
    const cap = jobCap(agentsForJob(this.#db, job.id));
    return cap !== null && jobCost(this.#db, job.id) >= cap;
  }

  #pause(agentId: string, note: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
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
   * The prompt one agent sees: the job instruction, what the agents it waited for said
   * last (Amendment 37), and its own brief — last, so "the work described above" and
   * "the root cause the debugger identified" both have something above them.
   */
  #promptFor(agentId: string): string {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return '';
    const job = getJob(this.#db, agent.jobId);
    const brief = getAgentBrief(this.#db, agentId);
    const upstream = agent.dependsOn.flatMap((id) => {
      const dep = getAgent(this.#db, id);
      return dep ? [{ role: dep.role, reply: eventLog().lastText(id) }] : [];
    });
    const handoff = handoffSection(upstream);
    const parts = [job?.prompt ?? ''];
    if (handoff) parts.push(`\n${handoff}`);
    if (brief?.trim()) parts.push(`\nYour role is ${agent.role}. ${brief.trim()}`);
    if (agent.helperCap) parts.push(`\n${orchestratorSection(agent.role, agent.helperCap)}`);
    return parts.join('\n').trim();
  }

  async #launch(agentId: string, resumeFrom?: string | null): Promise<void> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;
    const job = getJob(this.#db, agent.jobId);
    if (!job) return;

    // At its cap: stop here and say so, rather than start a run the SDK would end on
    // its first turn. Reached from pump() and from answering a parked request.
    if (budgetRefusal(agent)) {
      this.#pause(agentId, budgetNote(agent));
      return;
    }

    this.#active.add(agentId);
    this.#pushSlots();
    setAgentStatus(this.#db, agentId, 'working');
    if (job.status === 'queued') setJobStatus(this.#db, job.id, 'working');
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
      model: agent.model,
      autonomy: this.#autonomyFor(agentId),
      spentUsd: agent.costUsd,
      // What its persona gave it at launch, on this run and every resume (Amendment 68).
      ...personaScope(getAgentPersona(this.#db, agentId)),
    });
    this.#runners.set(agentId, runner);

    let outcome;
    try {
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

    this.#settle(agentId, outcome);

    // A decision that landed while this run was still unwinding.
    if (this.#resumeWanted.delete(agentId)) {
      const fresh = getAgent(this.#db, agentId);
      if (fresh?.sdkSessionId) {
        void this.#launch(agentId, fresh.sdkSessionId);
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
    if (lastDeferredTool(this.#db, agentId)) return '';

    // An orchestrator woken because its helpers finished: what they said (Amendment 51).
    const report = this.#takeHelperReport(agentId);
    if (report) return report;

    // Resumed on its own after a restart interrupted it (Amendment 53).
    if (this.#restarted.delete(agentId) && !arbiter().stagedFor(agentId)) return RESTART_NUDGE;

    const staged = arbiter().stagedFor(agentId);
    if (!staged) {
      // Queued with its session and nothing answered: woken from a pause while every
      // slot was taken. Told a call was decided, it went looking for one (Amendment 35).
      return answeredSinceLastRun(this.#db, agentId) ? RESUME_NUDGE : WAKE_NUDGE;
    }

    const tool = staged.toolName;
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
    outcome: { terminalReason: string | null; deferredTool: unknown; isError: boolean; errorDetail?: string | null },
  ): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent) return;

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
      setAgentStatus(this.#db, agentId, 'done');
      eventLog().emit(
        { projectId: agent.projectId, jobId: agent.jobId, agentId },
        { kind: 'status', status: 'done' },
      );
    }
    this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
    this.#rollUpJob(agent.jobId);
  }

  // ── orchestrators and helpers (Amendment 51) ──────────────────────────────

  /**
   * Start a helper for an orchestrator — the `start_helper` tool (routes/helpers.ts).
   * Same job, folder, model and autonomy as the orchestrator, including its per-agent
   * budget, so the job's cap grows by one agent's cap per helper, as for any agent.
   * Queued like any agent: it takes a slot when one is free.
   */
  startHelper(orchestratorId: string, task: string, name?: string): Agent {
    const orch = getAgent(this.#db, orchestratorId);
    if (!orch) throw new Error('no such agent');
    const cap = orch.helperCap ?? 0;
    if (cap === 0) throw new Error(`${orch.role} was not launched to orchestrate, so it has no helpers to start`);
    if (!task.trim()) throw new Error('a helper needs a task: the part of the work it should do');
    const mine = helpersOf(this.#db, orch.id);
    if (mine.length >= cap) {
      throw new Error(`${orch.role} may start ${cap} helper${cap === 1 ? '' : 's'}, and has started ${mine.length}. Wait for them, or do the rest yourself.`);
    }
    const taken = new Set(agentsForJob(this.#db, orch.jobId).map((a) => a.role));
    const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    let role = slug ? `${orch.role}-${slug}` : `${orch.role}-helper-${mine.length + 1}`;
    for (let n = 2; taken.has(role); n += 1) role = `${slug ? `${orch.role}-${slug}` : `${orch.role}-helper`}-${n}`;

    const helper = insertAgent(this.#db, {
      id: newId('agt'),
      jobId: orch.jobId,
      projectId: orch.projectId,
      role,
      model: orch.model,
      sdkSessionId: null,
      status: 'queued',
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy: orch.autonomy,
      brief: helperBrief(orch.role, task),
      parentId: orch.id,
      // A helper is more of its orchestrator, so it runs as the same persona (Amendment 68).
      ...personaFields(getAgentPersona(this.#db, orch.id)),
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
    return helperReport(done.map((h) => ({ role: h.role, status: h.status, reply: eventLog().lastText(h.id) })));
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
    const allSettled = agents.every(
      (a) =>
        a.status === 'done' ||
        a.status === 'failed' ||
        a.status === 'paused' ||
        a.status === 'stopped',
    );
    if (!allSettled) return;

    setJobStatus(this.#db, jobId, anyFailed ? 'failed' : 'done');
    this.#pushEntities({ jobs: [getJob(this.#db, jobId)!] });
  }

  // ── AgentControl, for the Arbiter ─────────────────────────────────────────

  isLive(agentId: string): boolean {
    return this.#runners.get(agentId)?.isLive ?? false;
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
    if (this.#active.size >= slotLimit()) {
      // No slot right now. Queue it; pump() picks it up as soon as one frees.
      this.#reopenJob(agent.jobId);
      setAgentStatus(this.#db, agentId, 'queued');
      this.#pushEntities({ agents: [getAgent(this.#db, agentId)!] });
      return;
    }
    void this.#launch(agentId, agent.sdkSessionId);
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
    void this.#launchWithPrompt(agentId, agent.sdkSessionId, text, synthetic);
    return 'resumed';
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

    this.#active.add(agentId);
    this.#pushSlots();
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
      model: agent.model,
      autonomy: this.#autonomyFor(agentId),
      spentUsd: agent.costUsd,
      // What its persona gave it at launch, on this run and every resume (Amendment 68).
      ...personaScope(getAgentPersona(this.#db, agentId)),
    });
    this.#runners.set(agentId, runner);

    let outcome;
    try {
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
    this.#settle(agentId, outcome);
    this.pump();
  }

  /** Write an agent's autonomy and tell every tab. Applies from its next run. */
  setAutonomy(agentId: string, autonomy: Autonomy): Agent | undefined {
    setAgentAutonomy(this.#db, agentId, autonomy);
    const agent = getAgent(this.#db, agentId);
    if (agent) this.#pushEntities({ agents: [agent] });
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
  async pauseAgent(agentId: string): Promise<void> {
    if (getAgent(this.#db, agentId)?.status === 'blocked' && (await arbiter().parkForAgent(agentId))) {
      return;
    }
    arbiter().cancelForAgent(agentId, 'paused by the user');
    const runner = this.#runners.get(agentId);
    if (runner) {
      this.#userStopped.add(agentId);
      await runner.stop();
    }
    this.#pause(agentId, 'paused by the user');
  }

  resumeAgent(agentId: string): void {
    const agent = getAgent(this.#db, agentId);
    if (!agent || agent.status !== 'paused') return;

    const refusal = budgetRefusal(agent);
    if (refusal) throw new BudgetReachedError(refusal);

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
      { kind: 'status', status: 'queued' },
    );
    this.pump();
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
   * Terminates first, unconditionally, so this is safe on a live agent: a row deleted
   * while its runner is mid-query would leave a process writing events for an agent the
   * database has never heard of.
   *
   * `resync` rather than an entity push, for the reason `deleteProject` uses it — the
   * store's `#applyEvent` never creates entities but it does update them, so pushing a
   * deleted agent could resurrect it in a browser that had it. A resync replaces the
   * collections wholesale and every connected tab converges.
   *
   * Touches no files. Keeps the event log and the day's spend.
   */
  async deleteAgent(agentId: string): Promise<void> {
    const agent = getAgent(this.#db, agentId);
    if (!agent) throw new Error(`no such agent ${agentId}`);

    await this.terminateAgent(agentId);
    this.#resumeWanted.delete(agentId);
    const jobId = agent.jobId;
    deleteAgent(this.#db, agentId);

    /*
     * A job with no agents left cannot make progress, so it must stop saying it might.
     * `#rollUpJob` returns early on an empty agent list — correct for a job whose agents
     * have not been inserted yet, wrong for one whose agents have been removed — so the
     * last-agent case is settled here instead.
     */
    if (agentsForJob(this.#db, jobId).length === 0) {
      setJobStatus(this.#db, jobId, 'done');
    }

    hub().broadcast({ type: 'resync' });
    this.pump();
  }

  /** The same for a job: its agents cascade, and the job row goes too. */
  async deleteJob(jobId: string): Promise<void> {
    if (!getJob(this.#db, jobId)) throw new Error(`no such job ${jobId}`);

    await this.terminateJob(jobId);
    for (const agent of agentsForJob(this.#db, jobId)) this.#resumeWanted.delete(agent.id);

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
    for (const id of this.#runners.keys()) this.#userStopped.add(id);
    await Promise.allSettled([...this.#runners.values()].map((r) => r.stop()));
  }

  get slots(): { used: number; total: number } {
    return { used: this.#active.size, total: slotLimit() };
  }

  /** Tell every tab the slot count — the status bar used to learn it only from a snapshot. */
  #pushSlots(): void {
    hub().broadcast({ type: 'slots', slots: this.slots });
  }
}

/** What a thrown launch or resume said, as a status event's `detail`. */
function thrown(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.trim().split('\n')[0] ?? '').slice(0, 400) || String(err).slice(0, 400);
}

let instance: Supervisor | null = null;

export function initSupervisor(db: Db): Supervisor {
  instance = new Supervisor(db);
  return instance;
}

export function supervisor(): Supervisor {
  if (!instance) throw new Error('Supervisor not initialised — call initSupervisor(db) first');
  return instance;
}
