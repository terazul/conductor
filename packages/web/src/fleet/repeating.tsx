/**
 * Repeating (Amendment 211): a project's jobs that repeat, on the Project screen. Each row is a
 * Spawn setup saved with repeat…: its name, its rule in words, when it next runs, and what its
 * last time did, with a link to the job it started. Pause and resume it, change its time, or
 * cancel it (asked first). Cancelling keeps the jobs it started.
 *
 * The rules each run follows are the daemon's (session/recurring.ts): a run due while the last
 * one is still going is skipped, and times missed while the daemon was down launch once.
 */

import { useState } from 'react';
import type { Agent, RecurringJob } from '@conductor/shared';
import { everyProblem, everyWords, readResult } from '@conductor/shared';
import { useAgents, useRecurring } from '../lib/store.js';
import { fmtStamp } from '../lib/when.js';
import { openAgent } from '../shell/nav.js';
import { RuleFields, draftOf, ruleOf, type RuleDraft } from '../shell/RuleFields.js';
import { useCommand } from '../agent/endpoints.js';
import { cancelRecurring, patchRecurring } from './endpoints.js';

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

/** The agent to open for a run's job: its first, if the job is still here. */
function firstAgentOf(agents: readonly Agent[], jobId: string | null): Agent | null {
  return jobId === null ? null : (agents.find((a) => a.jobId === jobId) ?? null);
}

export function RepeatingRow({ r, agents }: { r: RecurringJob; agents: readonly Agent[] }) {
  const cmd = useCommand();
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const now = new Date();
  const runAgent = firstAgentOf(agents, r.lastJobId);
  const result = readResult(r.lastResult);
  const tone = result?.kind === 'failed' ? ' is-fail' : result?.kind === 'skipped' ? ' is-skip' : '';
  const editWhy = editing ? everyProblem(ruleOf(editing)) : null;

  return (
    <div className={`pj-rep${r.paused ? ' is-paused' : ''}`}>
      <div className="pj-rep-name" title={r.request.prompt}>
        {r.name}
      </div>
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
      </div>

      {editing && (
        <div className="pj-rep-edit">
          <RuleFields rule={editing} onChange={setEditing} />
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
                void cmd
                  .run('Changing the time', () => patchRecurring(r.id, { every: ruleOf(editing) }))
                  .then((ok) => ok && setEditing(null))
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
            <span className="pj-group-ask">Cancel this schedule? The jobs it started stay.</span>
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
              onClick={() => void cmd.run(r.paused ? 'Resuming' : 'Pausing', () => patchRecurring(r.id, { paused: !r.paused }))}
              title={r.paused ? 'Run it again on its rule, next due from now' : 'Stop it running until you resume it'}
            >
              {r.paused ? '▶ resume' : '❚❚ pause'}
            </button>
            <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={() => setEditing(draftOf(r.every))}>
              edit time
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
