# Wave 10, Lane I: orchestrated stacks from Custom (Amendment 142)

The text below is for the merge to apply. This lane does not edit CONTRACT.md, docs/MANUAL.md,
the Makefile or TODO.md.

## CONTRACT

### Amendment 142 — post-merge, applied. **A Custom setup can orchestrate and saves the roles it lists; the navigator marks an orchestrator.**

Web only (`spawn/custom.ts`, `spawn/presets.ts`, `spawn/route.tsx`, `spawn/CustomSetup.tsx`,
`spawn/Pipeline.tsx`, `spawn/spawn.css`, `shell/navtree.ts`, `shell/Navigator.tsx`, and the verify
files). From the wave 10 plan (Lane I). It takes back the Amendment 128 "Not saved in a Custom
setup" bullet: Custom now has an orchestrated row, and its listed roles are saved. Nothing changed
on the wire or in the daemon: a Custom launch sends the same fields the preset sends
(`AgentSpec.helpers`, `AgentSpec.helperRoles`), checked by the daemon as Amendment 128 has it.

**The setup** (`spawn/custom.ts`):
- **`CustomRole.orchestrates?: boolean`** (`:42`) and **`SavedSetup.listed?: ListedRole[]`** (`:54`),
  both optional, so a setup saved before reads, launches and is written back as it was.
- **One row at a time.** `withOrchestrator(roles, i, on)` (`:89`): on makes that row the one and
  drops the field from the others; off drops it. `orchestratorRow` (`:97`) is the row that
  orchestrates. `customProblems` (`:113`) has a sentence for two ("Only one agent can orchestrate:
  untick the others.").
- **`toPreset`** gives the row `orchestrates: true` (`:185`) and the preset `orchestrated: true`
  (`:166`), as the preset "orchestrated pipeline" has them (`presets.ts:119`, `:125`), so
  `orchestratedFor` and `toAgentSpecs` take the two the same way: the row gets `helpers`
  (`helperCapFor`) and `helperRoles` (`helperRolesFor`), and nothing else in the stack changes.
- **Saved.** `setupOf(name, roles, models, listed)` (`:105`) adds `listed` only beside a row that
  orchestrates. `parseSetups` keeps the first row that orchestrates (a later one reads as an
  ordinary row) and reads `listed` only beside it (`:257`), through `parseListed` (`:270`): an id
  matching the role pattern and a tier of opus, sonnet or haiku, each once, at most
  `PIPELINE_ROLES_MAX` (8); anything else is left out.

**One agent needs no orchestrator** (`presets.ts:313`). With no role listed, a Custom setup keeps
its rows and the one that orchestrated is an ordinary agent, with no flags (`:320`); only the
preset becomes the full pipeline's architect, as before.

**Spawn** (`spawn/route.tsx`):
- `listsUnder` (`:318`) is the row the roles are listed under: the preset's one row, or the Custom
  row that orchestrates; none on an engine that cannot start helpers (`has.helpers`). The preset's
  `Pipeline` is drawn under that row (`:989`); the "+ up to N helpers" picker is not offered on it
  (`:967`). The rest of the plan is as Amendment 128 has it: the ◆ mark, the `.is-orch` edge, a
  tier with no model blocking the launch.
- **The tick.** `CustomSetup` takes `orchestrable={has.helpers}` (`:731`); each row then has an
  **orchestrates** checkbox (`CustomSetup.tsx:105`, `.sp-corch` in `spawn.css:930`, ink only).
- **Saving and loading.** Save writes `setupOf(name, custom, ownPicks, listedEdit ??
  defaultListed(personas))` (`:736`). Loading a saved setup puts its list back, or the default for
  one with none (`:694`). Choosing a preset or **custom…** puts the default back, as before.
- `Pipeline` takes `alone?` (`Pipeline.tsx:49`), its words with no role listed. Custom's
  (`route.tsx:998`) say its own row launches as an ordinary agent; the preset's are unchanged.

**The navigator** (`shell/navtree.ts:68`, `shell/Navigator.tsx:130-135`). `NavAgent.orchestrator` is
the Agent tab's own answer (`agentTabs`, `marksOrchestrator`, `agent/tabs.ts:76`). The row wears
`<OrchestratorMark short />` (◆, with its title) after the label, and its title ends
" · orchestrator: starts the others", as the Agent tab's does (`agent/agent.tsx:627-636`). No edge,
and no colour of its own.

**Verify.** `spawn/verify.ts` §23 (35 checks; 469 in all): one orchestrator at a time; a saved
setup round-trips with the tick and its listed roles and launches as before it was saved; a setup
saved before this amendment parses to exactly what it was, launches with no helpers whatever list
the screen holds, and is written back unchanged; the launch request and the `POST /api/jobs` body
from a Custom orchestrator row equal the preset's for the same row and roles, with the default and
an edited list; in a setup of several only the orchestrating row changes; with no role listed it
launches as the setup without the tick; a hand-edited setting (two ticks, bad list entries, twelve
roles, a list with no tick) is read safely. §15 and §21's source checks follow the new names.
`shell/verify.ts` §11 (7 checks; 163 in all): the orchestrator's row is marked and its helper, a
plain agent and an orchestrator with nothing listed are not; it agrees with `agentTabs` for every
agent; the row draws the tab's mark and title.

**Not done / not decided:**
- **One orchestrator per Custom setup.** The tick is one row at a time; a second orchestrated row
  in one stack is not offered.
- **The other rows still run.** A Custom orchestrator beside other rows is one row of a fixed
  stack: rows that wait for it start when it ends, and its helpers are its own. Its listed roles
  are not drawn from the setup's other rows.
- **No per-role brief in Spawn**, as Amendment 128: edit it in Settings → Personas.

## MANUAL

1. docs/MANUAL.md:321, the presets table. Existing text:

```
| **custom…** | the agents you add yourself. |
```

Replacement:

```
| **custom…** | the agents you add yourself. One of them can orchestrate: see "An orchestrated pipeline" below. |
```

2. docs/MANUAL.md:346-348, the end of the Custom editor's list. Existing text:

```
- **Remove** a row and the rows that waited for it are re-chained: one that waited for exactly the
  removed row now waits for the row that was above it (for no one, if the removed row was the
  first), and one that waited for it and others keeps the others.
```

Replacement:

```
- **Remove** a row and the rows that waited for it are re-chained: one that waited for exactly the
  removed row now waits for the row that was above it (for no one, if the removed row was the
  first), and one that waited for it and others keeps the others.
- Tick **orchestrates** on a row to have it run a pipeline, as the **orchestrated pipeline**
  preset's orchestrator does: the roles it may start are listed under it in the plan, edited the
  same way, and saved with the setup. One row at a time: ticking one unticks the others. It is
  offered only on an engine that can start helpers.
```

3. docs/MANUAL.md:420-421, in "An orchestrated pipeline". Existing text:

```
  **+ add a role…**. It can start those roles and no others. The list is for this launch only;
  choosing the preset again puts the default back.
```

Replacement:

```
  **+ add a role…**. It can start those roles and no others. The list is for this launch only;
  choosing the preset again puts the default back. A Custom setup's row can orchestrate too
  (tick **orchestrates**): the same list goes under that row, and a saved setup keeps it.
```

4. docs/MANUAL.md:451-455, "How it looks". Existing text:

```
- **How it looks.** The orchestrator wears a **◆ orchestrator** mark and a heavier edge in plain
  ink, no status colour, in the plan, on its Project lane and Fleet card row (◆) and on its
  Agent tab (◆). Only a stack of two or more agents has one. Take every role off the list
  and it is one agent: the plan says so, the mark and the helper cap are gone, and it launches as
  the full pipeline's architect on its own.
```

Replacement:

```
- **How it looks.** The orchestrator wears a **◆ orchestrator** mark and a heavier edge in plain
  ink, no status colour, in the plan, on its Project lane and Fleet card row (◆) and on its
  Agent tab (◆), and the ◆ on its row in the navigator. Only a stack of two or more agents has
  one. Take every role off the list and it is one agent: the plan says so, the mark and the
  helper cap are gone, and it launches as the full pipeline's architect on its own. A Custom
  row with every role taken off launches as the agent you made, plainly.
```

5. docs/MANUAL.md:459-462, after "An orchestrated pipeline". Existing text:

```
Each row gets its model in the plan preview, like the presets. Each role can appear only
once, and a role that only reads (`reviewer`, `analyst`, …) stays read-only here too. Name
the setup and **save** it, and it appears beside the presets, in every browser. **✕** then
**forget it** removes a saved one.
```

Replacement:

```
Each row gets its model in the plan preview, like the presets. Each role can appear only
once, and a role that only reads (`reviewer`, `analyst`, …) stays read-only here too. Name
the setup and **save** it, and it appears beside the presets, in every browser; a row that
orchestrates is saved with the roles listed under it. **✕** then **forget it** removes a saved one.
```

6. docs/MANUAL.md:892-893, the navigator's Agents. Existing text:

```
  there, never in amber. Under it is one row per agent, each with its status dot,
  plus a count when one needs you. A click opens the agent, and the navigator stays
```

Replacement:

```
  there, never in amber. Under it is one row per agent, each with its status dot,
  the ◆ when it is an orchestrator (as on its Agent tab), plus a count when one needs you. A
  click opens the agent, and the navigator stays
```

## Makefile test line

none
