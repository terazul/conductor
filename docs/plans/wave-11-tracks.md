# Plan: wave 11, the rest, as six parallel tracks

**Status:** planned 15 Oct 2026 against `main` at `65b12ab`. Supersedes the *shape and order* of
[wave-11.md](wave-11.md) §1, §3 and §4. Each lane's **specification** is still its section in
wave-11.md (Problem, Do, Verify), and its decisions are still wave-11.md §6. This file adds the
lanes that TODO.md has and wave-11.md doesn't, and says how the six tracks run side by side.

Wave 1 is done: Amendments 149-154 (`fd6b019`, `6a74150`).

## 0. Rules for every lane (all tracks)

wave-11.md §0 holds, with these changes for running six stacks at once:

- **One stack per track.** Each track is its own Build Stack job, with its own worktree. Its
  orchestrator (the architect) runs the track's lanes **in the order listed**, one helper at a
  time, as its prompt says.
- **A lane's branch is the job's branch.** Don't switch branches in the job's worktree (Conductor
  records it): the lanes of one track run one after another on the job's own branch
  (`conductor/job_…`, `git branch --show-current`). Start each lane with
  `git fetch origin && git rebase origin/main`, so it begins from everything merged so far.
- **Each lane is three helpers, named by the lane:** developer `<id>` (build, `make test`,
  commit on the job's branch), reviewer `<id>` (reads the diff against the lane's spec and §6;
  passes, or lists what to fix), developer `merge-<id>` (rebase, renumber, merge, push, as below).
  A failed review sends `<id>` back to the developer, and then the reviewer again (each at most
  twice, Amendment 151). Run a validator only where the lane says so.
- **The merge lock.** Six tracks merge into one `main`. Only the holder of the lock may touch the
  main checkout (`/Users/dtavares/development/conductor`) or push.
  - Take it: `mkdir ~/.conductor/merge.lock` (atomic; it fails while someone else has it). Then
    write your track and lane into `~/.conductor/merge.lock/owner`. If `mkdir` fails, wait 60 s and
    try again. If the lock is over 45 min old, read `owner`, and remove the lock only if that
    track's job is no longer working (`curl -s localhost:7777/api/jobs`).
  - Holding it, in the job's worktree: `git fetch origin && git rebase origin/main`; resolve any
    conflict by keeping both sides' intent (the other lane's text is never reworded); renumber this
    lane's amendment to **the top one in CONTRACT.md plus one**, and fix every place the lane cites
    its own number (CONTRACT, MANUAL, TODO, code comments); `make test` green.
  - Still holding it, in the main checkout: `git pull --ff-only origin main`, then
    `git merge --no-ff <the job's branch> -m "Merge Amendment N: <outcome>"`, then
    `git push origin main`. If the push is refused, the lock was broken: start the step again.
  - Release it: `rm -rf ~/.conductor/merge.lock`.
  - Never leave the main checkout dirty or on another branch; never force-push.
- **Fixed numbers.** Migrations: **250** R3, **260** R2, **270** H1, **280** G1. Amendment numbers
  are not planned: each is the top one plus one at the moment of its merge.
- **Files several tracks edit:** `CONTRACT.md` (top), `docs/MANUAL.md`, `TODO.md`, `Makefile`
  (`test`), `shared/src/wire.ts`, `session/supervisor.ts` (tracks 1, 2 and 5). Keep these edits
  additive and local to your lane's functions. A rebase conflict in someone else's code means
  stop and ask, not rewrite.
- **Budget.** Each stack has $500. When a lane is cut for budget, the order is wave-11.md §7's:
  H2, M1, N6, then G1's "when done".
- **Stop and ask the user** (question tool) only when wave-11.md §0 says to, or when a rebase
  conflict isn't yours to resolve. G1's design note is read by track 3's architect, who asks the
  user only if it departs from wave-11.md §6 G1 or this plan.
- **Finish a track** by ticking its TODO entries, then end with: each lane's amendment number and
  merge commit, what was cut and why, and anything left for the user.

## 1. The tracks

| Track | Lanes, in order | Main files | Migration | Spec |
|---|---|---|---|---|
| 1 Queue and outage | R3 → A2 → R2+N1 | `session/supervisor.ts` (`#settle`, slots), `session/schedule.ts`, `session/retry.ts`, new `session/outage.ts`, `alerts.ts` | 250, 260 | wave-11.md §3 S2, S3, S4 + §6 R2, R3, A2 |
| 2 Hand-off | N9 → H3 → H2 → N13 | `session/handoff.ts`, `#promptFor` in `supervisor.ts`, the hand-off card | — | wave-11.md §4 L1, L2, L3, P |
| 3 Branches and GitHub | N3 → N4 → G1 | `workspace/branches.ts`, `workspace/finish.ts`, `web/src/branches/` | 280 | wave-11.md §3 I1, §4 I2, I3 |
| 4 Files and navigator | N5 → N6 → FH | `workspace/tree.ts`, `web/src/files/`, `web/src/shell/navtree.ts` | — | wave-11.md §3 E2, J; FH below |
| 5 Models and engines | O1 → X1 → H1 | personas and model choice, `web/src/spawn/engine.ts`, `session/backends/`, `session/windows.ts` | 270 | wave-11.md §3 D2, §4 M; X1 below |
| 6 Screens and docs | U1 → O3 → M1 → D4 | the theme tokens, the orchestrator's transcript view, `web/src/metrics/`, `docs/adr/0001-preset-stacks.md` | — | wave-11.md §3 H, G, K; D4 below |

**Why these cuts:** each track owns its main files, so lanes in different tracks rarely meet
before the rebase. Tracks 1 and 2 both edit `supervisor.ts`, which wave-11.md ran one after the
other. The user decided on 15 Oct to run them side by side: track 1 changes `#settle`, the slot
queue and the boot-time resume; track 2 changes `#promptFor` and `handoff.ts`. The lock's
rebase sorts out the rest. H1 is in track 5, not track 2, because it is about where model
windows come from (`windows.ts`, the Claude backend); H2 in track 2 only reads the registry.

**Slowest path:** track 2, four lanes; tracks 1, 3 and 6 are close behind. Six stacks need at
most six slots at a time (an orchestrator gives its slot back while its helper runs); the
default is 7 (`daemon/src/slots.ts:16`).

## 2. Lanes not in wave-11.md

### FH — Fold an orchestrator's helpers once it is done (track 4)

The TODO entry "Fold an orchestrator's helpers once it is done" (TODO.md, Right now) is the spec.
In short: in the navigator (`web/src/shell/navtree.ts:151-238`), once an orchestrator has ended,
its ended helpers fold into one row under it ("↳ 12 helpers · all done"), opened and closed like
the other nodes (`conductor.navTree`); a helper that hasn't ended or needs you stays out of the
fold; the fold's dot is the worst status inside it. Display only. Reuse `nestHelpers`
(`web/src/fleet/nest.ts:18`). The Project screen's lanes may take the same fold. Checks in
`web/src/shell/verify.ts`. After N6, because both edit the navigator.

### X1 — Do non-Claude engines drop effort or plan mode? (track 5)

wave-11.md §8's open question. `autonomyOn` (`web/src/spawn/engine.ts:42-53`) keeps `effort` only
when the engine's `caps.effort` says so, and turns plan mode into `default` when `offersMode` says
the engine has none (`:37-39`). Trace for Copilot and OpenRouter:
- whether `GET /api/providers`' `capabilities.effort` and `planMode` match what each backend in
  `daemon/src/session/backends/` actually does with `autonomy.effort` and `mode`;
- whether a dropped choice is shown to the person before launch (Spawn's row note,
  `rowOverrides`, `spawn/presets.ts`), or silently lost;
- the same for "+ agent" on a running job (`web/src/spawn/stack.ts`).
If nothing is lost, the amendment records the trace with file:line and closes the question; if
something is, fix it, test it, and say which. Small.

### D4 — ADR 0001's stale risks (track 6)

`docs/adr/0001-preset-stacks.md:97-98`: the "Handoff growth" and "The architect asks questions"
risks. Check each against what was built since (the transitive hand-off and caps of Amendment 120
and N9, the windows registry `session/windows.ts`, the question gate of Amendment 76 on Copilot
and OpenRouter). Mark each as answered, with the amendment, or say plainly what is still unknown.
Do it after track 2's N9 has merged if it has; otherwise say N9 is pending. Docs only; `make test`
covers the links.

### M1, also: the Metrics TODO entry (track 6)

M1 (wave-11.md §3 K) builds the cost-per-day chart. Besides that, tick TODO's **Metrics (122)**
entry: the Errors tile's denominator is already Claude's calls only
(`web/src/metrics/rules.ts:111`, :165); the per-project filter and the `lib/verify.ts` comment are
done (Amendment 136). The one left is that Claude's model-call time includes subagents while
`calls` counts main-loop turns. Say so where the time-per-call figure is shown (its tooltip), and
record it as a known limit.

## 3. Decided (15 Oct)

| Item | Decision |
|---|---|
| Running | Six Build Stacks launched at once, one per track; each merges and pushes its own lanes |
| Budget | $500 per stack |
| Tracks 1 and 2 | Side by side, though both edit `supervisor.ts` |
| Role rules ("tests only", "docs only") | Left as words, as O2 was: no enforcement, no lane. TODO's Hand-off entry is ticked by H3's lane with this decision |
| FH | Fold, display only, nothing removed |

## 4. Launch

Each track is a Build Stack on project `conductor` (`prj_ec2cacdb-a67`), isolation `worktree`,
the architect orchestrating developer (opus), reviewer (sonnet) and validator (sonnet), 48
helpers in all, $500. The job's prompt is:

> Run track **N** of `docs/plans/wave-11-tracks.md`. Read its §0 and your track's row in §1,
> then each lane's spec (wave-11.md, or §2 here), and work the lanes in order. Commit and push
> through the merge lock as §0 says. When the track is done, tick its TODO entries and report.

## 5. After all six

- The user: `make install && make restart`; the person checks of wave-11.md §5 (after waves 2
  and 3), and pasting the UI test plan into `docs/checks/ui-test-plan.md`.
- Recheck TODO.md for anything new that can be built.
