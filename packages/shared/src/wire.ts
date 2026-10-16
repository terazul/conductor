/**
 * Wire types — REST request/response bodies and WebSocket frames.
 *
 * FROZEN CONTRACT (W0). Read-only for all tracks.
 *
 * Endpoint ownership (one route file per track, auto-globbed — no shared
 * route table to conflict on):
 *   W0        GET  /api/health                     routes/health.ts
 *   Track A   /api/projects /api/jobs /api/agents /api/requests
 *                                                 routes/session.ts
 *   Track C   /api/jobs/:jobId/{tree,file,diff}   routes/workspace.ts
 *   Track D   /api/jobs/:jobId/{servers,console}  routes/preview.ts
 *             /preview/:jobId/*  (reverse proxy)
 */

import type {
  AgentRole,
  AgentStatus,
  BlockMode,
  DaySpend,
  Decision,
  Event,
  PendingRequest,
} from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Domain entities
// ─────────────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the repo root. */
  path: string;
  defaultBranch: string;
  createdAt: string;
  /**
   * The project's directories after `path`, absolute, in the order they were added
   * (Amendment 39). Agents start in `path` and can reach these too; the Files screen
   * shows `path` and these, and nothing else. Absent from an older daemon.
   */
  extraDirs?: string[];
  /** Your notes on it, newest first (Amendment 55). Absent when there are none. */
  notes?: ProjectNote[];
}

/** A note you keep on a project, to track where you are (Amendment 55). */
export interface ProjectNote {
  id: string;
  projectId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** When it's due, as a local date `YYYY-MM-DD` (Amendment 63). Absent: no date. */
  due?: string;
  /** When it was ticked done. Absent: not done. */
  doneAt?: string;
}

/** The longest note the daemon takes. */
export const NOTE_MAX = 4000;

/**
 * Isolation for a job's writes.
 *
 * DECIDED (PLAN.md §11.1): one worktree per JOB, not per agent. Agents inside a
 * job are coordinated — sequential handoff, or disjoint file scopes enforced by
 * an Edit(path) deny rule. Worktree-per-agent makes merge conflicts the product;
 * a shared checkout corrupts silently.
 */
export type Isolation = 'worktree' | 'branch' | 'in_place';

export interface Job {
  id: string;
  projectId: string;
  /** The human's original instruction. */
  prompt: string;
  isolation: Isolation;
  /** Absolute path agents actually work in. Equals project.path for in_place. */
  worktreePath: string;
  branch: string;
  status: AgentStatus;
  createdAt: string;
  endedAt: string | null;
  /** Pause the job when cumulative cost crosses this. null = uncapped. */
  budgetUsd: number | null;
}

export interface Agent {
  id: string;
  jobId: string;
  projectId: string;
  role: AgentRole;
  model: string;
  /** SDK session id, once known. Needed for options.resume. */
  sdkSessionId: string | null;
  status: AgentStatus;
  blockMode: BlockMode | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Agent ids that must reach 'done' before this one starts. */
  dependsOn: string[];
  /**
   * How much rope this agent has. Amendment 7 — the `agents.autonomy` column and
   * the fixtures both carried this from the start, but the shared type did not,
   * so Track B had to read it defensively off an object the contract said had no
   * such field. The UI needs it to render the autonomy pills honestly.
   */
  autonomy: Autonomy;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * Amendment 51. How many helpers this agent may start — an orchestrator has one or more
   * — and, on a helper, the orchestrator that started it. Optional so recordings from
   * before still replay.
   */
  helperCap?: number;
  parentId?: string | null;
  /**
   * Amendment 74: the engine it runs on — `copilot` or `openrouter`. Absent is `claude`,
   * which every agent from before this is.
   */
  provider?: string;
  /**
   * Amendment 120. True while the agent is `done` but held for not handing off (Amendment
   * 104): it ended its turn without calling `hand_off`, so the agents after it have not
   * started. Present only when true, so every other agent's shape is what it was. It is what
   * `rerunPlan` reads to refuse a re-run, and what Fleet and the Project lane read to show
   * "not handed off".
   */
  handoffHeld?: boolean;
  /**
   * Amendment 128. The roles an orchestrated stack's orchestrator may start (`developer`,
   * `reviewer`, …), by id: it is what marks the agent as the orchestrator of an orchestrated
   * stack, on Fleet, the Project lanes and the Agent tabs. Present only on such an agent, so
   * every other agent's shape is what it was. The roles' system prompts and rope stay off the
   * wire, as a persona's do.
   */
  pipelineRoles?: string[];
  /**
   * Amendment 166. The headings its hand-off closes with, read from the system prompt it was
   * launched with (`closingHeadingsOf`): what `hand_off` checks its summary for, and what the
   * hand-off card in Needs You checks a person's draft for. Present only when there are some,
   * so every other agent's shape is what it was. The prompt itself stays off the wire.
   */
  closingHeadings?: string[];
  /**
   * Amendment 129. What the agent has spent TODAY, stamped with the day it is for: the figure
   * its budget (`autonomy.budgetUsd` or `budgetTokens`) is read against. `costUsd` stays the
   * agent's lifetime spend and is no longer what the budget counts. `agentBudget` (budget.ts)
   * reads this when the stamp is the day the caller passes and reads 0 when it is older, so
   * a page left open past midnight shows a renewed budget before the daemon says a word.
   * Absent reads as 0: an agent from before this, or a recording, has spent nothing today.
   */
  spentToday?: DaySpend;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawning work  (Track A · screen 7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How hard the model thinks. The SDK's own `EffortLevel`, mirrored rather than
 * reinterpreted — `'high'` is its default and ours.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How much rope an agent gets. Maps onto SDK permission options. */
export interface Autonomy {
  /** SDK permissionMode. */
  mode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto';
  /** SDK allowedTools. */
  allowedTools: string[];
  /** SDK disallowedTools. Survives every mode — the real safety net. */
  disallowedTools: string[];
  /**
   * The agent's budget in dollars, PER DAY (Amendment 129): what it may spend today before it
   * is warned, and twice that stops it. It went back to zero at midnight; it was a lifetime
   * cap before (Amendments 77, 124).
   */
  budgetUsd: number | null;
  /**
   * Amendment 77: the same budget in input plus output tokens, per day since Amendment 129
   * (it was a lifetime cap), for an engine that can't say what a run cost in dollars
   * (`ProviderInfo.capabilities.costUsd` false). Such an agent takes this and not `budgetUsd`;
   * a Claude agent takes `budgetUsd` and not this. Optional, so absent is uncapped and every
   * agent from before it reads as it did.
   */
  budgetTokens?: number | null;
  /**
   * SDK `effort`. Optional because agents created before this field existed have no
   * value stored, and absent must keep meaning "whatever the SDK defaults to" rather
   * than silently becoming 'low'.
   */
  effort?: EffortLevel;
  /**
   * "Merge into main and clean up when done" (Amendment 144). When its job, isolated in a
   * worktree of its own, settles `done` with its branch ahead of the target, and the merge
   * would be clean: the branch is merged, then the job, its folder and its branch are removed
   * (Amendment 143's `delete` with `forgetJob`; the transcripts stay). Off, or when the merge
   * can't run by itself, Needs You offers it instead. Optional; absent is off.
   */
  mergeWhenDone?: boolean;
}

export interface AgentSpec {
  role: AgentRole;
  model: string;
  /** Extra instruction appended to the job prompt for this role. */
  brief?: string;
  /** Roles that must finish first. Resolved to agent ids on creation. */
  dependsOnRoles?: AgentRole[];
  autonomy: Autonomy;
  /**
   * Put several agents on this role (Amendment 51): this one orchestrates, and may start
   * up to this many helpers. 0 or absent for an ordinary agent; at most HELPERS_MAX, or with
   * `helperRoles` (Amendment 128) at least 1 and at most PIPELINE_HELPERS_MAX (Amendment 151).
   * Spawn sends `pipelineHelperCap` for those unless the launch chose another number.
   */
  helpers?: number;
  /**
   * From its persona (Amendment 68). `persona` is the persona's id, for the record.
   * `systemPrompt` is appended to Claude Code's own; `skills` are the skills its session
   * may use, preloaded — absent means Claude Code's defaults. All three are kept on the
   * agent, so a resume or a wake runs with what it launched with.
   */
  persona?: string;
  systemPrompt?: string;
  skills?: string[];
  /** The engine (Amendment 74): `claude` (the default), `copilot` or `openrouter`. */
  provider?: string;
  /**
   * Amendment 128. Makes this agent the orchestrator of an orchestrated stack: the roles it
   * may start, each with what a helper of that role runs with. `start_helper` takes one of
   * their ids as its `role`, and refuses any other. Needs `helpers` above 0, which is how many
   * helpers it may start in all, send-backs included (`pipelineHelperCap` unless the launch chose
   * another, up to PIPELINE_HELPERS_MAX). Send-backs are counted per lane: a role and the `name`
   * `start_helper` was given (Amendment 151).
   */
  helperRoles?: HelperRole[];
}

/**
 * One role an orchestrated stack's orchestrator may start (Amendment 128), as Spawn resolved it
 * at launch. Copied into the orchestrator's row, as a persona's fields are copied into an
 * agent's, so a later edit of a persona or a tier changes nothing about a stack that is running.
 */
export interface HelperRole {
  /** The role's name, which is its persona's id: `developer`. Lowercase letters, digits and dashes. */
  id: string;
  /** The tier it was listed on, when the engine has tiers (Claude). Spawn lets you change it per role. */
  tier?: ModelTier;
  /** The exact model id its helpers run on: what the tier meant at launch. */
  model: string;
  /** What the role is for, from its persona: part of every helper's brief. */
  brief?: string;
  /** The persona's system prompt and skills, which its helpers run with (Amendment 68, 126). */
  systemPrompt?: string;
  skills?: string[];
  /**
   * Its rope, pinned the way Spawn pins that role: a reading role has the write tools denied and
   * nothing auto-approved. The daemon checks it with `readOnlyRefusal` when it is launched and
   * again when a helper is started.
   */
  autonomy: Autonomy;
  /**
   * What each tier meant at launch, so the orchestrator can ask for a cheaper one than listed
   * (`start_helper`'s `tier`). Absent on an engine without tiers.
   */
  tiers?: Partial<Record<ModelTier, string>>;
}

export const HELPERS_MAX = 8;

/** What GET /api/providers says about each engine (Amendment 74). */
export interface ProviderInfo {
  id: string;
  /** Null when it can launch agents; otherwise why not (no login, no key, not built). */
  unavailable: string | null;
  capabilities: {
    defer: boolean;
    resume: boolean;
    costUsd: boolean;
    effort: boolean;
    planMode: boolean;
    helperTools: boolean;
  };
}

export interface CreateJobRequest {
  projectId: string;
  prompt: string;
  isolation: Isolation;
  /** Preset name for the UI's benefit; the daemon only reads `agents`. */
  preset?: string;
  agents: AgentSpec[];
  budgetUsd?: number | null;
  /**
   * Methodology (2), "new branch: <name>" (Amendment 115): the branch the job's worktree is
   * on. Only with `isolation: 'worktree'`; absent, it is `conductor/<jobId>` as before.
   */
  branch?: string;
}

export interface CreateJobResponse {
  job: Job;
  agents: Agent[];
}

/**
 * `POST /api/jobs/:jobId/agents` (Amendment 89): one more agent in a job that is already
 * running, or finished (it reopens). The spec is checked as a launch's is, and
 * `dependsOnRoles` names roles already in the job. `feeds` names roles of agents in the job
 * that haven't started (queued, no session) that should now wait for this one as well —
 * inserting it in the middle.
 */
export interface AddAgentRequest extends AgentSpec {
  feeds?: AgentRole[];
}

export interface AddAgentResponse {
  agent: Agent;
  /** The agents named in `feeds`, now waiting for it too. */
  fed: Agent[];
}

/**
 * What `DELETE /api/agents/:id` did (Amendment 88). The agent is removed from the stack:
 * each agent that waited on it and hadn't started now waits on what it waited on
 * (`rewireOnRemoval`, stack.ts). `rewired` lists them with their new `dependsOn`.
 */
export interface RemoveAgentResponse {
  removed: string;
  rewired: { agentId: string; dependsOn: string[] }[];
}

export interface CreateProjectRequest {
  /** The MAIN folder: where agents work, and where worktrees are cut. */
  path: string;
  name?: string;
  /**
   * REFERENCED folders, added with the project in one step (Amendment 45). Agents can
   * read and edit them in place; they become `Project.extraDirs`. Every one is checked
   * before anything is created, so a typo in the third refuses the whole project rather
   * than leaving half of one behind.
   */
  dirs?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Driving a live agent  (Track A · screens 3, 4)
// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessageRequest {
  text: string;
  synthetic?: boolean;
}

/**
 * POST /api/agents/:agentId/message. `sent` into a live run; `resumed` a finished or parked one
 * in a free slot; `queued` with every slot taken (Amendment 168): it waits as a `slot`
 * scheduled message, and goes when one frees.
 */
export interface SendMessageResponse {
  ok: true;
  delivery: 'sent' | 'resumed' | 'queued';
}

/**
 * Hand off for an agent that ended its turn without calling `hand_off` (Amendment 104):
 * the summary the agents after it are told, edited by the person.
 */
export interface HandOffRequest {
  summary: string;
}

/** The longest summary an agent or a person can hand off with, in characters. */
export const HANDOFF_SUMMARY_MAX = 20_000;

/**
 * The note on the `done` status event of an agent that ended its turn without handing off
 * (Amendment 104). The transcript reads it, so the two sides say it the same way.
 */
export const HANDOFF_HELD_NOTE = 'stopped without handing off';

/** The note on the `done` status event written when a person handed off for it. */
export const HANDOFF_BY_USER_NOTE = 'handed off by you';

export interface DecideRequest {
  decision: Decision;
}

export interface SetAutonomyRequest {
  autonomy: Partial<Autonomy>;
}

export interface SetAutonomyResponse {
  autonomy: Autonomy;
  /**
   * 'now' when a live run took everything the change made: its permission mode and effort;
   * else 'next run' (Amendment 176). The tool lists and the budget are always the next run's,
   * so a change to them is 'next run' even when the mode or effort in it went live.
   */
  appliesTo: 'now' | 'next run';
}

/**
 * Nicknames Claude Code resolves through `~/.claude/settings.json`. Conductor does not
 * store them: an agent keeps the exact id it was given, so what it runs on cannot change
 * under it when a setting or a gateway changes (Amendment 40). The daemon refuses these
 * as a model and says what each currently means.
 */
export const MODEL_NICKNAMES = ['default', 'best', 'opus', 'sonnet', 'haiku', 'opusplan'] as const;

/**
 * The class of model a preset wants for a role. Presets name a tier, not an id, because
 * ids differ per deployment; Spawn turns the tier into the exact id the catalog says it
 * means at launch, and that id is what the agent keeps.
 */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface ModelOption {
  /** The exact id, passed to the SDK as `model` and stored on the agent. */
  id: string;
  /** A name for people: Claude Code's ("Opus 5.5") when it knows the model, else the id. */
  label: string;
  /** A Claude model. Anything else is served by the gateway but may not handle Claude Code's tools. */
  claude: boolean;
  /** The effort levels Claude Code says it takes, when Claude Code knows the model. */
  effortLevels?: EffortLevel[];
}

/** GET /api/models — what an agent can be given (Amendment 40). */
export interface ModelCatalog {
  /** Claude models first, in Claude Code's order; the rest by id. */
  models: ModelOption[];
  /** The exact id each tier means right now, when that model is in `models`. */
  tiers: Partial<Record<ModelTier, string>>;
  /**
   * Where `models` came from. 'gateway': the model API's own list of what it serves.
   * 'claude-code': the API could not be asked, so this is Claude Code's list, which
   * says what your settings name rather than what is live. 'none': neither answered.
   */
  source: 'gateway' | 'claude-code' | 'none';
  /** The API host that was asked. */
  host?: string;
  /** Why a source did not answer, in words. */
  note?: string;
  fetchedAt: string;
}

/**
 * GET /api/models?provider=<id> for any provider but `claude` (Amendment 78), whose
 * answer stays the ModelCatalog above. Ids are free-form — `anthropic/claude-sonnet-4.5`
 * on OpenRouter — and are kept exactly; the opus/sonnet/haiku tiers are Claude's alone.
 */
export interface ProviderModelList {
  provider: string;
  /** What the provider says it offers, in its order. Empty when it couldn't be asked. */
  models: { id: string; displayName: string; efforts?: string[] }[];
  /** Why the list is empty or partial, in words. Never a stack trace, never a key. */
  note?: string;
  fetchedAt: string;
}

export interface SetModelRequest {
  /** An exact id from GET /api/models — `?provider=` the agent's, when it isn't Claude. */
  model: string;
}

export interface SetModelResponse {
  model: string;
  /** 'now' when a live run switched for its next reply; else from the next run. */
  appliesTo: 'now' | 'next run';
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace  (Track C · screen 5)
// ─────────────────────────────────────────────────────────────────────────────

export interface FileNode {
  /** Worktree-relative POSIX path. */
  path: string;
  name: string;
  type: 'file' | 'dir';
  children?: FileNode[];
  /**
   * Populated when an agent has touched it this session. `deleted` (Amendment 29)
   * marks a path the tree keeps listing because its deletion is a change to review.
   */
  change?: { added: number; removed: number; created: boolean; at: string; deleted?: true };
  /** Set on a directory that is its own git repo: a nested clone or a submodule (Amendment 90). */
  repo?: { branch: string | null };   // null: detached HEAD, or no commits yet
}

export interface FileTreeResponse {
  root: FileNode;
  changedFiles: number;
  added: number;
  removed: number;
  /**
   * Set when the tree hit its entry cap and was cut short — the number of
   * entries omitted. The UI must show this; silent truncation in a file browser
   * makes someone believe a file does not exist.
   *
   * Added in Amendment 4. Track C had been smuggling the notice through as a
   * tree node with a NUL byte in its path (unopenable by construction, since
   * path validation rejects NUL before any fs call). That worked, but it was an
   * undocumented convention spanning two packages with no shared constant —
   * exactly what a later refactor deletes without knowing why it was there.
   */
  truncated?: number;
}

export interface FileContentResponse {
  path: string;
  /** Raw file text. */
  raw: string;
  /** Sanitized HTML, present only for markdown. */
  html?: string;
  /** Unified diff against HEAD, when the file is dirty. */
  diff?: string;
  /** ISO timestamp of last write, and which agent did it if known. */
  lastWriteAt?: string;
  lastWriteBy?: string;
  /**
   * The file is gone from the worktree, and `raw` is git's last copy of it — the
   * index's, else HEAD's. Amendment 29: before it, opening a deleted file that the
   * tree still listed was a 404, which reads as the viewer being broken.
   */
  deleted?: true;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  /**
   * Make a new file and refuse to replace one (Amendment 121). With it set, a name that
   * is taken, whether by a file, a folder or a link, is a 409 whose sentence ends
   * "already exists", and nothing is written. Without it the write replaces the file, as
   * editing always has. Missing folders are still made.
   */
  createOnly?: boolean;
}

/**
 * The rest of the verbs on a root (Amendment 138): a job's worktree at
 * `/api/jobs/:jobId/…`, or a project folder at `/api/projects/:projectId/dir/…?dir=`.
 * Every path is root-relative and crosses the same gate as a write: `..`, an absolute
 * path and anything under `.git` are a 400, and so is the root itself.
 *
 *   POST   …/folders              ← CreateFolderRequest → CreateFolderResponse (201)
 *   POST   …/rename               ← RenameRequest       → RenameResponse
 *   GET    …/entry?path=          → EntryResponse
 *   DELETE …/entry?path=[&recursive=1] → DeleteEntryResponse
 */
export interface CreateFolderRequest {
  /** Missing folders above it are made too. Anything already at the path is a 409. */
  path: string;
}

export interface CreateFolderResponse {
  /** The daemon's spelling of the path. */
  path: string;
}

export interface RenameRequest {
  /** A file or a folder. Missing is a 404. */
  from: string;
  /**
   * Taken is a 409, except by `from` itself under another case on a case-insensitive
   * filesystem (`readme.md` → `README.md`), which is a rename. A folder into itself is a 400.
   */
  to: string;
}

export interface RenameResponse {
  from: string;
  to: string;
  type: 'file' | 'dir';
}

/** What a delete would take, so the confirm can name it before anything goes. */
export interface EntryResponse {
  path: string;
  type: 'file' | 'dir';
  /** Files under it on disk, ignored ones included (1 for a file). */
  files: number;
  /** Folders under it, not counting itself. */
  folders: number;
  /** The count stopped at the daemon's ceiling: there are at least `files`. */
  capped?: true;
  /** How many of those files git tracks. Null when the root is not a git repo. */
  tracked: number | null;
}

export interface DeleteEntryResponse {
  path: string;
  type: 'file' | 'dir';
  /** Files that went with it (1 for a file). */
  files: number;
}

export interface DiffResponse {
  /** Unified diff for the whole worktree against HEAD. */
  diff: string;
  added: number;
  removed: number;
  files: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview  (Track D · screen 6)
// ─────────────────────────────────────────────────────────────────────────────

export interface DevServer {
  jobId: string;
  port: number;
  pid: number | null;
  /**
   * Which loopback family the server actually answered on.
   *
   * Added in Amendment 6. Dev servers frequently bind only `::1`: `localhost`
   * resolves to both families on macOS and the server picks one. An IPv4-only
   * probe then reports "no dev server" for a server that is serving perfectly —
   * indistinguishable from the frame-blocking failure this whole feature exists
   * to fix. Track D hit it mid-build; I reproduced it in my own verification
   * minutes after reading the report, and drew exactly the wrong conclusion
   * until I checked both families.
   *
   * Never hardcode `127.0.0.1` when probing or dialling. Probe both, remember
   * which answered, use that one.
   */
  host: '127.0.0.1' | '::1';
  /** Path served through the daemon's own origin — iframe THIS, not localhost:port.
   *  Cross-origin iframes break on X-Frame-Options; the proxy strips them. */
  proxyPath: string;
  startedByAgentId: string | null;
  detectedAt: string;
  alive: boolean;
}

export interface DevServersResponse {
  servers: DevServer[];
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  text: string;
  at: string;
}

export interface PostConsoleRequest {
  entries: ConsoleEntry[];
}

/** Persisted console history for a job's preview. */
export interface ConsoleLogResponse {
  entries: ConsoleEntry[];
}

/** "Send these errors to the agent" — becomes a synthetic user turn. */
export interface SendConsoleToAgentRequest {
  agentId: string;
  entries: ConsoleEntry[];
}

/**
 * Amendment 6. Track D invented this shape because the contract froze the
 * request and not the response, then reported it rather than leaving an
 * undeclared type on the wire.
 *
 * `delivered: false` is the honest outcome while the receiving endpoint is
 * absent — it returns the composed `text` so the UI can show what *would* have
 * been sent instead of throwing, and can't imply an agent was told something it
 * never received.
 */
export interface SendConsoleToAgentResponse {
  delivered: boolean;
  /** How many entries were included. */
  count: number;
  /** The composed user turn, so the UI can show it either way. */
  text: string;
  /** Why it wasn't delivered, when it wasn't. */
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts — what needs a person that is not a tool call (Amendment 28, F10 + F13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 *  - 'failed':      an agent ended `failed`. `cause` is the terminal reason.
 *  - 'budget':      an agent stopped on its cap (`budget_exhausted`) or its job's
 *                   (`job_budget_reached`). The caps are per day since Amendment 129, and
 *                   `renewed` says a new day has renewed it.
 *  - 'connection':  the model API is unreachable or refusing the login, or the retries
 *                   ran out. `cause` is a RetryCause. One alert per outage, not per agent.
 *  - 'server_down': a dev server stopped answering and nobody asked it to stop.
 *  - 'blocked_dep': a queued agent is waiting on one that failed or was stopped
 *                   (Amendment 85). `agentIds` is the waiting agent, `blockedBy` the one
 *                   it waits on, and `cause` that one's status. It stays queued, so it
 *                   still starts if the other is continued and finishes.
 *  - 'handoff_held': an agent that others wait for ended its turn without calling
 *                   `hand_off` (Amendment 104). It is `done` and the agents after it stay
 *                   queued until you hand off for it or it hands off itself. `agentIds` is
 *                   the held agent.
 *  - 'reconnecting': the model couldn't be reached and the agent is waiting to be tried
 *                   again (Amendment 123). `agentIds` is that agent, `cause` a RetryCause,
 *                   `attempt` of `maxRetries` this retry, and `retryAt` when it happens.
 *                   Held in memory, like a connection alert. It clears when the try starts.
 *  - 'budget_over': an agent, or its job, is past its budget and still working
 *                   (Amendment 124). A warning: nothing is paused, and it stops only at
 *                   twice the budget. `cause` is 'budget_over' for an agent (`agentIds` is
 *                   it) or 'job_budget_over' for a job (`jobId`, no `agentIds`), `spent`
 *                   and `budget` are in `unit`.
 */
export type AlertKind =
  | 'failed'
  | 'budget'
  | 'connection'
  | 'server_down'
  | 'daily_budget'
  | 'note_due'
  | 'blocked_dep'
  | 'handoff_held'
  | 'reconnecting'
  | 'budget_over'
  /** A worktree job finished with its branch ahead of the target: merge it? (Amendment 144) */
  | 'finished'
  /** A finished job's branch was merged by itself, and cleaned up (Amendment 144). Information only. */
  | 'merged';

/**
 * Not a PendingRequest: a pending request is a tool call waiting for approve or deny,
 * with a requestId, a toolName and a blockMode, and an outage has none of those.
 *
 * Failures, budget stops and dead servers are derived from what is stored, so a reload
 * or a daemon restart can't lose one; only a dismissal is stored. Connection alerts are
 * held in memory, because they describe the present.
 */
export interface Alert {
  /** Stable for one occurrence. The same agent failing again gets a new id. */
  id: string;
  kind: AlertKind;
  cause: string;
  /** Null for a connection alert, which can span projects. */
  projectId: string | null;
  jobId: string | null;
  /** Who is affected. Empty for a dev server nobody is recorded as starting. */
  agentIds: string[];
  since: string;
  /** connection: the host from ANTHROPIC_BASE_URL, when the daemon can read one. */
  endpoint?: string;
  /** connection: the latest attempt across the affected agents, and the SDK's cap. reconnecting: this retry, of how many. */
  attempt?: number;
  maxRetries?: number;
  /** connection: every affected agent's run has ended, so retrying needs you. */
  gaveUp?: boolean;
  /** server_down */
  port?: number;
  /** note_due (Amendment 63): the note, its text, its due date, and whether it's late. */
  noteId?: string;
  noteText?: string;
  due?: string;
  late?: boolean;
  /** daily_budget (Amendment 59): today's spend, and the budget it reached. */
  spent?: number;
  budget?: number;
  /** failed: what the SDK said, from the status event's `detail`. */
  detail?: string;
  /**
   * blocked_dep (Amendment 85): the agent being waited on. Not in `agentIds`, so it isn't
   * counted twice: its own failure already has an alert.
   */
  blockedBy?: string;
  /** reconnecting (Amendment 123): when the next try starts, as an ISO time. */
  retryAt?: string;
  /** budget_over (Amendment 124): what `spent` and `budget` count. Absent is dollars. */
  unit?: 'usd' | 'tokens';
  /**
   * budget (Amendment 129): the new day renewed this agent's budget while it was paused at the
   * ceiling. It is still paused, since nothing resumes by itself, and continue needs no raise.
   * Present only when true.
   */
  renewed?: boolean;
  /**
   * finished and merged (Amendment 144): the job's branch, the branch it goes into, and how
   * many commits it had that one lacked when the job finished. finished: `detail` says why it
   * wasn't merged by itself, when the agent's setting asked for that.
   */
  branch?: string;
  into?: string;
  ahead?: number;
  /** merged: the merge commit. */
  sha?: string;
  /** merged: the job, its folder and its branch were removed too. When false, `detail` says why not. */
  cleaned?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot — what a fresh page load needs before the feed takes over
// ─────────────────────────────────────────────────────────────────────────────

export interface Snapshot {
  projects: Project[];
  jobs: Job[];
  agents: Agent[];
  pending: PendingRequest[];
  servers: DevServer[];
  /** Amendment 28. */
  alerts: Alert[];
  /** Highest seq included. Subscribe with `since` = this. */
  seq: number;
  /** Daemon-wide facts for the status bar. */
  slots: { used: number; total: number };
  costToday: number;
  /**
   * Amendment 146: everything the fleet has spent, every day `cost_daily` has counted, summed.
   * It keeps what removed agents and projects spent. Optional, so a daemon or a recording from
   * before it still renders (as today's figure alone).
   */
  costTotal?: number;
  /** Amendment 146: each project's spend today and over its whole life. Optional for the same reason. */
  projectSpend?: ProjectSpend[];
  /** Amendment 46. Optional so a recording made before it still replays. */
  settings?: Record<string, string>;
  /** Amendment 111: messages waiting for their time. Optional for the same reason. */
  scheduled?: ScheduledMessage[];
}

/**
 * Amendment 146. What one project's agents spent, today and since Conductor started counting:
 * read from `project_spend_daily`, which nothing removes when an agent or a job is removed, so a
 * total does not fall when one goes. Dollars for engines that report them; tokens (input plus
 * output) for engines that don't, as `DaySpend` counts them. Today is the daemon's local day.
 */
export interface ProjectSpend {
  projectId: string;
  today: number;
  total: number;
  tokensToday: number;
  tokensTotal: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling  (Amendment 111)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The setting that pauses everything until a time: an ISO instant, or absent. Set, and in
 * the future, nothing starts by itself and every working agent is paused; at the time,
 * they carry on. The daemon removes it once it has passed.
 */
export const PAUSE_UNTIL_KEY = 'conductor.pauseUntil';

/**
 * What sends a scheduled message (Amendment 157): its time; its agent's turn ending as `done`
 * (one per turn, oldest first; a question, a failure or a pause don't count); or a free slot
 * (Amendment 168), for a message sent while every slot was taken, which only the daemon writes.
 */
export type ScheduleTrigger = 'at' | 'done' | 'slot';

/** A message to send an agent at a time. Gone once it is sent: the transcript has it then. */
export interface ScheduledMessage {
  id: string;
  agentId: string;
  /** When to send it, ISO. Chosen in the browser's local time. For a `trigger` other than `at`, when it was made. */
  at: string;
  /** What sends it (Amendment 157). `at` for every message made before there was a choice. */
  trigger: ScheduleTrigger;
  text: string;
  createdAt: string;
  /** Why it could not be sent, once it was due; null while it waits. It is not tried again. */
  error: string | null;
}

/** POST /api/agents/:agentId/scheduled. `at` is required unless `trigger` is `done` (Amendment 157). */
export interface ScheduleMessageRequest {
  at?: string;
  /** Default `at`. `slot` is refused: only the daemon makes one (Amendment 168). */
  trigger?: ScheduleTrigger;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branches  (Amendment 109, ADR 0008)
// ─────────────────────────────────────────────────────────────────────────────

/** One commit on a branch that its target doesn't have. */
export interface BranchCommit {
  sha: string;
  subject: string;
  /** ISO. */
  at: string;
}

/** A local branch of a project's repo, as it stands against the project's default branch. */
export interface BranchInfo {
  /** 'conductor/job_…', 'main', 'feature/x'. */
  name: string;
  /** Its tip's sha. */
  head: string;
  /** Its tip commit's subject and time (ISO). */
  subject: string;
  at: string;
  /** The project's `defaultBranch`: what "merge into main" merges into. */
  isTarget: boolean;
  /** Commits on it that the target doesn't have, and the other way round. */
  ahead: number;
  behind: number;
  /** The merge-base with the target; null when they share no history. */
  forkedAt: string | null;
  /** target..branch, newest first, at most 20. */
  commits: BranchCommit[];
  /** Where it is checked out, with the files changed there and not committed (untracked too). */
  worktree: { path: string; uncommitted: number } | null;
  /** Set when it is a known job's branch. */
  jobId: string | null;
  /** An agent on that job is working, blocked or queued: every action on it is refused. */
  live: boolean;
  /** Its upstream, and how far it is ahead of and behind it. Null when it has none. */
  upstream: { ref: string; ahead: number; behind: number } | null;
  /**
   * Set when Conductor rebased it while it had an upstream, and it has diverged from that
   * upstream since (N3): its next push needs a force, which Conductor never does.
   */
  rebased?: true;
}

/**
 * Where the branch everything is drawn against came from (Amendment 113): the one you chose
 * on the screen, origin's default (`origin/HEAD`), the one recorded when the project was
 * added, `main` or `master`, or whatever the repo has checked out.
 */
export type BranchTargetSource = 'chosen' | 'origin' | 'project' | 'main' | 'head';

/** The setting that holds the branch you chose to compare with, per project (Amendment 113). */
export const branchTargetKey = (projectId: string): string => `conductor.branchTarget.${projectId}`;

export interface BranchesResponse {
  projectId: string;
  /**
   * The branch everything is drawn against, and what "merge all" merges into. Always one
   * that exists, when the repo has any branch at all (Amendment 113).
   */
  target: string;
  /** Where `target` came from. Optional for a daemon from before Amendment 113. */
  targetFrom?: BranchTargetSource;
  /** 'origin' when the repo has it, else null. */
  remote: string | null;
  /** Where a merge into the target would run, and whether it has no tracked changes. */
  targetCheckout: { path: string; clean: boolean } | null;
  /** The target first, then by tip time, newest first. */
  branches: BranchInfo[];
  /** What the project's own folder has checked out (Amendment 117); null when detached. */
  rootBranch?: string | null;
  /**
   * Whether `rootBranch`'s checkout — the project's own folder — has no tracked changes
   * (Amendment 117, added by lane D beyond `rootBranch` above: the screen's "make default
   * and check out" needs this and `rootLive` to say why it's disabled before it tries).
   * Absent when the folder couldn't be read.
   */
  rootClean?: boolean;
  /**
   * Whether an `in_place` or `branch` job of this project currently has a live agent
   * (Amendment 117, same addition as `rootClean`): checking out in the folder would be
   * refused while this is true.
   */
  rootLive?: boolean;
  /**
   * Branches origin has (as last fetched) that have no local branch of the same name, by
   * name, sorted; `origin/HEAD` left out (Amendment 139). Spawn's branch picker lists them
   * as "on origin": a named launch on one tracks it. Absent from a daemon from before.
   */
  remoteOnly?: string[];
  /**
   * The repo this listing is of (N4): absolute, as `?repo=` takes it. Absent from a daemon
   * from before, which only ever listed the project's own folder.
   */
  repo?: string;
  /**
   * Every repo of the project the screen can open (N4), the project's own folder first:
   * that folder, the extra directories that are repos, and the repos nested in either up to
   * four deep — the repos Files shows. Absent from a daemon from before.
   */
  repos?: BranchRepoChoice[];
}

/** One repo the Branches screen can open (N4). */
export interface BranchRepoChoice {
  /** Absolute: what `?repo=` takes. */
  path: string;
  /** How the picker names it: the folder's name, then the path inside it for a nested repo. */
  name: string;
  /** The project's own folder: the only one with a default branch and a chosen target. */
  main: boolean;
}

export type BranchAction =
  /** `into` is any local branch; absent, the target (Amendment 110). */
  | { action: 'merge'; branch: string; into?: string }
  | { action: 'merge_all' }
  | { action: 'commit'; branch: string; message: string }
  | { action: 'push'; branch: string }
  | { action: 'fetch' }
  /**
   * Bring a branch up to its upstream (N3): fetch its remote, then `merge --ff-only` in its
   * worktree. Refused while an agent is on it, it isn't checked out, it has tracked changes,
   * it has no upstream, it isn't behind, or it has diverged ("merge or rebase").
   */
  | { action: 'pull'; branch: string }
  /**
   * Rebase a branch onto `onto` (N3), the target when absent, in its worktree. On a conflict
   * the rebase is aborted and the files are reported. A branch with an upstream may be
   * rebased; its next push then needs a force, which Conductor never does (`rebased`).
   */
  | { action: 'rebase'; branch: string; onto?: string }
  /**
   * Make `branch` the project's default (Amendment 117), and with `checkout`, switch the
   * project's own folder to it. Refused while the folder has tracked changes or anything
   * works in it.
   */
  | { action: 'set_default'; branch: string; checkout: boolean }
  /**
   * Remove a branch that is merged into the target, and its worktree (Amendment 143):
   * `git worktree remove` (never forced), `worktree prune`, `git branch -d` (never `-D`).
   * Refused while its folder has changes, an agent is on it, or it is the target or the
   * project folder's. A job that owns it keeps it unless `forgetJob`: that job is removed
   * first, as DELETE /api/jobs/:jobId does, and its transcripts stay. Remotes are never touched.
   */
  | { action: 'delete'; branch: string; forgetJob?: boolean }
  /** `delete` for every merged branch, oldest tip first; what was refused is listed as kept (Amendment 143). */
  | { action: 'clean_merged'; forgetJobs?: boolean };

export interface BranchActionResult {
  ok: boolean;
  /** In order, for merge and merge_all. */
  merged: string[];
  /** The branch a merge went into, for merge: the target unless `into` named another. For rebase, what it went onto. */
  into?: string;
  /** The merge (or rebase) stopped here and was aborted cleanly. */
  conflict?: { branch: string; files: string[] };
  /** The new commit, for commit and merge; the branch's new tip, for pull and rebase. */
  sha?: string;
  /** Git's own words, trimmed, for push, fetch, pull and rebase. */
  output?: string;
  /** The branches removed, in order, for delete and clean_merged (Amendment 143). */
  removed?: string[];
  /** The merged branches clean_merged left, each with the sentence `delete` refused it with. */
  kept?: { branch: string; why: string }[];
  /** The jobs removed first because `forgetJob(s)` was set; their transcripts stay. */
  forgotJobs?: string[];
  /** The state after, so the screen redraws once. */
  branches: BranchesResponse;
}

/**
 * What merging `branch` into `into` would do, worked out without touching any checkout
 * (Amendment 110): `GET /api/projects/:projectId/branches/preview?branch=&into=`.
 */
export interface BranchMergePreview {
  branch: string;
  into: string;
  /** Commits on `branch` that `into` doesn't have, and the other way round. */
  ahead: number;
  behind: number;
  /** into..branch, newest first, at most 20. */
  commits: BranchCommit[];
  /** The files the merge would conflict in: [] for none, null when this git can't tell beforehand. */
  conflicts: string[] | null;
  /** Why the merge would be refused, in the words the POST would use; null when it would run. */
  reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket frames
// ─────────────────────────────────────────────────────────────────────────────

export type ClientFrame =
  /** Sent immediately on open. Server replays everything after `since`. */
  | { type: 'subscribe'; since: number }
  | { type: 'ping' };

export type ServerFrame =
  | { type: 'hello'; seq: number; snapshot: Snapshot }
  /** Ordered, contiguous, ascending by seq. */
  | { type: 'events'; events: Event[] }
  /** Entities changed in a way the event log doesn't fully describe. */
  | { type: 'entities'; jobs?: Job[]; agents?: Agent[]; projects?: Project[] }
  | { type: 'pending'; pending: PendingRequest[] }
  | { type: 'servers'; servers: DevServer[] }
  /** The whole list, each time it changes (Amendment 28). */
  | { type: 'alerts'; alerts: Alert[] }
  /** The whole settings map, each time it changes (Amendment 46). */
  | { type: 'settings'; settings: Record<string, string> }
  /**
   * Today's spend, each time it grows (Amendment 59). It used to arrive only with a snapshot.
   * Amendment 146 adds the fleet's all-time total and each project's today and total, optional
   * so a page from before reads the frame as it did.
   */
  | { type: 'cost'; costToday: number; costTotal?: number; projectSpend?: ProjectSpend[] }
  /** Slots in use and the limit, each time either changes (Amendment 47). */
  | { type: 'slots'; slots: { used: number; total: number } }
  /** A terminal command started, or ended (Amendment 58). */
  | { type: 'terminal_run'; run: TerminalRun }
  /** Output from a terminal command, batched. */
  | { type: 'terminal_out'; agentId: string; runId: string; stream: 'out' | 'err'; text: string }
  /** A project's branches changed through the Branches screen (Amendment 109). */
  | { type: 'branches'; projectId: string }
  /** Amendment 111: every scheduled message, whenever one is added, sent, fails or is cancelled. */
  | { type: 'scheduled'; scheduled: ScheduledMessage[] }
  /**
   * Amendment 141: one scope's terminals, whole, whenever one is opened, exits or is closed,
   * so a terminal opened in one browser tab is listed in the others. Never carries output.
   */
  | { type: 'terminals'; scope: TermScope; terminals: TermInfo[] }
  /** The gap was too large to replay — client should refetch the snapshot. */
  | { type: 'resync' }
  | { type: 'pong' };

// ─────────────────────────────────────────────────────────────────────────────
// A terminal on the Agent screen  (Track A · Amendment 58)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One command you ran in an agent's folder. A command runner, not a terminal: each runs
 * in `$SHELL -c`, with no input, and its output comes back as text.
 */
export interface TerminalRun {
  id: string;
  agentId: string;
  command: string;
  cwd: string;
  startedAt: string;
  /** Null while it runs. */
  endedAt: string | null;
  exitCode: number | null;
  /** The signal that ended it, when one did — SIGINT for a stop. */
  signal: string | null;
  /** True once its output passed the cap and the rest was dropped. */
  cut?: boolean;
}

export interface TerminalChunk {
  stream: 'out' | 'err';
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Allow always" rules  (Track A · Amendment 48)
// ─────────────────────────────────────────────────────────────────────────────

/** Where Claude Code was asked to keep its own copy of a rule, and whether it's there. */
export interface RuleCopy {
  /** The SDK's destination: 'localSettings', 'projectSettings', 'userSettings', 'session', … */
  destination: string;
  /** The settings file it would be in; null for a session-only copy. */
  file: string | null;
  /** The entry as it appears in that file's `permissions.allow`. */
  entry: string;
  /** Whether the file holds it now. Null when the file can't be read, or there is none. */
  present: boolean | null;
}

export interface RuleView {
  id: string;
  projectId: string;
  toolName: string;
  /** Null: the whole tool. */
  ruleContent: string | null;
  grantedAt: string;
  /** Who asked. Null for rules from before Amendment 48, or an agent since removed. */
  agent: { id: string; role: string } | null;
  /** The SDK's copy, when the suggestion said where it went. */
  copy: RuleCopy | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Where Conductor keeps its data  (W0 · Amendment 46)
// ─────────────────────────────────────────────────────────────────────────────

export type StorageMode =
  /** Asked for nothing yet: the setup server is answering. */
  | 'undecided'
  /** `~/.conductor/` — the user allowed it, now or on an earlier start. */
  | 'home'
  /** The user said no: everything is in memory and goes when the daemon stops. */
  | 'memory'
  /** `CONDUCTOR_DB` names the database; nobody is asked. */
  | 'override';

export interface StorageState {
  mode: StorageMode;
  /** The folder Conductor would use, or uses. */
  dir: string;
  /** What is saved across a restart: nothing, in memory mode. */
  saved: boolean;
  /** Where the database is, or `:memory:`. */
  db: string;
  /** Where settings are written, or null when they aren't. */
  settings: string | null;
  /** Set once a memory session has been copied home: restart to keep saving there. */
  savedAt?: string;
  /**
   * The database from before this folder existed, inside the Conductor checkout, when
   * it is still there. Never opened, moved or deleted — the user chose to start fresh —
   * only named, so nobody wonders where their history went.
   */
  legacy?: string;
  /** What the old database holds, while the question is open — so it can say what comes over. */
  legacyHolds?: { projects: number; agents: number };
  /** Set when the old database was copied in on allowing (Amendment 53). */
  broughtFrom?: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export const WS_PATH = '/ws';
export const DEFAULT_PORT = 7777;

// ── A full terminal (Amendment 112; scopes, settings and bytes, Amendment 141) ────

/**
 * Whose a terminal is (Amendment 141). An agent's starts in its job folder and is shown on
 * the Agent screen's terminal tab; a project's starts in the project folder and is shown in
 * the Terminal dock under every screen (Ctrl-`). Both live by the same rules (service.ts).
 */
export type TermScope = { kind: 'agent'; agentId: string } | { kind: 'project'; projectId: string };

/** A scope as one string, `agent:<id>` or `project:<id>`: a map key, the same on both sides. */
export function termScopeKey(s: TermScope): string {
  return s.kind === 'agent' ? `agent:${s.agentId}` : `project:${s.projectId}`;
}

/** A terminal: a real shell on a pseudo-terminal, kept by the daemon. */
export interface TermInfo {
  id: string;
  /** Whose it is (Amendment 141). */
  scope: TermScope;
  /** Where its shell started: the agent's job folder, or the project folder. */
  cwd: string;
  /** The shell that ran (Amendment 141), e.g. `/bin/zsh`. */
  shell: string;
  startedAt: string;
  /** The shell has ended. It stays listed, with its last output, until closed. */
  exited: boolean;
  exitCode: number | null;
}

/**
 * `GET /api/agents/:agentId/terminals` and (Amendment 141) `GET /api/projects/:projectId/terminals`.
 * `available: false` says why, and the agent's tab shows the runner instead.
 */
export interface TermListResponse {
  available: boolean;
  reason?: string;
  terminals: TermInfo[];
}

/** `POST` to either list. The size is the panel's, so the prompt is drawn at it. */
export interface TermCreateRequest {
  cols?: number;
  rows?: number;
}

export interface TermCreateResponse {
  id: string;
}

/** A shell this machine has, for the Settings screen's picker (Amendment 141). */
export interface TermShell {
  /** What runs, and what `conductor.terminal.shell` holds. */
  path: string;
  /** `zsh`, or `zsh · /usr/local/bin/zsh` when two have the same name. */
  label: string;
}

/** `GET /api/terminals/shells`: the shells found, and the one used when the setting is empty. */
export interface TermShellsResponse {
  shells: TermShell[];
  default: string;
}

/**
 * What the page sends down `/ws/term/:id`: keys and paste (`in`), the panel's size, and
 * (Amendment 141) `bin`, bytes that are not text, base64: xterm.js's `onBinary`, which is how
 * a mouse report past column 95 arrives in the X10 encoding. Sent as `in` they would be UTF-8
 * encoded on the way to the shell, and each byte over 127 would become two. Output comes back
 * as binary frames.
 */
export type TermClientFrame =
  | { t: 'in'; d: string }
  | { t: 'bin'; d: string }
  | { t: 'resize'; cols: number; rows: number };

/**
 * The terminal's settings (Amendment 141), in Settings (9) under Terminal. The daemon has a
 * rule for each (daemon/src/terminal/prefs.ts); the page reads them (web/src/agent/Xterm.tsx).
 */
export const TERM_FONT_SIZE = { key: 'conductor.terminal.fontSize', min: 9, max: 24, fallback: 13 } as const;
export const TERM_SCROLLBACK = { key: 'conductor.terminal.scrollback', min: 1000, max: 100000, fallback: 5000 } as const;
export const TERM_SHELL_KEY = 'conductor.terminal.shell';

/** Digits in a setting's range, or null for anything else (`5e3`, `13.0`, empty or unset included). */
export function termNumber(raw: string | null | undefined, range: { min: number; max: number }): number | null {
  const v = raw?.trim() ?? '';
  if (!/^\d{1,7}$/.test(v)) return null;
  const n = Number(v);
  return n >= range.min && n <= range.max ? n : null;
}

/** `/ws/term/:id`, the socket for one terminal. */
export const TERM_WS_PREFIX = '/ws/term/';

// ─────────────────────────────────────────────────────────────────────────────
// Metrics  (Amendment 122)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/metrics?range=. `today` and `7d` count the daemon's local days, today included. */
export type MetricsRange = 'today' | '7d' | 'all';

/**
 * What one row, one day or the whole range adds up to. Sums only: rates (an error rate,
 * a time per call, tokens per second) are the reader's to divide, since only it knows
 * which of two figures it has.
 */
export interface MetricsCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Dollars, where the engines counted here report them; null when none does. */
  costUsd: number | null;
  /** Model round-trips. */
  calls: number;
  /** Model calls the SDK retried (`api_retry` events). Only Claude reports them. */
  retries: number;
  /**
   * The calls made by Claude, the one engine that reports a retry: the retry rate's whole
   * (Amendment 136). Equal to `calls` when nothing else ran; dividing by `calls` with a
   * Copilot or OpenRouter agent in the range would count calls nobody could have retried.
   */
  claudeCalls: number;
  /** Runs that ended, however they ended. */
  runs: number;
  /** Runs that ended `failed`. Your own stop, a pause and a budget stop are not among them. */
  failedRuns: number;
  /** Wall time of those runs, in ms. */
  runMs: number;
  /** Time the engine spent in model calls, in ms, over `timedCalls` calls. */
  apiMs: number;
  timedCalls: number;
  /** The output tokens of those timed calls, so tokens per second divides like by like. */
  timedOutputTokens: number;
}

export interface MetricsModelRow extends MetricsCounts {
  provider: string;
  model: string;
}

export interface MetricsDay extends MetricsCounts {
  /** The local day, YYYY-MM-DD. */
  day: string;
}

/**
 * Agents that spent before metrics were recorded. Their totals come from the agent rows
 * (Claude's tokens there are from the agent's last run only) and have no calls or times;
 * each is credited to the model the agent has now.
 */
export interface MetricsBefore {
  agents: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  models: Array<{
    provider: string;
    model: string;
    agents: number;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export interface MetricsResponse {
  range: MetricsRange;
  /** The first and last local day the range covers. `all` starts when recording did. */
  from: string;
  to: string;
  /** The local day recording began. Nothing earlier is in the rows below. */
  since: string;
  total: MetricsCounts;
  /** Busiest first (by tokens). */
  models: MetricsModelRow[];
  /** Newest first; only days with something in them. */
  days: MetricsDay[];
  /** Present for `all`, when there is anything from before. Never for one project. */
  before: MetricsBefore | null;
  /**
   * The project these counts are for (`?projectId=`, Amendment 136), or null for all of
   * them. With a project, `since` is the day per-project counting began: earlier counts
   * have no project and are only in the all-projects view.
   */
  project: MetricsProject | null;
}

/** GET /api/metrics?projectId= — which project the report is for. 404 for one that is not there. */
export interface MetricsProject {
  id: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trying again when the model can't be reached  (Amendment 123)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/agents/:agentId/stop-retrying — give up waiting: the agent ends `failed`, as it
 * did before retries. 409, with the sentence in `detail`, when it is not waiting to retry.
 * (POST /api/agents/:agentId/retry-now takes no body and answers `{ ok: true }`, 409 likewise.)
 */
export interface StopRetryingResponse {
  agent: Agent;
}
