/**
 * Repeating (Amendment 211): a project's jobs that repeat, on the Project screen. Each row is a
 * Spawn setup saved with repeat…: its name, its rule in words, when it next runs, and what its
 * last time did, with a link to the job it started. Pause and resume it, change its time, or
 * cancel it (asked first). Cancelling keeps the jobs it started.
 *
 * The rules each run follows are the daemon's (session/recurring.ts): a run due while the last
 * one is still going is skipped, and times missed while the daemon was down launch once.
 *
 * Amendment 216: a schedule can be a message to an agent instead, sent on its rule. The row says
 * which (**⟳ job** or **⟳ message to developer**), links a message's last result to its agent, and
 * offers ▶ run now and an edit of its name, its rule and its prompt or text, in place. The same row
 * is the Repeating screen's (repeating/route.tsx). `RepeatJobForm` saves a job you ran to repeat,
 * from its ⟳ repeat… on the Project screen, the Fleet card and that screen's + new.
 */

import { useState } from 'react';
import type { Agent, Job, PatchRecurringRequest, Project, RecurringJob } from '@conductor/shared';
import { NOT_REPEATABLE, RECURRING_NAME_MAX, everyProblem, everyWords, readResult, recurringNameProblem } from '@conductor/shared';
import { useAgents, useRecurring } from '../lib/store.js';
import { fmtStamp } from '../lib/when.js';
import { openAgent } from '../shell/nav.js';
import { DEFAULT_RULE, RuleFields, draftOf, ruleOf, type RuleDraft } from '../shell/RuleFields.js';
import { useCommand } from '../agent/endpoints.js';
import { defaultName, ruleLine } from '../spawn/repeat.js';
import { cancelRecurring, patchRecurring, runRecurring, saveRecurringFromJob } from './endpoints.js';

// The mark on a run's job is shared's, so the navigator draws the same words.
export { fromMark } from '@conductor/shared';

/** What its last time did: "started 09:00", "skipped 09:00: the last run was still going". */
export function resultLine(r: Pick<RecurringJob, 'lastAt' | 'lastResult'>, now: Date = new Date()): string {
  const result = readResult(r.lastResult);
  if (result === null || r.lastAt === null) return 'not run yet';
  const at = fmtStamp(r.lastAt, now);
  switch (result.kind) {
    case 'started':
      return `started ${at}`;
    case 'sent':
      return `sent ${at}`;
    case 'skipped':
      return `skipped ${at}: the last run was still going`;
    case 'failed':
      return `failed ${at}: ${result.reason}`;
  }
}

/** The Fleet card's count: "⟳ 2 repeating", or null for none. */
export function repeatingCount(n: number): string | null {
  return n > 0 ? `⟳ ${n} repeating` : null;
}

/** What it repeats: "⟳ job", or "⟳ message to developer" by the agent's role. */
export function kindWords(r: Pick<RecurringJob, 'kind' | 'agentId'>, agents: readonly Pick<Agent, 'id' | 'role'>[]): string {
  if (r.kind === 'job') return '⟳ job';
  return `⟳ message to ${agents.find((a) => a.id === r.agentId)?.role ?? 'an agent'}`;
}

/** Every schedule by its project, in the projects' own order; a project with none left out. */
export function repeatingGroups<P extends Pick<Project, 'id'>, R extends Pick<RecurringJob, 'projectId'>>(
  projects: readonly P[],
  recurring: readonly R[],
): { project: P; items: R[] }[] {
  return projects.map((project) => ({ project, items: recurring.filter((r) => r.projectId === project.id) })).filter((g) => g.items.length > 0);
}

/** The Repeating screen's count: "3 schedules in 2 projects", or that there are none. */
export function repeatingSummary(groups: readonly { items: readonly unknown[] }[]): string {
  const n = groups.reduce((sum, g) => sum + g.items.length, 0);
  if (n === 0) return 'nothing repeats yet';
  return `${n} schedule${n === 1 ? '' : 's'} in ${groups.length} project${groups.length === 1 ? '' : 's'}`;
}

/** A project's jobs that can be repeated, newest first: those whose setup Conductor kept. */
export function repeatableJobs<J extends Pick<Job, 'projectId' | 'createdAt' | 'repeatable'>>(jobs: readonly J[], projectId: string): J[] {
  return jobs.filter((j) => j.projectId === projectId && j.repeatable).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** ⟳ repeat…'s title on a job: what it does, or why it can't (NOT_REPEATABLE, the daemon's words). */
export function repeatJobTitle(job: Pick<Job, 'repeatable'>): string {
  return job.repeatable ? 'Run a job like this one again on a rule, until you cancel it' : NOT_REPEATABLE;
}

/** An edit in place: the name, the rule, and the prompt (a job) or the text (a message). */
export interface RepeatEdit {
  name: string;
  rule: RuleDraft;
  body: string;
}

/** What an edit starts as: the schedule as it is. */
export function editOf(r: RecurringJob): RepeatEdit {
  return { name: r.name, rule: draftOf(r.every), body: (r.kind === 'message' ? r.text : r.request?.prompt) ?? '' };
}

/** What is wrong with an edit, or null. The daemon checks the same, and a prompt against the whole setup. */
export function editProblem(r: Pick<RecurringJob, 'kind'>, e: RepeatEdit): string | null {
  return (
    recurringNameProblem(e.name) ??
    everyProblem(ruleOf(e.rule)) ??
    (e.body.trim() ? null : r.kind === 'message' ? 'Write the message first.' : 'Write what needs doing first.')
  );
}

/** The PATCH an edit makes: only what changed, a prompt for a job and text for a message. */
export function editPatch(r: RecurringJob, e: RepeatEdit): PatchRecurringRequest {
  const was = editOf(r);
  const every = ruleOf(e.rule);
  return {
    ...(e.name.trim() !== r.name ? { name: e.name.trim() } : {}),
    ...(JSON.stringify(every) !== JSON.stringify(r.every) ? { every } : {}),
    ...(e.body.trim() !== was.body.trim() ? (r.kind === 'message' ? { text: e.body.trim() } : { prompt: e.body.trim() }) : {}),
  };
}

/** The agent to open for a run's job: its first, if the job is still here. */
function firstAgentOf(agents: readonly Agent[], jobId: string | null): Agent | null {
  return jobId === null ? null : (agents.find((a) => a.jobId === jobId) ?? null);
}

export function RepeatingRow({ r, agents }: { r: RecurringJob; agents: readonly Agent[] }) {
  const cmd = useCommand();
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<RepeatEdit | null>(null);
  const now = new Date();
  const message = r.kind === 'message';
  const runAgent = message ? null : firstAgentOf(agents, r.lastJobId);
  const toAgent = message ? (agents.find((a) => a.id === r.agentId) ?? null) : null;
  const result = readResult(r.lastResult);
  const tone = result?.kind === 'failed' ? ' is-fail' : result?.kind === 'skipped' ? ' is-skip' : '';
  const editWhy = editing ? editProblem(r, editing) : null;

  return (
    <div className={`pj-rep${r.paused ? ' is-paused' : ''}`}>
      <div className="pj-rep-name" title={r.request?.prompt ?? r.text}>
        {r.name}
      </div>
      <div className="pj-rep-kind">{kindWords(r, agents)}</div>
      <div className="pj-rep-rule">
        {everyWords(r.every)} · {r.paused ? 'paused' : `next ${fmtStamp(r.nextAt, now)}`}
      </div>
      <div className={`pj-rep-last${tone}`}>
        {resultLine(r, now)}
        {runAgent && (
          <>
            {' · '}
            <button type="button" className="pj-rep-link" onClick={() => openAgent(runAgent)} title="Open the job this run started">
              its job
            </button>
          </>
        )}
        {toAgent && (
          <>
            {' · '}
            <button type="button" className="pj-rep-link" onClick={() => openAgent(toAgent)} title="Open the agent it writes to">
              its agent
            </button>
          </>
        )}
      </div>

      {editing && (
        <div className="pj-rep-edit">
          <input
            className="pj-rep-input"
            aria-label="name"
            value={editing.name}
            maxLength={RECURRING_NAME_MAX}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
          <RuleFields rule={editing.rule} onChange={(rule) => setEditing({ ...editing, rule })} />
          <textarea
            className="pj-rep-body"
            aria-label={message ? 'the message' : 'the prompt'}
            rows={3}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
          {editWhy && <span className="pj-rep-why">{editWhy}</span>}
        </div>
      )}

      <div className="pj-rep-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="fl-btn is-primary"
              disabled={cmd.busy || editWhy !== null}
              onClick={() =>
                void cmd.run('Saving the schedule', () => patchRecurring(r.id, editPatch(r, editing))).then((ok) => ok && setEditing(null))
              }
            >
              save
            </button>
            <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={() => setEditing(null)}>
              cancel
            </button>
          </>
        ) : armed ? (
          <>
            <span className="pj-group-ask">{message ? 'Cancel this schedule? What it sent stays.' : 'Cancel this schedule? The jobs it started stay.'}</span>
            <button
              type="button"
              className="fl-btn is-danger"
              disabled={cmd.busy}
              onClick={() => void cmd.run('Cancelling the schedule', () => cancelRecurring(r.id))}
            >
              {cmd.busy ? 'cancelling…' : '✕ cancel it'}
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
              keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="fl-btn is-ghost"
              disabled={cmd.busy}
              onClick={() => void cmd.run('Running it now', () => runRecurring(r.id), () => 'Done: its last result says how it went.')}
              title={
                message
                  ? 'Send it once now; its next time stays'
                  : 'Start it once now; its next time stays, and it is skipped if its last run is still going'
              }
            >
              ▶ run now
            </button>
            <button
              type="button"
              className="fl-btn is-ghost"
              disabled={cmd.busy}
              onClick={() => void cmd.run(r.paused ? 'Resuming' : 'Pausing', () => patchRecurring(r.id, { paused: !r.paused }))}
              title={r.paused ? 'Run it again on its rule, next due from now' : 'Stop it running until you resume it'}
            >
              {r.paused ? '▶ resume' : '❚❚ pause'}
            </button>
            <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={() => setEditing(editOf(r))}>
              edit
            </button>
            <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={() => setArmed(true)}>
              ✕ cancel
            </button>
          </>
        )}
      </div>

      {cmd.notice && (
        <div className={`pj-notice t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}

/**
 * ⟳ repeat… on a job you ran (Amendment 216): a name, its prompt to change or keep, and a rule. The
 * daemon copies the setup it kept for the job with this prompt; a job launched before it kept one
 * gets no button (`repeatJobTitle`), and the daemon refuses it in the same words.
 */
export function RepeatJobForm({ job, onClose }: { job: Pick<Job, 'id' | 'name' | 'prompt'>; onClose: () => void }) {
  const cmd = useCommand();
  const [name, setName] = useState(() => defaultName(job.name ?? '', job.prompt));
  const [prompt, setPrompt] = useState(job.prompt);
  const [rule, setRule] = useState<RuleDraft>(DEFAULT_RULE);
  const every = ruleOf(rule);
  const why = recurringNameProblem(name) ?? everyProblem(every) ?? (prompt.trim() ? null : 'Write what needs doing first.');

  return (
    // Its clicks and keys are its own, inside a Fleet card that opens on both.
    <div className="pj-rep-form" role="group" aria-label="repeat this job" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="pj-rep-edit">
        <span className="ui-lab">repeat as</span>
        <input
          className="pj-rep-input"
          aria-label="name"
          value={name}
          maxLength={RECURRING_NAME_MAX}
          placeholder="A name for the schedule"
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <textarea className="pj-rep-body" aria-label="the prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="pj-rep-edit">
        <RuleFields rule={rule} onChange={setRule} />
        <span className="pj-rep-rule">{ruleLine(rule, new Date())}</span>
      </div>
      <div className="pj-rep-actions">
        <button
          type="button"
          className="fl-btn is-primary"
          disabled={cmd.busy || why !== null}
          onClick={() =>
            void cmd
              .run('Saving the schedule', () => saveRecurringFromJob(name.trim(), every, job.id, prompt.trim()), (res: { recurring: RecurringJob }) => `Saved: next ${fmtStamp(res.recurring.nextAt)}.`)
          }
        >
          {cmd.busy ? 'saving…' : 'save schedule'}
        </button>
        <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={onClose}>
          close
        </button>
        <span className="pj-rep-how">Each run is a new job with this job's setup and this prompt. If the last run is still going when the next is due, that one is skipped.</span>
      </div>
      {why && <span className="pj-rep-why">{why}</span>}
      {cmd.notice && (
        <div className={`pj-notice t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}

/** ⟳ repeat… on a job: open while its form is, shut with the reason as its title when the job can't repeat. */
export function RepeatJobButton({ job, open, onToggle }: { job: Pick<Job, 'repeatable'>; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="fl-btn is-ghost"
      aria-expanded={open}
      disabled={!job.repeatable}
      title={repeatJobTitle(job)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      ⟳ repeat…
    </button>
  );
}

/** The list itself, for one project: nothing at all when it has none. */
export function RepeatingList({ projectId }: { projectId: string }) {
  const recurring = useRecurring().filter((r) => r.projectId === projectId);
  const agents = useAgents();
  if (recurring.length === 0) return null;
  return (
    <div className="pj-facts pj-repeating">
      <span className="ui-lab">Repeating · {recurring.length}</span>
      {recurring.map((r) => (
        <RepeatingRow key={r.id} r={r} agents={agents} />
      ))}
    </div>
  );
}
