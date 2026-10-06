/**
 * One agent's row: its role, its persona, who it waits for, and its brief. Spawn's Custom
 * setup is a list of these (Amendment 50), and a job's "+ agent" is one more (Amendment 89),
 * so the two can't drift into two editors that ask the same thing differently.
 *
 * The row only reports what was changed. What a change means for the others — renaming the
 * waits on a renamed role, naming a row after its persona — is the caller's, since only the
 * caller knows the other rows.
 */

import type { ReactNode } from 'react';
import type { AgentRole } from '@conductor/shared';
import { personaFor, type Persona } from './personas.js';

const BRIEF_HINT = 'What this agent does, on top of the prompt above. Optional.';

export function RoleRow({
  label,
  role,
  persona,
  shownPersona,
  brief,
  personas,
  rolesList,
  waitLabel = 'waits for',
  waitOptions,
  waits,
  onRole,
  onPersona,
  onToggleWait,
  onBrief,
  onRemove,
  removeDisabled = false,
  children,
}: {
  /** "Agent 2", for the screen reader's names of its fields. */
  label: string;
  role: AgentRole;
  /** The id it picked: `''` is none, chosen; absent is the persona of its role's name. */
  persona: string | undefined;
  /** The persona that applies, which the picker shows: a row named developer runs as developer. */
  shownPersona: Persona | undefined;
  brief: string;
  personas: readonly Persona[];
  /** The id of a `<datalist>` of role names, which the caller renders once. */
  rolesList: string;
  waitLabel?: string;
  /** The roles it may wait for. None: the "waits for" part isn't shown. */
  waitOptions: readonly AgentRole[];
  waits: readonly AgentRole[];
  onRole: (role: AgentRole) => void;
  onPersona: (id: string) => void;
  onToggleWait: (role: AgentRole) => void;
  onBrief: (brief: string) => void;
  /** Absent: no ✕ on the row. */
  onRemove?: () => void;
  removeDisabled?: boolean;
  /** More of the row, under the brief: a job's "+ agent" adds its feeds, model and cap. */
  children?: ReactNode;
}) {
  const p = persona ? personaFor(personas, persona) : undefined;
  return (
    <div className="sp-crow">
      <div className="sp-crow-head">
        <input
          className="sp-input sp-crole"
          value={role}
          list={rolesList}
          spellCheck={false}
          aria-label={`${label}'s role`}
          onChange={(e) => onRole(e.target.value.trim().toLowerCase())}
        />
        <select
          className="ui-select sp-cpersona"
          value={shownPersona?.id ?? ''}
          aria-label={`${label}'s persona`}
          title="What this agent is: its brief, system prompt, model, tool rules and skills. Settings → Personas edits them."
          onChange={(e) => onPersona(e.target.value)}
        >
          <option value="">no persona</option>
          {personas.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          {/* Deleted since the setup was saved: said so, rather than shown as none. */}
          {persona && !p && <option value={persona}>{persona} · deleted</option>}
        </select>
        {waitOptions.length > 0 && (
          <span className="sp-cwaits">
            {waitLabel}
            {waitOptions.map((above) => (
              <label key={above} className="sp-cwait">
                <input type="checkbox" checked={waits.includes(above)} onChange={() => onToggleWait(above)} />
                {above}
              </label>
            ))}
          </span>
        )}
        {onRemove && (
          <button type="button" className="sp-ghost" aria-label={`Remove ${role}`} disabled={removeDisabled} onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      {p?.description && <div className="sp-cpersona-says">{p.description}</div>}
      <textarea
        className="sp-input sp-cbrief"
        rows={2}
        value={brief}
        aria-label={`${label}'s brief`}
        placeholder={p?.brief ? p.brief : BRIEF_HINT}
        title={p?.brief ? `${p.name}'s brief. Type here to use your own for this launch.` : undefined}
        onChange={(e) => onBrief(e.target.value)}
      />
      {children}
    </div>
  );
}
