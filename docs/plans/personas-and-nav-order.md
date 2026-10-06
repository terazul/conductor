# Plan: personas, and the navigator in the Fleet's order

The three open TODO.md items as decided on 2 October, in three lanes that run at once.

## Step 0: the shared contract (done, serially, before the lanes)

So the lanes can't disagree about it:
- `packages/shared/src/wire.ts`: `AgentSpec` gains `persona?`, `systemPrompt?` and
  `skills?`.
- `packages/web/src/spawn/personas.ts`: `Persona`, `BUILT_IN_PERSONAS`, `PERSONAS_KEY`
  (`conductor.personas`), `personasFrom`, `withPersona`, `resetPersona`,
  `withoutPersona`, `newPersonaId`, `personaFor`, `isEdited` and `pillsWith`, with checks in
  `spawn/verify.ts` §12.

**Lanes must not change these exports' names or shapes.** They may add to them.

## Lane A: the navigator in the Fleet's order

Owns `web/src/fleet/order.ts`, `web/src/fleet/fleet.tsx`, `web/src/shell/navtree.ts`,
`web/src/shell/Navigator.tsx`, `web/src/shell/shell.css` and `web/src/shell/verify.ts`.

- Move the per-project sort facts out of the `useMemo` in `fleet.tsx` into a pure
  `sortFacts(projects, agents, pending)` in `order.ts`, which `fleet.tsx` calls.
- The navigator orders its projects with `sortProjects(…, fleetSort(sort, order), order,
  sortFacts(…))` from the same two settings, so it changes when the Fleet's Sort by does.
- Dragging a project row in the navigator sets my order (`moveBefore`) and switches the
  sort to `mine`, as a Fleet drag does.
- Checks in `shell/verify.ts`: the panel's order equals the Fleet's for every sort; a drag
  writes the order and the sort.

## Lane B: personas, end to end except the Custom row

Owns `daemon/src/db/migrations/100_persona.sql`, `daemon/src/session/store.ts`,
`daemon/src/session/supervisor.ts`, `daemon/src/session/runner.ts`,
`daemon/src/routes/session.ts`, `daemon/src/session/verify.ts`,
`web/src/settings/route.tsx`, `web/src/settings/settings.css` and `web/src/lib/verify.ts`.

- **Daemon:**
  - The migration adds `agents.persona`, `system_prompt` and `skills` (JSON).
  - `parseAgentSpecs` validates them: a system prompt of at most 20,000 characters, and
    skills as a string array.
  - `createJob` stores them. The runner's `#buildOptions` passes `systemPrompt: { type:
    'preset', preset: 'claude_code', append }` when there is one, and `skills` when the
    list isn't empty, on the first run and every resume.
  - Checks in `session/verify.ts`, against the fake SDK: the options carry both, a resume
    carries them again, and an agent without them is unchanged.
- **Web:** a **Personas** section on Settings to list, add, edit, delete (yours only) and
  reset built-ins, editing every field: name, description, brief, system prompt, model
  (`ModelSelect` or a tier), the five tool rules as three-way on/off/launch's, and skills
  as a comma list. Its checks go in `lib/verify.ts`.

## Lane C: presets and Custom rows use personas

Owns `web/src/spawn/presets.ts`, `web/src/spawn/custom.ts`,
`web/src/spawn/CustomSetup.tsx`, `web/src/spawn/route.tsx`, `web/src/spawn/spawn.css` and
`web/src/spawn/verify.ts` (keep §12).

- `toAgentSpecs(…, personas?)`: each role takes `personaFor(personas, r.role)`. The spec
  carries `persona`, `systemPrompt` and `skills`; the pills go through `pillsWith`; and
  `tools.write === false` makes the role read-only, like `READ_ONLY_ROLES`. A preset keeps
  its own brief and model tier.
- A Custom row picks a persona (a select), which fills in its role name and brief and
  stores `persona` by id in the row (`CustomRole.persona?`, saved setups included). The
  row can override the brief, and its model through the existing per-row picker, for
  that launch. The role name stays free.
- `route.tsx` reads `useSetting(PERSONAS_KEY)` into `personasFrom` and passes the result.

## Then, serially

Merge C, then B, then A. Then `make test`, a headless-Chrome check
(`web/scripts/cdp.mjs`: edit a persona in Settings, see it in Spawn), mutations
(`scripts/mutate.sh`), the MANUAL, CONTRACT Amendments 68 and 69, and the TODO.

## Rules for every lane

- Own files only. No new dependencies. Tokens only, no hex colours. Match the comments
  around you.
- Web: `pnpm -C packages/web exec tsc --noEmit -p .` plus the web suites. Lane B alone
  also runs the daemon checks (`cd packages/daemon && npx tsc --noEmit -p . && npx tsx
  --no-warnings=ExperimentalWarning src/session/verify.ts`), since they bind fixed ports.
  Nobody runs `make test` or starts the app.
- Commit on your branch, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
