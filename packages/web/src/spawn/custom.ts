/**
 * Custom setups: agents you add yourself (Amendment 50). Pure, so spawn/verify.ts checks
 * the rules under Node.
 *
 * A custom setup is a list of roles, each with a brief and the roles it waits for, turned
 * into a `Preset` so everything after — the plan preview, the per-row model pickers,
 * `toAgentSpecs` — is what the built-in presets already use. A setup can be named and
 * saved; saved ones are the `conductor.setups` setting, which the daemon keeps
 * (Amendment 46), so every tab and every start sees them.
 *
 * A row can pick a persona (Amendment 68), kept by id — in a saved setup too, so editing
 * the persona changes the setup. It fills in the row's role name, brief and model; the row
 * overrides the brief by typing one, and the model with the plan preview's picker, for that
 * launch only. The role name stays free, so two rows can share a persona.
 */

import type { AgentRole, ModelTier } from '@conductor/shared';
import type { Preset, PresetRole, RoleModels } from './presets.js';
import { personaFor, renamedPersona, type Persona } from './personas.js';

export interface CustomRole {
  role: AgentRole;
  brief: string;
  dependsOnRoles: AgentRole[];
  /**
   * The persona's id (Amendment 68). Absent: the persona of the same name as the role, if
   * there is one. `''`: none, chosen — so a row called developer can be plain.
   */
  persona?: string;
}

export interface SavedSetup {
  name: string;
  roles: CustomRole[];
  /** Exact model ids picked per role when it was saved. */
  models: RoleModels;
}

export const SETUPS_KEY = 'conductor.setups';
export const CUSTOM_ID = 'custom';
const SAVED_PREFIX = 'saved:';
const ROLE = /^[a-z][a-z0-9-]{0,30}$/;

/** The roles a new row can pick from; any name matching ROLE also works. */
export const KNOWN_ROLES: AgentRole[] = ['developer', 'validator', 'reviewer', 'scribe', 'debugger', 'analyst', 'architect'];

export const FIRST_ROLE: CustomRole = { role: 'developer', brief: '', dependsOnRoles: [] };

export const savedId = (name: string): string => `${SAVED_PREFIX}${name}`;
export const isSavedId = (id: string): boolean => id.startsWith(SAVED_PREFIX);

/** A new row's role: the first known one not taken yet, else `agent-N`. */
export function nextRole(roles: CustomRole[]): AgentRole {
  const taken = new Set(roles.map((r) => r.role));
  return KNOWN_ROLES.find((r) => !taken.has(r)) ?? `agent-${roles.length + 1}`;
}

/**
 * The setup with a new row at the end. It waits for the row above it, which is where a
 * row waits by default; untick it for one that starts with the first (Amendment 99).
 */
export function addRow(roles: CustomRole[]): CustomRole[] {
  const last = roles.at(-1);
  return [...roles, { role: nextRole(roles), brief: '', dependsOnRoles: last ? [last.role] : [] }];
}

/** What's wrong with a setup, one sentence each; empty when it can launch. */
export function customProblems(roles: CustomRole[]): string[] {
  const out: string[] = [];
  if (roles.length === 0) out.push('Add at least one agent.');
  const seen = new Set<string>();
  roles.forEach((r, i) => {
    if (!ROLE.test(r.role)) out.push(`Agent ${i + 1}: a role is lowercase letters, digits and dashes, starting with a letter.`);
    else if (seen.has(r.role)) out.push(`"${r.role}" is there twice. Each role once — name them apart, like builder-api and builder-ui.`);
    seen.add(r.role);
    for (const d of r.dependsOnRoles) {
      if (!roles.slice(0, i).some((x) => x.role === d)) out.push(`${r.role} waits for "${d}", which isn't above it.`);
    }
  });
  return out;
}

/** Drop a row, and any wait on it. */
export function removeRole(roles: CustomRole[], i: number): CustomRole[] {
  const gone = roles[i]?.role;
  return roles
    .filter((_, j) => j !== i)
    .map((r) => ({ ...r, dependsOnRoles: r.dependsOnRoles.filter((d) => d !== gone) }));
}

/** Rename a row, and every wait on it with it. */
export function renameRole(roles: CustomRole[], i: number, name: string): CustomRole[] {
  const was = roles[i]?.role;
  return roles.map((r, j) =>
    j === i ? { ...r, role: name } : { ...r, dependsOnRoles: r.dependsOnRoles.map((d) => (d === was ? name : d)) },
  );
}

const TIERS: readonly string[] = ['opus', 'sonnet', 'haiku'] satisfies ModelTier[];

/**
 * The persona a row runs as: the one it picked, else the one named like its role, else
 * none — and none when it chose none. What the row's picker shows, and what the launch
 * uses, so the two can't disagree. (Amendment 68)
 */
export function rowPersona(r: CustomRole, personas: readonly Persona[]): Persona | undefined {
  if (r.persona === '') return undefined;
  return personaFor(personas, r.persona ?? r.role);
}

/**
 * A custom setup as a preset. Its tier is sonnet; a row's model picker picks the exact id.
 *
 * A row with a persona (Amendment 68) takes the persona's brief unless it typed its own,
 * and the persona's tier when its model is one; an exact id comes from `personaPicks`.
 */
export function toPreset(id: string, label: string, roles: CustomRole[], personas: readonly Persona[] = []): Preset {
  return {
    id,
    label,
    roles: roles.map((r): PresetRole => {
      const p = rowPersona(r, personas);
      const brief = r.brief.trim() || p?.brief.trim() || '';
      return {
        role: r.role,
        model: p && TIERS.includes(p.model) ? (p.model as ModelTier) : 'sonnet',
        does: r.brief.trim()
          ? shorten(r.brief.trim(), 60)
          : p?.description.trim()
            ? shorten(p.description.trim(), 60)
            : brief
              ? shorten(brief, 60)
              : 'does what the prompt says',
        brief,
        ...(r.dependsOnRoles.length > 0 ? { dependsOnRoles: r.dependsOnRoles } : {}),
        // Explicit, so the launch uses the same persona the row shows: none stays none.
        persona: rowPersona(r, personas)?.id ?? '',
      };
    }),
  };
}

/**
 * The exact model ids rows get from their personas (Amendment 68): a persona whose model
 * is an id rather than a tier. Spawn puts the row's own pick over it, so a row can still
 * change it for this launch.
 */
export function personaPicks(roles: CustomRole[], personas: readonly Persona[]): RoleModels {
  const out: RoleModels = {};
  for (const r of roles) {
    const m = rowPersona(r, personas)?.model ?? '';
    if (m && !TIERS.includes(m)) out[r.role] = m;
  }
  return out;
}

/**
 * Whether a row's role is still one it was given rather than typed: empty, the name of the
 * persona it had, or the name of any persona. Picking a persona renames such a row after
 * it (Amendment 68) — on Spawn's Custom setup and in a job's "+ agent" (Amendment 89).
 */
export function untouchedRole(role: AgentRole, was: Persona | undefined, personas: readonly Persona[]): boolean {
  return role === '' || (was !== undefined && role === roleFromName(was.name)) || personas.some((p) => roleFromName(p.name) === role);
}

/** A persona's name as a role: lowercase, dashes for anything else (Amendment 68). */
export function roleFromName(name: string): AgentRole {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  return slug.slice(0, 31) || 'agent';
}

function shorten(s: string, n: number): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

/** The saved setups, from the setting. Anything malformed is left out, not fatal. */
export function parseSetups(raw: string | null): SavedSetup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SavedSetup[] = [];
    for (const x of parsed) {
      const s = x as Partial<SavedSetup>;
      if (typeof s?.name !== 'string' || !s.name.trim() || !Array.isArray(s.roles)) continue;
      const roles = s.roles
        .filter((r): r is CustomRole => typeof r?.role === 'string')
        .map((r) => ({
          role: r.role,
          brief: typeof r.brief === 'string' ? r.brief : '',
          dependsOnRoles: Array.isArray(r.dependsOnRoles) ? r.dependsOnRoles.filter((d): d is string => typeof d === 'string') : [],
          // By id, so the persona as it is now is what the setup gets (Amendment 68).
          ...setupPersona(r),
        }));
      if (customProblems(roles).length > 0) continue;
      const models: RoleModels = {};
      if (s.models && typeof s.models === 'object') {
        for (const [k, v] of Object.entries(s.models)) if (typeof v === 'string') models[k] = v;
      }
      if (!out.some((o) => o.name === s.name)) out.push({ name: s.name.trim(), roles, models });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A saved row's persona, after Amendment 84 removed the builder and documenter built-ins.
 * A row that picked one, or was named for one and picked nothing, now runs as developer or
 * scribe. Its role name stays, so what waits on it still does. Anything else is as saved.
 */
function setupPersona(r: CustomRole): { persona?: string } {
  if (typeof r.persona === 'string') return { persona: renamedPersona(r.persona) };
  const to = renamedPersona(r.role);
  return to !== r.role ? { persona: to } : {};
}

/** The setting after saving `setup` — replacing one of the same name. */
export function withSetup(saved: SavedSetup[], setup: SavedSetup): string {
  return JSON.stringify([...saved.filter((s) => s.name !== setup.name), setup]);
}

/** The setting after forgetting one, or null when none are left. */
export function withoutSetup(saved: SavedSetup[], name: string): string | null {
  const rest = saved.filter((s) => s.name !== name);
  return rest.length > 0 ? JSON.stringify(rest) : null;
}
