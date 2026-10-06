/**
 * Data access for screen 5.
 *
 * TRACK C owns this file.
 *
 * Every request goes through `api()` from lib/feed.ts so auth stays in one
 * place, and every piece of live state is read through the hooks in
 * lib/store.ts. Nothing here opens a socket or calls fetch directly.
 *
 * The refresh rule: the tree and the open file are REST reads, but *when* to
 * re-read them is derived from the event log. A `file_edit` for this job means
 * the tree is stale; a `file_edit` naming the open path means the pane is. That
 * is why the mockup's "live file watcher, no refresh" note is literally true —
 * there is no polling anywhere in this screen.
 *
 * Every hook takes a root — a job's id, or a project directory's `dirRoot`
 * (Amendment 39). A directory has no watcher and no file_edit events: agents reach
 * it but Conductor does not track it, so it is re-read when you ask (`refreshRoot`)
 * and whenever a tab under it is opened, and never on its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  Agent,
  DiffResponse,
  FileContentResponse,
  FileTreeResponse,
  Job,
  WriteFileRequest,
} from '@conductor/shared';
import { api } from '../lib/feed.js';
import { ApiError, errorText } from '../lib/errors.js';
import { useAgents, useJobEvents, useJobs } from '../lib/store.js';
import { parseDirRoot, rootEndpoint as endpoint } from './tabs.js';

// ── asked-for refreshes ─────────────────────────────────────────────────────

/** Per root, how many times ↻ was pressed. Module-level, so every hook on a root sees it. */
const asked = new Map<string, number>();
const askers = new Set<() => void>();

/** Re-read a root's tree, its open file and its diff. */
export function refreshRoot(root: string): void {
  asked.set(root, (asked.get(root) ?? 0) + 1);
  for (const l of askers) l();
}

function useAsked(root: string | null): number {
  return useSyncExternalStore(
    (fn) => {
      askers.add(fn);
      return () => askers.delete(fn);
    },
    () => (root ? (asked.get(root) ?? 0) : 0),
  );
}

/**
 * Shape of GET /api/workspaces — this track's own endpoint, so its type lives
 * here rather than in the frozen shared contract.
 */
export interface WorkspaceSummary {
  jobId: string;
  projectId: string;
  repoPath: string;
  path: string;
  branch: string;
  isolation: 'worktree' | 'branch' | 'in_place';
  baseRef: string | null;
  createdAt: string;
  removedAt: string | null;
}

export interface JobChoice {
  jobId: string;
  projectId: string;
  label: string;
  branch: string;
  path: string;
  isolation: string;
  /** True when the daemon has a worktree recorded, not just a jobs row. */
  watched: boolean;
}

interface Async<T> {
  data: T | null;
  error: string | null;
  /**
   * The HTTP status behind `error`, or null for no answer at all (the daemon is
   * down). A file that isn't there and a daemon that broke are different things to
   * tell someone, and the sentence alone doesn't say which it was.
   */
  status: number | null;
  loading: boolean;
}

function idle<T>(): Async<T> {
  return { data: null, error: null, status: null, loading: false };
}

/**
 * The last good copy per key, most recent last, for `useReload`'s `cache`. Coming
 * back to a tab shows what it last showed — marked loading — instead of a blank
 * pane while it refetches. The key still decides what may be shown: a copy is only
 * ever shown under its own key, so this never shows one file under another's name.
 */
class LastGood<T> {
  readonly #items = new Map<string, T>();
  constructor(readonly limit: number) {}
  get(key: string): T | undefined {
    return this.#items.get(key);
  }
  set(key: string, value: T): void {
    this.#items.delete(key);
    this.#items.set(key, value);
    for (const old of this.#items.keys()) {
      if (this.#items.size <= this.limit) break;
      this.#items.delete(old);
    }
  }
  delete(key: string): void {
    this.#items.delete(key);
  }
}

/** Re-runs `fn` when `key` changes, and again — coalesced — when `revision` does. */
function useReload<T>(
  key: string | null,
  revision: number,
  fn: (key: string) => Promise<T>,
  debounceMs = 250,
  cache?: LastGood<T>,
): Async<T> & { reload: () => void } {
  // The key the state belongs to. Without it, switching files shows the previous
  // file's text under the new file's breadcrumb until the fetch lands — which is
  // a lie, and the one lie a file viewer must never tell.
  const [state, setState] = useState<Async<T> & { key: string | null }>({
    key: null,
    ...idle<T>(),
  });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  /** What the last fetch that actually started was for: `key`, then the nonce. */
  const loaded = useRef<string | null>(null);

  // Keep `fn` out of the dependency list: callers build it inline, and a new
  // identity every render would turn this into a polling loop.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!key) {
      setState({ key: null, ...idle<T>() });
      return;
    }
    const ticket = ++latest.current;
    const asked = `${key}\u0001${nonce}`;
    let cancelled = false;

    const run = async () => {
      loaded.current = asked;
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await fnRef.current(key);
        if (cancelled || ticket !== latest.current) return;
        cache?.set(key, data);
        setState({ key, data, error: null, status: null, loading: false });
      } catch (err) {
        if (cancelled || ticket !== latest.current) return;
        // A copy that can't be re-read any more is not one to keep showing.
        cache?.delete(key);
        const status = err instanceof ApiError ? err.status : null;
        setState({ key, data: null, error: errorText(err), status, loading: false });
      }
    };

    // A new key, or a retry, loads at once — that's someone asking. Event-driven
    // reloads of the same key wait out a quiet period, so a burst of file_edits from
    // a busy agent is one refetch, not forty.
    const delay = asked !== loaded.current ? 0 : debounceMs;
    const timer = setTimeout(() => void run(), delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, revision, nonce, debounceMs, cache]);

  const fresh = state.key === key;
  const kept = !fresh && key ? (cache?.get(key) ?? null) : null;
  return {
    data: fresh ? state.data : kept,
    error: fresh ? state.error : null,
    status: fresh ? state.status : null,
    loading: !fresh || state.loading,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}

/**
 * Count of events that invalidate the tree, plus refreshes asked for. Cheap, stable,
 * no deep compare. A directory root has no events, so for it this is only the asking.
 */
function useTreeRevision(jobId: string | null): number {
  const events = useJobEvents(jobId);
  const bumps = useAsked(jobId);
  const edits = useMemo(
    () =>
      events.filter((e) => e.payload.kind === 'file_edit' || e.payload.kind === 'worktree').length,
    [events],
  );
  return edits + bumps;
}

/** Count of events that invalidate one open file, plus refreshes asked for. */
export function useFileRevision(jobId: string | null, path: string | null): number {
  const events = useJobEvents(jobId);
  const bumps = useAsked(jobId);
  const edits = useMemo(() => {
    if (!path) return 0;
    return events.filter((e) => e.payload.kind === 'file_edit' && e.payload.path === path).length;
  }, [events, path]);
  return edits + bumps;
}

/**
 * Jobs this screen can show.
 *
 * Primary source is the store's `jobs`, which now includes this track's own
 * bootstrap workspaces: Amendment 2 made snapshot contributors compose, so the
 * daemon publishes them alongside Track A's real jobs instead of one silently
 * discarding the other.
 *
 * `GET /api/workspaces` is kept as belt and braces. It costs one request and it
 * covers the window between opening a workspace and the next snapshot — a live
 * session's store is updated by events, and a freshly prepared worktree is not
 * an event the store folds into `jobs`.
 */
export function useJobChoices(): { choices: JobChoice[]; error: string | null; reload: () => void } {
  const jobs: Job[] = useJobs();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
        if (!cancelled) {
          setWorkspaces(res.workspaces);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, jobs.length]);

  const choices = useMemo(() => {
    const byId = new Map<string, JobChoice>();
    for (const ws of workspaces) {
      byId.set(ws.jobId, {
        jobId: ws.jobId,
        projectId: ws.projectId,
        label: ws.path.split('/').pop() ?? ws.jobId,
        branch: ws.branch,
        path: ws.path,
        isolation: ws.isolation,
        watched: true,
      });
    }
    for (const job of jobs) {
      const existing = byId.get(job.id);
      byId.set(job.id, {
        jobId: job.id,
        projectId: job.projectId,
        // The prompt is what a human recognises a job by; the path is not.
        label: job.prompt.slice(0, 48) || (existing?.label ?? job.id),
        branch: job.branch,
        path: job.worktreePath,
        isolation: job.isolation,
        watched: existing?.watched ?? false,
      });
    }
    return [...byId.values()];
  }, [jobs, workspaces]);

  return { choices, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** Tabs span roots, so a tab in another root shouldn't wait on its tree to draw one. */
const lastTrees = new LastGood<FileTreeResponse>(16);

export function useFileTree(jobId: string | null) {
  const revision = useTreeRevision(jobId);
  return useReload<FileTreeResponse>(
    jobId,
    revision,
    (id) => api<FileTreeResponse>(endpoint(id, 'tree')),
    250,
    lastTrees,
  );
}

/**
 * The image extensions the pane shows inline, mirroring the daemon's allowlist in
 * `workspace/service.ts`. Duplicated on purpose: the daemon's copy is the boundary
 * that enforces it, this one only decides whether to render `<img>` or ask for text.
 * A disagreement between them is a 415 in the pane, not a hole.
 */
const IMAGE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
]);

/** Does this path render as an image rather than as text? */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot > -1 && IMAGE_EXT.has(path.slice(dot).toLowerCase());
}

/**
 * The URL an `<img src>` points at.
 *
 * `revision` rides along as a cache-buster. The daemon already sends `no-store`, but
 * the element itself will not re-request an unchanged `src` — so without this an agent
 * overwriting a screenshot leaves the old one on screen.
 */
export function imageUrl(jobId: string, path: string, revision: number): string {
  return `${endpoint(jobId, 'image', path)}&r=${revision}`;
}

/** One per open tab, and then some. Module-level, so it outlives the screen. */
const lastFiles = new LastGood<FileContentResponse>(32);

export function useFileContent(jobId: string | null, path: string | null) {
  const revision = useFileRevision(jobId, path);
  // An image has no text to fetch; asking for it would just be a 415 per click.
  const key = jobId && path && !isImagePath(path) ? `${jobId}\u0000${path}` : null;
  return useReload<FileContentResponse>(
    key,
    revision,
    (k) => {
      const [id, p] = k.split('\u0000') as [string, string];
      return api<FileContentResponse>(endpoint(id, 'file', p));
    },
    250,
    lastFiles,
  );
}

const lastDiffs = new LastGood<DiffResponse>(4);

export function useWholeDiff(jobId: string | null, enabled: boolean) {
  const revision = useTreeRevision(jobId);
  return useReload<DiffResponse>(
    enabled ? jobId : null,
    revision,
    (id) => api<DiffResponse>(endpoint(id, 'diff')),
    250,
    lastDiffs,
  );
}

/** Write a file back into its root. The response is the re-read file. */
export async function writeFile(
  jobId: string,
  path: string,
  content: string,
): Promise<FileContentResponse> {
  const body: WriteFileRequest = { path, content };
  const d = parseDirRoot(jobId);
  const url = d
    ? `/api/projects/${encodeURIComponent(d.projectId)}/dir/file?dir=${encodeURIComponent(d.dir)}`
    : `/api/jobs/${encodeURIComponent(jobId)}/file`;
  const saved = await api<FileContentResponse>(url, { method: 'PUT', body });
  // What was just written is the newest copy there is. A tab switched back to shows
  // it at once, rather than the text from before the save until its refetch lands.
  lastFiles.set(`${jobId}\u0000${path}`, saved);
  return saved;
}

/** Bootstrap a workspace. Track A's session engine is the real caller. */
export async function openWorkspace(
  repoPath: string,
  isolation: 'worktree' | 'branch' | 'in_place',
): Promise<WorkspaceSummary> {
  const res = await api<{ workspace: WorkspaceSummary }>('/api/workspaces', {
    method: 'POST',
    body: { repoPath, isolation },
  });
  return res.workspace;
}

export interface Touch {
  agentId: string | null;
  at: string;
}

/**
 * Who last wrote each path, straight off the event log. The tree endpoint knows
 * *when* a file changed; only the log knows *which agent* did it, because that
 * attribution comes from Track A's PostToolUse events.
 */
export function useTouches(jobId: string | null): Map<string, Touch> {
  const events = useJobEvents(jobId);
  return useMemo(() => {
    const out = new Map<string, Touch>();
    for (const e of events) {
      if (e.payload.kind !== 'file_edit') continue;
      const prior = out.get(e.payload.path);
      out.set(e.payload.path, {
        // Never let a later anonymous watcher event erase a known author.
        agentId: e.agentId ?? prior?.agentId ?? null,
        at: e.ts,
      });
    }
    return out;
  }, [events]);
}

/** agentId → role, for the badge. */
export function useAgentRoles(jobId: string | null): Map<string, string> {
  const agents: Agent[] = useAgents(jobId ?? undefined);
  return useMemo(() => new Map(agents.map((a) => [a.id, a.role])), [agents]);
}

/** Re-render on an interval so "8s ago" stays true without a state channel. */
export function useTick(ms = 1_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

export function since(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
