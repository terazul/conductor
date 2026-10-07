/**
 * Screen 5 · FILES — read what the agents are writing, live.
 *
 * TRACK C owns this file. Registered by the glob in main.tsx (W0's), which is
 * why adding a screen means adding a file and never editing a router.
 *
 *   order 50 · hotkey 5 — the slot reserved for this track in CONTRACT.md §3.
 *
 * Layout follows mockups/conductor.html screen 5: a tree column (268px until you
 * drag its edge, F17) with the session diffstat pinned under it, and a pane that
 * switches between rendered markdown, raw text, and the diff. The left rail belongs
 * to Track B's shell and is deliberately absent here — this screen renders inside
 * whatever chrome is mounted, W0's fallback included.
 *
 * Everything on screen is derived: the badges come from git plus the event log,
 * the totals come from the tree response, and nothing polls.
 *
 * The column is one project's (Amendment 39): a tree for each of its directories and
 * nothing else, so what shows here is what you added to the project. Choosing one of
 * its jobs adds that job's worktree on top, where the agents' isolated changes are.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DiffResponse, FileContentResponse, FileNode, Project } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { currentRoute, onNavigate } from '../lib/nav.js';
import { useFeedStatus, useProjects } from '../lib/store.js';
import { errorText } from '../lib/errors.js';
import { Splitter } from '../shell/Splitter.js';
import { highlight, recall } from '../shell/nav.js';
import { useSetting, writeSetting } from '../lib/settings.js';
import { FileTree } from './FileTree.js';
import { FilePane } from './FilePane.js';
import { DiffView } from './DiffView.js';
import { TabStrip } from './TabStrip.js';
import {
  activate,
  activeTab,
  closeTab,
  dirRoot,
  keyOf,
  openTab,
  parseDirRoot,
  arrive,
  pickDone,
  selectJob,
  selectProject,
  setView,
  toggleFolder,
  type FilesState,
} from './tabs.js';
import { followLink, keep, update, useDirty, useFiles, useScrollMemory } from './useTabs.js';
import { TREE_DEFAULT, TREE_MIN, storedTreeWidth, treeMax, treeWidth } from './width.js';
import {
  imageUrl,
  isImagePath,
  openWorkspace,
  refreshRoot,
  useAgentRoles,
  useFileContent,
  useFileRevision,
  useFileTree,
  useJobChoices,
  type JobChoice,
  useTick,
  useTouches,
  useWholeDiff,
} from './useWorkspace.js';
import './files.css';

/** First changed file, else the first markdown file, else the first file at all. */
function pickInitial(root: FileNode): string | null {
  const flat: FileNode[] = [];
  const walk = (n: FileNode): void => {
    if (n.type === 'file') flat.push(n);
    for (const kid of n.children ?? []) walk(kid);
  };
  walk(root);
  return (
    flat.find((f) => f.change !== undefined && /\.mdx?$/i.test(f.name))?.path ??
    flat.find((f) => f.change !== undefined)?.path ??
    flat.find((f) => /\.mdx?$/i.test(f.name))?.path ??
    flat[0]?.path ??
    null
  );
}

/** The tree's entry for `path`, if it lists one. */
function findNode(root: FileNode, path: string): FileNode | null {
  for (const kid of root.children ?? []) {
    if (kid.path === path) return kid;
    if (kid.type === 'dir' && path.startsWith(`${kid.path}/`)) return findNode(kid, path);
  }
  return null;
}

/** Wall clock, re-read once a second, so "8s ago" ages on its own. */
function useNow(): number {
  const tick = useTick(1_000);
  return useMemo(() => Date.now(), [tick]);
}

const TREE_KEY = 'conductor.filesTreeW';

const onResize = (cb: () => void): (() => void) => {
  addEventListener('resize', cb);
  return () => removeEventListener('resize', cb);
};

/** The window's width, re-read when it changes. */
function useViewportWidth(): number {
  return useSyncExternalStore(onResize, () => innerWidth);
}

/** A directory's last path segment, which is what a person calls it. */
function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** One tree in the column: a job's worktree, or one of the project's directories. */
interface Root {
  root: string;
  /** What the section is headed with. */
  name: string;
  /** Its absolute path, for the hover. */
  where: string;
  job: JobChoice | null;
}

/** The roots the column shows for a project and a job. */
function rootsOf(project: Project | null, job: JobChoice | null): Root[] {
  const out: Root[] = [];
  if (job) out.push({ root: job.jobId, name: `⑂ ${job.branch}`, where: job.path, job });
  if (!project) return out;
  for (const dir of [project.path, ...(project.extraDirs ?? [])]) {
    // An in-place job's worktree IS the project's directory. Once is enough.
    if (job && dir === job.path) continue;
    out.push({ root: dirRoot(project.id, dir), name: baseName(dir), where: dir, job: null });
  }
  return out;
}

function Files() {
  const feed = useFeedStatus();
  const projects = useProjects();
  const { choices, error: choiceError, reload: reloadChoices } = useJobChoices();

  /*
   * What's open lives in the tab store (useTabs.ts), not in this component: this
   * screen unmounts whenever you leave it, and used to come back at the default pick
   * with everything you had open forgotten (Amendment 29). The column shows `project`
   * and `job`; the pane shows the active tab, which is always under one of their roots.
   */
  const s = useFiles();
  const dirty = useDirty();
  const tab = activeTab(s);
  const key = tab ? keyOf(tab) : null;
  const jobId = s.job;
  const root = tab?.jobId ?? null;
  const path = tab?.path ?? null;
  const wholeDiff = tab !== null && tab.path === null;

  /** Written straight after a PUT so the pane doesn't wait for the refetch. */
  const [justSaved, setJustSaved] = useState<{ key: string; file: FileContentResponse } | null>(
    null,
  );

  const now = useNow();

  /*
   * The tree's width (F17). Persisted, because this screen remounts on every navigation
   * and a file link from a transcript brings you here often. What's kept is the width
   * you dragged to; what's drawn is that, fitted to the window you have now.
   */
  const viewport = useViewportWidth();
  // In the settings file (Amendment 46), like every other size.
  const treeW = storedTreeWidth(useSetting(TREE_KEY));
  const setTreeW = (px: number): void => writeSetting(TREE_KEY, String(px));
  const shownW = treeWidth(treeW, viewport);

  /**
   * Deep links (Amendment 3). `navigate('files', { jobId, path })` from anywhere
   * — Fleet's `▤ files` affordance, a transcript's file reference — opens that file's
   * tab, or brings it forward, against the job the link names.
   *
   * Read-only on purpose. `navigate()` assigns `location.hash`, which PUSHES a
   * history entry, so mirroring every tab and tree click back into the hash would
   * mean twenty presses of Back to escape a browse. Deliberate jumps write the hash;
   * browsing inside one screen does not.
   *
   * Pressing `5` calls `navigate('files')` with no params, so it never disturbs
   * the tab in front.
   */
  useEffect(() => {
    const route = currentRoute();
    if (route.id === 'files') followLink(route.params, true);
    return onNavigate((id, params) => {
      if (id === 'files') followLink(params, false);
    });
  }, []);

  /*
   * A job's project, which the tab store can't know: a link names only the job. The
   * column shows the job's project whatever was stored, and the store is told, so a
   * click in one of that project's directories keeps the job beside it.
   */
  const job = choices.find((c) => c.jobId === jobId) ?? null;
  const projectId = job?.projectId ?? s.project;
  useEffect(() => {
    if (!job) return;
    update((st) => (st.job === job.jobId && st.project !== job.projectId ? { ...st, project: job.projectId } : st));
  }, [job?.jobId, job?.projectId]);
  const project = projects.find((p) => p.id === projectId) ?? null;

  /**
   * Which project the column opens on, once per arrival (Amendment 91's one rule, which
   * widens Amendment 44's): the project the route itself names (with no job), else the
   * one last highlighted anywhere, else the first — and whichever wins, a job already
   * open for a DIFFERENT project gives way, because `arrive` always re-decides rather
   * than trusting that Files already agrees with itself. A link naming a job or a file
   * decides for itself, in the effect above; `linked` keeps this out of its way.
   *
   * It reads the store as it is now, not as this render saw it, so a link followed a
   * moment ago wins. That was the flash — the link opened its file, then the default
   * switched the column out from under it to the first project, and the pane went blank.
   * Once per arrival, and only after the projects have loaded: re-running on every
   * snapshot would drag the column back while you browse.
   */
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || projects.length === 0) return;
    arrived.current = true;
    const { id, params } = currentRoute();
    const linked = id === 'files' && Boolean(params['jobId']);
    const at = (p: Project | undefined) => (p ? { id: p.id, first: dirRoot(p.id, p.path) } : null);
    // A route that names a project but no job is a weaker link than one that names a
    // job or a file (`applyLink` already handled those, above) — but it still outranks
    // what was merely remembered.
    const route = id === 'files' && !linked ? at(projects.find((p) => p.id === params['projectId'])) : null;
    const remembered = at(projects.find((p) => p.id === recall().projectId));
    update((st) => arrive(st, { route, remembered, first: at(projects[0]) }, linked));
  }, [projects]);

  // The column's project is the highlighted one from here on, whoever chose it.
  useEffect(() => {
    if (projectId && projects.some((p) => p.id === projectId)) highlight(projectId);
  }, [projectId, projects]);

  const roots = useMemo(() => rootsOf(project, job), [project, job]);

  // The active tab's tree, for the summary and the pane; its section reuses this one.
  const tree = useFileTree(root);
  const touches = useTouches(root);
  const roles = useAgentRoles(root);
  const diff = useWholeDiff(root, wholeDiff);
  const fetched = useFileContent(root, path);
  // Same revision the text path uses, so an overwritten image reloads too.
  const imageRev = useFileRevision(root, path);

  useEffect(() => {
    setJustSaved(null);
  }, [fetched.data]);

  const tabTree = tree.data?.root;
  const file = justSaved && justSaved.key === key ? justSaved.file : fetched.data;
  const node = useMemo(() => (tabTree && path ? findNode(tabTree, path) : null), [tabTree, path]);
  const has = useMemo(
    () => (tabTree ? (p: string) => findNode(tabTree, p)?.type === 'file' : undefined),
    [tabTree],
  );

  const role = useMemo(() => {
    if (!path) return undefined;
    const agentId = touches.get(path)?.agentId ?? file?.lastWriteBy ?? null;
    return agentId ? (roles.get(agentId) ?? agentId.slice(0, 8)) : undefined;
  }, [path, touches, roles, file?.lastWriteBy]);

  // Fixture replay has no daemon behind it, so say so rather than showing an
  // endless spinner against endpoints that cannot answer.
  if (feed === 'fixture') {
    return (
      <div className="c5-empty">
        <p>
          Screen 5 reads the worktree over REST, so it needs the daemon — fixture replay has
          no files behind it.
        </p>
        <p className="c5-note">
          run <code>pnpm --filter @conductor/web dev</code> without <code>VITE_FIXTURE</code>
        </p>
      </div>
    );
  }

  // Nothing to browse AND nothing asked for or kept open. A deep link naming a job
  // whose snapshot hasn't landed yet should wait for it, not be shown a setup form.
  if (projects.length === 0 && choices.length === 0 && jobId === null && s.tabs.length === 0) {
    return <Bootstrap error={choiceError} onOpened={reloadChoices} />;
  }

  const totals = tree.data;
  const changed = totals?.changedFiles ?? 0;
  const rootLabel = (id: string): string => {
    const d = parseDirRoot(id);
    if (d) return baseName(d.dir);
    return choices.find((c) => c.jobId === id)?.label ?? id.slice(0, 8);
  };
  // Before the lists have loaded, nothing is gone; it just hasn't been counted.
  const isGone = (id: string): boolean => {
    const d = parseDirRoot(id);
    if (d) {
      if (projects.length === 0) return false;
      const p = projects.find((x) => x.id === d.projectId);
      return !p || (p.path !== d.dir && !(p.extraDirs ?? []).includes(d.dir));
    }
    return choices.length > 0 && !choices.some((c) => c.jobId === id);
  };
  const close = (k: string): void => update((st) => closeTab(st, k));
  const projectJobs = choices.filter((c) => c.projectId === projectId);
  const activeName = root ? rootLabel(root) : null;

  let pane: React.ReactNode;
  if (tab && key && wholeDiff) {
    pane = <WholeDiffPane tabKey={key} diff={diff} onClose={() => close(key)} />;
  } else if (tab && key && path && isImagePath(path)) {
    /*
     * An image bypasses the text pane entirely (Amendment 25). It has no diff, no
     * editor and no markdown, so routing it through FilePane would mean four
     * branches inside a component built for text — and `useFileContent` does not
     * even fetch it.
     */
    pane = (
      <div className="c5-pane">
        <div className="c5-panehead">
          <span className="c5-crumb">
            <b>{path}</b>
          </span>
          {node?.change?.deleted && <span className="c5-tag gone">deleted</span>}
          {!node?.change?.deleted && (
            <div className="c5-actions">
              <a
                className="c5-btn"
                href={imageUrl(tab.jobId, path, imageRev)}
                target="_blank"
                rel="noreferrer"
              >
                ↗ full size
              </a>
            </div>
          )}
        </div>
        <div className="c5-panebody">
          {node?.change?.deleted ? (
            // The image route reads the disk, and the disk no longer has it.
            <div className="c5-banner">
              Deleted from the worktree. Git still has the image, but this pane shows
              images only from disk — its removal is in the full diff.
            </div>
          ) : (
            <div className="c5-img">
              {/* Checkerboard behind it, because a transparent PNG on a dark pane
                  is indistinguishable from a black one. */}
              <img src={imageUrl(tab.jobId, path, imageRev)} alt={path} />
            </div>
          )}
        </div>
      </div>
    );
  } else if (tab && key && path && fetched.error) {
    pane = (
      <Unavailable
        path={path}
        error={fetched.error}
        status={fetched.status}
        onRetry={fetched.reload}
        onClose={() => close(key)}
      />
    );
  } else if (tab && key && file) {
    pane = (
      <FilePane
        key={key}
        tabKey={key}
        jobId={tab.jobId}
        file={file}
        view={tab.view}
        onView={(v) => update((st) => setView(st, key, v))}
        role={role}
        now={now}
        onSaved={(saved) => setJustSaved({ key, file: saved })}
        has={has}
      />
    );
  } else {
    pane = (
      <div className="c5-pane">
        <div className="c5-panebody">
          <div className="c5-note">{tab || s.pick !== null ? 'opening…' : 'pick a file'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="c5-root">
      <div className="c5-col" style={{ width: `${shownW}px` }}>
        <div className="c5-colhead">
          <div className="c5-jobrow">
            <span className="c5-lab">Project</span>
          </div>
          <div className="c5-jobrow">
            <select
              className="c5-select"
              value={projectId ?? ''}
              onChange={(e) => {
                const p = projects.find((x) => x.id === e.target.value);
                if (p) update((st) => selectProject(st, p.id, dirRoot(p.id, p.path)));
              }}
              aria-label="project"
            >
              {/* A removed project, or one whose snapshot hasn't landed: say so rather
                  than showing another project's name over this one's trees. */}
              {!project && <option value={projectId ?? ''}>{projectId ? 'unavailable' : '—'}</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="c5-jobrow">
            <select
              className="c5-select"
              value={jobId ?? ''}
              onChange={(e) => {
                const id = e.target.value || null;
                update((st: FilesState) => selectJob(st, id));
              }}
              aria-label="job"
            >
              <option value="">no job · the directories as they are</option>
              {/* A deep-linked, restored or removed job may not be in `choices`. Show
                  it rather than letting the select silently display a different job
                  than the one the rest of the screen is talking about. */}
              {jobId && !job && <option value={jobId}>{jobId.slice(0, 8)} (unavailable)</option>}
              {projectJobs.map((c) => (
                <option key={c.jobId} value={c.jobId}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {job && (
            <div className="c5-branch" title={job.path}>
              ⑂ <b>{job.branch}</b> · {job.isolation}
            </div>
          )}
        </div>

        <div className="c5-treewrap">
          {roots.map((r) => (
            <RootSection
              key={r.root}
              r={r}
              shared={r.root === root ? tree : undefined}
              selected={r.root === root ? path : null}
              folders={s.folders[r.root]}
              picking={s.pick === r.root}
              now={now}
            />
          ))}
          {project ? (
            <div className="c5-note c5-rootnote">
              Only {project.name}'s directories show here. Add others to the project on Fleet
              (<code>1</code>).
            </div>
          ) : (
            roots.length === 0 && <div className="c5-note">choose a project</div>
          )}
        </div>

        <div className="c5-summary">
          <span className="c5-lab" title={activeName ?? undefined}>
            Changed{activeName ? ` · ${activeName}` : ''}
          </span>
          <div className="c5-kv">
            <span>
              {changed} file{changed === 1 ? '' : 's'}
            </span>
            <span>
              <b className="c5-pos">+{totals?.added ?? 0}</b>{' '}
              <b className="c5-neg">−{totals?.removed ?? 0}</b>
            </span>
          </div>
          <button
            type="button"
            className={`c5-btn${wholeDiff ? ' on' : ''}`}
            aria-pressed={wholeDiff}
            onClick={() => {
              if (!root) return;
              if (wholeDiff && key) close(key);
              else update((st) => openTab(st, root, null, Date.now(), keep));
            }}
            disabled={!root || (!wholeDiff && changed === 0)}
          >
            ⑂ review full diff
          </button>
        </div>
      </div>

      {/* A drag fits the width to this window before keeping it, so a drag past the
          limit doesn't save a width you never saw. */}
      <Splitter
        orientation="vertical"
        size={shownW}
        min={TREE_MIN}
        max={treeMax(viewport)}
        grow={1}
        onSize={(w) => setTreeW(treeWidth(w, viewport))}
        onReset={() => setTreeW(TREE_DEFAULT)}
        label="Resize the file tree"
      />

      <div className="c5-main">
        <TabStrip
          tabs={s.tabs}
          active={s.active}
          jobLabel={rootLabel}
          isGone={isGone}
          dirty={dirty}
          onActivate={(k) => update((st) => activate(st, k, Date.now()))}
          onClose={close}
        />
        {pane}
      </div>
    </div>
  );
}

/**
 * One root's tree under its own heading. A job's worktree is watched; a directory is
 * read when you open it or press ↻, since nothing tells Conductor it changed.
 */
function RootSection({
  r,
  shared,
  selected,
  folders,
  picking,
  now,
}: {
  r: Root;
  /** The screen's own read of this root, when it is the active tab's — one fetch, not two. */
  shared: ReturnType<typeof useFileTree> | undefined;
  selected: string | null;
  folders: FilesState['folders'][string] | undefined;
  /** This root is waiting for its default pick. */
  picking: boolean;
  now: number;
}) {
  const own = useFileTree(shared ? null : r.root);
  const tree = shared ?? own;
  const touches = useTouches(r.root);
  const roles = useAgentRoles(r.root);
  const top = tree.data?.root;

  // Chosen with nothing open: its default pick, once its tree lands.
  useEffect(() => {
    if (!top || !picking) return;
    update((st) => {
      if (st.pick !== r.root) return st;
      const p = pickInitial(top);
      return p ? openTab(st, r.root, p, Date.now(), keep) : pickDone(st);
    });
  }, [top, picking, r.root]);

  const changed = tree.data?.changedFiles ?? 0;
  return (
    <section className="c5-rootsec" aria-label={r.where}>
      <div className="c5-roothead" title={r.where}>
        <span className="c5-rootname">{r.name}</span>
        {changed > 0 && (
          <span className="c5-rootstat">
            {changed} changed
          </span>
        )}
        {r.job ? (
          <span className={`c5-tag ${tree.error ? 'idle' : 'live'}`}>
            {tree.error ? 'unavailable' : '◉ watching'}
          </span>
        ) : (
          <button
            type="button"
            className="c5-iconbtn"
            onClick={() => refreshRoot(r.root)}
            title={`Read ${r.where} again`}
            aria-label={`Read ${r.name} again`}
          >
            ↻
          </button>
        )}
      </div>
      {tree.data?.truncated ? (
        // Amendment 4's field. Never silent: a file browser that omits files
        // without saying so makes someone conclude the file doesn't exist.
        <div className="c5-truncated" role="note">
          ⚠ {tree.data.truncated.toLocaleString()} more file
          {tree.data.truncated === 1 ? '' : 's'} not shown — this tree is capped. Narrow the
          directory or use the diff view to find recent work.
        </div>
      ) : null}
      {tree.error ? (
        <div className="c5-error">{tree.error}</div>
      ) : tree.data ? (
        <FileTree
          root={tree.data.root}
          selected={selected}
          onSelect={(p) => update((st) => openTab(st, r.root, p, Date.now(), keep))}
          folders={folders}
          onToggle={(p, open) => update((st) => toggleFolder(st, r.root, p, open))}
          touches={touches}
          roles={roles}
          now={now}
        />
      ) : (
        <div className="c5-note">reading {r.job ? 'the worktree' : 'the directory'}…</div>
      )}
    </section>
  );
}

/** A job's whole-worktree diff, as a tab — so it keeps its scroll like any other. */
function WholeDiffPane({
  tabKey,
  diff,
  onClose,
}: {
  tabKey: string;
  diff: { data: DiffResponse | null; error: string | null };
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);
  // Only once there's something to scroll: restoring onto "diffing…" would clamp to 0.
  useScrollMemory(body, tabKey, diff.data ? 'diff' : null);
  return (
    <div className="c5-pane">
      <div className="c5-panehead">
        <span className="c5-crumb">
          <b>full worktree diff</b>
        </span>
        <span className="c5-tag done">
          {diff.data?.files ?? 0} files · +{diff.data?.added ?? 0} −{diff.data?.removed ?? 0}
        </span>
        <div className="c5-actions">
          <button type="button" className="c5-btn" onClick={onClose}>
            close
          </button>
        </div>
      </div>
      <div ref={body} className="c5-panebody flush">
        {diff.error ? (
          <div className="c5-error">{diff.error}</div>
        ) : diff.data ? (
          <DiffView diff={diff.data.diff} />
        ) : (
          <div className="c5-note">diffing…</div>
        )}
      </div>
    </div>
  );
}

/**
 * A tab whose file can't be shown, saying which of the reasons it is. Before, all of
 * these were one red line, or — for a crash in the daemon — a pane that flashed and
 * stayed empty.
 */
function Unavailable({
  path,
  error,
  status,
  onRetry,
  onClose,
}: {
  path: string;
  error: string;
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [title, hint, fail] =
    status === 404
      ? ['Not in this worktree', 'It may have been moved, or removed since this tab was opened.', false]
      : status === 413
        ? ['Too large to show here', 'Open it in an editor, or read what changed in the full diff.', false]
        : status === 415
          ? ['Not a text file', 'This pane shows text and common image types.', false]
          : status === null
            ? ["Can't reach the daemon", 'Is it running? `make restart` starts it again.', true]
            : status >= 500
              ? ['The daemon failed reading it', 'That is a bug in Conductor, not in your file.', true]
              : ["Couldn't open it", '', true];
  return (
    <div className="c5-pane">
      <div className="c5-panehead">
        <span className="c5-crumb">
          <b>{path}</b>
        </span>
      </div>
      <div className="c5-panebody">
        <div className={`c5-unavail${fail ? ' fail' : ''}`} role="status">
          <b>{title}</b>
          {hint && <p>{hint}</p>}
          <p className="c5-note">{error}</p>
          <div className="c5-actions">
            <button type="button" className="c5-btn" onClick={onRetry}>
              retry
            </button>
            <button type="button" className="c5-btn" onClick={onClose}>
              close tab
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * No workspaces yet. Until the session engine (Track A) creates jobs, this is how
 * a worktree gets prepared — the same WorktreeMgr call, reached over HTTP.
 */
function Bootstrap({ error, onOpened }: { error: string | null; onOpened: () => void }) {
  const [repo, setRepo] = useState('');
  const [isolation, setIsolation] = useState<'worktree' | 'branch' | 'in_place'>('worktree');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await openWorkspace(repo.trim(), isolation);
      onOpened();
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="c5-empty">
      <p>No worktree to show yet.</p>
      <p className="c5-note">
        Spawn a job on screen <code>7</code>, or open a repository directly:
      </p>
      <div className="c5-bootstrap">
        <input
          className="c5-input"
          placeholder="/absolute/path/to/a/git/repo"
          value={repo}
          spellCheck={false}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && repo.trim().length > 0) void open();
          }}
          aria-label="repository path"
        />
        <select
          className="c5-select"
          style={{ flex: 'none', width: 108 }}
          value={isolation}
          onChange={(e) => setIsolation(e.target.value as typeof isolation)}
          aria-label="isolation"
        >
          <option value="worktree">worktree</option>
          <option value="branch">branch</option>
          <option value="in_place">in place</option>
        </select>
        <button
          type="button"
          className="c5-btn primary"
          onClick={() => void open()}
          disabled={busy || repo.trim().length === 0}
        >
          {busy ? 'opening…' : 'open'}
        </button>
      </div>
      <p className="c5-note">
        <code>worktree</code> cuts a clean checkout under <code>.conductor/wt/</code>;{' '}
        <code>in place</code> shows the repository as it stands, uncommitted work included.
      </p>
      {(failure ?? error) && <div className="c5-error">{failure ?? error}</div>}
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'files',
  label: 'Files',
  hotkey: '5',
  order: 50,
  Component: Files,
};
