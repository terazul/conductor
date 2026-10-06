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
  /** Pause the agent when its own cost crosses this. */
  budgetUsd: number | null;
  /**
   * Amendment 77: pause the agent when its input plus output tokens reach this — a
   * lifetime cap, like `budgetUsd`, for an engine that can't say what a run cost in
   * dollars (`ProviderInfo.capabilities.costUsd` false). Such an agent takes this and
   * not `budgetUsd`; a Claude agent takes `budgetUsd` and not this. Optional, so absent
   * is uncapped and every agent from before it reads as it did.
   */
  budgetTokens?: number | null;
  /**
   * SDK `effort`. Optional because agents created before this field existed have no
   * value stored, and absent must keep meaning "whatever the SDK defaults to" rather
   * than silently becoming 'low'.
   */
  effort?: EffortLevel;
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
   * up to this many helpers. 0 or absent for an ordinary agent; at most HELPERS_MAX.
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
}

export interface CreateJobResponse {
  job: Job;
  agents: Agent[];
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

export interface DecideRequest {
  decision: Decision;
}

export interface SetAutonomyRequest {
  autonomy: Partial<Autonomy>;
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
 *                   (`job_budget_reached`).
 *  - 'connection':  the model API is unreachable or refusing the login, or the retries
 *                   ran out. `cause` is a RetryCause. One alert per outage, not per agent.
 *  - 'server_down': a dev server stopped answering and nobody asked it to stop.
 *  - 'blocked_dep': a queued agent is waiting on one that failed or was stopped
 *                   (Amendment 85). `agentIds` is the waiting agent, `blockedBy` the one
 *                   it waits on, and `cause` that one's status. It stays queued, so it
 *                   still starts if the other is continued and finishes.
 */
export type AlertKind =
  | 'failed'
  | 'budget'
  | 'connection'
  | 'server_down'
  | 'daily_budget'
  | 'note_due'
  | 'blocked_dep';

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
  /** connection: the latest attempt across the affected agents, and the SDK's cap. */
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
  /** Amendment 46. Optional so a recording made before it still replays. */
  settings?: Record<string, string>;
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
  /** Today's spend, each time it grows (Amendment 59). It used to arrive only with a snapshot. */
  | { type: 'cost'; costToday: number }
  /** Slots in use and the limit, each time either changes (Amendment 47). */
  | { type: 'slots'; slots: { used: number; total: number } }
  /** A terminal command started, or ended (Amendment 58). */
  | { type: 'terminal_run'; run: TerminalRun }
  /** Output from a terminal command, batched. */
  | { type: 'terminal_out'; agentId: string; runId: string; stream: 'out' | 'err'; text: string }
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
