/**
 * The Custom setup's editor (Amendment 50): add agents, name each one's role, say what
 * it does and which ones it waits for, and save the whole setup under a name.
 *
 * Models aren't set here. Each row of the plan preview below already has its own model
 * picker (Amendment 41), and a custom setup is shown there like any preset.
 *
 * Each row is a `RoleRow`, the same one a job's "+ agent" uses (Amendment 89).
 *
 * A row moves with its ↑ ↓ buttons or by dragging its grip (Amendment 99). Its place sets
 * which rows it may wait for, and a new row waits for the one above it. Moving a row keeps
 * the ticks that still point above it and drops the rest (`moveRow`).
 *
 * Each row can pick a persona (Amendment 68). Picking one names the row after it, unless
 * the row was already named something of its own, and its brief shows as the row's
 * placeholder: typing one overrides it for this launch. A persona's model reaches the row's
 * picker in the plan preview, where it can be changed like any other.
 */

import { useState } from 'react';
import { KNOWN_ROLES, addRow, customProblems, removeRole, renameRole, roleFromName, rowPersona, untouchedRole, type CustomRole } from './custom.js';
import { moveRow, toggleWait } from './order.js';
import { personaFor, type Persona } from './personas.js';
import { useReorder } from './reorder.js';
import { RoleRow } from './RoleRow.js';

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
    const untouched = untouchedRole(r.role, was, personas);
    const renamed = next && untouched ? renameRole(roles, i, roleFromName(next.name)) : roles;
    onChange(
      renamed.map((x, j) => {
        if (j !== i) return x;
        // "no persona" is kept as '', so the role's own name stops bringing one in.
        return { ...x, persona: id };
      }),
    );
  };
  const reorder = useReorder((from, to) => onChange(moveRow(roles, from, to)), roles.length);

  return (
    <div className="sp-custom" ref={reorder.rootRef} {...reorder.rootProps}>
      <datalist id="sp-known-roles">
        {KNOWN_ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {roles.map((r, i) => (
        <div key={i} className={`sp-reorder${reorder.markOf(i)}`} {...reorder.rowProps(i)}>
          <RoleRow
            label={`Agent ${i + 1}`}
            lead={roles.length > 1 ? reorder.handle(i, r.role || `agent ${i + 1}`) : undefined}
            role={r.role}
            persona={r.persona}
            shownPersona={rowPersona(r, personas)}
            brief={r.brief}
            personas={personas}
            rolesList="sp-known-roles"
            waitOptions={roles.slice(0, i).map((above) => above.role)}
            waits={r.dependsOnRoles}
            onRole={(name) => onChange(renameRole(roles, i, name))}
            onPersona={(id) => pickPersona(i, id)}
            onToggleWait={(on) => onChange(toggleWait(roles, i, on))}
            onBrief={(brief) => set(i, { brief })}
            onRemove={() => onChange(removeRole(roles, i))}
            removeDisabled={roles.length === 1}
          />
        </div>
      ))}
      <button
        type="button"
        className="sp-addproj"
        onClick={() => onChange(addRow(roles))}
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
