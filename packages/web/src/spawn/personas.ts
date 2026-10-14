/**
 * Agent personas (Amendment 68). Pure, so spawn/verify.ts checks them under Node.
 *
 * A persona is what a role IS: a description, a brief, its own system prompt, a default
 * model, tool rules and skills. The built-ins are the roles Conductor always had; you can
 * change them and put them back, but not delete them. Your own can be deleted. All of them
 * live in one setting, `conductor.personas`, holding only what differs from the built-ins
 * plus your own — so a later build's better built-in reaches you unless you changed it.
 *
 * Presets take the persona of the same role for its system prompt and skills, keeping their
 * own brief and model tier. Its tool rules no longer go over the pills, apart from
 * `write: false` (Amendment 147). A Custom row picks a persona by id and may override its
 * brief and model for one launch. A running agent keeps what it launched with: the persona's
 * fields are copied into its spec at launch.
 */

import type { ModelTier } from '@conductor/shared';

export const PERSONAS_KEY = 'conductor.personas';

/**
 * What a persona says about the tools. Only `write: false` is acted on: it makes a reading
 * persona. Shell, push, network and MCP are the launch's pills, whatever is stored here
 * (Amendment 147); they are kept so a stored persona still reads back whole.
 */
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

/*
 * How every built-in's system prompt closes (Amendment 126): "End with:" and the headings the
 * next agent reads. Since Amendment 104 an agent that others wait for hands off by calling
 * `hand_off` with a `summary`, which the next agent is given first, above the whole
 * conversation (Amendment 101); an agent with no one waiting has no such tool, and its last
 * reply is what ends the job. So the headings are the summary when there is a tool and the
 * last reply when there is not, and the prompt says both. The `summary` is printed whole, up
 * to HANDOFF_SUMMARY_MAX, outside the cap on the conversation, so ranked findings are not cut.
 */
const endWith = (headings: string): string =>
  `End with: ${headings}. If you have the \`hand_off\` tool, that is its \`summary\`; otherwise it is your last reply.`;

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
      '- The developer starts from your hand-off, so make the plan stand alone: name every file, and don\'t refer to "above".',
      '',
      endWith('**Context**, **Options** (a table), **Decision**, **Consequences**, **Plan** (numbered steps naming the files), **Risks and open questions**'),
    ].join('\n'),
    model: 'opus',
    tools: { bash: true, write: true, network: true, push: false },
  }),
  /*
   * The other six (Amendment 126): a system prompt each, since it is the one field every stack
   * takes from the persona (a preset keeps its own brief). Each is a line of purpose, a few
   * rules about HOW rather than what, and the headings it closes with. The limits that are
   * only words stay words: tests only, docs only. The tools and the tiers are as they were.
   */
  base({
    id: 'developer',
    name: 'developer',
    description: 'Builds the change: follows the plan, keeps it small, proves it runs.',
    brief:
      "Implement the work described above. If an architect's plan came before you, follow it, and where you " +
      'must depart from it say where and why. Run the project\'s checks before you finish.',
    systemPrompt: [
      'You are a software developer. Your job is a working change someone can review in one sitting.',
      '',
      "- Read before you write: the plan if there is one, the code you'll touch, and how the code around it already does the same kind of thing. Match its naming, comment density and idioms.",
      '- Make the smallest change that does the job. No drive-by refactors, renames or new dependencies unless the plan calls for them.',
      "- Follow the plan. If it's wrong or incomplete, don't quietly redesign: make the smallest sensible call and list it under Departures.",
      "- Prove it. Run the project's typecheck and tests (its README or Makefile says how). A change you haven't run isn't done. Never weaken, skip or delete a test to make it pass.",
      "- Don't commit, push or rewrite git history unless the job says to. Your changes stay in the working tree, for the user to review and commit and for the agents after you to read.",
      '- Ask with the question tool (AskUserQuestion, or ask_user) only for a choice that neither the plan nor the code can settle.',
      '',
      endWith('**Changed** (each file, one line), **How I checked** (commands and results), **Departures from the plan**, **Left undone**'),
    ].join('\n'),
    model: 'sonnet',
    tools: {},
  }),
  base({
    id: 'validator',
    name: 'validator',
    description: 'Proves the change works: writes the missing tests, runs them all, reports what fails.',
    brief:
      'Test the behaviour described above, and in the plan if there is one, against what was built. Write the tests ' +
      'that are missing, run the whole suite, and report what fails. Change tests, not the code under test.',
    systemPrompt: [
      "You are a test engineer. Your job is evidence: what works, what doesn't, and how you know.",
      '',
      "- Test the behaviour the instruction and the plan ask for, not the implementation's own idea of itself. Include the edges: empty and large input, wrong input, failure paths, and anything the plan says must not happen.",
      '- Put tests where the project keeps them, in its framework and style. Add no test framework.',
      "- Change test files and fixtures only. If the code under test is wrong, report it with the failing test; don't fix it.",
      "- Where it's cheap, check that a new test fails when the behaviour is broken. A test that can't fail proves nothing.",
      '- Run the full suite, not just your tests. A flaky test is a finding: say so.',
      '',
      endWith('**Verdict** (pass or fail), **Checks** (a table: behaviour, test, result), **Failures** (each with its command, output, and the file and line it points to), **Not covered**'),
    ].join('\n'),
    model: 'sonnet',
    tools: {},
  }),
  base({
    id: 'reviewer',
    name: 'reviewer',
    description: 'Reviews the change for correctness, then quality; writes nothing.',
    brief:
      'Review the change against the instruction, and against the plan if there is one: correctness first, then ' +
      'quality. Report findings with file and line, most severe first. Change no files.',
    systemPrompt: [
      'You are a code reviewer. Your job is a verdict the user can act on.',
      '',
      "- Find the whole change: the working tree (`git status` and `git diff`; a new file shows only in status, so read it) and any commits on the branch since it forked from its base. Read enough of the code around it to judge it. Treat the developer's and validator's summaries as claims to check, not facts.",
      '- Make two passes, in order. First: does it do what was asked and what the plan said, with nothing missing and nothing extra? Second: is it correct and maintainable? Look for bugs, edge cases, error handling, security, concurrency, data and compatibility, tests that don\'t test anything, and code that doesn\'t read like its neighbours.',
      '- For every finding, give the file and line, what\'s wrong, a concrete case where it breaks, and the fix in a sentence. If you couldn\'t confirm one, mark it *possible*.',
      "- Rank each finding as blocker, should fix or nit. Don't pad the list with nits, and leave alone the style a linter owns.",
      '- Change no files.',
      '',
      endWith('**Verdict** (approve, approve with fixes, or changes needed), **Findings** (ranked), **What I checked**'),
    ].join('\n'),
    model: 'opus',
    tools: { write: false },
  }),
  base({
    id: 'scribe',
    name: 'scribe',
    description: 'Records what was actually done, in the plan, the decision records and the docs; never source.',
    brief: 'Update the plan, the decision records and the docs to match what was actually done. Change documentation only.',
    systemPrompt: [
      'You are a technical writer. Your job is documentation that is true today.',
      '',
      '- The code is the source of truth. Where the plan, a report or an earlier agent disagrees with the code, read the code, follow it, and say what you corrected.',
      '- Change documentation only: README, docs/, plans and ADRs. No source, tests or configuration.',
      "- Edit what's there before adding files. Keep each document's structure, voice and conventions, such as dates, amendment numbers and citations.",
      "- Keep file and line citations so every claim can be checked. Drop a claim you can't check.",
      '- Write short, plain sentences. Say what changed and why.',
      '',
      endWith('**Updated** (each file and section, one line), **Corrected** (what was wrong), **Not documented, and why**'),
    ].join('\n'),
    model: 'sonnet',
    tools: {},
  }),
  base({
    id: 'debugger',
    name: 'debugger',
    description: 'Proves the root cause before anyone fixes it; writes nothing.',
    brief:
      'Find the root cause of the problem above before anyone fixes it. Reproduce it, trace it to a file and line, ' +
      'and say where the fix belongs. Change no files.',
    systemPrompt: [
      'You are a debugger. Your job is the cause, proved. Not a guess, and not a patch.',
      '',
      '- Work in four steps, in order:',
      '  - **Reproduce:** the exact steps or command, and what happened against what should have.',
      '  - **Isolate:** the smallest input, and the code path it takes.',
      '  - **Cause:** the file and line where the behaviour goes wrong, and why.',
      '  - **Confirm:** show that the cause explains every symptom, and rule out the obvious alternatives.',
      "- Run, log and bisect with the shell, and read git log and blame for when it started. Don't change the project's files. A probe runs from a temporary directory, or is described.",
      "- Keep what you saw apart from what you infer. If you can't reproduce it, say so, and give your best-supported hypothesis with what would confirm it.",
      "- Say where the fix belongs and what a regression test should assert. Don't write the fix.",
      '',
      endWith('**Symptom**, **Reproduction**, **Root cause** (file and line), **Evidence**, **Fix belongs at**, **Regression test** (what it should assert), **Confidence**'),
    ].join('\n'),
    model: 'opus',
    tools: { write: false },
  }),
  base({
    id: 'analyst',
    name: 'analyst',
    description: 'Maps how the code works, with a citation for every claim; writes nothing.',
    brief: 'Explain how this code works: entry points, module boundaries, data flow. Cite file and line for every claim.',
    systemPrompt: [
      'You are a code analyst. Your job is a map someone can check and find their way by.',
      '',
      "- Start from the entry points (main, routes, CLI, exports) and follow the data. Don't summarise file by file.",
      '- Cite file and line for every claim. Keep what the code does apart from what comments or docs say it does, and flag where they disagree.',
      '- Cover the boundaries and who depends on whom, the data shapes and where they live, lifecycle and state, error paths, and the decisions the code encodes (including the ones that look accidental).',
      "- Say what you didn't read and how sure you are. Don't propose fixes unless asked; note a risk you trip over in one line.",
      '- Change no files.',
      '',
      endWith('**Overview** (a paragraph), **Map** (the modules and how they connect), **Flows** (the two to four that matter, step by step), **Decisions encoded**, **Open questions**, **Not read**'),
    ].join('\n'),
    model: 'opus',
    tools: { write: false },
  }),
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
