/**
 * Screen 2 — PROJECT.  TRACK B.
 *
 * One project: its agents as lanes, its facts in a column, its docs and diff in
 * a dock underneath. This is where you sit while a job runs.
 *
 * The column is this project's alone: its name, its facts, its actions and its notes.
 * It used to list every project above them, which the shell's navigator now does on
 * every screen (Amendment 66), so the list and its "+" are gone from here.
 *
 * Reserved slot: order 20, hotkey `2`. Registered alongside Fleet from
 * ./route.tsx's plural `screens` export.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Agent, AgentStatus, Job, PendingRequest } from '@conductor/shared';
import { rollupStatus } from '@conductor/shared';
import {
  useAgents,
  useJobDiffstat,
  useJobs,
  usePending,
  useProjectStatus,
  useProjects,
  useServers,
} from '../lib/store.js';
import { useNavParams } from '../lib/nav.js';
import { isFinished, markJobsSeen, useTabVisible, useUnseenJobs } from '../lib/seen.js';
import {
  SCREEN,
  openFiles,
  openPreview,
  openSpawn,
  highlight,
  recall,
} from '../shell/nav.js';
import { primaryJob } from '../shell/describe.js';
import {
  DiffNums,
  STATUS_KEY,
  STATUS_WORD,
  Tag,
  fmtMoney,
  tildePath,
} from '../shell/ui.js';
import { removeJob, terminateJob, useCommand } from '../agent/endpoints.js';
import { AddAgent } from '../spawn/AddAgent.js';
import { Lane } from './lane.js';
import { nestHelpers } from './nest.js';
import { NotesPanel } from './Notes.js';
import { Dock } from './dock.js';
import { PROJECT_COLUMN, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';
import './fleet.css';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One job's agents, under a header that says which job they are.
 *
 * WHY THIS EXISTS. The lanes were filtered on `projectId`, so a project with two jobs
 * showed both jobs' agents in one undifferentiated grid — two lanes reading `analyst`,
 * two reading `auditor`, distinguishable only by status, which is the thing that
 * changes. Worse, the facts column described `primaryJob` alone, so half the lanes
 * belonged to a worktree and branch the panel was not showing.
 *
 * ALWAYS OPEN on arrival. Ended jobs used to collapse themselves on the theory that
 * history should be out of the way — which was wrong in the case that actually happens:
 * every job in a finished project is ended, so the whole screen arrived collapsed and
 * seeing your own agents took a click per job. Coming to this screen means wanting to see
 * the agents. The fold is still there for when a group IS in the way.
 */
function JobGroup({
  job,
  agents,
  pending,
  selected,
  onSelect,
  finished,
}: {
  job: Job;
  agents: Agent[];
  pending: PendingRequest[];
  selected: boolean;
  onSelect: () => void;
  /** It finished and you hadn't seen it when you opened the project (Amendment 87). */
  finished: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [armed, setArmed] = useState(false);
  // One more agent in this job (Amendment 89): the editor opens under the header.
  const [adding, setAdding] = useState(false);
  const cmd = useCommand();

  const blocked = agents.filter((a) => pending.some((p) => p.agentId === a.id)).length;
  const working = agents.filter((a) => a.status === 'working').length;
  const live = agents.filter((a) => !ENDED_STATUS.has(a.status));

  return (
    <section className={`pj-group${selected ? ' is-sel' : ''}`}>
      <header className="pj-grouphead">
        <button
          type="button"
          className="pj-grouptoggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
            onSelect();
          }}
        >
          <span className="pj-group-ch">{open ? '⌃' : '⌄'}</span>
          <span className="pj-group-prompt">{job.prompt}</span>
        </button>

        <span className="pj-group-meta">
          ⑂ {job.branch} · {plural(agents.length, 'agent')}
        </span>

        {blocked > 0 ? (
          <Tag tone="need">{blocked} blocked on you</Tag>
        ) : working > 0 ? (
          <Tag tone="live">{working} working</Tag>
        ) : (
          <Tag tone={STATUS_KEY[worstOf(agents)]}>{STATUS_WORD[worstOf(agents)]}</Tag>
        )}
        {finished && <Tag tone={job.status === 'failed' ? 'fail' : 'done'}>finished</Tag>}

        <button
          type="button"
          className="fl-btn is-ghost"
          aria-expanded={adding}
          onClick={() => {
            setAdding((a) => !a);
            setOpen(true);
          }}
          title="Add an agent to this job, running or finished: it can wait for the agents here, and the ones that haven't started can wait for it"
        >
          + agent
        </button>

        {/*
         * Two stages, one at a time, because the job is the unit you launched and so it is
         * the unit you clear away. While anything is running the only offer is to stop it;
         * once everything has ended the offer becomes to remove it, which is what takes
         * the lanes off the screen. Terminate needs no confirm (it is recoverable work,
         * not data), remove does.
         */}
        {live.length > 0 ? (
          <button
            type="button"
            className="fl-btn is-danger"
            disabled={cmd.busy}
            onClick={() =>
              void cmd.run(`Terminating ${plural(live.length, 'agent')}`, () =>
                terminateJob(job.id),
              )
            }
          >
            {cmd.busy ? 'terminating…' : `✕ terminate ${live.length}`}
          </button>
        ) : armed ? (
          <>
            <span className="pj-group-ask">
              Remove this job and {plural(agents.length, 'transcript')}? Files stay.
            </span>
            <button
              type="button"
              className="fl-btn is-danger"
              disabled={cmd.busy}
              onClick={() => void cmd.run('Removing the job', () => removeJob(job.id))}
            >
              {cmd.busy ? 'removing…' : '✕ remove'}
            </button>
            <button
              type="button"
              className="fl-btn is-ghost"
              disabled={cmd.busy}
              onClick={() => {
                cmd.dismiss();
                setArmed(false);
              }}
            >
              cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="fl-btn is-ghost"
            disabled={cmd.busy}
            onClick={() => setArmed(true)}
            title="Remove this job from Conductor — transcripts go, your files stay"
          >
            ✕ remove
          </button>
        )}
      </header>

      {cmd.notice && (
        <div className={`pj-notice t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}

      {adding && <AddAgent job={job} agents={agents} onClose={() => setAdding(false)} />}

      {open &&
        (agents.length === 0 ? (
          <p className="pj-group-none">No agents in this job.</p>
        ) : (
          <div className="pj-lanes">
            {nestHelpers(agents).map(({ agent: a, helperOf }) =>
              helperOf ? (
                // Nested under the orchestrator that started it (Amendment 51).
                <div key={a.id} className="pj-helper">
                  <span className="pj-helper-of">↳ helper of {helperOf}</span>
                  <Lane agent={a} siblings={agents} pending={pending} />
                </div>
              ) : (
                <Lane key={a.id} agent={a} siblings={agents} pending={pending} />
              ),
            )}
          </div>
        ))}
    </section>
  );
}

const ENDED_STATUS: ReadonlySet<string> = new Set(['done', 'failed', 'stopped']);

/** The status a job's header should wear: its unhappiest agent's. */
function worstOf(agents: Agent[]): AgentStatus {
  return rollupStatus(agents.map((a) => a.status));
}

export function ProjectScreen() {
  const projects = useProjects();
  const routed = useNavParams(SCREEN.project)['projectId'];

  /*
   * The hash wins. Arriving by hotkey it says nothing, so fall back to the last
   * project explicitly opened, then to the first one — the screen is never blank
   * and never silently shows a project you did not ask for while a better answer
   * exists.
   */
  const known = (id: string | undefined) =>
    id !== undefined && projects.some((p) => p.id === id) ? id : undefined;
  const active = known(routed) ?? known(recall().projectId) ?? projects[0]?.id ?? null;

  const project = projects.find((p) => p.id === active) ?? null;
  // The project shown is the highlighted one — including the fallback to the first
  // one — so Files opens on the same project. (Amendment 44)
  useEffect(() => {
    if (project) highlight(project.id);
  }, [project?.id]);
  const jobs = useJobs(active ?? undefined);
  const allJobs = useJobs();
  const allAgents = useAgents();

  /*
   * OPENING THE PROJECT IS SEEING ITS FINISHED JOBS (Amendment 87) — while the tab is in
   * front, so a job that ends behind it still counts on the badge until you come back.
   * The jobs marked are kept for the visit, so their groups go on saying "finished" while
   * you are here; leaving the screen, or opening another project, lets that go.
   */
  const allUnseen = useUnseenJobs();
  const visible = useTabVisible();
  const [fresh, setFresh] = useState<{ projectId: string | null; ids: string[] }>({
    projectId: null,
    ids: [],
  });
  const unseenHere = useMemo(
    () => allUnseen.filter((j) => j.projectId === active),
    [allUnseen, active],
  );
  useEffect(() => {
    if (!visible || active === null || unseenHere.length === 0) return;
    const ids = unseenHere.map((j) => j.id);
    setFresh((f) => ({
      projectId: active,
      ids: [...new Set([...(f.projectId === active ? f.ids : []), ...ids])],
    }));
    markJobsSeen(ids, allJobs);
  }, [visible, active, unseenHere, allJobs]);
  const finishedHere = (j: Job): boolean =>
    isFinished(j) &&
    ((fresh.projectId === active && fresh.ids.includes(j.id)) || unseenHere.some((u) => u.id === j.id));

  /*
   * WHICH JOB THE FACTS DESCRIBE.
   *
   * `primaryJob` is the default, not the answer: it prefers a job that has not ended,
   * then the most recent. That was fine while a project held one job, and silently wrong
   * once it held two — branch, isolation, worktree, diff and dev server all described one
   * job while the lanes showed every job's agents. Clicking a job header now selects it,
   * and the facts follow the selection.
   */
  const [pickedJob, setPickedJob] = useState<string | null>(null);
  const job =
    (pickedJob === null ? null : (jobs.find((j) => j.id === pickedJob) ?? null)) ??
    primaryJob(jobs);
  const allPending = usePending();
  const servers = useServers();
  const diff = useJobDiffstat(job?.id ?? null);
  const status = useProjectStatus(active ?? '');
  // The project column's width (Amendment 34). Before the early return: it's a hook.
  const column = usePanel(PROJECT_COLUMN);

  const agents = useMemo(
    () => allAgents.filter((a) => a.projectId === active),
    [allAgents, active],
  );
  const pending = useMemo(
    () => allPending.filter((p) => p.projectId === active),
    [allPending, active],
  );
  const server = servers.find((s) => s.jobId === job?.id && s.alive);
  const spend = agents.reduce((n, a) => n + a.costUsd, 0);
  const working = agents.filter((a) => a.status === 'working').length;

  /*
   * Newest job first. The one you just launched is the one you came to look at, and a
   * finished job from two hours ago should not be sitting above it.
   */
  const grouped = useMemo(
    () =>
      [...jobs]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((j) => ({ job: j, agents: agents.filter((a) => a.jobId === j.id) })),
    [jobs, agents],
  );

  if (!project) {
    return (
      <div className="fl-screen">
        <div className="fl-pane">
          <div className="fl-empty">
            <p className="fl-empty-h">No project selected.</p>
            <p>Pick one from the Fleet grid, or from the projects in the left panel.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fl-screen">
      {/* ── project column: this project's name, facts, actions and notes ── */}
      <div className="pj-col" style={{ width: `${column.size}px` }}>
        <div className="pj-colhead">
          <span className="pj-colname" title={project.name}>
            {project.name}
          </span>
        </div>
        <div className="pj-colbody">
          <div className="pj-facts">
            <span className="ui-lab">This project</span>
            <div className="pj-kv">
              <span>branch</span>
              <span>{job?.branch ?? '—'}</span>
            </div>
            <div className="pj-kv">
              <span>isolation</span>
              <span>{job ? job.isolation.replace('_', ' ') : '—'}</span>
            </div>
            <div className="pj-kv">
              <span>worktree</span>
              <span title={job?.worktreePath}>
                {job ? tildePath(job.worktreePath).split('/').slice(-2).join('/') : '—'}
              </span>
            </div>
            <div className="pj-kv">
              <span>diff</span>
              <span>
                {diff.files > 0 ? <DiffNums added={diff.added} removed={diff.removed} /> : '—'}
              </span>
            </div>
            <div className="pj-kv">
              <span>dev server</span>
              <span className={server ? 'pj-kv-live' : undefined}>
                {server ? `:${server.port} ◉` : 'none'}
              </span>
            </div>
            <div className="pj-kv">
              <span>spend</span>
              <span>{fmtMoney(spend)}</span>
            </div>
          </div>

          <div className="pj-colactions">
            <button
              type="button"
              className="fl-btn is-ghost"
              onClick={() => openFiles(job)}
            >
              ▤ open files
            </button>
            {server && (
              <button
                type="button"
                className="fl-btn is-ghost"
                onClick={() => openPreview(server)}
              >
                ◈ open preview
              </button>
            )}
          </div>

          {/* The same notes as the Fleet card, and the Agent screen's (Amendment 56). */}
          <div className="pj-facts pj-notes">
            <span className="ui-lab">Notes · {project.notes?.length ?? 0}</span>
            <NotesPanel project={project} />
          </div>
        </div>
      </div>

      <Splitter orientation="vertical" grow={1} label="Resize the project column" {...column.handle} />

      {/* ── lanes + dock ── */}
      <div className="fl-pane">
        <div className="fl-panehead">
          <span className="fl-crumb">
            <b>{project.name}</b>
            {job && (
              <>
                <i>/</i>⑂ {job.branch}
              </>
            )}
          </span>
          {pending.length > 0 ? (
            <Tag tone="need">
              {pending.length === 1 ? '1 blocked on you' : `${pending.length} blocked on you`}
            </Tag>
          ) : working > 0 ? (
            <Tag tone="live">{working} working</Tag>
          ) : (
            <Tag tone={STATUS_KEY[status]}>{STATUS_WORD[status]}</Tag>
          )}

          <div className="fl-panehead-r">
            <button
              type="button"
              className="fl-btn is-ghost"
              onClick={() => openSpawn(project)}
            >
              + spawn agent
            </button>
          </div>
        </div>

        <div className="fl-panebody is-lanes">
          {/*
           * Keyed on JOBS, not agents. It used to be agents, which meant that removing a
           * job's last agent replaced the whole lane area with "no agents in this
           * project" — taking the job groups, and with them the only remove button that
           * could clear the now-empty job, off the screen. A job outlives its agents, so
           * the empty state has to be about jobs.
           */}
          {jobs.length === 0 ? (
            <div className="fl-empty">
              <p className="fl-empty-h">No jobs in this project.</p>
              <p>Start work from the Spawn screen.</p>
            </div>
          ) : (
            <>
              {grouped.map((g) => (
                <JobGroup
                  key={g.job.id}
                  job={g.job}
                  agents={g.agents}
                  pending={pending}
                  selected={g.job.id === job?.id}
                  onSelect={() => setPickedJob(g.job.id)}
                  finished={finishedHere(g.job)}
                />
              ))}
              <button
                type="button"
                className="fl-add is-short"
                onClick={() => openSpawn(project)}
              >
                <span className="fl-add-plus">+</span>
                spawn agent here
              </button>
            </>
          )}
        </div>

        <Dock job={job} server={server} />
      </div>
    </div>
  );
}
