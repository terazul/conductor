# P1 design: Spawn launches several stacks from one plan

**Status:** approved by the user, 16 Oct 2026 (wave-12-tracks.md §2 P1). *Approved (16 Oct): option B, the batch request; the cap is a setting, `conductor.launch.stacks`, 1 to 6, default 3; the placeholder is `{track}`; the Fleet card is left for later.*
Written against `main` at `a023457` (Amendment 177 merged). Paths are under `packages/` unless they say otherwise.

**Decided (15 Oct), and not reopened here:** Spawn launches several stacks from one plan, up to 3 per
launch, each its own job (wave-12-tracks.md §3; TODO "When work is run in parallel…").

## Context: what is there today

- **One click launches one job.** Spawn's `launch` callback (`web/src/spawn/route.tsx:479-506`) sends
  one `POST /api/jobs` with `launchBody` (`web/src/spawn/launch.ts:133-143`). Nothing in `spawn/` loops
  or counts copies.
- **The daemon creates one job per request.** The route is `routes/session.ts:631-680`. It validates
  the agents (`parseAgentSpecs`, `checkProviderModels`) and the branch, then calls `sup.createJob`
  (`session/supervisor.ts:807-883`). `createJob` mints the id, opens the worktree, inserts the job and
  its agents, and pumps.
  - The worktree is at `<repo>/.conductor/wt/<jobId>`, on branch `req.branch ?? conductor/<jobId>`
    (`workspace/worktree.ts:230`, `:262`).
  - A named branch that is already checked out is refused with 409 (`LaunchBranchError`).
- **Jobs are not linked to each other.** The `jobs` table (`db/migrations/001_core.sql:19-30`) has
  never been altered. There is no parent, batch or launch id. `req.preset` is not stored.
- **The Fleet shows one job per project card**, the one `primaryJob` picks (`web/src/fleet/card.tsx:585`,
  `web/src/shell/describe.ts:52`: unfinished beats finished, then the newest). The Project screen lists
  every job (`fleet/project.tsx:75`, `:338`).
- **Slots are fleet-wide, 7 by default** (`daemon/src/slots.ts:16`). One run takes one slot
  (`#slotsUsed`, `supervisor.ts:2980`). An orchestrator gives its slot back while its helpers run
  (`#awaitHelpers`, `supervisor.ts:1948-1963`). There is no per-job or per-project limit on runs.
- **The merge lock is a convention, not code.** It is written only in `docs/plans/wave-11-tracks.md` §0
  and wave-12's §0, and carried out by each stack's helpers, who read the plan. No code mentions it.
- **How the parallel waves were run (wave 11 and wave 12):** by hand. Each was N Spawn launches with
  the same preset ("orchestrated pipeline", `web/src/spawn/presets.ts:118-134`). The prompts differed
  only in the track number ("Run track **N** of `docs/plans/wave-12-tracks.md`…"), each with its own
  worktree, and in wave 12 its own named branch (`w12/t2-q1`).

## What P1 adds

On Spawn, with the orchestrated preset, a **stacks** control: **1 | 2 | 3** (one pill per number up to the
setting `conductor.launch.stacks`, 1 to 6, default 3), default 1. Choosing 2 or 3 launches that many jobs from one click, all with the same project, preset, roles,
models, autonomy and per-agent budgets. Each job gets its own worktree, branch and prompt.

### Each stack's prompt and branch: one template, numbered

- The prompt is one text with a placeholder, **`{track}`**, which becomes 1, 2, 3 in the stacks. For
  example, "Run track **{track}** of `docs/plans/wave-13-tracks.md`." Under the box, Spawn shows each
  stack's first line once the placeholder is filled in.
- With stacks above 1, a prompt without `{track}` is refused before launch: *"Each stack needs its own
  work: put {track} where its number goes."* Otherwise N identical orchestrators would do the same
  work N times.
- **The branch:**
  - **new branch per launch** (`.conductor/wt/<job>`): each job gets `conductor/<jobId>` as today.
    Nothing to name.
  - **new branch: <name>**: the name must contain `{track}` too (e.g. `w13/t{track}`), and each stack
    gets its own. Without `{track}` it is refused, since two jobs can't share a branch.
  - **default branch, in the folder**: not offered above 1 stack. N stacks editing one folder would
    clash, and nothing could be undone.
- Spawn does not read or parse the plan file. The plan is for the orchestrators to read, as it is now.
  The number is all Spawn supplies.

### One request, all or nothing as far as it can be

**`POST /api/jobs/batch`**, with body `{ jobs: CreateJobRequest[] }` (1 to the cap), answered by
`{ jobs: CreateJobResponse[] }`.

- The daemon checks every request first: agents, models, branch shape, and the cap
  (`stacksLimit()`: the setting `conductor.launch.stacks`, else 3; `STACKS_MAX = 6` and `DEFAULT_STACKS = 3` in `shared`). It also checks that the named branches are distinct and not
  already checked out.
- Then it calls `createJob` for each in turn.
- A worktree that fails mid-way (a git error on stack 2) leaves stack 1 launched. The reply is a 207
  that names which stacks started and which failed, and why. Spawn shows that, not a bare "Launch
  failed". Undoing stack 1 is not attempted: a job that has started has already spent.
- **No migration.** The jobs aren't linked in the database, so `jobs` is unchanged and 300 stays
  unused. (See option C for the linked version.)

### Slots, budget and the merge lock

- **Slots: unchanged.** A stack in pipeline mode runs one thing at a time, its orchestrator or its one
  helper (`pipelineSection`, `session/handoff.ts:602`). So N stacks want at most N slots. With fewer
  slots free, the rest wait in `pump` as any queued agent does. Spawn's note under the control says so
  when `stacks` exceeds the slot limit minus the slots in use (it already reads them for Settings,
  `web/src/settings/route.tsx:186`).
- **Budget: per stack, as now.** Each job's cap is the sum of its agents' caps (`jobCap`,
  `session/budget.ts:273`). Spawn's budget line says the total: *3 stacks × $500 = $1,500*.
  Nothing new is enforced. (Track 3's M2 makes budgets warn only. That doesn't change this.)
- **The merge lock stays the plan's.** Several stacks writing to one `main` need it, but its rules
  (who merges, how to renumber, never force-push) are the plan's. Wave 11's §0 has them, and the
  orchestrators read them there. P1 doesn't build a lock in the daemon or add rules to the prompts.
  Spawn's note under the control reminds you: *"Stacks that merge into one branch need the plan to say
  how (a merge lock, as wave-11-tracks.md §0)."* A daemon-held lock is a later lane if wanted (see
  the risks at the end).

### Web, file by file

- `web/src/spawn/launch.ts`
  - `stacksBodies(input, n)` → `CreateJobRequest[]`: fills `{track}` in the prompt and branch.
  - `stacksRefusal(prompt, method, branch, n)` → `string | null`.
  - Both pure, so `spawn/verify.ts` checks them.
- `web/src/spawn/route.tsx`
  - The **stacks** pills next to "helpers in all", shown only when `orchestrates(listed)`.
  - The per-stack preview.
  - `launch` posts to `/api/jobs/batch` when n > 1, and to `/api/jobs` as before when n = 1.
  - After a launch: "3 stacks launched", each with a link to its job.
- `web/src/spawn/endpoints.ts`: the batch endpoint.
- The choice is state of this launch and goes back to 1 after it, as a preset's edits do (Amendment 99).

### Daemon, file by file

- `routes/session.ts`
  - `POST /api/jobs/batch`.
  - The existing route's validation moves into a `parseCreateJob(body)` that both routes call, so
    their checks can't drift apart. This is the only change to the existing route.
- `session/supervisor.ts`: none. `createJob` is called N times.
- `shared/src/wire.ts`: `CreateJobsRequest` and `CreateJobsResponse`. `shared/src/stack.ts` (or
  wherever `PIPELINE_HELPERS_MAX` lives): `STACKS_MAX = 6`, `DEFAULT_STACKS = 3`.
- The setting: `conductor.launch.stacks`, read by a `stacksLimit()` beside `slotLimit()` (`daemon/src/slots.ts`), validated by a
  `settingRule` (1 to 6), shown in Settings beside the launch budget and the slots (`web/src/settings/route.tsx`), and
  read by Spawn for how many pills to show.

## Options

| | A. Web loops N `POST /api/jobs` | **B. One batch request (recommended)** | C. B plus a launch group in the database |
|---|---|---|---|
| What changes | `spawn/` only | `spawn/`, one route, wire types | B, plus migration 300 (`jobs.launch_id`), the Fleet card, and stop or pause for the group |
| The cap of 3 | only in the browser | in the daemon too | in the daemon too |
| A stack that fails to start | the others may already have launched, and Spawn knows only its own calls | checked as a whole first; a git failure mid-way is reported per stack | as B |
| The Fleet card | shows one of the N jobs (`primaryJob`), as for waves 11 and 12 | as A | shows "3 stacks", each with its state |
| Cost | smallest | small | about twice B: a migration, `Job.launchId` on the wire, Fleet UI |
| Undo | trivial | trivial: an added route | a migration stays forever |

**Recommendation: B.** It is the smallest change that makes the cap and the checks the daemon's, and it
needs no migration. C is what you'd want if three stacks of one project should show as one thing on the
Fleet. That can come later on top of B: a `launch_id` column added then would simply be empty for jobs
launched before it.

## Tests

- **`web/src/spawn/verify.ts`**
  - `stacksBodies`: three bodies; `{track}` filled in the prompt and the named branch; the same agents
    and budgets in each.
  - `stacksRefusal`: no `{track}`; a named branch without `{track}`; default branch with n > 1; n > 3.
  - n = 1 sends exactly today's body to `/api/jobs`.
- **`session/verify.ts`, a new section against the real route and supervisor**
  - A batch of 3 makes 3 jobs, 3 worktrees and 3 branches.
  - A batch of 4 is refused (400) and makes nothing; with the setting at 2, a batch of 3 is refused; at 4, a batch of 4 is made.
  - One stack with a bad model is refused (400) and makes nothing.
  - Two stacks with one named branch are refused (409) and make nothing.
  - A branch made to fail in git on stack 2 gives 207, with stack 1 kept and stack 2's reason.
  - `POST /api/jobs` still behaves as before.
- **A manual check:** launch 3 stacks with `{track}` from a real plan, see 3 jobs on the Project screen,
  each with its own prompt and branch.

## Risks and open questions

- **The Fleet shows one job of three** (A and B). This is how waves 11 and 12 already looked. C fixes
  it, as could a smaller web-only change to the card that lists every unfinished job. **Asked.**
- **A fixed 3 or a setting.** The TODO says "3 at most by default", which reads as a setting
  (`conductor.launch.stacks`, 1 to 6, default 3, beside `conductor.launch.budget`). The decision of
  15 Oct says "up to 3 per launch". **Asked.**
- **`{track}` as the word.** A plan may call them lanes or parts. The placeholder could be `{n}`
  instead. Cheap to change before launch, awkward after. **Asked.**
- **No daemon merge lock.** A lock held as a directory by convention breaks when a stack dies holding
  it (the 45-minute rule in wave-11 §0 is the stale-lock escape). Building one into the daemon, as an
  MCP tool that `merge-<id>` helpers take and Conductor releases when the job ends, would make that
  safe. Not P1; a candidate for wave 13.
- **Not read:** `web/src/fleet/project.tsx` beyond its job grouping, and `web/src/spawn/Pipeline.tsx`'s
  layout, where the pills will sit. The developer should look at both before placing the control.
