/**
 * The project navigator: the shell's left panel, on every screen.  TRACK B.  (Amendment 66)
 *
 * It was the Project screen's column, which only that screen drew, so the Agent and Files
 * screens had no way across to another project. The shell draws it now, beside whatever
 * screen is up, and it stays up when you open something from it.
 *
 * Each project has three submenus, each opening on its own:
 *
 *  - AGENTS, grouped by job (Amendment 86): each job's prompt on one line, its agent
 *    count, its unhappiest agent's dot and what waits on you, opening and closing on its
 *    own and open to start with. Under it, one row per agent with its status dot, and a
 *    count when something waits on it. A click opens the agent; the panel stays.
 *  - NEEDS YOU, this project's waiting requests and alerts, one row each. Its heading is
 *    amber, with a count, whenever any wait. A click opens that one in Needs you.
 *  - FILES, the project's folders, main first, each opening into its directories as a
 *    tree (Amendment 92): a folder row opens and closes, fetching its tree with the
 *    Files screen's own `useFileTree` the first time it's opened; a file row opens that
 *    file on the Files screen. No change marks here, unlike the Files tree itself.
 *    A file or folder in it can be renamed (✎, F2) and deleted (⌫, Delete or ⌘⌫), with
 *    the Files tree's own box and confirm.
 *
 * An agent's row has its budget meter, the Fleet lane's thin bar in the Fleet's tones
 * (`pj-meter` with `data-tone`, fleet/fleet.css:1035), and a job's heading the sum of its
 * agents' (Amendment 140). No budget, no bar: a job with no budgeted agent has none.
 *
 * Amber in this panel is only ever a count of things waiting on you — that heading, the
 * project's name, an agent's row — never a selection or a hover (CONTRACT §5.1).
 *
 * A project's name opens its Project screen, which highlights it; the chevron beside it
 * only opens and closes it. What's in each list, and what's open, is navtree.ts.
 *
 * THE PROJECTS ARE IN THE FLEET'S ORDER (Amendment 69): the same two settings, read
 * through `navProjects`, so a new Sort by on Fleet reorders the panel too. Drag a
 * project's row onto another to put it there, as on Fleet: that writes your order and
 * switches the sort to `mine`, so the grid moves with it. Dropping below the last project
 * puts it at the end.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FileNode } from '@conductor/shared';
import { currentRoute, navigate, onNavigate, type NavParams } from '../lib/nav.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { useAgents, useAlerts, useJobs, usePending, useProjectSpend, useProjects } from '../lib/store.js';
import { useUnseenAgents, useUnseenJobs } from '../lib/seen.js';
import { ORDER_KEY, SORT_KEY } from '../fleet/order.js';
import { createFile, isImagePath, renameEntry, useFileTree } from '../files/useWorkspace.js';
import { NewFileForm } from '../files/NewFileForm.js';
import { DeleteConfirm } from '../files/DeleteConfirm.js';
import { onDisk } from '../files/deleting.js';
import { followRename, openNew } from '../files/useTabs.js';
import { SCREEN, openAgent, openProject, recall } from './nav.js';
import {
  NAV_TREE_KEY,
  currentProject,
  isOpen,
  jobShown,
  meterTitle,
  navDirId,
  navDrop,
  navFileLink,
  navId,
  navJobId,
  navProjects,
  navTree,
  parseOpen,
  serializeOpen,
  toggleOpen,
  type NavAgent,
  type NavFolder,
  type NavJob,
  type NavPart,
  type NavProject,
} from './navtree.js';
import { NAV_PANEL, usePanel } from './panels.js';
import { Splitter } from './Splitter.js';
import { Chevron, Dot, OrchestratorMark, STATUS_WORD, tildePath } from './ui.js';
import type { Budget } from './autonomy.js';
import '../fleet/fleet.css';

/** The screen up now and its params, kept current by every navigation. */
export function useRoute(): { id: string; params: NavParams } {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => onNavigate((id, params) => setRoute({ id, params })), []);
  return route;
}

/**
 * Flip one node. Read from the settings now, not from this render, so two quick clicks
 * on two nodes both land — and each leaves every other node as it was.
 */
function toggle(id: string): void {
  writeSetting(NAV_TREE_KEY, serializeOpen(toggleOpen(parseOpen(readSetting(NAV_TREE_KEY)), id)));
}

function Submenu({
  project,
  part,
  open,
  title,
  count,
  lit = false,
  children,
}: {
  project: NavProject;
  part: NavPart;
  open: ReadonlySet<string>;
  title: string;
  /** Null for none at all: Needs you shows a count only when something waits. */
  count: number | null;
  /** Amber: something here waits on you. */
  lit?: boolean;
  children: React.ReactNode;
}) {
  const id = navId(project.id, part);
  const shown = isOpen(open, id);
  return (
    <div className="sh-nav-sub">
      <button
        type="button"
        className={`sh-nav-head${lit ? ' is-need' : ''}`}
        aria-expanded={shown}
        onClick={() => toggle(id)}
        title={`${shown ? 'Close' : 'Open'} ${title} in ${project.name}`}
      >
        <Chevron open={shown} />
        <span className="sh-nav-label">{title}</span>
        {count !== null && <span className="sh-nav-n">{count}</span>}
      </button>
      {shown && <div className="sh-nav-items">{children}</div>}
    </div>
  );
}

/**
 * The thin budget bar of a row (Amendment 140): the Fleet lane's `pj-meter`, with the same
 * `data-tone`, sized for the panel by `sh-nav-meter` (shell.css). Nothing for no budget.
 */
function NavMeter({ budget, whose }: { budget: Budget | null; whose: string }) {
  if (!budget) return null;
  return (
    <span className="pj-meter sh-nav-meter" data-tone={budget.tone} title={meterTitle(budget, whose)} aria-label={meterTitle(budget, whose)}>
      <i style={{ width: `${Math.round(budget.fraction * 100)}%` }} />
    </span>
  );
}

function AgentRow({ agent: a, projectId, selected }: { agent: NavAgent; projectId: string; selected: boolean }) {
  return (
    <button
      type="button"
      className={`sh-nav-row${selected ? ' is-sel' : ''}`}
      onClick={() => openAgent({ id: a.id, jobId: a.jobId, projectId })}
      title={`${a.needs > 0 ? `${a.label} — waiting on you` : `${a.label} — ${STATUS_WORD[a.status]}`}${a.orchestrator ? ' · orchestrator: starts the others' : ''}`}
    >
      <Dot status={a.status} />
      <span className="sh-nav-label">{a.label}</span>
      {/* The orchestrator of an orchestrated stack, as its Agent tab marks it (agent/agent.tsx:636, Amendment 142). */}
      {a.orchestrator && <OrchestratorMark short />}
      {/* Filled, the same look as the Fleet lane's Tag (Amendment 94). Finished only until
          you open the agent, and again when it finishes again (Amendment 105). */}
      {a.status === 'working' && <span className="sh-nav-tag is-live">working</span>}
      {a.finished && <span className="sh-nav-tag is-done">finished</span>}
      <NavMeter budget={a.budget} whose={`${a.label}'s daily budget`} />
      {a.needs > 0 && <span className="sh-nav-need">{a.needs}</span>}
    </button>
  );
}

/** One job's agents under a project's Agents (Amendment 86). Open until you close it. */
function JobGroup({
  project,
  job,
  open,
  agentId,
}: {
  project: NavProject;
  job: NavJob;
  open: ReadonlySet<string>;
  agentId: string | undefined;
}) {
  const id = navJobId(project.id, job.id);
  const shown = jobShown(open, id);
  const count = `${job.agents.length} ${job.agents.length === 1 ? 'agent' : 'agents'}`;
  return (
    <div className="sh-nav-job">
      <button
        type="button"
        className="sh-nav-row sh-nav-jhead"
        aria-expanded={shown}
        onClick={() => toggle(id)}
        title={`${job.label} — ${count}${job.needs > 0 ? `, ${job.needs} waiting on you` : ''}${job.finished ? ', finished' : ''}`}
      >
        <Chevron open={shown} />
        <Dot status={job.status} />
        <span className="sh-nav-label">{job.label}</span>
        <span className="sh-nav-n">{job.agents.length}</span>
        {job.finished ? (
          <span className={`sh-nav-tag is-${job.status === 'failed' ? 'fail' : 'done'}`}>finished</span>
        ) : (
          job.status === 'working' && <span className="sh-nav-tag is-live">working</span>
        )}
        <NavMeter budget={job.budget} whose="its agents' daily budgets together" />
        {job.needs > 0 && <span className="sh-nav-need">{job.needs}</span>}
      </button>
      {shown && (
        <div className="sh-nav-items">
          {job.agents.map((a) => (
            <AgentRow key={a.id} agent={a} projectId={project.id} selected={a.id === agentId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One drag of a project row: which is moving, and where it would land (null: the end). */
interface NavDrag {
  dragging: string | null;
  over: string | null | undefined;
  start: (id: string) => void;
  /** Undefined: over nowhere a drop would land, such as the row being dragged. */
  hover: (target: string | null | undefined) => void;
  drop: (target: string | null) => void;
  end: () => void;
}

/**
 * A new file from the navigator (Amendment 138): which folder's name box is open, under
 * one of a project's folders, and how to make the file. The box is the Files tree's own
 * (`NewFileForm`, Amendment 121) and the file is made the same way (`createFile`); once
 * made it opens in Files, ready to type (`openNew`), and the box goes.
 */
interface NavAdd {
  /** The folder whose box is open, as a tree path ('' is the folder itself), or null. */
  at: string | null;
  open: (dir: string) => void;
  create: (path: string) => Promise<void>;
  cancel: () => void;
}

/** The + beside a folder's row: a sibling of the row's button, as in the Files tree. */
function AddButton({ dir, label, add }: { dir: string; label: string; add: NavAdd }) {
  return (
    <button
      type="button"
      className="sh-nav-add"
      onClick={() => add.open(dir)}
      title={`New file in ${label}`}
      aria-label={`New file in ${label}`}
      aria-pressed={add.at === dir}
    >
      +
    </button>
  );
}

/** The name box, under the folder that asked. */
function AddForm({ dir, add }: { dir: string; add: NavAdd }) {
  return add.at === dir ? (
    <NewFileForm key={`n:${dir}`} dir={dir} indent={0} onCreate={add.create} onCancel={add.cancel} />
  ) : null;
}

/**
 * Rename and delete from the navigator (Amendment 159), as the Files tree has them: the
 * rename is its name box in the row's place, and the open tabs follow the rename
 * (`renameEntry`, then `followRename`); the delete is its confirm under the row
 * (`DeleteConfirm`, which closes the tabs the delete took). One box at a time, with the +.
 */
interface NavEdit {
  /** The entry whose rename box is open, or null. */
  renaming: string | null;
  rename: (path: string) => void;
  renamed: (from: string, to: string) => Promise<void>;
  /** The entry a delete is asking about, or null. */
  deleting: FileNode | null;
  remove: (node: FileNode) => void;
  /** Put the rename box or the confirm away. */
  done: () => void;
}

/** ✎ and ⌫ beside a row, after a folder's +. */
function EditButtons({ node, edit }: { node: FileNode; edit: NavEdit }) {
  return (
    <>
      <button
        type="button"
        className="sh-nav-add"
        onClick={() => edit.rename(node.path)}
        title={`Rename ${node.path} (F2)`}
        aria-label={`Rename ${node.path}`}
      >
        ✎
      </button>
      <button
        type="button"
        className="sh-nav-add sh-nav-del"
        onClick={() => edit.remove(node)}
        title={`Delete ${node.path} (Delete)`}
        aria-label={`Delete ${node.path}`}
        aria-pressed={edit.deleting?.path === node.path}
      >
        ⌫
      </button>
    </>
  );
}

/** F2 renames the row's entry, and Delete (or ⌘⌫) deletes it, as in the Files tree. */
function editKeys(e: React.KeyboardEvent<HTMLElement>, node: FileNode, edit: NavEdit): void {
  if (e.key === 'F2') edit.rename(node.path);
  else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) edit.remove(node);
  else return;
  e.preventDefault();
}

/** The rename box, in the row's place. */
function RenameForm({ node, edit }: { node: FileNode; edit: NavEdit }) {
  return (
    <NewFileForm
      key={`r:${node.path}`}
      kind={node.type === 'dir' ? 'rename-dir' : 'rename-file'}
      dir={node.path}
      indent={0}
      onCreate={(to) => edit.renamed(node.path, to)}
      onCancel={edit.done}
    />
  );
}

/** The delete's confirm, under its row. */
function DeleteForm({ node, root, edit }: { node: FileNode; root: string; edit: NavEdit }) {
  return edit.deleting?.path === node.path ? (
    <DeleteConfirm key={node.path} root={root} node={edit.deleting} onDone={edit.done} onCancel={edit.done} />
  ) : null;
}

/**
 * One directory's children, inside a Files folder's tree (Amendment 92). Dirs first,
 * then files: the order the daemon already builds the tree in (`workspace/tree.ts`'s
 * `finish`), so this walks `node.children` as given rather than sorting again. A dir
 * row opens and closes a nested copy of this same list; a file row opens the file. A
 * dir row has a + (Amendment 138); a row on disk has ✎ and ⌫.
 */
function FileRows({
  node,
  projectId,
  root,
  open,
  add,
  edit,
}: {
  node: FileNode;
  projectId: string;
  root: string;
  open: ReadonlySet<string>;
  add: NavAdd;
  edit: NavEdit;
}) {
  return (
    <>
      {(node.children ?? []).map((kid) => {
        const here = onDisk(kid);
        if (kid.type === 'file') {
          if (here && edit.renaming === kid.path) return <RenameForm key={`r:${kid.path}`} node={kid} edit={edit} />;
          const row = (
            <button
              key={`f:${kid.path}`}
              type="button"
              className="sh-nav-row"
              onClick={() => navigate(SCREEN.files, navFileLink(root, kid.path))}
              onKeyDown={here ? (e) => editKeys(e, kid, edit) : undefined}
              title={kid.path}
            >
              <span className="sh-nav-label">{kid.name}</span>
            </button>
          );
          // A file git lists only because it was deleted has nothing on disk to rename or delete.
          return here ? (
            <div className="sh-nav-file" key={`f:${kid.path}`}>
              <div className="sh-nav-dirrow">
                {row}
                <EditButtons node={kid} edit={edit} />
              </div>
              <DeleteForm node={kid} root={root} edit={edit} />
            </div>
          ) : (
            row
          );
        }
        const id = navDirId(projectId, root, kid.path);
        const shown = isOpen(open, id);
        return (
          <div className="sh-nav-dir" key={`d:${kid.path}`}>
            {edit.renaming === kid.path ? (
              <RenameForm node={kid} edit={edit} />
            ) : (
              <div className="sh-nav-dirrow">
                <button
                  type="button"
                  className="sh-nav-row"
                  aria-expanded={shown}
                  onClick={() => toggle(id)}
                  onKeyDown={(e) => editKeys(e, kid, edit)}
                  title={`${shown ? 'Close' : 'Open'} ${kid.name}`}
                >
                  <Chevron open={shown} />
                  <span className="sh-nav-label">{kid.name}</span>
                  {/* A nested repo's branch, as a quiet mark beside its folder (Amendment 94). */}
                  {kid.repo && <span className="sh-nav-repo">⑂ {kid.repo.branch ?? 'detached'}</span>}
                </button>
                <AddButton dir={kid.path} label={kid.path} add={add} />
                <EditButtons node={kid} edit={edit} />
              </div>
            )}
            <DeleteForm node={kid} root={root} edit={edit} />
            <AddForm dir={kid.path} add={add} />
            {shown && (
              <div className="sh-nav-items">
                <FileRows node={kid} projectId={projectId} root={root} open={open} add={add} edit={edit} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * A folder's tree, fetched with the same hook the Files screen uses
 * (`useFileTree`, `files/useWorkspace.ts:297`). Mounted only while the folder's node is
 * open, so a folder nobody opens never costs a request; reopening it shows the last
 * copy at once while a fresh one is asked for.
 */
function FolderTree({
  projectId,
  root,
  open,
  add,
  edit,
}: {
  projectId: string;
  root: string;
  open: ReadonlySet<string>;
  add: NavAdd;
  edit: NavEdit;
}) {
  const tree = useFileTree(root);
  if (tree.error) return <span className="sh-nav-none">{tree.error}</span>;
  if (!tree.data) return <span className="sh-nav-none">{tree.loading ? 'loading…' : 'no files'}</span>;
  return <FileRows node={tree.data.root} projectId={projectId} root={root} open={open} add={add} edit={edit} />;
}

/**
 * One of a project's folders under Files (Amendment 92): opens and closes like any
 * other node, and while open shows its directories as a tree, folders first, then
 * files. A file row opens that file on the Files screen; nothing here changes marks.
 *
 * It and each folder in it have a + on hover or focus (Amendment 138), which opens the
 * Files tree's name box in place. The file is made where you were looking and opened in
 * Files ready to type; the panel stays as it was.
 *
 * What is in it can be renamed and deleted; the folder itself cannot,
 * as the Files tree's root cannot.
 */
function FolderNode({
  project,
  folder,
  open,
}: {
  project: NavProject;
  folder: NavFolder;
  open: ReadonlySet<string>;
}) {
  const id = navDirId(project.id, folder.root, '');
  const shown = isOpen(open, id);
  const [at, setAt] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FileNode | null>(null);
  const edit: NavEdit = {
    renaming,
    rename: (path) => {
      setAt(null);
      setDeleting(null);
      setRenaming(path);
    },
    renamed: async (from, to) => {
      const done = await renameEntry(folder.root, from, to);
      followRename(folder.root, done.from, done.to);
      setRenaming(null);
    },
    deleting,
    remove: (node) => {
      setAt(null);
      setRenaming(null);
      setDeleting(deleting?.path === node.path ? null : node);
    },
    done: () => {
      setRenaming(null);
      setDeleting(null);
    },
  };
  const add: NavAdd = {
    at,
    open: (dir) => {
      edit.done();
      setAt(at === dir ? null : dir);
    },
    create: async (path) => {
      const made = await createFile(folder.root, path);
      openNew(folder.root, made.path, made.raw, !isImagePath(made.path));
      setAt(null);
      navigate(SCREEN.files, navFileLink(folder.root, made.path));
    },
    cancel: () => setAt(null),
  };
  return (
    <div className="sh-nav-dir">
      <div className="sh-nav-dirrow">
        <button
          type="button"
          className="sh-nav-row"
          aria-expanded={shown}
          onClick={() => toggle(id)}
          title={`${shown ? 'Close' : 'Open'} ${tildePath(folder.dir)}`}
        >
          <Chevron open={shown} />
          <span className="sh-nav-label">{folder.name}</span>
          {folder.main && <span className="sh-nav-tag">main</span>}
        </button>
        <AddButton dir="" label={folder.name} add={add} />
      </div>
      <AddForm dir="" add={add} />
      {shown && (
        <div className="sh-nav-items">
          <FolderTree projectId={project.id} root={folder.root} open={open} add={add} edit={edit} />
        </div>
      )}
    </div>
  );
}

function ProjectNode({
  project,
  open,
  selected,
  agentId,
  drag,
  last,
}: {
  project: NavProject;
  open: ReadonlySet<string>;
  selected: boolean;
  /** The agent the Agent screen has up, if it is up. */
  agentId: string | undefined;
  drag: NavDrag;
  /** The bottom one, which shows the cue for a drop at the end. */
  last: boolean;
}) {
  const id = navId(project.id);
  const shown = isOpen(open, id);
  const needs = project.needs;
  const moving = drag.dragging !== null && drag.dragging !== project.id;

  const cls = [
    'sh-nav-proj',
    drag.dragging === project.id ? 'is-dragging' : '',
    moving && drag.over === project.id ? 'is-drop' : '',
    last && drag.dragging !== null && drag.over === null ? 'is-drop-after' : '',
  ].filter(Boolean).join(' ');

  return (
    /*
     * The whole node takes the drop, so an open project is a target all the way down;
     * only its row starts a drag, so the agents, needs and folders under it still click.
     */
    <div
      className={cls}
      onDragOver={(e) => {
        if (drag.dragging === null) return;
        // Kept from the body's handler, which would read it as a drop at the end.
        e.stopPropagation();
        const target = moving ? project.id : undefined;
        if (moving) e.preventDefault();
        if (drag.over !== target) drag.hover(target);
      }}
      onDrop={(e) => {
        if (drag.dragging === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (moving) drag.drop(project.id);
        else drag.end();
      }}
    >
      <div
        className={`sh-nav-prow${selected ? ' is-sel' : ''}`}
        draggable
        onDragStart={(e) => {
          drag.start(project.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', project.id);
        }}
        onDragEnd={drag.end}
      >
        <button
          type="button"
          className="sh-nav-tog"
          aria-expanded={shown}
          aria-label={`${shown ? 'Close' : 'Open'} ${project.name}`}
          onClick={() => toggle(id)}
        >
          <Chevron open={shown} />
        </button>
        <button
          type="button"
          className="sh-nav-pname"
          onClick={() => openProject(project.id)}
          title={
            needs > 0
              ? `${project.name} — ${needs === 1 ? '1 thing needs' : `${needs} things need`} you`
              : `Open ${project.name}`
          }
        >
          <span className="sh-nav-label">{project.name}</span>
          {needs > 0 && <span className="sh-nav-need">{needs}</span>}
        </button>
      </div>

      {shown && (
        <div className="sh-nav-subs">
          <Submenu project={project} part="agents" open={open} title="Agents" count={project.agents.length}>
            {project.agents.length === 0 && <span className="sh-nav-none">no agents yet</span>}
            {project.jobs.map((j) => (
              <JobGroup key={j.id} project={project} job={j} open={open} agentId={agentId} />
            ))}
          </Submenu>

          <Submenu
            project={project}
            part="needs"
            open={open}
            title="Needs you"
            count={needs > 0 ? needs : null}
            lit={needs > 0}
          >
            {project.needsRows.length === 0 && <span className="sh-nav-none">nothing waits on you</span>}
            {project.needsRows.map((n) => (
              <button
                key={n.key}
                type="button"
                className="sh-nav-row"
                onClick={() => navigate(SCREEN.attention, n.params)}
                title={n.label}
              >
                <span className="sh-nav-label">{n.label}</span>
              </button>
            ))}
          </Submenu>

          <Submenu project={project} part="files" open={open} title="Files" count={project.folders.length}>
            {project.folders.map((f) => (
              <FolderNode key={f.dir} project={project} folder={f} open={open} />
            ))}
          </Submenu>
        </div>
      )}
    </div>
  );
}

export function Navigator() {
  const projects = useProjects();
  const agents = useAgents();
  const pending = usePending();
  const alerts = useAlerts();
  const jobs = useJobs();
  const unseen = useUnseenJobs();
  const finished = useMemo(() => new Set(unseen.map((j) => j.id)), [unseen]);
  const unseenAgents = useUnseenAgents();
  const route = useRoute();
  const open = parseOpen(useSetting(NAV_TREE_KEY));
  const panel = usePanel(NAV_PANEL);

  // The Fleet's Sort by and your order, read as the Fleet reads them (Amendment 69).
  const rawSort = useSetting(SORT_KEY);
  const rawOrder = useSetting(ORDER_KEY);
  const spent = useProjectSpend();
  const ordered = useMemo(
    () => navProjects(projects, rawSort, rawOrder, agents, pending, spent),
    [projects, rawSort, rawOrder, agents, pending, spent],
  );
  const tree = useMemo(
    () => navTree(ordered, agents, pending, alerts, jobs, finished, unseenAgents),
    [ordered, agents, pending, alerts, jobs, finished, unseenAgents],
  );

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null | undefined>(undefined);
  const end = (): void => {
    setDragging(null);
    setOver(undefined);
  };
  const drag: NavDrag = {
    dragging,
    over,
    start: setDragging,
    hover: setOver,
    // As fleet.tsx's place(): your order, then the sort that shows it.
    drop: (target) => {
      const w = dragging ? navDrop(ordered, dragging, target) : null;
      if (w) {
        writeSetting(ORDER_KEY, JSON.stringify(w.order));
        writeSetting(SORT_KEY, w.sort);
      }
      end();
    },
    end,
  };
  const selected = currentProject(route, agents, recall().projectId);
  const agentId = route.id === SCREEN.agent ? route.params['agentId'] : undefined;

  return (
    <>
      <nav className="sh-nav" style={{ width: `${panel.size}px` }} aria-label="Projects">
        <div className="sh-nav-top">
          <span className="ui-lab">Projects · {projects.length}</span>
          <button
            type="button"
            className="sh-nav-add"
            // A new project (Amendment 71): the panel lists projects, so its + adds one. It
            // opened Spawn, which read as "new agent". New work is a project's own "+ spawn agent".
            title="Add a project"
            aria-label="Add a project"
            onClick={() => navigate(SCREEN.fleet, { add: '1' })}
          >
            +
          </button>
        </div>
        {/* Below the last project, a drop puts the dragged one at the end. */}
        <div
          className="sh-nav-body"
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            if (over !== null) setOver(null);
          }}
          onDrop={(e) => {
            if (!dragging) return;
            e.preventDefault();
            drag.drop(null);
          }}
        >
          {tree.length === 0 && <span className="sh-nav-none">no projects yet — add one on Fleet</span>}
          {tree.map((p, i) => (
            <ProjectNode
              key={p.id}
              project={p}
              open={open}
              selected={p.id === selected}
              agentId={agentId}
              drag={drag}
              last={i === tree.length - 1}
            />
          ))}
        </div>
      </nav>
      <Splitter orientation="vertical" grow={1} label="Resize the project navigator" {...panel.handle} />
    </>
  );
}
