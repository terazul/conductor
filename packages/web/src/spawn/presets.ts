/**
 * Agent presets — screen 7, section 4 ("who works on it").
 *
 * The mockup's promise is that you see the agent plan, including what runs in
 * parallel and what waits, BEFORE launching. `dependsOnRoles` is what encodes
 * that: an empty list means "starts now", a populated one means "waits".
 *
 * A role names a model TIER ('opus', 'sonnet') rather than an id, because ids differ
 * across API, Bedrock and gateway deployments. The tier is resolved to the exact id the
 * model API serves at launch (lib/models.ts), and the agent keeps that id. (Amendment 40)
 */

import type { AgentSpec, AgentRole, Autonomy, EffortLevel, ModelCatalog, ModelTier } from '@conductor/shared';
import { WRITE_TOOLS, isReadOnlyRole } from '@conductor/shared';
import { toAutonomy, type PillState } from './autonomy.js';
import { personaFor, pillsWith, type Persona } from './personas.js';

/**
 * What each tier is for — the plan preview says it beside the id the tier resolves to.
 *
 * The presets assign a tier PER ROLE on purpose — a reviewer that judges wants the
 * strongest reasoning, a scribe updating a plan does not — and that stays the default.
 * Spawn lets you replace it per row, or for every row at once. (Amendment 41)
 */
export const TIER_HINTS: Record<ModelTier, string> = {
  opus: 'Strongest reasoning. What the presets give to roles that design or judge.',
  sonnet: 'Fast and capable. What the presets give to roles executing a decided plan.',
  haiku: 'Cheapest and fastest. Suited to mechanical work, not to judgement.',
};

export interface PresetRole {
  role: AgentRole;
  model: ModelTier;
  /** What this agent is for — shown in the plan preview. */
  does: string;
  brief: string;
  dependsOnRoles?: AgentRole[];
  /** The persona's id, when it isn't the role's own — a Custom row's pick (Amendment 68). */
  persona?: string;
}

export interface Preset {
  id: string;
  label: string;
  roles: PresetRole[];
}

export const PRESETS: Preset[] = [
  {
    id: 'full',
    label: 'full build pipeline',
    roles: [
      {
        role: 'architect',
        model: 'opus',
        does: 'designs it and writes the plan',
        brief:
          'Before any code is written, design how to do the work above: read the code it touches, ' +
          'weigh the options, pick one and write the plan and an ADR. Change no source code.',
      },
      {
        role: 'developer',
        model: 'sonnet',
        does: 'implements the plan',
        brief:
          "Implement the work described above, following the architect's plan. Prefer small, reviewable changes.",
        dependsOnRoles: ['architect'],
      },
      {
        role: 'validator',
        model: 'sonnet',
        does: 'tests what was built',
        brief:
          "Write tests for the behaviour described above and in the architect's plan, run them " +
          'against what the developer built, and report what fails.',
        dependsOnRoles: ['developer'],
      },
      {
        role: 'reviewer',
        model: 'opus',
        does: 'spec + quality review',
        brief:
          "Review the change against the instruction and against the architect's plan for correctness " +
          'and quality. Report findings; do not rewrite.',
        dependsOnRoles: ['architect', 'developer', 'validator'],
      },
      {
        role: 'scribe',
        model: 'sonnet',
        does: 'updates PLAN.md and ADR',
        brief: 'Update the plan and any decision record to match what was actually done.',
        dependsOnRoles: ['architect', 'reviewer'],
      },
    ],
  },
  {
    id: 'bugfix',
    label: 'bug fix',
    roles: [
      {
        role: 'debugger',
        model: 'opus',
        does: 'finds the root cause',
        brief:
          'Find the root cause before proposing any fix. Report the cause with file and line evidence.',
      },
      {
        role: 'developer',
        model: 'sonnet',
        does: 'fixes at the source',
        brief: 'Fix the root cause the debugger identified. Add a regression test.',
        dependsOnRoles: ['debugger'],
      },
    ],
  },
  {
    id: 'review',
    label: 'review only',
    roles: [
      {
        role: 'reviewer',
        model: 'opus',
        does: 'reads and reports, writes nothing',
        brief: 'Review only. Report findings with file and line references. Change no files.',
      },
    ],
  },
  /*
   * Analysis is NOT review with a different word on it. A reviewer judges a change
   * and answers "is this right"; there is a diff, and the output is findings. An
   * analyst is pointed at code nobody has read yet and answers "how does this
   * work" — no diff, and the output is a map.
   *
   * The map used to end in the transcript, beside an auditor reading in parallel.
   * Now a scribe waits for it and writes it into the project's docs, because a map
   * nobody can find after the job is closed was read once. (Amendment 41; the scribe
   * took over from the documenter in Amendment 84.) So the analyst still writes
   * nothing, and the scribe writes — docs only. That limit is its brief, not its
   * tools: a doc is a file like any other, and there is no tool that can write
   * README.md but not index.ts. The diff is where to check it.
   */
  {
    id: 'analysis',
    label: 'analysis',
    roles: [
      {
        role: 'analyst',
        model: 'opus',
        does: 'maps the codebase and explains it',
        brief:
          'Explain how this code works: entry points, module boundaries, data flow, and the ' +
          'decisions already encoded in it. Cite file and line for every claim — a summary ' +
          'nobody can check is worth nothing. Change no files; the report is the deliverable.',
      },
      {
        role: 'scribe',
        model: 'sonnet',
        does: 'writes the analysis into the docs',
        brief:
          "Update this project's documentation to match what the analyst reported: the " +
          'README, docs/, and any architecture or decision records. Correct what is wrong, ' +
          'add what is missing, and keep the file and line citations so every claim can be ' +
          'checked against the code. Where the report and the code disagree, the code wins — ' +
          'read it. Change documentation only: no source, tests or configuration.',
        dependsOnRoles: ['analyst'],
      },
    ],
  },
  /*
   * Analysis Only: the analyst maps the code and a scribe keeps the result. Unlike
   * 'analysis', which has its scribe rewrite the project's docs, the scribe here only
   * records the findings as a plan or decision record would be kept (TODO, 2 Oct).
   */
  {
    id: 'analysis-only',
    label: 'Analysis Only',
    roles: [
      {
        role: 'analyst',
        model: 'opus',
        does: 'maps the codebase and explains it',
        brief:
          'Explain how this code works: entry points, module boundaries, data flow, and the ' +
          'decisions already encoded in it. Cite file and line for every claim. Change no ' +
          'files; the report is the deliverable.',
      },
      {
        role: 'scribe',
        model: 'sonnet',
        does: 'writes the findings down',
        brief:
          "Write up what the analyst reported as a short, dated note in the project's plan or docs, " +
          'keeping its file and line citations. Change documentation only: no source, tests or configuration.',
        dependsOnRoles: ['analyst'],
      },
    ],
  },
  {
    id: 'single',
    label: 'one agent',
    roles: [
      {
        role: 'developer',
        model: 'sonnet',
        does: 'does the work',
        brief: '',
      },
    ],
  },
];

export const DEFAULT_PRESET = 'full';

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

/** "starts now" / "after developer" — the mockup's right-hand column. */
export function startsWhen(role: PresetRole): string {
  const deps = role.dependsOnRoles ?? [];
  if (deps.length === 0) return 'starts now';
  if (deps.length === 1) return `after ${deps[0]}`;
  return `after ${deps.slice(0, -1).join(', ')} and ${deps.at(-1)}`;
}

/**
 * Roles whose entire job is to read. The list is `READ_ONLY_ROLES` in shared/src/stack.ts
 * since Amendment 89, so the daemon checks an added agent against the same one; every new
 * reading role belongs there. Re-exported so the plan preview and its checks keep their
 * import.
 */
export { isReadOnlyRole };

/** The persona a role takes: the one it picked, else the one of its role's name (Amendment 68). */
export function personaOf(r: PresetRole, personas?: readonly Persona[]): Persona | undefined {
  // `''` is none, chosen (a Custom row's "no persona"); absent is the role's own.
  if (!personas || r.persona === '') return undefined;
  return personaFor(personas, r.persona ?? r.role);
}

/**
 * Whether this row writes nothing: a reading role, or a reading persona (Amendment 68).
 * A persona can make a role read-only; it cannot make a reading role write.
 */
export function readsOnly(r: PresetRole, personas?: readonly Persona[]): boolean {
  return isReadOnlyRole(r.role) || personaOf(r, personas)?.tools.write === false;
}

/*
 * The file-mutating tools, denied outright for a reading role (`WRITE_TOOLS`, shared).
 *
 * Turning off auto-accept is NOT enough on its own, and it took writing the
 * analysis preset to notice. Without `acceptEdits` a write is not forbidden, it is
 * merely *asked about* — so a preset whose label reads "writes nothing" would
 * write the moment a human clicked approve on a prompt they had no reason to
 * distrust. `disallowedTools` is the only setting that survives every permission
 * mode (docs/MANUAL.md §5), which makes it the only one that can carry a promise.
 *
 * Bash is deliberately NOT here. It is already absent from `allowedTools` for
 * these roles, so every command stops and asks, and an analyst that cannot run
 * `git log` is an analyst that cannot answer how the code got this way. The line
 * is "cannot change files unattended or otherwise", not "cannot act".
 */

/**
 * Turn the chosen preset into the AgentSpec[] the daemon takes.
 *
 * A reading role is pinned read-only regardless of the pills — in both directions:
 * nothing it does is auto-approved, and the write tools are denied outright. The
 * pills describe what the user wants for the work; they cannot promote a reviewer
 * into a writer.
 *
 * With personas (Amendment 68), each role takes its persona — the one it picked, else the
 * one of its role's name. The spec carries the persona's id, system prompt and skills; its
 * tool rules go over the pills before the read-only pin, so a persona can't undo that; and a
 * reading persona (`write: false`) is pinned as a reading role is. The brief and the model
 * tier stay the preset's. Without personas, the specs are what they always were.
 */
export function toAgentSpecs(
  preset: Preset,
  pills: PillState,
  budgetPerAgent: number | null,
  effort?: EffortLevel,
  /** The exact id picked for a role. A role with none keeps its own tier, the default. */
  picks: RoleModels = {},
  /** What each tier means now — GET /api/models. */
  tiers: ModelCatalog['tiers'] = {},
  /** Per role, how many helpers it may start; absent or 0 is an ordinary agent (Amendment 51). */
  helpers: Partial<Record<AgentRole, number>> = {},
  /** The launch's mode (Amendment 65). A reading role takes it only if it is plan; else it asks. */
  mode?: Autonomy['mode'],
  /** Every persona (personasFrom); absent, no role takes one (Amendment 68). */
  personas?: readonly Persona[],
): AgentSpec[] {
  return preset.roles.map((r) => {
    const p = personaOf(r, personas);
    const readOnly = readsOnly(r, personas);
    const own: PillState = p ? pillsWith(pills, p.tools) : pills;
    const effective: PillState = readOnly
      ? // MCP tools can change things outside the folder, so a reading role has none (Amendment 67).
        { ...own, acceptEdits: false, allowBash: false, mcp: false }
      : own;

    // A reading role stays read-only whatever was chosen: planning is reading, the rest asks.
    const roleMode = mode === undefined ? undefined : readOnly ? (mode === 'plan' ? 'plan' : 'default') : mode;
    const autonomy = toAutonomy(effective, budgetPerAgent, effort, roleMode);

    return {
      role: r.role,
      // An unresolved tier is sent as is and the daemon refuses it by name; Spawn
      // blocks the launch before that (unresolvedRoles).
      model: modelFor(r, picks, tiers) ?? r.model,
      ...(r.brief ? { brief: r.brief } : {}),
      ...(p ? { persona: p.id } : {}),
      ...(p?.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      ...(p && p.skills.length > 0 ? { skills: p.skills } : {}),
      dependsOnRoles: r.dependsOnRoles ?? [],
      ...((helpers[r.role] ?? 0) > 0 ? { helpers: helpers[r.role] } : {}),
      autonomy: readOnly
        ? { ...autonomy, disallowedTools: [...autonomy.disallowedTools, ...WRITE_TOOLS] }
        : autonomy,
    };
  });
}

/** The exact id picked for each role that has one — Spawn's per-row model. */
export type RoleModels = Partial<Record<AgentRole, string>>;

/** The id a role will be given: its pick, else what its tier means now, else null. */
export function modelFor(
  r: PresetRole,
  picks: RoleModels,
  tiers: ModelCatalog['tiers'],
): string | null {
  return picks[r.role] ?? tiers[r.model] ?? null;
}

/**
 * The rows a launch has no id for: no pick, and a tier the model API doesn't serve.
 * Spawn names them and waits.
 */
export function unresolvedRoles(
  preset: Preset,
  tiers: ModelCatalog['tiers'],
  picks: RoleModels,
): PresetRole[] {
  return preset.roles.filter((r) => modelFor(r, picks, tiers) === null);
}

/**
 * What the "every role" picker shows: the one id every row will run on, once any row
 * has been picked. Null — "per role" — while every row is on its preset tier, or when
 * the rows differ.
 */
export function commonPick(
  preset: Preset,
  picks: RoleModels,
  tiers: ModelCatalog['tiers'],
): string | null {
  if (!preset.roles.some((r) => picks[r.role])) return null;
  const ids = new Set(preset.roles.map((r) => modelFor(r, picks, tiers)));
  const [only] = [...ids];
  return ids.size === 1 && only ? only : null;
}

/**
 * The picks after choosing `id` on one row. Choosing what the row's tier already
 * means drops the pick rather than storing it, so the row is back on its preset and
 * the "every role" picker can say "per role" again.
 */
export function pickFor(
  picks: RoleModels,
  r: PresetRole,
  id: string,
  tiers: ModelCatalog['tiers'],
): RoleModels {
  const next = { ...picks };
  if (!id || id === tiers[r.model]) delete next[r.role];
  else next[r.role] = id;
  return next;
}

/** Every row of `preset` on `id`; an empty id puts every row back on its tier. */
export function pickAll(preset: Preset, id: string): RoleModels {
  return id ? Object.fromEntries(preset.roles.map((r) => [r.role, id])) : {};
}
