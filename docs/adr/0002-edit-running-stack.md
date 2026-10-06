# ADR 0002 — Edit a running stack: add and remove agents in a live job

- **Status:** accepted (6 Oct 2026). Built in two commits: the stranded-dependents fix (Amendment 88), then add and remove (Amendment 89).
- **Asked for:** "add and remove agents in a job that is already running" (6 Oct), with one existing bug to fix first.
- **Decided by the user, in the request:** nothing new may start spending money without the user's action; no agent may wait forever; the job must always be able to settle; a job is a set of agent rows, so this works the same whatever stack launched it.

## Context

**A job doesn't remember its preset.** After launch it is a set of agent rows, each with `dependsOn: string[]` (agent ids). So editing a running stack means editing those rows. Nothing here reads a preset or a saved setup.

**How the graph runs today** (`packages/daemon/src/session/supervisor.ts`):

- `createJob` (`:515`) resolves `dependsOnRoles` to ids in one pass and inserts one row per spec.
- `pump` (`:613`) launches a `queued` agent when `#depsSatisfied` (`:638`) is true. Every dependency must be `done`. The one exception is a helper that failed or was stopped, which still counts as ended for its own orchestrator (Amendment 51).
- `startHelper` (`:902`) already adds an agent to a live job: `insertAgent`, a `queued` status event, `#reopenJob`, `#pushEntities`, `pump`. That is the model for "add".
- `#rollUpJob` (`:992`) settles a job only when every agent is `done`, `failed`, `paused` or `stopped`.
- `terminateAgent` (`:1260`) marks an agent `stopped`. `deleteAgent` (`:1343`) terminates it, deletes the row and broadcasts `resync`.
- The job's cap is the sum of its agents' current caps (`jobCap`, `budget.ts`), so a new agent grows it by its own cap with no extra code.
- The handoff (Amendment 37) gives an agent's first prompt the last reply of each agent in its own `dependsOn`, and nobody else's.

**The bug.** Stop the architect in a full pipeline and the developer, validator, reviewer and scribe wait forever. `#depsSatisfied` is false for good (the dependency is `stopped`, or its row is gone after a delete). The dependents stay `queued`, and `#rollUpJob` never settles the job. Amendment 85 added an alert that says so, but nothing could be done from it except stopping the waiting agents too.

Amendment 85 made one related decision that stays: an agent waiting on a **failed** one stays queued, because continuing the failed one is a real way forward.

**Read-only roles** are enforced only in the browser today. `toAgentSpecs` (`web/src/spawn/presets.ts`) pins a reading role to plan or ask-me and denies the write tools. The daemon trusts the specs it's given.

## Options and decisions

### 1. What happens to the agents waiting on a stopped one

| Option | Cost | Risk |
|---|---|---|
| A. Leave them queued (today) | none | The bug: they wait forever and the job never settles. |
| B. Fail them | small | Red cards and a failed job for something the user did on purpose. Continuing a failed agent that never started has no session to resume. |
| C. Run them at once, without it | small | Spends money the user didn't ask for. A reviewer starts on a plan that was never written. |
| **D. Pause them, with a note; resume runs without it** (chosen) | small | One more click per waiting agent. |

**Decision: D.** When an agent is stopped, each agent that is queued, hasn't started and waits on it goes `paused` with the note *"waits for architect, which was stopped — resume to run without it, or remove it"*. Nothing starts until the user does something.

- **Resume** drops the stopped dependency and queues the agent. Its first prompt still says what the stopped agent wrote last, marked the way a stopped helper is (Amendment 51): `[architect — stopped, so it may not have finished its part]`. A stopped agent is no longer in `dependsOn`, so the handoff can't find it there. It is kept in a new column, `agents.went_without` (JSON `[{id, role}]`, migration `120_went_without.sql`). Like the persona, it stays off the wire.
- **Only direct dependents are paused.** Those further down (the validator, behind the now-paused developer) stay queued, waiting on the developer. That is accurate: they start once the developer is resumed and done.
- **The roll-up counts a stuck agent as settled.** A queued agent is stuck when it can't start without the user, because something it waits on (directly or further up) is `paused`, `failed` or `stopped`, or is gone. `#rollUpJob` treats it like `paused`. So the job above settles, and Amendment 87's "finished" mark shows. This also settles a job whose reviewer waits on a failed developer (Amendment 85), which used to say "working" for good.
- **A settled job opens again when work resumes.** `resumeAgent` already calls `#reopenJob`. Continuing a failed agent with a message (`#launchWithPrompt`) now does too. Without that, `pump` would skip the queued agents of a job settled `failed`.
- **`terminateJob` doesn't pause anything.** It is stopping every agent anyway, so a pause before each stop would only add noise to the log.
- **Rows from before this fix** (queued behind a stopped or deleted agent) are swept by `reconcile` at startup and paused the same way, never started.
- **The Needs You card** (Amendment 85) now covers a paused agent waiting on a stopped one. It offers **resume** on the waiting agent instead of "stop this one too".

### 2. Adding an agent

**`POST /api/jobs/:jobId/agents`**, with an `AgentSpec` body plus an optional `feeds: string[]`. It returns `{ agent, fed }` (`AddAgentRequest` and `AddAgentResponse` in `wire.ts`).

- **One row builder.** The per-spec code in `createJob` moves to `agentRow()`, which both `createJob` and `addAgent` call. The persona, system prompt, skills, provider and helper cap are copied the same way in both.
- **The spec is parsed by the same code as a launch.** `parseAgentSpecs` is split so one entry can be parsed alone. The role, model, provider, autonomy, persona and helpers are checked exactly as they are at Spawn.
- **Checks against the job:**
  - the job exists (404 otherwise);
  - the role isn't already in the job;
  - `dependsOnRoles` names roles in the job, and none of them is `stopped`, since that agent will never finish;
  - the engine is the same as the job's other agents';
  - a per-agent cap is set: dollars on Claude, tokens on an engine without dollars, as Spawn always sends;
  - a reading role is read-only;
  - `feeds` names only `queued` agents with no session;
  - no cycle.
- **Read-only, in the daemon too.** `isReadOnlyRole` and the write-tool list move to `packages/shared/src/stack.ts`, so the daemon and the browser read one list. A reading role whose autonomy doesn't deny the write tools, or whose mode isn't plan or ask-me, is **refused, not pinned**. That is how the routes treat a bad persona: they don't trim it into shape. The browser builds a valid spec in the first place.
- **Feeds** insert the new agent in the middle. Each named agent gains the new agent in its `dependsOn`, so it now waits for it, and hears it in its handoff.
- **Cycles.** A cycle is possible only when a fed agent is also upstream of the new agent: it is one of its `dependsOn`, or something they wait on. That is the only case checked, and it is refused.
- **Then** the new agent is emitted `queued`, the job reopens (`#reopenJob`, so a finished job comes back), the new row and the fed rows are pushed, and `pump()` runs. The job's cap grows by the new agent's cap through `jobCap`, unchanged.

### 3. Removing an agent from the stack

| Option | What it means |
|---|---|
| E. New `POST /api/agents/:id/remove-from-stack` beside `DELETE` | Two routes. `DELETE` would still have to rewire, because the bug fix requires it, so both would do the same thing. |
| F. `DELETE /api/agents/:id?mode=rewire` | The other mode would be "delete and strand", which is the bug. |
| **G. `DELETE /api/agents/:id` always rewires** (chosen) | One route, one meaning. Its response gains `rewired`. |

**Decision: G.** The request asked for a new route, or `DELETE` with a mode. Both assume two behaviours worth keeping. Once `deleteAgent` must rewire (part 1 of the request), removing a row and removing it from the stack are the same act. A second route would be an alias, and a mode would only keep the bug reachable. So `DELETE` is "remove from stack", and its response is `{ removed, rewired: [{ agentId, dependsOn }] }` (`RemoveAgentResponse`).

**The rewiring** (`rewireOnRemoval`, pure, in `shared/src/stack.ts`):

- Each agent that waited on the removed one and **hasn't started** (no session, and `queued` or `paused`) waits on the removed agent's own dependencies instead. A→B→C, remove B: C now waits on A, and its handoff comes from A. Duplicates are dropped, and so are the removed agent's own helpers.
- **Agents that have started or ended are untouched.** Their `dependsOn` keeps the gone id. `#depsSatisfied` lets a missing dependency through only for an agent that has a session: it passed that gate when it started. This is also what lets an orchestrator whose helper was removed carry on.
- **An agent paused only because the removed agent was stopped is queued again.** Removing it is the user's action, and the confirm sentence says what will happen. One paused for any other reason (by you, or at its cap) stays paused.
- The order inside `deleteAgent` is: rewire, terminate, delete, requeue. Rewiring first means terminating doesn't strand anyone, so nothing is paused and then unpaused straight away.
- Files the removed agent wrote stay where they are, as with terminate. The event log and the day's spend are kept. Removing the last agent settles the job `done`, as before. `resync` is broadcast, then `pump()`.

### 4. The screens

- **Project screen → each job's header: `+ agent`.** It opens a row editor beside the job. The row is the Custom setup's row, taken out of `CustomSetup.tsx` as `RoleRow` so both use one component: role, persona, brief and "waits for". Here "waits for" lists the job's agents, without helpers and without stopped agents. Beside it:
  - **also feeds**, listing the job's queued agents that haven't started;
  - the **model** (the catalog picker on Claude, a model id on another engine);
  - a **cap** (dollars or tokens, as the job's engine reports).
- **Its autonomy comes from the job.** The added agent takes the permissions of a sibling that writes (or reads, if it is a reading role), with its own cap and its persona's tool rules. A reading role, or a reading persona, is pinned read-only exactly as `toAgentSpecs` pins it. The rules live in `web/src/spawn/stack.ts` (`addAgentSpec`, `addAgentProblems`), which are pure and checked in `spawn/verify.ts`.
- **Agent screen → remove from stack.** For a live or waiting agent, terminate's confirm offers **remove from stack** beside **✕ terminate**. A banner under the header says what moves, using `rewirePreview`: *"scribe will wait for architect instead."*, or *"developer will start, waiting for no one."* An ended agent's existing **remove** is the same call, and its banner says the same. Terminate and pause are unchanged.
  - A fourth button in the idle header didn't fit beside the inspector at a normal window width. So the option sits in the confirm, where the decision is made.
  - While a confirm is armed, the header hides fold all, export and interrupt. The question shortens with an ellipsis rather than pushing its buttons under the inspector, which the old terminate confirm already did.
- Every call goes through `api()` (`lib/feed.ts`). Every control is a button or input, reachable with Tab.

## Consequences

- **Wire, additive only:** `AddAgentRequest`, `AddAgentResponse` and `RemoveAgentResponse`. `DELETE /api/agents/:id` returns more than before, but the old `removed` field is still there.
- **Shared gains pure code** (`stack.ts`): the read-only roles, the write tools, the rewire and the cycle check. `presets.ts` re-exports `isReadOnlyRole`, so its importers don't change.
- **One migration**, `120_went_without.sql`: a nullable column, read only by the handoff.
- **A job settles in more cases**, so Amendment 87's "finished" mark and notification now also reach jobs stuck behind a failed or stopped agent. A job behind a paused agent settles `done`, which is what a paused agent has always meant to the roll-up.
- **Stopping an agent now writes a `paused` status for each direct dependent**, with a note.
- **An added agent can't be given its own pills.** It takes a sibling's, plus its persona's rules. Anything else is changed afterwards in the agent's inspector, as for any agent.

## Plan

1. **Commit 1, `fix(conductor)`, Amendment 88:** the pause-on-stop, the stuck-aware roll-up, resume-without with its handoff, the startup sweep, the alert and card change, and `deleteAgent` rewiring. Tests in `session/verify.ts` and `attention/verify.ts`.
2. **Commit 2, `feat(conductor)`, Amendment 89:** `agentRow`, `addAgent`, the add route, the wire types, `shared/stack.ts`, `RoleRow`, the `+ agent` editor, remove from stack, and the docs. Tests in `session/verify.ts` and `spawn/verify.ts`.

Commit 1 already needs the rewire to fix `deleteAgent`, so `rewireOnRemoval` lands in `shared/stack.ts` in commit 1.

## Risks and open questions

- **`docs/ARCHITECTURE.md` isn't in this repository.** README links it, and Amendment 81 says it lives outside git. So this ADR and the amendments carry what it would have said. Whoever keeps that file should add §1–3.
- **Feeding an agent mid-pipeline changes its handoff.** The fed agent hears the new agent as well as what it already waited on. That is the point, but it makes the fed agent's first prompt longer (up to 8k characters more per upstream agent).
- **Not covered:** editing an existing agent's dependencies in place, or reordering. Remove and add again does the same job.
