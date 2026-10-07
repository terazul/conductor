/**
 * The Files screen's open tabs, and where you were in each.  TRACK C.  (Amendment 29)
 *
 * Why this exists: main.tsx renders only the active screen, so going to Agent and
 * back unmounted Files, and everything it knew was useState. It came back at the
 * default pick — "it lost context". What you have open now lives outside React (in
 * useTabs.ts) and in localStorage, so a screen switch, a reload and a restart all
 * come back to the same tabs, each at its own view and scroll position.
 *
 * A tab is one file under a root, or that root's whole diff (`path: null`), so tabs
 * can span roots. A root is a job's worktree, named by the job's id, or one of a
 * project's directories as it is on disk, named by `dirRoot` (Amendment 39). The tree
 * column shows one project's directories, and above them the worktree of the job
 * chosen, if one is; the active tab is always under one of those.
 *
 * Pure: no DOM, no React, no storage. files/verify.ts runs these under Node.
 */

export type View = 'rendered' | 'raw' | 'diff';

const VIEWS: readonly View[] = ['rendered', 'raw', 'diff'];

export interface Tab {
  /**
   * The root: a job's id, or a `dirRoot`. Still called `jobId` because it is what
   * localStorage and `#files?jobId=…` links already hold, and a job's id is one.
   */
  jobId: string;
  /** Root-relative. Null is the root's whole diff. */
  path: string | null;
  view: View;
  /** Per view, so rendered and raw each come back where you left them. */
  scroll: Partial<Record<View, number>>;
  /** When it was last the active tab. Eviction, and which tab a close falls back to, go by it. */
  seen: number;
}

/** A job's folders, as you left them. Both lists are exceptions to the tree's defaults. */
export interface Folders {
  /** Closed by you, though open by default (top level, or a change underneath). */
  collapsed: string[];
  /** Opened by you. */
  opened: string[];
}

export interface FilesState {
  tabs: Tab[];
  /** `tabKey` of the active tab: one of `tabs`, under a root the column shows, or null. */
  active: string | null;
  /** The project whose directories the column shows. */
  project: string | null;
  /** The job whose worktree the column shows above them, or null for none. */
  job: string | null;
  /** Per root. */
  folders: Record<string, Folders>;
  /** The last deep link followed — see `followLink` in useTabs.ts. */
  link: string | null;
  /**
   * A root waiting for its first file: its job or project chosen with no tabs open,
   * so the screen opens the default pick when its tree lands. Only then — closing
   * your last tab leaves the pane empty rather than opening something you didn't
   * ask for.
   */
  pick: string | null;
}

/** Past this, the tab you looked at longest ago goes — unless it holds an unsaved edit. */
export const MAX_TABS = 24;

/** Per job and per list. A long browse can't grow the settings file without bound. */
const MAX_FOLDERS = 400;

export const EMPTY: FilesState = {
  tabs: [],
  active: null,
  project: null,
  job: null,
  folders: {},
  link: null,
  pick: null,
};

const DIR = 'dir:';

/** The root for a project's directory, as it is on disk. Named by path, so removing
 *  one directory never moves a tab onto another. */
export function dirRoot(projectId: string, dir: string): string {
  return `${DIR}${projectId}:${dir}`;
}

/** The project and directory a `dirRoot` names; null for a job's root. */
export function parseDirRoot(root: string): { projectId: string; dir: string } | null {
  if (!root.startsWith(DIR)) return null;
  const colon = root.indexOf(':', DIR.length);
  if (colon < 0) return null;
  const projectId = root.slice(DIR.length, colon);
  const dir = root.slice(colon + 1);
  return projectId && dir ? { projectId, dir } : null;
}

/** Where a root's reads live: a job's worktree, or a project's directory. */
export function rootEndpoint(root: string, what: 'tree' | 'file' | 'image' | 'diff', path?: string): string {
  const d = parseDirRoot(root);
  const q = new URLSearchParams();
  if (d) q.set('dir', d.dir);
  if (path !== undefined) q.set('path', path);
  const qs = q.toString();
  const base = d
    ? `/api/projects/${encodeURIComponent(d.projectId)}/dir/${what}`
    : `/api/jobs/${encodeURIComponent(root)}/${what}`;
  return qs ? `${base}?${qs}` : base;
}

/** Is `root` one the column shows for this project and job? */
export function inColumn(s: Pick<FilesState, 'project' | 'job'>, root: string): boolean {
  if (root === s.job) return true;
  const d = parseDirRoot(root);
  return d !== null && d.projectId === s.project;
}

/**
 * The project and job that show `root`. A directory of the project already shown
 * keeps the job beside it; one of another project shows that project alone. A job's
 * project is not known here — the screen fills it in from the job (route.tsx).
 */
function column(s: FilesState, root: string): Pick<FilesState, 'project' | 'job'> {
  const d = parseDirRoot(root);
  if (d) return { project: d.projectId, job: d.projectId === s.project ? s.job : null };
  return { project: s.project, job: root };
}

function latest(tabs: readonly Tab[], shown: (t: Tab) => boolean): Tab | null {
  return tabs.filter(shown).reduce<Tab | null>((best, t) => (!best || t.seen > best.seen ? t : best), null);
}

export function tabKey(jobId: string, path: string | null): string {
  return `${jobId}\u0000${path ?? ''}`;
}

export function keyOf(tab: Tab): string {
  return tabKey(tab.jobId, tab.path);
}

export function activeTab(s: FilesState): Tab | null {
  return s.tabs.find((t) => keyOf(t) === s.active) ?? null;
}

/** Opens a folder's ancestors, as a click on a file inside it would need. */
function reveal(folders: Record<string, Folders>, jobId: string, path: string | null): Record<string, Folders> {
  const f = folders[jobId];
  if (!f || path === null) return folders;
  const parts = path.split('/');
  const ancestors = new Set(parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/')));
  if (!f.collapsed.some((p) => ancestors.has(p))) return folders;
  return { ...folders, [jobId]: { ...f, collapsed: f.collapsed.filter((p) => !ancestors.has(p)) } };
}

function evict(tabs: Tab[], active: string, keep: (key: string) => boolean): Tab[] {
  let out = tabs;
  while (out.length > MAX_TABS) {
    let oldest: Tab | null = null;
    for (const t of out) {
      const k = keyOf(t);
      if (k === active || keep(k)) continue;
      if (!oldest || t.seen < oldest.seen) oldest = t;
    }
    // Everything left is active or unsaved. Over the cap beats losing an edit.
    if (!oldest) break;
    const gone = oldest;
    out = out.filter((t) => t !== gone);
  }
  return out;
}

/**
 * Focus a file's tab, or open one for it. A tab that is already open keeps its view
 * and scroll — coming back to a file is the point. `keep` names tabs eviction must
 * spare: the ones with an unsaved edit.
 */
export function openTab(
  s: FilesState,
  jobId: string,
  path: string | null,
  now: number,
  keep: (key: string) => boolean = () => false,
): FilesState {
  const key = tabKey(jobId, path);
  const open = s.tabs.some((t) => keyOf(t) === key);
  const tabs = open
    ? s.tabs.map((t) => (keyOf(t) === key ? { ...t, seen: now } : t))
    : [...s.tabs, { jobId, path, view: path === null ? 'diff' : 'rendered', scroll: {}, seen: now } satisfies Tab];
  return {
    ...s,
    tabs: evict(tabs, key, keep),
    active: key,
    ...column(s, jobId),
    folders: reveal(s.folders, jobId, path),
    pick: null,
  };
}

export function activate(s: FilesState, key: string, now: number): FilesState {
  const tab = s.tabs.find((t) => keyOf(t) === key);
  if (!tab) return s;
  return openTab(s, tab.jobId, tab.path, now);
}

/** Close a tab. Closing the active one goes back to the tab you were on before it. */
export function closeTab(s: FilesState, key: string): FilesState {
  const tabs = s.tabs.filter((t) => keyOf(t) !== key);
  if (tabs.length === s.tabs.length) return s;
  if (s.active !== key) return { ...s, tabs };
  const back = tabs.reduce<Tab | null>((best, t) => (!best || t.seen > best.seen ? t : best), null);
  return {
    ...s,
    tabs,
    active: back ? keyOf(back) : null,
    ...(back ? column(s, back.jobId) : {}),
    folders: back ? reveal(s.folders, back.jobId, back.path) : s.folders,
  };
}

/**
 * Show a job's worktree above the project's directories, at the tab you last had
 * open in it. Null shows the directories alone, keeping the tab in front if it is
 * one of theirs.
 */
export function selectJob(s: FilesState, jobId: string | null): FilesState {
  if (jobId === null) {
    const shown = { project: s.project, job: null };
    const front = activeTab(s);
    const back = front && inColumn(shown, front.jobId) ? front : latest(s.tabs, (t) => inColumn(shown, t.jobId));
    const active = back ? keyOf(back) : null;
    if (s.job === null && s.active === active) return s;
    return { ...s, job: null, active, pick: null };
  }
  const last = latest(s.tabs, (t) => t.jobId === jobId);
  const active = last ? keyOf(last) : null;
  const pick = last ? null : jobId;
  if (s.job === jobId && s.active === active && s.pick === pick) return s;
  return { ...s, job: jobId, active, pick };
}

/**
 * Show a project's directories, at the tab you last had open in one of them. `first`
 * is its first directory's root, which gets the default pick when nothing is open.
 */
export function selectProject(s: FilesState, projectId: string, first: string): FilesState {
  const last = latest(s.tabs, (t) => parseDirRoot(t.jobId)?.projectId === projectId);
  const active = last ? keyOf(last) : null;
  const pick = last ? null : first;
  if (s.project === projectId && s.job === null && s.active === active && s.pick === pick) return s;
  return { ...s, project: projectId, job: null, active, pick };
}

/** A project Files could open on, resolved to one that still exists: its id, and its
 *  first directory's root, for the default pick (Amendment 44). */
export interface ProjectPick {
  id: string;
  first: string;
}

/** What `arrive` has to go on, each tier already resolved — or null if that tier has
 *  nothing to say. Finding the project behind each id is the screen's job (route.tsx),
 *  not this pure one's. */
export interface ArriveWant {
  /** The route's own `projectId` param, when it names no job (Amendment 91). */
  route: ProjectPick | null;
  /** `recall().projectId` (Amendment 44). */
  remembered: ProjectPick | null;
  /** The first project, for a screen that has never shown one at all. */
  first: ProjectPick | null;
}

/**
 * Where the column goes when you arrive at Files. One rule (Amendment 91, which widens
 * Amendment 44's to a second tier):
 *
 *   1. a link naming a job or a file wins outright — `applyLink` already opened it, and
 *      `linked` says so, so this function stays out entirely;
 *   2. else the project the route itself names, with no job (`navigate('files', {
 *      projectId })`);
 *   3. else `recall().projectId`, the project last opened anywhere;
 *   4. else, only if Files had nothing open at all, the first project.
 *
 * Tiers 2 and 3 win outright, including over a job already open for a DIFFERENT
 * project: `selectProject` always clears it, so that job never gets to decide instead —
 * which it used to, because nothing re-ran this choice once Files already agreed with
 * itself about which project it was showing. Tier 4 is weaker than "what Files already
 * had", so — as before — it applies only to a blank screen, never to pull you off a
 * project you were already looking at for no better reason than it being first in the
 * list.
 */
export function arrive(s: FilesState, want: ArriveWant, linked: boolean): FilesState {
  if (linked) return s;
  const w = want.route ?? want.remembered;
  if (w) return s.project === w.id ? s : selectProject(s, w.id, w.first);
  if (want.first && s.project === null && s.job === null) return selectProject(s, want.first.id, want.first.first);
  return s;
}

/** The default pick found nothing to open (an empty tree). Stop waiting for it. */
export function pickDone(s: FilesState): FilesState {
  return s.pick === null ? s : { ...s, pick: null };
}

export function setView(s: FilesState, key: string, view: View): FilesState {
  if (!s.tabs.some((t) => keyOf(t) === key && t.view !== view)) return s;
  return { ...s, tabs: s.tabs.map((t) => (keyOf(t) === key ? { ...t, view } : t)) };
}

export function setScroll(s: FilesState, key: string, view: View, top: number): FilesState {
  const y = Math.max(0, Math.round(top));
  if (!s.tabs.some((t) => keyOf(t) === key && t.scroll[view] !== y)) return s;
  return {
    ...s,
    tabs: s.tabs.map((t) => (keyOf(t) === key ? { ...t, scroll: { ...t.scroll, [view]: y } } : t)),
  };
}

/** `open` is whether the folder is open now, which the tree works out from its defaults. */
export function toggleFolder(s: FilesState, jobId: string, path: string, open: boolean): FilesState {
  const f = s.folders[jobId] ?? { collapsed: [], opened: [] };
  const next: Folders = open
    ? { ...f, collapsed: [...f.collapsed.filter((p) => p !== path), path].slice(-MAX_FOLDERS) }
    : {
        collapsed: f.collapsed.filter((p) => p !== path),
        opened: [...f.opened.filter((p) => p !== path), path].slice(-MAX_FOLDERS),
      };
  return { ...s, folders: { ...s.folders, [jobId]: next } };
}

// ── deep links ──────────────────────────────────────────────────────────────

/** A deep link's identity, or null for params that don't name a job (`5` pressed). */
export function linkOf(params: Record<string, string>): string | null {
  const jobId = params['jobId'];
  return jobId ? tabKey(jobId, params['path'] || null) : null;
}

/**
 * Follow `#files?jobId=…&path=…` (Amendment 3): open or focus that file's tab. A link
 * naming only a job shows that job. No params leaves everything where it was.
 */
export function applyLink(
  s: FilesState,
  params: Record<string, string>,
  now: number,
  keep?: (key: string) => boolean,
): FilesState {
  const link = linkOf(params);
  const jobId = params['jobId'];
  if (link === null || !jobId) return s;
  const path = params['path'] || null;
  const dir = parseDirRoot(jobId);
  const next = path
    ? openTab(s, jobId, path, now, keep)
    : dir
      ? selectProject(s, dir.projectId, jobId)
      : selectJob(s, jobId);
  return next.link === link ? next : { ...next, link };
}

// ── labels ──────────────────────────────────────────────────────────────────

export interface TabLabel {
  name: string;
  /** The parent folder, when another open tab has the same file name. */
  dir: string | null;
  /** The root, when the tabs span more than one. */
  job: string | null;
}

export function tabLabels(tabs: readonly Tab[], jobLabel: (root: string) => string): TabLabel[] {
  const name = (t: Tab): string => (t.path === null ? 'full diff' : (t.path.split('/').pop() ?? t.path));
  const parent = (t: Tab): string => {
    if (t.path === null) return '';
    const i = t.path.lastIndexOf('/');
    return i < 0 ? '' : t.path.slice(0, i);
  };
  const count = new Map<string, number>();
  for (const t of tabs) count.set(name(t), (count.get(name(t)) ?? 0) + 1);
  const jobs = new Set(tabs.map((t) => t.jobId));
  return tabs.map((t) => {
    const clash = t.path !== null && (count.get(name(t)) ?? 0) > 1;
    return {
      name: name(t),
      dir: clash ? parent(t) || '/' : null,
      job: jobs.size > 1 ? jobLabel(t.jobId) : null,
    };
  });
}

// ── persistence ─────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MAX_FOLDERS) : [];

function parseTab(v: unknown): Tab[] {
  if (!isObj(v) || typeof v['jobId'] !== 'string' || v['jobId'] === '') return [];
  const path = typeof v['path'] === 'string' && v['path'] !== '' ? v['path'] : null;
  if (v['path'] !== null && path === null) return [];
  const view = VIEWS.includes(v['view'] as View) ? (v['view'] as View) : 'rendered';
  const scroll: Partial<Record<View, number>> = {};
  if (isObj(v['scroll'])) {
    for (const k of VIEWS) {
      const y = v['scroll'][k];
      if (typeof y === 'number' && Number.isFinite(y) && y > 0) scroll[k] = Math.round(y);
    }
  }
  const seen = typeof v['seen'] === 'number' && Number.isFinite(v['seen']) ? v['seen'] : 0;
  return [{ jobId: v['jobId'], path, view, scroll, seen }];
}

/**
 * What localStorage held, made safe to use: anything malformed is dropped rather than
 * trusted, because a bad entry here would otherwise break the screen on every load.
 */
export function parseState(raw: string | null): FilesState {
  if (!raw) return EMPTY;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!isObj(v)) return EMPTY;

  const byKey = new Map<string, Tab>();
  for (const t of Array.isArray(v['tabs']) ? v['tabs'].flatMap(parseTab) : []) byKey.set(keyOf(t), t);
  let tabs = [...byKey.values()];
  if (tabs.length > MAX_TABS) {
    const kept = new Set([...tabs].sort((a, b) => b.seen - a.seen).slice(0, MAX_TABS));
    tabs = tabs.filter((t) => kept.has(t));
  }

  const active =
    typeof v['active'] === 'string' && byKey.has(v['active']) && tabs.includes(byKey.get(v['active'])!)
      ? v['active']
      : null;
  const stored = {
    ...EMPTY,
    project: typeof v['project'] === 'string' ? v['project'] : null,
    job: typeof v['job'] === 'string' ? v['job'] : null,
  };
  // The column follows the front tab, whatever was stored beside it.
  const { project, job } = active ? column(stored, byKey.get(active)!.jobId) : stored;

  // Folders only for roots still in view, so removed jobs and directories don't pile up.
  const live = new Set([...tabs.map((t) => t.jobId), ...(job ? [job] : [])]);
  const folders: Record<string, Folders> = {};
  if (isObj(v['folders'])) {
    for (const [id, f] of Object.entries(v['folders'])) {
      const shown = live.has(id) || (project !== null && parseDirRoot(id)?.projectId === project);
      if (shown && isObj(f)) folders[id] = { collapsed: strings(f['collapsed']), opened: strings(f['opened']) };
    }
  }

  return {
    tabs,
    active,
    project,
    job,
    folders,
    link: typeof v['link'] === 'string' ? v['link'] : null,
    pick: typeof v['pick'] === 'string' && inColumn({ project, job }, v['pick']) ? v['pick'] : null,
  };
}

export function serialize(s: FilesState): string {
  return JSON.stringify(s);
}
