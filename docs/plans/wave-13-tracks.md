# Plan: wave 13, the open asks after wave 12, as two parallel tracks

**Status:** planned 16 Oct 2026 against `main` at `91df6ac`. The lanes are the four TODO.md
entries still open from 14-15 Oct ("Right now"), and two loose ends of wave 12. Each lane's
**specification** is its TODO entry; this file says how they're grouped, ordered and run, and §3
answers every **Decide:** in them, so neither stack has to stop to ask.

## 0. Rules for every lane (both tracks)

[wave-12-tracks.md](wave-12-tracks.md) §0 holds as written (which keeps
[wave-11-tracks.md](wave-11-tracks.md) §0): one Build Stack per track, a lane's branch is the
job's branch, a developer, a reviewer and a `merge-<id>` helper per lane, the merge lock at
`~/.conductor/merge.lock`, the rebase, renumbering to the top amendment plus one, `make test`
green, merging and pushing from the main checkout, and never force-pushing. These are the changes:

- **Two stacks.**
- **Nothing to ask.** §3 answers every Decide. A stack asks the user only if it finds something
  §3 doesn't cover (a rebase conflict in the other track's code, a check it can't make pass).
- **Fixed numbers.** Migration **310** is track 1's, only if W1's design note shows it needs one
  (§3 expects it not to). Nothing else may add one without asking. Check sections are numbered at
  merge, after the top one on `main` (32 today, `session/verify.ts:8244`).
- **Files both tracks edit:** `CONTRACT.md` (top), `docs/MANUAL.md`, `TODO.md`, and
  `session/supervisor.ts`. In supervisor.ts track 1 owns the retry branch of `#settle` (`:1290`),
  boot-time `reconcile` (`:494`), and `hold`/`release` (`:2520`, `:2532`); track 2 owns
  `#launchWithPrompt` (`:2282`) and its settle (`:2349`). Keep those edits additive and local to the
  lane's functions. A rebase conflict in the other track's code means stop and ask, not rewrite.
- **Finish a track** by ticking its TODO entries (with *Decided* and *Done* lines, as before),
  then end with each lane's amendment number and merge commit, what was cut and why, and anything
  left for the user.

## 1. The tracks

| Track | Lanes, in order | Main files | Migration |
|---|---|---|---|
| 1 Never give up on the model | **W1** | `session/retry.ts`, new `session/outage.ts`, `#settle`/`reconcile`/`hold`/`release` in `supervisor.ts`, `session/alerts.ts`, `session/models.ts`, the backends' `listModels`, the job status rollup, `web/src/attention/`, the status bar | 310, if needed |
| 2 Small fixes | L1 → E1 → T1 → H1 | `#launchWithPrompt` in `supervisor.ts`; `web/src/spawn/` (`autonomy.ts`, `route.tsx`), `web/src/agent/composer.tsx`, `backends/copilot.ts`; `routes/term.ts`, `routes/terminal.ts`, `web/src/agent/TermPanel.tsx`; `session/verify.ts`, `session/alerts.ts` (`#dailySince`/`#monthlySince` only), `TODO.md` | — |

**Why these cuts:** W1 is one large lane that touches how an agent fails, how it's resumed after a
restart and how it shows, so it runs alone and starts with a design note. Track 2 is four small
lanes that touch none of W1's functions. L1 goes first because it's a bug fix in supervisor.ts and
lands before W1 reaches its rebase. H1 is last because it renumbers check sections and edits TODO
items that the other lanes also tick.

**Slowest path:** track 1. Two stacks need at most two slots at once; the default is 7
(`daemon/src/slots.ts:16`).

## 2. The lanes

### Track 1

- **W1 · Never give up on the model: wait for it to come back, then resume.** *Spec:* TODO "Never
  give up on the model…", with §3's answers. **Design note first**, `docs/plans/w1-design.md`,
  reviewed by the stack's reviewer before any code (the user's approval isn't needed; §3 settles the
  hard-to-undo choices). It must say, with file:line:
  - how "waiting for the model" is stored: the agent `paused` with a status note, as Pause all
    stores `HOLD_NOTE` (`supervisor.ts:239`, read back with `lastStatusNote`, `:2536`); the provider
    from the agent's engine; "since" from that status event. This survives a restart, so
    migration 310 should not be needed; if it is, say why.
  - which agents wait: the ones whose short retries are spent (`decideRetry`, `retry.ts:169`, gains
    a third answer). `ACCOUNT_ERRORS` and `NEVER_BETTER` still don't wait. Since Amendment 180 no
    budget pauses anything, so the TODO's "Conductor's own budget pause" line is moot: a ⏸, Pause
    all, or a stop is a decision, not an outage, and isn't waited on.
  - the probe: one per provider, at 30 s, 1, 2, 5 and 15 min, then every 15 min, on `retry.ts`'s
    `Clock`. Claude's is `session/models.ts:80-112`'s `GET /v1/models`; Copilot and OpenRouter use
    their backend's `listModels()`. It also runs when the clock jumps and on **retry now**. A
    `Retry-After` or a usage limit's reset time replaces the schedule until then.
  - the resume: one agent first, the rest a few seconds apart after it answers
    (`RetryBook.answered`, `retry.ts:328`). Nothing resumes while Pause all holds (`#hold`), and
    `release()` (`:2532`) still resumes only `HOLD_NOTE` agents. A waiting agent that Pause all
    finds is left waiting.
  - after a restart: `reconcile` (`:494`) puts a waiting agent back in its provider's outage, not
    in the RESTART_NUDGE path.
  - how the job reads: a job whose only unfinished agents are waiting for the model shows as
    running. `rollupStatus` (`shared/src/events.ts:406`) works on statuses alone, so say where the
    note is taken into account, and keep `AgentStatus` (`events.ts:26`) unchanged.
  - the card: one per provider in Needs You, from the outage alert that exists
    (`alerts.ts:256`, `:293`): "can't reach the model since 14:02 — 6 agents waiting, next check
    14:47", with **retry now**, **stop waiting** (also on each agent; it ends them `failed` as
    today) and a link to the agents. The status bar shows the provider is down.

  *Verify:* a new section in `session/verify.ts`, driving the `Clock`:
  - an agent whose tries are spent is paused with the note, and its job still reads running;
  - the probe schedule backs off to 15 min and stays there;
  - when the probe answers, one agent resumes, then the rest are staggered;
  - a restart mid-wait rejoins the outage;
  - Pause all during an outage resumes nothing until it's released;
  - **stop waiting** ends the agent `failed`;
  - an auth error still goes straight to Needs You;
  - a `Retry-After` is honoured;
  - a new launch on a provider that's down joins the wait after its short tries.

  Add a web check in `web/src/lib/verify.ts` for the card's words and buttons.

### Track 2

- **L1 · A decision that lands while a messaged run is finishing is lost.** *Spec:* TODO "A
  decision that lands while a messaged run is finishing is lost". Nothing to decide. Follow
  `#resumeWanted` (`supervisor.ts:442`) in `#launchWithPrompt`'s settle (`:2349`), as `#launch`
  does at `:1214`. *Verify:* `session/verify.ts` §15, beside the unwinding-relaunch check. A decision
  that lands during a run started by a message, by a `'slot'` message, and by the ask to hand off
  each relaunches once, and only once.
- **E1 · An effort the model doesn't take.** *Spec:* TODO "An effort the model doesn't take", with
  §3's answer. Spawn's effort choice (`web/src/spawn/route.tsx`, from `EFFORTS` in `autonomy.ts`)
  and the composer's (`composer.tsx:640`) offer only the efforts the chosen model's list names
  (`efforts`, `shared/src/wire.ts:490`, filled by `backends/copilot.ts:230`). Where the list names
  none (Claude, OpenRouter), they offer all five. A choice the newly picked model doesn't take moves
  to the nearest one it does, and says so. The Copilot backend drops an effort the model doesn't
  list rather than send it, with one line in the transcript, so a `start_helper` or a saved default
  can't fail a run either. *Verify:* `web/src/spawn/verify.ts` and the composer's checks, and a backend
  check that an unlisted effort isn't sent.
- **T1 · A terminal opens in the project's root folder.** *Spec:* TODO "A terminal opens in the
  project's root folder…", with §3's answer. Every terminal starts at the project root
  (`project.path`). That includes the agent screen's **›_ terminal** tab (`agentAt`,
  `routes/term.ts:84-88`) and the old command runner (`cwdOf`, `routes/terminal.ts:30-34`), as the
  Terminal dock does (`:89-92`). `TermPanel.tsx`'s title says which folder and branch the shell is
  in. For an agent in its own worktree, it says the agent's changes are in
  `.conductor/wt/<jobId>`, with a copyable `cd` line. *Verify:* the term route's checks: an agent's
  terminal in a worktree job starts at `project.path`, and its title names the folder and branch.
- **H1 · Housekeeping.** No TODO entry; the list is here. Nothing to decide.
  - Move check section 31 (`session/verify.ts:7984`, Amendment 181) after 30 (`:8076`), so the
    sections run in order.
  - Prune `#dailySince` and `#monthlySince` (`alerts.ts:206`, `:236`) to the current day and month,
    so they don't grow for as long as the daemon runs.
  - Bring TODO.md's "Checks that need a person" up to date with Amendment 180. "$1 budget: stop
    at $2" becomes "warns at $1, keeps going". The midnight check's "an agent paused at its
    ceiling stays paused" is dropped. In "Look at what was built in Amendments 99-129", add
    wave 12's screens: the Fleet card's fold, the monthly budget in Settings and on a card's
    Edit, Metrics' By project table, and the status bar's month.
  - Record §3's 167 decision under wave 12 §5.

  *Verify:* `make test`.

## 3. Decided (16 Oct)

| Item | Decision |
|---|---|
| Running | Two Build Stacks at once, one per track; each merges and pushes its own lanes |
| Budget | $500 per stack (a warning only, since Amendment 180) |
| W1, the status | **`paused` with a reason** (a status note, as Pause all's `HOLD_NOTE`), not a new `AgentStatus` |
| W1, the probe's cap | **15 min**: 30 s, 1, 2, 5, 15 min, then every 15 min |
| W1, a limit | **None**: an agent waits until the model answers or you press **stop waiting** |
| W1, the job | Shows as **running** while its agents wait; the outage card in Needs You says what's waiting |
| W1, new launches | **Allowed to try**: they join the wait after their short tries |
| E1 | Offer the model's listed efforts; all five where the list says nothing |
| T1 | **Every terminal opens at the project root**, the agent's tab too; its title says the folder and branch, and where the agent's changes are |
| Amendment 167's job budget | **Kept per task**, as now: since 180 a job budget only warns, and 182's monthly project budget keeps a lasting total. No lane |

## 4. Launch

Each track is a Build Stack on project `conductor` (`prj_e1242060-a07`), isolation `worktree`.
The architect orchestrates developer (opus), reviewer (sonnet) and validator (sonnet). Both are
started from Spawn as one launch of two stacks (Amendment 181), with branch `w13/t{track}`. The
job's prompt is:

> Run track **{track}** of `docs/plans/wave-13-tracks.md`. Read its §0 and your track's row in §1,
> then each lane in §2 and its TODO.md entry, and work the lanes in order. §3 answers every
> **Decide:**; ask the user only about what it doesn't cover. Commit and push through the merge lock
> as §0 says. When the track is done, tick its TODO entries and report.

Track 1 is W1, track 2 is L1 → E1 → T1 → H1.

## 5. After both

For the user, not a stack:
- Restart the daemon (pause all, `make restart` in the main checkout, resume) so wave 13's code is
  live.
- One supervised session against a real model, with a small budget: TODO's "Checks that need a
  person", as H1 leaves them, ending with an outage (the network off mid-run) to see W1 wait and
  resume.
- Delete the merged branches and finished worktrees (`git branch`, `.conductor/wt/`), or use
  Branches' clean-up (Amendment 143).
