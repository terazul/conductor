/**
 * The event log — the single source of truth for everything the UI shows.
 *
 * FROZEN CONTRACT (W0). Read-only for all tracks.
 * Need a new payload kind? Stop and escalate — see CONTRACT.md §3.
 *
 * Design notes:
 *  - `seq` is GLOBAL and monotonic across the whole daemon (SQLite rowid).
 *    One writer, one cursor, trivially lossless reconnect. The browser
 *    subscribes once with `?since=<seq>` and filters client-side. With <=7
 *    concurrent agents this is the right simplification.
 *  - Everything the UI displays is DERIVED from this log. Agent status,
 *    project status, sparklines and diffstats are never stored.
 */

/** Which agent role produced this work. Free-form so presets can add roles. */
export type AgentRole =
  | 'builder'
  | 'validator'
  | 'reviewer'
  | 'scribe'
  | 'debugger'
  | 'uiux'
  | (string & {});

export type AgentStatus =
  | 'queued' // waiting for a slot
  | 'working' // actively running
  | 'blocked' // needs a human (held or parked — see BlockMode)
  | 'paused' // stopped by the user, resumable
  | 'stopped' // terminated by the user — ended deliberately, not resumable
  | 'done' // finished cleanly
  | 'failed'; // errored out

/**
 * How a blocked agent is being held.
 *  - 'held'   : the canUseTool promise is still pending; process alive, agent warm.
 *  - 'parked' : PreToolUse returned `defer`, the query ended. Survives a daemon
 *               restart; answering re-launches with options.resume.
 * See PLAN.md §1 finding B.
 */
export type BlockMode = 'held' | 'parked';

// ─────────────────────────────────────────────────────────────────────────────
// Event payloads
// ─────────────────────────────────────────────────────────────────────────────

/** Assistant prose. */
export interface TextPayload {
  kind: 'text';
  text: string;
}

/** A user turn (typed by the human, or injected by Conductor). */
export interface UserTextPayload {
  kind: 'user_text';
  text: string;
  /** true when Conductor generated it (e.g. "send console errors to agent"). */
  synthetic?: boolean;
}

/**
 * A tool call started. Emitted from the async PreToolUse hook, so it fires for
 * EVERY call including auto-approved ones. This is what drives the activity
 * feed and the sparkline. See PLAN.md §1 finding A.
 */
export interface ToolStartPayload {
  kind: 'tool_start';
  toolUseId: string;
  tool: string;
  /** Raw tool input. Shape varies by tool; render defensively. */
  input: unknown;
  /** One-line human summary, e.g. `Edit src/auth/token.ts`. */
  label: string;
}

export interface ToolEndPayload {
  kind: 'tool_end';
  toolUseId: string;
  ok: boolean;
  /** Short result summary, e.g. `6 passed, 1 xfail` or `clean · 2.4s`. */
  summary: string;
  durationMs?: number;
}

/**
 * A file was written.
 *
 * TWO SOURCES EMIT THIS, deliberately, and they carry different truths —
 * see `source`. Amendment 8, after Track A found that the merged system
 * double-counted every write.
 */
export interface FileEditPayload {
  kind: 'file_edit';
  /** Worktree-relative POSIX path. */
  path: string;
  added: number;
  removed: number;
  created?: boolean;
  deleted?: boolean;
  /**
   * Which channel observed the write.
   *
   *  - `'tool'`    — Track A's `PostToolUse`. Knows **who** wrote (real
   *                  `agentId`) and arrives immediately, but its line counts are
   *                  estimates from the tool input.
   *  - `'watcher'` — Track C's file watcher. Counts are **authoritative**
   *                  (`git diff --numstat`), but it sees bytes, not authors, so
   *                  `agentId` is null.
   *
   * Absent means authoritative, so pre-Amendment-8 events and the fixtures keep
   * their old meaning.
   *
   * `diffstat()` resolves the overlap per path — never sum both blindly, or
   * every write is counted twice.
   */
  source?: 'tool' | 'watcher';
}

/** An agent needs a human. Detail lives in the `requests` table. */
export interface RequestPayload {
  kind: 'request';
  requestId: string;
  requestKind: 'permission' | 'question';
  blockMode: BlockMode;
  /** One-line summary for the queue, e.g. `Bash · rm -rf dist/`. */
  label: string;
}

/** A human answered (or it expired / was auto-resolved). */
export interface ResolvedPayload {
  kind: 'resolved';
  requestId: string;
  decision: DecisionSummary;
}

export interface StatusPayload {
  kind: 'status';
  status: AgentStatus;
  blockMode?: BlockMode;
  /** Present on 'failed'. */
  error?: string;
  /**
   * On 'failed', what the SDK said about it, when it said anything: the result's
   * `errors`. `error` stays the code the sentences and alerts key on. Amendment 28.
   */
  detail?: string;
}

/** Cumulative usage, from SDKResultMessage. */
export interface UsagePayload {
  kind: 'usage';
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/** Agent's own todo list, when available. */
export interface TodoPayload {
  kind: 'todo';
  items: Array<{ text: string; state: 'pending' | 'active' | 'done' }>;
}

/** Job/worktree lifecycle. agentId is null for these. */
export interface WorktreePayload {
  kind: 'worktree';
  event: 'created' | 'reused' | 'removed';
  path: string;
  branch: string;
}

/**
 * Why a model API call is being retried (Amendment 28, F10).
 *  - 'unreachable': no HTTP response at all — DNS, VPN, offline.
 *  - 'auth':        the login was refused.
 *  - 'throttled':   rate limited or overloaded.
 *  - 'server':      anything else, such as a 5xx.
 * Only the first two need a person; the other two usually pass on their own.
 */
export type RetryCause = 'unreachable' | 'auth' | 'throttled' | 'server';

/**
 * The SDK is retrying a model API call (Amendment 28, F10). Until the next reply,
 * the agent is waiting on the network, not working.
 */
export interface ApiRetryPayload {
  kind: 'api_retry';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  cause: RetryCause;
  /** The HTTP status, or null when there was no response. */
  httpStatus: number | null;
  /** The SDK's error tag, e.g. `rate_limit` or `authentication_failed`. */
  error: string;
}

/** A dev server appeared or went away (Track D). */
export interface DevServerPayload {
  kind: 'dev_server';
  event: 'up' | 'down';
  port: number;
  pid?: number;
  /** Which agent started it. */
  startedByAgentId?: string;
  /**
   * On `down`: it stopped answering and nobody asked it to stop. Set only by the
   * liveness sweep, never by a stop or a forget (Amendment 28, F13).
   */
  unexpected?: boolean;
}

/** Captured browser console output from the preview pane (Track D). */
export interface ConsolePayload {
  kind: 'console';
  level: 'log' | 'warn' | 'error';
  text: string;
}

export type EventPayload =
  | TextPayload
  | UserTextPayload
  | ToolStartPayload
  | ToolEndPayload
  | FileEditPayload
  | RequestPayload
  | ResolvedPayload
  | StatusPayload
  | UsagePayload
  | TodoPayload
  | WorktreePayload
  | DevServerPayload
  | ConsolePayload
  | ApiRetryPayload;

export type EventKind = EventPayload['kind'];

/** A row in the log. */
export interface Event {
  seq: number;
  ts: string;
  projectId: string;
  jobId: string;
  /** null for job-scoped events (worktree, dev_server). */
  agentId: string | null;
  payload: EventPayload;
}

/** What the daemon accepts before it assigns seq/ts. */
export type NewEvent = Omit<Event, 'seq' | 'ts'> & { ts?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Human decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the SDK's AskUserQuestion input. `preview` is populated because we
 * set toolConfig.askUserQuestion.previewFormat = 'html' — we're a browser, so
 * we render Claude's option previews natively.
 */
export interface QuestionOption {
  label: string;
  description: string;
  /** Sanitized HTML fragment, or absent. */
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Opaque passthrough of the SDK's PermissionUpdate suggestions. */
export interface PermissionSuggestion {
  destination: string;
  [k: string]: unknown;
}

/** A pending ask, as the attention queue sees it. */
export interface PendingRequest {
  requestId: string;
  projectId: string;
  jobId: string;
  agentId: string;
  agentRole: AgentRole;
  projectName: string;
  kind: 'permission' | 'question';
  blockMode: BlockMode;
  createdAt: string;
  /** Tool name, e.g. 'Bash'. 'AskUserQuestion' for questions. */
  toolName: string;
  input: unknown;
  /** permission only — the rule that sent this to a human. */
  matchedRule?: string;
  /** permission only — best-effort reversibility note for the card. */
  reversible?: { value: boolean; reason: string };
  /** permission only — cwd the command would run in. */
  cwd?: string;
  /** permission only — ready-made rules for "allow always". */
  suggestions?: PermissionSuggestion[];
  /** question only. */
  questions?: Question[];
}

/** What the browser sends back. */
export type Decision =
  | { type: 'allow_once' }
  /** Allow and persist a rule so we stop being asked. */
  | { type: 'allow_always'; suggestions: PermissionSuggestion[] }
  /** Allow with a modified input. HELD requests only — `defer` drops updatedInput. */
  | { type: 'allow_edited'; updatedInput: unknown }
  | { type: 'deny'; message: string }
  /** Answer an AskUserQuestion. Keys are question text, values are option labels. */
  | { type: 'answer'; answers: Record<string, string | string[]>; response?: string };

/** Compact form stored on the resolved event. */
export interface DecisionSummary {
  type: Decision['type'] | 'expired';
  by: 'human' | 'rule' | 'system';
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers — shared so every track computes these identically
// ─────────────────────────────────────────────────────────────────────────────

/** Worst-first. A project shows the status of its unhappiest agent. */
const STATUS_SEVERITY: Record<AgentStatus, number> = {
  failed: 7,
  blocked: 6,
  working: 5,
  queued: 4,
  paused: 3,
  // Above `done` because "someone cut this short" is the more informative of the two
  // when a project holds both, and below `paused` because nobody is waiting on it.
  stopped: 2,
  done: 1,
};

export function rollupStatus(statuses: readonly AgentStatus[]): AgentStatus {
  if (statuses.length === 0) return 'done';
  return statuses.reduce((worst, s) =>
    STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst,
  );
}

export const SPARKLINE_BUCKET_MS = 15_000;
export const SPARKLINE_BUCKETS = 8;

/**
 * Tool-calls-per-bucket over the trailing window. Flat bars mean the agent is
 * thinking or stuck, not working — which is the whole point of showing it.
 */
export function sparkline(
  events: readonly Event[],
  now = Date.now(),
  buckets = SPARKLINE_BUCKETS,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  const windowStart = now - buckets * SPARKLINE_BUCKET_MS;
  for (const e of events) {
    if (e.payload.kind !== 'tool_start') continue;
    const t = Date.parse(e.ts);
    if (t < windowStart || t > now) continue;
    const idx = Math.min(
      buckets - 1,
      Math.floor((t - windowStart) / SPARKLINE_BUCKET_MS),
    );
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

/** One file's resolved change, after the two sources have been reconciled. */
export interface ResolvedFileEdit {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  /** Which source supplied the counts above. */
  countedFrom: 'watcher' | 'tool';
  /** Newest agent that claimed this write, if any source knew. */
  agentId: string | null;
  /** ISO timestamp of the newest event for this path. */
  at: string;
}

/**
 * Reconcile the two `file_edit` sources, per path. **Use this rather than walking
 * `file_edit` payloads yourself.**
 *
 * Amendment 9. Amendment 8 fixed `diffstat()` and stopped there, which was only
 * half the job: any code that walks the payloads directly still double-counts,
 * and Track B had two such places — per-file rows that would have shown roughly
 * double the total sitting right beside them. The rule needs exactly one
 * implementation, and this is it.
 *
 * The rule:
 *  - `'watcher'` (or absent `source`) is authoritative — real `git diff --numstat`.
 *  - `'tool'` is Track A's estimate, and is the fallback **only** for paths no
 *    watcher will ever report: `in_place` jobs, worktrees past the watcher cap.
 *  - Attribution is taken from whichever source knew it, regardless of which
 *    supplied the counts. Only the watcher has real numbers; only the tool
 *    channel knows who wrote.
 *  - `created` is sticky across sources: created once, created for the session.
 */
export function resolveFileEdits(events: readonly Event[]): Map<string, ResolvedFileEdit> {
  const authoritative = new Map<string, FileEditPayload[]>();
  const tool = new Map<string, FileEditPayload[]>();
  const agentByPath = new Map<string, string>();
  const atByPath = new Map<string, string>();

  for (const e of events) {
    if (e.payload.kind !== 'file_edit') continue;
    const p = e.payload;
    const bucket = p.source === 'tool' ? tool : authoritative;
    const list = bucket.get(p.path);
    if (list) list.push(p);
    else bucket.set(p.path, [p]);

    // Newest wins for both, and an anonymous write never erases a known author.
    if (e.agentId) agentByPath.set(p.path, e.agentId);
    atByPath.set(p.path, e.ts);
  }

  const out = new Map<string, ResolvedFileEdit>();
  const paths = new Set([...authoritative.keys(), ...tool.keys()]);

  for (const path of paths) {
    const auth = authoritative.get(path) ?? [];
    const est = tool.get(path) ?? [];
    const counted = auth.length > 0 ? auth : est;

    let added = 0;
    let removed = 0;
    for (const p of counted) {
      added += p.added;
      removed += p.removed;
    }

    out.set(path, {
      path,
      added,
      removed,
      // Sticky, and true if EITHER source ever said so.
      created: [...auth, ...est].some((p) => p.created === true),
      deleted: counted.at(-1)?.deleted === true,
      countedFrom: auth.length > 0 ? 'watcher' : 'tool',
      agentId: agentByPath.get(path) ?? null,
      at: atByPath.get(path) ?? '',
    });
  }

  return out;
}

/**
 * Line and file totals across a stream of events.
 *
 * Delegates to `resolveFileEdits()` so there is one implementation of the
 * two-source rule — see there for why summing both is wrong.
 */
export function diffstat(events: readonly Event[]): DiffStat {
  const resolved = resolveFileEdits(events);
  let added = 0;
  let removed = 0;
  for (const r of resolved.values()) {
    added += r.added;
    removed += r.removed;
  }
  return { added, removed, files: resolved.size };
}
