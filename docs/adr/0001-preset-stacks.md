# ADR 0001 — New preset stacks: an architect-led full pipeline, and analysis only

- **Status:** accepted as built (6 Oct 2026). The code decides: commit d2d1827 (Amendment 82) is the record, and this ADR describes it. An earlier draft chose D (replace `analysis`) and G (the reviewer and scribe also hear the architect). The user ruled that the code overrides the ADR, so those choices are superseded by E and F, as built.
- **Asked for:** TODO.md, "New preset stacks" (2 Oct). It was to come after the multi-provider work, which finished with Amendment 81.
- **Decided by the user:** the validator waits for the developer, so the pipeline runs strictly in order (5 Oct). The code overrides this ADR (6 Oct).

## Context

**How presets work.**

- `PRESETS` in `packages/web/src/spawn/presets.ts:47` holds all the stacks. Each `PresetRole` has a `role`, a model tier, a `does` line, a `brief` and `dependsOnRoles` (`presets.ts:30-39`).
- `toAgentSpecs` turns a preset into `AgentSpec[]` (`dependsOnRoles` is copied at `presets.ts:322`). Each role takes the persona whose id matches its role name and gets that persona's system prompt, skills and tool rules. The brief and the model tier stay the preset's own (Amendment 68). A role whose persona doesn't exist runs with no persona.
- The daemon treats roles as free text (`AgentRole` is `string & {}`, `packages/shared/src/events.ts:17-24`). It resolves `dependsOnRoles` against sibling roles (`packages/daemon/src/session/supervisor.ts:553-562`) and rejects a dependency that names no sibling (`routes/session.ts:218-220`). So none of this needed a wire or daemon change.
- **The handoff is direct, not transitive.** When an agent starts, its first prompt carries the final reply of each agent in its *own* `dependsOn`, and of no one else (`supervisor.ts:685-689`, `handoff.ts:37-45`). Each reply is capped at 8,000 characters (`handoff.ts:18`).
- The Settings default preset is stored by id. `launchDefaults` falls back to `full` when the stored id isn't a preset (`spawn/defaults.ts:54`).

**Personas** (`packages/web/src/spawn/personas.ts`): `architect` existed already (Amendment 70). `builder` is used by **bug fix** and **one agent**, by Custom's first row (`custom.ts:47`), and by saved setups and persona edits kept under the id `builder`.

**Not read:** the Copilot/OpenRouter backends (`session/backends/`), past checking that they take the same `AgentSpec`. `mockups/conductor.html`, which is a design reference and not shipped.

## Options

### Where "developer" comes from

| Option | Cost | Risk / what it makes harder |
|---|---|---|
| **A. Rename `builder` to `developer` everywhere** | Touches bug fix, one agent, Custom's first row, persona ids, many tests | Breaks saved setups (which store the persona by name, Amendment 68) and persona edits saved under `builder`. Hard to undo. |
| **B. Add a `developer` built-in persona; `builder` stays** (built) | One persona row and one known role | Two personas that are much alike. An edit to `builder` doesn't reach the full pipeline. |
| **C. A `developer` row run on the `builder` persona** | No new persona | The developer's system prompt can't say "follow the architect's plan" without changing what `builder` means everywhere. |

### Analysis only: beside `analysis`, or instead of it

| Option | Cost | Risk |
|---|---|---|
| **D. Keep the id `analysis` and turn it into analyst → scribe** | Edit one entry | No stored setting changes meaning, but the documenter stack is gone. |
| **E. Add `analysis-only` beside `analysis`** (built) | One new entry | Two analysis stacks that differ only in their second role. A saved default of `analysis` keeps working, because `analysis` still exists. |

### Who hears the architect's plan (the handoff isn't transitive)

| Option | What changes | Cost |
|---|---|---|
| **F. Each role depends on the one before it** (built) | — | The reviewer and the scribe never get the architect's reply. They can find the plan on disk, but nothing tells them it's there. |
| **G. The chain, plus the architect for the reviewer and the scribe** | `dependsOnRoles` lists | Up to 8k more characters in two first prompts. |

## Decision

**B + E + F, as built in d2d1827.** Plus the user's decision: a strictly sequential pipeline, with the validator after the developer.

- **B:** add `developer` and don't rename `builder`. A rename changes saved data and is the one choice here that is hard to reverse.
- **E:** `analysis-only` (label **Analysis Only**) sits beside `analysis`. Both stacks stay offered: `analysis` ends in a documenter that rewrites the project's docs, and **Analysis Only** ends in a scribe that writes the findings down as a dated note.
- **F:** each role hears only the role or roles it waits for. The reviewer gets the developer's and validator's replies, and the scribe gets the reviewer's.

### The stacks, as built (`presets.ts:48-191`)

```ts
// full — "full build pipeline", DEFAULT_PRESET
architect  opus    dependsOnRoles: []
developer  opus    dependsOnRoles: ['architect']
validator  sonnet  dependsOnRoles: ['developer']
reviewer   opus    dependsOnRoles: ['developer', 'validator']
scribe     sonnet  dependsOnRoles: ['reviewer']

// analysis — "analysis", unchanged
analyst    opus    dependsOnRoles: []          // READ_ONLY_ROLES
documenter sonnet  dependsOnRoles: ['analyst']

// analysis-only — "Analysis Only"
analyst    opus    dependsOnRoles: []          // READ_ONLY_ROLES
scribe     sonnet  dependsOnRoles: ['analyst']
```

## Consequences

- **Saved settings:** nothing breaks. `full` and `analysis` keep their ids, and Custom setups don't refer to presets.
- **A full-pipeline job takes longer:** five steps in sequence, where builder and validator used to overlap. That was the user's choice.
- **The reviewer and the scribe don't receive the architect's plan.** The reviewer judges the change against the instruction, not the plan. If plan-aware review matters later, add `'architect'` to their `dependsOnRoles` (option G). That is a two-line, reversible change.
- **The validator's text is out of date.** Its row still says "writes tests first" (`presets.ts:72-74`), but it now starts after the developer. The code wins here too; changing the wording is a separate edit, not part of this ADR.
- **Edits to the builder persona** don't reach full-pipeline launches. They still reach bug fix, one agent and Custom.
- **Two analysis stacks** appear in Spawn. MANUAL's preset table lists both (`docs/MANUAL.md:288-289`).
- **No daemon, wire or migration change**, so all of this is reversible.

## Plan

Done in d2d1827 (Amendment 82): `presets.ts`, `personas.ts`, `custom.ts`, `spawn/verify.ts`, MANUAL and CONTRACT.

The earlier draft's steps are superseded:

- *Step 1 (replace `analysis` in place, add architect dependencies):* dropped. E and F stand.
- *Step 3 (pin "no `analysis-only` id", handoff check):* dropped with it.
- *Step 4 (rewrite MANUAL for "analysis only", revise Amendment 82):* dropped. MANUAL and Amendment 82 already describe what was built.

Still worth doing by hand, once: `make start`, open Spawn, and check that the full pipeline's plan preview reads "starts now / after architect / after developer / after developer and validator / after reviewer", and that **Analysis Only** shows the analyst as read-only.

## Risks and open questions

- **Plan-aware review.** Under F the reviewer can't check the change against the architect's plan unless it goes looking. Option G is the fix if that turns out to matter.
- **Handoff growth, if G is ever taken.** The reviewer's first prompt could hold three replies of up to 8k characters each. That is fine on Claude, but could matter on a Copilot or OpenRouter model with a small context window. I didn't read those backends' context limits.
- **The architect asks questions.** Its system prompt tells it to use AskUserQuestion, so a full-pipeline job starts with a step that may block in Needs You. That is intended. Whether Copilot and OpenRouter carry AskUserQuestion through Conductor's own gate (Amendment 76) isn't verified here.
- **Later:** if more stacks want "everyone hears the plan", a transitive handoff in the daemon is the general fix. It's out of scope here.
