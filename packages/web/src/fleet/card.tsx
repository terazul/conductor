/**
 * Screen 1's project card.  TRACK B.
 *
 * One card per project. It has to answer, at a glance and from across the room:
 * is this project healthy, what are its agents doing, is anything actually
 * happening, and how much has changed.
 *
 *  - LEFT STRIPE    the project's worst agent status (useProjectStatus). The
 *                   amber one glows, because a blocked project is the only kind
 *                   you have to walk over to.
 *  - AGENT ROWS     what each agent is literally doing, now — not its status
 *                   word. "Edit src/auth/token.ts" beats "working".
 *  - SPARKLINE      real tool calls per 15s bucket for the whole job. Flat and
 *                   grey means stuck or thinking; that distinction is the point.
 *  - DIFFSTAT       useJobDiffstat, so the card shows work done, not work begun.
 *  - SHORTCUTS      files and preview, the two things you always want next.
 *  - `…`            edit and remove. This card is the only place either lives
 *                   (CONTRACT Amendment 25) — Fleet is where you survey projects,
 *                   so it is where you curate the list. Everything inside the menu
 *                   stops propagation, because the whole card is a button.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, PendingRequest, Project } from '@conductor/shared';
import {
  useAgentEvents,
  useAgents,
  useJobDiffstat,
  useJobs,
  usePending,
  useProjectStatus,
  useServers,
} from '../lib/store.js';
import { useNavParams } from '../lib/nav.js';
import { useUnseenJobs } from '../lib/seen.js';
import {
  SCREEN,
  openAgent,
  openFiles,
  openPreview,
  openProject,
  recall,
} from '../shell/nav.js';
import { useElapsedMs, useJobActivity } from '../shell/clock.js';
import {
  currentAction,
  dependencyNames,
  primaryJob,
  shownStatus,
  startedMs,
} from '../shell/describe.js';
import { useCommand } from '../agent/endpoints.js';
import {
  addProjectDir,
  editProject,
  removeProject,
  removeProjectDir,
  type ProjectRemoval,
} from './endpoints.js';
import { usePathComplete } from '../spawn/browse.js';
import { LatestNote, NotesButton, NotesPanel } from './Notes.js';
import {
  ProviderBadge,
  Dot,
  DiffNums,
  Spark,
  STATUS_KEY,
  STATUS_WORD,
  Tag,
  fmtElapsed,
  tildePath,
} from '../shell/ui.js';

function AgentRow({
  agent,
  siblings,
  pending,
}: {
  agent: Agent;
  siblings: readonly Agent[];
  pending: readonly PendingRequest[];
}) {
  const events = useAgentEvents(agent.id);
  const deps = dependencyNames(agent, siblings);
  const action = currentAction(agent, events, pending, deps);
  const shown = shownStatus(agent, pending);
  const elapsedMs = useElapsedMs(startedMs(agent, events), agent.endedAt, events);
  const elapsed = agent.status === 'queued' || elapsedMs === null ? null : fmtElapsed(elapsedMs);

  return (
    <button
      type="button"
      className={`fl-arow${action.tone === 'need' ? ' is-need' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        openAgent(agent);
      }}
      title={`${agent.role} — ${STATUS_WORD[shown]}`}
    >
      <Dot status={shown} />
      <span className="fl-arow-nm">{agent.role}</span>
      <ProviderBadge provider={agent.provider} />
      <span className="fl-arow-act">
        {action.head && <>{action.head} </>}
        {action.subject && <b>{action.subject}</b>}
      </span>
      <span className="fl-arow-el">
        {agent.status === 'queued' ? 'queued' : agent.status === 'done' ? 'done' : (elapsed ?? '—')}
      </span>
    </button>
  );
}

/**
 * The card's `…` menu: edit the project, or remove it.
 *
 * WHY EVERYTHING HERE STOPS PROPAGATION. The whole card is `role="button"` with
 * an `onClick` that navigates and an `onKeyDown` that treats Enter and Space as
 * activation. A menu nested inside it therefore has to stop both — and the text
 * inputs especially, because Enter in a rename field would otherwise bubble up
 * and navigate away mid-edit, discarding what was typed.
 *
 * Three states rather than a dialog: closed, menu, and one of the panels.
 * A panel replaces the menu in the same corner so nothing overlays the card it
 * refers to.
 *
 * WHY IT IS `position: fixed` AND NOT `absolute`. Absolute was clipped: the grid
 * lives in `.fl-panebody` (`overflow-y: auto`) inside `.fl-pane`
 * (`overflow: hidden`), so a menu opening upward from a card in the top row was cut
 * off by the scroll container and read as sliding under the header. No z-index fixes
 * that — overflow clips a descendant regardless of stacking. Fixed positioning is
 * the escape, and the cost is that the coordinates have to be measured and then
 * re-measured while the pane scrolls under it.
 */
type MenuState = 'closed' | 'menu' | 'edit' | 'dirs' | 'remove';

/** Roughly how tall each state renders, for deciding which way to open. */
const NEEDED: Record<Exclude<MenuState, 'closed'>, number> = {
  menu: 112,
  edit: 330,
  dirs: 300,
  remove: 290,
};

function CardMenu({
  project,
  jobs,
  agents,
  onRemoved,
  onMove,
  first = false,
  last = false,
}: {
  project: Project;
  jobs: number;
  agents: number;
  onRemoved: (removal: ProjectRemoval) => void;
  onMove?: (step: -1 | 1) => void;
  first?: boolean;
  last?: boolean;
}) {
  const [state, setState] = useState<MenuState>('closed');
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path);
  const cmd = useCommand();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    right: number;
    top?: number;
    bottom?: number;
  }>({
    right: 0,
  });

  /*
   * Anchor to the trigger's viewport rect, opening whichever way has room. `right`
   * is measured from the viewport's right edge so the menu stays right-aligned with
   * the button, which is where the eye already is.
   */
  useEffect(() => {
    if (state === 'closed') return;
    const measure = (): void => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const need = NEEDED[state];
      const right = Math.max(8, window.innerWidth - r.right);
      // Prefer upward — the action row is the last thing in the card, so downward
      // covers the next card. Flip only when there genuinely isn't room above.
      if (r.top - need - 8 >= 0) {
        setPlace({ right, bottom: window.innerHeight - r.top + 5 });
        return;
      }
      // Downward, but never off the bottom: in a short window neither direction
      // fits, and a panel hanging past the viewport cannot be scrolled to because
      // it is fixed. Clamp to 8px from the bottom and let it sit over the card.
      setPlace({
        right,
        top: Math.min(r.bottom + 5, Math.max(8, window.innerHeight - need - 8)),
      });
    };
    measure();
    // Capture phase: the scroll happens on .fl-panebody, not on window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [state]);

  // A menu that only closes via its own button is a menu you leave open by
  // accident, on a screen where every other card is one click away.
  useEffect(() => {
    if (state === 'closed') return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !pop.current?.contains(t)) setState('closed');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [state]);

  const reset = (): void => {
    cmd.dismiss();
    setName(project.name);
    setPath(project.path);
    setState('closed');
  };

  const save = (): void =>
    void cmd.run('Updating the project', async () => {
      const patch: { name?: string; path?: string } = {};
      if (name.trim() && name.trim() !== project.name) patch.name = name.trim();
      if (path.trim() && path.trim() !== project.path) patch.path = path.trim();
      if (patch.name === undefined && patch.path === undefined) {
        setState('closed');
        return null;
      }
      const result = await editProject(project.id, patch);
      setState('closed');
      return result;
    });

  /*
   * On success the project leaves the snapshot and this whole card unmounts with
   * it, so the outcome CANNOT be shown here — it is handed up to the Fleet screen,
   * which survives. The same reasoning the Project screen used before this moved.
   */
  const remove = (): void =>
    void cmd.run('Removing the project', async () => {
      const { removed } = await removeProject(project.id);
      onRemoved(removed);
      return removed;
    });

  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();

  return (
    <div className="fl-menu-wrap" ref={wrap} onClick={stop} onKeyDown={stop}>
      <button
        ref={trigger}
        type="button"
        className="fl-btn is-ghost"
        aria-haspopup="menu"
        aria-expanded={state !== 'closed'}
        aria-label={`More actions for ${project.name}`}
        onClick={() => setState((s) => (s === 'closed' ? 'menu' : 'closed'))}
      >
        …
      </button>

      {/*
       * Portalled to <body>. `.fl-card:hover` sets a transform, and a transformed
       * ancestor becomes the containing block for `position: fixed` — so the menu,
       * positioned from viewport coordinates, landed inside the card's own box and was
       * clipped by its `overflow: hidden`. React events still bubble through a portal
       * to the card's navigating onClick, hence the `stop` handlers on this root.
       */}
      {state !== 'closed' &&
        createPortal(
          <div ref={pop} className="fl-menu-portal" onClick={stop} onKeyDown={stop}>
            {state === 'menu' && (
              <div className="fl-menu" role="menu" style={place}>
                <button type="button" role="menuitem" onClick={() => setState('edit')}>
                  ✎ edit project
                </button>
                <button type="button" role="menuitem" onClick={() => setState('dirs')}>
                  ▤ folders…
                </button>
                {onMove && !first && (
                  <button type="button" role="menuitem" onClick={() => { onMove(-1); setState('closed'); }}>
                    ← move earlier
                  </button>
                )}
                {onMove && !last && (
                  <button type="button" role="menuitem" onClick={() => { onMove(1); setState('closed'); }}>
                    → move later
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => setState('remove')}
                >
                  ⌫ remove project
                </button>
              </div>
            )}

            {state === 'edit' && (
              <div className="fl-menu fl-menu--panel" style={place}>
                <label className="fl-f">
                  <span>name</span>
                  <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="fl-f">
                  <span>main folder</span>
                  <input
                    value={path}
                    spellCheck={false}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </label>
                {/*
                 * Said out loud because the daemon will not stop you. Changing the path
                 * rewrites this row and nothing else: existing worktrees, `jobs.worktree_path`
                 * and the transcripts stay where they are, so a project with history ends
                 * up naming one directory while its history describes another.
                 */}
                {path.trim() !== project.path && jobs > 0 && (
                  <p className="fl-f-warn">
                    {jobs === 1 ? '1 job' : `${jobs} jobs`} already ran here. Their worktrees and
                    transcripts keep pointing at the old directory — only new work uses this path.
                  </p>
                )}
                <div className="fl-menu-row">
                  <button type="button" className="fl-btn" disabled={cmd.busy} onClick={save}>
                    {cmd.busy ? 'saving…' : 'save'}
                  </button>
                  <button
                    type="button"
                    className="fl-btn is-ghost"
                    disabled={cmd.busy}
                    onClick={reset}
                  >
                    cancel
                  </button>
                </div>
                {cmd.notice && (
                  <div className={`fl-menu-note t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
                    {cmd.notice.text}
                  </div>
                )}
              </div>
            )}

            {state === 'dirs' && <DirsPanel project={project} place={place} onDone={reset} />}

            {state === 'remove' && (
              <div className="fl-menu fl-menu--panel" style={place}>
                <p className="fl-f-q">
                  Remove <b>{project.name}</b> from Conductor?
                </p>
                <p className="fl-f-b">
                  Forgets {jobs === 1 ? '1 job' : `${jobs} jobs`} and{' '}
                  {agents === 1 ? '1 agent' : `${agents} agents`}. Nothing is deleted from your
                  machine — the folder, any worktrees under <code>.conductor/wt</code> and every
                  branch an agent made all stay where they are.
                </p>
                <div className="fl-menu-row">
                  <button
                    type="button"
                    className="fl-btn is-danger"
                    disabled={cmd.busy}
                    onClick={remove}
                  >
                    {cmd.busy ? 'removing…' : 'remove'}
                  </button>
                  <button
                    type="button"
                    className="fl-btn is-ghost"
                    disabled={cmd.busy}
                    onClick={reset}
                  >
                    cancel
                  </button>
                </div>
                {cmd.notice && (
                  <div className={`fl-menu-note t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
                    {cmd.notice.text}
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * A project's directories (Amendment 39): the first, where its agents start, and the
 * others they can also reach. The Files screen shows exactly these, so this is where
 * you give a project another folder.
 *
 * Removing one is two clicks, and the second says what it does not do: Conductor
 * forgets the directory, the folder stays. The first can't be removed — it is the
 * project's path, changed with "edit project".
 */
function DirsPanel({
  project,
  place,
  onDone,
}: {
  project: Project;
  place: { right: number; top?: number; bottom?: number };
  onDone: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const cmd = useCommand();
  const completions = usePathComplete(draft, draft.trim() !== '');
  const extra = project.extraDirs ?? [];

  const add = (): void => {
    const path = draft.trim().replace(/\/+$/, '') || draft.trim();
    if (!path) return;
    void cmd.run(
      'Adding the folder',
      async () => {
        const r = await addProjectDir(project.id, path);
        setDraft('');
        return r;
      },
      (r: { existing: boolean }) => (r.existing ? `${project.name} already has that folder.` : ''),
    );
  };

  const remove = (path: string): void =>
    void cmd.run('Removing the folder', async () => {
      const r = await removeProjectDir(project.id, path);
      setConfirm(null);
      return r;
    });

  const listId = `fl-dirs-${project.id}`;
  return (
    <div className="fl-menu fl-menu--panel" style={place}>
      <p className="fl-f-q">{project.name}'s folders</p>
      <ul className="fl-dirs">
        <li>
          <code title={project.path}>{project.path}</code>
          <span className="fl-dirs-tag">main · agents work here</span>
        </li>
        {extra.map((d) => (
          <li key={d}>
            <code title={d}>{d}</code>
            <span className="fl-dirs-tag">referenced</span>
            {confirm === d ? (
              <span className="fl-dirs-confirm">
                <button
                  type="button"
                  className="fl-btn is-danger"
                  disabled={cmd.busy}
                  onClick={() => remove(d)}
                >
                  forget it
                </button>
                <button type="button" className="fl-btn is-ghost" onClick={() => setConfirm(null)}>
                  keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="fl-btn is-ghost"
                aria-label={`Remove ${d} from ${project.name}`}
                onClick={() => setConfirm(d)}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirm && (
        <p className="fl-f-b">
          Conductor forgets <code>{confirm}</code>. The folder and everything in it stay where they
          are.
        </p>
      )}
      <label className="fl-f">
        <span>add a referenced folder — agents can read and edit it too</span>
        <input
          value={draft}
          list={listId}
          autoFocus
          spellCheck={false}
          placeholder="~/code/another-repo"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            else if (e.key === 'Escape') onDone();
          }}
        />
        <datalist id={listId}>
          {(completions?.entries ?? []).map((en) => (
            <option key={en.path} value={`${en.path}/`}>
              {en.repo ? 'git repo' : ''}
            </option>
          ))}
        </datalist>
      </label>
      <div className="fl-menu-row">
        <button
          type="button"
          className="fl-btn"
          disabled={cmd.busy || draft.trim() === ''}
          onClick={add}
        >
          {cmd.busy ? 'adding…' : 'add'}
        </button>
        <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={onDone}>
          done
        </button>
      </div>
      {cmd.notice && (
        <div className={`fl-menu-note t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}

export function ProjectCard({
  project,
  onRemoved,
  onMove,
  first = false,
  last = false,
}: {
  project: Project;
  onRemoved: (removal: ProjectRemoval) => void;
  /** Move this card one place in your order (Amendment 54). */
  onMove?: (step: -1 | 1) => void;
  first?: boolean;
  last?: boolean;
}) {
  // The card's notes panel, open or not (Amendment 55).
  const [notesOpen, setNotesOpen] = useState(false);
  const status = useProjectStatus(project.id);
  const key = STATUS_KEY[status];
  const jobs = useJobs(project.id);
  const job = primaryJob(jobs);
  const allAgents = useAgents();
  const allPending = usePending();
  const servers = useServers();
  const diff = useJobDiffstat(job?.id ?? null);
  const activity = useJobActivity(job?.id ?? null);
  const selectedId = useNavParams(SCREEN.project)['projectId'] ?? recall().projectId ?? null;
  const allUnseen = useUnseenJobs();
  const unseen = useMemo(() => allUnseen.filter((j) => j.projectId === project.id), [allUnseen, project.id]);

  const agents = useMemo(
    () => allAgents.filter((a) => a.projectId === project.id),
    [allAgents, project.id],
  );
  const pending = useMemo(
    () => allPending.filter((p) => p.projectId === project.id),
    [allPending, project.id],
  );
  const server = useMemo(
    () => servers.find((s) => s.jobId === job?.id && s.alive),
    [servers, job?.id],
  );

  const blocked = pending.length > 0;
  const working = agents.filter((a) => a.status === 'working').length;

  /*
   * Every card opens its Project screen, blocked or not (Amendment 66). A blocked card
   * used to go straight to Needs you; now the card's amber says it needs you, and the
   * navigator's Needs you entry for the project is one click from there.
   */
  const open = () => openProject(project.id);

  /*
   * The stripe is the project's worst state. useProjectStatus rolls up agent
   * statuses, but a live request outranks all of them — and can exist before the
   * agent entity has been transitioned to `blocked`. A project someone is
   * waiting on is amber whatever the rollup says; that is what the stripe is for.
   */
  const stripe = blocked ? 'need' : key;

  /*
   * A job here finished and you haven't opened the project or its agents since
   * (Amendment 87). Red if one of them ended with a failure. Beside what is still
   * going on, or in place of the project's own done or failed when nothing is.
   */
  const finished =
    unseen.length > 0 ? (
      <Tag tone={unseen.some((j) => j.status === 'failed') ? 'fail' : 'done'}>finished</Tag>
    ) : null;

  // The headline tag. Amber only when a human is actually required.
  const headline = blocked ? (
    <>
      <Tag tone="need">needs you</Tag>
      {finished}
    </>
  ) : working > 0 ? (
    <>
      <Tag tone="live">{working === 1 ? '1 working' : `${working} working`}</Tag>
      {finished}
    </>
  ) : (
    (finished ?? <Tag tone={key}>{STATUS_WORD[status]}</Tag>)
  );

  return (
    <div
      className={`fl-card s-${stripe}${selectedId === project.id ? ' is-sel' : ''}`}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="fl-card-h">
        <h3>{project.name}</h3>
        {headline}
      </div>

      <div className="fl-card-path">
        {tildePath(project.path)}{' '}
        {job && (
          <>
            <b>⑂ {job.branch}</b> · {job.isolation.replace('_', ' ')}
          </>
        )}
      </div>

      <LatestNote project={project} />

      <div className="fl-card-agents">
        {agents.length === 0 ? (
          <div className="fl-arow is-empty">
            <span className="fl-arow-act">no agents yet</span>
          </div>
        ) : (
          agents.map((a) => <AgentRow key={a.id} agent={a} siblings={agents} pending={pending} />)
        )}
      </div>

      <div className="fl-card-foot">
        <Spark activity={activity} tone={blocked ? 'need' : 'live'} />
        {diff.files > 0 ? (
          <span>
            <DiffNums added={diff.added} removed={diff.removed} /> ·{' '}
            {diff.files === 1 ? '1 file' : `${diff.files} files`}
          </span>
        ) : (
          <span>{activity.moving ? 'working' : 'no recent tool calls'}</span>
        )}

        <span className="fl-card-actions">
          {job && (
            <button
              type="button"
              className="fl-btn is-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openFiles(job);
              }}
            >
              ▤ files
            </button>
          )}
          {server && (
            <button
              type="button"
              className="fl-btn is-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openPreview(server);
              }}
            >
              ↗ :{server.port}
            </button>
          )}
          <NotesButton project={project} open={notesOpen} onToggle={() => setNotesOpen((o) => !o)} />
          <CardMenu
            project={project}
            jobs={jobs.length}
            agents={agents.length}
            onRemoved={onRemoved}
            {...(onMove ? { onMove, first, last } : {})}
          />
        </span>
      </div>
      {notesOpen && <NotesPanel project={project} />}
    </div>
  );
}
