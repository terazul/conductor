/**
 * Agent personas (Amendment 68). Pure, so spawn/verify.ts checks them under Node.
 *
 * A persona is what a role IS: a description, a brief, its own system prompt, a default
 * model, tool rules and skills. The built-ins are the roles Conductor always had; you can
 * change them and put them back, but not delete them. Your own can be deleted. All of them
 * live in one setting, `conductor.personas`, holding only what differs from the built-ins
 * plus your own — so a later build's better built-in reaches you unless you changed it.
 *
 * Presets take the persona of the same role for its system prompt, skills and tool rules,
 * keeping their own brief and model tier. A Custom row picks a persona by id and may
 * override its brief and model for one launch. A running agent keeps what it launched
 * with: the persona's fields are copied into its spec at launch.
 */

import type { ModelTier } from '@conductor/shared';

export const PERSONAS_KEY = 'conductor.personas';

/** What a persona says about the tools; absent means the launch's pills decide. */
export interface PersonaTools {
  bash?: boolean;
  push?: boolean;
  network?: boolean;
  mcp?: boolean;
  /** False: a reading persona — the write tools are denied, whatever the launch says. */
  write?: boolean;
}

export interface Persona {
  /** Stable, lowercase: `developer`, or `persona-<n>` for your own. */
  id: string;
  /** What it's called on screen and, by default, the role an agent gets. */
  name: string;
  description: string;
  /** Added to the job prompt, as a preset's brief is. */
  brief: string;
  /** Appended to Claude Code's own system prompt. Empty: nothing appended. */
  systemPrompt: string;
  /** A tier, or an exact model id. Empty: the launch's choice. */
  model: ModelTier | string | '';
  tools: PersonaTools;
  /** Skill names to preload. Empty: Claude Code's defaults. */
  skills: string[];
  builtIn: boolean;
}

const base = (p: Omit<Persona, 'systemPrompt' | 'skills' | 'builtIn'> & Partial<Persona>): Persona => ({
  systemPrompt: '',
  skills: [],
  builtIn: true,
  ...p,
});

/** The roles Conductor shipped with, as personas. */
export const BUILT_IN_PERSONAS: readonly Persona[] = [
  /*
   * Designs before anyone builds (Amendment 70). First in the list because it comes first
   * in a job: a developer that waits for it starts from its plan. Writing is on for the ADR
   * and the plan; "no source code" is its brief's.
   */
  base({
    id: 'architect',
    name: 'architect',
    description: "Designs the change before it's built: options, trade-offs, a decision and a plan.",
    brief:
      'Before any code is written, design how to do the work above. Read the code it touches and describe what ' +
      'is there now, citing file and line. Give two or three ways to do it, with what each costs and risks, pick ' +
      'one and say why. Then write the plan: the modules and interfaces that change, the steps in order, which ' +
      'steps can run in parallel, and how each step will be checked. Record the decision as an ADR in docs/adr/. ' +
      'Change no source code: the plan is the deliverable.',
    systemPrompt: [
      'You are a software architect. Your job is a decision someone else can build from.',
      '',
      "- Evidence first. Every claim about the current system cites file and line. Say what you don't know rather than guessing, and name the files you didn't read.",
      '- Prefer the smallest change that solves the problem, and the patterns and dependencies the codebase already uses. A new dependency or a new pattern needs a reason.',
      '- Make trade-offs explicit: cost, risk, reversibility, and what each option makes harder later. Say which decisions are hard to undo (data shape, public APIs, migrations) and spend your care there.',
      '- Cover what designs usually miss: failure modes, security boundaries, data migration and backwards compatibility, how it will be tested, and how it will be operated.',
      "- When a choice is the user's (scope, product behaviour, accepting a risk), ask with AskUserQuestion rather than deciding for them.",
      "- Sketch interfaces and types if they help; don't write the implementation.",
      '',
      'Write the result as: Context, Options (a table), Decision, Consequences, Plan (numbered steps naming the files), and Risks and open questions.',
    ].join('\n'),
    model: 'opus',
    tools: { bash: true, write: true, network: true, push: false },
  }),
  base({ id: 'developer', name: 'developer', description: 'Implements the architect\'s plan.', brief: 'Implement the work described above, following the architect\'s plan. Prefer small, reviewable changes.', model: 'sonnet', tools: {} }),
  base({ id: 'validator', name: 'validator', description: 'Tests what was built and reports what fails.', brief: 'Write tests for the behaviour described above, run them against what was built, and report what fails.', model: 'sonnet', tools: {} }),
  base({ id: 'reviewer', name: 'reviewer', description: 'Reviews for correctness and quality; writes nothing.', brief: 'Review the change against the instruction for correctness and quality. Report findings with file and line; do not rewrite.', model: 'opus', tools: { write: false } }),
  base({ id: 'scribe', name: 'scribe', description: 'Keeps the plan and decision records current.', brief: 'Update the plan and any decision record to match what was actually done.', model: 'sonnet', tools: {} }),
  base({ id: 'debugger', name: 'debugger', description: 'Finds the root cause; writes nothing.', brief: 'Find the root cause before proposing any fix. Report the cause with file and line evidence.', model: 'opus', tools: { write: false } }),
  base({ id: 'analyst', name: 'analyst', description: 'Maps and explains the code; writes nothing.', brief: 'Explain how this code works: entry points, module boundaries, data flow. Cite file and line for every claim.', model: 'opus', tools: { write: false } }),
];

/**
 * Built-ins that were removed, and the one that does their work now (Amendment 84). The
 * builder's work is the developer's and the documenter's the scribe's; uiux has no
 * successor, so a row that used it runs with no persona.
 */
const RENAMED: Readonly<Record<string, string>> = { builder: 'developer', documenter: 'scribe' };
const REMOVED = new Set(['builder', 'documenter', 'uiux']);

/** The id a stored persona reference means now: its successor's, else itself. */
export function renamedPersona(id: string): string {
  return RENAMED[id] ?? id;
}

/**
 * Stored edits to a removed built-in, moved to its successor (Amendment 84). An edit
 * already saved under the successor's id wins; edits to uiux are dropped. Done on read,
 * so the next save writes the setting without them.
 */
function migrated(edits: Record<string, Partial<Persona>> | undefined): Record<string, Partial<Persona>> | undefined {
  if (!edits || typeof edits !== 'object') return edits;
  const out: Record<string, Partial<Persona>> = {};
  for (const [id, e] of Object.entries(edits)) if (!REMOVED.has(id)) out[id] = e;
  for (const [from, to] of Object.entries(RENAMED)) {
    const e = edits[from];
    if (e && !(to in out)) out[to] = { ...e, ...(e.name === from ? { name: to } : {}) };
  }
  return out;
}

/** What the setting holds: changed built-ins by id, and your own whole. */
interface Stored {
  edits?: Record<string, Partial<Persona>>;
  own?: Persona[];
}

const ID = /^[a-z][a-z0-9-]{0,40}$/;

function parseStored(raw: string | null): Stored {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const s = v as Stored;
    return s.edits === undefined ? s : { ...s, edits: migrated(s.edits) };
  } catch {
    return {};
  }
}

/** Only fields a persona has, of the right type; anything else is dropped. */
function clean(p: Partial<Persona>): Partial<Persona> {
  const out: Partial<Persona> = {};
  for (const k of ['name', 'description', 'brief', 'systemPrompt', 'model'] as const) {
    if (typeof p[k] === 'string') out[k] = p[k] as string;
  }
  if (Array.isArray(p.skills)) out.skills = p.skills.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (p.tools && typeof p.tools === 'object') {
    const t: PersonaTools = {};
    for (const k of ['bash', 'push', 'network', 'mcp', 'write'] as const) {
      if (typeof p.tools[k] === 'boolean') t[k] = p.tools[k];
    }
    out.tools = t;
  }
  return out;
}

/** Every persona, built-ins first in their order, then yours. A broken setting is the built-ins. */
export function personasFrom(raw: string | null): Persona[] {
  const s = parseStored(raw);
  const builtIns = BUILT_IN_PERSONAS.map((b) => ({ ...b, ...clean(s.edits?.[b.id] ?? {}), id: b.id, builtIn: true }));
  const own = (Array.isArray(s.own) ? s.own : [])
    .filter((p) => p && typeof p.id === 'string' && ID.test(p.id) && !BUILT_IN_PERSONAS.some((b) => b.id === p.id))
    .map((p) => ({ ...base({ id: p.id, name: p.id, description: '', brief: '', model: '', tools: {} }), ...clean(p), id: p.id, builtIn: false }));
  return [...builtIns, ...own];
}

/** Whether a built-in has been changed from what it shipped as. */
export function isEdited(p: Persona): boolean {
  const b = BUILT_IN_PERSONAS.find((x) => x.id === p.id);
  return b !== undefined && JSON.stringify({ ...b }) !== JSON.stringify({ ...p, builtIn: true });
}

/** The setting after saving `p`: a built-in keeps only what differs; yours is kept whole. */
export function withPersona(raw: string | null, p: Persona): string {
  const s = parseStored(raw);
  const b = BUILT_IN_PERSONAS.find((x) => x.id === p.id);
  if (b) {
    const diff: Partial<Persona> = {};
    for (const k of ['name', 'description', 'brief', 'systemPrompt', 'model', 'tools', 'skills'] as const) {
      if (JSON.stringify(p[k]) !== JSON.stringify(b[k])) (diff as Record<string, unknown>)[k] = p[k];
    }
    const edits = { ...(s.edits ?? {}) };
    if (Object.keys(diff).length > 0) edits[p.id] = diff;
    else delete edits[p.id];
    return JSON.stringify({ ...s, edits });
  }
  const own = (s.own ?? []).filter((x) => x.id !== p.id);
  return JSON.stringify({ ...s, own: [...own, { ...p, builtIn: false }] });
}

/** A built-in back as it shipped, or the setting unchanged for one of yours. */
export function resetPersona(raw: string | null, id: string): string {
  const s = parseStored(raw);
  if (!BUILT_IN_PERSONAS.some((b) => b.id === id)) return JSON.stringify(s);
  const edits = { ...(s.edits ?? {}) };
  delete edits[id];
  return JSON.stringify({ ...s, edits });
}

/** The setting without one of yours. A built-in can't be deleted; it is left as it is. */
export function withoutPersona(raw: string | null, id: string): string {
  const s = parseStored(raw);
  return JSON.stringify({ ...s, own: (s.own ?? []).filter((x) => x.id !== id) });
}

/** A fresh id for a new persona of yours. */
export function newPersonaId(list: readonly Persona[]): string {
  for (let n = 1; ; n++) if (!list.some((p) => p.id === `persona-${n}`)) return `persona-${n}`;
}

/** The persona for a role: the one with that id, or none. */
export function personaFor(list: readonly Persona[], role: string): Persona | undefined {
  return list.find((p) => p.id === role);
}

/**
 * A persona's tool rules over the launch's pills: what it says wins, what it leaves out
 * stays the launch's. `write: false` is a reading persona, applied by the caller, since
 * write isn't a pill.
 */
export function pillsWith(pills: Record<string, boolean>, t: PersonaTools): Record<string, boolean> {
  return {
    ...pills,
    ...(t.bash !== undefined ? { allowBash: t.bash } : {}),
    ...(t.push !== undefined ? { allowPush: t.push } : {}),
    ...(t.network !== undefined ? { network: t.network } : {}),
    ...(t.mcp !== undefined ? { mcp: t.mcp } : {}),
  };
}
