/**
 * "+ agent": one more agent in a job that is running or finished (ADR 0002, Amendment 89).
 *
 * The row is Spawn's Custom setup row (`RoleRow`): role, persona, brief and who it waits for,
 * here limited to this job's agents. Under it, what the job decides elsewhere: which agents
 * that haven't started should wait for it too ("also feeds"), its model, and its cap. Its
 * permissions are the job's own, taken from a sibling (`addedAutonomy`), so there are no pills
 * to set again; the inspector changes them afterwards, as for any agent.
 *
 * Shown by the job's group on the Project screen. Escape closes it.
 */

import { useMemo, useState } from 'react';
import type { Agent, AgentRole, Job, ModelTier } from '@conductor/shared';
import { useCommand } from '../agent/endpoints.js';
import { resolveTier, useModels } from '../lib/models.js';
import { CLAUDE, capabilitiesOf, providerLabel, useProviderModels, useProviders } from '../lib/providers.js';
import { useSetting } from '../lib/settings.js';
import { ModelSelect } from '../shell/ui.js';
import { KNOWN_ROLES, nextRole, roleFromName, rowPersona, untouchedRole } from './custom.js';
import { addAgent } from './endpoints.js';
import { PERSONAS_KEY, personaFor, personasFrom } from './personas.js';
import { RoleRow } from './RoleRow.js';
import {
  addAgentProblems,
  addAgentSpec,
  budgetDefault,
  feedOptions,
  jobEngine,
  templateFor,
  waitOptions,
  type AddDraft,
} from './stack.js';
import './spawn.css';

const TIERS: readonly string[] = ['opus', 'sonnet', 'haiku'] satisfies ModelTier[];

export function AddAgent({ job, agents, onClose }: { job: Job; agents: readonly Agent[]; onClose: () => void }) {
  const personasRaw = useSetting(PERSONAS_KEY);
  const personas = useMemo(() => personasFrom(personasRaw), [personasRaw]);
  const engine = jobEngine(agents);
  const claude = engine === CLAUDE;
  const usd = capabilitiesOf(engine, useProviders()).costUsd;
  const models = useModels();
  const theirs = useProviderModels(claude ? null : engine);
  const cmd = useCommand();

  const [draft, setDraft] = useState<AddDraft>(() => {
    const role = nextRole(agents.map((a) => ({ role: a.role, brief: '', dependsOnRoles: [] })));
    return { role, brief: '', dependsOnRoles: [], feeds: [], model: templateFor(agents, role)?.model ?? '', budget: budgetDefault(agents, role, usd) };
  });
  const set = (patch: Partial<AddDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const toggle = (list: AgentRole[], role: AgentRole): AgentRole[] =>
    list.includes(role) ? list.filter((r) => r !== role) : [...list, role];

  const shown = rowPersona({ role: draft.role, brief: draft.brief, dependsOnRoles: [], ...(draft.persona !== undefined ? { persona: draft.persona } : {}) }, personas);
  const problems = addAgentProblems(draft, agents, usd);
  const feeds = feedOptions(agents);

  /** As on Custom: a row not named by hand takes the persona's name, and on Claude its model. */
  const pickPersona = (id: string): void => {
    const next = id ? personaFor(personas, id) : undefined;
    const role = next && untouchedRole(draft.role, shown, personas) ? roleFromName(next.name) : draft.role;
    const tier = next?.model ?? '';
    const model = claude && tier ? (TIERS.includes(tier) ? resolveTier(models.catalog, tier as ModelTier) : tier) : null;
    set({ persona: id, role, ...(model ? { model } : {}) });
  };

  const submit = (): void => {
    if (problems.length > 0 || cmd.busy) return;
    void cmd
      .run('Adding the agent', () => addAgent(job.id, addAgentSpec(draft, agents, shown, usd)), (r) => `Added ${r.agent.role}.`)
      .then((ok) => {
        if (ok) onClose();
      });
  };

  return (
    <div
      className="pj-add"
      role="group"
      aria-label="Add an agent to this job"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <datalist id={`pj-roles-${job.id}`}>
        {KNOWN_ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <RoleRow
        label="The new agent"
        role={draft.role}
        persona={draft.persona}
        shownPersona={shown}
        brief={draft.brief}
        personas={personas}
        rolesList={`pj-roles-${job.id}`}
        waitOptions={waitOptions(agents).map((a) => a.role)}
        waits={draft.dependsOnRoles}
        onRole={(role) => set({ role })}
        onPersona={pickPersona}
        onToggleWait={(r) => set({ dependsOnRoles: toggle(draft.dependsOnRoles, r) })}
        onBrief={(brief) => set({ brief })}
      >
        <div className="pj-add-more">
          {feeds.length > 0 && (
            <span className="sp-cwaits" title="Agents that haven't started yet, which should wait for this one too">
              also feeds
              {feeds.map((a) => (
                <label key={a.id} className="sp-cwait">
                  <input type="checkbox" checked={draft.feeds.includes(a.role)} onChange={() => set({ feeds: toggle(draft.feeds, a.role) })} />
                  {a.role}
                </label>
              ))}
            </span>
          )}
          <span className="pj-add-field">
            <span className="ui-lab">model</span>
            {claude ? (
              <ModelSelect
                catalog={models.catalog}
                value={draft.model}
                onChange={(model) => set({ model })}
                onRefresh={models.refresh}
                loading={models.loading}
                title={draft.model}
              />
            ) : (
              <>
                <input
                  className="sp-input pj-add-model"
                  list={`pj-models-${job.id}`}
                  value={draft.model}
                  spellCheck={false}
                  aria-label={`Model id on ${providerLabel(engine)}`}
                  onChange={(e) => set({ model: e.target.value })}
                />
                <datalist id={`pj-models-${job.id}`}>
                  {(theirs.list?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </>
            )}
          </span>
          <span className="pj-add-field">
            <span className="ui-lab">{usd ? 'budget $' : 'budget, tokens'}</span>
            <input
              className="sp-input pj-add-budget"
              value={draft.budget}
              inputMode={usd ? 'decimal' : 'text'}
              aria-label={usd ? 'Its budget, in dollars' : 'Its budget, in tokens'}
              onChange={(e) => set({ budget: e.target.value })}
            />
          </span>
        </div>
      </RoleRow>
      {problems.map((p) => (
        <div key={p} className="sp-cf-note t-fail is-still">
          {p}
        </div>
      ))}
      <div className="pj-add-actions">
        <button type="button" className="fl-btn" disabled={problems.length > 0 || cmd.busy} onClick={submit}>
          {cmd.busy ? 'adding…' : `+ add ${draft.role || 'agent'}`}
        </button>
        <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={onClose}>
          cancel
        </button>
        <span className="pj-add-note">
          Runs on {providerLabel(engine)} with this job's permissions; the job's cap grows by its budget.
        </span>
      </div>
      {cmd.notice && cmd.notice.tone !== 'ok' && (
        <div className={`pj-notice t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}
