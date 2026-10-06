/**
 * The Custom setup's editor (Amendment 50): add agents, name each one's role, say what
 * it does and which ones it waits for, and save the whole setup under a name.
 *
 * Models aren't set here. Each row of the plan preview below already has its own model
 * picker (Amendment 41), and a custom setup is shown there like any preset.
 *
 * Each row can pick a persona (Amendment 68). Picking one names the row after it, unless
 * the row was already named something of its own, and its brief shows as the row's
 * placeholder: typing one overrides it for this launch. A persona's model reaches the row's
 * picker in the plan preview, where it can be changed like any other.
 */

import { useState } from 'react';
import type { AgentRole } from '@conductor/shared';
import { KNOWN_ROLES, customProblems, nextRole, removeRole, renameRole, roleFromName, rowPersona, type CustomRole } from './custom.js';
import { personaFor, type Persona } from './personas.js';

const BRIEF_HINT = 'What this agent does, on top of the prompt above. Optional.';

export function CustomSetup({
  roles,
  onChange,
  name,
  onName,
  onSave,
  saved,
  personas,
}: {
  roles: CustomRole[];
  onChange: (roles: CustomRole[]) => void;
  name: string;
  onName: (name: string) => void;
  onSave: () => void;
  /** Whether a setup of this name is already saved: saving replaces it. */
  saved: boolean;
  /** Every persona, for each row's pick (Amendment 68). */
  personas: readonly Persona[];
}) {
  const problems = customProblems(roles);
  const [said, setSaid] = useState<string | null>(null);
  const set = (i: number, patch: Partial<CustomRole>): void =>
    onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  /*
   * Name the row after the persona when the row hasn't been named by hand: it's empty, it's
   * the persona it had, or it's still one of the names rows start with.
   */
  const pickPersona = (i: number, id: string): void => {
    const r = roles[i]!;
    const was = rowPersona(r, personas);
    const next = id ? personaFor(personas, id) : undefined;
    const untouched =
      r.role === '' || (was !== undefined && r.role === roleFromName(was.name)) || personas.some((p) => roleFromName(p.name) === r.role);
    const renamed = next && untouched ? renameRole(roles, i, roleFromName(next.name)) : roles;
    onChange(
      renamed.map((x, j) => {
        if (j !== i) return x;
        // "no persona" is kept as '', so the role's own name stops bringing one in.
        return { ...x, persona: id };
      }),
    );
  };
  const toggleWait = (i: number, on: AgentRole): void => {
    const r = roles[i]!;
    set(i, {
      dependsOnRoles: r.dependsOnRoles.includes(on) ? r.dependsOnRoles.filter((d) => d !== on) : [...r.dependsOnRoles, on],
    });
  };

  return (
    <div className="sp-custom">
      <datalist id="sp-known-roles">
        {KNOWN_ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {roles.map((r, i) => {
        const p = r.persona ? personaFor(personas, r.persona) : undefined;
        return (
        <div className="sp-crow" key={i}>
          <div className="sp-crow-head">
            <input
              className="sp-input sp-crole"
              value={r.role}
              list="sp-known-roles"
              spellCheck={false}
              aria-label={`Agent ${i + 1}'s role`}
              onChange={(e) => onChange(renameRole(roles, i, e.target.value.trim().toLowerCase()))}
            />
            <select
              className="ui-select sp-cpersona"
              // What applies, not only what was picked: a row named developer runs as developer.
              value={rowPersona(r, personas)?.id ?? ''}
              aria-label={`Agent ${i + 1}'s persona`}
              title="What this agent is: its brief, system prompt, model, tool rules and skills. Settings → Personas edits them."
              onChange={(e) => pickPersona(i, e.target.value)}
            >
              <option value="">no persona</option>
              {personas.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
              {/* Deleted since the setup was saved: said so, rather than shown as none. */}
              {r.persona && !p && <option value={r.persona}>{r.persona} · deleted</option>}
            </select>
            {i > 0 && (
              <span className="sp-cwaits">
                waits for
                {roles.slice(0, i).map((above) => (
                  <label key={above.role} className="sp-cwait">
                    <input
                      type="checkbox"
                      checked={r.dependsOnRoles.includes(above.role)}
                      onChange={() => toggleWait(i, above.role)}
                    />
                    {above.role}
                  </label>
                ))}
              </span>
            )}
            <button
              type="button"
              className="sp-ghost"
              aria-label={`Remove ${r.role}`}
              disabled={roles.length === 1}
              onClick={() => onChange(removeRole(roles, i))}
            >
              ✕
            </button>
          </div>
          {p?.description && <div className="sp-cpersona-says">{p.description}</div>}
          <textarea
            className="sp-input sp-cbrief"
            rows={2}
            value={r.brief}
            placeholder={p?.brief ? p.brief : BRIEF_HINT}
            title={p?.brief ? `${p.name}'s brief. Type here to use your own for this launch.` : undefined}
            onChange={(e) => set(i, { brief: e.target.value })}
          />
        </div>
        );
      })}
      <button
        type="button"
        className="sp-addproj"
        onClick={() => onChange([...roles, { role: nextRole(roles), brief: '', dependsOnRoles: [] }])}
      >
        + add an agent
      </button>
      {problems.map((p) => (
        <div key={p} className="sp-cf-note t-fail is-still">
          {p}
        </div>
      ))}
      <div className="sp-csave">
        <input
          className="sp-input"
          value={name}
          spellCheck={false}
          placeholder="name it to save it — optional"
          onChange={(e) => {
            onName(e.target.value);
            setSaid(null);
          }}
        />
        <button
          type="button"
          className="sp-ghost"
          disabled={!name.trim() || problems.length > 0}
          onClick={() => {
            onSave();
            setSaid(saved ? `Replaced "${name.trim()}".` : `Saved "${name.trim()}". It's beside the presets now.`);
          }}
        >
          {saved ? 'save over it' : 'save'}
        </button>
        {said && <span className="sp-csaid">{said}</span>}
      </div>
    </div>
  );
}
