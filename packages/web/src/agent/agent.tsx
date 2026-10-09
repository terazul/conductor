/**
 * Screen 3 — AGENT.  TRACK B.
 *
 * One agent's full transcript, a composer to talk to it, and an inspector.
 * Reserved slot: order 30, hotkey `3`.
 */

import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Event } from '@conductor/shared';
import {
  useAgent,
  useAgentEvents,
  useAgents,
  useJobs,
  useAlerts,
  usePending,
  useProjects,
} from '../lib/store.js';
import { useNavParams } from '../lib/nav.js';
import { SCREEN, highlight, openAgent, openProject, recall } from '../shell/nav.js';
import { agentTabs } from './tabs.js';
import { useUnseenAgents } from '../lib/seen.js';
import { TerminalPanel } from './Terminal.js';
import { useElapsedMs } from '../shell/clock.js';
import { currentAction, dependencyNames, shownStatus, startedMs } from '../shell/describe.js';
import { budgetOf } from '../shell/autonomy.js';
import { Dot, ProviderBadge, STATUS_KEY, STATUS_WORD, Tag, fmtElapsed } from '../shell/ui.js';
import { Splitter } from '../shell/Splitter.js';
import { useFileTree } from '../files/useWorkspace.js';
import { foldAll, unfoldAll, updateFolds, useFolds } from './folds.js';
import { Transcript, buildTranscript, replyKeys } from './transcript.js';
import { Composer } from './composer.js';
import { Inspector } from './inspector.js';
import { NeedsPanel } from '../attention/NeedsPanel.js';
import { fileLinks, filesIn } from './links.js';
import { FOLLOW_PX, scrollIntent } from './scroll.js';
import { sleepControl } from './sleep.js';
import { rerunControl, rerunDone } from './rerun.js';
import {
  interruptAgent,
  pauseAgent,
  removeAgent,
  rerunAfter,
  resumeAgent,
  terminateAgent,
  useCommand,
  type CommandHandle,
} from './endpoints.js';
import { rewirePreview } from '../spawn/stack.js';
import '../fleet/fleet.css';
import './agent.css';

/**
 * What you last told this agent, pinned to the top of the transcript.
 *
 * The question "what did I actually ask for" is the one you need answered while reading
 * a long reply, and it is exactly the moment the instruction has scrolled off. The pale
 * bar on your own turns helps you find it by scanning; this removes the scan.
 *
 * SYNTHETIC TURNS DON'T COUNT. `user_text` also carries Conductor's own resume nudges,
 * which the transcript already labels `auto` rather than `you` — showing one here would
 * answer the question with something you never said.
 *
 * Sticky, so it costs one row at the top and then follows you down. It lives inside the
 * scroll container because that is what `position: sticky` resolves against.
 */
function LastAsk({ events }: { events: readonly Event[] }) {
  const last = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.payload.kind === 'user_text' && e.payload.synthetic !== true) {
        return { seq: e.seq, text: e.payload.text };
      }
    }
    return null;
  }, [events]);

  if (last === null) return null;

  return (
    <button
      type="button"
      className="ag-lastask"
      title="Jump to it in the transcript"
      onClick={() =>
        document.getElementById(`t-u${last.seq}`)?.scrollIntoView({ block: 'start' })
      }
    >
      <span className="ui-lab">You asked</span>
      <span className="ag-lastask-t">{last.text}</span>
    </button>
  );
}

/** Statuses an agent cannot be stopped out of, because it already has. */
const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'stopped']);

/**
 * Stop controls, in increasing order of finality.
 *
 *   interrupt  — stops this run. The agent stays and can be redirected. For "no, do it
 *                differently", which is the common case and so it needs no confirmation.
 *   pause      — puts it to sleep: frees its slot, keeps its conversation and any
 *                question it asked. Resume wakes it in the same session (sleep.ts).
 *   terminate  — ends it. Confirmed, because it is not undoable.
 *
 * The confirm is the two-step used for removing a project: the first press arms, the
 * second commits, and `cancel` is the wider target. No modal, because there is still no
 * modal anywhere in this app and a header button is the wrong place to introduce one.
 *
 * What terminate does NOT do, and the confirm says so: delete anything. The transcript,
 * the spend and every file the agent wrote all survive.
 *
 *   remove from stack — terminate and remove in one (Amendment 89), offered in terminate's
 *                confirm. The banner under the header says who waits for what afterwards
 *                (`rewirePreview`): "scribe will wait for architect instead." So does an
 *                ended agent's remove, which is the same call.
 */
function StopControls({
  agent,
  cmd,
  onAsk,
}: {
  agent: Agent;
  cmd: CommandHandle;
  /** What removing it does to the rest of its job, for the banner under the header; null when not asked. */
  onAsk: (consequence: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const job = useAgents(agent.jobId);

  const ended = ENDED.has(agent.status);
  const sleep = sleepControl(agent.status);
  /*
   * Removing is also removing from the stack (Amendments 88, 89): who moves is said before
   * you press, in the banner under the header, since it can be longer than the header is wide.
   */
  const moves = rewirePreview(job, agent.id) || 'Nothing in its job waits for it.';
  const consequence = !armed
    ? null
    : ended
      ? moves
      : `Or remove it from the stack: it stops, leaves its job and its transcript goes; your files stay. ${moves}`;
  useEffect(() => {
    onAsk(consequence);
    return () => onAsk(null);
  }, [consequence, onAsk]);

  if (armed) {
    const question = ended
      ? `Remove ${agent.role} from Conductor? Its transcript goes; your files do not.`
      : `Terminate ${agent.role}? It stops for good — nothing on disk is touched.`;
    return (
      <>
        <span className="ag-confirm-q" title={question}>
          {ended ? (
            <>
              Remove <b>{agent.role}</b> from Conductor? Its transcript goes; your files
              do not.
            </>
          ) : (
            <>
              Terminate <b>{agent.role}</b>? It stops for good — nothing on disk is touched.
            </>
          )}
        </span>
        <button
          type="button"
          className="fl-btn is-danger"
          disabled={cmd.busy}
          onClick={() =>
            void cmd
              .run(ended ? 'Removing' : 'Terminating', () =>
                ended ? removeAgent(agent.id) : terminateAgent(agent.id),
              )
              .then((ok) => {
                if (ok) setArmed(false);
              })
          }
        >
          {cmd.busy ? 'working…' : ended ? '✕ remove' : '✕ terminate'}
        </button>
        {/*
         * Terminate and remove in one, while it is live or still waiting (Amendment 89): it
         * leaves its job, and the agents waiting for it wait for what it waited for. Once it
         * has ended, ✕ remove is the same call.
         */}
        {!ended && (
          <button
            type="button"
            className="fl-btn is-danger"
            disabled={cmd.busy}
            title={consequence ?? undefined}
            onClick={() =>
              void cmd.run('Removing', () => removeAgent(agent.id)).then((ok) => {
                if (ok) setArmed(false);
              })
            }
          >
            remove from stack
          </button>
        )}
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
    );
  }

  return (
    <>
      {sleep && (
        <button
          type="button"
          className="fl-btn is-ghost"
          disabled={cmd.busy}
          title={sleep.title}
          onClick={() =>
            void cmd.run(sleep.doing, () =>
              sleep.action === 'resume' ? resumeAgent(agent.id) : pauseAgent(agent.id),
            )
          }
        >
          {sleep.label}
        </button>
      )}
      {/*
       * One button, two meanings, because they are two stages of one intention: stop the
       * work, then clear it away. An agent that has already ended cannot be terminated
       * again, and leaving a dead control there was what made "I terminated it and it
       * still hangs on" the obvious conclusion.
       */}
      <button
        type="button"
        className="fl-btn is-danger"
        disabled={cmd.busy}
        onClick={() => setArmed(true)}
        title={
          ended
            ? 'Remove this agent from Conductor — the transcript goes, your files stay'
            : 'Stop this agent for good, or remove it from its job'
        }
      >
        {ended ? '✕ remove' : '✕ terminate'}
      </button>
    </>
  );
}

/**
 * Re-run from here (Amendment 102): start the agents AFTER this one again, now that you have
 * changed what it said. Manual, so a chat with the architect doesn't re-run the whole stack
 * on every message.
 *
 * Only on an agent that has agents after it. Armed first, like terminate: the first press
 * says what it will do, in the banner under the header (who goes again, that running ones
 * are stopped first, that the folder is left as it is), and the second commits. When
 * something is in the way (it is still working, an agent after it was stopped) the button is
 * there, disabled, and its hover text is the reason; a refusal from the daemon is shown the
 * same way, as it said it.
 *
 * Armed, it takes the header: stop controls give way, as they do for each other.
 */
function RerunControl({
  agent,
  events,
  cmd,
  hidden,
  onAsk,
}: {
  agent: Agent;
  events: readonly Event[];
  cmd: CommandHandle;
  /** Another confirm is showing; this one waits its turn. */
  hidden: boolean;
  /** What pressing it will do, for the banner under the header; null when not armed. */
  onAsk: (explain: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const siblings = useAgents(agent.jobId);
  const hasReply = events.some((e) => e.payload.kind === 'text');
  const control = rerunControl(siblings, agent.id, hasReply);

  // It stopped being possible while armed (the agent started again, another tab removed one).
  const open = armed && control !== null && control.blocked === null;
  const explain = open ? control.explain : null;
  useEffect(() => {
    onAsk(explain);
    return () => onAsk(null);
  }, [explain, onAsk]);
  useEffect(() => {
    if (armed && !open) setArmed(false);
  }, [armed, open]);

  if (control === null || (hidden && !open)) return null;

  if (open) {
    return (
      <>
        <span className="ag-confirm-q" title={control.question}>
          {control.question}
        </span>
        <button
          type="button"
          className="fl-btn is-primary"
          disabled={cmd.busy}
          onClick={() =>
            void cmd
              .run('Re-running', () => rerunAfter(agent.id), rerunDone)
              .then(() => setArmed(false))
          }
        >
          {cmd.busy ? 'working…' : control.confirm}
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
    );
  }

  return (
    <button
      type="button"
      className="fl-btn is-ghost"
      disabled={cmd.busy || control.blocked !== null}
      title={control.blocked ?? control.title}
      aria-label={control.blocked ? `${control.label} — unavailable: ${control.blocked}` : control.label}
      onClick={() => {
        cmd.dismiss();
        setArmed(true);
      }}
    >
      {control.label}
    </button>
  );
}

/** Composer height limits, in px. Below MIN the textarea is unusable; above MAX
 *  the transcript stops being readable, which defeats the point of the screen. */
const COMPOSER_MIN = 150;
const COMPOSER_MAX = 620;
const COMPOSER_DEFAULT = 260;
const COMPOSER_KEY = 'conductor.composerH';

const clampH = (h: number): number => Math.min(COMPOSER_MAX, Math.max(COMPOSER_MIN, h));

/** Whether the inspector is shown (F18). Persisted like the composer height. */
const DETAILS_KEY = 'conductor.agentDetails';

export function AgentScreen() {
  const routed = useNavParams(SCREEN.agent)['agentId'];
  const agents = useAgents();
  const projects = useProjects();
  const remembered = recall();

  /*
   * Arriving by hotkey the hash names no agent, so pick the one most worth
   * looking at — blocked first, then working — scoped to the project last opened
   * if there was one. An empty screen would be the only wrong answer.
   */
  const fallback = useMemo(() => {
    const rank = (s: string) => (s === 'blocked' ? 0 : s === 'working' ? 1 : s === 'failed' ? 2 : 3);
    const scope = remembered.projectId;
    const scoped = scope ? agents.filter((a) => a.projectId === scope) : agents;
    return [...(scoped.length > 0 ? scoped : agents)].sort(
      (a, b) => rank(a.status) - rank(b.status),
    )[0];
  }, [agents, remembered.projectId]);

  /*
   * Persisted, because this screen remounts on every navigation and a height you
   * dragged would otherwise reset each time you came back from Files. In the settings
   * file (Amendment 46), like every other size.
   */
  const savedH = Number(useSetting(COMPOSER_KEY));
  const composerH = Number.isFinite(savedH) && savedH > 0 ? clampH(savedH) : COMPOSER_DEFAULT;
  const setComposerH = (h: number): void => writeSetting(COMPOSER_KEY, String(h));

  /*
   * The inspector, shown or not (F18). Starts shown, and never hides itself by window
   * width: a panel that vanishes on its own looks like a bug. Unmounted when hidden — it
   * derives everything from the store, so bringing it back costs nothing.
   */
  const details = useSetting(DETAILS_KEY) !== 'hidden';
  // Reply or terminal, in the bottom panel (Amendment 58). Remembered like the rest.
  const bottomTab = useSetting('conductor.agentBottom') === 'terminal' ? 'terminal' : 'reply';
  const setBottomTab = (t: 'reply' | 'terminal'): void => writeSetting('conductor.agentBottom', t === 'reply' ? null : t);
  const setDetails = (next: boolean | ((d: boolean) => boolean)): void => {
    // Read now, not from this render: the `i` key's listener outlives the render it saw.
    const v = typeof next === 'function' ? next(readSetting(DETAILS_KEY) !== 'hidden') : next;
    writeSetting(DETAILS_KEY, v ? 'shown' : 'hidden');
  };

  /*
   * The Needs you panel (Amendment 108), in the details' place while it's open. Opened only
   * by a click: the blocked banner, the header's "needs you" button, or a tab's amber count.
   * Not a setting: it's about what's waiting now, and kept across an agent change because
   * this screen stays mounted. The ref is for the `i` key's listener, which outlives renders.
   */
  const [needsOpen, setNeedsOpenState] = useState(false);
  const needsRef = useRef(false);
  const setNeedsOpen = (open: boolean): void => {
    needsRef.current = open;
    setNeedsOpenState(open);
  };
  // `i` and the details button close it and show the details; otherwise they toggle them.
  const toggleDetails = (): void => {
    if (needsRef.current) {
      setNeedsOpen(false);
      setDetails(true);
    } else setDetails((d) => !d);
  };

  // `i`, with the guards the screen keys use (main.tsx): no modifier, and not while
  // typing — an `i` in the composer is a letter, not a command.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'i' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
        return;
      }
      toggleDetails();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const exists = (id: string | undefined) =>
    id !== undefined && agents.some((a) => a.id === id) ? id : undefined;
  const active = exists(routed) ?? exists(remembered.agentId) ?? fallback?.id ?? null;
  const agent = useAgent(active);

  /*
   * Files follows the project you're in (Amendment 91): openAgent() already says so, but an
   * Agent screen reached by its own URL, or still here after a reload, never called it. Once
   * the agent is known, say so — a reload lands here before anything else is on screen.
   */
  useEffect(() => {
    if (agent) highlight(agent.projectId);
  }, [agent?.projectId]);

  const events = useAgentEvents(active);
  const jobs = useJobs(agent?.projectId);
  const job = jobs.find((j) => j.id === agent?.jobId) ?? null;
  const allPending = usePending();
  const allAlerts = useAlerts();
  const unseenAgents = useUnseenAgents();
  // Switching to an agent with nothing waiting closes the panel; answering the last one doesn't.
  // The same count its tab shows (agent/tabs.ts): its requests, and the alerts that name it.
  const needsHere =
    active === null
      ? 0
      : allPending.filter((p) => p.agentId === active).length +
        allAlerts.filter((a) => a.agentIds.includes(active)).length;
  useEffect(() => {
    if (needsHere === 0) setNeedsOpen(false);
  }, [active]);
  // Shared by interrupt, pause and terminate — see StopControls.
  const control = useCommand();
  // What removing it would do to its job, while that confirm is armed (Amendment 89).
  const [ask, setAsk] = useState<string | null>(null);
  // What re-running the agents after it will do, while that confirm is armed (Amendment 102).
  const [rerunAsk, setRerunAsk] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const elapsedMs = useElapsedMs(
    agent ? startedMs(agent, events) : null,
    agent?.endedAt ?? null,
    events,
  );

  /*
   * File names link to Files (F16). The tree is the one Files fetches, and it is what
   * decides whether a path in the prose is a real file or only looks like one.
   */
  const jobId = job?.id ?? null;
  const worktree = job?.worktreePath ?? null;
  const tree = useFileTree(jobId);
  const files = useMemo(() => (tree.data ? filesIn(tree.data.root) : null), [tree.data]);
  const links = useMemo(
    () => (jobId !== null && worktree !== null ? fileLinks({ id: jobId, worktreePath: worktree }, files) : null),
    [jobId, worktree, files],
  );

  /*
   * Built here rather than in <Transcript> because "fold all" needs the replies' keys
   * too (Amendment 33).
   */
  const worktreePath = links?.worktreePath ?? '';
  const turns = useMemo(() => buildTranscript(events, worktreePath), [events, worktreePath]);
  const replies = useMemo(() => replyKeys(turns), [turns]);
  const folds = useFolds();
  const foldedHere = active !== null ? (folds[active] ?? []) : [];
  const anyOpen = replies.some((k) => !foldedHere.includes(k));

  /*
   * Where to scroll (F15; the decision is `scrollIntent` in scroll.ts). Arriving lands on
   * the latest reply; after that, the stream is followed only while you're reading the
   * bottom of it.
   *
   * A layout effect, so the jump happens before paint and the top never flashes.
   * `fromBottom` is kept on every scroll and after every jump, so a change is judged by
   * where you were before it arrived.
   */
  const landedOn = useRef<string | null>(null);
  const fromBottom = useRef(0);
  // New events arrived below you while you were reading further up.
  const [behind, setBehind] = useState(false);
  const eventCount = events.length;
  const lastSeq = events.at(-1)?.seq ?? 0;
  const hasPane = agent !== null;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const intent = scrollIntent({
      landedOn: landedOn.current,
      agentId: active,
      eventCount,
      fromBottom: fromBottom.current,
    });
    if (intent === 'stay') {
      if (landedOn.current === active && eventCount > 0) setBehind(true);
      return;
    }
    el.scrollTop = el.scrollHeight;
    fromBottom.current = 0;
    if (intent === 'jump') landedOn.current = active;
    setBehind(false);
  }, [active, eventCount, lastSeq, hasPane]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom.current < FOLLOW_PX) setBehind(false);
  }, []);

  const toLatest = useCallback(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setBehind(false);
  }, []);

  if (!agent) {
    return (
      <div className="fl-screen">
        <div className="fl-pane">
          <div className="fl-empty">
            <p className="fl-empty-h">No agent selected.</p>
            <p>Pick a lane on the Project screen, or an agent row on the Fleet grid.</p>
          </div>
        </div>
      </div>
    );
  }

  const project = projects.find((p) => p.id === agent.projectId);
  const siblings = agents.filter((a) => a.jobId === agent.jobId);
  const pending = allPending.filter((p) => p.agentId === agent.id);
  const shown = shownStatus(agent, pending);
  const key = STATUS_KEY[shown];
  const action = currentAction(agent, events, pending, dependencyNames(agent, siblings));

  const elapsed = elapsedMs === null ? null : fmtElapsed(elapsedMs);
  /*
   * Stopped on its cap. Amber, not red: nothing broke, and the next move is a person's
   * — raise it in the composer below. Not while working (the run is still under it)
   * and not once terminated (nothing is coming back to spend).
   */
  const atBudget =
    budgetOf(agent)?.over === true && agent.status !== 'working' && agent.status !== 'stopped';

  const exportTranscript = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project?.name ?? 'agent'}-${agent.role}-transcript.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Newest job first (Amendment 49), the way the Project screen lists them.
  const jobOrder = [...jobs].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)).map((j) => j.id);
  const tabs = agentTabs(agents, agent.projectId, jobOrder, allPending, allAlerts);

  return (
    <div className="fl-screen">
      <div className="fl-pane">
        {/*
         * One tab per agent in this project (Amendment 49). Only with more than one: a
         * single tab is a label that repeats the header.
         */}
        {tabs.length > 1 && (
          <div className="ag-tabs" role="tablist" aria-label={`Agents in ${project?.name ?? 'this project'}`}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === agent.id}
                className={`ag-tab${t.id === agent.id ? ' is-on' : ''}${t.needs > 0 ? ' is-need' : ''}${t.newJob ? ' is-newjob' : ''}`}
                title={t.needs > 0 ? `${t.label} — ${t.needs === 1 ? 'needs you' : `${t.needs} things need you`}` : `${t.label} — ${STATUS_WORD[t.status]}`}
                onClick={() => {
                  const target = agents.find((a) => a.id === t.id);
                  if (target && t.id !== agent.id) openAgent(target);
                }}
              >
                <Dot status={t.status} />
                {t.label}
                {/* Filled, the same look as the status Tag (Amendment 94); working
                    already pulses via the Dot above. Finished only until you open that
                    agent, and again when it finishes again (Amendment 105). */}
                {t.status === 'done' && unseenAgents.has(t.id) && <span className="ag-tab-tag">finished</span>}
                {/* The count opens that agent with its Needs you panel (Amendment 108); the
                    rest of the tab only switches agent. */}
                {t.needs > 0 && (
                  <span
                    className="ag-tab-need"
                    title="Open what is waiting on you, beside the transcript"
                    onClick={(e) => {
                      e.stopPropagation();
                      const target = agents.find((a) => a.id === t.id);
                      if (target && t.id !== agent.id) openAgent(target);
                      setNeedsOpen(true);
                    }}
                  >
                    {t.needs}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="fl-panehead">
          <button
            type="button"
            className="ui-crumb ag-crumb"
            onClick={() => openProject(agent.projectId)}
          >
            {project?.name ?? agent.projectId}
            <i>/</i>
            <b>{agent.role}</b>
          </button>
          <Dot status={shown} />
          <Tag tone={key}>
            {STATUS_WORD[shown]}
            {elapsed && agent.status !== 'queued' ? ` · ${elapsed}` : ''}
          </Tag>
          {agent.blockMode && <Tag tone="need">{agent.blockMode}</Tag>}
          {needsHere > 0 && (
            <button
              type="button"
              className="ui-tag t-need atn-needs-btn"
              aria-pressed={needsOpen}
              title={needsOpen ? 'Close the needs you panel' : 'Answer it here, beside the transcript'}
              onClick={() => setNeedsOpen(!needsOpen)}
            >
              needs you · {needsHere}
            </button>
          )}
          {atBudget && <Tag tone="need">budget reached</Tag>}
          <span className="ag-model" title={agent.model}>
            {agent.model.replace(/^claude-/, '')}
          </span>
          <ProviderBadge provider={agent.provider} />

          <div className="fl-panehead-r">
            <button
              type="button"
              className="fl-btn is-ghost"
              aria-pressed={details && !needsOpen}
              title={details && !needsOpen ? 'Hide the details panel (i)' : 'Show the details panel (i)'}
              onClick={toggleDetails}
            >
              {/* Names the panel, and the arrow says which way it will go. */}
              {details && !needsOpen ? (
                <>
                  details <span aria-hidden="true">⇥</span>
                </>
              ) : (
                <>
                  <span aria-hidden="true">⇤</span> details
                </>
              )}
            </button>
            {/*
             * While terminate or remove is armed, the header is the decision: its confirm
             * needs the room, and these can wait (Amendment 89).
             */}
            {ask === null && rerunAsk === null && replies.length > 0 && (
              <button
                type="button"
                className="fl-btn is-ghost"
                title={anyOpen ? 'Fold every reply to one line' : 'Unfold every reply'}
                onClick={() =>
                  updateFolds((f) =>
                    anyOpen ? foldAll(f, agent.id, replies) : unfoldAll(f, agent.id),
                  )
                }
              >
                {anyOpen ? '⌃ fold all' : '⌄ unfold all'}
              </button>
            )}
            {ask === null && rerunAsk === null && (
              <>
                <button type="button" className="fl-btn is-ghost" onClick={exportTranscript}>
                  ⤓ export
                </button>
                <button
                  type="button"
                  className="fl-btn is-danger"
                  disabled={control.busy || ENDED.has(agent.status) || agent.status === 'paused'}
                  onClick={() => void control.run('Interrupting', () => interruptAgent(agent.id))}
                >
                  ⎋ {control.busy ? 'working…' : 'interrupt'}
                </button>
              </>
            )}
            <RerunControl agent={agent} events={events} cmd={control} hidden={ask !== null} onAsk={setRerunAsk} />
            {rerunAsk === null && <StopControls agent={agent} cmd={control} onAsk={setAsk} />}
          </div>
        </div>

        {(ask ?? rerunAsk) && <div className="ag-notice is-banner t-warn" role="status">{ask ?? rerunAsk}</div>}
        {control.notice && (
          <div className={`ag-notice is-banner t-${control.notice.tone}`} onClick={control.dismiss}>
            {control.notice.text}
          </div>
        )}

        {pending.length > 0 && (
          <button
            type="button"
            className="ag-blocked"
            onClick={() => setNeedsOpen(true)}
          >
            <span className="ui-lab">Waiting on you</span>
            <span className="ag-blocked-act">
              {action.head} <b>{action.subject}</b>
            </span>
            <span className="ag-blocked-go">answer →</span>
          </button>
        )}

        <div className="fl-panebody" ref={bodyRef} onScroll={onScroll}>
          <LastAsk events={events} />
          <Transcript
            turns={turns}
            agentId={agent.id}
            role={agent.role}
            streaming={agent.status === 'working'}
            links={links}
          />
          {/*
            * Without it, the follow rule's restraint reads as "nothing is happening":
            * you scrolled up, and the agent kept talking below you.
            */}
          {behind && (
            <button type="button" className="ag-latest" onClick={toLatest}>
              ↓ latest
            </button>
          )}
        </div>

        {/*
          * Drag to resize (Amendment 25). The composer grew a mode row and a
          * guardrail row, and a fixed height meant the thing you are typing into is
          * the thing with least room. The handle sets a height in px and the
          * transcript above takes what is left, because the transcript is the part
          * that can scroll. Dragging up grows it, hence `grow={-1}`.
          */}
        <Splitter
          orientation="horizontal"
          size={composerH}
          min={COMPOSER_MIN}
          max={COMPOSER_MAX}
          grow={-1}
          onSize={(h) => setComposerH(clampH(h))}
          onReset={() => setComposerH(COMPOSER_DEFAULT)}
          label="Resize the composer"
        />

        {/* Reply, or run a command in this agent's folder (Amendment 58). */}
        <div className="ag-bottom-tabs" role="tablist">
          <button type="button" role="tab" className="ag-bottom-tab" aria-selected={bottomTab !== 'terminal'} onClick={() => setBottomTab('reply')}>
            reply
          </button>
          <button type="button" role="tab" className="ag-bottom-tab" aria-selected={bottomTab === 'terminal'} onClick={() => setBottomTab('terminal')}>
            ›_ terminal
          </button>
        </div>
        <div className="ag-composer-wrap" style={{ height: `${composerH}px` }}>
          {bottomTab === 'terminal' ? <TerminalPanel agent={agent} /> : <Composer agent={agent} />}
        </div>
      </div>

      {/* The Needs you panel takes the details' place while it's open (Amendment 108). */}
      {needsOpen ? (
        <NeedsPanel agent={agent} onClose={() => setNeedsOpen(false)} />
      ) : (
        details && <Inspector agent={agent} job={job} events={events} elapsedMs={elapsedMs} links={links} />
      )}
    </div>
  );
}
