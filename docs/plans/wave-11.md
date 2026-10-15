# Plan: wave 11 (Amendments 148-169)

**Status:** planned 14 Oct 2026, nothing built yet. Written against `main` at `06ab549`.
Decisions are in §6.

**15 Oct: waves 2 and 3 now run as six parallel tracks; see [wave-11-tracks.md](wave-11-tracks.md).**
The lane specifications below still hold; §1's order and numbers don't.

Changed since the plan was first drafted:

- **R1 is done.** It is Amendment 147 (`be6a0fc`): what you click on Spawn is what runs, and a
  reading row says what its pin changed (`rowOverrides`, `spawn/presets.ts:454`). The lane is
  dropped. The plan's other R1 point, "+ agent drops mode and effort", turned out not to be a bug:
  147 traced both and they were never lost.
- **R2 was rewritten** by `06ab549` (TODO.md:22) as "wait for the model to come back, one probe
  per provider", with five open questions. That replaces lane S4's hourly-per-agent design, so S4
  waits for a new plan (§3).

## 0. Rules for every lane

- **Branch.** One lane is one item, on its own worktree off `main`, branch `conductor/w11-<id>`.
- **Before coding.** Read the item's TODO entry if it has one, and the newest three CONTRACT
  amendments (`CONTRACT.md:199` onward) to copy the format.
- **Amendment.** Each lane adds its own amendment at the top of CONTRACT:
  `### Amendment N — post-merge, applied. **<outcome>**`, then the files by package, the user's
  words with the date, an *Amends …* line, bold-led bullets with file:line, *Not done / not
  decided*, and *Verified*.
- **MANUAL.** Each lane updates the MANUAL section a person would read. A lane that changes
  nothing a person sees says so in its amendment.
- **Verify.** Tests go either in a new verify file, which also gets its own line in `Makefile`
  `test` (:171-201), or in a named section of an existing verify file. `make test` must be green
  before the merge.
- **TODO.** Most items here have no TODO entry: they came from analysis. Add the entry if it's
  missing, then tick it. Record each decision from §6 under **Decide:** as *Decided (14 Oct): …*.
- **Merge order.** Merge in the order shown. Rebase on `main` right before merging.
- **Files several lanes edit:** `CONTRACT.md` (top), `MANUAL.md`, `TODO.md`, `Makefile`,
  `shared/src/wire.ts`. Keep these edits additive. Never reword another lane's text.
- **Numbers.** Amendments go to whichever lane merges next, from **148**. Migration numbers are
  fixed: **250** R3, **260** R2, **270** H1, **280** G1. `db/index.ts:134-141` applies them in
  lexical order.
- **Line numbers** are as of `06ab549`. If one has moved, find the code by name. If the code
  itself is not what the lane says, stop and ask.
- **Stop and ask the person when:**
  - the code contradicts this plan;
  - a lane would change behaviour that a CONTRACT amendment records as intended and §6 doesn't
    cover;
  - `make test` fails for a reason outside the lane.
- **Hand-off.** End every lane with: what changed (file:line), how it was verified, what's not
  done, and any risk found.

## 1. Shape

| Wave | Lanes | Runs as | Why this order |
|---|---|---|---|
| 1 | S1 A1 · B A3 · C A4 · E1 N7 · F docs | 5 parallel lanes | bugs; no shared source files |
| 2 | S2 R3 → S3 A2 → (S4 R2, once replanned) · D2 O1 · G O3 · H U1 · I1 N3 · E2 N5 · J N6 · K M1 | 1 chain, then 7 single lanes | supervisor.ts is serial; E2 waits for E1 (tree.ts) |
| 3 | I2 N4 → I3 G1 · L1 N9 → L2 H3 → L3 H2 → P N13 · M H1 | 2 chains plus 1 single lane | builds on wave-2 branches and handoff work; L1 waits for the last S lane (supervisor.ts) |
| — | the person checks | person | after each wave (§5) |

**Merge order and the amendment numbers that fall out of it (if nothing slips):**
- **Wave 1:** 148 A1, 149 A3, 150 A4, 151 N7, 152 docs.
- **Wave 2:** 153 R3, 154 A2, 155 R2, 156 O1, 157 O3, 158 U1, 159 N3, 160 N5, 161 N6, 162 M1.
- **Wave 3:** 163 N4, 164 N9, 165 H1, 166 G1, 167 H3, 168 H2, 169 N13.
- *15 Oct: numbers shifted by one for the published Amendment 148; wave 1 is 149 A1, 150 A3,
  151 lane counting, 152 A4, 153 N7, 154 docs; wave 2 starts at 155.*

**Chains** (the lanes in a chain run one after another):
- **S:** `session/supervisor.ts`.
- **E:** `workspace/tree.ts`.
- **I:** `workspace/branches.ts`.
- **L:** `session/handoff.ts` and `#promptFor`.

---

## 2. Wave 1

### S1 — A1: a throw before `try` leaks a slot

**Problem.** `#launch` adds the agent to `#active` at `supervisor.ts:1225`, but the `try` starts
only at :1258. Between them run `#openRun`, the status writes, `emit`, and `createBackend` at
:1239-1253 together with its argument calls `#reachable`, `#rolesScope` and `personaScope`. If
any of that throws:
- the slot is never freed (the `finally` at :1279-1283 doesn't run);
- the row stays `working`, and `pump` skips it (:953);
- the promise is fire-and-forget (:970, :1293, :1945) and nothing handles an unhandled
  rejection, so on Node ≥22 the daemon crashes.

`#launchWithPrompt` has the same shape (:2141 / :2175 / :2187-2191).

**Do.**
- Put everything after `#active.add` under the `try`/`finally` that frees the slot, in both
  functions. A throw before `run()` ends as `launch_failed`/`resume_failed`, through the same path
  as :1267-1278.
- Give the fire-and-forget calls (:970, :1293, :1648, :1945, :1990) a logging `.catch`.

**Verify.** In `session/verify.ts` §13, beside :1735-1751, make `createBackend` throw, by a test
seam or an unregistered provider written straight to the row, and check:
- the slot count goes back to what it was;
- the agent ends `failed` with `launch_failed`;
- the next queued agent then launches;
- the same holds through `sendMessage`.

**Done when** `#active` never holds more ids than there are live runs.

**MANUAL.** None.

### B — A3: the arbiter matches the wrong request

**Problem.**
- `arbiter/index.ts:300-303` matches `toolUseId || toolName` against a list ordered oldest first
  (`store.ts:1043-1051`), so with two open Bash requests a call for R2 finds R1.
- Staged decisions sit in `#decided: Map<agentId, …>`: one per agent (:176). A second `decide`
  (:529-534) overwrites the first, and they are consumed by tool name only (:274-276).
- Copilot gives a re-offered call a fresh id (`copilot.ts:442`).

**Do.**
- Match by `toolUseId`. Fall back to the name only when exactly one open request has that name,
  or when the input is equal (check whether requests store their input).
- Keep staged decisions per request, consumed by id, or by name plus equal input.
- Keep the single-request park (`verify.ts:1993-1995`) and the MCP decline (:1985-1990).

**Verify.** In `session/verify.ts` §14 (:1807):
- with two open Bash requests, a call for the second parks on the second;
- R2's decision is never applied to R1's command;
- when both are answered before resume, both decisions survive;
- a Copilot-style call with a fresh id and one open request still parks.

**Done when** one request's decision can't reach another request's call.

**MANUAL.** None, unless the Needs You wording changes.

### C — A4: `/api/workspaces` takes any input

**Problem.** The routes are at `routes/workspace.ts:404-443`; the header at :29-39 says they are
"to be gated or removed at I4":
- **`jobId`** goes unchecked into `join(root, WT_DIR, jobId)` (`worktree.ts:220`), so `../`
  escapes `.conductor/wt`.
- **`projectId`** defaults to `prj_${jobId}` (:420) and is never looked up.
- **`repoPath`** can be any directory.
- **`branch` and `baseRef`** go to git unchecked.
- **DELETE** has no 404 for an unknown job and no check for live agents.
- **"Not a repository" and "no commits"** come back as 500 (`worktree.ts:181`, :236-238; `fail`
  :89-111).

The web uses GET and POST (`useWorkspace.ts:259`, :466-475), so these routes are gated, not
removed.

**Do.**
- `jobId` must match the shape the daemon generates.
- `projectId` must exist (404).
- `repoPath` must be the project path or one of its extraDirs (the `dirRoot` rule,
  `service.ts:306-332`).
- `branch` and `baseRef` must pass `git check-ref-format`.
- DELETE answers 404 for an unknown job and 409 while an agent is live; `force` is read strictly.
- GET can be scoped to a project.
- The two `ensure` errors become 400.

**Verify.** In `workspace/verify.ts` (:177-193), check each refusal. The existing callers must
still pass: `workspace/verify.ts` :489, :520 and :624; `verify-files-verbs.ts:305`;
`session/verify.ts` :621 and :863.

**Done when** no request can create or remove a worktree outside a known project.

**MANUAL.** None. Update the I4 note in the route header.

### E1 — N7: an ignored empty folder inside an untracked folder is listed

**Problem.** `emptyUnder` (`tree.ts:159-175`) never asks git whether a folder is ignored.

**Do.** Filter its candidates through `checkIgnore` (`git.ts:371-386`), and prune ignored
subfolders before recursing. Keep `MAX_EMPTY_PROBES` (:150).

**Verify.** In `workspace/verify.ts` (empty folders):
- an ignored empty folder under an untracked folder is hidden;
- a plain empty one is shown;
- a non-git root lists everything.

**Done when** Files matches `git status --ignored`.

**MANUAL.** Files: one line on which empty folders are shown.

### F — Docs: D1, D2, D3, the test plan and ADR 0001

*Decided (14 Oct): D2 drops the links.*

**Do.**
- **D1.** `TODO.md:14` gives a fixed number ("The next amendment is 148"), which goes stale.
  Change it to "the next number is the top of CONTRACT + 1".
- **D2.** `docs/ARCHITECTURE.md` doesn't exist. Remove the links to it, and point to `docs/adr/`
  where one is useful. The links are at:
  - `README.md:7`, :160 and :186
  - `docs/MANUAL.md:6`
  - `docs/adr/0002:116`
  - `docs/plans/multi-provider-lanes.md:14`
  - `docs/plans/multi-provider-backends.md:200`
- **D3.** Add auditor to the reading-role lists at `docs/MANUAL.md:372` and :443, matching
  `stack.ts:119` and MANUAL :541.
- **Test plan.** Add `docs/checks/ui-test-plan.md` with a placeholder heading; the person pastes
  in the UI test plan. Link it from the browser-check item at `TODO.md:102`.
- **ADR 0001.** Correct `docs/adr/0001-preset-stacks.md:14`. Its references
  (`supervisor.ts:685-689`, `handoff.ts:37-45`, the 8,000-character cap) were removed by
  Amendments 101, 104 and 120.

**Verify.** `scripts/verify-docs-links.mjs` (new, added to `make test`): every relative `.md`
link in README, MANUAL, TODO and `docs/` resolves to a file in git.

**Done when** the link check passes.

---

## 3. Wave 2

### Chain S: S2 → S3 → S4

#### S2 — R3: queue a message until the agent is done (migration 250)

*Decided (14 Oct): it's sent when the agent's turn ends as `done`. A pending question doesn't
count. On `failed` or `paused` it keeps waiting and shows that. One message per turn.*

**Problem.** Scheduled messages only know times (`140_scheduled.sql` `at TEXT NOT NULL`; `due()`
`schedule.ts:120-122`). The TODO entry is at `TODO.md:70`.

**Do.**
- **Migration.** `250_scheduled_trigger.sql` adds `trigger TEXT NOT NULL DEFAULT 'at'`, with the
  values `'at' | 'done' | 'slot'`. `'slot'` is for S3. For non-`at` rows, `at` = `created_at`,
  and `due()` reads only `'at'` rows.
- **Wire.** `ScheduledMessage.trigger` and `ScheduleMessageRequest {at?, trigger?, text}`
  (`wire.ts:829-844`).
- **Hook.** At the end of `#settle` (`sup:1359-1464`), when the result is `done`, send the oldest
  `'done'` row for that agent through `sendMessage`.
- **Composer.** A "⏲ when done" button beside "⏲ later" (`composer.tsx:562-570`).
  `ScheduledList` (`scheduled.tsx:30`) shows these rows and can cancel them.
- **Restart.** The rows persist, and none is sent until the agent next settles.

**Verify.** `session/verify-schedule.ts` §8:
- nothing is sent while the agent is working;
- it's sent once on `done`;
- a question doesn't trigger it;
- on `failed` it waits;
- two queued messages need two turns;
- cancel works;
- the rows survive a restart;
- a paused fleet holds them.

**Done when** you can line up follow-ups, each landing on its own new turn.

**MANUAL.** Agent → composer: "later" vs "when done".

#### S3 — A2: a sent message ignores the slot limit

*Decided (14 Oct): the message waits for a slot and survives a restart.*

**Problem.**
- `sendMessage` (`sup:1963-1992`) launches without a slot check.
- The Scheduler sends through it (`schedule.ts:209`).
- `#askToHandOff` (:1648) and the `#resumeWanted` relaunch (:1290-1295) don't check slots either.
- `resumeAgent` was given this fix in Amendment 35 (:2391-2397); `sendMessage` wasn't.
- Two things are intended and stay: the hold doesn't apply to your own message (:2345), and
  Amendment 132's brief overshoot (:2664-2668).

**Do.**
- When slots are full, store the message as a `'slot'` row (S2's table) and set the agent
  `queued`.
- `pump` sends the oldest `'slot'` row for an agent when it gives that agent a slot.
- The composer shows "waiting for a slot".
- Apply the same rule to `#askToHandOff` and `#resumeWanted`.

**Verify.**
- `session/verify.ts` §15 (:2046-2167): with all slots full, the live count doesn't rise; the
  agent launches with that exact prompt when a slot frees; the message survives a restart; a
  held fleet still delivers your message.
- `verify-schedule.ts`: a scheduled message waits the same way.

**Done when** nothing exceeds `slotLimit()` except the 132 overshoot.

**MANUAL.** Slots.

#### S4 — R2 + N1: wait for the model to come back (migration 260) — **needs a new plan**

**Don't build this from the text below.** `06ab549` rewrote the TODO entry (`TODO.md:22`): after
the usual short waits, the agent stops counting and waits for the model. One probe per provider
(`GET /v1/models` for Claude, `listModels()` for the others) runs on a schedule of 30 s, 1, 2,
5 and 15 min, then every 15 min. When the probe answers, the agents resume one at a time. A
`Retry-After` or a limit's reset time is honoured, and Needs You shows one card per provider.

That supersedes the 14 Oct "hourly, forever" answer. The entry has five open questions under
**Decide:**:
- a new agent status, or `paused` with a reason (`shared/src/events.ts:26`);
- a probe cap of 15 min or an hour;
- whether to give up after a day, or never;
- whether a job shows as running or as waiting;
- whether new launches on a provider that's down are held.

**Before S4 starts:** ~~the person answers those five questions~~ answered 14 Oct, see §6 R2. The
lane is built from the TODO entry (`TODO.md:22`) plus those answers; no separate analyst pass.

**What still holds from the earlier analysis:**
- `RetryBook` is memory only (`retry.ts:265-362`).
- On restart, `reconcile` (`sup:497-503`) resumes at once with a fresh count, as tested at
  `verify.ts:5925-5940`.
- `decideRetry` returns `out_of_tries` at `retry.ts:182`.
- Budget, auth and `NOT_THE_MODEL` stay unretried (`retry.ts:105-125`, :174, :180).
- The card and the banner are `AlertCard.tsx:307` and `Reconnect.tsx:16-49`.
- The tests are in `session/verify.ts` §23 (:5500).

**If S4 isn't ready** when S3 merges, chain L (wave 3) may start after S3 instead. S4 then
rebases onto L's supervisor changes.

### D2 — O1: an exact persona model falls back to sonnet

**Problem.**
- `tierOf` (`spawn/orchestrated.ts:32`) maps any non-tier model to `'sonnet'`.
- `ListedRole` (:24) can't hold an exact id.
- `helperRolesFor` (`presets.ts:335`) uses only the tier.

Amendment 147 rewrote `presets.ts` and `Pipeline.tsx`, so re-read both before changing them.

**Do.**
- Add `ListedRole.model?`, kept from the persona.
- `helperRolesFor` passes it on as `HelperRole.model`. `helperModel`'s tiers
  (`shared/stack.ts:250-272`) still work off `tier`.
- The role select in `Pipeline.tsx` shows the exact model. Its `rowOverrides` note (:70) is
  unchanged.

**Verify.** `spawn/verify.ts`, the orchestrated-roles section (§21): an exact Claude id and an
exact non-Claude id both survive, and tier personas are unchanged. §25 (Amendment 147) still
passes.

**Done when** a listed role runs its persona's model.

**MANUAL.** Spawn → Pipeline.

### G — O3: fold the orchestrator's long text by default

*Decided (14 Oct): O2 is accepted as it is. The orchestrator keeps its tools, and there's no
lane for it.*

**Problem.**
- The helper report (`handoff.ts:520-537`) arrives as a synthetic `user_text` (`sup:1262-1266`)
  and renders raw as an "auto" turn (`transcript.tsx:555-559`), with no fold.
- `replyKeys` (:525-527) leaves it out of fold all.
- `folds.ts:5-8` stores only folds you made.
- `inputSummary` (:285-295) has no `task` key.

**Do.**
- Make "auto" turns foldable under `u${seq}`.
- In an orchestrator's transcript they start folded. Detect the orchestrator with
  `marksOrchestrator`, `shared/stack.ts:300-305`, or `helperCap>0`, passed from
  `agent.tsx:788-794`.
- Add an "unfolded" set to `folds.ts`, so a default fold you open stays open and Amendment 18
  holds everywhere else.
- Fold all includes `u` keys, and `inputSummary` shows `task`.

**Verify.** `agent/verify.ts` (:220-233), with `renderToStaticMarkup`:
- an orchestrator's auto turn renders folded;
- a non-orchestrator's renders open;
- a default fold you open stays open;
- fold all covers the auto turns;
- a `start_helper` line shows its task.

**Done when** an orchestrator's page opens to its own replies.

**MANUAL.** Agent → transcript.

### H — U1: make the three backdrops easier to tell apart

*Decided (14 Oct): more chroma and a hue check. Violet `--you` stays, and no new backdrops are
added.*

**Problem.** `--here`, `--here-project` and `--here-agent` (`tokens.css:65`, :72-73 dark;
:160-162 light) differ in lightness by only 1.06–1.22. The checks (`lib/verify.ts:466-492`) set
a floor of 1.04 and nothing on hue.

**Do.**
- Make slate, petrol and wine more saturated at about the same lightness.
- Raise the pairwise floor to 1.06.
- Add a check that the three hues are at least 60° apart in OKLCH.
- Keep ink, ink2 and ink3 at ≥ 4.5:1 on all three. ink3 on the agent backdrop is at 4.57 dark
  and 4.59 light today.
- Keep "not a status colour" and "not `--you`".
- Revisit the crumb border (`ui.css:33`).

**Verify.** `lib/verify.ts` :466-492, with the new checks. `verify-crumb.ts:114-128` is
unchanged.

**Done when** the checks pass in both themes and the person confirms in the browser check that
the three are distinct at a glance.

**MANUAL.** Shell: the three backdrops.

### I1 — N3: pull and rebase on Branches

*Decided (14 Oct): rebasing a pushed branch is allowed, with a warning.*

**Problem.** `BranchAction` (`wire.ts:934-956`) has no pull or rebase. The rules in
`branches.ts:1-19`: never force, an explicit refspec, no prune.

**Do.**
- Add `pull{branch}` and `rebase{branch, onto?}`: parsed at `branches.ts:182-239` (including the
  detail list at :236), acted on in :800-933.
- **Pull** fetches, then runs `merge --ff-only @{u}` in the branch's worktree, with `sshEnv` and
  the timeout. It refuses (409) when:
  - the agent is live;
  - the branch isn't checked out;
  - there are tracked changes;
  - there's no upstream;
  - the branch isn't behind.
  A diverged branch gets "diverged — merge or rebase".
- **Rebase** goes onto `onto`, default `defaultBranch`. On conflict it runs `rebase --abort` and
  reports the files, as `mergeOne` does (:620-643).
  - When the branch has an upstream, the confirm warns: "this branch is pushed; after rebasing,
    the next push needs a force, which Conductor never does — you'd do it yourself".
  - After such a rebase, Push's refusal says the same.
- **Web.** Buttons beside Push (`route.tsx:620`), confirms like :664-674, and `rules.ts` helpers
  following the pattern of :118-151. Result text at :730-741.

**Verify.**
- `workspace/verify-branches.ts`:
  - a fast-forward pull works, and a diverged pull refuses;
  - a rebase works;
  - a conflict leaves the tree clean;
  - a pushed branch rebases, the warning shows, and the next push gets the force-needed
    refusal;
  - a live agent → 409.
- `branches/verify.ts`: the reasons and confirms.

**Done when** a branch can be brought up to date without a terminal, and Conductor never forces.

**MANUAL.** Branches: Pull, Rebase, and the force warning.

### E2 — N5: Changes and diffs miss nested repos (after E1)

**Problem.**
- `scanChanges` (`changes.ts:55-128`) runs only at the root, so a nested repo shows as
  `?? inner/`.
- `tree.ts:369-380` skips nested folders on purpose; ADR 0003:138 records the gap.
- `diffOf` (`service.ts:490-524`) and `#diffForPath` (:817-829) use the root only.

**Do.**
- Run `scanChanges` per nested repo (depth ≤ 4), prefix and merge the paths, and drop the opaque
  entry.
- Send each diff to the repo that owns its path.
- Update ADR 0003.

**Verify.** `workspace/verify.ts` §15 (~:1183-1254):
- badges and the roll-up show inside `inner/`;
- an inner file's diff is inner's diff;
- there is no `?? inner/`;
- a clean nested repo shows nothing.

**Done when** nested repos look like the root in Files.

**MANUAL.** Files.

### J — N6: drag to move in Files, and rename/delete in the Navigator

**Problem.**
- A move is a rename into another folder, and `renameOf` (`service.ts:652-712`) already supports
  it, but there's no drag and drop.
- The Navigator file rows (`Navigator.tsx:286-294`) have no verbs, and its folder rows
  (:300-322) have only Add.

**Do.**
- **Files tree.** Folder rows (`FileTree.tsx:280-320`, `data-path`) accept a native HTML5 drop
  using the MIME type `application/x-conductor-path`. That keeps it apart from project reorder
  (`Navigator.tsx:444-470`, :564-620). Follow `spawn/reorder.tsx:18-125`, including setData for
  Firefox (:88).
- **Keyboard.** A "Move to…" verb.
- **Same flow as rename.** A move calls `renameEntry` then `followRename`
  (`files/route.tsx:629-633`), so open tabs follow it.
- **Navigator.** Rename and delete, reusing `renameEntry`, `DeleteConfirm` and `closeDeleted`.

**Verify.**
- `files/verify.ts`: the drop rules (no dropping into itself or onto a file; a taken target
  refuses and the message shows), tabs follow the move, Move to… exists.
- `shell/verify.ts`: the Navigator rows have the verbs, and a project drag ignores a file drag.
- `verify-files-verbs.ts`: a move into a subfolder.

**Done when** files can be moved by drag or keyboard, and renamed or deleted from either tree.

**MANUAL.** Files and Navigator.

### K — M1: a cost-per-day chart on Metrics

*Decided (14 Oct): cost per day.* The TODO entry is at `TODO.md:177`.

**Problem.** Metrics has only tables (`metrics/route.tsx:177-268`). `days` holds non-empty days
only, newest first (`wire.ts:1312-1332`), and there's no chart library.

**Do.**
- Hand-rolled SVG with one bar per day, empty days included (filled from `from`/`to`), above the
  by-day table at :239.
- Same `showDays` rule as the table (`rules.ts:342`).
- A text alternative.
- Text inks only. Keep the limits in `metrics/verify.ts`:
  - :288 no hex;
  - :294 text inks only;
  - :295 `var(--fail)` exactly 3 times;
  - :296 no status vars.
  If a limit truly blocks the chart, change it and say why in the amendment.

**Verify.** `metrics/verify.ts`:
- 7 days give 7 bars;
- bar heights scale to the maximum;
- the colour limits still pass;
- a single day gives no chart.

**Done when** a range's shape shows at a glance.

**MANUAL.** Metrics.

---

## 4. Wave 3

### I2 — N4: Branches only shows the project's main repo

**Problem.** `projectRepo` uses only `project.path` (`project-repo.ts:75`), ignoring extraDirs
(`wire.ts:42`) and nested repos (`tree.ts:259-298`).

**Do.**
- The branch routes (`routes/branches.ts:60-99`) take a `repo` parameter.
- `projectRepo` checks it against {project.path, the extraDirs that are repos, nested repos up
  to depth 4}.
- `BranchesResponse` (:896-932) lists the choices.
- A repo picker in the Branches header (`route.tsx:260`), defaulting to project.path. The lock
  is already per root (:792-798).

**Verify.**
- `verify-branches.ts`:
  - a nested repo and an extra dir both list;
  - a repo outside the set → 400;
  - merging or pushing in a nested repo touches only that repo.
- `branches/verify.ts`: the picker.

**Done when** every repo that Files shows can be managed on Branches.

**MANUAL.** Branches.

### I3 — G1: GitHub pull requests, opt-in, including "when done" (migration 280)

*Decided (14 Oct): a button, plus an "open a PR when done" choice at launch. Local branches stay
the default.*

**Problem.**
- Nothing uses `gh`.
- Nothing parses the origin URL (`branches.ts:385`, :457 only check that origin exists).
- Finishing only ever merges locally (`finish.ts:111-179`).

**Do.** Start with a one-page design note in the amendment, and get the person's OK before the
code.
- **Setting.** `conductor.pullRequests`, off by default. With it off, nothing changes.
- **Gate.** When it's on, show the feature only if `gh auth status` succeeds and origin is
  GitHub. Parse both `git@github.com:o/r.git` and `https://github.com/o/r(.git)`.
- **Action.** `BranchAction` `open_pr{branch, title?, body?}`:
  - push with the existing code (:855-867, never force);
  - then `gh pr create --head b --base <target>`, via execFile, with the timeout and
    `GH_PROMPT_DISABLED=1`;
  - the title is the first line of the job prompt, and the body is the hand_off summary;
  - return the URL.
- **When done.** `Autonomy.openPrWhenDone`, copying `mergeWhenDone`:
  - `wire.ts:197`
  - `routes/session.ts:114-124`
  - `composer.tsx:159-160`
  - `spawn/autonomy.ts:83-84`, :123

  `finish.ts` then opens the PR instead of merging. The two choices are exclusive: picking one
  clears the other.
- **Cards.** The finished card gets "Open PR" (`attention/alerts.ts:198-204`,
  `AlertCard.tsx:253-293`). A new "PR opened" card shows the link. Reword the notes "Pushing
  stays on the Branches screen" and "Nothing was pushed".
- **Storage.** `job_finishes.pr_url` (migration 280).
- **Out of scope.** Conductor never merges a PR.

**Verify.**
- `verify-branches.ts`, with a fake `gh` on PATH:
  - the URL parser handles both forms and refuses non-GitHub origins;
  - with the setting off, the action → 409;
  - the push happens before `gh`;
  - when `gh` fails, the error is reported and the push stays.
- `session/verify-finish.ts`:
  - `openPrWhenDone` opens a PR and doesn't merge;
  - the two flags are exclusive.
- `attention/verify.ts`: the cards.
- A real GitHub run is person check P5.

**Done when** a finished job can end in a PR by choice, in one press or automatically, and
nothing changes with the setting off.

**MANUAL.** Branches, Spawn/composer (the choice) and Needs You.

### Chain L: L1 → L2 → L3 → P (after the last S lane)

#### L1 — N9: each stage sees every earlier stage's summary

*Decided (14 Oct): ancestors appear as their summaries.*

**Problem.**
- `#promptFor` hears only direct dependencies (`sup:1180-1187`), and so does `#takeRerunNote`
  (:2117-2122).
- An ancestor arrives only quoted inside the parent's first turn, which is the first thing
  `fitTurns` drops (`handoff.ts:193-203`).
- An ancestor's summary is never passed on. `docs/adr/0001` says otherwise, and lane F corrects
  it.

**Do.**
- Add a pure `ancestorsOf` to `shared/stack.ts`: an upward walk in topological order, written
  like `createsCycle`'s (:100-104).
- Direct dependencies stay as they are now.
- Ancestors are added as summary-only upstreams labelled "via <role>", counted against the cap.
  `dropRepeats` already prevents double counting (`verify.ts:2616-2622`).
- The re-run note does the same.

**Verify.** `session/verify.ts` §17 (:2601-2665):
- in an A→B→C chain, C holds A's summary once;
- in a diamond, the shared ancestor appears once;
- the cap holds;
- the re-run note matches.

**Done when** the last stage of a pipeline sees every earlier stage's summary.

**MANUAL.** Pipelines.

#### L2 — H3: check that a hand_off has its closing headings

*Decided (14 Oct): warn.* The TODO entry is at `TODO.md:207`.

**Problem.** The headings exist only on the web (`personas.ts`, the closing-headings lists).
`handOff` (`sup:1657-1674`) checks only that the summary is non-empty and its length.

**Do.**
- `AgentSpec.closingHeadings?: string[]`, sent from the persona and checked in
  `parseAgentSpec`.
- A pure `missingHeadings` in `handoff.ts`, which matches headings as words.
- `handOff` saves the summary, and its reply lists any missing headings and asks the agent to
  call again.
- The Needs You hand-off card shows "missing: …".
- `handOffByUser` (:1681-1705) only warns.

**Verify.** `session/verify.ts` §20 (:4515):
- with every heading present, a plain OK;
- with one missing, it's saved and the reply warns;
- with no headings configured, no check.

**Done when** an agent that forgets a heading is told at once.

**MANUAL.** Hand-off.

#### L3 — H2: measure the hand-off token estimate

*Decided (14 Oct): no tokenizer; measure instead.*

**Problem.** `CHARS_PER_TOKEN = 3` (`handoff.ts:66`) is a guess, feeding `handoffCap` (:79-81)
and `costOf` (:187).

**Do.**
- After a launch that carried a hand-off, compare the run's reported input tokens (the usage
  `metrics.ts` folds) with the characters sent.
- Record the ratio per model and show it on Metrics.
- Log a warning when a hand-off came within 10 % of the window.

**Verify.** `session/verify.ts` §17 (:2507-2564), with fake usage: the ratio maths and the
warning threshold.

**Done when** the estimate is measured against real runs.

**MANUAL.** Metrics (the ratio).

#### P — N13: pass a report to another stack, which launches at once

*Decided (14 Oct): the report is the `hand_off` summary, or the last reply when there is none.
Same project only. It launches straight away.*

**Problem.**
- A launch carries only `prompt` and `agents` (`CreateJobRequest`, `wire.ts:281-294`); nothing
  names a source agent.
- Spawn's deep link takes only `projectId` (`spawn/route.tsx:270-272`).
- Saved setups (`conductor.setups`, `custom.ts:45`, :57) can't be launched from outside Spawn.

**Do.**
- **The action.** A **Pass to…** action on the agent page and on the hand-off card. You pick a
  saved setup and one of its rows (e.g. architect in "Build Stack"), from the same project only.
- **The launch.** One confirm line lists the setup, the row, the isolation and the budget; then
  it launches. Where Spawn has no remembered isolation or budget, use worktree and no budget,
  and say so on the confirm.
- **Build the job in the web, with the same code Spawn uses.** `toPreset` → `toAgentSpecs` with
  the setup's saved picks and Spawn's remembered defaults, so Amendment 147's rule (the pills win)
  applies. The prompt is "Execute the report handed to you".
- **Wire.** `AgentSpec.handedReport?: {fromAgentId, text}`, on the chosen row only.
- **Daemon checks.** The source agent must exist and be in the same project (400 if not); `text`
  is capped at `HANDOFF_SUMMARY_MAX` (`wire.ts:359`).
- **The prompt.** `#promptFor` (`sup:1167-1205`) adds it as one upstream, "Handed to you from
  <role> in <job>", through `handoffSection` under the cap.
- **Record.** Note the source in the new job's event log. No migration.

**Verify.**
- `session/verify.ts` §17:
  - only the chosen row's first prompt holds the report, once, under the cap;
  - an unknown or cross-project source → 400.
- A web verify for the agent and attention screens (the Pass to… picker):
  - the spec it builds matches what Spawn would launch for that setup;
  - the summary is used, or the last reply when there's no summary.

**Done when** "pass the plan to the architect in Build Stack" is one action.

**MANUAL.** Agent page / hand-off: Pass to….

### M — H1: model windows are lost on restart (migration 270)

**Problem.**
- The windows registry is an in-memory Map (`windows.ts:23`, header :14-17).
- Claude's `result.modelUsage[*].contextWindow` is ignored (`metrics.ts:69-85`;
  `claude.ts:608-720`).

**Do.**
- On each result, record the window under both the canonical id and `agent.model` (aliases,
  matched as `matchModel` does).
- Persist the windows (`270_model_windows.sql`) and load them at startup.
- Keep the model-list writers (`copilot.ts:227`, :247-250; `models.ts:290`).

**Verify.** `session/verify.ts` §21 (:4914-4968):
- the window is recorded under both the alias and the full id;
- it survives a restart;
- `[1m]` is still ignored (`windows.ts:44-47`).

**Done when** the hand-off cap uses the real window from the first run on, even after a restart.

**MANUAL.** None.

---

## 5. Person checks (not for the orchestrator)

- **After wave 1:**
  - paste the UI test plan into `docs/checks/ui-test-plan.md`;
  - UI test plan sections A–D;
  - Amendment 147 on Spawn: what you click runs, and a reading row says so.
- **After wave 2:**
  - sections E–H;
  - the browser check at `TODO.md:102`;
  - U1 in both themes;
  - "when done";
  - a message sent while slots are full;
  - once S4 is built, an outage (cut the network, then restart the daemon mid-wait).
- **After wave 3:**
  - on real models: the transitive hand-off, the H3 warnings, the H1 windows, and N13 passing a
    plan to Build Stack's architect;
  - P5, a real GitHub PR on a throwaway repo, both by button and when done.
- **Before S4:** answer the five questions in the R2 TODO entry.

## 6. Decided (14 Oct)

| Id | Decision |
|---|---|
| R1 | Done in Amendment 147: the pills win; only `write: false` and reading roles pin a row |
| A2 | The message waits for a slot and survives a restart (the S2 table, `trigger='slot'`) |
| R2 | Superseded by `06ab549`: wait for the model, one probe per provider. *Decided (14 Oct), the five questions:* the agent is `paused` with a reason ("waiting for the model"), not a new status; the probe backs off to every 15 min; it never gives up (Pause or Cancel stops it); the job shows as waiting; new launches on a provider that's down are queued until the probe answers |
| R3 | Sent when the turn ends as `done`; a question doesn't count; it waits through `failed`/`paused`; one per turn |
| O2 | Accepted as is: no enforcement, no lane |
| U1 | More chroma, floor 1.06, hues ≥ 60° apart |
| N3 | Rebasing a pushed branch is allowed, with a force-needed warning; Conductor never forces |
| N9 | Ancestors appear as summaries, "via <role>", within the cap |
| H2 | No tokenizer; measure the ratio, and warn within 10 % of the window |
| H3 | Warn: save the summary and tell the agent |
| M1 | Cost per day |
| G1 | Opt-in setting; a button and an "open a PR when done" choice, exclusive with merge-when-done; Conductor never merges a PR |
| D2 | Drop the links |
| N13 | Summary or last reply; same project only; launches at once |
| Closed earlier | N2, N8, N10, Q1, U2 |

## 7. Cost and order

- **Sizes, in agent runs** (S ≈ 1, M ≈ 2–3, L ≈ 4+):
  - **S:** A1, A4, N7, docs, O1, U1.
  - **M:** A3, R3, A2, O3, N3, N5, M1, N4, N9, H1, H3, H2, N13.
  - **L:** R2, N6, G1.
- **Slowest path:** S1 → S2 → S3 → S4 → L1 → L2 → L3 → P, eight merges in a row. It's seven if L
  goes ahead of S4.
- **If budget runs short, cut in this order:** H2, M1, N6, then G1's "when done".

## 8. Open questions

- Whether the arbiter stores enough tool input for A3's fallback.
- Whether non-Claude engines drop effort or plan (`engine.ts:37-51`, suspected; Amendment 147
  traced Claude only). *Answered 15 Oct by Amendment 156: nothing is lost. Copilot and OpenRouter
  keep the effort (`reasoningEffort`, `copilot.ts:401`), and plan first, which they lack, is sent as
  "ask me" and shown pressed as **ask me** before launch, on Spawn, "+ agent" and a helper an
  orchestrator starts. Left open: an effort the model doesn't take (TODO).*
- How the agent page and the hand-off card would host N13's **Pass to…**: not read.
