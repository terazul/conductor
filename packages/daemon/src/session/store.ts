/**
 * Track A's data access. Row shapes in, domain types out.
 *
 * node:sqlite types every result as Record<string, SQLOutputValue> and rows come
 * back with a null prototype, so every read goes through `rows()`/`row()` from
 * db/index.js rather than scattering `as unknown as` casts (CONTRACT.md §4).
 */

import { isProvider, type ProviderId } from './backend.js';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentRole,
  AgentStatus,
  Autonomy,
  BlockMode,
  DaySpend,
  DecisionSummary,
  HelperRole,
  Isolation,
  Job,
  PendingRequest,
  PermissionSuggestion,
  Project,
  ProjectNote,
  ProjectSpend,
  Question,
} from '@conductor/shared';
import { closingHeadingsOf, helperSlug } from '@conductor/shared';
import { row, rows, type Db } from '../db/index.js';

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;

/** JSON that came from our own tables. Narrow at the edges, not everywhere. */
function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// projects
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  default_branch: string;
  /** Set by `setDefaultBranch` (Amendment 117); not on the wire `Project`, nothing outside this file reads it. */
  default_branch_set: number;
  created_at: string;
  /** The project's monthly budget in dollars, or null for none (290_project_monthly_budget.sql). */
  monthly_budget_usd?: number | null;
}

/** A project's directories after its first, in the order they were added (Amendment 39). */
export function projectDirs(db: Db, projectId: string): string[] {
  return rows<{ path: string }>(
    db
      .prepare('SELECT path FROM project_dirs WHERE project_id = ? ORDER BY added_at, rowid')
      .all(projectId),
  ).map((r) => r.path);
}

const toProject = (db: Db, r: ProjectRow): Project => {
  const notes = projectNotes(db, r.id);
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    defaultBranch: r.default_branch,
    createdAt: r.created_at,
    extraDirs: projectDirs(db, r.id),
    // Only when there are some, so a project's shape is what it always was (Amendment 55).
    ...(notes.length > 0 ? { notes } : {}),
    // The same: only when one is set, so a project without one reads as before (Amendment 182).
    ...(r.monthly_budget_usd != null ? { monthlyBudgetUsd: r.monthly_budget_usd } : {}),
  };
};

// ── notes (Amendment 55) ────────────────────────────────────────────────────

interface NoteRow {
  id: string;
  project_id: string;
  text: string;
  created_at: string;
  updated_at: string;
  due?: string | null;
  done_at?: string | null;
}

const toNote = (r: NoteRow): ProjectNote => ({
  id: r.id,
  projectId: r.project_id,
  text: r.text,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // Only when set, so a plain note's shape is what it was (Amendment 63).
  ...(r.due ? { due: r.due } : {}),
  ...(r.done_at ? { doneAt: r.done_at } : {}),
});

/** Every open note due today or before, for Needs You. */
export function dueNotes(db: Db, today: string): ProjectNote[] {
  return rows<NoteRow>(
    db.prepare('SELECT * FROM project_notes WHERE due IS NOT NULL AND due <= ? AND done_at IS NULL ORDER BY due, created_at').all(today),
  ).map(toNote);
}

/** Newest first: the note you wrote last is where you are. */
export function projectNotes(db: Db, projectId: string): ProjectNote[] {
  return rows<NoteRow>(
    db.prepare('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId),
  ).map(toNote);
}

export function getNote(db: Db, id: string): ProjectNote | undefined {
  const r = row<NoteRow>(db.prepare('SELECT * FROM project_notes WHERE id = ?').get(id));
  return r ? toNote(r) : undefined;
}

export function insertNote(db: Db, projectId: string, text: string, due: string | null = null): ProjectNote {
  const at = nowIso();
  const id = newId('note');
  db.prepare(
    'INSERT INTO project_notes (id, project_id, text, created_at, updated_at, due) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, text, at, at, due);
  return getNote(db, id)!;
}

/** Change what's given: text, due (null clears it), done. The rest stays. */
export function updateNote(
  db: Db,
  id: string,
  patch: { text?: string; due?: string | null; done?: boolean },
): ProjectNote | undefined {
  const at = nowIso();
  if (patch.text !== undefined) db.prepare('UPDATE project_notes SET text = ?, updated_at = ? WHERE id = ?').run(patch.text, at, id);
  if (patch.due !== undefined) db.prepare('UPDATE project_notes SET due = ?, updated_at = ? WHERE id = ?').run(patch.due, at, id);
  if (patch.done !== undefined) db.prepare('UPDATE project_notes SET done_at = ? WHERE id = ?').run(patch.done ? at : null, id);
  return getNote(db, id);
}

export function deleteNote(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM project_notes WHERE id = ?').run(id).changes) > 0;
}

export function listProjects(db: Db): Project[] {
  return rows<ProjectRow>(db.prepare('SELECT * FROM projects ORDER BY created_at').all()).map(
    (r) => toProject(db, r),
  );
}

export function getProject(db: Db, id: string): Project | undefined {
  const r = row<ProjectRow>(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  return r ? toProject(db, r) : undefined;
}

export function getProjectByPath(db: Db, path: string): Project | undefined {
  const r = row<ProjectRow>(db.prepare('SELECT * FROM projects WHERE path = ?').get(path));
  return r ? toProject(db, r) : undefined;
}

/** Add a directory to a project. The caller has checked it; this only records it. */
export function addProjectDir(db: Db, projectId: string, path: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO project_dirs (project_id, path, added_at) VALUES (?, ?, ?)',
  ).run(projectId, path, nowIso());
}

/** Forget one of a project's directories. The row only — the directory is not touched. */
export function removeProjectDir(db: Db, projectId: string, path: string): boolean {
  return Number(
    db.prepare('DELETE FROM project_dirs WHERE project_id = ? AND path = ?').run(projectId, path).changes,
  ) > 0;
}

export function insertProject(
  db: Db,
  p: { path: string; name: string; defaultBranch: string },
): Project {
  const project: Project = {
    id: newId('prj'),
    name: p.name,
    path: p.path,
    defaultBranch: p.defaultBranch,
    createdAt: nowIso(),
    extraDirs: [],
  };
  db.prepare(
    `INSERT INTO projects (id, name, path, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(project.id, project.name, project.path, project.defaultBranch, project.createdAt);
  return project;
}

/**
 * Change a project's name and/or path.
 *
 * ON EDITING THE PATH. The path is this row's natural key — `UNIQUE` in the
 * schema, and the value every worktree was cut relative to. Changing it does NOT
 * migrate anything: `jobs.worktree_path`, `workspaces.repo_path` and the
 * worktrees on disk all keep pointing where they pointed, so a project with
 * history ends up describing one directory while its history describes another.
 * That is a deliberate product decision (CONTRACT Amendment 25), not an
 * oversight — the caller is expected to say so out loud, which the Fleet card's
 * confirm does.
 *
 * `defaultBranch` isn't touched here: it has its own setter, `setDefaultBranch`,
 * reached from the Branches screen's "Make default" (Amendment 117).
 */
export function updateProject(
  db: Db,
  id: string,
  patch: { name?: string; path?: string },
): Project | undefined {
  const current = getProject(db, id);
  if (!current) return undefined;

  const name = patch.name?.trim() || current.name;
  const path = patch.path?.trim() || current.path;

  db.prepare(`UPDATE projects SET name = ?, path = ? WHERE id = ?`).run(name, path, id);
  return getProject(db, id);
}

/**
 * Whether this project's `defaultBranch` was set on purpose, via `setDefaultBranch`
 * (Amendment 117), rather than merely captured at registration. `resolveTarget`
 * (`workspace/branches.ts`) uses this to decide where the recorded branch ranks.
 */
export function defaultBranchIsSet(db: Db, id: string): boolean {
  const r = row<{ default_branch_set: number }>(
    db.prepare('SELECT default_branch_set FROM projects WHERE id = ?').get(id),
  );
  return r?.default_branch_set === 1;
}

/**
 * Make `branch` the project's default (Amendment 117), from the Branches screen's "Make
 * default". Unlike `updateProject`, this one field is meant to be set after registration,
 * so `default_branch_set` is marked too: `resolveTarget` then draws against it ahead of
 * origin/HEAD, instead of behind it as a mere fallback (Amendment 113).
 */
export function setDefaultBranch(db: Db, id: string, branch: string): Project | undefined {
  db.prepare('UPDATE projects SET default_branch = ?, default_branch_set = 1 WHERE id = ?').run(branch, id);
  return getProject(db, id);
}

/**
 * Set a project's monthly budget in dollars, or with null take it away (Amendment 182). The
 * caller has checked it (PATCH /api/projects/:id). It only warns: Needs You's `monthly_budget`.
 */
export function setProjectMonthlyBudget(db: Db, id: string, usd: number | null): Project | undefined {
  db.prepare('UPDATE projects SET monthly_budget_usd = ? WHERE id = ?').run(usd, id);
  return getProject(db, id);
}

/**
 * Forget a project. One DELETE, because `PRAGMA foreign_keys = ON` and every
 * table Track A owns hangs off this row with ON DELETE CASCADE: jobs, agents,
 * requests, session_rules, agent_runs all go with it.
 *
 * Three things are deliberately NOT deleted:
 *  • `events` — append-only (CONTRACT §5.2). The log is the record of what
 *    happened, and what happened doesn't stop having happened.
 *  • `cost_daily` — the money was spent. A removal is not a refund.
 *  • anything on disk. Not this file's business, and not any caller's either.
 *
 * The agents' `agent_spend_daily` rows go with them (Amendment 129): they are the agents'
 * budgets, and a removed agent has none left to read. The project's `project_spend_daily`
 * rows stay, unread while the project is gone (Amendment 146): no foreign key, as `cost_daily`.
 */
export function deleteProject(db: Db, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/**
 * Forget one agent. `requests` and `agent_runs` go with it via ON DELETE CASCADE
 * (001_core, 010_session) and `PRAGMA foreign_keys = ON`.
 *
 * NOT deleted, deliberately, and for the same reasons as `deleteProject`: the `events`
 * rows, because the log is append-only (§5.2) and an orphaned transcript is a truer
 * record than a hole; `cost_daily`, because the money was spent and a removal is not a
 * refund; `project_spend_daily`, for the same reason, so its project's total keeps what it
 * spent (Amendment 146); and nothing whatsoever on disk.
 */
export function deleteAgent(db: Db, id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

/** The same for a whole job. Its agents cascade from this one row. */
export function deleteJob(db: Db, id: string): void {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// jobs
// ─────────────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  project_id: string;
  prompt: string;
  isolation: string;
  worktree_path: string;
  branch: string;
  status: string;
  budget_usd: number | null;
  created_at: string;
  ended_at: string | null;
  name: string | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  projectId: r.project_id,
  prompt: r.prompt,
  isolation: r.isolation as Isolation,
  worktreePath: r.worktree_path,
  branch: r.branch,
  status: r.status as AgentStatus,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  budgetUsd: r.budget_usd,
  ...(r.name ? { name: r.name } : {}),
});

export function listJobs(db: Db): Job[] {
  return rows<JobRow>(db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()).map(toJob);
}

export function jobsForProject(db: Db, projectId: string): Job[] {
  return rows<JobRow>(
    db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId),
  ).map(toJob);
}

export function getJob(db: Db, id: string): Job | undefined {
  const r = row<JobRow>(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  return r ? toJob(r) : undefined;
}

export function insertJob(db: Db, j: Omit<Job, 'createdAt' | 'endedAt'>): Job {
  const job: Job = { ...j, createdAt: nowIso(), endedAt: null };
  db.prepare(
    `INSERT INTO jobs (id, project_id, prompt, isolation, worktree_path, branch,
                       status, budget_usd, created_at, ended_at, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    job.id,
    job.projectId,
    job.prompt,
    job.isolation,
    job.worktreePath,
    job.branch,
    job.status,
    job.budgetUsd,
    job.createdAt,
    job.name ?? null,
  );
  return job;
}

/** The name a launched stack is shown by, or with null its original prompt again. */
export function setJobName(db: Db, id: string, name: string | null): void {
  db.prepare('UPDATE jobs SET name = ? WHERE id = ?').run(name, id);
}

export function setJobStatus(db: Db, id: string, status: AgentStatus): void {
  // `stopped` has ended too (Amendment 85): it isn't coming back, and without an end time
  // its clock kept counting from when it started.
  const ended = status === 'done' || status === 'failed' || status === 'stopped' ? nowIso() : null;
  db.prepare('UPDATE jobs SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?').run(
    status,
    ended,
    id,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// agents
// ─────────────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  job_id: string;
  project_id: string;
  role: string;
  model: string;
  sdk_session_id: string | null;
  status: string;
  block_mode: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  depends_on: string;
  autonomy: string;
  brief: string | null;
  started_at: string | null;
  ended_at: string | null;
  helper_cap?: number | null;
  provider?: string | null;
  parent_id?: string | null;
  persona?: string | null;
  system_prompt?: string | null;
  skills?: string | null;
  handoff_held?: number | null;
  helper_roles?: string | null;
  helper_role?: string | null;
  name?: string | null;
  /** From `agent_spend_daily` for today (Amendment 129); null when it has spent nothing today. */
  spent_usd?: number | null;
  spent_tokens?: number | null;
}

/**
 * Used when a row predates a field, or carries unparseable JSON. No tools, Bash included, though
 * Spawn's default allows it since Amendment 175: the row it stands in for may be a reading role's,
 * and a broken row should ask, not run.
 */
export const DEFAULT_AUTONOMY: Autonomy = {
  mode: 'default',
  allowedTools: [],
  disallowedTools: [],
  budgetUsd: null,
};

/** The headings an agent's hand-off closes with, as the wire carries them: only when there are some. */
function closingHeadingsField(systemPrompt: string | null | undefined): Pick<Agent, 'closingHeadings'> {
  const headings = closingHeadingsOf(systemPrompt);
  return headings.length > 0 ? { closingHeadings: headings } : {};
}

const toAgent = (r: AgentRow, day: string): Agent => ({
  id: r.id,
  jobId: r.job_id,
  projectId: r.project_id,
  role: r.role as AgentRole,
  model: r.model,
  sdkSessionId: r.sdk_session_id,
  status: r.status as AgentStatus,
  blockMode: r.block_mode as BlockMode | null,
  costUsd: r.cost_usd,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  dependsOn: parse<string[]>(r.depends_on, []),
  // Amendment 7 put this on the shared type. The column was always here.
  autonomy: parse<Autonomy>(r.autonomy, DEFAULT_AUTONOMY),
  startedAt: r.started_at,
  endedAt: r.ended_at,
  // Only when set, so an ordinary agent's shape is what it always was (Amendment 51).
  ...(r.helper_cap ? { helperCap: r.helper_cap } : {}),
  ...(r.parent_id ? { parentId: r.parent_id } : {}),
  // Only when it isn't Claude, so a Claude agent's shape is what it always was (Amendment 74).
  ...(r.provider && r.provider !== 'claude' ? { provider: r.provider } : {}),
  // Only while it is done and held for not handing off (Amendment 120), so every other agent's
  // shape is what it was. The same pair the alert and the daemon's refusals read (Amendment 104).
  ...(r.status === 'done' && r.handoff_held === 1 ? { handoffHeld: true } : {}),
  // Only on the orchestrator of an orchestrated stack (Amendment 128): the ids, nothing of the roles' prompts.
  ...pipelineRolesField(r.helper_roles),
  // Only when its system prompt names some: the prompt stays on the row.
  ...closingHeadingsField(r.system_prompt),
  // What it spent today, stamped with the day, which is what its budget is read against (Amendment 129).
  spentToday: { day, usd: r.spent_usd ?? 0, tokens: r.spent_tokens ?? 0 },
  // Only when you gave it one (Amendment 184).
  ...(r.name ? { name: r.name } : {}),
});

/**
 * Agents with what each has spent today (Amendment 129) joined on, so every wire Agent carries
 * the figure its budget is read against. `where` is the rest of the statement, on `a`.
 */
function readAgents(db: Db, where = '', ...params: Array<string | number>): Agent[] {
  const day = localDay();
  return rows<AgentRow>(
    db
      .prepare(
        `SELECT a.*, s.cost_usd AS spent_usd, s.tokens AS spent_tokens
           FROM agents a LEFT JOIN agent_spend_daily s ON s.agent_id = a.id AND s.day = ?
          ${where}`,
      )
      .all(day, ...params),
  ).map((r) => toAgent(r, day));
}

/** The engine an agent runs on (Amendment 74). `claude` for every agent from before. */
export function getAgentProvider(db: Db, id: string): ProviderId {
  const r = row<{ provider: string | null }>(db.prepare('SELECT provider FROM agents WHERE id = ?').get(id));
  return isProvider(r?.provider) ? r.provider : 'claude';
}

// ── orchestrators and helpers (Amendment 51) ────────────────────────────────

/** The roles stored on an orchestrator row, whole, dropping anything that is not one (Amendment 128). */
function pipelineRolesOf(raw: string | null | undefined): HelperRole[] {
  const v = raw ? parse<unknown>(raw, []) : [];
  return Array.isArray(v)
    ? v.filter((r): r is HelperRole => !!r && typeof r === 'object' && typeof (r as HelperRole).id === 'string' && typeof (r as HelperRole).model === 'string')
    : [];
}

/** `{ pipelineRoles }` for an orchestrator's wire shape, or nothing: the ids of its roles (Amendment 128). */
function pipelineRolesField(raw: string | null | undefined): { pipelineRoles?: string[] } {
  if (!raw) return {};
  const ids = pipelineRolesOf(raw).map((r) => r.id);
  return ids.length > 0 ? { pipelineRoles: ids } : {};
}

/**
 * The roles an orchestrator may start, as it was launched with them (Amendment 128): each with
 * the prompt, rope and model a helper of that role runs with. Empty for an ordinary agent and
 * for an ordinary orchestrator, whose helpers have no role.
 */
export function getHelperRoles(db: Db, id: string): HelperRole[] {
  const r = row<Pick<AgentRow, 'helper_roles'>>(db.prepare('SELECT helper_roles FROM agents WHERE id = ?').get(id));
  return pipelineRolesOf(r?.helper_roles);
}

/** The listed role a helper was started as, or null (Amendment 128). */
export function getHelperRole(db: Db, id: string): string | null {
  const r = row<Pick<AgentRow, 'helper_role'>>(db.prepare('SELECT helper_role FROM agents WHERE id = ?').get(id));
  return r?.helper_role ?? null;
}

/**
 * How many helpers of this role the orchestrator has started in one lane, ended or not
 * (Amendment 128; per lane since Amendment 151). A lane is the role and the `name` it was
 * started with, as `helperSlug` stores it; no name is the role's unnamed lane. The name is kept
 * in the helper's `role` column, which `Supervisor.startHelper` writes as `<role>-<name>`
 * (`<role>` with none), and `-2`, `-3` … after it when the lane is started again. So a lane's
 * helpers are that stem, or that stem and a number.
 */
export function startedInLane(db: Db, orchestratorId: string, role: string, name?: string): number {
  const slug = helperSlug(name);
  const stem = slug ? `${role}-${slug}` : role;
  const started = rows<{ role: string }>(
    db.prepare('SELECT role FROM agents WHERE parent_id = ? AND helper_role = ?').all(orchestratorId, role),
  );
  return started.filter((r) => r.role === stem || (r.role.startsWith(`${stem}-`) && /^\d+$/.test(r.role.slice(stem.length + 1)))).length;
}

export function helpersOf(db: Db, parentId: string): Agent[] {
  return readAgents(db, 'WHERE a.parent_id = ? ORDER BY a.rowid', parentId);
}

/** Helpers whose final reply hasn't been handed to their orchestrator yet. */
export function unreportedHelpers(db: Db, parentId: string): Agent[] {
  return readAgents(db, 'WHERE a.parent_id = ? AND a.reported_at IS NULL ORDER BY a.rowid', parentId);
}

export function markReported(db: Db, ids: string[]): void {
  const at = new Date().toISOString();
  const stmt = db.prepare('UPDATE agents SET reported_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(at, id);
}

export function setAgentDependsOn(db: Db, id: string, dependsOn: string[]): void {
  db.prepare('UPDATE agents SET depends_on = ? WHERE id = ?').run(JSON.stringify(dependsOn), id);
}

/** An agent its dependant was started without, by role (Amendment 88). */
export interface WentWithout {
  id: string;
  role: string;
}

/** What this agent was resumed without: agents it waited on that were stopped or removed. */
export function getWentWithout(db: Db, id: string): WentWithout[] {
  const r = row<{ went_without: string | null }>(db.prepare('SELECT went_without FROM agents WHERE id = ?').get(id));
  const v = r?.went_without ? parse<unknown>(r.went_without, []) : [];
  return Array.isArray(v)
    ? v.filter((x): x is WentWithout => typeof x?.id === 'string' && typeof x?.role === 'string')
    : [];
}

export function setWentWithout(db: Db, id: string, without: WentWithout[]): void {
  db.prepare('UPDATE agents SET went_without = ? WHERE id = ?').run(without.length ? JSON.stringify(without) : null, id);
}

// ── handing off (Amendment 104) ─────────────────────────────────────────────

/** What an agent said to the agents after it, and whether it is being held for not saying it. */
export interface Handoff {
  /** From its `hand_off` call or a person's edit; null when it has not handed off this run. */
  summary: string | null;
  /** Ended its turn without handing off, so the agents after it wait. */
  held: boolean;
}

export function getHandoff(db: Db, id: string): Handoff {
  const r = row<{ handoff_summary: string | null; handoff_held: number }>(
    db.prepare('SELECT handoff_summary, handoff_held FROM agents WHERE id = ?').get(id),
  );
  return { summary: r?.handoff_summary ?? null, held: r?.handoff_held === 1 };
}

/** Both columns at once: `held` can only be true when it has not handed off. */
export function setHandoff(db: Db, id: string, h: Handoff): void {
  db.prepare('UPDATE agents SET handoff_summary = ?, handoff_held = ? WHERE id = ?').run(
    h.summary,
    h.held && h.summary === null ? 1 : 0,
    id,
  );
}

/**
 * The roles whose reply changed, for an agent "re-run from here" put back into its session and
 * that has not started yet (Amendment 120); null when no note is waiting. Kept in the row, not
 * in memory, so a daemon restart between the press and the start keeps it.
 */
export function getRerunPending(db: Db, id: string): string[] | null {
  const r = row<{ rerun_pending: string | null }>(db.prepare('SELECT rerun_pending FROM agents WHERE id = ?').get(id));
  if (r?.rerun_pending == null) return null;
  const v = parse<unknown>(r.rerun_pending, null);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

/** Leave a note waiting for `id`, or with null take it away. Names the roles that changed; may be empty. */
export function setRerunPending(db: Db, id: string, changed: readonly string[] | null): void {
  db.prepare('UPDATE agents SET rerun_pending = ? WHERE id = ?').run(changed === null ? null : JSON.stringify(changed), id);
}

/** Agents held for not handing off, by id. Derived into Needs You as `handoff_held`. */
export function heldHandoffs(db: Db): string[] {
  return rows<{ id: string }>(db.prepare('SELECT id FROM agents WHERE handoff_held = 1').all()).map((r) => r.id);
}

/** The note on an agent's last status event, if it had one: why it is paused, failed, … */
export function lastStatusNote(db: Db, agentId: string): string | null {
  const r = row<{ payload: string }>(
    db
      .prepare(`SELECT payload FROM events WHERE agent_id = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`)
      .get(agentId),
  );
  if (!r) return null;
  const p = parse<{ error?: unknown }>(r.payload, {});
  return typeof p.error === 'string' ? p.error : null;
}

export function listAgents(db: Db): Agent[] {
  return readAgents(db);
}

export function getAgent(db: Db, id: string): Agent | undefined {
  return readAgents(db, 'WHERE a.id = ?', id)[0];
}

export function agentsForJob(db: Db, jobId: string): Agent[] {
  return readAgents(db, 'WHERE a.job_id = ?', jobId);
}

export function getAgentBrief(db: Db, id: string): string | null {
  const r = row<{ brief: string | null }>(db.prepare('SELECT brief FROM agents WHERE id = ?').get(id));
  return r?.brief ?? null;
}

/** What an agent's persona gave it at launch (Amendment 68). */
export interface AgentPersona {
  persona: string | null;
  systemPrompt: string | null;
  /** Null: Claude Code's defaults. */
  skills: string[] | null;
}

/**
 * Read back for every run, resumes and wakes included, so an agent keeps what it launched
 * with. Kept off the wire Agent: a system prompt can be long, and nothing on screen needs it.
 */
export function getAgentPersona(db: Db, id: string): AgentPersona {
  const r = row<Pick<AgentRow, 'persona' | 'system_prompt' | 'skills'>>(
    db.prepare('SELECT persona, system_prompt, skills FROM agents WHERE id = ?').get(id),
  );
  const skills = r?.skills ? parse<unknown>(r.skills, null) : null;
  return {
    persona: r?.persona ?? null,
    systemPrompt: r?.system_prompt ?? null,
    skills: Array.isArray(skills) ? skills.filter((x): x is string => typeof x === 'string') : null,
  };
}

export function insertAgent(
  db: Db,
  a: Omit<Agent, 'startedAt' | 'endedAt'> & {
    brief?: string;
    /** From its persona (Amendment 68); kept on the row, off the wire. */
    persona?: string;
    systemPrompt?: string;
    skills?: string[];
    /** Amendment 128: the roles an orchestrator may start; and, on a helper, the one it was started as. Off the wire. */
    helperRoles?: HelperRole[];
    helperRole?: string;
  },
): Agent {
  const agent: Agent = {
    id: a.id,
    jobId: a.jobId,
    projectId: a.projectId,
    role: a.role,
    model: a.model,
    sdkSessionId: a.sdkSessionId,
    status: a.status,
    blockMode: a.blockMode,
    costUsd: a.costUsd,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    dependsOn: a.dependsOn,
    autonomy: a.autonomy,
    startedAt: null,
    endedAt: null,
    ...(a.helperCap ? { helperCap: a.helperCap } : {}),
    ...(a.parentId ? { parentId: a.parentId } : {}),
    ...(a.provider && a.provider !== 'claude' ? { provider: a.provider } : {}),
    ...(a.helperRoles?.length ? { pipelineRoles: a.helperRoles.map((r) => r.id) } : {}),
    ...closingHeadingsField(a.systemPrompt),
    // A new agent has spent nothing today (Amendment 129).
    spentToday: { day: localDay(), usd: 0, tokens: 0 },
  };
  db.prepare(
    `INSERT INTO agents (id, job_id, project_id, role, model, sdk_session_id, status,
                         block_mode, cost_usd, input_tokens, output_tokens,
                         depends_on, autonomy, brief, started_at, ended_at, helper_cap, parent_id,
                         persona, system_prompt, skills, provider, helper_roles, helper_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.jobId,
    agent.projectId,
    agent.role,
    agent.model,
    agent.sdkSessionId,
    agent.status,
    agent.blockMode,
    agent.costUsd,
    agent.inputTokens,
    agent.outputTokens,
    JSON.stringify(agent.dependsOn),
    JSON.stringify(a.autonomy),
    a.brief ?? null,
    a.helperCap ?? 0,
    a.parentId ?? null,
    a.persona ?? null,
    a.systemPrompt ?? null,
    a.skills ? JSON.stringify(a.skills) : null,
    a.provider ?? 'claude',
    a.helperRoles?.length ? JSON.stringify(a.helperRoles) : null,
    a.helperRole ?? null,
  );
  return agent;
}

export function setAgentStatus(
  db: Db,
  id: string,
  status: AgentStatus,
  blockMode: BlockMode | null = null,
): void {
  const started = status === 'working' ? nowIso() : null;
  // `stopped` has ended too (Amendment 85): it isn't coming back, and without an end time
  // its clock kept counting from when it started.
  const ended = status === 'done' || status === 'failed' || status === 'stopped' ? nowIso() : null;
  db.prepare(
    `UPDATE agents
        SET status = ?, block_mode = ?,
            started_at = COALESCE(started_at, ?),
            ended_at = COALESCE(?, ended_at)
      WHERE id = ?`,
  ).run(status, blockMode, started, ended, id);
}

export function setAgentSession(db: Db, id: string, sdkSessionId: string): void {
  db.prepare('UPDATE agents SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
}

export function setAgentAutonomy(db: Db, id: string, autonomy: Autonomy): void {
  db.prepare('UPDATE agents SET autonomy = ? WHERE id = ?').run(JSON.stringify(autonomy), id);
}

export function setAgentModel(db: Db, id: string, model: string): void {
  db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(model, id);
}

/** The name an agent is shown by, or with null none, so it reads as its role again (Amendment 184). */
export function setAgentName(db: Db, id: string, name: string | null): void {
  db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, id);
}

/**
 * Usage from SDKResultMessage is CUMULATIVE for a streaming session, so this
 * overwrites rather than adding. Summing across results would double-count.
 */
export function setAgentUsage(
  db: Db,
  id: string,
  u: { costUsd: number; inputTokens: number; outputTokens: number },
): void {
  db.prepare(
    'UPDATE agents SET cost_usd = ?, input_tokens = ?, output_tokens = ? WHERE id = ?',
  ).run(u.costUsd, u.inputTokens, u.outputTokens, id);
}

// ─────────────────────────────────────────────────────────────────────────────
// cost rollup
// ─────────────────────────────────────────────────────────────────────────────

let dayClock = (): Date => new Date();

/**
 * Where "today" is read from, so a check can move the day without waiting for midnight
 * (Amendment 103). With no argument, the real clock is put back.
 */
export function setDayClock(fn?: () => Date): void {
  dayClock = fn ?? ((): Date => new Date());
}

/**
 * The day key for the cost rollup, in LOCAL time.
 *
 * Deliberately not `toISOString().slice(0,10)`: that is UTC, so a user in EDT
 * spending $1.25 at 20:00 would watch the status bar reset to $0.00 four hours
 * before their day ended. "Today" in a status bar means the human's today.
 */
export function localDay(d: Date = dayClock()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The local month, `YYYY-MM`: the first seven characters of `localDay`, so a month turns when
 * its last day does (Amendment 182). What the month's figures and the monthly budgets read.
 */
export function localMonth(d: Date = dayClock()): string {
  return localDay(d).slice(0, 7);
}

export function addCostToday(db: Db, delta: number): void {
  if (delta <= 0) return;
  db.prepare(
    `INSERT INTO cost_daily (day, cost_usd) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
  ).run(localDay(), delta);
}

export function costToday(db: Db): number {
  const r = row<{ cost_usd: number }>(
    db.prepare('SELECT cost_usd FROM cost_daily WHERE day = ?').get(localDay()),
  );
  return r?.cost_usd ?? 0;
}

/** What the fleet has spent this local month: the month's days of `cost_daily`, summed (Amendment 182). */
export function costMonth(db: Db): number {
  const r = row<{ total: number }>(
    db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_daily WHERE substr(day, 1, 7) = ?').get(localMonth()),
  );
  return r?.total ?? 0;
}

/** Cumulative spend for a job over its whole life. Information: no cap reads it (Amendment 129). */
export function jobCost(db: Db, jobId: string): number {
  const r = row<{ total: number }>(
    db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agents WHERE job_id = ?').get(jobId),
  );
  return r?.total ?? 0;
}

// ── what each agent spent today (Amendment 129) ─────────────────────────────

/** What `agentId` has spent today: both units, stamped with the day. Zero when it has spent nothing. */
export function spentToday(db: Db, agentId: string): DaySpend {
  const day = localDay();
  const r = row<{ cost_usd: number; tokens: number }>(
    db.prepare('SELECT cost_usd, tokens FROM agent_spend_daily WHERE agent_id = ? AND day = ?').get(agentId, day),
  );
  return { day, usd: r?.cost_usd ?? 0, tokens: r?.tokens ?? 0 };
}

/**
 * Add what a run just spent to the agent's day, and return the day's figure. It grows by deltas
 * as usage arrives, the way `addCostToday` does for the machine's day, and is credited to the
 * day the usage ARRIVES: a run that crosses midnight counts its later usage on the new day.
 * Nothing negative or empty is written. An agent that no longer exists records nothing, and reads
 * as zero.
 */
export function addSpendToday(db: Db, agentId: string, delta: { usd?: number; tokens?: number }): DaySpend {
  const usd = delta.usd && delta.usd > 0 ? delta.usd : 0;
  const tokens = delta.tokens && delta.tokens > 0 ? Math.round(delta.tokens) : 0;
  if (usd > 0 || tokens > 0) {
    const day = localDay();
    // The agent's day and its project's day are one write (Amendment 146): a SAVEPOINT, so it
    // nests inside a caller's transaction as well as standing alone, and neither is ever
    // credited without the other.
    db.exec('SAVEPOINT spend');
    try {
      db.prepare(
        `INSERT INTO agent_spend_daily (agent_id, day, cost_usd, tokens)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?)
         ON CONFLICT(agent_id, day) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           tokens = tokens + excluded.tokens`,
      ).run(agentId, day, usd, tokens, agentId);
      // The project's own record, which outlives the agent (240_spend_totals.sql).
      db.prepare(
        `INSERT INTO project_spend_daily (project_id, day, cost_usd, tokens)
         SELECT project_id, ?, ?, ? FROM agents WHERE id = ?
         ON CONFLICT(project_id, day) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           tokens = tokens + excluded.tokens`,
      ).run(day, usd, tokens, agentId);
      db.exec('RELEASE spend');
    } catch (err) {
      db.exec('ROLLBACK TO spend');
      db.exec('RELEASE spend');
      throw err;
    }
  }
  return spentToday(db, agentId);
}

// ── totals that outlive what spent them (Amendment 146) ─────────────────────

/**
 * Everything the fleet has spent, in dollars: every day `cost_daily` holds, summed. Nothing
 * removes those rows (`deleteAgent`, `deleteJob` and `deleteProject` leave them), so a removed
 * agent's money stays in it.
 */
export function costTotal(db: Db): number {
  const r = row<{ total: number }>(db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_daily').get());
  return r?.total ?? 0;
}

/**
 * Each project's spend today, this local month (Amendment 182) and over its whole life, from
 * `project_spend_daily`, which no removal touches. Only the projects there are: a forgotten
 * project's rows are kept, unread. Every project is listed, with zeros when it has spent nothing.
 */
export function projectSpend(db: Db): ProjectSpend[] {
  type Sums = { id: string; today: number; month: number; total: number; tokens_today: number; tokens_month: number; tokens_total: number };
  const day = localDay();
  const month = localMonth();
  return rows<Sums>(
    db
      .prepare(
        `SELECT p.id,
                COALESCE(SUM(CASE WHEN s.day = ? THEN s.cost_usd END), 0)               AS today,
                COALESCE(SUM(CASE WHEN substr(s.day, 1, 7) = ? THEN s.cost_usd END), 0) AS month,
                COALESCE(SUM(s.cost_usd), 0)                                            AS total,
                COALESCE(SUM(CASE WHEN s.day = ? THEN s.tokens END), 0)                 AS tokens_today,
                COALESCE(SUM(CASE WHEN substr(s.day, 1, 7) = ? THEN s.tokens END), 0)   AS tokens_month,
                COALESCE(SUM(s.tokens), 0)                                              AS tokens_total
           FROM projects p LEFT JOIN project_spend_daily s ON s.project_id = p.id
          GROUP BY p.id
          ORDER BY p.id`,
      )
      .all(day, month, day, month),
  ).map((r) => ({
    projectId: r.id,
    today: r.today,
    month: r.month,
    total: r.total,
    tokensToday: r.tokens_today,
    tokensMonth: r.tokens_month,
    tokensTotal: r.tokens_total,
  }));
}

/** The `cost` frame's figures, and the snapshot's: today, this month, the fleet's all-time total, each project's three. */
export function spendFigures(db: Db): { costToday: number; costMonth: number; costTotal: number; projectSpend: ProjectSpend[] } {
  return { costToday: costToday(db), costMonth: costMonth(db), costTotal: costTotal(db), projectSpend: projectSpend(db) };
}

/**
 * A job's spend today: what its agents spent, summed. What a job's budget is read against,
 * as `jobCap` is the sum of its agents' budgets (Amendment 129). Dollars only, as the cap is.
 */
export function jobCostToday(db: Db, jobId: string): number {
  const r = row<{ total: number }>(
    db
      .prepare(
        `SELECT COALESCE(SUM(s.cost_usd), 0) AS total
           FROM agent_spend_daily s JOIN agents a ON a.id = s.agent_id
          WHERE a.job_id = ? AND s.day = ?`,
      )
      .get(jobId, localDay()),
  );
  return r?.total ?? 0;
}

/** The agents that spent anything on `day`. The day change pushes these afresh, their budgets reading from zero. */
export function agentsThatSpentOn(db: Db, day: string): string[] {
  return rows<{ agent_id: string }>(
    db.prepare('SELECT agent_id FROM agent_spend_daily WHERE day = ? AND (cost_usd > 0 OR tokens > 0)').all(day),
  ).map((r) => r.agent_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// requests
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestRecord {
  id: string;
  agentId: string;
  jobId: string;
  projectId: string;
  kind: 'permission' | 'question';
  blockMode: BlockMode;
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  label: string;
  matchedRule?: string;
  cwd?: string;
  suggestions?: PermissionSuggestion[];
  reversible?: { value: boolean; reason: string };
  questions?: Question[];
  createdAt: string;
  resolvedAt: string | null;
  decision: DecisionSummary | null;
}

interface RequestRow {
  id: string;
  agent_id: string;
  job_id: string;
  project_id: string;
  kind: string;
  block_mode: string;
  tool_name: string;
  tool_use_id: string | null;
  input: string;
  label: string;
  matched_rule: string | null;
  cwd: string | null;
  suggestions: string | null;
  reversible: string | null;
  questions: string | null;
  created_at: string;
  resolved_at: string | null;
  decision: string | null;
}

function toRequest(r: RequestRow): RequestRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    jobId: r.job_id,
    projectId: r.project_id,
    kind: r.kind as 'permission' | 'question',
    blockMode: r.block_mode as BlockMode,
    toolName: r.tool_name,
    toolUseId: r.tool_use_id,
    input: parse<unknown>(r.input, {}),
    label: r.label,
    matchedRule: r.matched_rule ?? undefined,
    cwd: r.cwd ?? undefined,
    suggestions: r.suggestions ? parse<PermissionSuggestion[]>(r.suggestions, []) : undefined,
    reversible: r.reversible
      ? parse<{ value: boolean; reason: string } | undefined>(r.reversible, undefined)
      : undefined,
    questions: r.questions ? parse<Question[]>(r.questions, []) : undefined,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    decision: r.decision ? parse<DecisionSummary | null>(r.decision, null) : null,
  };
}

export function insertRequest(db: Db, r: Omit<RequestRecord, 'resolvedAt' | 'decision'>): void {
  db.prepare(
    `INSERT INTO requests (id, agent_id, job_id, project_id, kind, block_mode, tool_name,
                           tool_use_id, input, label, matched_rule, cwd, suggestions,
                           reversible, questions, created_at, resolved_at, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    r.id,
    r.agentId,
    r.jobId,
    r.projectId,
    r.kind,
    r.blockMode,
    r.toolName,
    r.toolUseId,
    JSON.stringify(r.input ?? {}),
    r.label,
    r.matchedRule ?? null,
    r.cwd ?? null,
    r.suggestions ? JSON.stringify(r.suggestions) : null,
    r.reversible ? JSON.stringify(r.reversible) : null,
    r.questions ? JSON.stringify(r.questions) : null,
    r.createdAt,
  );
}

export function getRequest(db: Db, id: string): RequestRecord | undefined {
  const r = row<RequestRow>(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));
  return r ? toRequest(r) : undefined;
}

export function openRequests(db: Db): RequestRecord[] {
  return rows<RequestRow>(
    db
      .prepare('SELECT * FROM requests WHERE resolved_at IS NULL ORDER BY created_at ASC')
      .all(),
  ).map(toRequest);
}

export function openRequestsForAgent(db: Db, agentId: string): RequestRecord[] {
  return rows<RequestRow>(
    db
      .prepare(
        'SELECT * FROM requests WHERE agent_id = ? AND resolved_at IS NULL ORDER BY created_at ASC',
      )
      .all(agentId),
  ).map(toRequest);
}

export function setRequestBlockMode(db: Db, id: string, mode: BlockMode): void {
  db.prepare('UPDATE requests SET block_mode = ? WHERE id = ?').run(mode, id);
}

export function resolveRequest(db: Db, id: string, summary: DecisionSummary): void {
  db.prepare('UPDATE requests SET resolved_at = ?, decision = ? WHERE id = ?').run(
    nowIso(),
    JSON.stringify(summary),
    id,
  );
}

/**
 * The shape the attention queue renders. Joins in the names the card needs so
 * Track E never has to correlate three endpoints.
 */
export function pendingRequests(db: Db): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const r of openRequests(db)) {
    const agent = getAgent(db, r.agentId);
    const project = getProject(db, r.projectId);
    out.push({
      requestId: r.id,
      projectId: r.projectId,
      jobId: r.jobId,
      agentId: r.agentId,
      agentRole: agent?.role ?? 'builder',
      projectName: project?.name ?? r.projectId,
      kind: r.kind,
      blockMode: r.blockMode,
      createdAt: r.createdAt,
      toolName: r.toolName,
      input: r.input,
      matchedRule: r.matchedRule,
      reversible: r.reversible,
      cwd: r.cwd,
      suggestions: r.suggestions,
      questions: r.questions,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// session_rules  — persisted "allow always"
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleRecord {
  id: string;
  projectId: string;
  toolName: string;
  ruleContent: string | null;
  behavior: string;
  suggestion: PermissionSuggestion | null;
  createdAt: string;
  /** The agent whose request earned it. Null for rules from before Amendment 48. */
  agentId: string | null;
}

interface RuleRow {
  id: string;
  project_id: string;
  tool_name: string;
  rule_content: string | null;
  behavior: string;
  suggestion: string | null;
  created_at: string;
  agent_id: string | null;
}

const toRule = (r: RuleRow): RuleRecord => ({
  id: r.id,
  projectId: r.project_id,
  toolName: r.tool_name,
  ruleContent: r.rule_content,
  behavior: r.behavior,
  suggestion: r.suggestion ? parse<PermissionSuggestion | null>(r.suggestion, null) : null,
  createdAt: r.created_at,
  agentId: r.agent_id ?? null,
});

export function getRule(db: Db, id: string): RuleRecord | undefined {
  const r = row<RuleRow>(db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id));
  return r ? toRule(r) : undefined;
}

/** Forget one rule. Conductor's copy only — see session/rules.ts for the SDK's. */
export function deleteRule(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM session_rules WHERE id = ?').run(id).changes) > 0;
}

export function rulesForProject(db: Db, projectId: string): RuleRecord[] {
  return rows<RuleRow>(
    db.prepare('SELECT * FROM session_rules WHERE project_id = ? ORDER BY created_at, id').all(projectId),
  ).map(toRule);
}

export function insertRule(
  db: Db,
  r: { projectId: string; toolName: string; ruleContent: string | null; suggestion?: unknown; agentId?: string },
): void {
  db.prepare(
    `INSERT INTO session_rules (id, project_id, tool_name, rule_content, behavior, suggestion, created_at, agent_id)
     VALUES (?, ?, ?, ?, 'allow', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(
    newId('rule'),
    r.projectId,
    r.toolName,
    r.ruleContent,
    r.suggestion ? JSON.stringify(r.suggestion) : null,
    nowIso(),
    r.agentId ?? null,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// agent_runs — which SDK session to resume, and how the last run ended
// ─────────────────────────────────────────────────────────────────────────────

export interface DeferredTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function startRun(db: Db, agentId: string, sdkSessionId: string | null): string {
  const id = newId('run');
  db.prepare(
    `INSERT INTO agent_runs (id, agent_id, sdk_session_id, started_at) VALUES (?, ?, ?, ?)`,
  ).run(id, agentId, sdkSessionId, nowIso());
  return id;
}

export function finishRun(
  db: Db,
  runId: string,
  o: { sdkSessionId?: string | null; terminalReason?: string; deferredTool?: DeferredTool | null },
): void {
  db.prepare(
    `UPDATE agent_runs
        SET sdk_session_id = COALESCE(?, sdk_session_id),
            terminal_reason = ?,
            deferred_tool = ?,
            ended_at = ?
      WHERE id = ?`,
  ).run(
    o.sdkSessionId ?? null,
    o.terminalReason ?? null,
    o.deferredTool ? JSON.stringify(o.deferredTool) : null,
    nowIso(),
    runId,
  );
}

/**
 * The deferred call an agent is parked on, if any: its LAST run's, and only if that run
 * ended by deferring.
 *
 * This used to return the newest deferred call from any run, so one defer, ever, made
 * every later resume look like a defer. Those resume with no prompt at all, and a
 * session with nothing re-offered and nothing sent waits for input forever. A run that
 * ended `tool_deferred_unavailable` also names its call, and is not parked on it either.
 */
/**
 * Whether a human answered one of this agent's requests after its latest run began —
 * a decision that run never saw. It is what tells a queued agent that was answered
 * while every slot was taken from one that was woken from a pause (Amendment 35), and
 * it is kept in the rows, so it still holds after a restart has lost what the Arbiter
 * staged in memory.
 */
export function answeredSinceLastRun(db: Db, agentId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM requests
          WHERE agent_id = ? AND resolved_at IS NOT NULL
            AND json_extract(decision, '$.type') != 'expired'
            AND resolved_at > COALESCE((SELECT MAX(started_at) FROM agent_runs WHERE agent_id = ?), '')
          LIMIT 1`,
      )
      .get(agentId, agentId) !== undefined
  );
}

export function lastDeferredTool(db: Db, agentId: string): DeferredTool | null {
  const r = row<{ deferred_tool: string | null; terminal_reason: string | null }>(
    db
      .prepare(
        `SELECT deferred_tool, terminal_reason FROM agent_runs
          WHERE agent_id = ?
          ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(agentId),
  );
  if (r?.terminal_reason !== 'tool_deferred' || !r.deferred_tool) return null;
  return parse<DeferredTool | null>(r.deferred_tool, null);
}
