/**
 * Screen 3's inspector.  TRACK B.
 *
 * The facts you keep glancing at: who this is, what it is costing, what it has
 * touched, and what it is allowed to do.
 *
 * NO CONTEXT PERCENTAGE. The mockup shows "38% ctx" and CONTRACT §8 explicitly
 * leaves that open — tokens are reported until a real window size can be derived
 * from the Models API, because "a misleading percentage is worse than none". So
 * this reports tokens as tokens, and the one meter here measures spend against
 * the cap that will actually pause the agent.
 */

import { ceilingWords, type Agent, type Job } from '@conductor/shared';
import { budgetOf, budgetWords, scopedRules, toolPolicy } from '../shell/autonomy.js';
import { filesTouched, latestTodo } from '../shell/describe.js';
import { DiffNums, fmtElapsed, fmtMoney, fmtTokens } from '../shell/ui.js';
import { agentPairWords } from '../shell/spend.js';
import { CLAUDE, capabilitiesOf, providerLabel, providerOf, tokenWords, useProviders } from '../lib/providers.js';
import type { Event } from '@conductor/shared';
import { OUTSIDE, type FileLinks } from './links.js';
import { AGENT_INSPECTOR, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';
import { useProjects } from '../lib/store.js';
import { NotesPanel } from '../fleet/Notes.js';

export function Inspector({
  agent,
  job,
  events,
  elapsedMs,
  links,
}: {
  agent: Agent;
  job: Job | null;
  events: readonly Event[];
  /** Null when a recording gives us no clock to measure against. */
  elapsedMs: number | null;
  /** The transcript's file links, so a touched file opens in Files from here too. */
  links: FileLinks | null;
}) {
  const budget = budgetOf(agent);
  // An engine that reports no dollars shows no spend, and its cap is in tokens (Amendment 80).
  const dollars = capabilitiesOf(agent, useProviders()).costUsd;
  const pair = agentPairWords(agent, dollars);
  const autonomy = agent.autonomy;
  const todo = latestTodo(events);
  const files = filesTouched(events);
  const tokens = agent.inputTokens + agent.outputTokens;
  // Drag its left edge (Amendment 34). Leftwards grows it, hence `grow={-1}`.
  const { size, handle } = usePanel(AGENT_INSPECTOR);
  // Its project's notes, the same ones the Fleet card shows (Amendment 56).
  const project = useProjects().find((p) => p.id === agent.projectId) ?? null;

  return (
    <>
      <Splitter orientation="vertical" grow={-1} label="Resize the inspector" {...handle} />
      <aside className="ag-insp" style={{ width: `${size}px` }}>
        <div className="ag-isec">
          <span className="ui-lab">Agent</span>
          <div className="pj-kv">
            <span>role</span>
            <span>{agent.role}</span>
          </div>
          <div className="pj-kv">
            <span>model</span>
            <span title={agent.model}>{agent.model.replace(/^claude-/, '')}</span>
          </div>
          {providerOf(agent) !== CLAUDE && (
            <div className="pj-kv">
              <span>engine</span>
              <span>{providerLabel(agent.provider)}</span>
            </div>
          )}
          <div className="pj-kv">
            <span>elapsed</span>
            <span>{elapsedMs === null ? '—' : fmtElapsed(elapsedMs)}</span>
          </div>
          <div className="pj-kv">
            {/* Today (what the budget counts) and its whole life, side by side (Amendment 146); in
                tokens on an engine that reports no dollars. */}
            <span title="What this agent spent today, which its budget counts and which starts again at midnight; and over its whole life.">spent</span>
            <span title={dollars ? undefined : `${providerLabel(agent.provider)} reports tokens, not dollars`}>
              {pair.today} · {pair.total}
            </span>
          </div>
          {agent.sdkSessionId && (
            <div className="pj-kv">
              <span>session</span>
              <span title={agent.sdkSessionId}>{agent.sdkSessionId.slice(0, 12)}…</span>
            </div>
          )}
        </div>

        <div className="ag-isec">
          <span className="ui-lab">Usage</span>
          {budget ? (
            <>
              <div className="ag-bar" data-tone={budget.tone}>
                <i style={{ width: `${Math.round(budget.fraction * 100)}%` }} />
              </div>
              <div className="pj-kv">
                <span>
                  {budget.unit === 'tokens'
                    ? `today ${tokenWords(budget.spent)} of ${tokenWords(budget.cap)} tokens`
                    : `today ${fmtMoney(budget.spent)} of ${fmtMoney(budget.cap)}`}
                </span>
                <span className="ag-bar-pct" data-tone={budget.tone}>
                  {budget.pct}%
                </span>
              </div>
              {budget.state !== 'ok' && (
                <p className="ag-isec-note">
                  {budget.state === 'over'
                    ? `Over today's budget, which only warns. It stops at ${budgetWords(budget.unit, budget.ceiling)} today.`
                    : `Stopped at ${budgetWords(budget.unit, budget.ceiling)} today, ${ceilingWords()} its daily budget. It starts again at midnight.`}
                </p>
              )}
            </>
          ) : (
            <div className="pj-kv">
              <span>budget</span>
              <span>uncapped</span>
            </div>
          )}
          <div className="pj-kv">
            <span>tokens in</span>
            <span>{fmtTokens(agent.inputTokens)}</span>
          </div>
          <div className="pj-kv">
            <span>tokens out</span>
            <span>{fmtTokens(agent.outputTokens)}</span>
          </div>
          {tokens === 0 && <p className="ag-isec-note">No usage reported yet.</p>}
        </div>

        {project && (
          <div className="ag-isec">
            <span className="ui-lab">
              {project.name} notes · {project.notes?.length ?? 0}
            </span>
            <NotesPanel project={project} />
          </div>
        )}

        {todo && todo.items.length > 0 && (
          <div className="ag-isec">
            <span className="ui-lab">Todo</span>
            <ul className="ag-todo">
              {todo.items.map((it, i) => (
                <li key={`${i}-${it.text}`} className={`is-${it.state}`}>
                  {it.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {files.length > 0 && (
          <div className="ag-isec">
            <span className="ui-lab">Files touched</span>
            <div className="ag-files">
              {files.map((f) => {
                const href = links?.touched(f.path) ?? null;
                const name = f.path.split('/').at(-1);
                return (
                  <div key={f.path} title={href === null && links !== null ? `${f.path} — ${OUTSIDE}` : f.path}>
                    {href === null ? (
                      <span className="ag-files-p">{name}</span>
                    ) : (
                      <a className="ag-files-p" href={href}>
                        {name}
                      </a>
                    )}
                    <span className="ag-files-n">
                      {f.created ? <span className="ui-pos">new</span> : (
                        <DiffNums added={f.added} removed={f.removed} />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="ag-isec">
          <span className="ui-lab">Guardrails</span>
          <div className="pj-kv">
            <span>mode</span>
            <span>{autonomy.mode}</span>
          </div>
          {(['Bash', 'Write', 'WebFetch'] as const).map((tool) => {
            const p = toolPolicy(autonomy, tool);
            // Rules covering part of this tool. Shown next to the headline rather than
            // folded into it: `Bash(git push:*)` constrains one command, and letting it
            // decide the word for the whole tool is what made bash read as denied.
            const partial = scopedRules(autonomy.disallowedTools, tool);
            // And the commands it runs unasked where the tool asks: a reading role's read-only shell (Amendment 148).
            const allowedSome = p === 'asks' ? scopedRules(autonomy.allowedTools, tool) : [];
            return (
              <div className="pj-kv" key={tool}>
                <span>{tool.toLowerCase()}</span>
                <span className={`ag-policy is-${p}`}>
                  {p}
                  {allowedSome.length > 0 && (
                    <i className="ag-policy-x" title={allowedSome.join(', ')}>
                      {' '}
                      · {allowedSome.length} allowed {allowedSome.length === 1 ? 'rule' : 'rules'}
                    </i>
                  )}
                  {partial.length > 0 && (
                    <i className="ag-policy-x">
                      {' '}
                      · {partial.length} denied {partial.length === 1 ? 'rule' : 'rules'}
                    </i>
                  )}
                </span>
              </div>
            );
          })}
          {autonomy.disallowedTools.length > 0 && (
            <p className="ag-isec-note">never: {autonomy.disallowedTools.join(', ')}</p>
          )}
          {job && (
            <div className="pj-kv">
              <span>writes</span>
              <span>{job.isolation === 'in_place' ? 'repo, in place' : `${job.isolation} only`}</span>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
