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
  DecisionSummary,
  Isolation,
  Job,
  PendingRequest,
  PermissionSuggestion,
  Project,
  ProjectNote,
  Question,
} from '@conductor/shared';
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
  created_at: string;
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
 * `defaultBranch` is not editable on purpose. It is captured once at
 * registration from whatever branch was checked out, nothing reads it, and a
 * field the UI can set but no code consults is worse than one it cannot.
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
 * Forget a project. One DELETE, because `PRAGMA foreign_keys = ON` and every
 * table Track A owns hangs off this row with ON DELETE CASCADE: jobs, agents,
 * requests, session_rules, agent_runs all go with it.
 *
 * Three things are deliberately NOT deleted:
 *  • `events` — append-only (CONTRACT §5.2). The log is the record of what
 *    happened, and what happened doesn't stop having happened.
 *  • `cost_daily` — the money was spent. A removal is not a refund.
 *  • anything on disk. Not this file's business, and not any caller's either.
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
 * refund; and nothing whatsoever on disk.
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
                       status, budget_usd, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
  );
  return job;
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
}

/** Used when a row predates a field, or carries unparseable JSON. */
export const DEFAULT_AUTONOMY: Autonomy = {
  mode: 'default',
  allowedTools: [],
  disallowedTools: [],
  budgetUsd: null,
};

const toAgent = (r: AgentRow): Agent => ({
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
});

/** The engine an agent runs on (Amendment 74). `claude` for every agent from before. */
export function getAgentProvider(db: Db, id: string): ProviderId {
  const r = row<{ provider: string | null }>(db.prepare('SELECT provider FROM agents WHERE id = ?').get(id));
  return isProvider(r?.provider) ? r.provider : 'claude';
}

// ── orchestrators and helpers (Amendment 51) ────────────────────────────────

export function helpersOf(db: Db, parentId: string): Agent[] {
  return rows<AgentRow>(
    db.prepare('SELECT * FROM agents WHERE parent_id = ? ORDER BY rowid').all(parentId),
  ).map(toAgent);
}

/** Helpers whose final reply hasn't been handed to their orchestrator yet. */
export function unreportedHelpers(db: Db, parentId: string): Agent[] {
  return rows<AgentRow>(
    db.prepare('SELECT * FROM agents WHERE parent_id = ? AND reported_at IS NULL ORDER BY rowid').all(parentId),
  ).map(toAgent);
}

export function markReported(db: Db, ids: string[]): void {
  const at = new Date().toISOString();
  const stmt = db.prepare('UPDATE agents SET reported_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(at, id);
}

export function setAgentDependsOn(db: Db, id: string, dependsOn: string[]): void {
  db.prepare('UPDATE agents SET depends_on = ? WHERE id = ?').run(JSON.stringify(dependsOn), id);
}

export function listAgents(db: Db): Agent[] {
  return rows<AgentRow>(db.prepare('SELECT * FROM agents').all()).map(toAgent);
}

export function getAgent(db: Db, id: string): Agent | undefined {
  const r = row<AgentRow>(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
  return r ? toAgent(r) : undefined;
}

export function agentsForJob(db: Db, jobId: string): Agent[] {
  return rows<AgentRow>(db.prepare('SELECT * FROM agents WHERE job_id = ?').all(jobId)).map(
    toAgent,
  );
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
  };
  db.prepare(
    `INSERT INTO agents (id, job_id, project_id, role, model, sdk_session_id, status,
                         block_mode, cost_usd, input_tokens, output_tokens,
                         depends_on, autonomy, brief, started_at, ended_at, helper_cap, parent_id,
                         persona, system_prompt, skills, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
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

/**
 * The day key for the cost rollup, in LOCAL time.
 *
 * Deliberately not `toISOString().slice(0,10)`: that is UTC, so a user in EDT
 * spending $1.25 at 20:00 would watch the status bar reset to $0.00 four hours
 * before their day ended. "Today" in a status bar means the human's today.
 */
export function localDay(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** Cumulative spend for a job, for the budget cap. */
export function jobCost(db: Db, jobId: string): number {
  const r = row<{ total: number }>(
    db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agents WHERE job_id = ?').get(jobId),
  );
  return r?.total ?? 0;
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
