# Plan: wave 12, the asks of 15 Oct, as three parallel tracks

**Status:** planned 15 Oct 2026 against `main` at `3b442a2`. The lanes are the nine TODO.md entries
added that day (Right now, "Asked for (15 Oct)") and the loose ends of Amendment 167. Each lane's
**specification** is its TODO entry; this file says how they're grouped, ordered and run. Two are
top priority, and each leads its track.

## 0. Rules for every lane (all tracks)

[wave-11-tracks.md](wave-11-tracks.md) §0 holds as written: one Build Stack per track, a lane's
branch is the job's branch, three helpers per lane (developer, reviewer, `merge-<id>`), the merge
lock at `~/.conductor/merge.lock`, the rebase, renumbering to the top amendment plus one, merging and
pushing, and never force-pushing. These are the changes:

- **Three stacks, not six.**
- **Decide first.** A lane whose TODO entry has a **Decide:** asks the user with the question tool
  before building, unless §3 already answers it. It offers the options the entry names, with a
  recommendation. The answer goes into the TODO entry as *Decided (date): …*. Lanes with nothing to
  decide come first in each track, so a stack has work while its questions wait.
- **Fixed numbers.** Migrations: **285** B1 (decided 16 Oct), **290** M3, **300** P1, if they need one. Nothing else may add one
  without asking. (260 and 280 were wave 11's, R2 and G1, and are left alone.)
- **Files several tracks edit:** `CONTRACT.md` (top), `docs/MANUAL.md`, `TODO.md`,
  `session/supervisor.ts` (all three: track 1 in `#launch` and what it reads, track 2 in
  `sendMessage`, `#sendWhenDone`, `startHelper` and `#clearFinishedHelpers`, track 3 in `#settle`'s
  budget branch), and `session/store.ts` (track 1 `DEFAULT_AUTONOMY`, track 3 the spend reads). Keep
  those edits additive and local to the lane's functions. A rebase conflict in another track's code
  means stop and ask, not rewrite.
- **Finish a track** by ticking its TODO entries, then end with each lane's amendment number and
  merge commit, what was cut and why, and anything left for the user.

## 1. The tracks

| Track | Lanes, in order | Main files | Migration |
|---|---|---|---|
| 1 Spawn and permissions | **B1** → S1 → S2 | `web/src/spawn/` (`autonomy.ts`, `presets.ts`, `RoleRow.tsx`, `Pipeline.tsx`, `route.tsx`, `verify.ts`), `DEFAULT_AUTONOMY` in `store.ts`, `#launch` in `supervisor.ts`, `routes/session.ts` (`/autonomy`, `/model`) | — |
| 2 Orchestrators | **Q1** → C1 → P1 | `supervisor.ts` (as above), `session/schedule.ts`, `routes/helpers.ts`, `session/handoff.ts` (the orchestrator sections), `web/src/agent/scheduled.tsx`, `composer.tsx` | 300 |
| 3 Money, data and the Fleet | F1 → K1 → M2 → M3 | `web/src/fleet/card.tsx`, `fleet.css`; `daemon/src/db/` (new `backup.ts`), `Makefile`; `session/budget.ts`, the spend reads in `store.ts`, `#settle`; `web/src/metrics/`, the Fleet's spend line | 290 |

**Why these cuts:** each track owns its main files. **Track 1** is everything Spawn launches with, and
B1 goes before S1 because S1 decides whether "Bash by default" also reaches agents already launched.
**Track 2** is everything an orchestrator does after launch; P1 is last because it is the largest and
needs a design before any code. **Track 3** has budgets and spend: M2 and M3 both rewrite
`budget.ts`, so they run one after the other; F1 and K1 touch nothing else here and go first.

**Slowest path:** track 3, four lanes, though F1 is small. Track 2's P1 may be the single longest
lane. Three stacks need at most three slots at once (an orchestrator gives its slot back while its
helper runs); the default is 7 (`daemon/src/slots.ts:16`).

## 2. The lanes

Each lane's spec is its TODO.md entry (title in bold). What's here is the order, the decision it
waits on, and how it's checked.

### Track 1

- **B1 · Every agent has Bash by default. TOP PRIORITY.** *Spec:* TODO "Every agent has Bash by
  default". *Decide:* new launches only, or existing agents too (recommend new launches only; S1
  covers the rest). *Verify:* `spawn/verify.ts` checks that a default launch allows `Bash` with no
  prompt, a reading role is still refused it (`readOnlyRefusal`), and `Bash(git push:*)` is still
  denied without **allow push**. The checks at `:273` and `:489` change with it.
- **S1 · A changed setting takes effect on the next run.** *Spec:* TODO "A changed setting takes
  effect on the next run". *Find first*, then report to the user before building: which settings
  (model, autonomy, persona prompt and skills, budget) a run reads from the row and which it copies at
  launch, with file:line. *Verify:* `session/verify.ts`, with each setting changed between two runs,
  the second run's options carrying the change.
- **S2 · "one agent" lets you pick what kind of agent.** *Spec:* TODO "'one agent' lets you pick
  what kind of agent". *Decide:* remember the last pick per project, or always start at developer.
  Reuse `RoleRow`. *Verify:* `spawn/verify.ts`, where the default is still developer (`:766`) and a
  picked persona launches as that persona with its prompt and skills.

### Track 2

- **Q1 · Queue a command to the orchestrator. TOP PRIORITY.** *Spec:* TODO "Queue a command to the
  orchestrator". *Decide:* the two options in the entry. Note Amendment 168 (a message sent with
  every slot taken waits for a slot) and Amendment 167 (a non-synthetic message clears finished
  helpers). Say in the amendment which one a queued message triggers, and when. *Verify:*
  `session/verify-schedule.ts` or `verify.ts` §17c: a message queued on a working orchestrator is
  sent exactly once, when the decision says.
- **C1 · Amendment 167's loose ends.** No TODO entry; the list is here. (a) An event on the
  orchestrator saying N helpers were removed, shown in its transcript. (b) Checks that a refused
  message (budget reached, folder gone) and **re-run from here** remove nothing. (c) A check of the
  "shell still running" rule, with a stub terminal if the suite can't open a PTY. Nothing to
  decide. *Verify:* `session/verify.ts` §17c, plus `web/src/agent/verify.ts` for how (a) shows.
- **P1 · How many orchestrators parallel work may set up (3 by default).** *Spec:* TODO "When work
  is run in parallel…". *Decide first, in a design note* (`docs/plans/p1-design.md`, read and
  approved by the user before any code): an orchestrator starting other orchestrators, or Spawn
  launching several stacks from one plan; per launch or for the whole fleet; how the merge lock and
  slots apply. *Verify:* as the design note says.

### Track 3

- **F1 · Fleet cards: the agent list shows and collapses, collapsed by default.** *Spec:* TODO
  "Fleet cards: …". Nothing to decide. Keep Amendment 169's navigator fold as it is. *Verify:*
  `web/src/lib/verify.ts`, where the Fleet's checks are: collapsed on first load, the choice kept per card,
  and an agent that needs you still visible when collapsed (its count on the toggle).
- **K1 · Back up the database regularly, and bring the last backup back.** *Spec:* TODO "Back up the
  database regularly…". *Decide:* how often, how many kept, where restore lives (recommend: on
  daemon start and every 6 h, the last 10 kept, restore as a `make` target that refuses while the
  daemon is running). *Verify:* a new `daemon/src/db/verify-backup.ts`, added to `make test`: a backup made while the daemon is writing
  opens and passes `PRAGMA integrity_check`, pruning keeps N, and restore brings back the latest.
- **M2 · A budget that's exceeded doesn't stop anything.** *Spec:* TODO "A budget that's exceeded…".
  *Decide:* bug report or wanted change, and which budgets. Nothing is built until it's answered.
  *Verify:* `session/verify.ts` §27 and the budget sections, which change with the decision.
- **M3 · Monthly spend and a monthly budget.** *Spec:* TODO "Monthly spend and a monthly budget…".
  *Decide:* local month or not; per agent, per project, the fleet, or several. A month's figure is a
  sum over the daily tables, so migration 290 only if the monthly cap needs a column. *Verify:* the
  spend sections of `session/verify.ts`: a month's total, 0 after the month turns, and the cap
  holding as the daily one does.

## 3. Decided (15 Oct)

| Item | Decision |
|---|---|
| Running | Three Build Stacks at once, one per track; each merges and pushes its own lanes |
| Priority | B1 and Q1 lead their tracks |
| Budget | $500 per stack |
| B1 | Bash by default for new launches **and** agents already launched: every agent's autonomy allows Bash, except reading roles (still read-only) and `Bash(git push:*)` without **allow push** |
| S2 | Spawn remembers the last pick of **one agent** per project; developer the first time |
| Q1 | A message queued on an orchestrator goes at its **next wake**, alongside its helpers' reports, not after everything |
| P1 | **Spawn launches several stacks from one plan**, up to 3 per launch, each its own job. The design note (`docs/plans/p1-design.md`) still needs the user's approval before code |
| K1 | A consistent backup (`VACUUM INTO`) on daemon start and every 6 h, the last 10 kept in `~/.conductor/backups/`, restore as a `make` target that refuses while the daemon runs |
| M2 | The wanted change: **budgets only warn and never stop work**, the agent's and the job's, with no ceiling |
| M3 | A **local** month, as the day is. A monthly budget for the **whole fleet** and for **each project**, beside the daily ones |
| B1, how existing agents get Bash (16 Oct) | A **one-time migration 285** adds `Bash` to `allowedTools` for every agent that isn't a reading role. After it, the row is the truth: Bash turned off later stays off, as "ask me". 285 is reserved for it |
| Reviewers (16 Oct) | In wave 12's stacks the **reviewer runs Bash without asking** (tests, `git diff`, `git show`). It still may not edit or write files, and `git push` stays denied. On 15 Oct both reviewers stopped on their first command and waited 10 h |

Every **Decide:** above is answered here (15 and 16 Oct), so the stacks don't stop to ask. P1's design note
is the one approval still due, before P1's code.

## 4. Launch

*16 Oct: the first launch (15 Oct, jobs `job_eb84c829-d1b`, `job_048b5a32-785`, `job_778a2d6e-557`) ended when the
database was reset. Its work so far is on two branches, not reviewed or merged: Q1 on
`conductor/job_048b5a32-785` (`0d039ff`) and F1 on `conductor/job_778a2d6e-557` (`3d1d9d3`). A relaunch should
start tracks 2 and 3 from those and review them first. Not relaunched yet, by the user's choice.*

Each track is a Build Stack on project `conductor` (`prj_e1242060-a07` since the database was reset on 16 Oct), isolation `worktree`, with
the architect orchestrating developer (opus), reviewer (sonnet) and validator (sonnet). The job's
prompt is:

> Run track **N** of `docs/plans/wave-12-tracks.md`. Read its §0 and your track's row in §1, then each
> lane in §2 and its TODO.md entry, and work the lanes in order. Ask the user each lane's **Decide:**
> that §3 doesn't answer, before building it. Commit and push through the merge lock as §0 says.
> When the track is done, tick its TODO entries and report.

## 5. After all three

For the user, not a stack:
- Try Amendment 167 in the app: an orchestrator with two helpers finishes, you send it a new task,
  the old helpers leave the Fleet, and new ones start as `-api`, not `-api-2`.
- Delete the empty `packages/daemon/conductor.db` left by a mistaken `sqlite3` call (gitignored).
- Amendment 167's job budget: removing helpers lowers the job's spend today and its cap together, so
  a job's daily budget is in effect per task. Keep that, or count removed helpers' spend against the
  job (a lane for wave 13).
