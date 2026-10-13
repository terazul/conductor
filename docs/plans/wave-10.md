# Plan: wave 10, the "worth doing next" list (Amendments 134-144)

**Status:** wave 10a started 13 Oct 2026. Built on `main` at `55f1df8` (Amendment 133). The decisions
are in §6.

**Asked (13 Oct):** "generate an execution plan for the worth doing next". That list was the
"Right now" install check, the loose ends of Amendments 112-128 in `TODO.md`, and the branch hygiene
raised on 9-12 Oct (clean up merged branches safely, merge and clean up when a job finishes).

Paths are under `packages/` unless they start with `docs/`, `scripts/` or `Makefile`.

---

## 1. Shape

Eleven lanes in three waves, smallest first, so the things you hit every day land first and a lane
never waits on a bigger one.

| Wave | Lanes | Runs as | Why this order |
|---|---|---|---|
| **10a**, small fixes | A install check · B crumb · C metrics · D token mode | in parallel, one worktree each | none touch the same files; each is under a day |
| **10b**, features | E files · F git methodology · G retry and budgets · H terminal · I orchestrated Custom | E, F, H in parallel; then G; then I | E, G and I all edit `shell/Navigator.tsx`, so G and I follow E |
| **10c**, branch hygiene | J branch clean-up · K merge and clean up when a job ends | J, then K | K reuses J's clean-up |

Every lane:

1. works in its own worktree off the latest `main`;
2. writes its CONTRACT amendment and its `docs/MANUAL.md` change;
3. adds or extends a `verify` file and puts it in `make test`;
4. ends with `make test` green;
5. is merged into `main` in the order of the table, and `main` is pushed after each wave.

Files more than one lane edits are merged in order and kept additive: `shared/src/wire.ts` (new types
at the end of their section), `CONTRACT.md` (one amendment each), `docs/MANUAL.md`, `Makefile` (one
`make test` line each), `TODO.md` (tick the item).

## 2. Wave 10a: small fixes

### Lane A: say when the install is out of date (Amendment 134)

**Problem.** `make start` (`Makefile:88-100`) starts the daemon and Vite with no check that
`node_modules` matches `pnpm-lock.yaml`. After a pull that adds a package, the browser shows Vite's
`Failed to resolve import` overlay.

**Do.**
- `scripts/check-install.mjs`: compares `pnpm-lock.yaml` byte for byte with
  `node_modules/.pnpm/lock.yaml`, the copy pnpm writes on every install (checked 13 Oct: identical when
  current). Exit 0 when they match. When stale, either run
  `pnpm install --frozen-lockfile --prefer-offline` (when `CONDUCTOR_AUTO_INSTALL=1`), or print one
  sentence: *"Dependencies are out of date: run `make install` (or `pnpm install`)"*, and exit 1.
- `make start` and `make restart` run it first, before anything starts.
- `docs/MANUAL.md` §7 troubleshooting table (`:1188`): a row for the overlay.

**Verify.** `scripts/verify-check-install.mjs`: a temp dir with a lock and a stale copy says stale; a
matching copy passes; a missing `node_modules` says stale. **Done when** `make start` after touching the
lock prints the sentence and starts nothing.

### Lane B: Needs You's label matches the Agent screen (Amendment 135)

**Do.** `web/src/attention/route.tsx:318, :340, :369`: `ui-crumb` → `ui-crumb is-agent` on the agent
rows (the project row keeps `is-project`). `web/src/lib/verify-crumb.ts` check F: Needs You moves from
the `--here` list to `--here-agent`.

**Done when** `verify-crumb` passes and the three Needs You headers show the Agent screen's backdrop.

### Lane C: metrics that say what they mean (Amendment 136)

**Do.**
- `web/src/metrics/rules.ts:95-99`: the retry rate's denominator is Claude's calls only, because only
  Claude reports retries. The Errors tile says "of Claude's calls" when other engines ran.
- Time per call: label it "per turn, subagents included" rather than dividing a parallel total; tokens
  per second is computed per run, then averaged.
- `web/src/lib/verify.ts:859`: fix the stale comment (Metrics is hotkey `8`), and use a hotkey nothing
  has.
- **Per-project filter (blocked on Q1).** `metrics_daily` is keyed `(day, provider, model)`
  (`daemon/src/db/migrations/170_metrics.sql:14-38`). The filter needs migration
  `220_metrics_project.sql` (`project_id` on `metrics_daily`, part of its key), the counts written with
  it from `recordRunEnd` (`daemon/src/session/metrics.ts:394-417`), `?projectId=` on `GET /api/metrics`,
  and a project picker on the screen. Data from before the migration has no project.

**Verify.** `web/src/metrics/verify.ts`: mixed-engine fixtures for the rates; daemon
`session/verify-metrics` for the project column if Q1 is yes.

### Lane D: token mode lets a browser in (Amendment 137)

**Problem.** With `CONDUCTOR_TOKEN` set, the bearer hook (`daemon/src/index.ts:94-103`) also runs on
WebSocket upgrades. A browser can't set `Authorization` on a WebSocket, so `/ws` and `/ws/term` refuse
it even with the right `?token=` (`daemon/src/terminal/verify.ts:510-524` asserts the refusal today).

**Do.** In the hook, an upgrade request (`req.headers.upgrade === 'websocket'`) to `WS_PATH` or
`/ws/term/` is checked by `?token=` instead of the header, compared in constant time
(`crypto.timingSafeEqual`), and still refused without one. Nothing else changes: the localhost and
Origin guard (`guard.ts:41`) runs first, as now.

**Verify.** Flip `terminal/verify.ts:510-524`: `?token=` alone connects; no token, a wrong one, or a
foreign Origin are refused, for both sockets. **Done when** a browser on `?token=` gets the feed and a
terminal.

## 3. Wave 10b: features

### Lane E: Files, the rest of the verbs (Amendment 138)

**There today.** Files (5) has a **+** per folder and at the root (`web/src/files/FileTree.tsx:131-141`,
`files/route.tsx:604-606`) that opens `NewFileForm`, written create-only (`createFile`,
`files/useWorkspace.ts:411`; the daemon's 409 at `daemon/src/workspace/service.ts:556`). The navigator's
folder rows (`web/src/shell/Navigator.tsx:204-311`) have none. There is no new folder, rename or delete
anywhere.

**Do.**
- **Navigator +.** On a folder row's hover, a **+** that opens the same `NewFileForm` in place, then
  opens the new file in Files (`openNew`, `files/useTabs.ts:198`).
- **Daemon routes**, for a job (`/api/jobs/:jobId/…`) and a project folder
  (`/api/projects/:projectId/dir/…?dir=`), through the same path gate (`resolveForWrite`,
  `workspace/paths.ts:101`) and lock:
  - `POST …/folder { path }`: `mkdir`, 409 when it exists.
  - `POST …/rename { from, to }`: `rename`, 409 when `to` exists (and on a case-insensitive filesystem,
    a name that differs only in case is allowed as a rename of itself).
  - `DELETE …/file?path=`: removes a file. A folder only when empty (Q2 for non-empty).
  - Nothing under `.git`, and nothing outside the folder, as for writes.
- **Web.** On a row in Files: **rename** (inline), **delete** (confirm, naming the file and saying
  whether git has it), and **new folder** beside **+**. Open tabs follow a rename and close on a delete.
- **Shared.** `CreateFolderRequest`, `RenameRequest` in `wire.ts`.

**Verify.** daemon `workspace/verify-files-verbs.ts` (each verb, 409s, `..` and `.git` refused, a
case-only rename on macOS); web `files/verify.ts` (tabs follow a rename, close on delete).

### Lane F: git methodology, finished (Amendment 139)

**Do.**
- **Track a remote-only branch.** `branchExists` checks `refs/heads/` only (`workspace/git.ts:146`),
  so a branch only on origin is cut fresh from `HEAD`. In `#addNamed` (`workspace/worktree.ts:279-305`):
  when `refs/remotes/origin/<name>` exists and the local branch doesn't,
  `worktree add --track -b <name> -- <path> origin/<name>`.
- **Branch picker in Spawn.** The free-text input (`web/src/spawn/route.tsx:562-583`) gets a
  `<datalist>` from `getBranches` (`branches/endpoints.ts:18`): local branches, then origin-only ones
  marked "on origin". It is still free text, so a new name works.
- **restoreFolder, said plainly.** `daemon/src/session/supervisor.ts:2175-2196`: before `worktree add`,
  if the branch is checked out elsewhere (`listWorktrees`), throw `FolderGoneError` naming where, so the
  route answers 409 with that sentence rather than git's 500.
- **`POST /api/workspaces`.** `fail()` (`routes/workspace.ts:71-86`) maps `LaunchBranchError` to its
  status.

**Verify.** daemon `workspace/verify.ts` (remote-only branch tracked, upstream set), `verify-folder.ts`
(checked-out elsewhere → 409); web `spawn/verify.ts` (the datalist).

### Lane G: retry and budgets you can set (Amendment 140), after E

**Do.**
- **Settings.** `conductor.retryDelays` (a comma list of seconds, 1-5 entries, each 1 s to 30 min) read
  by `RETRY_DELAYS_MS` (`daemon/src/session/retry.ts:26`), and `conductor.budgetCeiling` (1.0-10.0)
  read where `BUDGET_CEILING` is used (`shared/src/budget.ts:35`, `:49`). Rules through `settingRule`,
  as `conductor.slots` does (`daemon/src/slots.ts:26-29`). Settings (9) rows in the `SlotsSection`
  pattern (`web/src/settings/route.tsx:133-174`).
- **Navigator budget meter.** Each agent row in `shell/Navigator.tsx` and `shell/navtree.ts` gets the
  thin meter the tab and Fleet card use (`budgetOf`, `shell/autonomy.ts:97`; tones from
  `shell/spend.ts:30`). A job row gets the sum.
- **The first retry's card** (Q3).
- **Midnight** (Q4): unchanged by default.

**Verify.** daemon `session/verify.ts` retry section with a set list; web `shell/verify.ts` (meter
tones), `settings/verify` (the rules).

### Lane H: terminal, the rest of the plan (Amendment 141)

From `docs/plans/full-terminal.md` §5 and the 112 loose ends. In two steps, so the first is useful on
its own.

**H1.**
- **Settings.** `conductor.terminal.fontSize` (9-24), `.scrollback` (1,000-100,000), `.shell` (from the
  daemon's list of shells found). Replace the fixed values at `web/src/agent/Xterm.tsx:55-56`.
- **Add-ons.** `@xterm/addon-search` (⌘F / Ctrl-Shift-F), `addon-web-links`, `addon-clipboard` (OSC 52,
  write only), `addon-webgl` with the DOM renderer as the fallback. Handle `onBinary` for mouse reports.
- **Paths open in Files**, through `files/links.ts`.

**H2.**
- **A Terminal dock under every screen** for the project you're on (D8b), opened with Ctrl-`. It
  replaces the placeholder seam in `web/src/fleet/dock.tsx:65`.
- **A `terminals` hub frame,** so a terminal opened in one tab is listed in the others.
- **The headless mirror** (`@xterm/headless` + `addon-serialize`) in place of the raw 512 KB replay, so
  reattaching mid-`vim` draws the screen.
- **Not in this wave:** tmux persistence (Q5).

**Verify.** daemon `terminal/verify.ts` (serialize round trip, the frame); web `agent/verify` for the
settings and key maps. **A person checks** `vim`, `htop`, `less` in the browser, and Ubuntu (§5).

### Lane I: orchestrated stacks from Custom (Amendment 142), after G

**Problem.** Only the preset can list the roles an orchestrator may use. `listsRoles` is false for
Custom (`web/src/spawn/route.tsx:310`), `CustomRole` has no `orchestrates` (`spawn/custom.ts:22-31`),
and `SavedSetup` has no listed roles (`:33-38`).

**Do.** `CustomRole.orchestrates?: boolean` and `SavedSetup.listed?: ListedRole[]`, older saved setups
reading as before. Custom shows the listed-roles editor when one row orchestrates, saves it with the
setup, and sends it on launch as the preset does. The navigator marks an orchestrator (`◆`) like the
Agent tab.

**Verify.** web `spawn/verify.ts` (a saved setup round-trips with listed roles; an old one loads).

## 4. Wave 10c: branch hygiene

### Lane J: clean up merged branches safely, on the Branches screen (Amendment 143)

**Rule, from 9-10 Oct.** A done job's agent can be messaged again, and it needs its folder then (memory:
"A done job's worktree may still be in use"). So nothing is removed without saying which job it belongs
to, and a branch an agent could resume on is never removed without asking.

**Do.**
- **`BranchAction` `delete`** (`shared/src/wire.ts:824-836`, `daemon/src/workspace/branches.ts:630`):
  `{ action: 'delete'; branch; forgetJob?: boolean }`. It is refused (409, with the sentence) when:
  - it is the target, or checked out in the project's own folder;
  - it isn't merged into the target (`ahead > 0`); use `git branch -d`, never `-D`;
  - its worktree has uncommitted changes;
  - a job on it has an agent that is `working`, `blocked` or `queued`.
  When a `done` or `failed` job owns it and `forgetJob` isn't set, it is refused with *"job X's agents
  can still be messaged, and they need this folder; remove the job, or tick 'forget the job too'"*.
  With `forgetJob`, the job is removed first, as the Project screen's ✕ does (the transcripts stay).
  Then `git worktree remove` (no `--force`), `git worktree prune`, `git branch -d`.
- **`clean_merged`**: the same for every branch that passes, one at a time, stopping at the first
  refusal; the answer lists what went and what stayed, with why.
- **Screen.** **Delete** in the action bar for a merged branch; **⌫ Clean up merged (n)** in the head,
  with a confirm listing each branch, its folder and its job. Remote branches are never touched.

**Verify.** `daemon/src/workspace/verify-branches.ts` §12: each refusal; `-d` on an unmerged branch
refused; a done job's branch refused without `forgetJob` and removed with it, with the job's
transcript kept; the folder and the branch both gone; no remote change.

### Lane K: merge and clean up when a job finishes (Amendment 144), after J

**Do.**
- When a `worktree` job settles `done` (`#rollUpJob`, `daemon/src/session/supervisor.ts:1772-1795`) and
  its branch is ahead of the target, Needs You shows **Finished: merge into main?** Nothing happens by
  itself (Q6).
- Its buttons:
  - **merge**: Lane J's preview, then `merge` (refused on a conflict, which names the files). The job,
    its folder and its branch stay, so its agents can still be messaged.
  - **merge and clean up**: the same merge, then `delete` with `forgetJob: true`, after a confirm that
    says the job's agents can't be messaged afterwards (their transcripts stay).
  - **open Branches**, and dismiss.
- **Push** stays a separate, confirmed action on the Branches screen.

**Verify.** daemon: a done job ahead of main gets the card, one that isn't ahead doesn't; **merge** keeps
the job and folder; **merge and clean up** removes the job, folder and branch, keeping the transcripts;
a conflict merges and removes nothing.

## 5. Checks only a person can do

From `TODO.md` "Checks that need a person", plus what this wave adds. Best done after 10b:

1. Amendments 99-144 in a browser, light and dark (the crumb backdrops in particular).
2. One run against a real model: a question left unanswered for 20 minutes then answered (132), a
   restart mid-run (133), a retry (123).
3. The terminal: `vim`, `htop`, `less`, a reload mid-`top`, on macOS; and once on Ubuntu 24.04.
4. A re-run of a parked agent against the real SDK (102).
5. The new role instructions against the old on one real bug (126).

## 6. Decisions (answered 13 Oct)

| | Question | Decided |
|---|---|---|
| **Q1** | Metrics per project: add `project_id` to the metrics table? (C) | **Yes.** Counts from before it have no project and show under "all projects" only. |
| **Q2** | Delete a non-empty folder from Files? (E) | **Yes, with a double check:** a confirm, then a second "Are you sure?" naming how many files go with it. |
| **Q3** | Show a retry's card from the first retry (5 s)? (G) | **Yes.** |
| **Q4** | At midnight, continue agents paused only for today's budget, unattended? (G) | **Yes.** Only those paused by the day's budget or ceiling, not ones you paused. |
| **Q5** | Shells that survive a daemon restart through tmux? (H) | **No.** |
| **Q6** | Merge and clean up when a job finishes: a card, or automatic? (K) | **A setting on the agent:** "merge and clean up when done". When it is on and the merge is clean, it happens by itself; when it is off (or the merge would conflict), Needs You offers **merge and clean up**. |

## 7. Cost and order of work

| Lane | Size | Rough cost |
|---|---|---|
| A, B, D | small | $3-6 each |
| C | small, medium with Q1 | $5-12 |
| E, F, G, I | medium | $10-20 each |
| H | medium-large (H1 then H2) | $20-35 |
| J, K | medium | $12-20 each |

About $130-200 for the wave. Run 10a first and push; then 10b; then 10c. Each wave is a stopping
point: nothing in a later wave is needed for an earlier one to be useful.
