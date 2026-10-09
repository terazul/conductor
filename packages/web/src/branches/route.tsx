/**
 * Screen 7 — Branches (Amendment 109, ADR 0008). A project's local branches drawn against
 * its default branch, and the four things you do to land an agent's work: merge one into
 * main, merge them all, commit what's uncommitted, push to origin. Plus Fetch.
 *
 *   order 65 · hotkey 7. Registered by main.tsx's `./＊/route.tsx` glob, like every screen.
 *
 * WHICH PROJECT. The one the route names (`openBranches(projectId)`), else the one you
 * were last on (`recall()`, which the Project and Agent screens keep up to date). The
 * route's own project wins over the remembered one, as in Files (Amendment 91). With
 * neither, the screen says so and lists the projects.
 *
 * WHEN IT RE-READS. On arriving, on the window getting focus back, after every action
 * (from the answer's own `branches`, not a second request), when a `branches` frame names
 * this project (another tab acted), and when this project's jobs or their agents change
 * status, because `live` and new commits follow those.
 *
 * WHAT IT REFUSES. Everything the daemon refuses, said beforehand: see rules.ts. The
 * daemon's 409 still has the last word, and its sentence is shown as it is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchAction, BranchActionResult, BranchInfo, BranchesResponse } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { ApiError, errorText } from '../lib/errors.js';
import { useNavParams } from '../lib/nav.js';
import { useAgents, useJobs, useProjects } from '../lib/store.js';
import { SCREEN, highlight, openBranches, recall } from '../shell/nav.js';
import { branchAction, getBranches } from './endpoints.js';
import { BranchGraph } from './graph.js';
import { onBranchesChanged } from './live.js';
import {
  commitReason,
  defaultMessage,
  mergeAllState,
  mergeConfirm,
  mergeReason,
  mergeable,
  pushConfirm,
  pushReason,
  showCommit,
  showPush,
} from './rules.js';
import './branches.css';

type Outcome =
  | { kind: 'done'; action: BranchAction['action']; res: BranchActionResult }
  | { kind: 'error'; label: string; text: string; tone: 'warn' | 'fail' };

type Confirming = 'merge' | 'merge_all' | 'push' | null;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The project the screen shows: the route's, else the remembered one. */
function useProjectId(): string | null {
  const routed = useNavParams(SCREEN.branches)['projectId'];
  return routed ?? recall().projectId ?? null;
}

/** The branches of one project, re-read whenever something says they may have changed. */
function useBranches(projectId: string | null) {
  const [resp, setResp] = useState<BranchesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Answers can come back out of order; only the newest request's counts.
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await getBranches(projectId);
      if (mine !== seq.current) return;
      setResp(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [projectId]);

  /** An action's answer carries the state after it: take it, and drop any older read in flight. */
  const accept = useCallback((next: BranchesResponse) => {
    seq.current++;
    setResp(next);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    setResp(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [load]);

  useEffect(() => onBranchesChanged((id) => id === projectId && void load()), [projectId, load]);

  /*
   * This project's jobs and their agents' statuses. A job's branch appears when it starts,
   * `live` changes with its agents, and an agent finishing is when its commits are there.
   * The first value is the mount, which the effect above already read for.
   */
  const jobs = useJobs(projectId ?? undefined);
  const agents = useAgents();
  const activity = useMemo(() => {
    const ids = new Set(jobs.map((j) => j.id));
    const js = jobs.map((j) => `${j.id}:${j.status}`).join(',');
    const as = agents.filter((a) => ids.has(a.jobId)).map((a) => `${a.id}:${a.status}`).join(',');
    return `${js}|${as}`;
  }, [jobs, agents]);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const first = seen.current === null;
    seen.current = activity;
    if (!first) void load();
  }, [activity, load]);

  return { resp, error, loading, load, accept };
}

function Branches() {
  const projects = useProjects();
  const jobs = useJobs();
  const projectId = useProjectId();
  const project = projects.find((p) => p.id === projectId) ?? null;
  const { resp, error, loading, load, accept } = useBranches(project ? project.id : null);

  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState<BranchAction['action'] | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [message, setMessage] = useState('');

  // This is the project you're on now, for the screens that open on "the one you were on".
  useEffect(() => {
    if (project) highlight(project.id);
  }, [project?.id]);

  // A different project starts from nothing selected and nothing said.
  useEffect(() => {
    setSelected(null);
    setConfirming(null);
    setOutcome(null);
  }, [projectId]);

  const branch: BranchInfo | null = resp?.branches.find((b) => b.name === selected) ?? null;

  // Each newly selected branch starts from its job's prompt as the message.
  useEffect(() => {
    setConfirming((c) => (c === 'merge_all' ? c : null));
    setMessage(branch ? defaultMessage(branch, jobs) : '');
  }, [selected]);

  const run = useCallback(
    async (action: BranchAction, label: string) => {
      if (!project) return;
      setBusy(action.action);
      setOutcome(null);
      try {
        const res = await branchAction(project.id, action);
        accept(res.branches);
        setOutcome({ kind: 'done', action: action.action, res });
      } catch (err) {
        const tone = err instanceof ApiError && err.status === 409 ? 'warn' : 'fail';
        setOutcome({ kind: 'error', label, text: errorText(err), tone });
      } finally {
        setBusy(null);
        setConfirming(null);
      }
    },
    [project, accept],
  );

  if (!project) return <NoProject projectId={projectId} projects={projects} />;

  const all = resp ? mergeAllState(resp) : null;
  const target = resp?.target ?? 'main';

  return (
    <div className="br">
      <div className="br-head">
        <span className="ui-crumb">
          {project.name} <i>/</i> <b>branches</b>
        </span>
        {resp && (
          <span className="br-remote" title={resp.remote ? `the remote pushes go to` : 'this repo has no remote called origin'}>
            {resp.remote ? `⇅ ${resp.remote}` : 'no origin'}
          </span>
        )}
        {loading && <span className="br-quiet">reading…</span>}
        <div className="br-actions">
          <button
            type="button"
            className="br-btn"
            disabled={!resp?.remote || busy !== null}
            title={resp && !resp.remote ? 'this repo has no origin to fetch from' : `fetch ${resp?.remote ?? 'origin'} — nothing is pruned or merged`}
            onClick={() => void run({ action: 'fetch' }, 'Fetch')}
          >
            {busy === 'fetch' ? '⟳ Fetching…' : '⟳ Fetch'}
          </button>
          {all && (
            <>
              <button
                type="button"
                className="br-btn br-btn-go"
                disabled={all.reason !== null || busy !== null}
                title={all.reason ?? `merge ${plural(all.count, 'branch', 'branches')} into ${target}, one merge commit each`}
                aria-describedby={all.reason ? 'br-all-why' : undefined}
                onClick={() => setConfirming('merge_all')}
              >
                {busy === 'merge_all' ? '⇉ Merging…' : `⇉ Merge all into ${target} (${all.count})`}
              </button>
              {all.reason && (
                <span id="br-all-why" className="br-why">
                  {all.reason}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {confirming === 'merge_all' && resp && all && all.reason === null && (
        <div className="br-confirm" role="alertdialog" aria-label="confirm merge all">
          <span>
            Merge {plural(all.count, 'branch', 'branches')} into {target}, oldest first, one merge commit each?{' '}
            <span className="br-quiet">{mergeable(resp).map((b) => b.name).join(', ')}</span>. It stops at the first
            conflict, and undoes that one.
          </span>
          <button type="button" className="br-btn br-btn-go" disabled={busy !== null} onClick={() => void run({ action: 'merge_all' }, 'Merge all')}>
            Merge all
          </button>
          <button type="button" className="br-btn" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="br-body">
        {error && !resp && <div className="br-note fail">Couldn't read the branches — {error}</div>}
        {!error && !resp && <div className="br-note">Reading {project.name}'s branches…</div>}
        {error && resp && <div className="br-note fail">Couldn't refresh — {error}. Showing the last read.</div>}
        {resp && (
          <div className="br-scroll">
            <BranchGraph resp={resp} selected={selected} onSelect={(n) => setSelected((s) => (s === n ? null : n))} />
            {resp.branches.length <= 1 && (
              <div className="br-note">Only {target} so far. Branches appear here as agents start jobs.</div>
            )}
          </div>
        )}
      </div>

      {outcome && <Result outcome={outcome} target={target} onClose={() => setOutcome(null)} />}

      {resp && branch && (
        <ActionBar
          resp={resp}
          branch={branch}
          busy={busy}
          confirming={confirming}
          setConfirming={setConfirming}
          message={message}
          setMessage={setMessage}
          run={(a, l) => void run(a, l)}
          onClose={() => setSelected(null)}
        />
      )}
      {resp && !branch && !outcome && (
        <div className="br-hint">Choose a branch to merge, commit or push it. {loading ? '' : <button type="button" className="br-link" onClick={() => void load()}>re-read</button>}</div>
      )}
    </div>
  );
}

/** A disabled-able button with its reason beside it, so it never just sits there grey. */
function Act({
  label,
  reason,
  busy,
  go,
  onClick,
}: {
  label: string;
  reason: string | null;
  busy: boolean;
  go?: boolean;
  onClick: () => void;
}) {
  return (
    <span className="br-act">
      <button
        type="button"
        className={`br-btn${go ? ' br-btn-go' : ''}`}
        disabled={reason !== null || busy}
        title={reason ?? undefined}
        onClick={onClick}
      >
        {label}
      </button>
      {reason && <span className="br-why">{reason}</span>}
    </span>
  );
}

function ActionBar({
  resp,
  branch: b,
  busy,
  confirming,
  setConfirming,
  message,
  setMessage,
  run,
  onClose,
}: {
  resp: BranchesResponse;
  branch: BranchInfo;
  busy: BranchAction['action'] | null;
  confirming: Confirming;
  setConfirming: (c: Confirming) => void;
  message: string;
  setMessage: (m: string) => void;
  run: (a: BranchAction, label: string) => void;
  onClose: () => void;
}) {
  const working = busy !== null;
  const merge = mergeReason(resp, b);
  const commit = showCommit(b) ? commitReason(b) : null;
  const push = pushReason(resp, b);
  const confirmMerge = mergeConfirm(resp, b);
  const commitBlocked = commit ?? (message.trim().length === 0 ? 'write a message first' : null);

  return (
    <div className="br-bar" role="region" aria-label={`actions for ${b.name}`}>
      <div className="br-bar-head">
        <b>{b.name}</b>
        <span className="br-quiet">
          {b.isTarget ? 'the branch merges go into' : b.forkedAt === null ? `shares no history with ${resp.target}` : `${plural(b.ahead, 'commit')} ahead, ${b.behind} behind`}
          {b.worktree ? ` · ${b.worktree.path}` : ' · not checked out'}
        </span>
        <button type="button" className="br-link br-close" onClick={onClose} aria-label="close the actions">
          ✕
        </button>
      </div>

      <div className="br-bar-acts">
        {!b.isTarget && (
          <Act label={busy === 'merge' ? 'Merging…' : `Merge into ${resp.target}`} reason={merge} busy={working} go onClick={() => setConfirming('merge')} />
        )}

        {showCommit(b) && (
          <span className="br-act br-commit">
            <input
              className="br-input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && commitBlocked === null && !working) run({ action: 'commit', branch: b.name, message: message.trim() }, 'Commit');
              }}
              placeholder="commit message"
              aria-label={`commit message for ${b.name}`}
              disabled={commit !== null}
              spellCheck={false}
            />
            <Act
              label={busy === 'commit' ? 'Committing…' : `Commit ${plural(b.worktree?.uncommitted ?? 0, 'file')}…`}
              reason={commitBlocked}
              busy={working}
              onClick={() => run({ action: 'commit', branch: b.name, message: message.trim() }, 'Commit')}
            />
          </span>
        )}

        {showPush(resp, b) && (
          <Act label={busy === 'push' ? 'Pushing…' : `Push to ${resp.remote ?? 'origin'}`} reason={push} busy={working} onClick={() => setConfirming('push')} />
        )}

        {b.isTarget && !showCommit(b) && !showPush(resp, b) && (
          <span className="br-why">nothing to do — {resp.target} has no uncommitted work, and {resp.remote ?? 'origin'} has all of it</span>
        )}
      </div>

      {confirming === 'merge' && merge === null && (
        <div className="br-confirm" role="alertdialog" aria-label={`confirm merging ${b.name}`}>
          <span>
            {confirmMerge.ask}
            {confirmMerge.warn && <span className="br-warn"> {confirmMerge.warn}</span>}
          </span>
          <button type="button" className="br-btn br-btn-go" disabled={working} onClick={() => run({ action: 'merge', branch: b.name }, 'Merge')}>
            Merge
          </button>
          <button type="button" className="br-btn" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}

      {confirming === 'push' && push === null && (
        <div className="br-confirm" role="alertdialog" aria-label={`confirm pushing ${b.name}`}>
          <span>{pushConfirm(resp, b)}</span>
          <button type="button" className="br-btn br-btn-go" disabled={working} onClick={() => run({ action: 'push', branch: b.name }, 'Push')}>
            Push
          </button>
          <button type="button" className="br-btn" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** What an action did, in words, with git's own output where it said anything. */
function Result({ outcome, target, onClose }: { outcome: Outcome; target: string; onClose: () => void }) {
  if (outcome.kind === 'error') {
    return (
      <div className={`br-result ${outcome.tone}`} role="status">
        <span>
          {outcome.label} didn't happen — {outcome.text}
        </span>
        <button type="button" className="br-link br-close" onClick={onClose} aria-label="dismiss">
          ✕
        </button>
      </div>
    );
  }
  const { action, res } = outcome;
  const sha = res.sha ? ` (${res.sha.slice(0, 7)})` : '';
  let text: string;
  if (action === 'merge' || action === 'merge_all') {
    text =
      res.merged.length > 0
        ? `Merged ${res.merged.join(', ')} into ${target}${res.merged.length === 1 ? sha : ''}.`
        : res.conflict
          ? ''
          : `Nothing was merged.`;
  } else if (action === 'commit') text = `Committed${sha}.`;
  else if (action === 'push') text = res.ok ? 'Pushed.' : 'The push did not go through.';
  else text = res.ok ? 'Fetched.' : 'The fetch did not go through.';

  return (
    <div className={`br-result${res.conflict || !res.ok ? ' warn' : ' ok'}`} role="status">
      <div className="br-result-body">
        {text && <span>{text}</span>}
        {res.conflict && (
          <div className="br-conflict">
            <span>
              {res.conflict.branch} conflicts with {target} in {plural(res.conflict.files.length, 'file')} — the merge was undone,
              and {target} is as it was{res.merged.length > 0 ? ' after the merges above' : ''}.
            </span>
            <ul>
              {res.conflict.files.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {res.output && <pre className="br-output">{res.output}</pre>}
      </div>
      <button type="button" className="br-link br-close" onClick={onClose} aria-label="dismiss">
        ✕
      </button>
    </div>
  );
}

function NoProject({ projectId, projects }: { projectId: string | null; projects: { id: string; name: string; path: string }[] }) {
  return (
    <div className="br">
      <div className="br-head">
        <span className="ui-crumb">
          <b>branches</b>
        </span>
      </div>
      <div className="br-body">
        <div className="br-pick">
          {projectId ? <p>That project isn't here any more.</p> : <p>No project chosen yet.</p>}
          {projects.length === 0 ? (
            <p className="br-quiet">There are no projects. Add one on Fleet (1), and its branches show here.</p>
          ) : (
            <>
              <p className="br-quiet">Choose one to see its branches:</p>
              <ul>
                {projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="br-btn" onClick={() => openBranches(p.id)}>
                      {p.name}
                    </button>
                    <span className="br-quiet">{p.path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'branches',
  label: 'Branches',
  hotkey: '7',
  order: 65,
  Component: Branches,
};
