# Plan — the nine open TODO items of 6 Oct (Amendments 84–87)

## Context

TODO.md has nine open items after Amendment 83. The user decided on 6 Oct:

- **Finish notice:** when a whole job ends, its card, its lane group and its navigator row show **finished** until seen. The tab badge counts it, and a desktop notification fires if those are on. Opening the project or one of the job's agents marks it seen.
- **Seen** is kept in Settings (`packages/web/src/lib/settings.ts`), so it's the same in every browser.
- **An agent whose dependency failed** stays queued, so it still starts if the failed agent is resumed and finishes, and Needs You says so. That needs a new `AlertKind` (`packages/shared/src/wire.ts:476`).
- **Personas:** documenter merges into scribe, builder into developer, and uiux is dropped.

Facts the lanes rely on:

- The tab badge counts pending requests plus alerts (`packages/web/src/attention/notify.ts:159-166`). Its effects run once per tab, in `attention/always.tsx`.
- `#depsSatisfied` counts a failed dependency as ended only for a helper's orchestrator (`packages/daemon/src/session/supervisor.ts:638-647`).
- `setAgentStatus` sets `ended_at` only for done and failed (`packages/daemon/src/session/store.ts:534`).
- The navigator's agents are flat (`packages/web/src/shell/Navigator.tsx:211-224`) but already ordered by job (`agent/tabs.ts`). The Project screen already heads its groups with the job's prompt, branch and agent count (`fleet/project.tsx:95-110`).

## Options

| | Run order | Cost | Risk |
|---|---|---|---|
| **One agent, in order** | 9 items in sequence | Slowest | None from overlap |
| **Four lanes split by file, in parallel; the finish notice's navigator mark after the navigator lane** | Wave 1: 4 lanes; wave 2: one small join | Fastest | Lanes share a worktree, so each is barred from the others' files |
| **Four worktrees, merged after** | Parallel | Merge work on CONTRACT, MANUAL and TODO | No git remote; worktree base unclear |

## Decision

Run four lanes in one worktree, each owning a set of files. Agents don't edit CONTRACT.md, docs/MANUAL.md or TODO.md: they return the text, and the integrator applies it and commits each amendment on its own after a green `make test`.

| Lane | Amendment | Items | Owns |
|---|---|---|---|
| **A. Spawn** | 84 | developer on sonnet; the validator's wording; the reviewer and scribe hear the architect; fewer personas | `packages/web/src/spawn/**`, and `'builder'` fixtures in other verify files only where a persona lookup needs it |
| **B. Daemon** | 85 | a stopped agent gets `ended_at`; an agent waiting on a failed dependency raises a `blocked_dep` alert | `packages/daemon/**`, `packages/shared/src/wire.ts` (AlertKind only), `packages/web/src/attention/alerts.ts`, `AlertCard.tsx`, `attention/describe.ts`, `attention/verify.ts` |
| **C. Navigator** | 86 | the agents grouped by job | `packages/web/src/shell/navtree.ts`, `Navigator.tsx`, `shell.css`, `shell/verify.ts` |
| **D. Finish notice** | 87 | a job finished, until seen | `packages/web/src/lib/seen.ts` (new), `attention/notify.ts`, `attention/always.tsx`, `fleet/card.tsx`, `fleet/project.tsx`, `fleet/fleet.css`, `lib/verify.ts`; in wave 2, the navigator's job row |

Defaults the user didn't set:

- A navigator group is headed by the job's prompt on one line, plus its agent count. Groups start open, and are shown even when a project has only one job. A group shows the dot of its unhappiest agent and the count of what needs you. Helpers aren't nested under the agent that made them.
- The validator's preset row reads `does: 'tests what was built'`. Its persona is reworded the same way.
- The **analysis** preset keeps its id and its rewrite-the-docs brief, now on a `scribe` row. Saved settings keep working.
- Saved persona edits and setups under `builder`, `documenter` or `uiux` are mapped when read: builder becomes developer, documenter becomes scribe, and a uiux row runs with no persona, as an unknown persona already does.

## Consequences

- **Bug fix and one agent** launch a `developer`, on that preset's own model tier. Running agents keep their role text, because roles are free text in the daemon.
- **A new alert kind** is the only wire change. It's additive (with an optional `blockedBy`). Web and daemon ship together, so no tab meets the kind without knowing it.
- **"Seen"** adds one Settings key. Nothing to migrate.
- **Full-pipeline prompts** grow by up to 8k characters for the reviewer and the scribe (`handoff.ts:18`).

## Plan

1. **Wave 1, in parallel:** lanes A, B, C and D (D leaves the navigator alone). Each lane runs `pnpm -r typecheck` and its own verify file, not `make test`, because the lanes share a worktree.
2. **Wave 2:** after C, add D's **finished** mark to the navigator's job row.
3. **Integrate:**
   - apply each lane's CONTRACT, MANUAL and TODO text;
   - run `make test`;
   - commit Amendments 84–87 one at a time, staging each lane's files.
4. **By hand, later:** `make start`, then launch a cheap two-agent job and watch the finished mark appear and clear.

## Risks and open questions

- **Lanes share a worktree.** A lane that strays outside its files can clobber another's. The integrator checks `git diff --stat` per lane before committing.
- **Both B and D change what the badge counts.** B adds an alert kind, which the badge counts automatically. D adds finished jobs. Neither edits the other's file.
- **Persona migration.** A user's own edit to `builder` would replace the developer persona's text. That is the intent, but it is visible.
