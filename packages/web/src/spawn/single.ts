/**
 * What kind of agent the preset "one agent" launches (Amendment 179): a role and a persona,
 * picked in its row of the plan with the `RoleRow` Custom setup and a job's "+ agent" use, and
 * remembered per project as a setting. The first time for a project it is a developer, as the
 * preset has always been. Pure, so spawn/verify.ts checks it under Node.
 *
 * Only the role and persona change. The model tier, `does` and the empty brief stay the
 * preset's: the prompt is what one agent is told, and its row's model picker is where its model
 * changes. So the persona brings its system prompt and skills, as the developer always did, and a
 * reading role or persona is pinned read-only by `rowAutonomy`, as anywhere else.
 */

import type { AgentRole } from '@conductor/shared';
import { customProblems, type CustomRole } from './custom.js';
import { personaFor, renamedPersona, type Persona } from './personas.js';
import { presetById, type Preset } from './presets.js';

export const SINGLE_ID = 'single';

/** The setting that holds a project's last pick for one agent. */
export const singleKey = (projectId: string): string => `conductor.launch.single.${projectId}`;

export interface SinglePick {
  role: AgentRole;
  /** As a Custom row has it: absent is the persona of the role's name, `''` none, chosen. */
  persona?: string;
}

/** The preset's own: a developer, running as the developer persona. */
export const DEFAULT_SINGLE: SinglePick = { role: 'developer' };

/** What's wrong with a pick, one sentence each; empty when it can launch. Custom's rules for one row. */
export function singleProblems(pick: SinglePick): string[] {
  return customProblems([asRow(pick)]);
}

/**
 * A project's pick, from its setting. Nothing stored, anything malformed, or a persona that no
 * longer exists is the default; a persona since renamed (`renamedPersona`) is read as its successor.
 */
export function parseSingle(raw: string | null, personas: readonly Persona[]): SinglePick {
  if (!raw) return DEFAULT_SINGLE;
  try {
    const x = JSON.parse(raw) as Partial<SinglePick> | null;
    if (typeof x?.role !== 'string') return DEFAULT_SINGLE;
    const persona = typeof x.persona === 'string' ? renamedPersona(x.persona) : undefined;
    const pick: SinglePick =
      persona !== undefined
        ? { role: x.role, persona }
        : renamedPersona(x.role) !== x.role
          ? { role: x.role, persona: renamedPersona(x.role) }
          : { role: x.role };
    if (singleProblems(pick).length > 0) return DEFAULT_SINGLE;
    // A persona picked by id and deleted since: back to the developer, not to no persona.
    if (pick.persona && !personaFor(personas, pick.persona)) return DEFAULT_SINGLE;
    return pick;
  } catch {
    return DEFAULT_SINGLE;
  }
}

/**
 * The setting that says `pick`: null for the default, so a project back on a developer keeps none.
 * A persona picked by the role's own name is the same as none picked.
 */
export function singleSetting(pick: SinglePick): string | null {
  if (pick.role === DEFAULT_SINGLE.role && (pick.persona === undefined || pick.persona === pick.role)) return null;
  return JSON.stringify(pick);
}

/** The preset "one agent", its row the role and persona picked. The default is the preset as it is. */
export function singlePreset(pick: SinglePick): Preset {
  const base = presetById(SINGLE_ID);
  const row = base.roles[0]!;
  return { ...base, roles: [{ ...row, role: pick.role, ...(pick.persona !== undefined ? { persona: pick.persona } : {}) }] };
}

/** The pick as a Custom row, for the rules and helpers the two share. */
export function asRow(pick: SinglePick): CustomRole {
  return { role: pick.role, brief: '', dependsOnRoles: [], ...(pick.persona !== undefined ? { persona: pick.persona } : {}) };
}
