# CONTRACT

Rules for the five parallel tracks. Read this before writing code.
Execution plan: [PLAN.md](PLAN.md). Design reference: [mockups/conductor.html](mockups/conductor.html).

W0 is complete and **frozen**. Its smoke test passes:

```
pnpm --filter @conductor/daemon smoke     # must stay green
pnpm --filter @conductor/web verify        # must stay green
```

(Counts are deliberately not quoted here — they drift with every amendment, and
I have miscounted them three times. Run the suites; green is the contract.)

---

## 1. File ownership

You may write **only** in your track's directories. Everything else is read-only,
including other tracks' code.

| Track | Owns | Migration |
|---|---|---|
| **A — Session engine** | `packages/daemon/src/session/`, `packages/daemon/src/arbiter/`, `packages/daemon/src/routes/session.ts`, `packages/web/src/spawn/` | `010_session.sql` |
| **B — Shell, Fleet, Transcript** | `packages/web/src/shell/`, `packages/web/src/fleet/`, `packages/web/src/agent/` | — |
| **C — Workspace** | `packages/daemon/src/workspace/`, `packages/daemon/src/routes/workspace.ts`, `packages/daemon/src/routes/fs.ts`, `packages/web/src/files/` | `030_workspace.sql` |
| **D — Preview** | `packages/daemon/src/preview/`, `packages/daemon/src/routes/preview.ts`, `packages/web/src/preview/` | `020_preview.sql` |
| **E — Attention UX** | `packages/web/src/attention/` | — |

### Read-only for everyone (W0-owned)

```
packages/shared/**                     the frozen contract
packages/daemon/src/index.ts           bootstrap + route auto-registration
packages/daemon/src/eventlog.ts        the log — all tracks emit through it
packages/daemon/src/hub.ts             WS broadcast + snapshot contributors
packages/daemon/src/db/index.ts        sqlite + migration runner + row helpers
packages/daemon/src/db/migrations/001_core.sql
packages/daemon/src/routes/health.ts
packages/daemon/src/smoke.ts
packages/web/src/main.tsx              screen auto-registration
packages/web/src/lib/**                feed, store, screen contract
packages/web/src/styles.css            base + fallback shell
packages/web/src/diagnostics/**
fixtures/generate.mjs                  add a function; never edit another's
root manifests, tsconfigs, vite.config.ts
```

---

## 2. The one rule

> **If you need a change outside your own directories, STOP and report it.
> Do not make the change.**

Cross-track edits are how a parallel build becomes unmergeable. Stopping costs
minutes. Five agents independently editing `shared/events.ts` costs a day.

Escalations batch into a **contract amendment** applied on `main` by W0, after
which every track rebases.

---

## 3. Collisions already designed out

Don't reintroduce these.

| Hotspot | How it's avoided |
|---|---|
| Daemon route table | Routes auto-glob from `src/routes/*.ts`. Add a **file**; `export default async function (app) {}`. |
| Web router | Screens auto-glob from `src/*/route.tsx`. Export `screen: ScreenDef`. |
| Shell chrome | Track B exports `shell: ShellDef` from `src/shell/shell.tsx`; `main.tsx` picks it up automatically and drops the fallback. |
| Always-running work | Export `alwaysOn: AlwaysOnDef` from `src/<track>/always.tsx`. Mounted once for the life of the tab, outside the shell, surviving every screen change. Use it for anything that must keep working while the user looks at another screen. |
| Snapshot building | `registerSnapshotContributor(() => ({ pending: … }))` from your own module. Never edit `buildSnapshot`. |
| DB schema | One numbered migration per track, **append-only**. Never edit an applied file. |
| Dependencies | All pre-declared. If something is genuinely missing, escalate — don't edit a manifest. |
| Design tokens | `packages/shared/src/tokens.css`. No hardcoded hex anywhere. |
| Fixtures | One output file per track from `fixtures/generate.mjs`. |

### Reserved screen slots

| order | hotkey | screen | track |
|---|---|---|---|
| 10 | `1` | Fleet | B |
| 20 | `2` | Project | B |
| 30 | `3` | Agent | B |
| 40 | `4` | Needs you | E |
| 50 | `5` | Files | C |
| 60 | `6` | Preview | D |
| 70 | `7` | Spawn | A |
| 99 | `0` | Diagnostics | W0 |

---

## 4. How to work

**Daemon tracks (A, C, D)**

```bash
pnpm --filter @conductor/daemon dev        # tsx watch
pnpm --filter @conductor/daemon smoke      # must stay green
bash fixtures/make-scratch-repo.sh         # a dirty git repo to work against
```

Emit events through `eventLog().emit(scope, payload)` — never write the `events`
table directly, or the hub won't see it. Use `rows<T>()` / `row<T>()` / `tx()`
from `db/index.js`; node:sqlite types results as `Record<string, SQLOutputValue>`
and won't cast straight to a row interface.

**Web tracks (B, C, D, E)**

```bash
VITE_FIXTURE=session-basic       pnpm --filter @conductor/web dev   # B
VITE_FIXTURE=permission-requests pnpm --filter @conductor/web dev   # E
pnpm --filter @conductor/web dev                                    # live daemon
```

Read state through the hooks in `lib/store.ts` — `useAgents`, `usePending`,
`useSparkline`, `useProjectStatus`, and the rest. Send commands with `api()` from
`lib/feed.ts` so auth stays in one place. Never fetch or open a socket yourself.

Press `0` for Diagnostics. If your screen looks wrong, check there first to see
whether the problem is the data or your UI.

**Before you hand back**

```bash
pnpm -r typecheck                          # must be clean
pnpm --filter @conductor/daemon smoke      # must be green
```

---

## 5. Design rules that aren't negotiable

1. **One colour does one job.** `--live` working, `--need` a human is required,
   `--fail` broken, `--done` finished, `--queue` waiting, `--idle` dormant.
   **`--need` is never decorative.** It means *you*. Amber somewhere harmless
   destroys the one signal the whole product is built around.

2. **Everything displayed is derived from the event log.** Don't add a parallel
   state channel. If the UI needs something, it should be an event.

3. **Keyboard first.** The attention queue must be clearable without a mouse.

4. **Never block the agent on us.** The `PreToolUse` observation hook returns
   `{ async: true }`. An agent must never wait on Conductor's bookkeeping.

---

## 6. Two SDK findings the design depends on

Both verified against the Agent SDK docs. Full detail in PLAN.md §1.

**A — `canUseTool` is not an observation channel.** "The callback never fires for
auto-approved tools." Under `acceptEdits` it would fire almost never, so it can't
feed the activity view. Use `PreToolUse` with `{async:true}` to see *every* call;
use `canUseTool` for human decisions only.

**B — `defer` is the durability story.** A pending `canUseTool` promise holds a
live process; fine for 40s, not for a 12-minute wait, and it dies with the daemon.
`PreToolUse` returning `permissionDecision: "defer"` ends the query so the session
resumes from disk. Hence two block modes: `held` (under `DEFER_AFTER`, ~90s) and
`parked` (beyond it).

Two gotchas: `defer` **ignores `updatedInput`**, so "edit & run" must use the held
path; and precedence is `deny` > `defer` > `ask` > `allow`.

---

## 7. Decisions already made

- **One worktree per JOB**, not per agent. Agents inside a job are coordinated —
  sequential handoff, or disjoint file scopes enforced by an `Edit(path)` deny
  rule. Worktree-per-agent makes merge conflicts the product; a shared checkout
  corrupts silently. (`Isolation` in `shared/src/wire.ts`.)
- **Global event `seq`**, not per-agent. One writer, one cursor, trivially
  lossless reconnect. Fine at this scale.
- **`node:sqlite`, not `better-sqlite3`.** The native binding wouldn't build here,
  and five agents each running `pnpm install` is five chances to fail. Built-in
  needs no toolchain. Costs: experimental warning (silenced in the start script),
  no `.transaction()` helper (use `tx()`), null-prototype rows.
- **Workspace packages are consumed as source.** No build order to remember, no
  stale `dist/`.
- **Auth is scaffolded, off by default.** Localhost bind is the guard;
  `CONDUCTOR_TOKEN` turns on bearer auth. Hardening is an I5 item.

## 8. Still open — escalate, don't guess

- `DEFER_AFTER` default. Track A's spike measures resume cost; that sets it.
- Context-window percentage. Report tokens until it can be derived honestly from
  the Models API; a misleading percentage is worse than none.

---

## 9. Amendment log

### Amendment 109 — post-merge, applied. **A Branches screen (7): see a project's branches, merge into main, commit, push.**

Daemon (`workspace/branches.ts` new, `routes/branches.ts` new, `workspace/git.ts`,
`workspace/verify-branches.ts`). Wire (`BranchInfo`, `BranchesResponse`, `BranchAction`,
`BranchActionResult`, the `{ type: 'branches', projectId }` frame) as laid out in step 0, unchanged.
Asked 9 Oct: "show the GitHub branches and give me an option to merge a branch into main, merge all
branches into main, do a commit and push." Design: [ADR 0008](docs/adr/0008-branches-screen.md). The
first code in the daemon that writes history or talks to a remote.
- **Routes.** `GET /api/projects/:projectId/branches` → `BranchesResponse`; `POST` the same path with a
  `BranchAction` → `BranchActionResult`, which carries the listing after the action. Every POST, refused
  or not, broadcasts `{ type: 'branches', projectId }`.
- **Listing.** The local branches of the repo `project.path` is in (`for-each-ref refs/heads`), against
  the project's `defaultBranch`: ahead/behind (`rev-list --left-right --count`), `merge-base`, `log -n 20
  target..branch`, the upstream's ahead/behind (null when none is set or it is gone), the worktree it is
  checked out in (`listWorktrees`, prunable ones skipped) with `status --porcelain` lines as
  `uncommitted`. `targetCheckout` is the worktree with the target, `clean` when `status --porcelain -uno`
  is empty: untracked files don't count. `remote` is `'origin'` when `git remote` lists it. `jobId` is the
  newest of the project's jobs whose `branch` is that name, a live one first; `live` is any agent of such
  a job `working`, `blocked` or `queued`. Order: the target, then tip time, newest first.
- **merge** runs `merge --no-ff --no-edit -m "Merge branch '<b>' into <target>" -- refs/heads/<b>` in
  `targetCheckout.path`. A failure with unmerged files (`diff --name-only --diff-filter=U`) is `merge
  --abort`ed and answered `200 { ok: false, conflict: { branch, files } }`; any other failure is aborted
  too and is a 500. **merge_all** does the same, oldest tip first, over every branch that isn't the
  target, isn't live and is ahead; it re-counts before each (an earlier merge may have taken it), and
  stops at the first conflict with `merged` so far. **commit** runs `add -A -- . ':(top,exclude).conductor'`
  then `commit -m` in the branch's worktree: Conductor's own folder of job worktrees is never added.
  **push** runs `push [-u] -- origin refs/heads/<b>:refs/heads/<b>`, `-u` when it has no upstream;
  **fetch** runs `fetch --no-prune -- origin`. Both get `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless
  one is already set, and 60 s; `output` is git's stdout and stderr, trimmed.
- **Safety.** `execFile` only, through `git()`, which gains an optional `{ env, timeoutMs }` and
  `gitBoth()` (stdout and stderr); `GitError.timedOut` says it was killed. A name starting with `-` is
  refused before anything else, every name must be in the `for-each-ref` list, and refs go in fully
  qualified after `--`. Nothing is forced: no `--force`, and the explicit refspec has no `+`, so a
  configured `remote.origin.push = +…` is never used. Every POST holds `KeyedLock` on
  `branches:<repoRoot>`.
- **Errors**, `{ error, detail? }`: **404** no such project. **400** not a git repo, an unknown action,
  no branch or one starting with `-`, no such branch, merging the target into itself, an empty message.
  **409** the branch is live (and, for merge and merge_all, the target is: an agent working in place
  would have the merge land under it), the target isn't checked out, its checkout has tracked changes,
  nothing to merge (ahead 0), no worktree to commit from, nothing to commit (also after `add`, when only
  excluded files changed), no origin, a rejected push (git's stderr as detail). **504** push or fetch
  timed out. **500** git failed, stderr as detail.
- **Verify:** `workspace/verify-branches.ts` (port 7811), 86 checks against a repo, a bare origin and a
  second clone in `tmpdir()`, every case in ADR 0008 § Testing.

**Web (lane B2).** `web/src/branches/`, new: `route.tsx` registers screen 7 (`id: 'branches'`, order 65); `graph.tsx`
draws the SVG from a pure `layout(BranchesResponse)` (the target as a rail whose dots are the distinct fork distances,
read from each branch's `behind`, with the commits between them counted; a curve, up to 10 commit dots, an uncommitted
hollow dot, a tip label and badges per branch; ahead 0 dimmed and joined to the rail; `forkedAt: null` starting on its
own); `rules.ts` holds the pure "why not" sentences for merge, merge all, commit and push, and the confirms;
`endpoints.ts` has `getBranches` and `branchAction`; `live.ts` takes the `branches` frame, which `lib/store.ts` now
hands it. The project is the route's `projectId`, else the remembered one; with neither, the screen lists projects.
It re-reads on arrival, window focus, a `branches` frame for its project, a change in its jobs' or agents' statuses,
and from each action's own `branches`. Not watched: `worktree` events, because the store has no per-project event
selector and backfilling every job's history to count them costs more than it buys. The web treats a branch with no
history in common with the target as not mergeable (git refuses unrelated histories), so it is left out of
"merge all"'s count. Also `shell/nav.ts` (`SCREEN.branches`, `openBranches`), `shell/shell.tsx` ("1–7 screens"),
`lib/screens.ts` (the reserved table), and `lib/verify.ts` §15, whose made-up tab-less screen now names hotkey 8.
Checked by `web/src/branches/verify.ts`.


### Amendment 108 — post-merge, applied. **Answer an agent's requests in a side panel on its own Agent screen.**

Web only (`attention/NeedsPanel.tsx`, `attention/needs.ts`, `attention/AlertCard.tsx`, `attention/attention.css`,
`agent/agent.tsx`, `settings/route.tsx`, `lib/verify.ts`, `attention/verify-needs-panel.ts`). No daemon, wire or
database change. Asked 9 Oct: "for the Needs You, have it come up as a side panel when I click on it in the Agent
page — that way I don't have to leave the page to approve it or interact with it." Design:
[ADR 0007](docs/adr/0007-needs-panel-on-agent.md).
- **What it shows**, by the user's choice: everything waiting on that agent and only that agent. `needsFor(agentId,
  pending, alerts)` (pure, in `attention/needs.ts`, re-exported by `NeedsPanel.tsx`) gives its requests, then the
  alerts whose `agentIds` include it, each oldest first. A request from another agent isn't here; the rail and the
  navigator still count it.
- **The cards are the Needs you screen's own.** `PermissionCard` and `QuestionCard` unchanged, each with its own
  `{ composer, draft, cursor }` in a map keyed by `requestId`; `pruneCards` drops a request's entry once it leaves
  `pending`. Decisions go through `useDecisions(requests)`, so a card leaves only when the daemon's `resolved` event
  drops it, as on screen 4. Alerts are `<AlertCard … onAgentScreen />`.
- **`AlertCard`'s `onAgentScreen?: boolean`** hides the "open" action for the alert's own agents (you're already
  there). An open for another agent, such as the one a waiting agent waits on, stays. Nothing else changes.
- **No keys.** The panel adds no `window` listener: screen 4's Enter, Tab, Escape and letters would fight the composer
  and `i`. The cards' buttons, textareas and Tab order are all there is.
- **On the Agent screen**, `needsOpen` is local state, never opened by itself:
  - the blocked banner (`ag-blocked`) opens it, and no longer calls `openAttention`;
  - a **needs you · N** button in the header, with the need Tag's look, shows when N > 0 (the tab's count) and
    toggles it;
  - another tab's amber count opens that agent with the panel; the rest of the tab only switches agent, as before;
  - while open it takes the Inspector's place. `i` and the details button close it and show the details;
  - switching to an agent with nothing waiting closes it. Answering the last one doesn't: it stays open and says
    "Nothing is waiting on <role>.", with a close button.
- **Its width** is its own setting, `AGENT_NEEDS` (`conductor.agentNeedsW`, 340px, min 280, half the window at most),
  dragged by a `Splitter grow={-1}` like the details. `.atn-side` draws no edge of its own. It's in `lib/verify.ts`
  §10b's panel table and Settings' layout reset.
- **Unchanged:** the Needs you screen, its queue, its keys and the notification ladder; the navigator's Needs you
  rows and the rail button; `openAttention`; `DETAILS_KEY` and `rightPanelFor`.

### Amendment 107 — post-merge, applied. **One "where you are" label, the same on every screen.**

Web only (`shell/ui.css`, `fleet/fleet.css`, `fleet/fleet.tsx`, `fleet/project.tsx`,
`agent/agent.tsx`, `agent/agent.css`, `attention/route.tsx`, `attention/attention.css`,
`preview/route.tsx`, `preview/preview.css`, `files/route.tsx`, `files/FilePane.tsx`,
`files/files.css`, `lib/verify-crumb.ts`). No behaviour, wire or daemon change. Reported 9
Oct: "the highlighting of project/agent is not consistent across tabs; for example, it is
not highlighted when we get to the Needs You tab." Design: [ADR
0006](docs/adr/0006-one-crumb-everywhere.md). It carries Amendment 97's backdrop — the
project/agent label sitting on `--here` — from Fleet, Project and Agent to every other
screen.
- **One class, not five copies.** `.ui-crumb` (and its `b`/`i` rules) now live in
  `shell/ui.css`, unchanged from the `.fl-crumb` Amendment 97 added, so every screen that
  imports `shell/ui.tsx` already has it. `.fl-crumb`, `.atn-crumb` and `.pv-crumb` are gone
  from `fleet.css`, `attention.css` and `preview.css`.
- **Twelve sites, one class.** Fleet (`fleet.tsx`), Project (`project.tsx`), Needs You
  (`attention/route.tsx`, all three headers) and Preview (`preview/route.tsx`, both) use
  `ui-crumb`. Agent (`agent.tsx`) uses `"ui-crumb ag-crumb"`: `ag-crumb` still carries the
  button's hover behaviour (`agent.css`), nothing else. Files (`files/route.tsx`,
  `files/FilePane.tsx`) uses `"ui-crumb c5-crumb"`: `c5-crumb` keeps only what a path needs
  — `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0`, and its
  tighter 5px `i` margin — the backdrop comes from `ui-crumb` alone.
- **Unchanged:** the label's look (`--fs-md`, the `--here` backdrop, the mixed border), the
  header rows' height, and the contrast check already in `lib/verify.ts` (the inks on
  `--here`, ≥ 4.5:1 in both themes). `lib/verify-crumb.ts` adds the checks this amendment
  needs — the shared class and its backdrop, the four old copies gone, Files' crumb carrying
  no background of its own, and all twelve sites naming `ui-crumb` — without touching
  `lib/verify.ts`, which another lane's build also depends on.

### Amendment 106 — post-merge, applied. **What you typed reads in its own colour: `--you`.**

Shared (`tokens.css`) and web (`agent/agent.css`, `agent/transcript.tsx`, `agent/verify.ts`,
`lib/verify.ts`), and `docs/MANUAL.md`. Asked 9 Oct: "make the 'You' text I type that shows up in the
output areas a different, more highlight colour."
- **`--you`**, a new colour token for both themes: `#c4a8ff` dark, `#6236b0` light. Violet, which no
  status colour is, so your turns stand out without reading as "needs you" (`--need` still means only
  that, §3). It is in `lib/verify.ts`'s measured text tokens: at least 6.6:1 dark and 5.9:1 light on every
  surface, and about 5:1 on its own 10% tint.
- **Your turns** in the transcript (`.ag-msg.is-you`) put the label, the left bar and the text in `--you`,
  on a `--you` tint at 10% instead of the `--ink` one. A turn Conductor sent for you (`synthetic`,
  labelled **auto**) gets `is-auto` and keeps the old neutral look: you didn't type it.
- Nothing else changes colour.

### Amendment 105 — post-merge, applied. **An agent's "finished" clears once you've opened it.**

Web only (`lib/seen.ts`, `attention/always.tsx`, `shell/navtree.ts`, `shell/Navigator.tsx`,
`agent/agent.tsx`, `lib/verify.ts`, `shell/verify.ts`, `agent/verify.ts`), and `docs/MANUAL.md`. No
daemon, wire or database change. Reported 9 Oct: "the finished tag is never cleared from the menu bar,
even after I visit the particular agent." Design: [ADR 0005](docs/adr/0005-finished-agent-seen.md).
It narrows Amendment 94 for the navigator's agent rows and the Agent screen's tabs.
- **Seen per agent.** A new setting, `conductor.seenAgents` = `{ since, agents: { <agentId>: <endedAt
  seen> } }`, beside `conductor.seenJobs` (Amendment 87) and in its pattern: `parseSeenAgents`,
  `serializeSeenAgents`, `unseenDoneAgents`, `markAgentsSeen` (pure), and `markAgentSeen`,
  `useUnseenAgents` (live). An agent is unseen when it is `done` (not failed or stopped), has an end time
  after `since`, and after the one you saw. `setAgentStatus` writes a new `ended_at` on every end, so an
  agent re-run or continued that finishes again is unseen again. `startSeenOnce` writes its `since` once.
  A separate key, not a map inside `seenJobs`: `parseSeen`/`serializeSeen` rebuild only `{ since, jobs }`,
  so a tab on an older bundle would drop the map, and a fresh `since` keeps the upgrade from lighting every
  old done agent.
- **Seeing an agent** is having its Agent screen open while the tab is in front. The `Notifier` effect that
  marks the open agent's job marks the agent too, under the same `if (!visible) return`. Opening its
  project doesn't.
- **Where it shows.** `NavAgent` gains `finished` (done and not yet seen); `navTree` takes the unseen agent
  ids as a new last parameter, default empty. The navigator's `AgentRow` shows **finished** on
  `a.finished`; the Agent screen's tab on `t.status === 'done' && unseenAgents.has(t.id)`.
- **Unchanged:** the job group's **finished** and its seen, the Fleet card, the Project screen, the agent
  lane's `Tag`, the Agent header's status `Tag` (`STATUS_WORD.done` is still `finished`), the tab badge and
  desktop notifications (jobs only).

### Amendment 104 — post-merge, applied. **An agent hands off only by saying so: a `hand_off` tool.**

Shared (`wire.ts`, `stack.ts`), daemon (`routes/helpers.ts`, `routes/session.ts`, `session/supervisor.ts`,
`session/store.ts`, `session/alerts.ts`, `session/handoff.ts`, `session/rerun.ts`, `session/backend.ts`,
`session/backends/claude.ts`, `session/backends/copilot.ts`, `session/verify.ts`, migration
`130_handoff.sql`) and web (`attention/alerts.ts`, `attention/AlertCard.tsx`, `attention/HandOff.tsx`
new, `attention/attention.css`, `attention/verify.ts`, `shell/describe.ts`, `agent/endpoints.ts`,
`agent/transcript.tsx`, `lib/verify.ts`), and `docs/MANUAL.md`. A TODO.md item (asked 7 Oct, decided
8 Oct): "an agent hands off only by saying so". It uses the seam Amendment 101 left, `Upstream.summary`.
- **The tool.** `hand_off({ summary })`, in `MCP_TOOLS` beside `start_helper`. It is given to every agent
  that has an agent waiting for it (`waitersOf`, now in shared `stack.ts`: the agents whose `dependsOn`
  holds it, not its own orchestrator, which waits for its helpers by another road, Amendment 51). The
  last agent in a chain has none, and finishes `done` as before. Claude gets it from the per-agent MCP
  endpoint, allowed outright (`mcp__conductor__hand_off`); Copilot and OpenRouter in-process, beside
  `start_helper`, `skipPermission`, served by the same `callTool`. Both capability rows already had
  `helperTools: true`. A new `RunnerScope.handOff` says whether an agent gets it; `helperCap` is
  unchanged. Today's rule "tools go only to orchestrators" is now "to orchestrators, and to agents others
  wait for", and `tools/list` answers with that agent's own tools (`toolsFor`, `Supervisor.toolAccess`).
  An agent that is both gets all three. Refused with a sentence the model reads: nobody waits for you, a
  blank summary, one over 20,000 characters (`HANDOFF_SUMMARY_MAX`).
- **It is told to.** An agent others wait for has one more line in its first prompt, after the line about
  asking (Amendment 100): when you are done call `hand_off`; they start only once you have; without it you
  wait in Needs You. The line is taken out of the conversation the next agent is given
  (`turnsFromEvents`), as the line about asking is.
- **The hold, in `#settle`.** Before `done` is written: if no summary was given in this run and an agent
  that waits for it is still `queued` (or `paused` and never started), the agent is *held*. It is `done`,
  not a new status. `#depsSatisfied` does not count a held agent, so what waits stays queued, and the job
  stays `working`. Its `done` status event carries the note `stopped without handing off`
  (`HANDOFF_HELD_NOTE`), so the transcript says so and the alert has an id. A chat with an agent whose
  followers have all run holds nothing, and neither does a failed agent (it is `failed`, with its own alert).
- **Kept across a restart.** Migration `130_handoff.sql` adds two columns to `agents`, off the wire like
  the persona: `handoff_summary` (what it said, or what a person sent for it) and `handoff_held`. The
  alert is derived from them, as the other agent alerts are; a daemon that restarts finds the hold and
  starts nothing. The TODO suggested the alerts table, but that table holds only dismissals (Amendment
  28), and the alerts themselves are derived, so the state lives with the agent. *One summary belongs to
  one run:* it is cleared when a finished agent works again (you wrote to it, or `rerunFrom` re-runs it),
  not when a run is only resumed after a pause, a parked question or a restart.
- **The alert.** `AlertKind` gains `handoff_held`: `agentIds` is the held agent, `cause` is
  `stopped without handing off`. Derived by `Alerts.#heldHandoffs` for an agent that is `done`, held, and
  has an agent still waiting; the id carries its last status event, so a dismissal lasts until it is held
  again. It clears when it hands off, is handed off for, works again, or nothing waits for it any more.
- **The card.** *Not handed off*, amber (`--need`): "architect stopped without handing off, so the agents
  after it have not started", a **waiting** line (who, by role), then **hand off** (primary), **open
  agent** and dismiss, and a **reply** box. **hand off** opens the summary for editing, prefilled with the
  agent's last reply (and filling in if its history arrives late, until you type over it); **hand off with
  this** sends exactly that text, trimmed, and cannot be pressed when the daemon would refuse it. **send
  reply** is an ordinary message: the agent works again and hands off when it is done. A send that was
  accepted does not remove the card; the daemon clears the alert, so a refusal stays on screen with its
  reason. Tokens only (`atn-ta`, `--ink3`, `--fail`, `--need`), both themes. Its Fleet/navigator line reads
  *stopped without handing off* in amber, and the transcript's note reads *finished — stopped without
  handing off*. (The TODO named `attention/describe.ts`; the alert sentences are in `shell/describe.ts`,
  and `attention/describe.ts` is the permission-card reader, which is unchanged.)
- **`POST /api/agents/:id/hand-off`** `{ summary }` → `{ agent }`. 400 if `summary` is not text; 404; **409**
  with the sentence in `detail` when the agent is not held, or the summary is empty or over the limit. It
  records the summary, clears the hold, writes a `done` status event with the note `handed off by you`,
  and `pump()` starts what waited.
- **The handoff.** `#promptFor` gives each upstream its `summary` (printed first, whole, outside the cap —
  `Upstream.summary`, as Amendment 101 built it) above the whole conversation. `rerunNote` carries the same
  section, so a re-run agent hears the summary of the agent before it too.
- **Re-run from here (Amendment 102) still works.** The source agent has handed off, or has nobody
  waiting, so talking to it holds nothing: its `done` stands, its summary from before is dropped (it was
  about the old plan), and **↻ re-run after this** runs as before. The agents it re-runs get a summary
  reset and are asked, in the note, to hand off again; one that doesn't is held, and the agents behind it
  wait for you. A re-run from an agent that is held is refused (409): "stopped without handing off … Hand
  it off in Needs You first", since none of the agents after it has started.
- **Checked**: `session/verify.ts` §20 (who is given the tool, the tool list per agent, the refusals; the
  turn that ends without `hand_off` holds with the dependant still queued, the alert, the status note, a
  snapshot that carries it, the job still working; a second connection to the file finds the hold; a
  reply works the agent again and holds it again with a new alert id; the person's edited summary is what
  the developer is told, trimmed and above the conversation, with the refusals; `hand_off` over the
  endpoint then the end of the turn starts the validator with the summary; the last agent has no tools and
  finishes `done`; talking to a handed-off architect holds nothing and its re-run works; a re-run developer
  that doesn't hand off is held, a re-run from it is refused, and the validator then resumes with the
  summary), §17l (Copilot and OpenRouter: the in-process tool, a blank summary as a failure the model
  reads, held, handed off, the next agent starts with the summary), `attention/verify.ts` §6 (the actions,
  title, notification, top-bar word, who waits, the draft, what can be sent, the wiring of the button,
  the edit box and the reply box, tokens only) and `lib/verify.ts` (the lane line). The existing stack
  tests in §17, §17o, §17p and §19 now call `hand_off` where an agent in the middle used to simply finish.
- **Not done**: the Agent screen's **re-run** button does not know a held agent (the hold is not on the
  wire), so it is enabled and the daemon's 409 explains. No hand-off from the Fleet card or the Project
  lane; Needs You and the reply box are the way. A hand-off made before a daemon restart that interrupted
  the same run is kept (the run is resumed, not restarted), but one made in a run that had already ended
  and was then run again is dropped by design. The wording of Amendment 100's line ("a question in your
  reply … the agents after you start without the answer") is now stale for an agent with agents waiting:
  they are held, not started. It is left as it was. Orchestrated stacks (a separate TODO item) are not
  built; whether an orchestrator's helpers also get `hand_off` is still its own open question (they do
  not: a helper's `waitersOf` is empty). Not run by this lane: `make test`, the daemon smoke test, and the
  workspace/preview suites.

### Amendment 103 — post-merge, applied. **Open pages are told when the day changes, so the status bar's "today" reads zero at midnight.**

Daemon (`daily.ts`, `session/alerts.ts`, `session/store.ts`, `session/verify.ts`). The status-bar half of a
TODO.md item (8 Oct): "when the day restarts, the budget should go back to zero (at midnight my
time zone)".
- **What was wrong.** The daemon already counted the day right: one `cost_daily` row per local
  day (`localDay`, `costToday`). An open page was told today's total only when it connected (the
  hello snapshot) and when a Claude run's spend grew (the `cost` frame, `backends/claude.ts`).
  A tab left open past midnight kept yesterday's figure until the next spend or a reload.
- **`DayWatch`** (`daily.ts`) looks at the day every `DAY_CHECK_MS` (30 s) and compares
  `localDay()` with the last day it saw. The first look that finds them different is a turn:
  it runs once, then the day seen is the new one. The timer is `unref`'d, so it never keeps the
  daemon alive.
- **On a turn**, `startDayWatch(db)` broadcasts `{ type: 'cost', costToday: costToday(db) }` to
  every connected page (0, at midnight) and calls `costChanged()`, so the daily-budget alert
  is checked against the new day: a standing "daily budget reached" clears, because its id
  carries the date. The same refresh turns over notes due today. Nothing changes in `wire.ts` or
  the web: the status bar and the Settings meter already take a `cost` frame.
- **Why a short interval and not one timer to midnight.** A machine that sleeps through
  midnight fires a long timer late, and a clock set by hand fires it at the wrong time. A look every 30 s sends the
  frame within half a minute of the machine waking, whether it slept one night or three, and
  sends exactly one: a clock that jumps whole days is still a single turn. A look on the
  same day sends nothing. A clock moved backwards to another day is a turn too.
- **Wired in `Alerts.start()`**, which already holds the daily budget's refreshes, and stopped
  with it (`stop()` runs the returned stopper). `Alerts#atMidnight` is unchanged: it still
  refreshes just after midnight for notes, and now the watch covers the late case it can't.
- **The time zone is the daemon process's local one.** `localDay` reads local `Date` parts and
  nothing sets `TZ`, so "midnight" is your machine's, unless the daemon is started under another
  zone. There is no time-zone setting. A machine that changes zone while the daemon runs turns
  the day when the date in the new zone differs.
- **A seam for the tests.** `setDayClock(fn?)` in `session/store.ts` changes the clock that
  `localDay()` reads when it is given no date, so `costToday`, `addCostToday`, the daily alert
  and the watch all see the same fake day. With no argument it puts the real clock back.
  Nothing outside `session/verify.ts` calls it. `DayWatch` also takes its own `today()` for
  a unit check.
- **Checked** (`session/verify.ts` §17q), with a fake clock: spend on day 1 passes the budget and
  its alert stands; the clock moves past midnight and a `cost` frame carrying 0 reaches every
  tab, once, with the timer looking ten more times; the alert clears and the tabs hear it; a look
  on the same day sends nothing; a tab that connects reads 0; spend on day 2 shows only day 2's
  total (2, not 8) and yesterday's 6 is kept in `cost_daily`; a clock that jumps three days
  sends one frame; and `DayWatch` alone starts, turns once, and stops.
- **Not done: an agent's own cap.** The composer's "$4.10 of $25" (`budgetUsd`, `budgetTokens`)
  is still a lifetime cap by design (Amendment 77), so it never resets at midnight. Whether that
  was the budget meant, and whether it should become a per-day cap, is the TODO.md item's open
  question. Nothing here touches it.

### Amendment 102 — post-merge, applied. **Re-run from here: start the agents after one again, with its latest reply.**

Shared (`rerun.ts`, new; `index.ts`), daemon (`session/rerun.ts`, new; `session/supervisor.ts`, `routes/session.ts`, `session/verify.ts`) and web (`agent/rerun.ts`, new; `agent/agent.tsx`, `agent/endpoints.ts`, `agent/verify.ts`). A TODO.md item (7 Oct, decided 8 Oct): "re-run from here".
- **`↻ re-run after this`**, in the Agent screen's header, is there only when the agent has agents
  after it. The first press arms it: the header asks `Re-run 2 agents after architect?`, a banner under
  it says what will happen (who goes again, who is stopped first, that the folder is left alone), and
  **↻ re-run 2 agents** commits. Stop controls, fold, export and interrupt give way while it is armed.
  It is manual on purpose: a conversation with the architect must not re-run the whole stack on every
  message. It has no colour of its own (`fl-btn is-ghost`, `is-primary`, `ag-confirm-q`, the `t-warn`
  banner), so it reads in both themes.
- **`POST /api/agents/:id/rerun`** → `RerunResponse` (`{ from, agents: [{ agentId, role, action,
  stopped }] }`). 404 for an unknown agent; **409** with the reason in `detail` when it can't be done:
  nothing comes after it, it is still working / waiting for you / paused / failed, it has written no
  reply, an agent after it was stopped or is only just starting, an agent after it (or the job) is at
  its budget. A refusal changes nothing: everything refusable is checked before the first agent is
  stopped. The web's `explain` already passes a 409's sentence through.
- **`rerunPlan(agents, rootId, { hasReply })`** (`shared/src/rerun.ts`) is the one copy of the rules,
  as `stack.ts` is for removal: the daemon applies it and the button reads it, so what the banner
  says is what the daemon does. "After it" is everything downstream through `dependsOn`, however far,
  not through helpers. Steps come in dependency order (the job's own order where that doesn't
  matter). Each is `resume` (it has a session), `start` (failed before it had one: starts from its
  prompt, which now carries the new reply) or `wait` (hasn't started: left alone, reads the new reply
  when it does). `stops` marks one that is working or blocked.
- **`Supervisor.rerunFrom`** (`session/supervisor.ts`) does it. A running agent after it is stopped
  first (its input is stale) the way `pauseAgent` stops one, its session kept; a question it was
  parked on is cancelled, since it was asked about input that changed; its working helpers are
  terminated and the orchestrator hears them as stopped (Amendment 51). Then every agent that goes
  again is set `queued`, with the status note `re-running after architect, whose reply changed`, and
  `pump()` starts them. **Order is `pump`'s**: an agent starts only when every agent it waits for is
  `done`, so the ones that waited for the changed agent go first and the ones behind them wait until
  those are done again. The job is held out of `pump` (`#halting`) while the stops happen, so no
  sibling starts on the old reply. A second press in the same job during that is refused.
- **They resume their own sessions** (`sdkSessionId`, through `pump` → `#launch`, as any queued agent
  with a session does), with `rerunNote` (`session/rerun.ts`) as the resume prompt. The note is built
  when the agent starts, not when you pressed, so a later agent hears the NEW reply of the one before
  it. It says: your input changed; nothing was reset; look at what is here and fix what no longer
  fits; then the same section a first prompt carries for what the agents before it said last. It
  outranks a parked call's silent re-offer in `#resumePrompt`, and carries the report of any helpers
  that have ended.
- **Nothing in the worktree is touched.** No reset, no cleanup, no file read or written. The test
  checks a file, `git status` and `HEAD` before and after.
- **Checked**: `session/verify.ts` §19 (the order, a diamond, refusals with their reasons, a running
  developer stopped before its resume and its slot given back, the note and the latest reply, the
  later agent hearing the new reply, an unstarted scribe left alone and started as usual, a parked
  question cancelled, a budget refusal changing nothing, an orchestrator and its helper, a failed
  agent with no session) and `agent/verify.ts` §10 (the button only when agents follow, what it says
  it will do, why it can't be pressed, the wiring and no colours of its own).
- **Not done**: the Fleet card and the Project lane have no button (Agent screen only). A restart
  between the press and an agent's start loses the note (it is held in memory, like the restart
  nudge), and the agent resumes with the usual wake nudge instead.

### Amendment 101 — post-merge, applied. **The next agent gets the whole conversation of the agent before it, as text.**

Daemon (`session/handoff.ts`, `eventlog.ts`, `session/supervisor.ts`'s `#promptFor`,
`session/verify.ts`). A TODO.md item (asked 8 Oct, decided 8 Oct: "as text"). It replaces
Amendment 37's "only the final reply, cut at 8,000 characters".
- **What it gets.** For each agent it waited for (and each one it was started without,
  Amendment 88), under `[role]`: the user's messages (`User:`), the agent's replies (`Agent:`) and
  one line for each tool call (`Tool: Edit src/auth/token.ts`), in order. What a tool returned is
  left out; a call that failed says `(failed)`. Edits, spend, status and requests are not in it.
  Messages Conductor wrote (`synthetic`: resume nudges, "switched to opus") are not the user's and
  are left out.
- **Source.** The event log, so it is the same for Claude, Copilot and OpenRouter, and for an
  agent that waited for several. `EventLog.conversation(agentId)` returns only `user_text`,
  `text`, `tool_start` and `tool_end` (the newest 20,000, oldest first); `forAgent` carries every
  kind and stops at 2,000, which a busy agent passes. `turnsFromEvents` turns them into lines.
- **Its launch prompt is not repeated back.** An upstream's first message is the prompt
  `#promptFor` built for it. Its job instruction becomes `(the job instruction, as above)`, since
  the next agent has it at the top, and the line from Amendment 100 is dropped, since the next
  agent gets its own. Its role brief stays, and so does the handoff it was given in turn: a chain
  A, B, C hands C everything B knew, A's part included. That part is the oldest, so it goes first
  when the cap is reached.
- **The cap is about a quarter of the next model's context window** (`handoffCap`), in characters
  at 3 to a token. The repo knew no window, so there is a small table (`contextWindow`), which
  gives a floor, not the real figure, because a bigger window only means it is given less than it
  could take: Claude 200,000 tokens, 1,000,000 with `[1m]`; `gpt-`, `o<digit>` and `gemini` 128,000;
  anything else 64,000. A `vendor/` in front of the id is ignored. That is 150,000, 750,000, 96,000
  and 48,000 characters.
- **Over the cap, the oldest goes first.** Whole entries, from the start (`fitTurns`); the section
  says `… (the first 7 of 10 entries are left out to fit)`. The last reply is never cut or dropped,
  even if it alone is over the cap, and a run of tool calls after it does not push it out.
- **Several upstreams share the cap** (`shareCap`): an equal share each, and what one does not
  need goes to the rest. Needs of 10, 500 and 900 against 600 get 10, 295 and 295.
- **The job instruction is outside the cap.** `#promptFor` puts it first and the cap covers only
  the handoff section.
- **Unfinished upstreams keep their wording** (Amendments 51, 88): `[role — stopped, so it may
  not have finished its part]`, the "started without waiting for every agent" opening, and "(It
  was stopped before it wrote a reply.)". An orchestrator's report on its helpers
  (`helperReport`) is unchanged: each helper's last reply, cut at 8,000 characters. `HANDOFF_CAP`
  is gone; that figure lives only there now.
- **A seam for `hand_off`.** `Upstream` has an optional `summary`. When set, `handoffSection`
  prints `Its summary of its work:` and the summary first under the role, whole and not counted in
  the cap, then the conversation. Nothing sets it yet.
- **A question's answer.** The log keeps the answer to a question asked with the question tool only
  as the one-line result of the tool call (the `resolved` event holds the decision type, not the
  answers). So a `Tool: asked the user · <question> → <result>` line carries it, the one place a
  tool's result is passed on. It reads as long as the tool's own summary, 100 characters.
- **Checked** (`session/verify.ts` §17): the debugger's messages, notes, replies and tool lines
  arrive in order, with no tool output and no Conductor message; the job instruction appears once;
  the question and its answer; the oldest go first, exactly at the cap and one over; the last reply
  stays whole over the cap and after trailing tool calls; three upstreams share the cap; a
  200,000-character job instruction is first and whole with 400 replies cut to a quarter of
  opus's window; stopped and failed wording; the helper report is as it was; the summary seam; the
  window table and the cap; the turns from hand-written events. Three tests in §17o (two) and §17p
  now expect `[role]\nAgent: …` where they expected the bare reply.
- **Not done**: reading a model's real window (OpenRouter's list has `context_length`; nothing
  uses it); counting tokens, since the cap is in characters; `hand_off`; the same treatment for an
  orchestrator's helpers. A forked session was not built. A resume is not given the text again.

### Amendment 100 — post-merge, applied. **An agent in a stack is told to ask with the question tool, not in prose.**

Daemon (`session/handoff.ts`, `session/supervisor.ts`'s `#promptFor`, `session/verify.ts`). A TODO.md
item (asked 7 Oct, decided 8 Oct: "yes").
- **One line in the first prompt** of an agent that is in a stack: it waits for another, was
  started without one that was stopped (Amendment 88), or another agent waits for it. It says
  to ask the user with the question tool (`AskUserQuestion`, or `ask_user` in Copilot and
  OpenRouter), not in its reply: a question in the reply ends the turn and the agents after it
  start without the answer; the question tool holds it, and them, until the user has answered.
  An agent on its own gets nothing extra, so its prompt is unchanged.
- **Where.** After the handoff section (Amendment 37) and before the agent's own brief, so the
  brief is still last. `inStack` and `stackLine` in `handoff.ts` are pure; `#promptFor` only
  asks them.
- **Why it works without new machinery.** A question asked with the tool is already held in
  Needs You (`arbiter/index.ts`) and `#settle` starts nothing after an agent that is blocked. The
  architect in the TODO example ended its turn on a question in prose, which `#settle` read as done.
- **OpenRouter gets the question tool.** Checked, not changed: OpenRouter runs on
  `CopilotBackend` (`backends/index.ts`), whose one `#config()` gives every session
  `onUserInputRequest`, and the SDK turns `ask_user` on from that (`requestUserInput:
  !!config.onUserInputRequest`, on create and on resume). `verify.ts` now asks a question
  through an OpenRouter agent's session and answers it.
- **Checked** (`session/verify.ts` §17, and §17l for OpenRouter): the line is in an agent that
  waited, after the handoff and before its brief; an agent that others wait for gets it though it
  waited for nobody; an agent on its own does not; `inStack` is true for the waiting and the
  waited-for, and for one started without a stopped agent; an OpenRouter agent's `ask_user` is a
  question in Needs You and its answer comes back.
- **Not done**: it does not replace the later `hand_off` tool. An agent can still end with "I'll
  wait", and the line says nothing against it. An orchestrator's helpers are not told: they report
  to the orchestrator, not to the user. A resume does not repeat the line; the session already has it.

### Amendment 99 — post-merge, applied. **Move rows in Spawn to set who each agent waits for.**

Web only (`spawn/order.ts` and `spawn/reorder.tsx`, new; `spawn/route.tsx`, `spawn/CustomSetup.tsx`,
`spawn/RoleRow.tsx`, `spawn/custom.ts`, `spawn/spawn.css`, `spawn/verify.ts`; `docs/MANUAL.md`). The
second half of a TODO.md item (8 Oct): "an agent's place in the stack sets what it can wait for".
The daemon half is Amendment 98, so `packages/daemon` and `packages/shared` are not touched.
- **Move a row.** Each row of the plan under the presets, and each row of a Custom setup, has
  **↑ ↓** buttons and a **⋮⋮** grip. The buttons are real buttons, named for the row ("Move
  reviewer up"), so they work from the keyboard, and focus follows the row to its new place so the
  next press moves the same row. The grip is native HTML5 drag and drop (as Fleet's cards use,
  Amendment 54): drop on another row to put it there, with a line showing where it lands. No
  drag library. A one-row preset or setup has no buttons.
- **The default is a chain.** Each row waits for the one directly above it. A new Custom row
  waits for the one above it (`addRow`); it was empty before. The presets keep the waits they
  have in code; three of the full pipeline's five are the chain, and the reviewer (three
  ticks) and the scribe (two) are not.
- **The ticks stay.** Every row but the first shows **waits for**, one box per row above it
  (`WaitsFor`, taken out of `RoleRow` so the plan's rows and Custom's rows and a job's "+ agent"
  share it). The plan's rows show them for the presets; they are kept in the stack's order.
- **Moving re-checks the ticks** (`moveRow`, `spawn/order.ts`). A tick that now points at the row
  itself or at a row below it is dropped; one that still points above is kept, so the full
  pipeline's reviewer keeps its three when moved down one place. A row that waited for exactly
  the row above it (the chain) waits for whichever row is above it now, so a chain stays a chain
  when one row is moved out of it. A row left with no ticks that had some waits for the row
  above it. A row set to wait for no one (not the first) stays that way. The first row waits
  for no one. A dropped tick is not remembered: moving the reviewer below the scribe and back
  does not bring the scribe's wait for it back.
- **For this launch only.** A change to a preset's rows is held in the Spawn screen's state
  (`arranged`) and nowhere else: it isn't written to a setting, and the preset doesn't become a
  Custom setup or a saved one. Choosing a preset (the same one again too) puts its own rows
  back, as does **↺ back to …** in the plan's header, which shows only while rows are changed.
  Moving a row back to where it was clears the change. The job's `preset` label is still the
  preset's own name.
- **Both themes.** The new rules use only tokens `lib/verify.ts` already measures (`--ink`,
  `--ink2`, `--ink3`, `--line`, `--line2`); the grip and the note read as `--ink3`. No new
  colour, so `lib/verify.ts` is unchanged.
- **Checked** (`spawn/verify.ts` §18): the default chain; which rows are on it; a move within
  bounds keeping the reviewer's three ticks; ticks dropped when they now point below; the chain
  re-forming around a moved row; a row left with nothing; a parallel row staying parallel;
  ticking in stack order and refusing a row below or itself; for every move of every preset,
  every row waits only for rows above it (what the daemon requires), none is lost, and none
  that waited ends up waiting for no one; the launch is sent in the new order; `PRESETS` is
  byte-identical afterwards; the change is never written to a setting; a Custom setup moved any
  way has no problems; the buttons, their names and the native drag are in the source; no drag
  library; the CSS has no colour of its own.
- **Not done**: removing a Custom row doesn't re-chain the rows that waited for it (they wait
  for no one, as before). Moving rows in a running job's stack, and the job's "+ agent", are
  unchanged (it still picks what it waits for from the job's agents). Not looked at in a
  browser: the drag, the drop line and the look in both themes need the user's eye.

### Amendment 98 — post-merge, applied. **A launched agent can only wait for one listed before it.**

Daemon (`routes/session.ts`, `session/verify.ts`). The first half of a TODO.md item (8 Oct):
"you can only depend on agents in the stack before you".
- **`parseAgentSpecs`** refuses a launch where an agent's `dependsOnRoles` names a role listed
  after it: 400, `invalid agents`, with "… depends on developer, which comes after it — an agent
  can only wait for one before it". An unknown role and the agent itself are refused as
  before.
- **Why in the daemon.** Spawn's Custom rows already offer only the agents above them
  (`spawn/custom.ts`), and every preset lists its roles in order. A request could still skip
  the UI and name a later agent, or two agents waiting for each other, which leaves both
  `queued` forever. The order is the stack's order, so "before" needs no new field.
- **Not changed:** adding an agent to a running job (Amendment 89). Its `dependsOnRoles` can
  only name agents that already exist, and its `feeds` are checked for loops with
  `createsCycle`.
- **Still open:** choosing who each agent waits for on a preset's rows.

### Amendment 97 — post-merge, applied. **The project / agent label at the top has its own backdrop.**

Shared (`tokens.css`) and web (`fleet/fleet.css`, `agent/agent.css`, `lib/verify.ts`). A TODO.md
item (7 Oct, and again on 8 Oct: "it is still not very visible").
- **`--here`**, a new colour token for both themes: `#1f3047` dark, `#d6e0f0` light. It's
  not a status colour (§5.1), so it never reads as one.
- **`.fl-crumb`** sits on it, with a border mixed from `--here` and `--ink3`, 5px corners,
  `3px 10px` padding, and `--fs-md` instead of `--fs-base`. That's the label on the Project
  screen (`project / ⑂ branch`), the Agent screen (`project / role`, still a button back to
  the project; its border lights on hover) and the Fleet header.
- **Checked**: `lib/verify.ts` fails unless `--ink`, `--ink2` and `--ink3` are at least 4.5:1
  on `--here` in both themes. They are 10.9, 6.6 and 4.9 in dark, and 13.2, 7.3 and 4.9 in light.
- **Not done**: a different colour per screen, which is still open in TODO.md. The top bar's
  **Project** and **Agent** tabs are Amendment 95.

### Amendment 96 — post-merge, applied. **The agent's settings under the message box fold away.**

Web only (`agent/settingsfold.ts`, new; `agent/composer.tsx`, `agent/agent.css`,
`agent/verify.ts`). A TODO.md item (8 Oct).
- **settings ▸ / ▾**, beside **⇧⏎ newline**, folds the guardrails pills and the interaction,
  effort, model and budget rows. The message box and **send** don't fold.
- **Folded, one line says what is set**: `ask me · high · sonnet-5-5 · $4.10 of $25`
  (`settingsSummary`). An engine with no effort leaves it out; a token budget reads
  `184k of 500k tokens`; no cap reads `$4.10 spent`. The line turns `--fail` when the budget is
  reached or the mode is unsafe (`summaryAlarm`), and the unsafe mode's sentence, a model
  warning and any notice still show.
- **One setting for every agent**, `conductor.agentSettings`: absent or `shown` is open,
  `hidden` is folded. It's in Settings, so it's the same in every browser, as the details
  panel is. It isn't a layout key, so resetting panel sizes leaves it, as it leaves the
  details panel.

### Amendment 95 — post-merge, applied. **The top bar's tabs read louder, and the open one stands out with a tint and a heavier underline.**

Web only (`shell/shell.css`'s `.sh-screens`, `lib/verify.ts`).

- Every tab's ink moves from `--ink3` to `--ink2`, with `font-weight: 600`, so an
  unselected tab reads louder against the bar even before you look at which one is open.
- The open tab (`.sh-screens button.on`) now gets `color: var(--ink)`, a tinted background
  — `color-mix(in srgb, var(--ink) 7%, var(--bg2))`, the same `color-mix` tint pattern
  `agent.css` already uses for a selected row — in place of a flat surface colour, and a
  3px accent underline (`box-shadow: inset 0 -3px 0 var(--ink)`), up from 2px.
- `lib/verify.ts`'s §9 contrast block gains a check for `--ink` and `--ink2` against that
  tinted background in both themes (computed ratios: dark `--ink` 12.72:1, `--ink2`
  7.72:1; light `--ink` 12.54:1, `--ink2` 6.97:1 — all clear 4.5:1 with margin), and a new
  §33 confirms the heavier ink/weight, the tint, and the 3px underline read back from
  `shell.css` correctly.

**Verified:** `lib/verify.ts` §9 (new tab-ink-on-tint checks) and §33 ("the top bar's tabs
read louder, and the open one stands out"). `make test` is green.

### Amendment 94 — post-merge, applied. **Working and finished are filled in the navigator and agent tabs too; a nested repo's branch shows beside its folder, in Files and the navigator alike.**

Web only (`shell/Navigator.tsx`, `shell/shell.css`, `agent/agent.tsx`, `agent/agent.css`,
`files/FileTree.tsx`, `files/files.css`, `shell/verify.ts`, `files/verify.ts`,
`agent/verify.ts`). Carries the filled-tag convention (Amendment 93) and the nested-repo
branch mark (Amendment 90) into the places that still showed the old tinted tag, or no
branch mark at all.

- **Navigator agent rows and job groups** (`Navigator.tsx`, `.sh-nav-tag` in `shell.css`)
  now render the same filled look as `.ui-tag.t-live`/`.t-done`: `background:
  var(--live)`/`var(--done)`, `color: var(--bg)`, `font-weight: 700` — reusing the same
  tokens, nothing new. An agent row shows filled **working** or filled **finished**; a job
  group shows filled **working** when nothing in it has finished yet, filled **finished**
  once it has. `.is-fail` is unchanged (tonal, as before).
- **Agent tabs** (Amendment 49, `agent.tsx`/`agent.css`) gain a filled **finished** tag
  (`.ag-tab-tag`, `background: var(--done)`, `color: var(--bg)`) on a done agent's own tab;
  a working one already pulses via the tab's `Dot`, so no separate tag was needed for that
  state.
- **`FileNode.repo?.branch`** (Amendment 90) now shows beside a nested repo's folder as a
  quiet mark — `⑂ <branch>`, or `⑂ detached` when `branch` is `null` — in both the Files
  tree (`FileTree.tsx`'s `.c5-repo`) and the navigator's folder rows (`Navigator.tsx`'s
  `FileRows`, `.sh-nav-repo`). Both marks are `color: var(--ink3)`, no status colour,
  matching the icon+text convention `files/route.tsx` already uses for a job's own branch.

**Verified:** `shell/verify.ts` §10 ("the carry-through: filled marks and a nested repo's
branch"); `files/verify.ts` ("a nested repo's branch, beside its folder"); `agent/verify.ts`'s
Tabs block (a finished agent's own tab says so, filled). `make test` is green.

### Amendment 93 — post-merge, applied. **Working and finished are filled, edged and plainly worded.**

Web only (`shell/ui.tsx`, `shell/ui.css`, `fleet/card.tsx`, `fleet/lane.tsx`, `fleet/fleet.css`,
`lib/verify.ts`). The three "Seeing what's happening" items of 7 Oct.

- **`Tag` tones `live` and `done` are filled, not tinted** (`ui.css`): a solid `background:
  var(--live)`/`var(--done)`, `color: var(--bg)` (the same ink `.sp-go` and `.sh-alert-n`
  already put on a status fill), `font-weight: 700` against the base `.ui-tag`'s 600, at the
  same `--fs-2xs`. `--bg` on `--live`/`--done` clears 4.5:1 in both themes (dark 10.96:1 /
  9.46:1, light 5.74:1 / 5.66:1 — `lib/verify.ts`, §9 and the new §32). `need`, `fail`, `queue`
  and `idle` are unchanged: only the two states someone scans the grid for, working and
  finished, are filled.
- **The 3px left edge.** The Fleet card already carried one, driven by its existing
  `stripe`/`s-${stripe}` class and `.fl-card::before` (unchanged). The agent lane did not: it
  now gets the same treatment as an inset shadow — `.pj-lane.s-live` /
  `.pj-lane.s-done { box-shadow: inset 3px 0 0 var(--live|--done); }` — set from `STATUS_KEY`
  in `lane.tsx`, mutually exclusive with the existing amber `.is-need` treatment for a blocked
  lane.
- **The pulse.** `.ui-dot.d-live`'s `animation: conductor-pulse var(--pulse-slow)` (1.7s) and
  the global `@media (prefers-reduced-motion: reduce)` override in `tokens.css` already met
  this; both predate this amendment and needed no change, only the new §32 check that pins
  them down by name.
- **The word.** `STATUS_WORD.done` is now `'finished'`, so every place that renders it —
  the Fleet card's and the Project screen's fallback tag, the agent lane's tag, the Agent
  screen's header, the navigator's agent rows — says **finished** instead of **done**. The
  Fleet card's agent-row elapsed column had its own hardcoded `'done'` label (`card.tsx`,
  the `fl-arow-el` span); it now reads `'finished'` too, for the same reason.
- **Unseen is untouched.** `lib/seen.ts` and `attention/notify.ts` are unchanged: "unseen
  finished" stays per job (Amendment 87), so the tab badge can't double-count against a
  per-agent mark that doesn't exist.
- **`lib/verify.ts`** gains an explicit `--bg` on `--live`/`--done` check inside the existing
  contrast section (§9, named apart from the generic fill loop so a regression in either
  reads as its own failure) and a new §32 that reads `ui.tsx`, `ui.css`, `lane.tsx`,
  `fleet.css` and `card.tsx` to confirm the filled tag CSS, the lane's edge classes, the dot's
  animation and reduced-motion handling, and the word change, all stay in place.

**Known gap, not fixed here:** `docs/MANUAL.md:925` currently reads *"A terminated agent
reads **stopped** — not "done", which would claim it finished."* That line quotes the old
`STATUS_WORD.done` value by name; the contrast it draws (stopped vs. finished) still holds,
but the word it names no longer exists. It should become *"not **finished**"* when this text
is applied.

### Amendment 92 — post-merge, applied. **A project's Files folders open into their directories as a tree, in the navigator.**

Web only (`shell/navtree.ts`, `shell/Navigator.tsx`). The navigator's **Files** submenu used
to list a project's folders flat, each a button that jumped straight to the Files screen on
that root. Now each folder is a node that opens and closes like every other row in the panel,
and while open shows its directories and files, nested arbitrarily deep.

- **`navDirId(projectId, root, path)`** names one directory's node:
  `p:<projectId>:files:<root>:<path>`. A folder's own node is `path: ''`; a directory under it
  is named by its own root-relative path. Because the id carries the project, the root and the
  path, a folder opened under two different projects, or two different folders of the same
  project, never share a node even when their trees hold a directory of the same name. Ids are
  kept in settings exactly as every other node's is (`NAV_TREE_KEY`, `toggleOpen`).
- **`navFileLink(root, path)`** is `{ jobId: root, path }` — the same shape `applyLink`
  (`files/tabs.ts`) reads off a `#files` deep link, so a file row's click is indistinguishable
  from following that link.
- **Fetching.** Each open folder mounts its own `useFileTree(folder.root)`
  (`files/useWorkspace.ts:297`) — the Files screen's own hook, not a second mechanism — so a
  folder nobody opens costs nothing, and reopening one shows its last tree at once while a
  fresh copy is asked for underneath. A directory under it is likewise fetched only once, from
  the one tree its folder already holds; opening a nested directory draws from the same
  response rather than issuing another request.
- **Order.** Folders come first, then files, in the order the tree already arrives in: the
  daemon's `buildTree` (`workspace/tree.ts`) sorts `children` dirs-first-then-alphabetical
  before it answers, and the Files screen's own tree trusts that order rather than re-sorting,
  so the navigator does too.
- **No change marks.** Unlike the Files tree itself, nothing here reads a node's `change`. This
  is a deliberate, reversible default (ADR 0003, decision 2); a later amendment may add them,
  alongside `FileNode.repo`'s branch mark (Amendment 90).
- **Clicks.** A folder's row toggles open/closed, with `aria-expanded` and the same keyboard and
  focus behaviour as every other navigator row. A file's row calls
  `navigate('files', navFileLink(root, path))`, opening it on the Files screen; the panel stays
  up.

**Verified:** `shell/verify.ts` §9: the `navDirId` format, that project/root/path each make a
distinct id and a folder's own node never collides with one of its directories, `navFileLink`'s
shape, and that `Navigator.tsx` wires `FolderNode`/`FileRows` through `useFileTree`, `toggle` and
`navigate(SCREEN.files, navFileLink(...))` rather than the old flat click.

---

### Amendment 91 — post-merge, applied. **Files opens on the project you're in, wherever you arrived from.**

Web only (`shell/nav.ts`, `files/route.tsx`, `files/tabs.ts`, `agent/agent.tsx`). Files used to
open on whichever project was last `highlight`-ed (Amendment 44), but an Agent screen reached by
its own URL, or still open after a reload, never called `highlight` at all — so pressing `5`
could show a stale, unrelated project. The rule is now one rule, checked afresh every time Files
is arrived at, not just read once from memory:

1. a link naming a job or a file wins outright (`applyLink`, unchanged);
2. otherwise, the project the route itself names, with no job (`navigate('files', { projectId
   })`);
3. otherwise, `recall().projectId` — the project last opened or highlighted anywhere
   (Amendment 44, unchanged in meaning, now a second tier rather than the only one);
4. otherwise, only if Files had nothing open at all, the first project.

- **`arrive(s, want: ArriveWant, linked)`** (`files/tabs.ts`) replaces the old positional
  `arrive(s, highlighted, fallback, linked)`. `ArriveWant` carries each tier already resolved to
  a `ProjectPick` (`{ id, first }`) or `null`, so the pure function stays free of the project
  list and the route — resolving those is `files/route.tsx`'s job. Tiers 2 and 3 win outright,
  including over a job already open for a *different* project: `selectProject` always clears
  it, so the job never gets to decide instead.
- **`agent/agent.tsx`** now calls `highlight(agent.projectId)` once the agent has loaded,
  mirroring the Project screen's own `if (project) highlight(project.id)` (`fleet/project.tsx`).
  This closes the actual bug: an Agent screen opened by URL or surviving a reload now says which
  project it's showing, the same as a click into it always did.
- **`files/route.tsx`**'s arrival effect re-reads `currentRoute()` and `recall()` fresh each time
  it runs (once per mount, after projects have loaded) rather than trusting a value captured at
  render time, so a link followed moments earlier still wins over the default that used to flash
  in behind it.

**Verified:** `files/verify.ts` §"a project's directories": the route's project winning over the
remembered one; the remembered project winning when the route names none; a link deciding for
itself regardless of either; another project's job already open giving way to both the route and
the remembered tier; the first-project default applying only to a wholly blank screen, never
pulling you off a project you already had open; and source checks that `agent/agent.tsx` calls
`highlight(agent.projectId)` and that `route.tsx` reads both `params['projectId']` and
`recall().projectId`.

---

### Amendment 90 — post-merge, applied. **Nested repos and submodules open all the way down in Files, marked with their branch.**

Daemon (`workspace/tree.ts`, `workspace/git.ts`), shared (`wire.ts`), fixture
(`fixtures/make-scratch-repo.sh`). `git ls-files` stops at another repo's boundary and hands the
outer repo one opaque entry for the whole thing — a nested clone or an initialised submodule
became a childless file leaf in the tree, which is the bug this amendment closes.

- **`FileNode.repo?: { branch: string | null }`** (`wire.ts`) — set on a directory that is its
  own git repo. `branch` is the nested repo's current branch, or `null` for a detached HEAD or a
  repo with no commits yet (an unborn HEAD names a branch nothing has been committed to; a
  detached one names no branch at all). Additive and optional: no existing `FileNode` consumer
  changes shape.
- **`tree.ts`'s `classifyLevel`** is the one place that notices a repo boundary, by `lstat` on a
  `.git` entry inside a non-symlink directory — never `isRepo` (`git.ts`), which answers true for
  *any* directory inside the outer repo, nested boundary or not. A directory for an ordinary
  clone's `.git`, a file for a submodule's gitlink: both are caught the same way. `lstat`, never
  `stat`, so a symlink is never mistaken for the directory it points at — a link back up the tree
  can't be "expanded" into the infinite recursion that would be.
- **`expandNestedRepo`** re-lists a nested repo with its own `listFiles` (filtered by the same
  `NEVER_LISTED` deny-list — a nested repo's own `node_modules` stays hidden exactly like the
  outer repo's), grafts the result in under the boundary's path, and marks the folder with
  `nestedBranch` (`git.ts`, built on `hasHead`/`currentBranch`, catching every failure to `null`
  so a corrupt or half-cloned nested repo still browses). It recurses into repos nested inside
  that one, up to `MAX_NESTED_DEPTH` (4) levels — a repo found exactly at the limit is still
  marked with its branch, just not listed further. Siblings expand in parallel (`Promise.all`),
  so a project with several nested repos pays for `git ls-files` once per repo per tree request,
  not serially.
- **A listed directory with no `.git` inside it** — an uninitialised submodule looks exactly like
  this: tracked, present on disk, empty — becomes an empty dir node, not a file leaf.
- **Budget.** The outer repo's own paths are always placed ahead of every nested repo's in the
  capped list, so one large nested clone can never push the project's own files out of a tree cut
  short by `MAX_TREE_ENTRIES`; `truncated` and the server-side warn line report the combined total
  dropped, own and nested together. A nested repo's folder — and its branch — is forced into the
  tree unconditionally (`ensureDir`), independent of whether the cap trimmed away every file
  inside it: the folder marking where a nested repo lives is not something the cap is allowed to
  hide.
- **`walkFiles`** (the no-git fallback for an `in_place` isolation outside any repo) stops at a
  nested-repo boundary the same way and hands it to the same expansion, instead of recursing past
  it, so `in_place` and a real git root behave alike.
- **Changes stay the outer repo's own, by design (ADR 0003).** The outer `git status` only ever
  reports a nested repo's whole directory as one opaque, possibly-dirty gitlink, never a path
  inside it, so a nested repo's own changes don't show in the outer tree's change badges.
- **Fixture.** `make-scratch-repo.sh` grows a nested clone (`inner/`, its own commit and branch,
  a `node_modules`, and a symlink back up to its parent that must not be followed) and an
  initialised submodule (`vendor-lib/`, added with `protocol.file.allow=always` since git 2.38+
  refuses a local-path submodule by default).

**Verified:** `workspace/verify.ts` §15 "nested repos browse all the way down": a nested clone's
file and a submodule's file both list at their full path; each folder is marked with its real
branch; `node_modules` inside the nested clone stays hidden; a cap sized to just the outer repo's
own files drops only nested ones, with every own file surviving and the nested repos' folders
still shown, branch and all, even with their files capped out; a symlink back up the tree doesn't
loop. Also checked by hand: reading a file inside a nested repo through the file/image routes
works and never asks the outer repo's git about it — pure filesystem path containment, no fix
needed.

---

### Amendment 89 — post-merge, applied. **Add and remove agents in a job that is already running.**

Daemon (`session/supervisor.ts`, `routes/session.ts`), shared (`stack.ts`, `wire.ts`) and web
(`spawn/stack.ts`, `spawn/AddAgent.tsx`, `spawn/RoleRow.tsx`, `spawn/CustomSetup.tsx`,
`spawn/custom.ts`, `spawn/presets.ts`, `spawn/endpoints.ts`, `fleet/project.tsx`,
`fleet/fleet.css`, `agent/agent.tsx`, `agent/agent.css`, `agent/endpoints.ts`). The second half
of ADR 0002 (`docs/adr/0002-edit-running-stack.md`). A launched job doesn't remember its preset,
so all of this reads the job's agent rows, the same for a built-in or a custom stack.
- **`POST /api/jobs/:jobId/agents`**, body `AddAgentRequest` (an `AgentSpec` plus `feeds?:
  AgentRole[]`), answers 201 `AddAgentResponse` (`{ agent, fed }`), 404 for no such job, and 400
  with the sentence otherwise. The spec goes through `parseAgentSpec`, the per-entry half of
  `parseAgentSpecs`, and `checkProviderModels`: checked exactly as a launch's agents are.
  `Supervisor.addAgent` then checks it against the job:
  - the role isn't taken;
  - `dependsOnRoles` names roles in the job, none of them `stopped`;
  - `feeds` names agents that are `queued`, have no session and aren't helpers;
  - no loop (`createsCycle`): a fed agent upstream of the new one;
  - the same engine as the job's own agents;
  - a cap of its own (`budgetUsd` or `budgetTokens`);
  - `readOnlyRefusal`: a reading role must deny `WRITE_TOOLS` and be in plan or default mode.
    It is refused, not pinned.
- **Then** it inserts the row with `agentRow()`, which `createJob` now uses for each spec too,
  appends the new id to each fed agent's `dependsOn`, emits `queued`, runs `#reopenJob` (a
  finished job comes back), pushes the new and fed rows, `pump()`s, and rolls up, so an agent
  added behind a failed one leaves the job settled. The job's cap grows by the new cap through
  `jobCap`, unchanged.
- **Remove from stack is `DELETE /api/agents/:id`** (Amendment 88). The ADR chose no new route
  and no mode, because the only other behaviour a mode could keep is the stranding.
- **Shared.** `READ_ONLY_ROLES`, `isReadOnlyRole`, `WRITE_TOOLS` and `readOnlyRefusal` move to
  `stack.ts`, with `createsCycle`. `spawn/presets.ts` imports them and re-exports
  `isReadOnlyRole`, so every reading role is still listed once.
- **Web: `+ agent`** on each job's header on the Project screen opens `AddAgent`. The row is
  `RoleRow`, taken out of `CustomSetup` (which now renders its rows with it):
  - role, persona, brief, and **waits for** (`waitOptions`: not helpers, not stopped);
  - **also feeds** (`feedOptions`), model (`ModelSelect` on Claude, an id with the engine's
    list elsewhere) and a cap (dollars or tokens, `parseCap`, required);
  - `addAgentProblems` says what's wrong before the daemon is asked;
  - `addAgentSpec` builds the request. Its autonomy (`addedAutonomy`) is a sibling's that reads
    alike, never a reader's for a writer, else Spawn's defaults. The persona's tool rules go
    over it, a reading role or persona is pinned as `toAgentSpecs` pins one, and the cap is its
    own. Escape closes the editor.
  - Picking a persona renames a row not named by hand (`untouchedRole`, now shared with Custom).
- **Web: remove from stack.** Terminate's confirm on the Agent screen offers **remove from
  stack** beside **✕ terminate**. The banner under the header says what moves
  (`rewirePreview`): "scribe will wait for architect instead.", "validator will start: architect
  is done.", or "developer stays paused, and will wait for no one." An ended agent's **✕
  remove** shows the same banner. While a confirm is armed, the header hides fold all, export
  and interrupt, and the question ends in an ellipsis rather than push its buttons under the
  inspector. The old terminate confirm did that at a normal window width. `removeAgent`
  answers `RemoveAgentResponse`.

**Verified:** `session/verify.ts` §17p:
- adds an agent mid-job, waiting on the developer and feeding the scribe; the job's cap goes
  from $10 to $15;
- refuses a loop (two ways), a duplicate role, an unknown dependency, feeding a started agent,
  a non-list `feeds`, no cap, a reading role that could write or accepts edits, a nickname
  model, another engine, and an unknown job (404), and leaves no row behind;
- the added validator starts after the developer and hears it, and the fed scribe waits for it;
- adding to a finished job reopens it and runs;
- adding behind a failed agent keeps the job settled.

§17o (Amendment 88) covers removing a queued middle agent, removing a running one, and stopping
an upstream one. `spawn/verify.ts` §17 checks `rewirePreview`, the wait and feed options, the
engine, every `addAgentProblems` sentence, `addAgentSpec` on Claude and on OpenRouter, the
read-only pin (which `readOnlyRefusal` accepts), a writer added to a job of readers, a reading
persona, and the cap's default. A headless Chrome against `make fixture` showed the editor in
a job group and the remove-from-stack confirm with its banner, with no console errors.
`make test` is green. `docs/ARCHITECTURE.md` isn't in this repository (Amendment 81), so it
wasn't updated; the ADR carries the design.

### Amendment 88 — post-merge, applied. **Nobody waits for good on an agent that was stopped or removed.**

Daemon (`packages/daemon/src/session`, `routes/session.ts`, migration `120_went_without.sql`),
shared (new `packages/shared/src/stack.ts`; `RemoveAgentResponse` in `wire.ts`) and web
(`packages/web/src/attention`). The first half of ADR 0002 (`docs/adr/0002-edit-running-stack.md`),
fixed ahead of the feature it was found in.
- **The bug.** Stop the architect of a full pipeline and the developer, validator, reviewer
  and scribe waited for good: `#depsSatisfied` was false forever (the dependency was
  `stopped`, or its row gone after a delete), they stayed `queued`, and `#rollUpJob` never
  settled the job.
- **Stopping pauses who waited on it.** `terminateAgent` now runs `#strand(jobId)`: each
  queued agent with no session that waits on a `stopped` agent (not its own helper,
  Amendment 51) or on a row that is gone goes `paused`, with `strandNote(role)` as the
  note: "waits for architect, which was stopped — resume to run without it, or remove it".
  Nothing starts by itself. Only direct dependants are paused; the ones further down wait on
  them. Not while `terminateJob` is stopping the whole job. `reconcile` runs the same sweep
  at startup, for rows a build from before this left queued.
- **Resume runs it without.** `resumeAgent` (`#goWithout`) drops the stopped or gone ids from
  `dependsOn` of an agent that hasn't started, and keeps them in the new
  `agents.went_without` column (JSON `[{ id, role }]`, off the wire). `#promptFor` adds them to
  the handoff with `status: 'stopped'`. `handoffSection` marks such an entry as
  `helperReport` marks a helper that didn't finish:
  `[architect — stopped, so it may not have finished its part]`, and opens with "You were
  started without waiting for every agent before you to finish." A stopped agent that never
  wrote reads "(It was stopped before it wrote a reply.)".
- **A job always settles.** `#rollUpJob` counts a queued agent as settled when it is stuck
  (`isStuck`, `stack.ts`): something it waits on, directly or further up, is paused, failed
  or stopped, or is gone (a helper that ended still counts as ended for its orchestrator).
  So a job behind a failed developer (Amendment 85) settles `failed` too, rather than saying
  working for good. Continuing a failed agent with a message (`#launchWithPrompt`) now
  reopens its job, and `#launch` sets a job that isn't working to working. Otherwise `pump`
  skipped the queued agents of a job settled `failed`.
- **`deleteAgent` rewires** (`rewireOnRemoval`, `stack.ts`). Each agent that waited on the
  removed one and hasn't started (no session, `queued` or `paused`) waits on the removed
  one's own dependencies instead, without duplicates and without the removed agent's
  helpers. It rewires before it terminates, so terminating pauses nobody. An agent paused
  only by `strandNote` that now waits on nothing stopped is queued again: the removal is the
  say-so. Agents that have started are untouched; `#depsSatisfied` lets a gone dependency
  through for an agent with a session. The job then reopens if something in it can start,
  and otherwise rolls up. `DELETE /api/agents/:id` answers `RemoveAgentResponse`
  (`{ removed, rewired: [{ agentId, dependsOn }] }`); `removed` is unchanged.
- **Alerts.** `#blockedDeps` also covers a `paused` agent waiting on a `stopped` one. The
  card's fix for a stopped one is now **resume** on the waiting agent (`AlertAction`
  `continue` gains the label `resume`); one still queued from before has only open and
  dismiss. Its note says to resume, or to remove the stopped one from the stack.

**Verified:** `session/verify.ts` §17o has the pure rewire and stuck rules, and the repro: the
architect stopped mid-run leaves the developer paused with the note, the rest queued, nothing
started and the job settled; resuming runs the developer without the architect, with the
stopped handoff, and the pipeline goes on. Also: `terminateJob` pauses nobody; a restart
pauses legacy rows and starts none; deleting a stopped agent requeues the one it paused;
deleting a queued middle agent rewires the next one and its handoff comes from the one before;
deleting a running agent frees its slot for the one it rewired; a job behind a failed agent
settles `failed` and reopens when continued. `attention/verify.ts` checks the resume action.
`make test` is green.

### Amendment 87 — post-merge, applied. **A job says when it has finished, until you've seen it.**

Web only: new `packages/web/src/lib/seen.ts`; `attention/notify.ts`, `attention/always.tsx`,
`fleet/card.tsx`, `fleet/project.tsx`, `shell/navtree.ts`, `shell/Navigator.tsx`,
`shell/shell.css`. From TODO.md's two items of 6 Oct. No wire or daemon change.
- **Finished** is the job's own roll-up: `status` `done` or `failed` with an `endedAt`
  (`isFinished`), which `#rollUpJob` sets once none of its agents can make progress. A job
  with no agents left (settled `done` when its last agent is removed) is never shown.
- **Seen** is one Settings key, `conductor.seenJobs`, holding
  `{ since: ISO, jobs: { <jobId>: <endedAt seen> } }` (`SeenState`, `parseSeen`,
  `serializeSeen`). A job is unseen when it is finished, has an agent, and its `endedAt` is
  after both `since` and the end time kept for it (`unseenFinished`), so a job continued
  and finished again is unseen again. Before the key exists nothing is unseen;
  `startSeenOnce` writes `{ since: now }` once the daemon's settings arrive, so the first load
  doesn't light every old job. `markSeen` keeps each job's current `endedAt`, drops jobs that
  no longer exist, and returns null when nothing changes, so `markJobsSeen` writes only a
  real change. A broken value reads as not kept.
- **Who marks.** The Project screen marks its own project's unseen jobs; the always-on
  notifier marks the job of the agent on the Agent screen (`seenOnAgent`). Both only while
  the tab is visible (`useTabVisible`). The Project screen keeps the ids it marked for the
  visit, so their groups go on saying finished until it unmounts or the project changes.
- **The ladder.** `badgeState` takes a fourth `finishedCount` (default 0), counted but never
  urgent. `useLadderEffects` takes an optional `finished: LadderFinished[]`
  (`{ key: 'job:<id>:<endedAt>', title, body, projectId }`): rung 2 shows one notification
  per key, rung 3 doesn't chime for them, and the keys join the live-id pruning.
  `LadderTarget` gains `{ projectId }`, which `always.tsx` opens with `openProject`.
  `enableDesktop` pre-marks the finished keys on screen, as it does requests and alerts.
- **The marks.** The Fleet card's headline is a `finished` Tag (tone `done`, or `fail` if a
  finished job failed) beside needs-you or working, or in place of the status word. The
  Project screen's `JobGroup` takes `finished`. `navTree` and `groupByJob` take an optional
  `finished: ReadonlySet<jobId>`, and `NavJob` gains `finished: boolean`; the navigator draws
  it as `.sh-nav-tag.is-done`/`.is-fail`, never `--need`.
- Checked in `lib/verify.ts` §31, `shell/verify.ts` §8 and `attention/verify.ts`.

### Amendment 86 — post-merge, applied. **The navigator groups a project's agents by job.**

Web only (`packages/web/src/shell`). From TODO.md's item of 6 Oct.
- **The groups.** `NavProject` gains `jobs: NavJob[]` beside the flat `agents`, which stays
  as it was. `groupByJob` puts each job's agents together where its first agent is, so the
  groups come newest first, as `agentTabs` orders the rows. A `NavJob` is `{ id, label,
  agents, status, needs }`: `label` is the job's prompt on one line (`jobLine` folds every
  run of whitespace) and falls back to the job id when the job isn't known. `status` is its
  unhappiest agent's, by the Fleet's `SORT_RANK`. `needs` is the sum of its agents'.
  `navTree`'s `jobs` now needs `prompt` as well.
- **Open state.** A group is `p:<id>:job:<jobId>` (`navJobId`), in the same
  `conductor.navTree` set. It is the one node that **starts open**: its id in the set means
  you closed it (`jobShown`). So a new job's agents show without a click, and nothing is
  migrated. The same `toggleOpen` flips it and touches nothing else.
- **The panel.** Agents draws one `JobGroup` per job: a chevron, the dot, the prompt
  (ellipsed), the count, and the amber `.sh-nav-need` count when something waits. The
  agent rows under it are unchanged. A project with one job still shows its group.
  Helpers (Amendment 51) are listed in their job, not under the agent that made them. The
  new `.sh-nav-jhead` is never amber (§5.1).
- **Checks.** `shell/verify.ts` §8.

### Amendment 85 — post-merge, applied. **A stopped agent has an end time, and an agent waiting on a failed one says so.**

Daemon (`packages/daemon/src/session`), wire (`packages/shared/src/wire.ts`) and web
(`packages/web/src/attention`, `packages/web/src/shell/describe.ts`). From TODO.md's two
"Possible bug" items of 6 Oct, both confirmed in the code first.
- **Stopped gets `ended_at`.** `setAgentStatus` set it only for `done` and `failed`
  (`store.ts:534`), so a terminated agent's clock (`shell/clock.ts`) kept counting from when it
  started. `stopped` now sets it too. It is final (`terminateAgent`: "a stopped one is not
  coming back"), so nothing resumes it and the time never moves again. The other readers
  (`fleet/order.ts` recency, the alerts' `since`) want the same.
- **Waiting on a failed agent.** `#depsSatisfied` (`supervisor.ts:638`) lets a failed or
  stopped dependency through only for a helper's orchestrator (Amendment 51), so the reviewer
  after a failed developer sat `queued` with nothing saying why. By decision it **stays
  queued**: continue the failed one and, once it is done, the waiting one starts. The
  supervisor is unchanged.
- **Wire, additive.** `AlertKind` gains `'blocked_dep'`, and `Alert` an optional `blockedBy`
  (the agent waited on). `agentIds` is the waiting agent alone, so the failed one, which has
  its own `failed` alert, isn't counted twice on its tab. An older web build would not know
  the kind (`AlertCard`'s `KIND` has no entry), but web and daemon ship together, and Vite
  reloads an open tab.
- **Derived**, like the other agent alerts (`alerts.ts` `#blockedDeps`): one per queued agent
  and direct dependency that is `failed` or `stopped`, a helper's orchestrator excepted.
  `cause` is the dependency's status. The id carries the dependency's last status event, so a
  dismissal lasts until that agent ends badly again. It clears itself when the dependency runs
  again or the waiting agent leaves `queued`.
- **The card** is **Waiting**, amber: "reviewer is waiting on developer, which failed", a
  **waiting on** line, then **continue developer** (when its session can be resumed), **open
  developer** and dismiss. Waiting on a stopped agent offers only open and dismiss, and says to
  stop this one too. The notification reads "demo · reviewer needs you"; the top bar, "waiting
  on a failed agent" (or stopped).

**Verified:** `session/verify.ts` checks a terminated agent's `ended_at`, and that a queued
agent waiting on a failed or stopped one is an alert on the waiting agent (with `blockedBy`),
stays queued, isn't one for a helper's orchestrator or an agent that isn't queued, and clears
when the failed one runs again. `attention/verify.ts` checks the actions (continue and open the
failed one; only open for a stopped one), the title, the notification and the top bar's word.
`make test` is green.

### Amendment 84 — post-merge, applied. **Fewer built-in personas, and the full pipeline reads the plan.**

Web only (`packages/web/src/spawn`). From four TODO.md items of 6 Oct: fewer built-in
personas, the developer on sonnet, the validator reworded, and the architect's plan for the
reviewer and the scribe. No wire or daemon change: a role is still a free string.
- **Seven built-ins, not ten.** `builder`, `documenter` and `uiux` are gone (`personas.ts`).
  The builder differed from the developer by one clause of its brief, and the documenter and
  the scribe both write docs. uiux has no successor. `KNOWN_ROLES` drops the three, and a new
  Custom setup's first row is `developer`.
- **The presets follow.** **bug fix** and **one agent** run a `developer`, keeping their own
  tier and brief. **analysis** keeps its id, label and brief, and its writer is now a `scribe`.
  **Analysis Only** is unchanged.
- **The full pipeline.** The developer row and the `developer` persona run on `sonnet`: the
  architect has decided the plan, and executing a decided plan is what sonnet is for
  (`TIER_HINTS`). The validator row now "tests what was built", against the description and
  the architect's plan. The `validator` persona now "Tests what was built and reports what
  fails." The reviewer waits for `architect, developer, validator` and reviews against the
  plan. The scribe waits for `architect, reviewer`. Both are now handed the architect's final
  reply (Amendment 37), which is option G in `docs/adr/0001-preset-stacks.md`. Each first
  prompt can be up to 8,000 characters longer (`handoff.ts`).
- **Old settings, converted on read** (`renamedPersona`, and `migrated` in `parseStored`).
  Stored edits to `builder` move to `developer`, and edits to `documenter` move to `scribe`.
  An edit already under the new id wins, and edits to `uiux` are dropped. The next save
  writes the setting without them. A saved Custom row that picked `builder` or `documenter`,
  or is named for one and picked nothing, runs as `developer` or `scribe`. It keeps its role
  name, so what waits on it and its saved model still apply. A row that picked `uiux` runs
  with no persona.
- **Agents already launched** keep their role and the persona fields copied into their spec
  (Amendment 68). `AgentRole` in `shared/events.ts` still lists `builder` and `uiux`, since
  old jobs carry them.

**Verified:** `spawn/verify.ts` §16 checks:
- the full pipeline's order, tiers, briefs and waits, and that the validator still waits for
  the developer alone;
- bug fix, one agent and analysis on their new roles;
- that no preset names a removed role;
- the seven built-ins and the known roles;
- that edits move from builder and documenter, that an existing edit wins, that uiux edits
  are dropped, and that the next save cleans the setting;
- that a saved setup's builder, documenter and uiux rows resolve as described.

The Amendment 68 and 70 checks now use `developer` where they used `builder`. `make test` is
green.

### Amendment 83 — post-merge, applied. **A note can be copied, and its delete says so.**

Web only (`packages/web/src/fleet`, `packages/web/src/lib`); no wire change. From TODO.md "Copy a
note, and make deleting one easy to find".
- **⧉ copy** in each note's actions puts its text on the clipboard, exactly as written (no due
  date or age), and shows **✓ copied** for a moment. `NoteRow` is shared, so it's in the Project
  column, the Fleet card's panel and the Agent inspector.
- The Fleet card's note line has a compact **⧉** beside it. It stops its click and keydown, so
  copying doesn't open the project.
- The delete button reads **✕ delete**, so it isn't confused with the due picker's **✕** ("no
  due date"). Its confirm is unchanged.
- `copyText` (`lib/clipboard.ts`) uses `navigator.clipboard.writeText`, which needs a secure
  page (localhost, 127.0.0.1, https). Elsewhere it throws, and the button shows **couldn't copy**
  with the reason. There is no `execCommand` fallback for a LAN address, by decision.

**Verified:** section 24 of `lib/verify.ts` checks copy in the row and on the card, that the
card's copy stops propagation, the **✕ delete** label, that a stubbed clipboard receives the
text exactly, and the error with no clipboard. `make test` is green.

### Amendment 82 — post-merge, applied. **The full pipeline starts with the architect, and there is an Analysis Only stack.**

Web only (`packages/web/src/spawn`); no wire change. From TODO.md "New preset stacks".
- **full build pipeline** is now architect → developer → validator → reviewer → scribe. Only
  the architect starts at once; each later role waits on the one before it (the reviewer on
  developer and validator).
- **Analysis Only** (`analysis-only`) is the analyst, then a scribe that writes the findings
  down. The analyst stays a read-only role. The existing **analysis** stack, which ends in a
  documenter, is unchanged.
- **developer** is a new built-in persona and a known Custom role: builder's brief, told to
  follow the architect's plan. **builder** stays, for bug fix, one agent and Custom setups.
- MANUAL's preset table and persona list say so.

**Verified:** `spawn/verify.ts` checks the order, who starts at once, Analysis Only's roles
and read-only analyst, and the developer persona; the tests that used the full preset's
`builder` row now use `developer`.

### Amendment 81 — post-merge, applied. **The docs say what each engine can and can't do.**

Step 8 of `docs/plans/multi-provider-backends.md`, its last.
- **README:**
  - Prerequisites gain the two optional rows: a Copilot login, and `OPENROUTER_API_KEY`.
  - Known gaps say Copilot and OpenRouter report no dollars and lose a waiting request on
    restart.
  - `OPENROUTER_API_KEY` joins the environment variables.
- **MANUAL:**
  - §2 gains "Choose the engine": the three engines, what each needs, where the key is
    kept, the one model id per launch, and what differs. The differences are budgets in
    tokens, no plan mode, and expired requests after a restart. §0 and §6 point at it.
  - `make fixture` is described as what it now replays (Amendment 80).
- **TODO.md:** the work is recorded as done, with the spike commands that still need
  running against the real services.
- **`docs/ARCHITECTURE.md`:** README already links it and it exists, but it is not in git
  and Conductor didn't write it, so it is left as it is.

**Verified:** the words were checked against the merged build. A throwaway daemon and
headless Chrome showed:
- Copilot struck through, with its login sentence.
- OpenRouter offered once a key was saved: 465 models, and the pill reading
  "stop each agent after 5M tokens".
- **plan first** hidden.
- Settings' Providers section.

The test key appeared in no page and no log, and `~/.conductor/secrets.json` was not
written in override mode. `make test`: 10 PASS, exit 0.

### Amendment 80 — post-merge, applied. **The screens choose an engine, and show only what it can do.**

Step 7 of `docs/plans/multi-provider-backends.md`. Web and fixtures only; no wire change.
- `lib/providers.ts` reads `GET /api/providers` once for every screen. `capabilitiesOf`
  gives Claude everything, an engine the daemon describes what it says, and an engine it
  doesn't describe nothing. `controlsFor` and `offersMode` decide what a screen shows.
  `tokenWords` is the daemon's `tokens()`, so both say the same figure, and `parseTokens`
  reads `500k` or `1.5M`. The two routes Lane A is building have their answers typed here:
  `OpenRouterKeyState` and `CopilotLogin`. A 404 from either is "not available", not an
  error.
- Spawn gains an **engine** row. Claude is the default. An engine that can't launch agents
  is shown off, with the daemon's reason under it. On another engine:
  - one free-form model id for the launch, offered from `GET /api/models?provider=`, and
    any id can be typed. Its `note` shows when the list is empty;
  - `spawn/engine.ts` turns the specs into ones that carry `provider` and that model. A
    budget in tokens replaces dollars where `costUsd` is false: `budgetUsd: null`, a
    `budgetTokens` cap (5M by default), and no dollar cap on the job;
  - effort, helpers and plan mode are left out where the engine lacks them, and plan mode
    is sent as "ask me".
  For Claude, `specsOn` and `autonomyOn` return what they were given, so the payload is
  unchanged.
- Composer and details panel ask the agent's engine. Plan mode shows only where it exists,
  or when the agent is already in it. The effort row shows only with `effort`. The model
  comes from the engine's list. The budget is in tokens where `costUsd` is false: the patch
  is `{ budgetTokens }`, and "used" counts input plus output. Spend reads "not reported"
  rather than $0.00. `budgetOf` gains `unit`, and the Project lane's meter follows it.
- A provider badge sits beside the role on Fleet cards, beside the model in the Project lane
  and the Agent header, and as an "engine" row in the details panel. A Claude agent has none.
- Settings → **Providers**: the OpenRouter key is shown as set or unset and where it came
  from, never as the key. It is a password field that is emptied once sent, whether or not
  the daemon took it. `keyStateFrom` keeps only `set` and `source`, so a daemon that echoed
  the key couldn't get it rendered. "clear" appears only for a saved key, and the field is
  off when `OPENROUTER_API_KEY` is set. The Copilot line gives the login, or how to sign in
  (`copilot` then `/login`, or `GH_TOKEN`), and the daemon's note. Not built: the plan's
  optional OpenRouter base URL, which the Lane A routes don't carry.
- `fixtures/providers.jsonl` (new, from `generate.mjs`) is session-basic plus a docs-site
  project. Its scribe runs on `openrouter` with `anthropic/claude-sonnet-4.5`, `costUsd` 0,
  190k tokens and a 500k `budgetTokens` cap. `make fixture` replays it, and
  `FIXTURE=session-basic` replays the old one. The other fixtures regenerate byte for byte.

**Verified:** spawn/verify.ts §15 has 18 checks: the Claude specs are the same array with
no provider, a job cap as before, the provider and model on every other spec, dollars
replaced by tokens, plan mode sent as ask, effort and helpers following the flags, the deny
rules untouched, and the route wiring. agent/verify.ts "Engines" has 16: the token bar,
controls following the flags, `parseTokens` and `tokenWords`, the model problem, and source
checks on the composer, details panel and badge. lib/verify.ts §30 has 16: only `set` and
`source` are kept, the PUT carries the key and its answer doesn't, clear sends null, both
404s read as not available, no GitHub credential reads as not signed in with the note, and
the settings source has a password field emptied in `finally`, no draft in markup, no
setting or storage write, and no `console`. Five mutations via `scripts/mutate.sh` were
each caught: echoing the daemon's fields, keeping `budgetUsd` on a token engine, dropping
Claude's identity path, unfiltered composer modes, and not emptying the key field.

Browser (headless Chrome, `scripts/cdp.mjs`):
- A throwaway daemon on 7795: Spawn shows Claude on, and Copilot and OpenRouter off with
  "… isn't available in this build yet". Settings → Providers says "Not available" for
  both 404s, with no error.
- A Claude agent's composer, header and details panel match the pre-change build in the
  fixture replay.
- A local stub for the Lane A routes: an OpenRouter launch posted `provider`, the model,
  `budgetUsd: null`, `budgetTokens: 5000000` and no job cap. A Claude launch posted no
  `provider`, with `budgetUsd` 25 per agent and 100 for the job. A saved key left the
  field empty and appeared nowhere in the page.

`pnpm -r typecheck` clean. `make test`: 10 PASS, exit 0.
### Amendment 79 — post-merge, applied. **Opening Spawn or Settings doesn't start Copilot for someone who has no login.**

Found while merging Amendment 76.
- **The problem:** Spawn's provider check and Settings' login status both ask the Copilot
  runtime who you are. Asking starts the runtime, a native process of some 86 MB, and it
  then stays up until the daemon stops. So everyone who opened either screen paid for it,
  including those who will never use Copilot.
- **The fix:** `copilotLogin()` first looks for any credential the runtime would use, from
  the findings' "Authentication" list:
  - the environment variables `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` and
    `GITHUB_COPILOT_API_TOKEN`;
  - the files `~/.copilot/config.json` and `~/.config/gh/hosts.yml`.

  It only checks that they exist and never opens one. When there are none, the answer is
  "no GitHub credential found", and the runtime isn't started.
- **When a credential exists:** the runtime is asked, as before. A file can be present
  without a Copilot login, so the runtime still has the last word.
- **For tests:** `copilotSdk.credentialPresent` is the swap point.

**Verified:**
- `session/verify.ts` §17l: with no credential, the login route says so and the fake
  runtime is never asked.
- `scripts/mutate.sh` removing the check is caught.
- §17l and §17m now run in that order on one branch. §17m's "nothing was made" check
  counts only the agents its own spawns made. The Copilot budget-stop test caps in
  tokens alone.
- `make test`: 10 PASS, exit 0.

### Amendment 78 — post-merge, applied. **Each provider lists its own models.**

Step 6 of `docs/plans/multi-provider-backends.md`.
- `ProviderModelList { provider, models: { id, displayName, efforts? }[], note?, fetchedAt }`
  is additive in `wire.ts`. Ids are free-form (`anthropic/claude-sonnet-4.5`) and are kept
  exactly. The opus/sonnet/haiku tiers stay Claude's alone.
- `GET /api/models?provider=<id>`:
  - none, empty, or `claude` returns the `ModelCatalog` exactly as before, `?fresh=1`
    included;
  - an id that isn't a provider gets 400 naming the three;
  - any other provider returns a `ProviderModelList` from its factory's `listModels()`.
    A provider that isn't registered, or whose listing throws or takes over 20 s, gets an
    empty list with a `note` saying why. It is never a 500. The note keeps the error's
    first line only, with anything shaped like a credential, or equal to one in the
    environment, taken out.
- `session/models.ts`: `providerModels(provider, factory, fresh)` caches a list that came
  back for ten minutes, as Claude's catalog is cached, and asks once for concurrent
  callers. A failure isn't cached. The factory is passed in, so `models.ts` never imports
  the registry. `providerModelRefusal(list, model)` refuses an id the list lacks. It
  names the ids when there are twelve or fewer, and points at the route otherwise. An
  empty list refuses nothing.
- At spawn, `parseAgentSpecs` stays synchronous and its refusals and their words are
  unchanged. `checkProviderModels` runs after it and checks each non-Claude spec's model
  (which is still required) against its provider's list. Claude's spec is checked by
  `refusal(model)` as before.
- `POST /api/agents/:id/model` checks against the list of the agent's stored provider
  (`getAgentProvider`). Claude's check and words are unchanged. A non-Claude agent with
  no model given is pointed at `GET /api/models?provider=<its provider>`.

**Verified:** `session/verify.ts` §17n uses fake `openrouter` (a list) and `copilot` (a
listing that throws with a credential and a stack in its message). It covers: no
provider and `claude` return the catalog's shape; an unknown provider gets 400; a list,
de-duplicated, named, with efforts, asked once and cached, with `fresh=1` asking again;
a failure gives a note with neither the credential nor the stack; an unregistered
provider gets a note. At spawn, an unlisted id or a Claude tier gets 400, a listed id is
kept exactly, and an empty list accepts anything. The model route checks against the
agent's own provider: it refuses a Claude id on an OpenRouter agent that Claude's check
would pass. Claude agents are unchanged. `make test`: 10 PASS, exit 0.

### Amendment 77 — post-merge, applied. **Budgets with no dollar figure: a cap in tokens.**

Step 5 of `docs/plans/multi-provider-backends.md`. Copilot and OpenRouter report tokens
and premium requests, never dollars (findings Q7), so a dollar cap on them would never be
reached.
- `Autonomy.budgetTokens?: number | null` is additive. It is a lifetime cap on
  `inputTokens + outputTokens`, for an engine whose `capabilities.costUsd` is false.
  Absent means uncapped, so every stored autonomy reads as it did.
- One unit per agent, the one its engine reports. At spawn and on
  `POST /api/agents/:id/autonomy`:
  - a positive `budgetUsd` on a `costUsd: false` engine gets 400, saying to cap it with
    `budgetTokens` instead. It is refused rather than ignored, because ignoring it would
    launch an agent with no cap at all;
  - a `budgetTokens` on Claude gets 400: its budget is `budgetUsd`;
  - a `budgetTokens` that isn't a whole number above 0 (or null) gets 400, rather than
    becoming no cap the way a bad `budgetUsd` becomes null. Null takes the cap off.
  - A Claude agent's autonomy has no `budgetTokens` key, so its shape is unchanged.
- `budget.ts`: `budgetRefusal` and `budgetNote` read the token cap when there is no
  dollar cap. They say it in tokens: "The Builder has spent 512k of its 500k-token
  budget — raise it to continue." and "budget reached — spent 512k of its 500k-token
  budget". The prefix is unchanged, so `budgetStop` and the alert still read it. A dollar
  cap reads exactly as before. `tokens()` formats counts, rounded down so a figure never
  reads as more than was spent. `tokensSpent()` is input plus output.
  `budgetUnitRefusal()` is the spawn rule above. The supervisor already calls
  `budgetRefusal` before every launch, message and resume. A backend that calls it after
  each usage update, and ends the run `budget_exhausted`, gets the pause and the note in
  tokens with nothing more.
- `jobCap` stays in dollars. A token-capped agent has no dollar cap, and its dollars are
  unknown rather than zero (OpenRouter still bills them). So, like any agent without a
  dollar cap, it uncaps the job's dollar cap, and its own token cap still stops it.
  Tokens are never added to dollars. Today's spend is `cost_daily`, which only a
  backend's dollar `costUsd` feeds, so it is unchanged.

**Verified:** `session/verify.ts` §17m runs a fake `costUsd: false` engine registered on
`copilot`. It covers: under the cap it runs and resumes; reaching the cap pauses it with
the note in tokens; message and resume are refused with the sentence; raising the cap
resumes it; null uncaps it. It also covers dollar caps unchanged, the job cap, today's
spend unchanged by 912k tokens, and every spawn and autonomy refusal above. `make test`: 10
PASS, exit 0.
### Amendment 76 — post-merge, applied. **Agents run on GitHub Copilot and OpenRouter, behind Conductor's own permission gate.**

Step 4 of `docs/plans/multi-provider-backends.md`. Claude's behaviour is unchanged.
- **`session/backends/copilot.ts`** has a new `CopilotBackend implements AgentBackend`.
  It serves `copilot`, which uses your login, and `openrouter`, which is BYOK at
  `https://openrouter.ai/api/v1` with the key and a model id. Both go through
  `@github/copilot-sdk`.
  - There is one client per provider, started lazily with `start()`. It is two clients,
    not one, because BYOK needs `useLoggedInUser: false`, which is a client option.
    `routes/providers.ts` stops them in `onClose`, after `routes/session.ts` has stopped
    the agents. Fastify closes plugins in reverse order, and `src/index.ts` is unchanged.
  - Each agent has one session, and **its id is the agent's id**. A resume always resumes
    that id, so it never resumes an id another engine stored. The provider, callbacks,
    tools and folders are passed again on every resume, with
    `continuePendingWork: false`. The session is disconnected at the end of each run, as
    Claude's query ends at its first result.
  - `copilotSdk` is the swap point for tests (`createClient`, `fetchOpenRouterModels`).
- **`session/backends/copilot-events.ts`** is a pure translator from SDK events to
  `EventPayload`. It handles text, `tool_start`, `tool_end`, `file_edit`, `todo` and
  per-call usage. It matches `tool.execution_complete` to its start by `toolCallId`. A
  sub-agent's text and idling don't count as this agent's turn. `askFromPermission`
  names a permission request after the Claude call it is.
- **`translate.ts`** gains `normaliseTool` and `COPILOT_TOOLS`. The map is `bash`→Bash,
  `view`→Read, `edit`/`str_replace_editor`→Edit, `create`→Write, `update_todo`→TodoWrite
  (parsed from its markdown checklist), `ask_user`→AskUserQuestion, plus grep, glob,
  web_fetch, web_search and task. Inputs are mapped to Claude's keys too. `toolLabel`,
  `isWriteTool`, `fileEditFromTool`, `todoFromInput` and `reversibility` each normalise
  first, so the functions are shared, not forked. A Claude name passes through untouched.
- **Permissions.** `onPermissionRequest` runs `gateCall` first, because this SDK applies
  neither `disallowedTools` nor a permission mode:
  - `disallowedTools` is refused in every mode, `bypassPermissions` included. Matching
    uses the new `toolRuleFor` in `arbiter/index.ts`, built on `ruleCovers`. A shell line
    is split into its commands: a deny needs one command covered, and an allow needs
    every command covered.
  - Then the mode applies, with Claude's meanings. `bypassPermissions` runs everything.
    Reads inside the agent's folders run. `plan` only reads. `acceptEdits` runs edits in
    its folders. `allowedTools` runs what it names. `dontAsk` refuses rather than asks.
    `default` asks, and so does `auto`, which has no classifier on this engine.
  - Next, a decision staged during a pause is applied, through `arbiter().preToolUse`.
  - Only after that is the arbiter asked. Its allow becomes `approve-once` and its deny
    becomes `reject` with the message. An edited allow is rejected with the edit,
    because this SDK has no `updatedInput`.
  - Whole-tool disallows also become `excludedTools` where the names map one to one.
  - `ask_user` goes to `onUserInputRequest` and becomes an AskUserQuestion request.
- **No defer.** `requestPermission` sets no `DEFER_AFTER_MS` timer for an engine whose
  `capabilities.defer` is false, so the request stays held even when no browser is
  watching. `interrupt()` aborts the callback's signal, so a waiting request is parked
  and answering it resumes with the nudge. On boot, `recoverOrphans` expires such an
  engine's held request, with a note and a `resolved` event, and puts the agent back to
  `working` so `reconcile` resumes it. Claude's requests are parked as before.
- **Usage.** `assistant.usage` tokens are added to lifetime totals as they arrive, via
  `setAgentUsage`. The dollar spend is never changed. After each update, if
  `budgetRefusal(getAgent(…))` refuses, the run aborts and ends `budget_exhausted`, and
  the supervisor pauses the agent with `budgetNote`.
- **Helpers.** `start_helper` and `list_helpers` are registered in-process with
  `defineTool` and `skipPermission`. They are served by `routes/helpers.ts`'s
  `MCP_TOOLS` and `callTool`, the code Claude's MCP endpoint uses.
- **`session/secrets.ts`** holds the OpenRouter key. `OPENROUTER_API_KEY` wins;
  otherwise the key comes from `~/.conductor/secrets.json`, written through a temp file
  and a rename with mode 0600. In memory or override mode it stays in-process. The key
  is never in `settings.json`, an event, a row, a log or a response.
- **`routes/providers.ts`** is new:
  - `GET` and `PUT /api/providers/openrouter/key` (`{ key: string | null }`) both return
    `{ set, source }`.
  - `GET /api/providers/copilot/login` returns `{ authenticated, login, note? }`. It
    fails soft with a note.
- **`backends/index.ts`** registers `copilot` and `openrouter` with the findings'
  capabilities: `defer:false resume:true costUsd:false effort:true planMode:false
  helperTools:true`.
  - The factories live in `backends/index.ts` and call into `copilot.ts` only when used,
    so the import cycle through the arbiter can't run either module's code too early.
  - `copilot` refuses at spawn when the last login status said no. That status is
    cached for 10 minutes after a yes and 30 seconds after a no, and spawn never waits
    on the runtime. The very first check says "try again in a moment".
  - `openrouter` refuses with no key.
  - Model lists: `copilot` uses `client.listModels()`. `openrouter` uses the public
    `GET /api/v1/models`, cached for 10 minutes and sent no key.

**Verified:** `session/verify.ts` §17l covers:
- the name map, with Claude unchanged;
- rule matching, and the gate in every mode;
- recorded events;
- a normal turn and its transcript;
- tokens counted with no dollars;
- a resume by the agent's own id when the row holds a foreign one;
- held, not parked, with nobody watching, then approved;
- a deny;
- an interrupt that parks the request, then the answer resuming and letting the re-made
  call through;
- a disallowed call refused under `bypassPermissions`, plus `excludedTools`;
- a session error reaching Needs you;
- a budget stop pausing the agent;
- helper tools, and `ask_user`;
- an orphan expired on `recoverOrphans`, while Claude's is parked;
- the key in no response, setting, event or row, and env winning;
- the openrouter refusal with no key;
- the login route failing soft, and the model lists.

§17k's not-yet check now expects copilot's login refusal. `scripts/mutate.sh` removing
the `disallowedTools` guard in `gateCall` is caught by 3 checks. `make test`: 10 PASS,
exit 0.

### Amendment 75 — post-merge, applied. **What the Copilot SDK can do, found out before building on it.**

Step 0 of `docs/plans/multi-provider-backends.md`, done after steps 1–3, which needed
none of its answers.

**New dependency: `@github/copilot-sdk` `1.0.16` in `packages/daemon`, pinned exactly**
(§3). The plan names it as the one allowed addition. It brings `zod`, `koffi` and
`vscode-jsonrpc`, plus a per-platform runtime package. `koffi` is loaded only for the SDK's
in-process transport, which Conductor doesn't use.
- `docs/plans/multi-provider-findings.md` answers the eleven questions from the SDK's
  types and docs, with `file:line` evidence. Q10 is YES: BYOK bypasses GitHub auth, so
  `openrouter` runs on the same SDK and no `openai-compat` backend is needed.
- The capability flags for `copilot` and `openrouter`, set when step 4 registers them:
  - `resume`, `effort` and `helperTools` are true.
  - `defer` is false. No defer exists, and re-offering a pending request on resume is
    unconfirmed.
  - `costUsd` is false. The SDK reports tokens and premium requests, never dollars.
  - `planMode` is false until it is wired and tested.
- `session/backends/copilot-spike.ts` checks the answers that matter against the real
  service. Nothing imports it, and `make test` doesn't run it, because it spends requests.
  `auth` and `models` are free and were run here. They found that `getAuthStatus` and
  `listModels` need `client.start()` first. They also found that this machine has no
  Copilot login, so the paid checks are for the user to run.

**Verified:** `pnpm -r typecheck` is clean with the spike included. `make test`: 10 PASS,
exit 0.

### Amendment 74 — post-merge, applied. **Each agent has a provider, chosen at spawn; claude by default.**

Step 3 of `docs/plans/multi-provider-backends.md`.
- `session/backends/index.ts` is the registry. `registerBackend`, `backendFor`,
  `createBackend(provider, db, scope)`, `providerRefusal` and `providers` cover it.
  Claude is always registered, with every capability on. `BackendFactory` gains
  `unavailable()` (no login, no key) and `create()`.
- Migration `110_provider.sql` adds `agents.provider TEXT NOT NULL DEFAULT 'claude'`, so
  existing rows are claude. `getAgentProvider(db, id)` reads it.
- `AgentSpec.provider?` and `Agent.provider?` are additive. The wire carries
  `provider` only when it isn't claude, so a Claude agent's shape is unchanged.
- `parseAgentSpecs`: no provider means claude. An unknown one gets 400 naming the three.
  A known one with no engine yet, or one that can't launch, gets 400 saying why, rather
  than failing mid-run. Only claude's models are checked against Claude's list; each
  other provider will check its own (step 6).
- The supervisor's two runner sites call `createBackend(getAgentProvider(...))`, and
  `#runners` holds `AgentBackend`. An agent's provider never changes, so its stored
  session id only ever goes to the engine that made it. Helpers inherit their
  orchestrator's provider.
- `GET /api/providers` returns `ProviderInfo[]` (`id`, `unavailable`, `capabilities`) for
  the screens.

**Verified:** `session/verify.ts` §17k covers the default and the wire shape, Claude still
running, the unknown and not-yet providers getting 400, `/api/providers`, and the old
import path. `make test`: 10 PASS, exit 0.

### Amendment 73 — post-merge, applied. **The Claude engine moves behind the interface, unchanged.**

Step 2 of `docs/plans/multi-provider-backends.md`.
- `session/runner.ts` moves to `session/backends/claude.ts`, and `AgentRunner` becomes
  `ClaudeBackend implements AgentBackend`. Every line of logic is kept, only the
  relative imports changed, and the `sdk` swap point is still exported.
- `session/runner.ts` stays as a re-export (`AgentRunner` is `ClaudeBackend`), so the
  supervisor and `verify.ts` are untouched.
- `arbiter/index.ts` returns `PermissionDecision` instead of the SDK's
  `PermissionResult`. The Claude backend narrows it back with a cast, since its allow
  and deny are that SDK's own shape.

**Verified:** `make test`: 10 PASS, exit 0, with no test changes at all.

### Amendment 72 — post-merge, applied. **An interface for agent engines.**

Step 1 of `docs/plans/multi-provider-backends.md`: run agents on more than Claude Code.
Types only, with no behaviour change. `session/backend.ts` (new) defines:
  - `ProviderId` (`claude | copilot | openrouter`), `PROVIDERS` and `isProvider`;
  - `BackendCapabilities` (`defer`, `resume`, `costUsd`, `effort`, `planMode`,
    `helperTools`);
  - `ProviderModel` (`{id, displayName, efforts?}`);
  - `PermissionDecision`, the arbiter's answer in no SDK's words;
  - `RunnerScope`, `RunOutcome` and `RunOpts`, moved here unchanged;
  - `AgentBackend`, exactly the surface the supervisor used: `agentId`, `isLive`,
    `sessionId`, `run`, `send`, `setModel`, `interrupt` and `stop`;
  - `BackendFactory` (`provider`, `capabilities`, `listModels`).

### Amendment 71 — post-merge, applied. **The navigator's + adds a project.**

Asked: "how do I create a new project? When I click on the + it takes me to the new Agent
page." The navigator's **+** opened Spawn (Amendment 66). Spawn starts new work, which
reads as a new agent, while the panel is a list of projects. It now opens Fleet's
add-a-project form (`navigate('fleet', { add: '1' })`, Amendment 45). New work is still
**+ spawn agent** on a project's screen and **+ new work** on Fleet. `shell/verify.ts`
checks it.

### Amendment 70 — post-merge, applied. **An architect among the built-in personas.**

Asked for: "update the default personas, include architect in the personas."

- `spawn/personas.ts`: `BUILT_IN_PERSONAS` gains **architect**, first in the list, since it
  comes first in a job.
  - Brief: design before code, citing file and line; two or three options with costs
    and risks; a decision; a plan of steps, the files and interfaces they change, which
    run in parallel, and how each is checked; an ADR in `docs/adr/`; no source changes.
  - System prompt: evidence first, the smallest change and existing patterns, explicit
    trade-offs and irreversible decisions, failure modes, security, migration, testing
    and operation, AskUserQuestion for the user's choices, interfaces but no
    implementation, and a fixed result shape.
  - Model `opus`. Tools `{bash: true, write: true, network: true, push: false}`, with MCP
    left to the launch.

  Being a built-in, it can be edited and reset, not deleted. Anyone who hasn't edited it
  gets this version.
- `spawn/custom.ts`: `KNOWN_ROLES` offers `architect`, last, so a new row's default role
  is unchanged.
- No preset has an architect role, so presets are unchanged.

**Verified:** `spawn/verify.ts` §14 checks it is built in and first, its model, prompt and
brief, its tool rules, that a Custom architect row launches with its system prompt, shell
and no push, and that new rows still take validator after builder. `make test`: 10 PASS.

### Amendment 69 — post-merge, applied. **The navigator lists projects in the Fleet's order, and a drag there sets yours.**

Asked for (TODO.md). **Decided by the user:** follow the Fleet's Sort by, and dragging in
the panel sets my order. Lane A of `docs/plans/personas-and-nav-order.md`.

- `fleet/order.ts`: `sortFacts(projects, agents, pending)` is pure, moved out of
  `fleet.tsx`'s `useMemo` unchanged, so the Fleet and the navigator compute the same facts.
  `SORT_RANK` is exported.
- `shell/navtree.ts`: `navProjects(projects, rawSort, rawOrder, agents, pending)` is the
  Fleet's `fleetSort` + `sortProjects` + `sortFacts`, from the same two settings.
  `navDrop(shown, dragged, target)` returns `moveBefore`'s order and the `mine` sort, or
  null for a drop on itself.
- `shell/Navigator.tsx` orders its projects with `navProjects`. A project row is
  draggable, and the whole project node is a drop target; the space after the last
  project puts one last. A drop writes the order, then the sort.

**Verified:**
  - `shell/verify.ts` §7 (41 checks) covers `sortFacts` on a fixture, the panel's order
    equalling the Fleet's for every sort with and without a saved order, the fallbacks,
    the drop, and the wiring.
  - In headless Chrome: changing the Fleet's sort to newest reorders the panel, and a
    drag in the panel reorders both lists and switches the sort to mine.
  - One mutation was caught (the panel ignoring the sort).

### Amendment 68 — post-merge, applied. **Personas: what each role is, editable, carried to every run.**

Asked for (TODO.md): add, edit and delete agent personas, and pick one per Custom row.
**Decided by the user:**
  - a persona holds a name, description, brief, system prompt, default model, tool rules
    and skills;
  - personas are kept in Settings;
  - built-ins can be edited and reset but not deleted, and your own can be deleted;
  - presets use the persona of the same role for its system prompt, skills and tool
    rules, keeping their own brief and tier;
  - a running or sleeping agent keeps what it launched with;
  - saved setups store a persona by id, and a row can override the brief and model for
    one launch.

Built in three lanes, as planned in `docs/plans/personas-and-nav-order.md`, after a serial
step 0 that fixed the shared contract.

- **Step 0:** `AgentSpec` gains `persona?`, `systemPrompt?` and `skills?`.
  `web/src/spawn/personas.ts` holds `Persona`, `BUILT_IN_PERSONAS` (the eight roles,
  with reviewer, debugger and analyst `write: false`), and the `conductor.personas`
  setting. That setting stores only the edits to built-ins, plus your own personas
  whole, so a later build's built-ins still reach you. The file also has `personasFrom`,
  `withPersona`, `resetPersona`, `withoutPersona`, `newPersonaId`, `personaFor`, `isEdited`
  and `pillsWith`.
- **Lane B (daemon and editor):**
  - Migration `100_persona.sql` adds `agents.persona`, `system_prompt` and `skills`.
  - `parseAgentSpecs` validates them: an id of `[a-z0-9-]{1,60}`, a system prompt of at
    most 20,000 characters, and at most 50 skills of 1–100 characters, de-duplicated.
  - `createJob` stores them, and helpers inherit their orchestrator's.
  - Both runner constructions fill `RunnerScope` from `getAgentPersona`. `#buildOptions`
    passes `systemPrompt: {type:'preset', preset:'claude_code', append}` and `skills` on
    every run, resumes included.
  - **Settings → Personas** lists the personas, marks an edited built-in **changed** and
    yours **yours**, and offers edit, reset (edited built-ins only), delete with a
    confirm (yours only) and **+ new persona**. The editor covers every field, with
    three-way tool rules and a model chooser of the launch's choice, a tier, or an
    exact id via `ModelSelect`.
- **Lane C (presets and Custom):**
  - `toAgentSpecs(…, personas?)`: a role's persona (`personaOf`, from `r.persona ?? r.role`;
    `''` means none) gives the spec `persona`, `systemPrompt` and `skills`. Its tool rules
    go over the pills through `pillsWith`, and `write: false` makes the role read-only.
    A persona can't make a reading role write. Without personas, the output is unchanged.
  - `custom.ts`: `CustomRole.persona?` is stored by id in saved setups. `rowPersona` is
    the persona a row runs as (its pick, else the one named like its role, `''` for
    none), and the launch and the picker both use it, so they can't disagree. A row
    takes the persona's brief unless it types its own, and its tier or exact id
    (`personaPicks`) unless the row picks one.
  - `CustomSetup.tsx` has a persona select per row, showing the description and the
    brief as the placeholder, and marking a deleted persona.
  - `route.tsx` reads the setting and passes the personas everywhere.
- **Main session:** found and fixed one inconsistency. A row named `builder` with
  nothing picked ran as builder while its picker said "no persona". The picker now
  shows `rowPersona`, and "no persona" stores `''`.

**Verified:**
  - `session/verify.ts` §17j (21 checks) runs against the fake SDK: the options carry the
    appended system prompt and skills; a resume carries them again; an agent without a
    persona has neither; a helper inherits; bad values get 400; the limits are accepted.
  - `spawn/verify.ts` §12–13 and `lib/verify.ts` §29 cover the web side.
  - In headless Chrome: editing builder's system prompt saves only that field and marks
    it **changed**; **+ new persona** adds yours; in Spawn's Custom setup the first row
    shows **builder** and lists every persona; picking yours renames the row.
  - Three mutations were caught: persona not applied; system prompt not passed; nav
    ignoring the sort.
  - `make test`: 10 PASS, exit 0.

### Amendment 67 — post-merge, applied. **"Run shell unattended" means it, and "allow all session" is never greyed out for nothing.**

Two reports. **"I started an agent with Auto and allow bash; why do I still get Allow in
Needs you?"** Bash was in `allowedTools`, but Claude Code still calls `canUseTool` for
commands its own checks flag. The requests' `matched_rule` showed which: "changes
directory before running a version-control command" (`cd x && git …`, untrusted hooks),
"Contains simple_expansion" (`$VAR`), and clones. MCP tools (Lucid here) were covered by
no pill at all. **"Allow all session is never enabled."** For those flagged commands
Claude Code sends no rule suggestions, and the button is disabled without one, so it was
greyed out on exactly the calls that ask most.

**Decided by the user:** when shell is on, Conductor allows those flagged commands too;
and there is a new **allow MCP tools** pill.

- `arbiter/index.ts`:
  - `allowedUnattended(allowedTools, toolName)` gives `run shell unattended` for Bash
    when `Bash` is allowed, `allow MCP tools` for `mcp__…` when `mcp__*` is allowed, and
    null otherwise.
  - `requestPermission` checks it first and answers `allow`, logging a `resolved` event
    (`by: 'rule'`, with the reason). Deny rules were applied before the call reached
    here, so no-push still holds, and other tools still ask.
  - `fallbackSuggestions(toolName, input)`: a request with no SDK suggestions gets a
    session-scoped `addRules` of the exact command (for Bash) or of the whole tool, and
    none for a question. Allow always then persists Conductor's copy as usual, and
    `ruleCovers` matches the exact command.
- Web:
  - Spawn's `PILLS` gain `mcp` (off by default), and `toAutonomy` adds `mcp__*`.
  - `toAgentSpecs` never gives a reading role `mcp__*`, as it never gives it Bash: MCP
    tools can change things outside the folder.
  - The composer's guardrails gain **allow MCP tools**.
  - The shell pill's hints say it now covers Claude Code's own double-checks.

**Verified:**
  - `session/verify.ts` §17i, against the real arbiter:
    - shell on: a flagged `cd && git` command is allowed with no request, and the event
      says why, while Write still asks;
    - MCP on: an MCP tool is allowed, but not the shell;
    - shell off: it asks, carries the fallback rule of the exact command, is allowed
      next time after allow always, and a different command still asks;
    - the two pure functions directly.
  - `spawn/verify.ts` §11 checks the pill, the default, and reading roles.
  - Three mutations were caught. `make test`: 10 PASS, exit 0.

### Amendment 66 — post-merge, applied. **A project navigator down the left of every screen.**

Asked for on 2 October: one left panel where each project has nested, independently
opening **Agents**, **Needs you** and **Files** submenus. It shows agent status, lights
up Needs you, and stays put when you open an agent. Both side panels can be closed from
the top bar. **Decided by the user:**
  - the Project screen drops its projects list;
  - the submenus list their items, and a click opens one;
  - every Fleet card goes to its Project screen;
  - the right-panel icon shows only where there is a right panel.

Planned in `docs/plans/project-navigator.md` and built, as asked, in two lanes at once, each
an agent in its own git worktree owning separate files. They were then merged serially.

**Lane A, the navigator (shell):**
  - `shell/navtree.ts` (pure): `navTree(projects, agents, pending, alerts, jobs)` gives
    each project's needs count, agent rows (`agentTabs`: newest job first, numbered
    roles, needs), needs rows (requests then alerts, each with its `requestId`/`alertId`
    deep link) and folder rows (main first, each once, with its `dirRoot`).
    `navId`/`parseOpen`/`toggleOpen`/`serializeOpen` manage the open set (`conductor.navTree`;
    a broken value opens nothing). It also has `navShown` (`conductor.navOpen`),
    `rightPanelFor` (the Agent screen only) and `currentProject`.
  - `shell/Navigator.tsx` draws it: chevrons with `aria-expanded`, the name opening the
    Project screen, rows opening the agent, the Needs-you item or the folder in Files,
    and a **+**. It is resizable (`NAV_PANEL`, `conductor.navW`).
  - `shell/shell.tsx` mounts it before the screen and adds the two top-bar `PaneIcon`s.
    The right one toggles `conductor.agentDetails`, which the Agent screen already
    reads, so the icon, **details** and `i` agree.
  - A new `shell/verify.ts` (67 checks) runs in `make test`.

**Lane B, the Project screen and Fleet:**
  - `fleet/card.tsx`: `open` is always `openProject`; it used to go to Needs you for a
    blocked project.
  - `fleet/project.tsx` loses `ProjectListRow`, its map and the column's **+**. The column
    heads with the project's name and keeps its facts, notes and actions; unused list
    styles are removed. `lib/verify.ts` §28 checks this, and §16's source check now
    points at `projectNeeds` itself, which the navigator uses.

**Main session:** merged both onto `cleanup`. `scripts/mutate.sh` is the mutation helper,
now kept in the repo, and `web/scripts/cdp.mjs` gains `{size}` and `{shot}` steps.

**Verified:**
  - `make test`: 10 PASS, exit 0 (with `shell/verify.ts`).
  - Headless Chrome with a real daemon and two projects:
    - the navigator lists both on Fleet;
    - a card opens its Project screen with no list in its column;
    - submenus open independently, and Beta stays open when Alpha's do;
    - Agents rows carry status dots, and Needs you is amber with its due note;
    - clicking an agent keeps the navigator and its open submenus;
    - the right icon hides and shows the inspector, and is gone off the Agent screen;
    - the left icon hides the navigator;
    - a Needs-you row opens Needs you on its alert, and a folder row opens Files on the
      project;
    - what's open survives a reload.
  - Four mutations were caught: toggles closing others, the right icon everywhere, and
    another project's requests or alerts leaking in.

### Amendment 65 — post-merge, applied. **Spawn asks how the agents interact with you.**

Asked for (TODO.md). **Decided by the user:** ask me, auto-accept edits, plan first and
auto, plus bypass permissions behind a plain warning. One choice per launch, setting only
the mode, with the pills keeping the tool rules. The default lives in Settings →
launch defaults, and reading roles stay read-only.

Before this, `toAutonomy` reached only `default`, `acceptEdits` and `plan`, through the
**auto-accept edits** pill and the **plan first** button. `auto` and `bypassPermissions`,
which `Autonomy['mode']` and the daemon always accepted, couldn't be chosen at launch.

- `spawn/autonomy.ts`: `MODES` lists id, label, hint and, for bypass only, a warning that
  nothing will ask and nothing will reach Needs You. `DEFAULT_MODE` is `acceptEdits`,
  what Spawn did before. `toAutonomy(…, chosen?)` uses the chosen mode, else works it
  out from the pills, so existing callers are unchanged. The **auto-accept edits** pill
  is gone. `describeAutonomy` names auto and bypass, and under bypass says the shell
  runs unattended.
- `toAgentSpecs(…, mode?)`: a reading role gets `plan` if that was chosen, else `default`,
  whatever else was chosen. Its write tools stay denied in every mode.
- `spawn/route.tsx`: a mode row at the top of section 5, with the warning under it when
  bypass is picked. The **plan first** button is gone, being a mode now. The mode is sent
  in every spec.
- `spawn/defaults.ts` stores `conductor.launch.mode`; a bad value reads as the default.
  The Settings tab's launch defaults have the same row.
- The runner already passes `allowDangerouslySkipPermissions` exactly when the mode is
  bypass (Amendment 17), and the composer already switches a live agent's mode.

**Verified:**
  - `spawn/verify.ts` §10 checks the five ids; only bypass warning; every mode reaching a
    writing role while a reading role plans or asks with Write denied; the deny rules
    holding under bypass; the old pill-derived default; the saved default and a bad one;
    the summary; and the route sending the mode with the old controls gone.
  - In headless Chrome: the row shows **auto-accept edits** selected, bypass shows its
    warning, and the options summary says so.
  - Three mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 64 — post-merge, applied. **What you type to an agent survives remounts and reloads.**

Reported: "my text being added for instructions to the agent gets wiped out. Three times
I have started to type only to have the text area wiped out." The reply box (`text` in
`agent/composer.tsx`) and Spawn's prompt (`prompt` in `spawn/route.tsx`) were component
state, so whatever remounted them lost the text:
  - switching **reply ↔ terminal** (Amendment 58 made that a remount);
  - switching agent tab (Amendment 49) or screen;
  - a page reload. Vite reloads the page when code changes under a running dev server,
    which happened often while these amendments were being written.

- `lib/drafts.ts` (new): `useDraft(key)` is like `useState('')`, but the text lives in a
  module store backed by this tab's `sessionStorage`. That survives remounts and
  reloads, is per tab (so two tabs don't fight), and goes when the tab closes. It isn't a
  setting (Amendment 46): a draft isn't a preference to sync to every browser.
- The reply box uses `useDraft('reply:<agentId>')`, so each agent keeps its own, and Spawn
  uses `useDraft('spawn:prompt')`. Sending or launching clears them, as before.

**Verified:**
  - In headless Chrome with a real daemon: text typed in the reply box is still there
    after switching to the terminal and back, after switching to another agent (which has
    its own empty box) and back, and after reloading the page.
  - With the old `useState`, the same test loses the text at the first switch: the bug,
    reproduced.
  - `lib/verify.ts` §27 checks the store and the wiring. `make test`: 9 PASS, exit 0.

### Amendment 63 — post-merge, applied. **Notes can be due, and done; a due or late note stands out.**

Asked for (TODO.md). **Decided by the user:**
  - due today is amber and late is red, and the Fleet card shows the most urgent due
    note instead of the newest;
  - notes can be marked done;
  - due and late notes reach Needs You;
  - "today" is local midnight, turning over without a reload.

- Migration `090_note_due.sql` adds `project_notes.due` (a local `YYYY-MM-DD`) and
  `done_at`. `ProjectNote.due?` and `doneAt?` are present only when set.
- Routes:
  - `POST …/notes {text, due?}`.
  - `PATCH …/notes/:id` changes only what is sent: `{text?, due? (null clears),
    done?}`. A tick sends `done` alone, and an empty patch gets 400.
  - A due date must be a real calendar day.
  - Every change refreshes alerts as well as broadcasting the project.
- Needs You: `AlertKind` gains `note_due`, and `Alert` gains `noteId`, `noteText`, `due` and
  `late`. `Alerts.#notesDue()` raises one per open note due today or before. Its id is
  `note:<id>:<today>`, so a dismissal lasts the day. A timer refreshes just after each
  local midnight, which also turns the daily budget's day over (Amendment 59). The card
  offers **✓ mark done** (`note_done`), **open project** and dismiss.
- Web: `fleet/notewords.ts` has `localDate`, `dueState`, `dueLabel` and `cardNote` (late
  first, then today, then the newest). `fleet/Notes.tsx` gains `DuePicker` (**due
  today** or a date, and clear), a done checkbox per note, and the amber or red edge on
  the card's note, count and rows; a done note is struck through. Today is re-read every
  minute.

**Verified:**
  - `session/verify.ts` §17h checks bad dates refused; not yet due, no alert; today and
    late alerts with their text, date and lateness; ids carrying today; the broadcast; a
    tick kept with `doneAt` and stopping the alert; an un-tick bringing it back; clearing
    the date; empty and bad patches; delete.
  - `lib/verify.ts` §26 covers the states, labels, the card's choice and local midnight.
  - Four mutations were caught: done notes still nagging; no broadcast (caught once the
    check watched the socket rather than the snapshot); done ignored on the web; the card
    always showing the newest.
  - `make test`: 9 PASS, exit 0.

### Amendment 62 — post-merge, applied. **Agent replies render the markdown models actually write.**

Asked: "why is the text that comes back from the LLM never nicely formatted, even when I
ask for it to be?" Replies go through `agent/markdown.tsx`, which Amendment 17 kept
deliberately partial. Files uses the daemon's full renderer. A typical formatted reply
lost most of its shape:
  - a table showed as raw pipes;
  - a bullet under a numbered item split the list in two and restarted its numbering at 1;
  - `- [ ]` and `***x***` stayed as symbols;
  - a quote could hold only a line of text;
  - a fence with an info string (```` ```ts title="x" ````) or tildes wasn't code.

**Decided by the user:** extend our renderer rather than adopt `marked` in the browser.
So there is no new dependency, and it still builds only React elements, never an HTML
string.

- **Tables:** a pipe row followed by a separator with the same number of columns.
  `tableCells` splits on unescaped pipes, `:---:` sets alignment, missing cells are
  empty, cells hold inline formatting, and a wrapper `div.md-table` scrolls a wide table.
- **Lists:** `readList` / `listElement`.
  - An item owns every line indented past its own depth, so nesting goes to any depth,
    of either kind, and two-space nesting under a number works.
  - Blank lines between items keep one list. A line that carries on an item joins its
    text.
  - An item's other lines are rendered as blocks (paragraphs, code, lists).
  - `<ol start>` keeps the model's first number.
  - `- [ ]` and `- [x]` are disabled checkboxes (`md-task`, `is-done`).
- **Quotes** render their lines as blocks.
- **Inline:** `***x***` is bold italic, and bold, italic and strike can hold formatting
  (`**see `x.ts`**`).
- **Fences:** ``` or ~~~, any length, closed by the same kind at least as long, with an
  info string; the first word is the language.
- **Headings** drop closing `#`s.
- **Unchanged on purpose:** `_x_` and `__x__` are not emphasis (identifiers), only
  `http(s)` links are clickable, and anything unrecognised is still text.
- `agent.css` styles tables, task boxes and the spacing of blocks inside items and quotes.

**Verified:** `agent/verify.ts` "Formatting" has 23 checks, covering each construct above,
that a pipe in prose isn't a table, and that HTML in a cell or a task item can't become
markup. One older check moved: a quote's text is now in a `<p>`. Five mutations were
caught: no tables; no column match; no start number; blank lines splitting a list; and
continuation lines (fixed while testing). `make test`: 9 PASS, exit 0.

### Amendment 61 — post-merge, applied. **A dock launch finds your projects, and the terminal's input has room.**

Two reports.

**"I started it from the icon on the dock, but it did not show any projects; make
restart fixed it."** The dock launcher exports `CONDUCTOR_HOME` as the **checkout**
(`scripts/dock.sh`, `scripts/launch.sh`), and Amendment 46 had used the same name for the
**data folder**. A dock launch therefore took the checkout as its data folder. It exists,
so it counted as allowed, and the daemon opened a new, empty `<checkout>/conductor.db`.
`make restart` from a terminal doesn't set the variable, so it opened `~/.conductor/`.
The data folder's override is now `CONDUCTOR_DATA`, read by `storage.ts`, the Makefile
and the docs, and nothing else sets it. The empty `conductor.db` the dock launch made is
left in the checkout, untouched (it is gitignored).

**"The terminal does not work: I clicked on the tab, but I can't enter anything."** The
prompt before the input was the worktree's whole path, in a flex row with `min-width: 0`
on the input. A long path took the full width and squeezed the input to 0 px, leaving
nowhere to click. Found by driving the real page in headless Chrome
(`packages/web/scripts/cdp.mjs`).
  - The prompt is now the folder's last part (the full path is on hover and in the line
    above). It gives way first (`max-width: 40%`, ellipsis), and the input keeps at
    least `8em`.
  - The input is focused when the tab opens, and a click in the output returns to it
    unless you were selecting text.

**Verified:**
  - `smoke.ts` §6 checks the dock's `CONDUCTOR_HOME` doesn't move the data.
  - `agent/verify.ts` "Terminal" checks the prompt, the input's minimum, and the click.
  - In headless Chrome with a real daemon: the tab opens focused, a centred click lands
    on the input, typing and ⏎ run `git status --short; ls` in the agent's folder, and a
    click in the output refocuses.
  - Two mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 60 — post-merge, applied. **Mermaid blocks are drawn as diagrams, in files and in replies.**

Asked for: "support generation of mermaid diagrams in the markdown view; currently we see
the code and not the image". It was planned first, in `docs/plans/mermaid-diagrams.md`,
then carried out on request ("execute on the plan").

**New dependency: `mermaid@^12` in `packages/web`** (§3). Asked for directly. It is loaded
only by `import('mermaid')` inside `lib/mermaid.ts`, so pages with no diagram never fetch
it; `vite build` puts it in its own chunks. Rendering services (mermaid.ink, Kroki) were
rejected, because they would send file contents off the machine.

- **Files:** `workspace/markdown.ts` marks a mermaid fence `<pre class="md-code md-mermaid">`,
  keeping its escaped source, and `sanitize-html` allows the class. `FilePane` draws each
  one, puts the diagram before it and hides the source behind a **source** toggle. It
  draws again on a theme change, and a block it can't draw keeps its source, with the
  reason.
- **Replies:** `agent/markdown.tsx` hands a mermaid fence to `agent/Mermaid.tsx`
  (`MermaidBlock`), in its own file, so `markdown.tsx` still never inserts HTML. It
  shows the source until drawn, and falls back to it on an error.
- **Safety, three layers,** in `lib/mermaid.ts`:
  1. `securityLevel: 'strict'`.
  2. `htmlLabels: false`, which puts labels in SVG text, not HTML in a `foreignObject`.
     Checking in a real browser showed strict alone let an `<img>` in a label through,
     without its handler, but able to load any URL.
  3. `scrubSvg`, which removes script, iframe, img, image, foreignObject, object and
     embed, `on…` attributes, `javascript:` values and any `href` not starting with `#`.
- `shell/theme.ts`: `useTheme` has a server snapshot, so a component using it renders
  under Node.

**Verified:**
  - `workspace/verify.ts` checks the marking, any case, escaping, and that other blocks
    are untouched.
  - `agent/verify.ts` "Mermaid" checks the fallback markup, other blocks untouched, no
    markup from the source, `markdown.tsx` inserting no HTML, the strict, lazy,
    text-label, scrubbed setup, fence detection, and the error's first line.
  - `files/verify.ts` checks `FilePane`'s drawing and fallback.
  - `packages/web/scripts/mermaid-browser-check.sh` draws real diagrams with the real
    module in headless Chrome: flowchart, sequence, hostile, broken, and `scrubSvg`
    alone. It isn't in `make test`, because it needs Chrome; run it after upgrading
    mermaid.
  - Three mutations were caught by the browser check: HTML labels on; the tag list
    ignored; attributes kept. `make test`: 9 PASS, exit 0.

### Amendment 59 — post-merge, applied. **A daily budget, shown as a bar in the status bar.**

Asked for (TODO.md): "in settings, let me specify a daily budget and then show in a graph
at the bottom panel where I am in that budget. Go to yellow, red, if I am getting close."
**Decided by the user:** yellow at 75%, red at 95%; reaching it only warns; the day is
local midnight to midnight, as `cost_daily` already counted it.

- `daily.ts` (new, W0) holds `conductor.dailyBudget` (dollars, above 0, up to 1,000,000,
  with a `settingRule`) and `dailyBudget()`. `costChanged` / `onCostChanged` fire when
  today's spend grows.
- **Today's spend now reaches the page as it changes.** It came only with a snapshot, the
  gap the TODO said to check for (the slot count had the same gap, Amendment 47). The
  runner broadcasts a new `ServerFrame` `{type:'cost', costToday}` when a run's spend
  grows, and the store takes it.
- **Needs You:** `AlertKind` gains `daily_budget`, and `Alert` gains `spent`/`budget`.
  `Alerts.#daily()` raises one while today's spend is at or over the budget. Its id is
  `daily:<local date>`, so dismissing lasts the day. It is re-checked on every spend and
  budget change. Its only action is dismiss; the card says it only warns.
- **Web:** `shell/spend.ts` (pure): `dailyMeter` gives fraction, tone (ok/warn/over), label
  and title. The status bar's `DailySpend` draws a small bar with "$3.20 of $10.00 today",
  green, then yellow, then red. Settings → **Spend** edits the budget, mirroring the
  daemon's rule.

**Verified:**
  - `session/verify.ts` §17g checks a bad budget gets 400; no alert under it; a spending
    run sending `cost` to every tab; the alert with spend and budget, broadcast; nothing
    paused; one a day; raising the budget clearing it; spend growing with no other
    event still raising it; and none with no budget.
  - `lib/verify.ts` §25 covers thresholds, the full bar, the words, the field, and that
    the setting matches the daemon's.
  - Four mutations were caught: red at 100%; no cost frame; no refresh on spend; the
    alert raised early.
  - `make test`: 9 PASS, exit 0.

### Amendment 58 — post-merge, applied. **A terminal on the Agent screen: a command runner in the agent's folder.**

Asked for (TODO.md): "a capability to open up a terminal command line window/panel."
**Decided by the user:** a command runner, not a real terminal, so there is no new
dependency (§3) and nothing interactive; and on the Agent screen, in that agent's folder.

**Daemon:**
  - `session/terminal.ts` (new) runs each command as `$SHELL -c` in the agent's job
    worktree:
    - stdin is closed, so a prompt reads end-of-file instead of hanging;
    - it runs in its own process group, so **stop** (SIGINT, then SIGKILL after 3 s)
      reaches what the shell started;
    - `TERM=dumb`/`NO_COLOR`, and `CONDUCTOR_TOKEN` taken out of its environment.
  - One command at a time per agent (409 otherwise).
  - Output is batched every 50 ms and capped at 256 KB per run (then `cut`). The last 20
    runs per agent are kept in memory, forgotten, and stopped, by a daemon restart.
  - It runs as the user, with the user's permissions, behind the localhost guard and
    `CONDUCTOR_TOKEN`; the panel says so. Commands aren't written to the agent's
    transcript: they are yours.
  - `routes/terminal.ts` (new): `GET`/`POST`/`DELETE /api/agents/:id/terminal` and
    `POST /api/terminal/:runId/stop`.
  - New `ServerFrame`s: `terminal_run {run}` when a command starts or ends, and
    `terminal_out {agentId, runId, stream, text}`. `TerminalRun` and `TerminalChunk`
    are in `wire.ts`.

**Web:**
  - `lib/terminal.ts` (new) keeps runs per agent from history and frames. `mergeRun`,
    `appendOutput`, `stripAnsi` and `endLine` are pure.
  - `agent/Terminal.tsx` (new) is the panel: prompt with the folder, ⏎ to run, ↑↓
    history, ■ stop, clear, stderr in amber, the exit or signal on the last line.
  - The Agent screen's bottom panel has **reply | ›_ terminal** tabs in the composer's
    resizable area; the choice is the `conductor.agentBottom` setting.

**Verified:**
  - `session/verify.ts` §17f checks validation and 404s; a run in the agent's folder with
    its exit code; stdout and stderr apart to every tab; kept history; the token not
    passed on; one at a time; stop by signal; a prompt getting end-of-file; the cap;
    clear; stopping an unknown run.
  - `agent/verify.ts` "Terminal" covers the web rules.
  - Four mutations were caught: token kept; input left open; no cap; commands at once.
  - `make test`: 9 PASS, exit 0.

### Amendment 57 — post-merge, applied. **The Fleet has a Sort by menu.**

Asked for: "allow the cards in the Fleet to be sorted by name, working, my order, etc."
Amendment 54's two-way button becomes a **Sort by** select with seven choices (`SORTS` in
`fleet/order.ts`): needs you first, my order, name, working (most working now), recently
active (latest agent start or end), spend (the agents' total) and newest (project added
last).

- `sortProjects(projects, sort, order, facts)` is pure. The Fleet computes `SortFacts` for
  each project once: needs-you rank, working count, last activity and spend. Every sort
  ties on name, so equal projects never swap between renders.
- The choice is the `conductor.fleetSort` setting. `fleetSort` accepts every id in `SORTS`,
  and falls back as before.
- Dragging or moving a card still switches to **my order**, starting from what is shown.

**Verified:** `lib/verify.ts` §23 checks each sort's order and ties, and that every menu choice
is kept. Three mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 56 — post-merge, applied. **The same notes on the Project and Agent screens.**

Asked for: "add the ability to CRUD notes in the Projects tab, agents tab." **Decided by
the user:** one set of notes per project, the same everywhere. The Agent screen shows its
agent's project's notes.

- `fleet/project.tsx`: the projects column has a **Notes · N** section under the project's
  facts, with `NotesPanel`.
- `agent/inspector.tsx`: a **<project> notes · N** section with `NotesPanel` for the agent's
  project.
- No new data or routes: Amendment 55's are the only ones. A change anywhere reaches every
  screen, because notes ride on the project's `entities` frame. `fleet/Notes.tsx` imports
  its own styles.

**Verified:** `lib/verify.ts` §24 checks both screens render the panel for the right project.
`make test`: 9 PASS, exit 0.

### Amendment 55 — post-merge, applied. **Notes on a project, on its Fleet card.**

Asked for: "allow me to add notes to each project, so that I can keep track of where I
am. These notes should be visible on the Fleet page when I see their card. Have the card
show the number of notes on it. Allow me to CRUD on the notes."

- Migration `080_notes.sql` adds `project_notes (id, project_id → projects ON DELETE
  CASCADE, text, created_at, updated_at)`. Removing a project forgets its notes, like
  every row that is only about the project, and touches no files.
- `wire.ts`: `ProjectNote`, `NOTE_MAX` = 4000, and `Project.notes?`, newest first and present
  only when there are some, so a project's shape is otherwise unchanged. Notes ride on
  the project, so the snapshot, `GET /api/projects` and `entities` frames carry them with
  no new frame.
- Routes (`routes/session.ts`):
  - `POST /api/projects/:id/notes {text}` returns 201 `{note, project}`.
  - `PATCH …/notes/:noteId {text}` keeps `createdAt` and moves `updatedAt`.
  - `DELETE …/notes/:noteId` returns `{project}`.
  - Text is trimmed and must be 1–4000 characters, else 400; an empty edit is refused,
    so delete instead. A note is reached only through its own project, else 404.
  - Every change broadcasts the project.
- Web: `fleet/Notes.tsx` provides:
  - `LatestNote`, the newest note under the card's path, two lines, with its age;
  - `NotesButton`, the count in the footer (`✎ 3 notes` / `+ note`);
  - `NotesPanel`, which adds (⌘⏎), edits (⌘⏎ saves, Esc cancels) and deletes with a
    confirm.

  Clicks and keys stop at the panel, since the card is a button that opens the project.
  The words are pure, in `fleet/notewords.ts`.
- Notes are the user's: nothing gives them to agents.

**Verified:** `session/verify.ts` §17e checks validation, 404s, create, trim, newest-first,
the broadcast, GET, edit keeping `createdAt`, an empty edit refused, cross-project access
refused, delete (and twice), and the field gone with none left. `lib/verify.ts` §24 covers
the words and wiring. Four mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 54 — post-merge, applied. **The Fleet cards can be put in your own order.**

Asked for: "Allow me to reorder the location of the various projects on the Fleet card
page." The grid had one order, needs-you first and then by status.

- `fleet/order.ts` (new, pure) has `applyOrder`, `moveBefore`, `moveBy`, `parseOrder` and
  `fleetSort`. Your order is the `conductor.fleetOrder` setting, a list of project ids.
  A project you haven't placed goes after, in its own order, and a removed one drops out.
  `conductor.fleetSort` is `mine` or `attention`. Until you choose, it's `attention`,
  unless an order exists.
- `fleet/fleet.tsx`:
  - Each card is in a draggable slot. Dropping one card on another puts it just before
    that card, saves the order, and switches to your order, since a drag can only mean
    that.
  - The header's **⇅ your order / ! needs you first** button switches between the two.
- `fleet/card.tsx`: the **…** menu has **← move earlier / → move later**, which is the
  keyboard way, and hidden at either end.
- Needs-you-first is still one click away. The amber attention rail and each card's
  colour still say what needs you in either order.

**Verified:** `lib/verify.ts` §23 checks the saved order, new and removed projects, a drop
in either direction, single steps and both ends, the default sort, and a broken setting.
Three mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 53 — post-merge, applied. **A restart keeps everything: the history comes to `~/.conductor/`, and interrupted agents resume by themselves.**

Asked for: "when we restart, it keeps all the connections and chat history." Two things
didn't survive. The history would be left behind on first allowing `~/.conductor/`
(Amendment 46's "start fresh"), and agents mid-run came back paused. **Both decided by
the user:** bring the history over, and resume interrupted agents automatically. This
reverses Amendment 46's start-fresh choice.

**History (`storage.ts`, `setup.ts`):**
  - While undecided, `storageNow()` reports `legacyHolds {projects, agents}`, counted from
    the old database opened read-only.
  - `POST /api/storage/choice {allow: true, bring: true}` → `allowHome(true)` copies it in
    with `VACUUM INTO` from a read-only handle. That includes what is still in its
    write-ahead log, and leaves the old file byte-for-byte as it was. It never copies
    over a database already in the folder. `broughtFrom` says it happened.
  - `CONDUCTOR_LEGACY_DB` points at a stand-in, so the smoke test never reads a real
    history.
  - The question (`settings/always.tsx`) shows **Bring my history: copy 3 projects and 1
    agent, with their chats**, ticked by default, when there is an old database.

**Restarts (`Supervisor.reconcile`):** an agent left `working` with no runner (a graceful
stop leaves them so on purpose; a hard kill does too) is now `queued`, not `paused`. Its
status event says "the daemon restarted mid-run — resuming it" (the transcript shows a
queued status with a reason as a note). It is remembered in `#restarted`, so its resume
prompt is `RESTART_NUDGE`, once. `pump()` then resumes it: in its session, into a free
slot, and paused instead if it is at its budget. One with no session starts from its
prompt.

**Verified:**
  - `smoke.ts` §6 checks the holds reported; bring copying everything, including what was
    in the log; the old file unchanged; no bring starting empty.
  - `session/verify.ts` §5 is updated (queued, not paused), and §17d checks every
    interrupted agent queued; resumed with no click; `RESTART_NUDGE` in its session; a
    fresh one from its prompt; one at its cap paused; told once.
  - `lib/verify.ts` §18 covers the offer's words.
  - Five mutations were caught: paused again; no nudge; bring ignored; always bringing;
    opening the old file writable.
  - `make test`: 9 PASS, exit 0.

### Amendment 52 — post-merge, applied. **A folder field's list opens only while the field is focused.**

Reported: "selected +Project and it started with two popup menus." `spawn/PathField.tsx`
started its completion list open whatever the focus. That was right while Spawn had the
only one; Amendment 45's Fleet form has two (main and referenced), so both lists opened
at once over each other. Now `open` starts as `autoFocus`, opens on focus and closes on
blur. Picking a row is a mousedown that keeps focus, so closing on blur never loses a
pick.

**Verified:** `lib/verify.ts` §17 checks the three handlers; one mutation (starting open)
was caught. `make test`: 9 PASS, exit 0.

### Amendment 51 — post-merge, applied. **Several agents on one role, run by an orchestrator.**

Asked for (TODO.md): "When starting an agent for a role like builder, offer to put several
agents on it. The first one then only orchestrates: it splits the work, starts the
others and collects what they report." **Decided by the user:** helpers count against
slots and share the job's budget like any agent, and show nested under the orchestrator.
The orchestrator gets a Conductor tool to start them, capped at a number set at launch,
and hears their final replies.

**How the orchestrator starts helpers: an MCP server the daemon serves over HTTP.** The
SDK's in-process `createSdkMcpServer` needs zod, which isn't a daemon dependency, and
adding one needs escalating (§3). `routes/helpers.ts` answers `POST /mcp/agents/:agentId`
with the JSON-RPC a tools client needs:
  - `initialize`, `ping`, `tools/list` and `tools/call`; notifications get 202; anything
    else gets `method not found`; `GET` gets 405. Replies are plain JSON, which the
    streamable-HTTP transport allows.
  - The agent is named in the path, so no argument can claim to be another.
  - The localhost guard applies, and the runner sends `CONDUCTOR_TOKEN` as a header when
    one is set.
  - Checked against a real Claude Code: it connects and lists `start_helper` and
    `list_helpers`.

**Daemon:**
  - `AgentSpec.helpers` (0–`HELPERS_MAX` = 8; the route refuses others with 400) becomes
    `agents.helper_cap`. Migration `070_helpers.sql` adds `helper_cap`, `parent_id` and
    `reported_at`. `Agent.helperCap`/`parentId` appear only when set, so an ordinary
    agent's shape is unchanged.
  - The runner gives an agent with `helperCap` the server as `mcpServers.conductor`, with
    `mcp__conductor__start_helper`/`list_helpers` in `allowedTools`: never asked, never
    deferred. The orchestrator's prompt gains `orchestratorSection()` (`handoff.ts`).
  - `Supervisor.startHelper(orch, task, name?)` refuses without a cap, past the cap, or
    with no task. The role is `<role>-<name>` or `<role>-helper-N`, unique in the job. The
    helper takes the orchestrator's model and autonomy (its per-agent budget included),
    `helperBrief()`, and `parentId`. It is queued and pumped like any agent.
    `listHelpers()` gives role, status, and the last reply once ended.
  - **Waiting.** An orchestrator whose turn ends normally with unreported helpers
    (`#awaitHelpers`) goes back to `queued`, depending on them, and frees its slot.
    `#depsSatisfied` counts a helper that failed or was stopped as ended, so it can't
    block its orchestrator for ever.
  - **Hearing back.** When pump restarts it (with its session), `#resumePrompt` begins
    with `#takeHelperReport`: `helperReport()` gives each ended helper's last reply,
    saying which didn't finish. Those helpers are marked `reported_at`, which lasts
    across a restart, and dropped from its `dependsOn`. A turn with nothing left to
    hear from ends `done`.
**Web:**
  - Each Spawn plan row has **1 agent / + up to N helpers**, sent as `helpers` by
    `toAgentSpecs(…, helpers)`. A preset change clears it.
  - The Project screen's lanes put each helper after its orchestrator, captioned
    **↳ helper of …** (`fleet/nest.ts`, pure). A helper whose orchestrator is gone
    stands on its own.

**Not in this:** helpers can't start helpers (they have no cap), and custom setups don't
save a helper count.

**Verified:**
  - `session/verify.ts` §17c runs the real supervisor and routes with a fake SDK:
    - the tools and their URL, allowed outright, and the prompt;
    - MCP `initialize`, the 202, `tools/list` and an unknown method;
    - `start_helper` naming, numbering, the cap, and a required task; a non-orchestrator
      refused; the helpers' job, model, autonomy and brief; helpers taking slots;
      `list_helpers`;
    - the orchestrator waiting queued and giving its slot back; one helper done not
      being enough; the last, failed, restarting it in its own session with each
      reply and which didn't finish; reported and no longer waited on; `done` after;
    - 400 for 9 helpers.
  - `spawn/verify.ts` §9 checks the spec field; `lib/verify.ts` §22 checks the nesting.
  - Eight mutations were caught: no tools; no cap; no waiting; a failed helper
    blocking; no report; never marked reported; no orchestrator words; any agent
    orchestrating.
  - `make test`: 9 PASS, exit 0.

### Amendment 50 — post-merge, applied. **A Custom setup on Spawn: your own agents, saved by name.**

Asked for (TODO.md): "Keep the preset setups for quick starts, and add a **Custom** one
where you add agents yourself and set each one's role and model." **Decided by the
user:** a custom setup can be named and saved, and the daemon keeps it, so every tab
and restart sees it.

- `spawn/custom.ts` (new, pure) holds the rules:
  - `CustomRole {role, brief, dependsOnRoles}`, and `toPreset()`, which turns the rows
    into a `Preset`. The plan preview, the per-row model pickers (Amendment 41) and
    `toAgentSpecs` then treat it like any preset. Each row's tier is sonnet until its
    picker chooses an exact id.
  - `customProblems()` refuses an empty setup, a role that isn't
    `[a-z][a-z0-9-]*`, a repeated role (the daemon resolves waits by role, and already
    refuses repeats), and a wait on a role that isn't above it.
  - `renameRole`/`removeRole` carry the waits along. `nextRole` picks the first free
    known role.
  - Saved setups are the `conductor.setups` setting, a JSON list of
    `{name, roles, models}`. `parseSetups` drops anything malformed. Saving by an
    existing name replaces it, and forgetting the last clears the setting.
- `spawn/CustomSetup.tsx` (new) is the editor: role (with known roles offered), brief,
  **waits for** checkboxes for the rows above, add or remove, and name-and-save.
- `spawn/route.tsx` adds **custom…** and the saved setups to the preset pills. A saved
  one loads into the editor, models included; its **✕** asks first. Launch waits while
  the setup has a problem, and a renamed or removed row drops its model pick.
- A reading role stays read-only in a custom setup, because `isReadOnlyRole` is about
  the role, not the preset.

**Verified:** `spawn/verify.ts` §8 covers the rules above, a custom setup's specs (per-row
model, a read-only reviewer, its waits), and saving, replacing, forgetting and
malformed input. Five mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 49 — post-merge, applied. **The Agent screen has a tab per agent in its project.**

Asked for (TODO.md): "In a project with several agents, opening Agents should show a
tab per agent in that project … Each tab should show whether that agent needs you."

- `agent/tabs.ts` (new, pure): `agentTabs(agents, projectId, jobOrder, pending, alerts)`.
  - Only the project's agents, newest job first; within a job, in creation order, which
    is the plan's order.
  - A role that appears more than once is numbered (`builder 1`, `builder 2`).
  - `needs` counts pending requests and alerts naming the agent. While it's above zero
    the tab's status is `blocked`, whatever the row says, the same rule as the projects
    list (Amendment 43).
  - `newJob` marks where a job's group starts.
- `agent/agent.tsx` draws the strip above the header only when there is more than one
  tab. A click is `openAgent`, so the hash and the highlighted project follow. The Files
  `TabStrip` wasn't reused: its tabs close and reorder, and these do neither.

**Verified:** `agent/verify.ts` "Tabs" checks the project filter, the order, the numbering,
requests and alerts both marking a tab, the job groups, and the one-tab rule. Four
mutations were caught. `make test`: 9 PASS, exit 0.

### Amendment 48 — post-merge, applied. **"Allow always" rules can be seen and revoked, and `:*` means what Claude Code means.**

Asked for (TODO.md): "Clicking allow always on a request saves a rule for the whole
project, and nothing in the UI lists those rules or takes one back." **Decided by the
user:** revoking deletes Conductor's row and only *points at* Claude Code's copy (which
file, which entry). Conductor never edits it.

**Found on the way, and fixed.** `#matchRule` read `npm test:*` as a literal prefix,
`npm test:`. That's Claude Code's syntax for "`npm test` and anything after it". So
Conductor's own copy of every prefix Bash rule matched nothing, and the arbiter asked
again for calls the user had allowed always. This was mostly hidden, because the SDK
applies its own copy within a session. The matching is now `ruleCovers()`, pure and
exported: `x:*` is `x` or `x ` followed by anything, a bare trailing `*` is a plain
prefix, and anything else is exact.

- Migration `060_rule_origin.sql` adds `session_rules.agent_id`, with no foreign key,
  since the rule belongs to the project. `#persistRules` records it; older rows have
  none and say so.
- `session/store.ts` gets `RuleRecord.createdAt`/`agentId`, `getRule` and `deleteRule`;
  `rulesForProject` is now ordered.
- `session/rules.ts` (new) has `describeRule` → `RuleView` (in `wire.ts`), with who asked
  and the SDK's copy. It reads the suggestion's `destination`: `localSettings` →
  `<cwd>/.claude/settings.local.json`, `projectSettings` → `<cwd>/.claude/settings.json`,
  `userSettings` → Claude Code's own `settings.json`, session or cliArg → no file. `cwd` is
  the job worktree the agent ran in. `fileHolds` reads the file (read-only) for the
  entry in `permissions.allow`; `present` is null when it can't be read.
- Routes: `GET /api/projects/:projectId/rules` returns `{rules}`, or 404 for an unknown
  project. `DELETE /api/rules/:ruleId` returns `{removed}`, a `RuleView` including the
  copy, or 404.
- Web: **Settings → Allowed always** picks a project (the highlighted one, Amendment 44)
  and lists its rules: `ruleTitle`, `ruleOrigin`, and `copyLine`, which says where the other
  copy is and what to remove. **revoke…** confirms, and `REVOKE_NOTE` says a running agent
  keeps what its session has until its next run. The words are pure, in
  `settings/rules.ts`.

**Verified:**
  - `session/verify.ts` §17b drives a real held request to allow always. It checks the
    rule is listed with its agent, time and copy (found in the agent's folder, present).
    A later matching call is then allowed without asking. Revoking returns the copy and
    leaves the file byte-for-byte; the next matching call asks again; twice gets 404.
    `ruleCovers`, `settingsFileFor`, `fileHolds` and `ruleEntry` are checked directly.
  - `lib/verify.ts` §21 covers the words.
  - Seven mutations were caught: the old `:*` reading; `:*` too loose; no agent
    recorded; revoke keeping the row; the copy looked for outside `.claude/`; presence
    ignoring the file; the copy line losing its entry.
  - `make test`: 9 PASS, exit 0.

### Amendment 47 — post-merge, applied. **A Settings tab, and a slot limit that changes while running.**

Asked for (TODO.md): "A Settings tab in the top menu. One place for behaviour and
configuration changes … The first setting it needs is the maximum number of agent
slots … a value the daemon stores and can change while running, with one source for
both."

**Slots (daemon):**
  - `slots.ts` (new, W0) is the one source. `slotLimit()` reads the `conductor.slots`
    setting, else `CONDUCTOR_SLOTS`, else 7, on every check. The supervisor schedules by
    it and `hub.ts`'s empty snapshot reports it. `TOTAL_SLOTS` is gone.
  - `settings.ts` gains `settingRule(key, rule)`, so `conductor.slots` must be a whole
    number from 1 to 32 or the PATCH gets 400. It also gains `onSettingsChanged`: a new
    limit makes the supervisor re-`pump()` (a raise starts what was queued) and push
    the count.
  - **Lowering it stops nobody.** Running agents finish, and `pump()` starts nothing
    until fewer than the limit are running. (The TODO's own suggestion.)
  - A new `ServerFrame` `{type:'slots', slots:{used,total}}` goes out whenever a slot is
    taken or freed, or the limit changes. The status bar used to learn the count only
    from a snapshot, so it went stale between reloads.
  - **Open, not changed here:** a message to an idle agent (`sendMessage` →
    `#launchWithPrompt`) starts it at once, whether or not a slot is free. That was
    already so before this. It is now visible, because the limit can be lowered under
    running work. The MANUAL says so.

**Settings tab (web, `settings/route.tsx`, order 90, hotkey `9`):**
  - Where it is kept: the storage mode and folder, **save to ~/.conductor** in memory
    mode, and the old database named.
  - Agents running at once: its field rule mirrors the daemon's (`settings/slots.ts`),
    and a check compares the two sources.
  - Launch defaults: preset, one model for every role or per role, isolation, the
    autonomy pills, effort and budget. `spawn/defaults.ts` parses each with a fallback,
    so a bad value never stops Spawn from opening. `launchPatch` writes only what differs
    from built in. Spawn's state starts from `launchDefaults(readSetting)`.
  - Look: theme, reset panel sizes, unfold every reply. Notifications stay on Needs you.
  - `web/src/lib/settings.ts` drops a write the daemon refused (4xx) rather than
    retrying it forever. Its next `settings` frame puts the kept value back.

**Verified:**
  - `session/verify.ts` §15 checks bad limits (0, x, 33, 2.5) refused; a new limit taken;
    no more than it starting; lowering it stopping nobody and starting nothing; the
    `slots` frame; raising it starting the queued agent; the snapshot reporting it; and
    removal going back to the default.
  - `spawn/verify.ts` §7 covers the launch defaults' parsing, fallbacks and round-trip.
    `lib/verify.ts` §20 covers the field rule, that it matches the daemon's, and the tab.
  - Six mutations were caught: pills unchecked; a bad preset kept; `launchPatch` writing
    everything; the limit ignoring the setting; no re-pump on change; no rule.
  - `make test`: 9 PASS, exit 0.

### Amendment 46 — post-merge, applied. **Data and settings live in `~/.conductor/`, and only once the user allows it.**

Asked for (TODO.md): "Move it, and the settings file the Settings tab will write, to one
folder in the user's home directory … it asks the user before creating it … and doesn't
write anything under home until the user agrees."

**Four choices, all made by the user:**
- **Ask in the web UI, on first load.**
- **If the user says no, run in memory and say nothing will be saved.** Not remembered:
  the next start asks again.
- **Start fresh.** The old `packages/daemon/conductor.db` is not moved or opened. It is
  named in the question as left where it is.
- **Everything is a setting.** Theme, panel sizes, folds, Files tabs, the composer height,
  the inspector toggle, the column toggle and the notification choices all move out of
  localStorage into the settings file.

**Daemon:**
  - `storage.ts` (new, W0) decides the mode at boot. `override` if `CONDUCTOR_DB` is set;
    `home` if `~/.conductor/` exists (the folder is the consent, and only `allowHome`
    creates it, mode 700); else `undecided`. `memory` follows a "no". `CONDUCTOR_HOME`
    moves the folder.
    - `storageNow()` returns `StorageState {mode, dir, saved, db, settings, savedAt?, legacy?}`.
      Its type is in `wire.ts`.
    - `saveMemoryHome(db)` copies a memory session home with `VACUUM INTO` for the next
      start. It refuses to overwrite a database already there.
  - `setup.ts` (new): while undecided, `main()` runs a setup server on the daemon's own
    port **before `build()`**, since every part opens the database at start. It answers
    `/api/health` (`setup: true`, so `make start` sees it up), `GET`/`POST
    /api/storage/choice {allow: boolean}` and 503 for anything else. It closes once
    answered, and the real daemon starts; the page's feed reconnects.
  - `db/index.ts`: `DEFAULT_DB` is gone. `dbPath()` is `storageNow().db`, and `:memory:`
    until decided.
  - `settings.ts` (new): a flat string map in `settings.json`, written through a
    temporary file and a rename, mode 600. Names match `[a-zA-Z0-9._:-]{1,120}`; values
    are strings; `null` removes. A bad patch is refused before anything changes, and a
    broken file is ignored. With nowhere to save, settings last as long as the process.
  - `routes/settings.ts` (new): `GET`/`PATCH /api/settings`. Every change is broadcast as
    a new `ServerFrame` `{type:'settings', settings}`, and `Snapshot.settings?` carries them
    (optional, so old recordings replay).
  - `routes/health.ts`: `GET /api/storage/choice`; `POST` gets 409 once decided; `POST
    /api/storage/save-home`.

**Web:**
  - `lib/settings.ts` (new): the one reader and writer. Writes land locally at once and
    go up batched (300 ms). `mergeIncoming` keeps an unsent write over the daemon's older
    copy. The first time the daemon's settings arrive, `importable` moves this browser's
    `conductor.*` localStorage keys up (never over the daemon's) and removes them locally.
    Until then, localStorage still answers and takes writes, so a fixture replay, or a
    daemon started before this change, behaves as before.
  - Every former localStorage user reads and writes through it: `shell/theme.ts`,
    `shell/panels.ts`, `agent/folds.ts`, `agent/agent.tsx`, `files/useTabs.ts` (read at
    start and once on load, never live, so two browsers don't fight over the front tab),
    `files/route.tsx`, `files/FilePane.tsx` and `attention/notify.ts`. The OS notification
    permission stays per browser.
  - `settings/always.tsx` (new, always-on): the question as a modal while undecided, and a
    line on every screen while in memory, with **save to ~/.conductor**. The words are
    pure, in `settings/storage.ts`.
  - `make clean` deletes only the database in `CONDUCTOR_HOME`, leaving settings and the
    old database.

**Verified:**
  - `smoke.ts` §6 covers undecided runs on memory and writes nothing; the setup server
    answering health, 503 for the rest, 400 for a non-answer, and closing on yes and on
    no; yes creating the folder (700) and putting the database in it; the next start not
    asking; no staying in memory and not being remembered; saving home and refusing to
    overwrite; `CONDUCTOR_DB` skipping the question; `settings.json` written (600),
    patched, removed and re-read, with a bad name or value refused whole and a broken
    file ignored; and over HTTP, PATCH, a 400, the snapshot, and the broadcast.
  - `lib/verify.ts` §18–19 covers the question's words, the banner, `mergeIncoming`,
    `importable`, and that no source outside `lib/settings.ts` touches localStorage.
  - Seven mutations were each caught: home without asking; yes creating nothing;
    overwriting a database; bad names accepted; never written; no broadcast; any answer
    accepted.
  - `make test`: 9 PASS, exit 0.

### Amendment 45 — post-merge, applied. **A project is added on Fleet, with its main and referenced folders at once.**

Asked for (TODO.md): "Make adding a project a place to add the folders that belong to it:
one is the main folder, where agents work, and the rest are referenced folders they can
read and use." Spawn's **where** step listed the existing projects with an add field
under them, so it read as if it were asking for the new project's folders, and it wasn't.

**Three choices, made by the user:**
- **Referenced folders stay read-and-edit**, in place, as Amendment 39's extra
  directories already are. "Main" and "referenced" are the words for what
  `Project.path` and `Project.extraDirs` already meant. No schema change.
- **Folders only**, not single files.
- **Adding happens on Fleet only.** Spawn picks from existing projects and links to
  Fleet (`navigate('fleet', { add: '1' })`, which opens the form).

**Daemon:**
  - `CreateProjectRequest` (W0, `wire.ts`) gains `dirs?: string[]`.
    `Supervisor.createProject(path, name, dirs)` expands `~` in every path, which the main
    path didn't do before. It checks **every** referenced folder (exists, is a directory)
    before writing anything. It drops repeats and the main folder, and inserts the
    project and its `project_dirs` rows before the one `entities` broadcast.
  - A main folder already taken returns `existing: true` and changes nothing. That
    project's folders are edited on its card.
  - `dirs` that isn't a list of strings gets 400.

**Web:**
  - `fleet/NewProject.tsx` is the form: main folder, name (placeholder from the folder),
    and a referenced list. A folder still in the add field when you press **add project**
    is sent, not dropped. The rules are pure, in `fleet/addproject.ts`:
    `tidyPath`, `nameFrom`, `addReferenced` (which refuses a blank, a repeat or the main
    folder, and says why) and `addedLine`.
  - `spawn/PathField.tsx`: Spawn's completing field is moved out of `spawn/route.tsx` so
    the form can use it, with an optional submit label, placeholder, autofocus, and
    `judge: 'git'` for a note that says only whether the folder is a repository.
  - Fleet gets **+ add project** in its header, the grid tile says **add a project**, and
    the empty state has an add button. A new project is `highlight()`ed (Amendment 44).
  - Spawn: the add field, `addProject` and its note are gone. The where step lists
    projects, plus **+ add a project on Fleet…**.
  - The card's panel reads **▤ folders…**, with **main · agents work here** and
    **referenced** rows. The edit form's field is **main folder**.

**Verified:**
  - `session/verify.ts` §18: one missing or file-typed referenced folder refuses the
    whole project with nothing created; bad `dirs` gets 400; a project is created with
    its referenced folders, deduplicated, main dropped, `~` expanded and in order;
    creating it again changes nothing; removal leaves the folders.
  - `lib/verify.ts` §17 covers the form's rules, that Spawn no longer POSTs a project,
    and that the form sends a folder left in the field.
  - Seven mutations were caught: referenced rows not written; files accepted; repeats
    kept; a missing folder skipped; the main folder compared untidied; repeats accepted
    in the form; the field's folder dropped.
  - `make test`: 9 PASS, exit 0.

### Amendment 44 — post-merge, applied. **Files opens on the highlighted project.**

Asked for (TODO.md): "With the second project selected in the projects panel, opening
Files should show only that project's directories and files … not the last one used or
the first in the list." Files opened on whatever its tab store held from last time, or
failing that on `projects[0]`. Selecting a project on the Project screen told it nothing.

- **One notion of "this project".** `shell/nav.ts` gains `highlight(projectId)` over the
  existing fallback memory (`recall().projectId`). The Project screen calls it for the
  project its list shows selected, **including its fallback to the first project**, so
  "selected" on screen and "highlighted" in memory never differ. Files calls it for the
  project its column shows, so choosing one there selects it back on the Project screen.
- **`arrive()` in `files/tabs.ts`** is pure. On arrival without a link, a highlighted
  project wins: `selectProject` onto it, which brings its last tab forward or waits to
  open its first directory. Arriving on the project already shown changes nothing. With
  nothing highlighted, Files keeps what it had, else opens the first project. A link in
  the hash (`jobId` or `projectId`) decides for itself.
- **Once per arrival.** `files/route.tsx` runs it once, after the projects have loaded,
  instead of on every snapshot. Re-running would drag the column back while you browse.

**Verified:** `files/verify.ts` checks that another highlighted project is shown with its
last tab or its first directory; that arriving on the shown project changes nothing;
that a link is left alone; that a job beside the column gives way; that with no highlight
Files keeps what it had or opens the first; and that the Project screen and Files both
record the highlight. Three mutations were caught: links overridden; highlight applied
only to an empty column; the Project screen not recording its selection. `make test`:
9 PASS, exit 0.

### Amendment 43 — post-merge, applied. **One projects list: the rail of pips is gone.**

Asked for (TODO.md): "Clicking the project icon in the left rail opens a second panel
beside it listing the same projects by name. Keep the named projects panel and drop the
icon rail."

- `shell/shell.tsx`: `ProjectRail` and `RailPip` are removed, along with `.sh-rail` and
  `.sh-pip` in `shell.css` and `--rail` in `shared/src/tokens.css`. The shell is now
  three pieces: the attention rail, the screen nav and the status bar.
- The rail's one rule moves with it. A project is amber whenever the queue holds a
  request **or an alert** for it, whatever the status rollup says, because the rollup
  can lag. That rule is now `projectNeeds()` in `shell/describe.ts`, and
  `fleet/project.tsx`'s `ProjectListRow` uses it for `is-need`, the dot and a count.
- The rail's **+** is now a **+** in the projects column's head, opening Spawn.
- What is given up: a project list on screens other than Project. The attention rail
  across the top still covers "something needs you" from anywhere.

**Verified:** `lib/verify.ts` §16 checks that requests and alerts both count, for their own
project only; that an alert with no project marks none; that the shell no longer draws a
rail; and that the named list uses `projectNeeds`. Two mutations were caught: alerts
ignored, and pending counted across projects. `make test`: 9 PASS, exit 0.

### Amendment 42 — post-merge, applied. **A screen can be registered without a tab, and Spawn is one.**

Asked for (TODO.md): "Remove Spawn from the top menu. The screen stays, reached from the
project panel and Fleet's +." You start work from a project, so a top-level tab for it
was a second, context-free way in.

- `lib/screens.ts` (W0): `ScreenDef` gains `tab?: boolean`, and `hotkey` becomes
  optional. `tab: false` means registered and routable, so `navigate('spawn')` and deep
  links still work, but no nav chip and no hotkey. The rules are two pure functions,
  `tabbed()` and `screenForKey()`, so they can be tested without `import.meta.glob`.
- `main.tsx` (W0) builds the nav from `tabbed(screens)` and the hotkeys from
  `screenForKey`. A screen without a tab has no hotkey even if it names one.
- `spawn/route.tsx` registers with `tab: false` and no hotkey. `7` is free. The reserved
  table says so.
- The status bar reads `1–6` screens.

**Verified:** `lib/verify.ts` §15 checks that a tabless screen gets no chip and no key,
that tabs come in nav order, and that Spawn's own registration has `tab: false` and no
hotkey. Two mutations were caught: the key lookup ignoring `tab`, and the nav not
filtering. `make test`: 9 PASS, exit 0.

### Amendment 41 — post-merge, applied. **Each role in Spawn has its own model picker, and analysis ends in docs.**

Asked for: "how do i assign different models to different roles", then "on the
Analyst, make the second model a documenter — update documentation based on analysis
roles". Amendment 40's Spawn had one override that replaced every role's tier at
once. There was no way to give the builder opus and the scribe something cheaper.
The only way was to launch and then change each agent in its composer.

**Per-role models (`spawn/presets.ts`, `spawn/route.tsx`):**
  - `RoleModels` is the exact id picked per role. `toAgentSpecs(…, picks, tiers)` sends
    `modelFor(r, picks, tiers)`: the role's pick, else what its tier means now. It
    replaces the single override.
  - Each plan-preview row has a `ModelSelect` showing the id that row will be sent.
    Picking the id its tier already means drops the pick (`pickFor`) rather than
    storing it, so the row is back on its preset.
  - The model picker above the plan is now a shortcut. `pickAll` sets every row, and
    `per role` clears them. `commonPick` shows one id only once a row is picked and
    every row resolves to it. Otherwise it shows `per role`, so it never names a model
    some rows aren't on.
  - Switching preset drops per-row picks and keeps a model given to every row.
  - `unresolvedRoles()` replaces `unresolvedTiers()`. It names the rows with no id, and
    a pick in that row resolves it. Spawn's warning names those roles.

**The analysis preset** is now `analyst` → `documenter`, not `analyst` ∥ `auditor`:
  - The documenter is `sonnet`, `dependsOnRoles: ['analyst']`, so Amendment 37 hands it
    the analyst's report. It updates the README, `docs/`, and architecture or decision
    records, keeping the citations. Where the report and the code disagree, the code
    wins.
  - It **writes**, so it is not in `READ_ONLY_ROLES`. "Documentation only" is its brief,
    not a tool rule: no permission separates a doc from source. The plan preview no
    longer marks it read-only, and the MANUAL says to check its diff.
  - `auditor` stays in `READ_ONLY_ROLES`. Agents launched as auditors still exist, and
    their role is what they were promised.

**Verified:**
  - `spawn/verify.ts`: the analysis checks are rewritten (the analyst is read-only and
    starts now, and the documenter waits, can write, and has its scope in its brief).
    §5 now checks per-role picks, `pickAll`, `commonPick`, `pickFor` and
    `unresolvedRoles`.
  - Nine mutations were each caught: picks ignored; a same-as-tier pick stored;
    `commonPick` naming an id with no picks; `pickAll` setting one row;
    `unresolvedRoles` ignoring picks; documenter made read-only; documenter made
    parallel; auditor dropped from `READ_ONLY_ROLES`; brief losing its scope.
  - `make test`: 9 PASS, exit 0.

### Amendment 40 — post-merge, applied. **An agent is given an exact model id, from the list the model API serves.**

Asked for: "can we be more specific on the models we select, is there a way to get the
supported list of models?" Before this, Spawn and the composer offered only the aliases
`opus | sonnet | haiku`. The alias meant whatever `ANTHROPIC_DEFAULT_*_MODEL` said, and
nothing said when that id was retired. That is how agents failed on
`us.anthropic.claude-opus-5`: the gateway had stopped serving it, and nothing in
Conductor could have known.

**Two choices, both made by the user:**
- **Offer every model the gateway serves**, Claude first, the rest grouped apart with
  "may not handle Claude Code's tools".
- **Exact ids only.** No nicknames are stored on an agent.

**Where the list comes from (`daemon/src/session/models.ts`, new).** Two sources, since
neither is enough alone:
  - The model API's `GET {ANTHROPIC_BASE_URL}/v1/models` (paged, 20 s timeout) decides
    **what is offered**. It is the only list that knows a model was retired. The
    credential is `ANTHROPIC_AUTH_TOKEN` (Bearer) or `ANTHROPIC_API_KEY`, read from the
    environment and then from Claude Code's `settings.json` `env`, where Claude Code
    reads it. It is sent on that one request and never logged. A failed request
    reports only its status.
  - The SDK's `Query.supportedModels()` decides **what each model is called** and its
    effort levels, and what the tiers `opus | sonnet | haiku` resolve to now. Rows whose
    value is `default`, `best` or `opusplan` never label a model.
  - `combine()` is pure. Served ids are offered, and a `[1m]` variant is added when
    Claude Code offers one for a served base. A tier counts only when its resolved id is
    served. Without the gateway, Claude Code's list is offered with
    `source: 'claude-code'` and a note; with neither, `source: 'none'`.
  - `catalog()` caches for ten minutes and asks one question at a time. Two tabs opening
    Spawn start one Claude Code process. `known()` never asks.
  - `modelSources` is the one indirection. `session/verify.ts` replaces both sources
    before anything runs, so the suite cannot reach the network.

**wire.ts:** `MODEL_ALIASES` is replaced by `MODEL_NICKNAMES` (`default best opus sonnet
haiku opusplan`), `ModelTier`, `ModelOption {id, label, claude, effortLevels?}` and
`ModelCatalog {models, tiers, source, host?, note?, fetchedAt}`. `SetModelRequest.model` is
documented as an exact id.

**Routes (`routes/session.ts`):**
  - `GET /api/models[?fresh=1]` returns the `ModelCatalog`.
  - `POST /api/jobs` and `POST /api/agents/:id/model` pass through `refusal()`, which
    returns 400 `unknown model`. A nickname is always refused, saying what it means now
    if that is known. An id missing from the list is refused **only when the gateway
    itself gave the list**, naming the host and the served ids. Claude Code's list
    proves nothing about what is served, and no list proves nothing either.
  - `refusal()` uses `known()`, so validating never waits on a fetch. The picker that
    offers the ids has always fetched first.

**Web:**
  - `lib/models.ts` (new) has `useModels()`, shared per page, plus the pure words
    `shortModel`, `resolveTier`, `modelProblem`, `modelGroups` and `catalogLine`.
  - `shell/ui.tsx` `ModelSelect` is a grouped `<select>`. It always offers the agent's
    current value, marking it `· not served`, rather than showing something else.
  - Presets keep a **tier** per role (`spawn/presets.ts`: `PresetRole.model: ModelTier`,
    `TIER_HINTS`), because ids differ per deployment. This deviates on purpose from
    "presets pin ids". `toAgentSpecs(…, override, tiers)` resolves each tier at launch,
    so the agent stores the id.
  - `unresolvedTiers()` names a tier with no served id. Spawn blocks the launch and says
    so, and it waits for the list before launching at all.
  - The composer's model pills became `ModelSelect`. A nickname, or an id the gateway no
    longer serves, gets a `--fail` line saying what will happen.
  - `fleet/lane.tsx` uses `shortModel`, so `us.anthropic.claude-opus-5-5` reads as
    `opus-5-5` (`· 1M` for the 1M window).

**Not migrated:** agents that already store `opus` or `sonnet` keep running on what the
settings say. The composer warns about them; nothing rewrites a row.

**Also in this change:** `@anthropic-ai/claude-agent-sdk` moved to ^0.3.284 (bundled
Claude Code 2.1.284). The gateway refuses opus-5-5 from Claude Code older than 2.1.280.
This is a version bump, not a new dependency (§3).

**Verified:**
  - `session/verify.ts` §12 is rewritten for exact ids, nickname refusal, served-list
    refusal and a job naming a nickname. It also checks the catalog's order, labels, 1M
    variant, tiers and effort levels, that concurrent GETs make one ask, and the
    Claude Code and none fallbacks.
  - `spawn/verify.ts` §5 checks tiers resolved to ids, overrides and `unresolvedTiers`.
  - `lib/verify.ts` §14 checks `shortModel`, `modelProblem`, `modelGroups` and
    `catalogLine`.
  - Ten mutations were each caught: nicknames not refused; refusing on any list;
    labelling from `default`/`best`; asking twice; tiers ignoring what is served; the
    warning ignoring the source; `· 1M` dropped; tiers not resolved; the override
    ignored; nicknames not flagged.
  - `make test`: 9 PASS, exit 0.

### Amendment 39 — post-merge, applied. **A project is a list of directories, and Files shows only those.**

Asked for: "each project should have its own list of directories … when I go to the
Files, only those directories should show up. If I want other directories, I should add
those to the projects." Before this, a project was one path. Files showed whatever
jobs existed, across every project, so there was no way to say which folders belonged
to which work.

**Two choices, both made by the user:**
- **Agents work in the first directory and can reach all of them.** The first stays
  what `Project.path` always was: where jobs start and worktrees are cut, with
  isolation unchanged. The others go to the SDK as `additionalDirectories` and are
  edited in place, with no worktree.
- **Files: pick a project, then see its directories.** Picking a job as well adds its
  worktree.

**Removal touches no files** (the standing rule from Amendment 36). Removing a directory
deletes one row, and removing a project cascades to its rows. Neither calls
`WorkspaceService.close()` or `WorktreeMgr.remove()`.

- **Migration 050 `project_dirs`:** `(project_id, path, added_at)`, with primary key
  `(project_id, path)` and `ON DELETE CASCADE` from `projects`. The first directory is
  not a row; it stays `projects.path`.
- **wire.ts:** `Project.extraDirs?: string[]`, optional, in the order added.
- **Routes (`routes/session.ts`):** body types stay local, per Amendment 2.
  - `POST /api/projects/:projectId/dirs {path}` returns 201 `{project, existing:false}`,
    or 200 `{project, existing:true}` if the project already has the path, first
    directory included. `~` and bare names expand the way the completion list does
    (`workspace/browse.ts` `expand`). A missing path or a file gets 400.
  - `DELETE /api/projects/:projectId/dirs?path=` returns `{project}`. The first
    directory is refused with 400 and pointed at editing the path; so is a path the
    project doesn't have.
  - Both broadcast `entities` with the project.
  - `PATCH /api/projects/:id` with a `path` that is one of the others moves it to first
    and drops it from the others.
- **Reads (`routes/workspace.ts`):** `GET /api/projects/:projectId/dir/{tree,file,image,diff}?dir=<abs>[&path=]`
  and `PUT …/dir/file?dir=<abs>` are the job reads, pointed at a directory.
  - `WorkspaceService.dirRoot` returns 404 unless `dir` is one of the project's, and
    410 if it is no longer a directory.
  - Directories are named **by absolute path, not by index**. Removing one must not
    slide an open tab onto the next folder.
  - The record's key is `dir:<projectId>:<path>`. Project ids contain no colon, so the
    split is at the first colon after the prefix, and a path can contain colons.
  - No watcher: `#watcherFor` skips these keys. The Files screen has a ↻ instead.
- **git (`workspace/git.ts`):** a directory can be a folder inside a larger repo, which
  in-place projects already could be.
  - `status` porcelain paths are repo-root-relative, so `rev-parse --show-prefix` is
    stripped from them, and entries outside the folder are dropped.
  - `numstat` and `diff` use `--relative`.
- **Runner:** `RunnerScope.extraDirs` becomes `additionalDirectories`. The supervisor's
  `#reachable` passes the project's directories that still exist, except the worktree
  itself. A directory that has gone is left out; the run is not failed.
- **translate.ts:**
  - `relPath` returns an absolute path unchanged when it is outside the worktree, so
    `../../x` never appears.
  - `fileEditFromTool` emits nothing for those paths. A `file_edit` is
    worktree-relative by contract, and one for another directory would badge the wrong
    file.
- **Web, Files (`files/tabs.ts`, `route.tsx`, `useWorkspace.ts`):**
  - `Tab.jobId` is now a **root**: a job id, or `dirRoot(projectId, dir)`.
  - `FilesState.project` is new. `selectProject` and `inColumn` are new.
  - `rootEndpoint` picks the job or the dir URL.
  - Opening a directory tab of the project already shown keeps the chosen job; one
    from another project shows that project alone.
  - The column has a project picker, a job picker ("no job · the directories as they
    are"), then one `RootSection` per root, each with its own tree, count and ↻.
  - Deep links keep the `jobId` param, which can now carry a dir root.
- **Web, Fleet (`fleet/card.tsx`):** `… → ▤ directories…` lists the first directory
  ("agents start here") and the others. Removing one takes two steps, and the second
  says the folder is untouched. Adding one uses `usePathComplete` for completion.

Checks:
- Session verify §18 (32 checks):
  - validation, `existing`, the `entities` broadcast, `~`;
  - reads by `?dir=`, including 400 for a missing `dir`, 404 for another folder and 400
    for `../`;
  - a folder inside another repo counts and diffs only itself, by its own paths;
  - PUT;
  - `cwd` and `additionalDirectories`, with a missing directory left out;
  - 410 for a gone directory;
  - no `file_edit` outside the worktree;
  - the first-directory refusal and its wording;
  - removal leaves the disk alone; PATCH promotes; the project cascade.
- Files verify (17 checks): `dirRoot` round-trips, including a colon in the path;
  `rootEndpoint`; `selectProject`, `inColumn`, `selectJob(null)`; dir deep links;
  reload.

Twelve mutations were each caught:
- dropping the prefix strip;
- dropping `--relative`;
- dropping the membership check;
- dropping the exists filter;
- dropping the first-directory refusal (the check was tightened to read the message
  after this one first survived);
- dropping `additionalDirectories`;
- dropping the translate skip;
- dropping the PATCH promotion;
- dropping `~` expansion;
- `inColumn` ignoring the project;
- `column` dropping the job;
- `parseDirRoot` splitting at the last colon.

### Amendment 38 — post-merge, applied. **Conductor says which commit it is running, and when it was made.**

Conductor runs from source (`tsx`, `vite dev`), so there is no build artifact to stamp.
The build info is the checkout the daemon started from. That is the question it
answers: "is what I'm looking at the code I just changed?" Vite reloads on edit; the
daemon does not.

- **`daemon/src/build.ts`:** reads the following once at boot, with `git -C` this file's
  folder and never the process cwd:
  - the commit's short hash;
  - the branch (null when detached);
  - the committer date;
  - whether tracked files had changes (untracked ones don't count);
  - the root `package.json` version, the start time and the Node version.

  With no git, or outside a checkout, these are null and the daemon still boots.
- **`GET /api/build`:** in `routes/health.ts`, returns that record plus `head` (HEAD read
  again for each request) and `behind` (HEAD has moved since boot). It is not in the
  frozen `wire.ts`. `/api/health` is unchanged.
- **Web:**
  - `diagnostics/build.ts` holds the words (pure).
  - The status bar shows `branch@commit`, with `*` for changes, amber and `⚠` when
    `behind`. Its hover shows both dates. It is fetched every minute, and not shown in
    fixture mode.
  - Diagnostics has a **Build** section.
- **`make status`:** prints a `build` line, and a pointer to `make restart` when `behind`.

The web side has no separate stamp. Vite serves what is on disk, so its commit is
always HEAD, and a Vite `define` would only record when the dev server started.

Checks:
- Daemon smoke §8 (5 checks): the reported commit is `git rev-parse --short HEAD`,
  both dates parse, and it is not `behind`.
- Web verify §13 (9 checks): the tag forms, the date format, and the stale warning.

Two mutations were each caught: inverting the `behind` comparison, and dropping the `*`.

### Amendment 37 — post-merge, applied. **An agent that waited hears what the ones before it said.**

`dependsOn` used to control timing only. A reviewer started once the builder was
`done`, with the job prompt and its own brief, and found the builder's work only
because they share a worktree (§7). The files reached it. What the builder said about
them did not: the cause a debugger found, or the tests a validator saw fail. The
bug-fix preset's builder brief ("Fix the root cause the debugger identified") pointed
at something it was never shown.

- **What is passed on:** each upstream agent's final reply, which is its last `text`
  event. The working notes before it are not passed on. An agent that finished without
  writing prose is said to have done so, rather than left out.
- **Where it goes:** `#promptFor` in `supervisor.ts` builds the prompt as job prompt,
  handoff, then brief. The brief comes last so "the work described above" has something
  above it. The wording is in `session/handoff.ts`, which is pure. A reply longer than
  `HANDOFF_CAP` (8,000 characters) is cut, and the cut says how long the reply was.
- **When:** at launch only. A resume continues a session that already has it. It is
  part of the launch prompt, so the transcript's first turn shows exactly what the
  agent was told.
- `EventLog.lastText(agentId)` reads it. That keeps the query in the file that owns
  `events`.
- There is no switch for it. A per-agent option would mean a field on `AgentSpec` in the
  frozen `wire.ts`. An agent with no dependencies is told nothing extra.

`session/verify.ts` §17 has 7 checks:
- It hears the last reply and not the working notes.
- A silent upstream agent is named as silent.
- The order is job, handoff, brief.
- The transcript shows the prompt.
- An agent with no dependencies gets the plain prompt.
- A long reply is cut.

Two mutations were each caught: dropping the handoff from the prompt, and reading the
first reply instead of the last. §17's first run also showed that §15 hands
`sdk.query` back to the real SDK, so §17 installs the fake itself.

### Amendment 36 — post-merge, applied. **A cleanup button for the event log, and "+ add another project…".**

Two answers from you.

**F8, event log retention: kept, with a button to clear it.** Removal still keeps events
(store.ts `deleteProject`): removing something is not a decision about the record. But
nothing can show those events afterwards, and in the live database they were 979 of
1,010. So clearing them is offered as its own decision. **Diagnostics (`0`) → Storage**
shows the database path, its size, and how many events are left over.
**⌫ clean up** asks first, then deletes them.

- **What counts as left over:** an event whose job or agent no longer exists. Removing a
  project removes its jobs, so that is covered. `project_id` is deliberately not
  tested: a dev server's event can carry an empty one while its job is live.
- **What stays:** every event anything can still open, `cost_daily` (the money was
  spent), and everything on disk.
- **The one exception to append-only (§5.2), and why cursors survive it.** `events.seq`
  is AUTOINCREMENT, so a deleted seq is never handed out again. Every later event still
  sorts after any cursor a client holds. `head()` can go down after a cleanup, and
  that is harmless for the same reason.
- `EventLog.storage()` and `EventLog.pruneOrphans()` live in `eventlog.ts`, the only
  file allowed to write `events`. They run `VACUUM` afterwards, so the file shrinks.
  The routes are `GET /api/storage` and `POST /api/storage/cleanup` in
  `routes/health.ts`. Running cleanup twice is harmless. As with `routes/fs.ts`, the
  response types are not added to `wire.ts`.
- The token stays opt-in, as PLAN.md I5 intends. That was F8's other half, unchanged.

**The projects report.** You removed Architecture-Work with × and then added the
new folder. You had read "+ different project…" as "instead of this one". It is now
"+ add another project…", with a title saying the projects above stay.

`session/verify.ts` §16 has 11 checks, all through the HTTP routes:
- A removed job's events and a removed agent's events go.
- A live agent's transcript stays, and so does a live job's event that has an empty
  `project_id`.
- Spend history stays.
- A new event after cleanup gets a seq above the old head.
- A second cleanup removes nothing.

`lib/verify.ts` §12 checks the wording. Three mutations were each caught: testing
`project_id`, dropping the agent clause, and offering the button with nothing to clear.
§16's first run also caught a fixture named `agt_gone` that collided with a live agent
from §12. Not click-tested in a browser.

### Amendment 35 — post-merge, applied. **An agent can be put to sleep and woken later.**

A TODO.md item. There was no new status to add: **⏸ pause** already stopped a run and
kept the SDK session, and **▶ resume** already went back into it. Sleep is pause,
made to keep its promises. Four things were wrong with it:

- **Pause threw away a pending question.** It called `cancelForAgent`, which expired
  the request. Now a *blocked* agent keeps its question. A held request is parked
  (`Arbiter.parkForAgent`), which stops the run and frees the slot. A parked one is
  asleep already. The agent stays blocked in Needs You, and answering is what wakes
  it. Pausing it again changes nothing.
- **Resume ignored the slot limit.** It launched through `#launchWithPrompt`, which
  never looks at `TOTAL_SLOTS`. Now a woken agent is `queued`, and `pump()` starts it
  when a slot is free, the same way as any launch.
- **A woken agent in a paused job never started.** `pump()` skips paused jobs, so
  that agent stayed queued for good. Waking or answering now reopens a paused, failed
  or done job to `working` (`#reopenJob`). `resumeParked` does the same when slots
  are full.
- **A tool call cut short read "running…" forever.** `runner.stop()` (pause or
  terminate) now closes every call still open with `tool_end {ok:false, summary:
  'stopped before it finished'}` (`CUT_SHORT`). The exception is a call waiting on a
  request: it is still open, and its answer comes later.

**What it's told on waking.** `WAKE_NUDGE` replaces `CONTINUE_NUDGE`. It says the agent
was paused, and that a tool call running at the time was stopped, so it should check
what that call did. A queued agent that was *answered* gets `RESUME_NUDGE`. Which
nudge applies is read from the database (`answeredSinceLastRun`: an answer after the
last run started), so it is still right after a daemon restart.

**On screen.** `agent/sleep.ts` decides the pause and resume button's label and title.
Pause says it frees the slot and keeps the conversation. For a blocked agent it says
the question is kept and answering wakes it. Resume says it may wait for a slot.

Known gaps, not fixed:
- Sending a message to a paused agent still resumes it directly, past the slot
  limit.
- A call `canUseTool` denied has no `tool_end` of its own, because
  `PostToolUseFailure` isn't hooked. If the agent is then stopped, that call reads
  "stopped before it finished".

`session/verify.ts` §15 checks, with 20 checks:
- A working agent is paused mid-call: the slot is freed, the session is kept and the
  call is closed.
- A wake with every slot full queues, reopens its job, and starts when a slot frees.
- A blocked agent keeps its question through a pause, and answering wakes it in the
  same session.

`agent/verify.ts` §8 checks the button's wording. Five mutations on the daemon side
and one on the web side were each caught. Not click-tested in a browser.

### Amendment 34 — post-merge, applied. **The other side panels and docks drag to size.**

A TODO.md item. The Files tree (F17) and the Agent composer (Amendment 25) already
dragged. Five more panels were a fixed size, and each now has a `Splitter` on its
inner edge:

| Panel | Edge | Was | Min | Max | Key |
|---|---|---|---|---|---|
| Agent inspector `.ag-insp` | left | 246px | 200 | 40% of width | `conductor.agentInspectorW` |
| Needs you queue `.atn-insp` | left | 252px | 200 | 40% of width | `conductor.queuePanelW` |
| Project column `.pj-col` | right | `--projcol` (288px) | 200 | 40% of width | `conductor.projectColW` |
| Project dock `.pj-dock` | top | 236px | 120 | 70% of height | `conductor.projectDockH` |
| Preview dock `.pv-dock` | top | 178px | 100 | 70% of height | `conductor.previewDockH` |

- **One rule, in `shell/panels.ts`**, the Files tree's rule (`files/width.ts`)
  generalised: the size you asked for is kept, and what's drawn is that fitted to the
  window now, so a size saved on a big monitor can't crowd a laptop and is back on the
  big monitor. `usePanel(panel)` returns the drawn size and the Splitter's props.
  Double-click resets to the old fixed size, which stays in the CSS as the size before
  the first render. Malformed or missing storage is the old size.
- **The splitter draws the edge.** Each panel's own border on that side is removed,
  so there is one line, not two, 3px apart.
- Not made resizable: the rail, top bar and status bar (chrome, sized to their
  contents), the lanes (fluid grids), Diagnostics (one column), and popovers.
- The Files tree and composer keep their own code. Moving them onto `panels.ts` would
  change nothing you can see, and their keys would have to stay the same.

`lib/verify.ts` §10b checks each panel: it starts at its old size, stops at its
minimum and maximum, reads storage back, has a CSS size that matches its fallback, has
no second border, and has a Splitter that drags the right way. It also checks that no
two panels share a key. Not click-tested in a browser. Dragging the Preview dock across
the embedded iframe relies on pointer capture reaching the handle over an iframe.

### Amendment 33 — post-merge, applied. **Every reply folds to one line, and folds are kept.**

A TODO.md item. Tool calls fold to one line (Amendment 25). A reply only got a fold
control when it was over 1,200 characters or 20 lines (`foldable` in
`agent/markdown.tsx`), collapsed to an 8-line fade, and forgot the fold when you left.

- **Every agent turn folds.** Its role label is the toggle, with `⌃`/`⌄` under the
  name, the same chevrons a tool row uses. Folded, the turn is one line:
  `foldLine(prose)`, its first line of prose with the markdown that only means
  something rendered stripped (`**not** safe` reads `not safe`), and a count such as
  `12 lines · 3 tool calls · 1 ask`. The line can be clicked to unfold. Nothing is
  truncated inside rendered markdown, so a fold can't cut a code block. `foldable`,
  its thresholds and `.ag-clamp` are gone.
- **Replies still start open (Amendment 18).** What's stored is the set you folded,
  never a default.
- **⌃ fold all / ⌄ unfold all** in the Agent header folds the replies there are now.
  A reply that arrives afterwards is output you haven't read, and arrives open. The
  label reads unfold all once every reply is folded.
- **Kept per agent** in `agent/folds.ts`, in localStorage under `conductor.agentFolds`,
  by turn key (`a${seq}`, from the event log, so stable across reloads). Bounded like
  the Files tabs: 500 folds per agent, oldest dropped first, and 40 agents, the one
  looked at least recently dropped first. Malformed storage is no folds.
- `buildTranscript` now runs in `agent.tsx`, which passes `turns` to `<Transcript>`,
  because fold all needs the reply keys too.

`agent/verify.ts` §4 replaces the threshold checks with the store's rules: folds are
per agent, fold all doesn't reach a later reply, bounds and recency, reload and
malformed storage, `foldLine`, and that fold all skips your turns. Not click-tested in
a browser.

### Amendment 32 — post-merge, applied. **Rendered markdown fills the pane, and prints as a PDF.**

Two TODO.md items for the Files pane.

**Width.** `.c5-md` was capped at `max-width: 720px`, so on a wide window a file sat in a
narrow column beside empty space, and tables and code blocks scrolled sideways inside it.
It now fills the pane. The old measure is `.c5-md.column`, switched by **¶ column** in
the pane head (rendered view only). It's one setting for every file, in localStorage
under `conductor.files.column`, because it's about the screen, not the file.

**PDF.** **⎙ PDF** (rendered view only) calls `files/print.ts` `printRendered(el, path)`.
- It **copies the rendered element** into a `.c5-print` sheet at the end of `<body>`.
  The copy is of what's on screen: html the daemon sanitised, with links and images
  already rewritten by the pane (Amendment 31). Nothing is re-rendered and no markup
  is added, so the sanitizer is still the one thing to audit.
- `files.css` hides `.c5-print` on screen. Under `@media print` it hides every other
  child of `<body>` and shows only the sheet, with page-break rules for headings,
  tables, images and code. Code wraps rather than being cut off at the page edge.
- It waits for the copy's images to decode, sets `document.title` to the file name
  without its extension (`pdfTitle`, which browsers offer as the PDF's name), calls
  `window.print()`, and removes the sheet and restores the title on `afterprint`.
- The browser's print dialog makes the PDF. No new dependencies (§3).

**Paper is light.** The sheet carries `data-theme='light'`. `tokens.css` now declares the
light block as `:root[data-theme='light'], [data-theme='light']`, so any element can ask
for the light tokens for its subtree. Before, only `<html>` could. That keeps print
colours as tokens (F5) rather than a second, literal palette. `lib/verify.ts` reads the
block by the new selector.

`files/verify.ts` "printing a rendered file" checks the PDF name, that print shows only
the sheet, that the sheet never shows on screen, and the token selector. Reverting the
selector fails it here and in `lib/verify.ts`. Not click-tested in a browser.

### Amendment 31 — post-merge, applied. **A link from one markdown file to another opened a blank tab.**

Report: viewing `API-Gateway/internal-api-gateway-vs-istio-ingress.md` in Files,
clicking a link to `Service-Mesh/learnings-service-mesh.md` opened
`localhost:5173/Service-Mesh/learnings-service-mesh.md`, not the file.

**The cause.** `workspace/markdown.ts` keeps a relative href as written, and gives every
`<a>` `target="_blank"`. Its comment said such links "just don't resolve to anything the
browser can fetch, which is honest". In the browser, they resolve against the app's URL,
not the file's folder, so the link opened a new tab of the dev server. A relative
`<img src>` failed the same way: it asked the dev server for the image, not the daemon.

**The fix is in the pane, not the sanitizer.**

- **`files/links.ts` (new, pure)** — `resolveDocLink(href, from, has?)` answers `file`
  (a worktree-relative path), `anchor`, `external` or `none`.
  - A relative href resolves against the folder of the file being shown. A leading `/`
    is the repo root, as on GitHub.
  - Query and fragment are dropped from a file link. Segments are percent-decoded,
    because marked encodes the href: `my%20notes.md` is `my notes.md` on disk. A decoded
    `/` or `\` makes it `none`, so `..%2F` is not a way into another folder.
  - Climbing out of the worktree is `none`. So are protocol-relative hrefs and
    backslashes. `http:`, `https:` and `mailto:` are `external`.
  - **One fallback, only with a tree:** if the file's folder has no such file and the
    repo root does, the root's is used. Agents often write `Service-Mesh/b.md` from
    `API-Gateway/a.md` meaning the repo's folder. The file's folder still wins when it
    has the file. Without a tree, or with neither, the file's folder is the answer, and
    Files' unavailable pane says the file isn't there.
  - `headingSlugs(texts)` gives GitHub's slugs, with repeats numbered `-1`, `-2`.
- **`FilePane`**, after the sanitized html mounts, in a layout effect:
  - rewrites a file link's `href` to the Files deep link (`#files?jobId=…&path=…`) and
    drops its `target`, so hover shows the real target and Cmd-click opens it in a new
    browser tab;
  - removes the `href` of a `none` link;
  - points a relative image at the daemon's image route (Amendment 25);
  - keeps the document's own href in `data-doc`, so a re-run starts from what the file
    wrote, not from the last rewrite.
  - A plain click on a file link calls `navigate()`, which re-notifies on the same
    target, so a link to a tab already open still brings it forward. A `#section` link
    scrolls to the heading with that slug, and the app's hash is left alone. External
    links are untouched.
- **`files/route.tsx`** passes `has`, the tree's lookup of files, to the pane.

**Why the sanitizer is still the only thing to audit.** The pane changes only `href`,
`src`, `target`, `title` and `data-doc` on elements the sanitizer already let through,
and every value it writes is its own: a hash URL, the image route, or nothing. It adds
no markup. Heading ids stay stripped, because an element id is also a global name the
page's scripts can trip over, so `#section` is matched by slug when the link is clicked.

**Left alone:** a link to a folder opens a tab that says the path is a directory. It
does not open the folder in the tree.

`files/verify.ts` "links inside a rendered file" covers the report's case, both
fallback directions, a leading slash, query and fragment, escapes, climbing out, the
web, and slugs. Resolving against the repo root instead of the file's folder fails 7 of
its checks. Dropping the decoded-separator guard fails 1.

### Amendment 30 — post-merge, applied. **An agent failed `tool_deferred_unavailable` on every message, for good.**

Report: "I keep getting this error: failed — tool_deferred_unavailable". It came from an
agent working with the Lucid MCP server. Every message sent to it failed at once, with 0
tokens.

**The cause took three steps, and the first is ours.**

- **The arbiter deferred an MCP call.** PreToolUse's case 2 re-parks a call that matches
  an open request, by `toolUseId` **or by tool name**. A Lucid call was waiting for the
  human, and the model made a parallel call to a Lucid tool. That call matched by name
  and was deferred alongside it.
- **The SDK can't resume a deferred MCP call.** On resume, the CLI (SDK 0.3.278) finds
  the deferred call in the session file: the newest `hook_deferred_tool` entry with no
  result after it. It then checks that the call's tool exists before anything else, and
  it doesn't wait for MCP servers to reconnect. So the run ends
  `tool_deferred_unavailable`, `is_error`, with 0 tokens and the call in
  `deferred_tool_use`.
- **Nothing ever gives that call a result.** So every resume after that finds it again
  and fails the same way, whatever is sent.

**And one bug of ours made every resume after a defer send nothing.**
`lastDeferredTool` returned the newest deferred call from any run, not just the last
one. So one defer, ever, made every later resume look like a defer. Those resume with
no prompt, and a session with nothing re-offered and nothing sent waits forever.

**Three fixes:**

- **An MCP call behind a waiting one is declined, never deferred.** `preToolUse` case 2
  returns `deny` with a reason: "a … call is waiting for the human's decision. Make this
  call again once that one has been answered." That costs the model one retry. Built-in
  tools are still re-parked, because they always exist on resume.
- **A run that ends `tool_deferred_unavailable` is moved past the call, once.**
  - `AgentRunner.run()` forks the session with `forkSession(…, { upToMessageId })`. The
    fork ends at the entry just before the reply that made the call. One API reply is
    stored as several entries (thinking, text, each `tool_use`) that share `message.id`,
    and all of them are cut, because half a reply is nothing to resume from.
  - The fork is run once with a note. The note spells out the lost call, with its input
    capped at 1500 characters. It also says what the human decided, read from the
    arbiter's staged decision, because the resume that carried the decision never ran.
  - If the human sent the message, their words go again after the note, and the
    `user_text` event logs only the note, as `synthetic`. A resume prompt of Conductor's
    is replaced by the note: the supervisor now passes `synthetic: true` for resume
    prompts, which also labels them `auto` in the transcript.
  - The agent carries on from the fork, and the original session file is left as it is.
  - If the fork fails the same way, or no fork can be made (the call isn't in the file,
    or nothing comes before it), the agent fails. Its detail reads "stuck on a … call
    that can no longer be made, and could not be moved past it".
  - The runner's `sdk` seam gains `getSessionMessages` and `forkSession`, so verify can
    fake the session file.
- **`lastDeferredTool` reads only the agent's last run**, and returns its call only if
  that run ended `tool_deferred`. The tie-break is `rowid`, because `started_at` has
  millisecond resolution.

**An agent already wedged this way recovers the same way: send it a message.** No wire
shape changed.

**Two things were left alone:**

- `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` exists in the CLI. Nothing here shows that it runs
  before the deferred-tool check, so the fix doesn't rely on it.
- Case 1 applies a staged decision to the next call of the same tool name, not the same
  `toolUseId`. A built-in sibling can therefore receive a decision meant for another
  call. That was true before this amendment and is unchanged.

`session/verify.ts` §14 covers the fork (where the cut falls, the note, what is logged,
and the session afterwards), a single retry, the failure when no fork can be made,
answering a parked request with a sibling deferred behind it, the MCP decline, and
`lastDeferredTool`. I reverted each of the three fixes in turn to confirm that its
checks fail.

### Amendment 29 — post-merge, applied. **A file clicked in a transcript flashed and didn't open, and Files forgot where you were.**

Two reports: "when I click on a file to open it in the file viewer, it just flashes but
no file shows up", from a file name in the Agent transcript (Amendment 25's links), and
"I was in the file tab, went to the agent tab, and when I came back it had lost
context".

**The flash had three causes, and fixing any one alone left it flashing for some files.**

- **Markdown with a nested list or a fence inside a tight list item returned a 500.**
  `workspace/markdown.ts`'s `listitem` renderer passed an item's tokens to
  `parseInline`. Those tokens are block tokens even when the item is tight, so a
  nested list made it throw. The renderer now calls `parser.parse(tokens, loose)`, as
  marked's default does. Tight means no `<p>`; it doesn't mean inline-only.
- **A file the tree listed could be a 404.** The tree keeps a deleted path, because a
  deletion is a change to review. So a file an agent removed was clickable and then
  couldn't be read. `#goneFile` now opens git's last copy through `storedCopy`, which
  tries the index and then HEAD, and `readBlob` (`cat-file`, so no textconv runs). The
  response is marked **`FileContentResponse.deleted`**, and the tree marks the path with
  **`FileNode.change.deleted`**. Both are optional, so older readers are unaffected.
  The pane shows a banner and no edit button, because this isn't the file on disk.
  `image()` still reads only the disk, so a deleted image returns a 404 and the pane
  shows a banner in its place. A dangling symlink now returns a 404 that names its
  target.
- **The jobId race.** The deep link set the job, and then the default-job effect,
  still holding the null job from its closure, replaced it with the first job in the
  list. That swapped in a different file and changed the job back. The default is now
  applied inside `update()` against the store's current state, so it only fills a job
  that is still unset.

A tab that can't be read still doesn't blank out. The `Unavailable` pane says why,
picked by status (404, 413, 415, 5xx, or no reply from the daemon), and offers **retry**
and **close tab**.

**Losing your place came from `main.tsx`, which renders only the active screen.**
Anything Files kept in React state was unmounted when you left. The fix is **tabs**
across jobs, held outside React:

- `files/tabs.ts` holds the rules as pure functions: `openTab`, `closeTab`, `activate`,
  `selectJob`, `applyLink`, `setView`, `setScroll` and `toggleFolder`. `closeTab`
  falls back to the most recently used tab. `openTab` evicts past `MAX_TABS` (24) but
  never a tab with unsaved work. The invariant: **the active tab's job is always the
  selected job.**
- `files/useTabs.ts` is a module-level store (`useSyncExternalStore`). A debounced
  write saves it to **`localStorage["conductor.filesTabs"]`**, and `pagehide` flushes
  the write. `parseState` validates what it reads back, and bad data gives `EMPTY`
  rather than an error. It saves the tabs, each tab's view and scroll per view, and
  the folders you opened or closed.
- **Unsaved edits are kept in memory only.** They survive switching tabs and screens,
  but not a reload. A draft restored hours later against a file an agent has since
  rewritten is a worse surprise than the browser's "leave site?" prompt, which
  `beforeunload` raises when anything is dirty. Closing a dirty tab asks first, as a
  two-step in the tab bar (`TabStrip.tsx`), not a modal.
- **A reload doesn't re-follow the link it loaded at.** The URL still holds
  `#files?jobId=…&path=…` from whenever you last clicked. Re-following it would pull
  that tab back in front of the one you moved on to. `bootLink` skips a link equal to
  the saved `link` on first mount only. Any later navigation follows links again,
  including one to the same target (`lib/nav.ts` re-notifies for those).
- `writeFile` puts the saved response into the file cache. Without that, a tab you
  switched back to showed the text from before your save until its refetch landed.

`files/verify.ts` covers the pure rules, and `make test` now runs it. In
`workspace/verify.ts`, the markdown checks cover nested and loose list items. §8b covers
deleted reads: the HEAD copy, the index copy and the dangling link.

### Amendment 27 — post-merge, applied. **A reloaded tab had every agent's cost and none of its transcript.**

Reported as "I left the Agent page and when I returned there is no transcript, but it
shows $6.44 spent". The cost is on the `Agent` entity, which the snapshot carries. The
transcript is events, which **the snapshot never carried and the feed only replays for a
cursor the tab already holds**. A fresh subscribe (`since: 0`) gets `hello` and nothing
before it. So the store only ever held events that arrived while that tab was open. A
reload, a reopened tab, or an HMR reload of `store.ts` (a commit landing in the
worktree while you're watching is enough) emptied every transcript, the Fleet card's
current action and elapsed time, and the job diffstat. `GET /api/agents/:id/events`
was written for this ("transcript backfill for a deep link") and nothing called it.

The event hooks (`useAgentEvents`, `useJobEvents`, `useJobDiffstat`) now call
`store.backfill()`, which fetches `/api/agents/:id/events` or `/api/jobs/:id` once per id
per snapshot. The fetch waits for the first snapshot, so a deep link doesn't fetch twice,
and it is skipped in fixture mode. `store.applyHistory()` merges the result by `seq`:

- **It does not move `seq` and does not fold payloads.** The seq gate is the feed's
  idempotence guarantee (Amendment 7), and the snapshot's entities are already newer
  than any history.
- **The live path became `appendBySeq`.** History can already hold an event the feed
  hasn't delivered yet. Then the event still passes the gate and folds, but it isn't
  appended a second time. Nearly every call is still a plain append.
- **Each `hello` bumps `generation`**, so a resync fetches history again for whatever is
  on screen.

`lib/verify.ts` §8 covers both arrival orders, the gate, the fold and array identity.

### Amendment 26 — post-merge, applied. **Two defects in Amendment 25, both found by using it once.**

**1. `add` silently selected a different project than the one being typed.**
`createProject` deduped on path — correct, `projects.path` is `UNIQUE` — and returned
the existing row **indistinguishably from a fresh create**. So adding a folder you
already had selected the old project and said nothing, which on screen is the picker
filling itself with a directory you did not type. Reported as exactly that.

The fix is not to stop deduping. `createProject` now returns `{ project, existing }`,
the route answers **200 for "you already had this" and 201 for "made you one"**, and the
picker says which. **A silent no-op is worse than a refusal** — a refusal tells you what
happened, and this told you nothing while appearing to do something wrong.

**2. Removal goes back into the `where` picker, alongside the Fleet card.**
Amendment 25 consolidated it onto the card and was wrong about the case that produces
most removals: a path mistyped ten seconds ago, in the list in front of you, while
setting up the job you came for. Sending someone to another screen to undo a typo made
on this one is the defect Amendment 17 was filed for, reintroduced by tidying.

So `spawn/endpoints.ts` and the row `×` are back, and the Fleet card keeps its `…`.
**The duplication is the feature**: removal belongs everywhere a project is listed,
because every list is somewhere you can notice the list is wrong. What Amendment 25 got
right was the Project screen — a sidebar button on a screen you reach *after* choosing
the project is the one place nobody looks — and that stays deleted.

**3. The card menu was clipped by the scroll container.** Reported as "edit project on
the top card goes under the menu bar". Not z-index: the grid lives in `.fl-panebody`
(`overflow-y: auto`) inside `.fl-pane` (`overflow: hidden`), and **overflow clips a
descendant regardless of stacking**. An absolutely-positioned menu opening upward from
the top row was simply cut off.

Now `position: fixed` with coordinates measured from the trigger's rect, re-measured on
scroll (capture phase — the scroll is on `.fl-panebody`, not `window`) and on resize.
It still prefers opening upward, because the action row is the last thing in the card
and downward covers the next one; it flips when there is no room above, and clamps to
the viewport when there is room in neither, since a fixed panel hanging past the bottom
cannot be scrolled to.

**Follow-up: `fixed` alone did not fix it — the menu then never appeared at all.**
`.fl-card:hover` sets `transform: translateY(-1px)`, and a transformed ancestor becomes
the containing block for `position: fixed`. The trigger lives inside the card, so the
card is always hovered while you click it: the viewport-derived coordinates were applied
relative to the card and the menu landed outside its box, clipped by the card's own
`overflow: hidden`. The menu and both panels are now portalled to `<body>`. The
outside-click check covers the trigger's wrapper and the portal root, and the portal
root stops `click`/`keydown` propagation, because React events bubble through a portal
to the card's navigating `onClick` even though the DOM nodes are elsewhere.

### Amendment 25 — post-merge, applied. **Six UI changes from one session of using it.**

All six came from the same complaint shape: the thing you need is on a different screen
from the moment you need it. Grouped because they were reported together, not because
they share an implementation.

**1. Project delete and edit move onto the Fleet card, behind `…`.** Removal had spread
to three places — the Project screen (Amendment 11), the Spawn picker (Amendment 17), and
neither was where people look. It is now one: `fleet/card.tsx`, on the card you were
already reading. The Project-screen button and the Spawn `×` are gone, along with
`spawn/endpoints.ts`.

The success notice CANNOT live on the card. A removed project leaves the snapshot and
takes its card with it, so `keptLine` moved up to `fleet.tsx`, which survives — the same
hoist the Project screen needed, one level further out.

**2. Editing a project: `PATCH /api/projects/:projectId`, name and path.** Path is
editable, which is a product decision with a cost: `projects.path` is the row's natural
key and the value worktrees were cut relative to, so changing it migrates **nothing** —
`jobs.worktree_path`, `workspaces.repo_path` and the directories on disk all keep
pointing where they pointed. A project with history ends up naming one directory while
its history describes another. The daemon does not refuse this; the panel says it, in
amber, only when jobs exist. **The right place for a consequence the code allows is the
sentence next to the button, not a comment.**

Two refusals, because both reach the user as something worse by default: a path that does
not exist (else it fails later, at launch, with a message about git), and a path another
project already holds (else the `UNIQUE` constraint surfaces as a raw
`SQLITE_CONSTRAINT`). `defaultBranch` is deliberately NOT editable — nothing reads it, and
a field the UI can set but no code consults is worse than one it cannot.

**3. Tool calls collapse by default, diffs included.** Reverses the half of Amendment 18
that opened diffs automatically. That was right for a turn with one edit and wrong for the
runs that happen, where a dozen diffs push the agent's prose — the thing you were reading —
off the screen. Amendment 18's prose fold stays default-open: **mechanics hide, output does
not.**

**4. The composer is resizable.** It grew a mode row and a guardrail row while keeping a
fixed height, so the pane you type into had the least room. A 7px handle sets a height in
px, the transcript takes what is left because it is the part that scrolls, and the height
persists in `localStorage` because this screen remounts on every navigation. Pointer
capture rather than window listeners, so a fast drag that outruns the cursor still tracks;
arrow keys do the same job for a keyboard.

**5. Guardrails on a live agent: allow bash / write / web / git push.** Previously only
shell was reachable here, so an agent launched read-only stayed read-only for life and the
way to let it write was to kill the job. Phrased `allow X` to match Spawn — the two
framings sat on opposite sides of one screen, and a pill that lights for the safe state in
one place and the permissive state in the other is a trap.

**Two axes, and the difference is what each toggle can promise.** `allowedTools`
auto-approves before `canUseTool` is consulted, so OFF means *ask me*, not *refuse*.
`disallowedTools` removes the tool from the agent and survives every permission mode
including bypass, so OFF there means *cannot*. Writes and web take the deny axis, because
"cannot write" has to hold under bypass. Shell takes the allow axis, because an agent that
cannot run `git log` cannot explain anything.

Amber marks the **restricted** state, not the pill being on (§5.1: `--need` means a human
is required, which is true when a guard is off and every command lands in your queue).

**6. Images render in the Files pane.** `GET /api/jobs/:jobId/image` serves bytes; the
pane renders `<img>` and skips the text fetch entirely, since an image has no diff, no
editor and no markdown.

**An extension allowlist, not a binary sniff.** `looksBinary` returning true says only
that a file is not text — a route keyed on that serves anything, which is how "view
images" becomes "download any file". Containment is `resolveForRead`, the same gate text
uses, because this route reaches the filesystem and does not get its own implementation of
the rule. SVG is included (agents write diagrams) with `nosniff` and a null CSP, so
script-in-XML is neutralized rather than trusted. The revision rides in the URL as a
cache-buster: `no-store` does not make an `<img>` re-request an unchanged `src`, so
without it an overwritten screenshot stays on screen.

### Amendment 24 — post-merge, applied. **A hard kill left agents working forever, and `make clean` never cleaned.**

Prompted by a plain question — "if I quit or reboot, does it remember?" — which turned out to
have two wrong answers in the code.

**1. No startup reconciliation.** Everything is in SQLite, so a restart genuinely remembers
projects, jobs, agents, transcripts, open requests, rules and spend. What it cannot remember
is processes. A **graceful** stop is fine: `SIGTERM` → `app.close()` → the `onClose` hook →
`sup.shutdown()`, and every runner settles itself. A **hard** kill — `kill -9`, an OOM, a
reboot, a closed lid — leaves the row untouched, still saying `working`. Nothing resumed it,
because `pump()` only ever takes `queued`; nothing noticed, because `isLive` is false. So it
sat in the one status the entire product reads as "leave it alone", permanently, and
`docs/MANUAL.md` had promised since I1 that "agents mid-work are stopped and resumable".

`Supervisor.reconcile()` now runs at init and moves those to `paused` with "the daemon
restarted mid-run" in the transcript — resumable for real, since `sdk_session_id` is stored.
It **must run after `arbiter().recoverOrphans()`**, which re-labels held requests as parked
and moves their agents to `blocked`: an agent that was working *and* owed an answer is that
function's to fix, and by the time reconcile runs its status is no longer `working`, so it is
left alone. The other order would pause an agent that is answerable.

Worth noting what was already right: `recoverOrphans` has handled orphaned *requests* since
I5. The gap was agents with **no** open request — the case where nothing else had a reason to
look at the row. I nearly shipped a duplicate of `recoverOrphans` before reading it.

**2. `make clean` deleted the wrong file, and said it had worked.** The daemon runs with
`cwd=packages/daemon`, so `openDb`'s default `'conductor.db'` resolves to
`packages/daemon/conductor.db` — 500 KB, with a 4 MB WAL. `clean` removed `./conductor.db`
from the repo root, which only ever held a stray empty file created by something run from
there, then printed "db and logs removed". Anyone who used it to get back to a clean slate
kept every project they thought they had deleted. Now removes both paths, with the real one
in a `DB` variable so it cannot drift from the daemon's cwd unnoticed.

Seven checks in `session/verify.ts` §5, including the two negatives that matter: a `queued`
agent is left for `pump` rather than paused, and a finished one is not disturbed — a
reconciler that over-reaches is worse than one that does nothing.

### Amendment 23 — post-merge, applied. **`Bash(git push:*)` is not `Bash`.**

The inspector reported **bash: denied** for an agent that could run bash all day. Spotted by
a user reading the Guardrails panel against an agent that was plainly running shell commands.

`toolPolicy` matched `disallowedTools` with a prefix test:

```ts
const matches = (rule: string) => rule === tool || rule.startsWith(`${tool}(`);
if (autonomy.disallowedTools.some(matches)) return 'denied';
```

The "never push" default — on by default since the mockup — always puts
`Bash(git push:*)` in `disallowedTools`. That rule constrains ONE command; the prefix test
read it as the whole tool being off. So every agent in the product, under the default
settings, was reported as unable to use bash.

The same test was wrong in the other direction too: a scoped **allow** like `Bash(ls:*)`
auto-approves one pattern and leaves the rest asking, and would have been reported as the
whole tool being allowed.

`namesWholeTool` now matches only an exact rule, and scoped rules are returned separately by
`scopedRules` for the caller to render as the exceptions they are — the inspector shows
`asks · 1 denied rule`. **Folding a qualifier into a headline produces a confident one-word
answer that is wrong**, which on a panel whose entire job is "what may this agent do" is the
worst available failure.

Worth noting what made this survive: the logic was right about the thing it was written to
be careful about. Its doc comment correctly said `disallowedTools` "survives every
permission mode — it is the real safety net", and the codebase says so in four other places.
Being right about the important distinction (`allowedTools` absence means *asks*, not
*denied*) is no protection against being wrong about a narrower one two lines later.

Eight checks in `spawn/verify.ts` §6, including both directions of the bare/scoped split and
that bypass still cannot override a bare deny. Two of them fail with the prefix test
restored — confirmed.

### Amendment 22 — post-merge, applied. **A removed job came back as a project that had never existed.**

`DELETE /api/projects/:id` answered `no such project` for a project plainly on screen. The
project was genuinely gone; what was on screen was a **synthetic** one, and Amendment 21
created it.

`workspaces` has **no foreign key to `jobs`** — deliberately, it is Track C's table — so
`deleteJob` deleting the job row orphaned the workspace row. Track C's snapshot contributor
then does exactly what it was designed to do: republish any workspace that no `jobs` row
describes as a synthetic job, plus a synthetic project named `basename(ws.repoPath)`. That
is correct behaviour for the bootstrap workspaces it was written for, and it meant a removed
job reappeared in every browser as a job nobody launched, inside a project that did not
exist, with nothing able to remove either — there was no row left to DELETE. The phantom
even wore a different name from the real project, which is the detail that identified it.

Two fixes, and the second is the one that matters:

1. **`deleteJob` cascades to Tracks C and D** — `workspace().forget(jobId)`,
   `registry.forgetJob`, `console.clear` — exactly as `deleteProject` already did. `forget`,
   not `close`, for the same reason: close runs `git worktree remove`.
2. **`deleteProject` now sweeps by PROJECT, not only by its current jobs.** The job loop
   can only reach jobs the project still has, so a job removed earlier had already left an
   orphan that survived the project removal. Sweeping `workspace().list()` for the project
   id closes the door rather than patching the latest way through it.

**The general lesson, and it is the fourth amendment to make a version of it:** a table with
no foreign key to the thing it describes needs an explicit cascade at every call site that
deletes that thing, and "every call site" grows each time someone adds a delete. Amendment
11 got this right for `deleteProject` and Amendment 21 reintroduced it for `deleteJob`,
because the cascade lives in prose and a method signature rather than in the schema.

Six checks in `session/verify.ts` §4, built around the one that was missing: cut a real
worktree for a job, remove the job, and assert the workspace row is gone, that the snapshot
does **not** contain a synthetic job for it, and that the worktree directory is still on
disk — removal forgets, it does not delete.

### Amendment 21 — post-merge, applied. **"I terminated it and it still hangs on."**

Amendment 19 shipped terminate and called the job done. It wasn't: terminate sets a status,
and the agent stays on screen reading `stopped` — correct while you still care what it did,
and useless once you don't. A finished project accumulated lanes nobody would look at
again, the terminate button stayed lit on agents that had already ended, and the only way
to clear anything was to remove the whole project. Reported in four words that named the
gap better than the design did.

**Terminate stops the work. Remove clears it away.** Two verbs, two stages of one
intention, and the UI now presents them as one button that changes meaning: `✕ terminate`
while the agent is running, `✕ remove` once it has ended. The dead control on an ended
agent was itself part of why "I terminated it and it still hangs on" was the obvious
conclusion.

- `DELETE /api/agents/:agentId` and `DELETE /api/jobs/:jobId` — a DELETE this time,
  because something really is deleted. `requests` and `agent_runs` cascade from the agent
  row, and agents cascade from the job row, so both are one statement.
- `deleteAgent` **terminates first, unconditionally**. A row deleted while its runner is
  mid-query would leave a process emitting events for an agent the database has never
  heard of.
- `resync`, not an entity push — the store's `#applyEvent` updates entities without
  creating them, so pushing a deleted agent could resurrect it in a tab that still had it.
  Same mechanism as `deleteProject`.
- The event log and `cost_daily` survive, and nothing on disk is touched. An orphaned
  transcript is a truer record than a hole.

**A second defect fell out of writing the test.** `terminateAgent` had no guard for an
agent that had already ended, so it re-emitted `status: stopped` every time — which meant
`deleteAgent` (terminating unconditionally) appended an event recording nothing, and worse,
terminating a **`done`** agent would have relabelled it `stopped`, rewriting what actually
happened to it. You cannot terminate something that already completed. Now idempotent
*and* quiet, via a shared `ENDED_STATUSES` set. Caught by a log-length assertion failing
`8 vs 7` — a one-event discrepancy that turned out to be a semantic bug.

**Job groups now open on arrival.** Amendment 19 collapsed ended jobs on the theory that
history should be out of the way. That was wrong in the case that actually happens: every
job in a finished project is ended, so the screen arrived fully collapsed and seeing your
own agents cost a click per job. Coming to the Project screen means wanting to see the
agents. The fold stays for when a group genuinely is in the way — a default, not a policy.

One process note, because it repeated: the new verify section initially deleted
`agt_builder` and `job_inplace`, which the project-removal sections below it still need, so
seven later checks failed for a reason that had nothing to do with the code. It now inserts
a `job_spare` of its own. **A verify that destroys its own later fixtures is a verify that
lies about where the bug is.**

### Amendment 20 — post-merge, applied. **A model override that leaves the default alone.**

The model was chosen per role by the preset and nowhere else — `opus` for roles that design
or judge, `sonnet` for roles executing a decided plan — with no way to say "all of this on
haiku" for a job that does not warrant opus anywhere, or the reverse for one that does.

Kept as an **override**, not converted into a setting. `toAgentSpecs` takes
`model: ModelAlias | null = null`, and null means each role keeps its own — so the
considered per-role assignment stays the default and the new control only ever replaces it
wholesale. Adding a fifth positional parameter rather than a new preset field, because the
choice belongs to a launch, not to a preset.

**Aliases, never pinned ids**, and the verify asserts it (`/^[a-z]+$/` on every offered id).
This is the reason `presets.ts` has always said `'opus'` instead of `'claude-opus-5'`: the
alias is what resolves across API, Bedrock and gateway deployments, where the exact id
differs. A model picker offering ids would work on the machine it was written on.

Two checks worth their line count: the override applies to **every** role rather than the
first (the bug a `.map` written in a hurry produces), and it disturbs nothing else — the
read-only roles' `disallowedTools` still deny `Write` afterwards, so changing the model
cannot quietly undo Amendment 15.

The plan preview renders `modelOverride ?? r.model`, so what the screen shows is what gets
sent. That mattered more than it sounds: without it the override would have been the one
thing on a screen whose entire stated promise is "no hidden translation" that you had to
take on trust.

### Amendment 19 — post-merge, applied. **Terminate, job grouping, and two bugs a second job exposed.**

A user launched the same preset twice and everything that assumed one job per project came
apart at once.

**1. `AgentStatus` gains `stopped`.** A widening of a frozen union, and the honest option.
There was no way to end an agent — only `interrupt` (resumable by design) and `pause`
(resumable by name). Terminating had to land on *some* status, and all six existing ones
lie about it: `done` claims it finished, `failed` claims it errored, `paused` claims you
might come back. A killed agent rendering green next to agents that completed is a lie the
whole UI then repeats, in the card stripe, the tag and the transcript note.

The union is closed, `agents.status` has no CHECK constraint, and the three
`Record<AgentStatus, …>` maps are exhaustive — so the compiler found every site that had
to decide what the new state looks like. `stopped` ranks above `done` and below `paused`:
nobody is waiting on it, but "someone cut this short" is the more informative of the two.
It settles a job like `paused` does and explicitly **does not** count as a failure, because
marking the job failed would put a red card on a decision.

`#settle` grew a guard: `terminateAgent` stops the runner and then writes `stopped`, so it
normally wins by ordering, but `stop()` resolving does not prove the run's async chain has
reached the settle — and a late settle would relabel a killed agent `done`.

**2. `cancelForAgent` never cancelled a parked request.** It walked `#held` only, which is
the in-memory map; a **parked** request has no entry there, because the query ended and the
DB row *is* the durable record — that is the whole point of parking. So pausing or
terminating a parked agent left its request open forever: a card in "Needs you" asking
permission for an agent that was never coming back to answer, and nothing in the product
could clear it. Reported as "I can't get rid of that entry", found by a verify check that
asserted the queue empties. This bug predates terminate and affected `pause` identically.

**3. Every message to a parked agent was logged twice.** `sendMessage` emitted `user_text`
and then handed the same text to `#launchWithPrompt`, whose runner emits it again on the
way in. A *live* agent took `runner.send` and emitted once, which is why nobody noticed:
only the resume path doubled. The runner is the single emitter now — the same rule Track C
settled on for file edits — with `synthetic` threaded through so a resume nudge still
renders as `auto` rather than as something you said.

**4. The Project screen assumed one job.** Lanes filtered on `projectId`, so two jobs
produced four lanes — two reading `analyst`, two reading `auditor` — distinguishable only
by status, which is the thing that changes. Meanwhile the facts column described
`primaryJob` alone, so half the lanes belonged to a worktree and branch the panel was not
showing. Lanes are now grouped per job under a header that names it, ended jobs collapse by
default, and **the facts follow the selected job** instead of a silent guess.

**5. "How much rope" had mixed polarity**, which the user named before I did.
"auto-accept edits" and "allow network" granted permission while "ask before bash" and
"never push" withheld it: two adjacent switches meaning opposite things by their labels. All
four now read "on means the agent may do it unattended", and the ⚠ follows the *state*
rather than being a static flag on a pill — it used to draw on "ask before bash" whether the
pill was on or off, so the glyph reserved for "a human is required" appeared on a setting
that, when off, required nobody. Plan mode left the row entirely: it is a mode, not a
permission, and it already had its own control.

**6. `effort` is exposed.** `Autonomy.effort` mirrors the SDK's `EffortLevel` and is
**optional**, so agents stored before the field existed keep meaning "whatever the SDK
defaults to" rather than silently becoming `low`. An unknown value is dropped rather than
defaulted, for the same reason. Selectable at launch and per agent afterwards — it is a
`query()` option, so like `permissionMode` it applies from the next run, and the composer
says so.

Two couplings worth recording: Track B's composer imports `EFFORTS`/`DEFAULT_EFFORT` from
Track A's `spawn/autonomy.ts` rather than duplicating the list, because two lists of the
same five levels drift; and `terminateAgent` is a `POST`, not a `DELETE`, because nothing
is deleted — the transcript, the spend and every file the agent wrote all stay.

11 new checks in `session/verify.ts` §3 and 6 in `spawn/verify.ts` §4. One of them —
"a terminated agent stops asking you for things" — is what found bug 2; it failed `1 → 1`
on the first run, which is exactly the phantom queue entry a human had already reported.

### Amendment 18 — post-merge, applied. **A 14k-character audit report arrived as one paragraph.**

Three defects on the Agent screen, all surfaced by the first real run of the new
`analysis` preset. The reported symptom was "a bunch of stuff I can't close"; the cause
was mostly not length.

**1. `white-space: pre-wrap` was set on one side of the conversation only.**
`agent.css` had it on `.ag-msg.is-you .ag-body` — *your* turns — and agent prose rendered
in a bare `<p>`, where CSS collapses every newline into a space. A report with eight
headings, five lists and four code fences arrived as a single unbroken paragraph. The
asymmetry is the whole bug, and it had been there since the screen was written: the
transcript was only ever tested against short replies, where a lost newline is invisible.

**2. Nothing could be folded.** Tool calls collapse to one line; prose had no control at
all. Fixed with a per-turn fold that is **default open** — a transcript that hides output
you have not read is worse than one you have to scroll, and the report is the thing you
asked for. It clamps by CSS height rather than by truncating text, so a fold can never
cut a code block in half, and the label counts the turn's total lines rather than
guessing at how many are hidden.

**3. Three of six permission modes were unreachable.** `Autonomy['mode']` mirrors the
SDK's `PermissionMode` exactly, and the daemon validated and forwarded all six — but the
composer's pills expressed two modes plus a tool-list toggle, so `dontAsk`, `auto` and
`bypassPermissions` were dead letters inside a frozen contract. Now an exclusive mode row,
each with its consequence in one line, plus the `appliesTo: 'next run'` the route has
always returned and the UI always discarded.

`bypassPermissions` also needed `allowDangerouslySkipPermissions: true` in `runner.ts`,
passed **conditionally** — the SDK refuses the mode without it, so shipping the button
first would have produced a control that looked like it worked and did nothing, which is
the worst of the three available behaviours.

**The interesting decision is where markdown gets rendered.** `workspace/markdown.ts`
argues against the browser, and it is right for the reason it gives: browser rendering
would mean "shipping a markdown stack **and a sanitizer** into every tab and trusting each
one equally". The sanitizer is the load-bearing half of that sentence, and it is only
needed because that renderer produces an HTML *string* for `dangerouslySetInnerHTML`.

`agent/markdown.tsx` produces **React elements**. React escapes text children by
construction, so `<script>alert(1)</script>` from an agent with shell access is five words
on screen and cannot be anything else. No sanitizer, because no HTML — nothing to
configure, nothing to keep in sync. It also adds no dependency (`packages/web` has only
react, react-dom and shared; CONTRACT §3 makes a missing dependency an escalation).
Server-side was rejected on three counts: the `text` event shape is frozen, the log is
append-only so existing transcripts would stay unrendered, and it would force
`dangerouslySetInnerHTML` at the other end anyway.

**That guarantee is a property of the code, not of this paragraph**, which is why
`packages/web/src/agent/verify.ts` (37 checks, in `make test`) leads with five escaping
assertions and a `javascript:`-href refusal. Switching one paragraph to
`dangerouslySetInnerHTML` was confirmed to fail all five with live tags in the output.

The renderer is deliberately partial, with one invariant: **unrecognised syntax renders as
literal text, never nothing.** Tables, footnotes and unterminated fences all fall through
to text, because a swallowed construct in an audit report is a deleted finding. Two
omissions are deliberate rather than lazy: `_italic_`/`__bold__` are unsupported, since
`audit_event_id` would italicise its own middle; and only `http(s):` links become links.

Verified against the real 14,128-character report already in the event log: 40 blocks, 8
headings, 4 code blocks, 5 lists, 152 inline code spans, zero live tags.

### Amendment 17 — post-merge, applied. **The remedy was on a different screen from the mistake.**

Amendment 11 put "remove project" on screen 2, which is right for a project with
history behind it. It was also the *only* place, and it is the wrong one for the case
that actually generates removals: a path typed wrong sixty seconds ago, sitting in
Spawn's `2 · where` picker. The cure was to leave the screen, switch to Project,
re-select the thing just created, and remove it there. **The place a person notices
the mistake was the one place they could not fix it.**

Amendment 16's lesson, read from the other end. There, a *constraint* living in one
layer was rediscovered once per surface that could reach it. Here a *remedy* lived on
one surface and could not be reached from where the error was made. Same shape: the
question is never only whether the capability exists, it is whether it exists where
the person is standing.

Screen 7 now carries the same command on each picker row, in Track A's own files:

- **`spawn/endpoints.ts`** — `removeProject()` and `ProjectRemoval`. A second copy of
  a four-line wrapper, which the per-screen-family convention in `agent/endpoints.ts`
  already accepts; the alternative is Track A's screen importing Track B's module to
  call Track A's own route.
- **`useCommand` is imported, not reimplemented.** Two translations of the same 409
  would drift, and 409 is the status carrying content here — the daemon refuses while
  an agent runs and names it.
- **`ProjectCard`** in `spawn/route.tsx`: `×` arms, a panel confirms, and the panel
  replaces the card so the row keeps its width and nothing below it moves.

Three details that are the whole correctness of it:

1. **`×` is a sibling of the card, never a child.** A `<button>` inside a `<button>`
   is invalid HTML and browsers resolve it by dropping one — usually the one you
   wanted. The flex sizing moved to a `.sp-proj-cell` wrapper, so rows keep the width
   they had before the button existed.
2. **The selection is cleared when the removed project is the selected one.**
   Otherwise `projectId` outlives the row it names, `canLaunch` stays true, and the
   next `⌘⏎` buys a 400 — the same late-failure shape Amendments 14 and 16 spent
   three passes removing from step 3.
3. **Always visible, not revealed on hover.** A control that appears only under the
   cursor cannot be found by someone looking for it, and this one exists for exactly
   that person. `--ink3` at rest, `--fail` on hover and `:focus-visible`.

The confirm repeats screen 2's sentence on purpose — *Conductor forgets, the disk
keeps*. Duplicated wording is the cost of that promise being legible at both places
someone can act on it.

### Amendment 16 — post-merge, applied. **The third time the same gap was found from a new direction.**

`POST /api/jobs → 400 … /Architecture-Work/IAM is not a git repository`, from a user
who had written a prompt, chosen a preset and set the pills before finding out. The
daemon was right. Amendment 10 made that refusal real, Amendment 14 fixed the *label*
that steered people into it, and the **choice itself was still offered** — so the
same defect surfaced a third time, from a third angle.

The fix is not another word. `worktree` and `branch` both create a branch, and whether
the selected project can support that is knowable the instant it is selected: step 3's
two git isolations are struck through for a folder with no repo, `in_place` is selected
for the user, and a line names the folder and says `git init`. The daemon's refusal
stays exactly where it is — a UI that knows better is a convenience, never the
boundary.

Two details that are the whole difference between this working and annoying:

- **`isRepo === null` means allowed.** Not-known-yet and daemon-could-not-say are the
  same state, and greying out options on either would punish a slow answer. When the
  daemon can't say, its own error beats a guess of ours.
- **A `forced` ref, so the correction is reversible.** Switching from a non-repo project
  to a real one restores `worktree`. Without it, `in_place` — the one isolation with
  nothing to revert to — would stay selected on a real repo because the user never chose
  it and has no reason to re-check. Only what we changed gets changed back, so a
  deliberate `in_place` on a real repo survives.

It reuses `GET /api/fs/complete` (Amendment 13) rather than adding an is-this-a-repo
route: `target.repo` already answers exactly this, and a second endpoint would be a
second door onto the same `existsSync(join(dir, '.git'))`.

**The lesson is about where a rule gets enforced, not how it is worded.** A constraint
that lives only in the layer that rejects will be rediscovered once per surface that
can reach it. Amendments 10, 14 and 16 are one bug, met three times, because the first
two fixes each addressed the surface in front of them.

### Amendment 15 — post-merge, applied. **An `analysis` preset, and the read-only roles that were not read-only.**

Two reading agents, in parallel, on a codebase nobody has read: `analyst` explains
how it works, `auditor` finds what is fragile. Not `review` renamed — a reviewer
judges a *change* and there is a diff; an analyst answers "how does this work" and
there is not.

Adding it cost nothing structurally, which is worth recording as a design win:
`AgentRole` is deliberately an **open** union (`… | (string & {})`,
`shared/src/events.ts`), and nothing in the daemon keys off a role — the supervisor
interpolates it into the system prompt and otherwise treats it as opaque. Two new
roles, zero changes outside `packages/web/src/spawn/`. Contrast `Isolation`, a closed
union in the frozen `wire.ts`: a fourth isolation would have been an amendment with a
migration behind it. **Which unions are open is a decision that pays or charges you
every time the product grows.**

The real find came from writing it. `toAgentSpecs` pinned reviewer and debugger to
`{ acceptEdits: false, askBash: true }` and called that read-only. It was not.
Removing auto-accept does not forbid a write, it only makes the write *ask* — so a
preset whose plan preview read "writes nothing" would write the moment a human
clicked approve on a prompt they had no reason to distrust. The label was a promise
the mechanism could not keep.

Three changes, all in Track A's `spawn/`:

1. **`READ_ONLY_ROLES` is a Set, not a condition.** A list is auditable; `||` chains
   are how the fourth role gets forgotten. Forgetting is silent in the worst way —
   the agent runs, the preview still says "writes nothing", and it writes.
2. **The write tools are denied outright** for those roles: `Edit`, `Write`,
   `MultiEdit`, `NotebookEdit` appended to `disallowedTools`, the only setting that
   survives every permission mode (MANUAL §5). Bash is deliberately *not* denied — it
   is already absent from `allowedTools`, so every command stops and asks, and an
   analyst that cannot run `git log` cannot answer how the code got this way. The line
   is "cannot change files", not "cannot act".
3. **The plan preview marks those rows `read-only`.** The resolved-options disclosure
   at the foot of the screen shows the *job's* autonomy, which for a reading role is
   not what gets sent. A screen whose whole promise is "no hidden translation" cannot
   have one row quietly differ from its own summary.

New suite: `packages/web/src/spawn/verify.ts` (Track A, in `make test`) — 56 checks,
no daemon and no browser, because it is all pure functions. It asserts the negative
case against the *most permissive* pills a user can set, and the five write-tool
checks were confirmed to fail with change 2 reverted. **Every mistake these functions
can make is silent and valid-looking, which is precisely the class of bug that needs
a test rather than a reading.**

### Amendment 14 — post-merge, applied. **The pill for the git-less isolation named a git branch.**

Amendment 10 made `in_place` work without git. The label above it still read
**"straight onto main"**, so the capability shipped undiscoverable, and the wording
steered people to `branch in place` — the one option that cannot run in a folder
with no repo. Observed as a `400` from `POST /api/jobs`, five decisions after the
one that caused it: `could not prepare a branch workspace: … is not a git repository`.

The label was wrong in every case it covers:

1. **No git.** There is no `main`; the workspace records Amendment 10's
   `NO_GIT_BRANCH = '(no git)'`.
2. **Git, but not on main.** `#ensureInPlace` reads `currentBranch(root)`. On a repo
   checked out at `action-item-id-scheme` the pill promised main and would deliver
   that.
3. **Its own hint already said so** — "Agents edit your checkout on its *current
   branch*". The correct wording sat one field away from the label contradicting it.

And `branch in place` — the isolation that *requires* git — owned the phrase "in
place", so the two pills competed for the name of the thing only one of them does.

Four changes, all Track A's:

- **`label: 'this folder, as-is'`**, true with or without git and on any branch.
- **`note: 'no branch, no undo'`**, in the slot the worktree pill uses for
  `.conductor/wt/<job>`. The hazard is the missing baseline, not the branch name:
  `--fail` styling is unchanged and still earned.
- **`hint`** names both cases, and that this is the isolation needing no git.
- **A second hint slot.** One `hint` state rendered section 3's explanation
  underneath section 5, two sections below the pill being hovered — the sentence
  saying which isolation needs git was displayed nowhere near the choice it
  governs. `isoHint` renders directly under the pills.

**The mockup is fixed**, as in Amendments 2, 6 and 7: `mockups/conductor.html` was
drawn for a repo mid-feature, where "straight onto main" is vivid and accurate. It
encodes an assumption two of three real cases break, and the mockup is the design
reference, not the specification of a bug.

Nothing in `wire.ts` moves: `Isolation` is still `'worktree' | 'branch' | 'in_place'`
and the daemon reads the id, never the label.

### Amendment 13 — post-merge, applied. **Path completion, and the one place this system looks outside a workspace.**

"Enter the absolute path of a repository" asked the user to know something they
reasonably don't. The fix is not a file picker: **a browser cannot be handed a real
filesystem path.** `<input type="file" webkitdirectory>` yields file names and a
bare folder name, never an absolute path, and it is an upload rather than a
reference. The daemon, being a local process, can answer — so completion is a
daemon endpoint, and the browser's half is only debounce and keys.

New surface, owned by **Track C** because it is filesystem access and the limits
are this track's to keep:

- `workspace/browse.ts` — `completePath()`, splitting the way a shell does.
- `routes/fs.ts` — `GET /api/fs/complete?path=`. Deliberately not in `wire.ts`
  (Amendment 2): an affordance for one input field is not a contract between tracks.
- Track A's `spawn/browse.ts` + `PathField` in `spawn/route.tsx` — ⇥ completes, ↑↓
  pick, ⏎ descends or adds, ⎋ closes then cancels.

**Every other path in this track is contained to a worktree by `paths.ts`. This one
has no root to be contained to — that is the feature.** So containment is replaced
by limits that remove categories of abuse rather than making them unlikely:

1. **Directories only.** Files are never listed. This cannot find
   `~/.aws/credentials`; the answer to "what is in this folder" is only ever
   "these folders".
2. **Names only.** It reads directory entries and never opens a file.
3. **Dotfolders hidden** until the user types the dot, as a shell behaves.
4. **A hard cap with the overflow counted**, not silently dropped — Amendment 4's
   rule for a different tree.
5. **No writes, and no way to add one.** No `mkdir`, `rename` or `unlink` in the
   module. The moment it can change the disk it stops being a lookup and becomes
   the hole `paths.ts` exists to prevent.

Paths come back canonicalised through `canonicalRoot`, so a symlinked path and its
real path can't become two projects.

Two details that only show up when you write it: a **linked worktree's `.git` is a
file**, not a directory, so the repo marker tests existence rather than
`isDirectory` — otherwise `.conductor/wt/<job>` wouldn't read as a repo. And a bare
`~` lists home instead of completing usernames inside `/Users`, which is what the
shell reading would do and would offer exactly one useless row.

20 checks in `workspace/verify.ts` §14, weighted towards the refusals — that files
are absent, that dotfolders are absent, that a half-typed path and a NUL byte are
both `200` with an empty list rather than an error, because both are ordinary
keystrokes in a path being typed.

### Amendment 12 — from Track A's verify, applied to Track C. **The first file of every new feature was invisible.**

`git status --porcelain` collapses a wholly-untracked directory into one record for
the *directory*: an agent that creates `api/v2/rotate.js` in a repo with no `api/`
yet produces `?? api/` and nothing about the file. Two consequences, both silent:

- **The watcher emitted nothing.** `#emitBatch` looks the written path up in
  `status()`; not finding `api/v2/rotate.js`, it took the "clean again" branch, found
  no prior emission to clear, and dropped the write. No `file_edit`, so no
  `file_changes` row, so no badge, no diffstat, no attribution — for the file that
  starts the work.
- **`scanChanges` counted a directory as a file.** It called `countNewFile` on
  `api/`, which yielded a zero-line entry, so the diffstat reported one changed file
  and none of its lines.

One-word fix — `-uall` on the status invocation — and the doc comment on `status()`
now says it is load-bearing, because it reads like tidiness.

Why 60-odd Track C checks missed it: **every one of them wrote into a directory the
fixture already tracked.** `src/token.js`, `src/brand-new.js`, `docs/PLAN.md`. The
filter tests were thorough about what must *stay out* of the log (gitignored,
`node_modules`, no-op rewrites) and silent about the ordinary case of a path whose
parent is also new. It surfaced from Track A's removal suite, which built a repo
from scratch and wrote the one file it needed — the shape a real first job has, and
the shape no fixture-based test had.

Guarded now in `workspace/verify.ts` §7b, on both the event and the diffstat, and
both checks were confirmed to fail with the fix reverted. A guard that has never
failed is a guess.

### Amendment 11 — post-merge, applied. **Removing a project: four tracks, one promise.**

A project could be added and never removed. Removal is one route, but the
bookkeeping it has to forget is spread across four owners, and the neighbouring
call in each of them touches the filesystem — so the interesting part of this
amendment is what it does *not* do.

The promise the UI makes is *it forgets, it does not delete*. Therefore:

- **`WorkspaceService.forget` (C), not `close`.** `close` calls
  `WorktreeMgr.remove`, which runs `git worktree remove` and deletes the directory.
  Correct when a checkout is being disposed of; catastrophic when a human asked
  Conductor to stop listing a project. `forget` stops the watcher and drops the rows.
- **`WorkspaceStore.forget` deletes the `workspaces` row rather than stamping
  `removed_at`.** `removed_at` means "the directory is gone", which here would be a
  false statement about the filesystem. Nothing left behind beats a wrong flag.
- **`ServerRegistry.forgetJob` (D) drops rows without emitting `down` or sending a
  signal.** The dev server is still serving; `down` would put a falsehood in an
  append-only log, and SIGTERM would be exactly the reaching-onto-your-machine the
  feature promises not to do.
- **`events` and `cost_daily` survive (A).** The log is append-only (§5.2) and the
  money was spent. A removal is not a refund.

Everything else goes in one `DELETE FROM projects` — `PRAGMA foreign_keys = ON` and
every Track A table cascades from it.

Three decisions worth recording:

1. **`resync`, not a new frame.** Deletion propagates by broadcasting `resync`, which
   makes every connected browser refetch `/api/snapshot` and replace its collections
   wholesale. The frozen wire contract needs no change, and `#applyEvent` never
   creates entities, so a removed project cannot walk back in off the event stream.
2. **Refuse, don't stop.** A live agent makes the removal a `409` naming the roles in
   the way. Killing work in flight is the human's call, not a side effect of a button
   labelled "remove". Liveness is `#active`/`isLive`, not the `status` column — a row
   reading `working` after a restart is stale bookkeeping with no process behind it.
3. **The cascade goes through each track's public API.** The supervisor calls
   `workspace().forget` and `preview().registry.forgetJob`; it does not write another
   track's tables. Same shape as the existing in-process `workspace().open` call.

Track A now has its own suite, `session/verify.ts` (in `make test`): a throwaway repo,
a real worktree, a real dev server, 46 checks. The ones that matter are the negative
ones — after a removal the README is byte-for-byte, the worktree is still on disk
with the agent's file in it, `git worktree list` still registers it, the branch still
exists, and the dev server still answers. It also found Amendment 12.

### Amendment 10 — post-merge, applied. **`in_place` never worked without git, and the manual promised it did.**

`WorktreeMgr.#ensureLocked` checked `isRepo` — and resolved `repoRoot` — *before*
dispatching on isolation, so all three isolations required a git repository. Two of
them genuinely do: they create a branch. `in_place` creates nothing, and existing
for scratch directories is the entire reason it is in the `Isolation` type.

The bug was invisible because both halves were individually defensible.
`createProject` deliberately accepts a non-repo path, with a comment saying
`in_place` still works — Track A's reading of Track C's contract, never executed
against it. The Sep 22 doc pass then verified the *worktree* refusal against a
running daemon, found it clean, and wrote `docs/MANUAL.md` from the untested half.
**A verified half is not a verified whole**; the case that was asserted rather than
run is the one that was broken.

Five changes, all in Track C's directory:

1. **`#ensureLocked` requires git only for `worktree` and `branch`.** With no repo
   there is no root to discover, so the directory the human named *is* the
   workspace.
2. **`NO_GIT_BRANCH = '(no git)'`** is what `branch` says for a git-less
   workspace — a parenthesised non-branch, matching the `(detached)` that
   `currentBranch` already returns. Deliberately **not** `null`: widening the field
   would mean a migration rebuilding two `NOT NULL` columns, a change to the frozen
   `Job` wire type, and a fallback at seven render sites, to express what the string
   already says. Nothing treats `branch` as a ref after creation — checked.
3. **`status()` returns `[]` for a non-repo**, the same guard `numstat` and `diff`
   already carry for a repo with no commits. This is what stops the throw reaching
   the tree, diff, file and watcher paths.
4. **`walkFiles` backs `buildTree` when there is no git.** `git ls-files` applies
   .gitignore for us; without it the structural deny-list becomes load-bearing, so
   pruning happens *during* traversal. Its ceiling sits well above the display cap,
   because stopping at the cap would make `truncated` report "1 not shown" when
   thousands were — Amendment 4's point, restated.
5. **The `file_edit` projection becomes the record, not just the attribution.**
   With no HEAD there is no delta, so every write reports the file's length and the
   watcher takes its untracked path for everything. Counts stay real (bytes are
   read); what is honestly unavailable is "changed relative to a commit", and the
   manual now says so instead of implying parity.

20 checks in `workspace/verify.ts` §13, including the refusal that must *stay* a
refusal. The general lesson, and it is the third amendment to make the same shape
of point: **an assumption about another track's behaviour is a test you have not
written.** Track A's comment was reasonable, cheap to verify, and wrong.

### Amendment 1 — from Track E, applied

Three gaps Track E reported instead of editing around. All were W0's to fix.

1. **`--well` token added.** The scale had no value *deeper* than `--bg`, which
   recessed surfaces need — terminal command blocks, preview wells. Track E was
   right to refuse to invent one.
2. **`alwaysOn` mount point added** (`AlwaysOnDef`, globbed from
   `src/<track>/always.tsx`). `main.tsx` renders only the active screen, so a
   notification ladder living in screen 4 stopped the moment the user pressed
   `1` — exactly when the tab badge matters most. Tracks needing this must add
   their own `always.tsx`; it is not automatic.
3. **Fixture fixed.** `permission-requests.jsonl` had no `preview` fields and no
   `multiSelect` case, so a Done criterion W0 itself wrote was unreachable. The
   question now carries two HTML previews, plus a second `multiSelect: true`
   question with **no** previews so the undefined path is exercised too.

Rebase onto `main` to pick these up.

### Amendment 2 — from Track C, applied

1. **Snapshot contributors now COMPOSE.** `buildSnapshot` shallow-spread each
   contributor's slice, so two tracks both supplying `jobs` silently discarded
   one — last registration won, no error, no log line. Array slices (`projects`,
   `jobs`, `agents`, `pending`, `servers`) now merge by identity and accumulate;
   scalars (`slots`, `costToday`) stay single-owner last-wins; `seq` is never a
   contributor's to set. Locked in by a smoke check. **Track C may now contribute
   its real `jobs` slice instead of the defensive no-op it registered.**
2. **`li.now` is `--live`, not `--need`.** The mockup styled the in-progress task
   marker amber, contradicting §5.1 of this file. Amber means *a human is
   required*; a current-task marker is status. `--live` is correct — that task is
   being worked on right now. The mockup is fixed.

Not changed, for the record:

- **Track C's three `/api/workspaces` endpoints stay as bootstrap.** They live in
  its own route file and exist so screen 5 is demonstrable before Track A ships
  job creation. They are deliberately **not** added to `wire.ts` — enshrining a
  temporary in the frozen contract is worse than leaving it clearly marked.
  Track A creates jobs in-process via `workspace().ensure()`, not over HTTP.
  Expect these to be gated or removed at I4.
- **A fresh worktree being clean is correct**, not a fixture bug. Dirt appears
  when agents work in it. The `in_place` path is the right way to exercise
  existing-dirt rendering.

Rebase onto `main` to pick these up.

### Amendment 3 — from Track E, applied

**Hash-driven navigation added** (`packages/web/src/lib/nav.ts`). `main.tsx` owned
the active screen and ignored the hash, so an `alwaysOn` component — which lives
in a separate React tree, outside the shell — could not bring the user to a
screen. Track E's clicked desktop notification hit this: it could focus the tab
but not leave whatever screen you were on, which is the kind of half-working that
teaches people to ignore notifications.

Use it instead of touching `location.hash` or `history` directly:

```ts
import { navigate, currentRoute, onNavigate } from '../lib/nav.js';
navigate('attention');                     // jump to a screen
navigate('agent', { agentId: 'agt_1' });   // ...with params it can read
const { id, params } = currentRoute();     // read them
onNavigate((id, params) => { … });         // react to being navigated to
```

Works from a screen, the shell, or an `alwaysOn` component. **Track B: this is
what the Fleet cards should use** for "open files" / "open preview" / drilling
into a project or agent — don't hand-roll screen switching.

### Amendment 4 — from Track C, applied

**`FileTreeResponse.truncated?: number`** added. Track C had been signalling a
capped tree through a node with a NUL byte in its path — unopenable by
construction, since `paths.ts` rejects NUL before any fs call. Clever, and it
worked, but an undocumented convention spanning two packages with no shared
constant is exactly what a later refactor deletes without knowing why. The field
is the honest version; the sentinel can come out.

Silent truncation in a file browser is a correctness bug, not a cosmetic one — it
makes someone believe a file does not exist. Whatever sets this must surface it
in the UI.

### Amendment 5 — from Track E, applied

**`useNavParams(screenId)`** added to `lib/nav.ts`. Use it instead of wiring
`onNavigate` yourself, because there are two cases and each needs a different
mechanism:

- **Navigated to from another screen** — your component is not mounted when
  `notifyNavigation()` fires, so a listener never sees it. The mount-time
  `currentRoute()` read catches this.
- **Navigated to while already open, with new params** — you are mounted and
  there is no remount, so only the listener catches it.

Wire one and it works in testing and fails in the case you didn't try. Track E
found this the hard way; the hook now covers both.

Empty params from a bare `navigate('yourScreen')` (a hotkey press) are reported
honestly. Whether that means "reset" or "leave my selection alone" is your
screen's policy — leave-alone is usually right.

**Tracks B and D: you will both hit this.** Opening the Agent screen at an agent,
or Preview at a job, is the same shape.

### Amendment 6 — from Track D, applied

1. **`DevServer.host: '127.0.0.1' | '::1'`** added. Dev servers frequently bind
   only `::1` — `localhost` resolves to both families on macOS and the server
   picks one. An IPv4-only probe then reports "no dev server" for a server that
   is serving fine, which is indistinguishable from the frame-blocking failure
   the preview feature exists to fix. Track D hit it mid-build; I reproduced it
   in my own verification minutes after reading the report and drew exactly the
   wrong conclusion until I checked both families.
   **Never hardcode `127.0.0.1` when probing or dialling.** Probe both, remember
   which answered, dial that one.
2. **`ConsoleLogResponse` and `SendConsoleToAgentResponse`** added. The contract
   froze the requests and not the responses. `delivered: false` carrying the
   composed `text` is the honest shape while the receiving endpoint is absent —
   it can't imply an agent was told something it never received.
3. **Track D's removal of amber from screen 6 is blessed, and the mockup is
   fixed.** The mockup painted "send errors to agent" with `btn amber`, but
   nothing there is summoning a human — they are already looking at their app.
   Errors are `--fail`; the button borrows that accent. Same class of bug as the
   `li.now` violation Track C caught.

Also accepted without change: dock tabs are `console` + `server` rather than the
mockup's console/network/server-log, because network and server-log have no data
source in this track and a tab that renders nothing is worse than one that isn't
there.

### Amendment 7 — from Track B, applied. **Two real bugs, both affecting every UI track.**

1. **StrictMode double-connect — FIXED.** `main.tsx` calls `store.connect()` from
   a `useEffect`, and `<StrictMode>` runs effects twice in development. `Feed`
   had no re-entrancy guard, so two sockets (or two fixture replays) ran
   concurrently and **every event arrived twice** — silently doubling
   `useSparkline()` and `useJobDiffstat()`, and duplicating React keys for anyone
   keying on `seq`. Track B found it by watching two of its own screens disagree
   about one diffstat. `Feed` now guards; the store is *also* idempotent on `seq`.
   **Remove any local dedupe workaround.**
2. **The store mutated event arrays in place — FIXED.** `#applyEvent` pushed onto
   the existing array and re-`set()` it, so array identity never changed and
   `useMemo(..., [events])` froze at its first value forever. The symptom — a
   list that renders once then stops while data is plainly arriving — looks like
   a React bug, not a store bug. Arrays are now replaced.
   **Remove any memo-keyed-on-seq workaround.**
3. **`screens: ScreenDef[]`** now accepted from a `route.tsx`, so one directory
   can own two screens. Track B had to create a directory containing a three-line
   re-export to register Fleet and Project. That shim can go.
4. **`Agent.autonomy`** added to the shared type. The DB column and the fixtures
   both carried it from the start; the contract didn't, so tracks were reading it
   defensively off an object the contract said had no such field.
5. **`useSparkline(agentId, now?)`** gained a `now` seam. A fixture recorded at a
   past timestamp falls outside the trailing wall-clock window, rendering a busy
   agent as flat — i.e. "stuck", the exact opposite of the truth. Pass `now` when
   replaying a recording.
6. **Hash format documented:** ids are bare, `#fleet` not `#/fleet`. A leading
   slash parses as an unknown id and lands on the empty state, which looks like a
   catastrophic regression and isn't.

**New gate — run it before handing back:**

```
pnpm --filter @conductor/web verify     # store reducer
```

W0 had no web-side test, which is exactly why these two bugs survived. Neither
breaks a build, neither throws; they just quietly produce wrong numbers in a
layer four tracks depend on.

### Amendment 9 — from Track B, applied. **Amendment 8 was only half a fix.**

Amendment 8 fixed `diffstat()` and stopped there. Anything that walks `file_edit`
payloads **directly** still double-counted, and Track B had two such places — per-file
rows that would have shown roughly double the total sitting right beside them.
That is the same two-numbers-for-one-diff symptom that led it to the
double-connect, so it fixed its own copies and reported the general gap.

Three changes:

1. **`resolveFileEdits(events)` exported from `@conductor/shared`** — one
   implementation of the rule, returning per-path `{added, removed, created,
   deleted, countedFrom, agentId, at}`. **Use it rather than walking `file_edit`
   payloads yourself.** `diffstat()` now delegates to it.
2. **Track C's `recordEdit` precedence is explicit rather than incidental.** It
   was a last-writer-wins upsert that happened to be correct only because the
   watcher fires after a debounce and so usually landed second. A slow watcher, a
   fast re-edit, or a job past the watcher cap would have left an estimate on
   screen with nothing to contradict it. A `'tool'` event may now create a row but
   never overwrites counts on an existing one; watcher events always do.
3. Attribution is taken from whichever source knew it, regardless of which
   supplied the counts — only the watcher has real numbers, only the tool channel
   knows who wrote.

The general lesson, which cost two amendments to learn: **fixing a shared helper
does not fix the callers who bypass it.** When a rule matters, export the rule,
not just a function that happens to apply it.

### Amendment 8 — from Track A, applied. **The merged system was double-counting every write.**

`file_edit` has **two emitters**, deliberately, and they carry different truths:

| source | knows | doesn't know |
|---|---|---|
| `'tool'` — Track A's `PostToolUse` | **who** wrote it (real `agentId`), arrives immediately | counts are estimates from the tool input |
| `'watcher'` — Track C's watcher | counts are **authoritative** (`git diff --numstat`) | sees bytes, not authors — `agentId` is null |

`diffstat()` summed both, so every change was counted twice. A plausible-looking
wrong number is worse than an obviously wrong one, because nobody questions it.

`FileEditPayload.source` is now part of the contract, and `diffstat()` resolves
the overlap **per path**: authoritative wins where it exists, and the `'tool'`
estimate is the fallback where it never will — `in_place` jobs and any worktree
past the watcher cap. Absent `source` means authoritative, so the fixtures and
pre-amendment events keep their meaning.

**Track A must set `source: 'tool'` on its emissions** — until it does, the fix
is inert, because both sources still read as authoritative.

Also blessed without change: Track B removed amber from every place the mockup
had used it decoratively — primary buttons, the active nav tab, hover states, the
"YOU" label, inline code, composer pills. That is applying §5.1 as a rule rather
than patching the instances I happened to catch. The mockup was wrong in all of
them.

Rebase onto `main` to pick these up.
