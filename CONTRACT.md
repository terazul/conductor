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

*Renumbered 15 Oct 2026: Amendments 149–154 were merged locally as 148–153, and moved up by one
because Amendment 148 was published first from another session. Their commit messages keep the
old numbers.*

### Amendment 167 — post-merge, applied. **A message sent with every slot taken waits for a slot, in the database, and goes in the first one that frees.**

Daemon (`db/migrations/255_scheduled_synthetic.sql` new, `session/schedule.ts`, `session/supervisor.ts`,
`routes/schedule.ts`, `session/verify.ts`, `session/verify-schedule.ts`), shared (`wire.ts`), web
(`agent/endpoints.ts`, `agent/composer.tsx`, `attention/HandOff.tsx`, `agent/scheduled.tsx`,
`lib/verify-schedule.ts`), docs (`docs/MANUAL.md`, `TODO.md`). The user, 14 Oct 2026, in
docs/plans/wave-11.md §6 A2 ("a sent message ignores the slot limit"), *Decided (14 Oct): the message
waits for a slot and survives a restart.* *Amends Amendment 47*, whose open question was that a message
to an idle agent "starts it at once, whether or not a slot is free"; *Amendment 111*, under which a
message you send still goes through a hold (it still does, but waits for a slot first); and *Amendment
157*, which reserved `'slot'` with nothing writing it. Amendment 132's brief overshoot (an answered
question counts again at once) is unchanged.

- **The row** (`255_scheduled_synthetic.sql`). `scheduled_messages.synthetic INTEGER NOT NULL DEFAULT 0`,
  so the ask to hand off and the web's "continue" stay *auto* in the transcript when they wait. It isn't
  on the wire. `insertScheduled(…, trigger, synthetic)` (`schedule.ts:110-131`), `getScheduled`
  (`:160`), and `nextForSlot` (`:170`), the agent's oldest `'slot'` row with no error, by
  `created_at`, then rowid.
- **Sending a message** (`supervisor.ts:2109-2114`). After the budget and folder refusals, which are
  unchanged, a message waits as a `'slot'` row when every slot is taken, when one of yours already
  waits (it goes first), or when the agent's last run is still unwinding. That last case used to start
  a second run beside the first. The agent is set `queued` with `SLOT_WAIT_NOTE` (`:230`, `#waitForSlot`
  `:2135`). `sendMessage` returns `'queued'`, and the route answers `{ ok, delivery: 'queued' }`
  (`SendMessageResponse`, `wire.ts:358`). Queueing doesn't reopen the job; the launch does.
- **pump** (`supervisor.ts:970-978`). For a queued agent with a `'slot'` row, the row goes as soon as a
  slot is free (`#sendForSlot`, `:2149`): the row is deleted and the agent resumes its own session with
  the text, word for word. It goes past what `sendMessage` goes past with a free slot: the job's pause or
  failure, its dependencies, the wait for the model (Amendment 123), and a hold (Amendment 111). The
  exception is the ask to hand off, which is Conductor's and waits for a hold to end. A refusal found
  then (a budget, a folder gone, no session) sets the row's `error` and pauses the agent or reports the
  folder, as a timed one does.
- **One per turn** (`supervisor.ts:1507-1518`). At the end of `#settle`, an agent that ends `done` or
  `failed` with another `'slot'` row is queued again before `#rollUpJob`, so its job isn't finished
  under it. `#sendWhenDone` (`:1541`) waits while a `'slot'` row is pending, so yours go first.
- **The ask to hand off** (`#askToHandOff`, `supervisor.ts:1741-1746`). With every slot taken it
  waits as a synthetic `'slot'` row instead of launching.
- **A relaunch wanted while a run unwound** (`#resumeWanted`, `supervisor.ts:1323-1335`). If the slot
  was taken meanwhile, the agent is queued with its job reopened, as `resumeParked` does, and pump
  resumes it when a slot frees. It used to launch over the limit. It says why on a `queued` status
  event, `SLOT_RESUME_NOTE` (`:237`), which `resumeParked`'s own no-slot branch does not. That note is
  not `SLOT_WAIT_NOTE`, so cancelling a message you send it afterwards doesn't undo the queue.
  Both waits arise only when the limit came down while agents ran, because the ending run gives its
  own slot back before either is decided.
- **A message due at its time** (the Scheduler's `#once`). It goes through `sendMessage`, so with
  every slot taken it becomes a `'slot'` row and the timed row is deleted.
- **Cancelling** (`routes/schedule.ts:78-80`, `slotMessageCancelled` `supervisor.ts:2176`). ✕ on a
  `'slot'` row, once none is left, puts a queued agent back to its status before it was queued (from
  its status events), so pump doesn't start it unasked. A cancelled ask to hand off leaves the agent
  `done`, held for you as it would have been. `POST /api/agents/:id/scheduled` still refuses
  `trigger: 'slot'` (400): only the supervisor writes one.
- **Web.** `sendMessage` returns the answer (`endpoints.ts:38`). `sentText` (`:46`) turns `'queued'`
  into *Waiting for a slot: it goes when one frees.* (`SLOT_WAIT_TEXT`, `:43`), which the composer
  (`composer.tsx:278`) and the reply in Needs you (`HandOff.tsx:52`) show. `ScheduledList` shows the
  row as **⏲ waiting for a slot** (`scheduled.tsx:119`) with what it waits on (`slotWaits`, `:69`):
  *goes when one frees*, *after this turn*, *waiting: it asked you something*, *waiting: it is paused*,
  or *after the one before it*.

*Not done / not decided:* across agents, pump still goes in `listAgents` order, and a `'slot'` row
gets no priority over other queued agents. A cancelled row's "status before" comes from the agent's
status events, so an agent with none (never run here) stays queued. A row that failed (`error`) is
skipped and stays until you clear it, like a timed one. A relaunch is wanted only for a run `#launch`
started: a decision that lands while a run `#launchWithPrompt` started (your message, a slot row, the
ask) is unwinding is not relaunched at all, slots or not, as before this amendment.

*Verified:* daemon `session/verify.ts` §15 (`:2229`), 22 new checks on the fake SDK. With every slot
taken, messages to an idle agent start nothing, the live count stays at the limit, and the route
answers `'queued'`. They wait as `'slot'` rows in order, with the agent queued and saying why, and a
second connection to the file finds both. Pumping while full starts nothing. A freed slot resumes the
agent's own session with the first text, word for word, the second goes at the next turn, and the
agent ends `done`. All of that happens while the fleet is held. Cancelling puts the agent back to
`done`, and a freed slot then doesn't start it. A second Supervisor on a fresh connection sends a
waiting message in its first free slot, held. Daemon `session/verify-schedule.ts` §9 (`:486`), 6
checks: a message due at its time with the one slot taken starts nothing, becomes a `'slot'` row with
its text, queues the agent with the note, and goes in its own session when the slot frees. Web
`lib/verify-schedule.ts` §6 (`:133`), 7 checks. With the queue branch in `sendMessage` disabled, 14
of §15's checks and 4 of §9's fail ("8 of 7" running, `delivery: 'resumed'`). Send-back 1 adds two
more. §15 (`:2364`), 5 checks: a decision that lands while a run unwinds, with the limit lowered under
it, starts no second run, leaves the live count at the limit, and queues the agent with
`SLOT_RESUME_NOTE` and no row; a freed slot relaunches its own session once, with `WAKE_NUDGE`. §20
(`:5075`), 9 checks: a restarted analyst that ends its turn without `hand_off` with the limit lowered
under it starts nothing and stays at the limit. The ask waits as one synthetic `'slot'` row with
`HANDOFF_ASK`, and the agent is queued with `SLOT_WAIT_NOTE`, not held, while the developer waits. A
hold that frees the slot doesn't send it. Released, it goes in the agent's own session, shown as auto,
once, within the limit; ending that turn without `hand_off` too holds it, and it isn't asked again. With
`#askToHandOff`'s slot check disabled, 6 of the 9 fail ("1 new run(s), 2 of 1"); with `#resumeWanted`'s
disabled, 2 of the 5 do. `make test` green.

### Amendment 166 — post-merge, applied. **A `hand_off` short of its closing headings is saved, and the agent is told which.**

Shared (`headings.ts`, `wire.ts`, `index.ts`), daemon (`session/store.ts`, `session/supervisor.ts`,
`routes/helpers.ts`, `session/verify.ts`), web (`attention/alerts.ts`, `attention/HandOff.tsx`,
`attention/attention.css`, `attention/verify.ts`, `spawn/verify.ts`), `docs/MANUAL.md` and `TODO.md`. The
user, 15 Oct 2026: "Run track 2 of `docs/plans/wave-11-tracks.md`"; this is the plan's lane L2 (wave-11.md §4,
"H3: check that a hand_off has its closing headings"), with *Decided (14 Oct): warn*, and §6: "Warn: save the
summary and tell the agent." *Decided (15 Oct): the role rules 'tests only' and 'docs only' are left as words,
as O2 was: no enforcement, no lane.* *Amends Amendments 104 and 126*: 104's `hand_off` took any summary that
was not empty; 126 gave each built-in role the headings it closes with, and nothing read them.

- **The headings are read from the prompt, not sent.** `closingHeadingsOf(systemPrompt)`
  (`shared/src/headings.ts:24`, pure): the bold names on the last line that starts "End with:" (any case), in
  order, each once, trailing colon dropped, at most 20 of at most 80 characters. The row already keeps the
  system prompt it was launched with (Amendment 68, `system_prompt`), so there is no `AgentSpec.closingHeadings`
  and no migration: what is checked is what the agent was told, a persona edited later changes nothing, and a
  restart keeps it. `Agent.closingHeadings?` (`wire.ts:147`) carries them, present only when there are some
  (`closingHeadingsField`, `store.ts:410`, used by `toAgent` `:443` and `insertAgent` `:706`); the prompt
  stays off the wire.
- **What counts as the heading.** `missingHeadings(summary, headings)` (`headings.ts:52`, pure, in shared so
  the daemon and the card read it the same way): a heading is there when a line starts with it as a word, case
  and spacing aside, as a Markdown heading (`## Plan`, `### Plan and steps`), in bold or italic (`**Plan**`,
  `**Plan:**`, `_Plan_`), or plain with a colon or alone on its line (`Plan:`, `Plan`). A list marker or quote in
  front is skipped (`- **Plan** (the steps)`). The word opening a sentence ("Plan to refresh"), inside one, or
  going on ("**Planning**") does not count. No headings, nothing missing.
- **`hand_off` keeps it and says so.** `handOff` (`supervisor.ts:1722`) saves the summary as before and now
  returns `missing` too (`:1738`). The tool's reply (`routes/helpers.ts:184`), with any missing: *Handed off,
  but your summary has no heading for Plan. It is saved, and developer will be told it first once your turn
  ends. Call hand_off again with the whole summary, those headings included: the new one replaces this one.*
  Otherwise it is the reply it was. Nothing is refused and nothing waits on a second call.
- **The card warns; a person is not stopped.** `handOffMissing(summary, agent)` (`alerts.ts:299`) is
  `missing: Plan, Risks` or null (all there, empty, or none asked for). The Needs You hand-off box shows it
  under the summary, only when it can be sent (`HandOff.tsx:84`, `.atn-handoff-missing`, `attention.css:372`,
  `--need`), and **hand off with this** is not disabled by it. `handOffByUser` (`supervisor.ts:1748`) takes it
  unchanged.

*Not done / not decided:* a heading under another name (**Departures** for **Departures from the plan**)
counts as missing. Helpers have no `hand_off`, so nothing checks theirs; nor an agent's last reply when nobody
waits for it. The check runs once per call: an agent that ignores the reply is not asked again, and the
agents after it start with what it saved. The card's warning is only while the box is open; the alert itself
does not name what is missing. The role rules "tests only" and "docs only" stay words (decided above).

*Verified:* `session/verify.ts` §20 (`:4854`, the block "Amendment 166" at `:5110`): pure checks of
`closingHeadingsOf` (bold names on the "End with:" line, none without a prompt, line or bold, the last such line
read) and of `missingHeadings` (every heading form counts; a sentence opening, inside or "Planning"/"Plans" does
not; no headings, nothing missing); then, against the real supervisor and the fake SDK, architect (Context,
Plan) → developer (Changed, Left undone) → validator (none) → scribe: the wire carries the headings and none for
the validator; the architect's `**Context**` only is taken, the reply names Plan and asks for `hand_off` again,
and the summary is saved; the full one gets the plain reply and replaces it; the held developer handed off by
you with `Changed:` only is taken (200), saved and released; the validator's "All green." gets the plain reply.
Web: `attention/verify.ts:448` (`handOffMissing`: one, every one in order, none for all there, empty or no
headings; the box shows it only when sendable and never disables the send) and `spawn/verify.ts:1169` (each
built-in's prompt yields exactly its headings; each spec `toAgentSpecs` launches carries them; an edited prompt
brings its own, one with no "End with:" line none). With `missingHeadings` returning nothing the card checks
fail; with `closingHeadingsField` returning nothing the wire and the reply checks fail. `pnpm -r typecheck`
clean; `make test` green.

### Amendment 165 — post-merge, applied. **Files moves an entry by drag or Move to…, and the navigator renames and deletes.**

Web (`files/moving.ts` new, `files/naming.ts`, `files/NewFileForm.tsx`, `files/FileTree.tsx`,
`files/route.tsx`, `files/deleting.ts`, `files/files.css`, `files/verify.ts`, `shell/Navigator.tsx`,
`shell/shell.css`, `shell/verify.ts`), daemon (`workspace/verify-files-verbs.ts`) and docs
(`docs/MANUAL.md`, `TODO.md`). This lane came from analysis, not from the user: it is
docs/plans/wave-11.md §3 J (N6), run as track 4 of docs/plans/wave-11-tracks.md on 15 Oct 2026.
*Amends Amendment 138*, whose "Not done: drag and drop to move; … a rename or delete in the
navigator" and "Only a new file here; rename and delete are on Files" no longer hold. Nothing on the
wire or in the daemon changes: a move is the existing rename, whose refusals (into itself, 400; a
taken name, 409) are `renameOf`'s (`workspace/service.ts:669`).

- **A move is a rename into a folder.** `moveInto` (`files/moving.ts:40`) gives the new path, nothing
  to do when the folder is the one the entry sits in (`parentOf`, `:29`), or a refusal when the folder
  is the entry or under it. `moveEntry` (`:60`) calls `renameEntry` and then `followRename`, as a
  rename does, so open tabs and their edits follow; a refusal rejects with the daemon's sentence.
- **Drag.** Each row on disk is draggable (`dragProps`, `files/FileTree.tsx:74`) and carries its path
  as `application/x-conductor-path` (`MOVE_MIME`, `moving.ts:26`), plus `text/plain` for Firefox, as
  `spawn/reorder.tsx` does. Folder rows and the section's heading (the top, `route.tsx:719`) are
  targets (`dropProps`, `FileTree.tsx:90`); a file row is not. `canDrop` (`moving.ts:51`) takes only
  that MIME from a drag that started in the same section, so a project's drag in the navigator
  (text/plain only) is never taken for one, and it refuses the entry's own folder and anything under
  the entry. The drag is held per section (`route.tsx:599`); the dragged row fades and the target is
  marked (`dragMark`, `FileTree.tsx:110`, theme tokens in `files.css:1227`). A taken name shows the
  daemon's sentence under the target folder (`moveErrorFor`, `FileTree.tsx:291`) until the next verb
  or drag. After a move the target folder is opened down to (`openDown`, `route.tsx:612`).
- **Move to… from the keyboard.** A `→/` button beside ✎ and ⌫ (`FileTree.tsx:263`) opens the name
  box (`NewFileForm` kind `move`, `NewFileForm.tsx:51`) in the row's place, prefilled with the folder
  it sits in, selected (`prefillMove`, `naming.ts:103`); empty or `.` is the top
  (`checkMoveFolder`, `:113`), and the same folder closes the box with nothing sent.
- **The navigator renames and deletes.** A file or folder row on disk under a folder node has ✎ and ⌫
  (`EditButtons`, `shell/Navigator.tsx:284`; F2 and Delete or ⌘⌫ on the row, `editKeys`, `:311`). ✎
  opens the Files tree's own name box (`RenameForm`, `:319`), which calls `renameEntry` and
  `followRename` (`:490`); ⌫ opens the Files tree's `DeleteConfirm` (`DeleteForm`, `:333`), which
  closes the deleted tabs with `closeDeleted` as on Files. One box at a time per folder node, a +
  included. The folder node's root has none, as on Files; a row shown only because it was deleted
  (`onDisk`, `files/deleting.ts:138`) has none either. Only the file and folder rows change.

*Not done / not decided.* No drag in the navigator, and no keyboard shortcut for Move to… (it is a
button in the tab order). A folded folder does not open while a drag hovers on it, so a move into a
folder deep down is Move to…, or a drag after opening it. The navigator's open folders are not
carried over a rename of one. Not looked at in a browser in either theme, nor a drag in Firefox.

*Verified.* `files/verify.ts` (`:853`): the drop rules (into itself and anything under it refused, the
folder it sits in a no-op, a file row no target, a text/plain-only drag and no drag both refused);
the drag carries the MIME and text/plain; dragover and drop accept and refuse as the rules say; the
Move to… button, box, prefill and top; the marks and the refused message under its folder and at the
top; with a stubbed daemon, a move posts the rename and the tab and its edit follow, a 409 rejects
with the daemon's sentence, and into-itself or staying sends nothing. `shell/verify.ts` §13 (`:543`):
the navigator's file and folder rows have ✎ and ⌫, the folder node and a deleted row have none, they
reuse `renameEntry`, `followRename` and `DeleteConfirm`, and a project's drag ignores a file's.
`workspace/verify-files-verbs.ts` (`:226`): a file and a folder moved into a subfolder, and a move
onto a taken name refused with 409 and both left as they were. `make test` green.

### Amendment 164 — post-merge, applied. **An orchestrator's auto turns start folded, so its page opens to its own replies; one you open stays open, and fold all reaches them.**

Web only (`agent/folds.ts`, `agent/transcript.tsx`, `agent/agent.tsx`, `agent/verify.ts`, `settings/route.tsx`), and
`docs/MANUAL.md`, `TODO.md`. No daemon, wire or migration change; the daemon's hand-off and report
text is as it was. The user, 14 Oct 2026, on wave 11's items O2 and O3: *"O2 is accepted as it is. The
orchestrator keeps its tools, and there's no lane for it."*, leaving O3 (wave-11.md §3 G): fold the
orchestrator's long text by default. *Amends Amendment 18*, under which every fold was one you made
and replies always arrived open: that still holds everywhere except the auto turns of an
orchestrator, which start folded. *Amends Amendment 33*, whose **auto** turn was a label only and now
folds like a reply, and *Amendment 51*, whose helper reports arrive as those auto turns.

- **An auto turn folds** (`transcript.tsx:534`). `AutoTurn` is the you-turn Conductor sent
  (`synthetic`); its **auto** label is the fold button, as an agent's name is on a reply, and folded
  it shows its first line and "N lines" (`foldLine`), as a reply does. Its key is `u${seq}`, the
  turn's own key. `replyKeys` (`:571`) now lists them with the `a${seq}` replies, so **⌃ fold all** and
  its anyOpen test cover them. Your own typed turns don't fold and are unchanged.
- **Which ones start folded** (`transcript.tsx:579`, `agent.tsx:516`). `startFoldedKeys(turns,
  orchestrator)` is every auto turn when `orchestrator`, else none; `agent.tsx` passes it to
  `Transcript` as `startFolded`. An orchestrator is an agent with `helperCap > 0`: that is exactly
  the condition under which the daemon sends a helper report (`#takeHelperReport`, `if
  (!agent?.helperCap) return ''`), so it's the agents whose auto turns are long. `marksOrchestrator`
  (shared `stack.ts:368`) wasn't used: it needs pipeline roles and a stack of two, and misses
  Amendment 51's orchestrator without roles.
- **A default fold you open stays open** (`folds.ts:83-121`, `:181-186`). The fold state is two
  sets of the same shape and bounds, per agent: `conductor.agentFolds` (unchanged: the folds you
  made on turns that start open) and `conductor.agentUnfolds` (new: the turns you opened that
  started folded). `shownFolded(s, id, key, byDefault)` reads the one that applies; `toggleFold`
  writes it; `foldEvery` folds every key, by adding to `folds` and taking the started-folded ones
  out of `unfolds`; `unfoldEvery` clears `folds` and puts every started-folded key in `unfolds`.
  `updateFoldState` writes only the sets that changed. The old key is read as before, so there is
  nothing to migrate; a non-orchestrator's folds use `folds` alone, which is Amendment 18 as it was.
- **A `start_helper` line shows its task** (`transcript.tsx:289`). `inputSummary` picks `task` after
  `prompt`, so `mcp__conductor__start_helper` reads as the task given, not the input's JSON.
- **Settings' reset returns every turn to how it starts** (`settings/route.tsx:950-953`). "unfold
  every reply" clears `conductor.agentUnfolds` as well as `conductor.agentFolds`, so an
  orchestrator's auto turns fold again after it; it now says "Every turn is back to how it starts."

*Not done / not decided:* not looked at in a browser. Every auto turn in an orchestrator starts folded, not only its helpers' reports (a
continue or a hand-off note too): they are the same turn on the page, and the spec asks for "auto
turns". The tool row's name is still the raw MCP name; only its subject changed.

*Verified:* `agent/verify.ts` "an orchestrator's auto turns start folded" (20 checks) renders a
`Transcript` with `renderToStaticMarkup`: an orchestrator's auto turn renders folded to its first
line with "4 lines" and none of its body, and its own reply open; a non-orchestrator's renders open
and still folds; one opened with `updateFoldState` renders open, while the same key on another
agent is still folded; fold all folds the reply and both auto turns (three `aria-expanded="false"`,
no markdown body) and unfold all opens them; a `start_helper` line's subject is its task. With
`'task'` taken out of `inputSummary`, the `u` keys taken out of `replyKeys`, `startFoldedKeys`
returning none, or `shownFolded` ignoring `byDefault`, those checks fail; restored, they pass.
`tsc --noEmit` in `packages/web` is clean and `make test` is green: 28 PASS.

### Amendment 163 — post-merge, applied. **A Claude run's own context window is kept, under the model's alias and its full id, and every window outlives a restart, so the hand-off cap uses the real one from the first run on.**

Daemon (`session/windows.ts`, `session/backends/claude.ts`, `index.ts`, `session/verify.ts`, migration
`270_model_windows.sql` new) and `docs/MANUAL.md` (§ the hand-off, one paragraph). No wire, shared or web
change. TODO.md, "Hand-off, windows and roles (120, 126)", found 10 Oct and planned on 14 Oct as wave 11
lane H1 (`docs/plans/wave-11.md` §4 M): "The model-window registry is in memory (`session/windows.ts`).
After a restart a resumed stack uses the floor table until a model list is asked for. Claude's result
carries `modelUsage[model].contextWindow`, which would fill it from the `result` case in
`session/backends/claude.ts`." On 15 Oct the user wrote "Run track 5 of `docs/plans/wave-11-tracks.md`".
*Amends Amendment 120*: its registry was filled only by the model lists and held "what the daemon has heard
since it started". Now a Claude result fills it too, a run's window wins over a list's, and it is kept in
the database. `handoffCap`, `contextWindow`, the floor table and the `[1m]` rule are unchanged.

- **From each result.** The Claude backend's `result` case calls `recordRunWindows('claude', modelUsage,
  model)` right after the Metrics record (`backends/claude.ts:668-674`), with the agent's model as the run
  has it (`#scope.model`, which a model switch updates, `:750`). It is in a `try`: a window is never worth
  ending a run over, as with `#record`.
- **Under which names** (`windowsFromResult`, `windows.ts:101`, pure). Each `modelUsage` entry's
  `contextWindow` is kept under its `canonicalModel` (else its key) and under the key when that differs, and
  under the agent's own model when that is an alias that names the entry as `matchModel` does
  (`metrics.ts:165`: `opus` names `claude-opus-4-7`). The supervisor looks the window up by the agent's model
  (`#handoffCapOf`, `supervisor.ts:1158-1160`, unchanged), so an agent launched on `opus` finds the window
  its own run reported. `default`, or an alias that names none of the entries, adds no name. Other models a
  run used (a subagent's) are kept under their own ids.
- **`[1m]` is still not looked up** (`reportedWindow`, `windows.ts:150-152`, as before), and now not
  recorded either. A `[1m]` key is skipped, and so is the entry a `[1m]` agent model names (`:116-118`),
  because its window is the 1,000,000 one and would be given to the base id.
- **A run's window beats a list's** (`keep`, `windows.ts:57-61`). **Decision:** the result's `contextWindow`
  is the window that run had, and a list says what the model can take. For Claude these can differ: the
  gateway's `max_input_tokens` can be the 1M window, while Claude Code runs the base one unless asked for
  `[1m]`. So a list never overwrites a window a run reported, and a run always overwrites a list's or an
  earlier run's. For Copilot and OpenRouter only the lists write, so nothing there changes.
- **Kept across a restart** (migration 270). `model_windows (provider, model, tokens, source, updated_at)`,
  key `(provider, model)`, `source` `list` or `run`. `initWindows(db)` (`windows.ts:137`) loads it and keeps
  the handle, and the daemon calls it at startup beside `initEventLog` (`index.ts:100-102`). From then on
  `keep` upserts each window that changed. One that is the same, from the same source, is not written again,
  so a result doesn't write the database every turn. A failed write is logged, and the window is still kept
  in memory. Without `initWindows` (a test that never calls it) the registry is in memory only, as before.
- **The writers keep their signatures.** `recordWindows(provider, models)` is unchanged for its three callers
  (`copilot.ts:227`, `:250`; `models.ts:290`), and they now persist too. `reportedWindow` is unchanged for
  the supervisor, and for H2 (track 2) when it reads the registry. `forgetWindows` (verify only) clears the
  table as well.
- **The MANUAL** (`docs/MANUAL.md:555-564`) says a Claude run's window counts and wins over a list's, and
  that the windows are kept across a restart. Its line saying the daemon forgets them until Spawn is opened
  is gone.

*Not done / not decided:* the window is learned when the first run on a model ends. That run's own
launch prompt, and any agent started before it ends, still use the list's window or the floor. So "from
the first run on" means from the first result, and then for good, restarts included. A window stays until
a later result or list (where allowed) changes it. Nothing ages out, and a model that is gone keeps its
row, which costs one row. An alias whose model changes (a new `opus`) takes the new window with the next
result on it. Tokens are still not counted (Amendment 120; H2 measures the ratio). Not looked at on a real
model: wave-11.md §5 lists "the H1 windows" among the person's checks after wave 3.

*Verified:* `daemon/src/session/verify.ts`. Pure, beside 120's checks (`:2715-2754`): the canonical id, the
key and the alias are kept; an exact id is not kept twice, and `default` or a non-matching alias adds no
name; `[1m]` is not kept, under a `[1m]` key or for a `[1m]` agent's base id; junk is skipped; a run beats a
list, and a later run beats an earlier one. Live, in §21 (`:5328-5405`): an agent launched on the alias
`tinyrun-h1` ends with a `modelUsage` keyed `claude-tinyrun-h1-20261015` (canonical `claude-tinyrun-h1`,
`contextWindow` 2,000), a helper model and a `[1m]` entry. The window is then kept under all three names,
the helper's under its own, and the `[1m]` one not at all. A model list after it doesn't overwrite it. The
rows are in `model_windows`, read from the file on a fresh connection with their sources. The same window
again doesn't change `updated_at`. `initWindows` on that fresh connection, the restart, has every window
back before any list is asked for, and a window only in memory is gone. A downstream agent on the alias is
then given a quarter of 2,000 tokens (the newest of 40 replies, under 3,500 characters), not the floor. The
model-list checks of 120 in §21 pass unchanged, now with the table attached. **Revert check:** with the
`recordRunWindows` call removed from `claude.ts` and `initWindows` made to load nothing, 5 of the live
checks fail: the alias and full id read `undefined undefined undefined`, the list check fails, the table
check fails, the restart check reads "0 loaded", and the downstream prompt is 5,306 characters. Restored,
the session verify passes (1,462 checks). `pnpm -r typecheck` is clean, and `make test` exits 0 in one run, 28 suites PASS ("Track A session: PASS", "docs links: PASS — 33 links in 47 files").

### Amendment 162 — post-merge, applied. **Branches shows every repo Files shows: the project's own folder, its extra directories that are repos, and the repos nested in either, picked in the header.**

Daemon (`workspace/project-repo.ts`, `routes/branches.ts`, `workspace/verify-branches.ts`), shared
(`src/wire.ts`), web (`branches/endpoints.ts`, `branches/rules.ts`, `branches/route.tsx`,
`branches/verify.ts`) and docs (`docs/MANUAL.md`, `TODO.md`). The user, 14 Oct 2026: "Execute …
docs/plans/wave-11.md … following §0"; this is the plan's lane I2, item N4
(`docs/plans/wave-11.md:516`), run as track 3 of `docs/plans/wave-11-tracks.md` on 15 Oct.
*Amends Amendment 109*, whose Branches screen opened only `project.path`; *Amendment 144*, whose
`projectRepo` is unchanged and still what `session/finish.ts` merges in; and *Amendment 156*, whose
`rebasedSincePush` was already keyed by the repo's root (`branches.ts:121`, `:444`), so a rebase in
one repo never marks a same-named branch in another.

- **The choices** (`projectRepos`, `project-repo.ts:165`): `project.path` first, then each extra
  directory that is a repo, then the repos nested in either, from Files' own `buildTree`
  (`tree.ts`, unedited; nested up to four deep), named `<dir>/<rel>`. A repo is listed once, by
  the real path of its top level, so an extra directory inside the project's repo is that repo.
  `BranchesResponse` gains `repo?` and `repos?: BranchRepoChoice[]` (`wire.ts:955`, `:961`, `:965`).
- **`?repo=`** on GET, POST and the preview (`routes/branches.ts:75`, `:85`, `:98`), resolved by
  `projectRepoOf` (`project-repo.ts:198`). Absent, empty or the project's own folder opens it as
  before (`openOwn`). Anything else must match a choice by real path, so a symlink, `..`, a plain
  sub-folder, another project's repo, a missing or a relative path are a 400, "not one of
  <project>'s repos" (`:211`), and nothing runs. GET and POST answers name the repo and list the
  choices (`stamped`).
- **Another repo** (`openOther`, `project-repo.ts:131`) has no jobs, no chosen target and no
  default branch: it is drawn against origin's default, else what it has checked out, else main or
  master (`resolveTarget` with the checked-out branch as the recorded one), and `set_default` is a
  400 (`:137`). Its checked-out branch is live while an agent that can reach the repo is live, so
  pull, rebase, merge into it, delete and the rest refuse it with the same 409 as a job's branch
  (`refuseLive`, `branches.ts:504`). Which agents reach it (`reachedByAll`, `project-repo.ts:82`):
  every agent is given the project's extra directories whatever its job's isolation
  (`Supervisor.#reachable`, `supervisor.ts:692`), so for a repo that is, is in, or holds an extra
  directory, any live agent of the project counts; for a repo nested only in `project.path`, a live
  agent of an `in_place` or `branch` job, which works in that folder. A `worktree` job's agent is
  given its worktree and the extra directories, not `project.path`, and its checkout holds no nested
  repo (they're untracked), so it doesn't count there. Every action locks and runs in that repo's
  root, against its own remote; nothing else changes.
- **Web.** `endpoints.ts` adds `?repo=` to all three requests. `rules.ts:361-385` adds `ownRepo`,
  `repoChoices` (none for one repo), `repoParam` (none for the own folder) and `ownersIn` (no jobs
  outside the own folder). `route.tsx:283` puts a **repo** picker (`RepoPicker`, `:453`) first in
  the header; the repo picked is kept while you stay on the project, and another project starts from
  its own folder on its first read: the repo and the choices are kept with the project they were
  picked in (`:196-204`), so a switch never asks for the old project's repo. The choices are the last listing's, so the picker stays when a repo can't
  be read. In another repo, **compared with** is a plain line, the root line is hidden, and **Make
  default** and its check-out are gone (`:285`, `:703`).
- **Docs.** `docs/MANUAL.md` gains "Branches in another repo" after "Pull and rebase a branch", and a
  sentence in the Branches row of the screens table.

*Not done / not decided:* compared with and Make default are for the own folder only, as is the
setting `branchTargetKey`; nothing new is persisted. A project whose own folder isn't a repo still
gets its 400 with no listing, so the picker can't reach the repos inside it. In the own folder,
nothing changes: an extra directory inside the project's repo is that repo, and a worktree job's
agent writing there doesn't make its checked-out branch live, as before. Every
listing (GET, and the one POST returns) now walks each project directory with `buildTree`, as Files
does; a large tree costs that on every redraw.

*Verified:* daemon `verify-branches.ts` section 15 (`:1087`), on a repo with a nested clone (with
its own origin, a worktree and a repo nested in it), an extra directory that is a repo, one that
isn't but holds one, and one inside the project: the listing names its repo and the choices, in
order and deduped; each repo lists its own branches, and same-named branches stay separate; another
project's repo, a symlink, `..`, a sub-folder, a plain folder, a missing and a relative path are 400s
on GET, POST and the preview, touching nothing; an empty `?repo=` is the own folder; a merge in the
nested repo moves only its branch, and its push reaches only its origin; its rebase marks only its
branch rebased; `set_default` there is a 400; `projectRepo` still opens the own folder; and a live
in-place agent makes the nested repo's checked-out branch live (merge into it, 409); a live agent of
a `worktree` job makes the extra-directory repo's and the one nested in a plain extra directory's
checked-out branch live (pull, rebase and merge there, 409), and not the repo nested only in the
project's folder. Daemon: 243 checks
PASS. Web `branches/verify.ts` section 12 (`:445`): the rules, the three requests' `?repo=`, the
picker, its default and reset (kept with the project, so a switch reads the new project's own
folder first), and what another repo hides; section 7's preview check accepts the new
argument. `pnpm -r typecheck` clean; `make test`: 28 PASS (rerun once: port 3143 was taken). Review follow-up: `make test` 28 PASS (rerun once: Track C's watcher author check timed out, then passed alone twice).

### Amendment 161 — post-merge, applied. **Each stage of a pipeline hears every earlier stage's summary, not only the one before it.**

Shared (`stack.ts`), daemon (`session/handoff.ts`, `session/supervisor.ts`, `session/verify.ts`) and
`docs/MANUAL.md`. The user, 15 Oct 2026: "Run track 2 of `docs/plans/wave-11-tracks.md`"; this is the
plan's lane L1 (wave-11.md §4, "N9: each stage sees every earlier stage's summary"), with *Decided (14 Oct):
ancestors appear as their summaries*, and §6: "Ancestors appear as summaries, 'via <role>', within the cap."
*Amends Amendments 101, 104 and 120*: 101 had a chain A, B, C hand C A's part only inside B's launch prompt,
which is the oldest text and the first the cap drops; 104 printed every summary whole, outside the cap, and
only for the agents waited on directly; 120 found a chain had nothing to drop. An agent sees more in its first
prompt and its re-run note; nothing on a screen changes.

- **`ancestorsOf(agents, agentId)`** (`shared/src/stack.ts:122`, pure, beside `createsCycle`, and walked the
  same way). Everything the agent waits on, directly or however far up, each once, in topological order: one
  comes after every one it waits on, so the furthest is first. Each is an `Ancestor` (`:110`) with `via`, the
  agent's own dependency that leads to it (the first in `dependsOn` that does; itself for a direct one). An
  agent's own helpers are not walked (they report to it, not to the stage after it, Amendment 51), an id no
  agent has is left out, and a loop ends.
- **Further up, by the summary alone.** `Upstream.via` (`handoff.ts:246`): an upstream that is not one the
  reader waited for. It has no turns (`turnsOf`), its heading is `[role, via <role>]` (`head`, `:374`), and its
  body is its summary only (`viaBody`, `:385`), never "(It finished without a written reply.)".
- **Within the cap.** Its need is its summary as set down (`viaCost`, `:382`), shared out with the
  conversations by `shareCap` (`:424`). Over its share it keeps the beginning and says `… (the last N
  characters of its summary are left out to fit)`, or `(Its summary, N characters, is left out to fit.)` with
  no room at all. The summaries of the agents waited on directly are still whole and outside the cap
  (Amendment 104).
- **Said once.** In its own voice the ancestor says its summary, so `dropRepeats` (Amendment 120) takes the
  copy quoted in the next stage's launch prompt out and leaves the marker; in a diamond both quotes go and
  the one part stays. When any upstream is further up, the opening adds: *The agents further up, marked "via"
  the agent that waited for them, are given only by their summaries.* (`:429`), in the singular with one
  ("The agent further up … is given only by its summary."); "the agent" / "the agents" before it counts only the
  direct ones.
- **The supervisor.** `#furtherUp(agent)` (`supervisor.ts:1656`) turns `ancestorsOf` into those upstreams, each
  with its role, its summary from `getHandoff` and `via` the role it came through, leaving out the direct ones,
  any that never handed off, and any it was started without (`getWentWithout`, Amendment 88). `#promptFor` puts
  them first, oldest first, then the direct ones as before, then the ones it was started without, marked
  stopped (`:1186`). `#takeRerunNote` puts them before its direct ones the same way (`:2203`), so a re-run note
  says what a first prompt would.

*Not done / not decided:* an ancestor that never handed off (a person released it, or it predates
Amendment 104) is left out rather than given by its last reply. An agent it was started without is not walked
further up: removing one rewires its waiters to what it waited on (Amendment 88), so those are direct. One
stopped but not removed (`#goWithout`) leaves the resumed agent's `dependsOn`, yet can still be reached through
another live dependency (X went without S; T, which X waits on and which had already started, still waits on S);
`#furtherUp` leaves it out by id, so neither the first prompt nor the re-run note gives it "via". An
orchestrator's helper report is unchanged. `docs/adr/0001-preset-stacks.md` still says what it says about
transitive handoff; track 6's lane D4 corrects that ADR.

*Verified:* `session/verify.ts` §17 (`:2767`, the block "each stage hears every earlier stage's summary"),
against the real supervisor and the fake SDK: in architect → developer → scribe, the developer hears the
architect as before and nothing "via"; the scribe holds the architect's summary once, under `[architect, via
developer]`, before the developer's part, with the developer's quote of it left out; re-run from the
developer, the scribe's re-run note holds it once the same way. Pure: a diamond gives the shared ancestor's
summary once and both quotes go; four sharing 3,000 characters take 750 each and three ancestors' summaries
are cut with the line, the direct summary whole; with room every one is whole; with none it says so; `rerunNote`
carries the same section; with two further up the opening says "agents", with one "agent". In §17o (`:4205`,
"Further up and gone without"): X went without S, still reached through T; X's first prompt gives S once, marked
stopped, and only the analyst further up "via" T, and its re-run note has the same "via" parts and no S.
`ancestorsOf` in §17p (`:4267`): a chain, a diamond (`a<b b<b c<c`), a direct one also further up another,
helpers and a missing id, a loop. With `#furtherUp` returning nothing the chain and re-run checks fail; with it
not leaving out the ones gone without, both §17o checks fail. `pnpm -r typecheck` clean; `make test` green.

### Amendment 160 — post-merge, applied. **Copilot and OpenRouter keep the effort chosen, and Spawn shows plan mode as "ask me" before launch: nothing is lost, so the open question is closed.**

Docs only (`CONTRACT.md`, `TODO.md`, `docs/plans/wave-11.md`). No code changed in `web`, `daemon` or `shared`,
and `docs/MANUAL.md` is unchanged because nothing visible changed: § Copilot and OpenRouter already says
"**No plan mode.** **plan first** is hidden, and a preset that plans first asks you instead", and its effort
paragraph holds. The user, 14 Oct 2026, wrote wave-11.md §8's open question "Whether non-Claude engines drop
effort or plan (`engine.ts:37-51`, suspected; Amendment 147 traced Claude only)". On 15 Oct they wrote "Run
track 5 of `docs/plans/wave-11-tracks.md`". This is lane X1. *Amends nothing*: it confirms Amendment 80
(an engine shows only what it can do, and a plan it lacks is sent as "ask me") and extends Amendment 147's
trace to the other engines. Both engines run on one `CopilotBackend` (`session/backends/index.ts:48`,
`:56`), so one trace covers both.

- **What the engines say.** `GET /api/providers` sends each engine's `capabilities`
  (`routes/session.ts:914`). For Copilot and OpenRouter that is `COPILOT_CAPABILITIES`
  (`backends/index.ts:41`): `effort: true`, `planMode: false`. Both flags match what the backend does.
- **`effort: true` is true.** `#config`, which is given when a session is created and on every resume, passes
  `reasoningEffort: autonomy.effort` when one is set (`backends/copilot.ts:401`). `setModel` passes it again
  (`:706-707`). The SDK's `ReasoningEffort` uses our five words, `low` to `max` (`@github/copilot-sdk` 1.0.16
  `types.d.ts:1609`; ours is `shared/src/wire.ts:160`), so nothing is mapped and nothing is rounded.
- **`planMode: false` is true.** Claude's **plan first** reads, writes a plan, and then waits for your
  approval. The Copilot gate has nothing to approve: its `plan` only reads, for the whole run
  (`gateCall`, `copilot.ts:301`). The SDK's own plan mode (`session.rpc.mode.set`,
  `onExitPlanModeRequest`) is a different mechanism and is not wired (`docs/plans/multi-provider-findings.md:31-37`).
  Claiming plan mode would promise an approval step that never comes.
- **Spawn, what is sent.** `specsOn` (`spawn/engine.ts:56`) passes every spec through `autonomyOn` (`:62`),
  and every listed role of an orchestrated stack too (`:66-68`). `autonomyOn` keeps the effort where the
  engine has it (`:51`) and sends a mode the engine lacks as `default` (`modeOn`, `:37-39`; `:47`). A reading
  role that plans on Claude (`rowAutonomy`, `presets.ts:459`) asks on Copilot. Spawn won't launch on another
  engine until it knows that engine's capabilities (`engineReady`, `route.tsx:452-453`), so an unknown
  engine's `NONE` (`lib/providers.ts:29`, `:48-56`) is never what launches.
- **Spawn, what is shown.** Spawn offers **plan first** only where the engine has it
  (`MODES.filter(offersMode)`, `route.tsx:1042`). The pill pressed is `shownMode = modeOn(mode, caps)`
  (`:259`), so after switching to Copilot from a Claude plan, **ask me** is the pill pressed. The resolved
  panel shows the `permissionMode` and the effort that will be sent (`:1160-1162`). The effort row is shown
  where `has.effort` (`:1124-1127`), which is both engines. The row note (`rowOverrides`, `presets.ts:489`)
  names a mode only when a role's mode differs from the one pressed. Together, the pressed pill and the row
  note describe what runs, before launch.
- **The daemon keeps them.** `parseAutonomy` keeps a known mode (`routes/session.ts:97-99`) and a known effort
  (`:108-112`), for an agent, a listed role (`parseHelperRoles`, `:223`) and an added agent (`parseAgentSpec`,
  `:289`). `autonomyFor` (`:132-138`) checks only the budget's unit, never the mode or the effort. The
  supervisor stores what was sent (`supervisor.ts:186`) and starts the agent's own engine with it
  (`createBackend`, `:1247`; `autonomy`, `:1257`).
- **"+ agent".** `addAgentSpec` (`spawn/stack.ts:185`) copies a sibling's autonomy (`addedAutonomy`, `:117`).
  That autonomy was already converted at launch, so it has no plan on Copilot and keeps the effort. It sends
  the job's engine (`:199`). With no sibling, it uses Spawn's defaults (`:125`), the same as on Claude. A
  reading role keeps plan only if its sibling had it (`:130`), which on Copilot it didn't.
- **A helper an orchestrator starts.** `start_helper` (`routes/helpers.ts:164`) calls `startHelper`
  (`supervisor.ts:1766`). The helper takes the orchestrator's autonomy (`:1790`) or the listed role's
  (`:1795`), both converted by `specsOn` at launch, checked by `readOnlyRefusal` (`:1797`;
  `shared/src/stack.ts:181-189`, which accepts `plan` or `default`). It runs on the orchestrator's engine
  (`:1837`).
- **After launch.** The agent screen's composer offers plan only where the engine has it, or where the agent is
  already in it (`offersMode`, `lib/providers.ts:64-65`; `agent/composer.tsx:621`). It shows effort where
  `has.effort` (`:644`). A change goes through `POST /api/agents/:agentId/autonomy` (`routes/session.ts:889`)
  and applies from the agent's next run (`supervisor.ts:2262-2269`), and that run's resume carries the new
  effort (`copilot.ts:401`).
- **What the daemon doesn't strip.** A request made outside Spawn can still send `plan` to Copilot. It is
  kept, and the gate holds it to reads (`copilot.ts:301`): stricter than asked, never looser.

*Not done / not decided:* Spawn and the composer offer all five efforts for any model, on every engine,
Claude included. Copilot's model list says which efforts each model takes (`efforts`, `copilot.ts:231`) and
OpenRouter's says nothing. An effort a model doesn't take is a problem with that model, not with the engine.
The SDK's runtime has messages that refuse it ("Reasoning effort '…' is not supported for model '…'"), so it
should fail at the run rather than run at another effort. That was not tried live, which needs a Copilot
login. It is an open TODO entry and is not fixed here. When an agent has no effort set (one added to a job
with no sibling), the composer presses **high** (`DEFAULT_EFFORT`), though the SDK applies its own default.
This happens on every engine, as it does today.

*Verified:* by reading the code at `ac31a29`, path by path, as above. The checks that already pin this pass
unchanged. In `web/src/spawn/verify.ts` §15: 'plan mode, which it lacks, is sent as "ask me"' (`:739`),
"effort and helpers, which it has, are kept" (`:740`), "an engine that can do nothing: no effort, no
helpers…" (`:745`), and the listed roles off Claude (`:1320-1321`). In `daemon/src/session/verify.ts`: the
capabilities are the findings (`:3754`), and the gate's modes, where plan only reads (`:3352`). No check
was added, because no code changed. `make test` exit 0 in one run, every suite PASS ("Track A spawn: PASS", "Track B agent: PASS", "docs links: PASS — 33 links in 47 files").

### Amendment 159 — post-merge, applied. **The three label backdrops carry more chroma, sit 1.06:1 apart in lightness and 60° apart in hue, in both themes.**

Shared (`tokens.css`) and web (`lib/verify.ts`), and `docs/MANUAL.md`, `TODO.md`. No behaviour, wire
or daemon change, no migration, no new token. The user, 14 Oct 2026, on wave 11's item U1 (lane H,
"make the three backdrops easier to tell apart"): *"more chroma and a hue check. Violet `--you` stays,
and no new backdrops are added"*; §6: "More chroma, floor 1.06, hues ≥ 60° apart". *Amends Amendment
127*, which chose `--here-project` and `--here-agent` and set the floor at 1.04:1 with no check on
hue, and answers the question it and Amendment 135 left ("say if … too alike once seen") with
numbers; the person still looks.

- **New values** (`tokens.css:65`, `:74-75` dark; `:162-164` light). Old → new, with OKLCH
  lightness L, chroma C and hue H:

  | token | dark | light |
  |---|---|---|
  | `--here` (slate) | `#1f3047` L .306 C .048 H 256° → `#1c2e55` L .308 C .074 H 264° | `#d6e0f0` L .904 C .024 H 260° → `#d4e1fb` L .908 C .038 H 264° |
  | `--here-project` (petrol) | `#002a35` L .264 C .048 H 220° → `#002e30` L .274 C .047 H 199° | `#c4ecf9` L .919 C .045 H 220° → `#acf4f7` L .921 C .071 H 199° |
  | `--here-agent` (wine) | `#4d283e` L .334 C .064 H 345° → `#591e43` L .339 C .098 H 345° | `#f5cfe3` L .892 C .050 H 345° → `#fccde6` L .896 C .062 H 345° |

  Lightness stays where it was (L within .01 in each); chroma goes up by about half, except the
  dark petrol.
- **The dark petrol is as saturated as sRGB has it.** `#002a35` already had red at 0, the edge of the
  gamut; at that darkness a blue-green can't reach more than about C .046-.050 between 199° and
  220°. So it gains distance by hue instead: it moves from 220° to 199°, 36° → 64° from the slate,
  which is what the slate and petrol lacked (they were the closest pair). Its light twin gains
  chroma (.045 → .071).
- **Hues, pairwise, dark / light**: slate-petrol 36° / 40° → 65° / 65°; slate-wine 88° / 85° → 81° /
  81°; petrol-wine 124° / 126° → 146° / 146°. The status hues are `--fail` 31°, `--need` 72°, `--done`
  133°, `--live` 174°, `--queue` 250°, `--you` 298°; the petrol at 199° sits between `--live` and
  `--queue`, 25° from `--live` but at a third of its OKLCH lightness, and the slate moves 8° further from
  `--queue`'s blue-grey, not toward `--you`.
- **Lightness ratios, dark / light** (WCAG luminance): `--here`-`--here-project` 1.137 / 1.059 →
  1.096 / 1.067; `--here`-`--here-agent` 1.074 / 1.058 → 1.076 / 1.063; `--here-project`-`--here-agent`
  1.221 / 1.120 → 1.180 / 1.135. The order is kept: in dark petrol is darkest and wine lightest, in
  light the other way round. The two light pairs that were under 1.06 are over it now.
- **Ink on the three, dark** (`--ink` / `--ink2` / `--ink3`): `--here` 10.85 / 6.58 / 4.91;
  `--here-project` 11.90 / 7.22 / 5.38 (was 12.33 / 7.48 / 5.58); `--here-agent` 10.08 / 6.12 / 4.56
  (was 10.10 / 6.13 / 4.57). **Light**: `--here` 13.30 / 7.40 / 4.91 (was 13.15 / 7.31 / 4.85);
  `--here-project` 14.20 / 7.90 / 5.24 (was 13.93 / 7.75 / 5.14); `--here-agent` 12.51 / 6.96 / 4.62
  (was 12.43 / 6.91 / 4.59). `--ink3` on the dark wine is the tightest, at 4.56, 0.01 under where it
  was; the 4.5 floor on it is what caps the dark wine's lightness, and so the whole spread.
- **The checks** (`lib/verify.ts` section 9, "both themes are readable"): the pairwise floor is
  1.06:1 (`:508`, was 1.04). New: each backdrop has an OKLCH chroma of at least 0.03, so its hue is a
  hue and not a grey's noise (`:512`; the old light `--here`, C .024, fails it), and any two are at
  least 60° apart in OKLCH hue, the short way round the wheel (`:518`). `oklch` (`:437`) is Ottosson's
  OKLab from linear sRGB. The "not a status colour (or `--you`)" and the 4.5:1 ink checks are as they
  were.
- **The crumb border, revisited and kept** (`shell/ui.css:33`, `color-mix(in srgb, var(--crumb) 60%,
  var(--ink3))`). Measured against its backdrop it is 1.94 / 1.98 / 1.84 in dark (was 1.95 / 1.98 /
  1.89) and 1.73 / 1.75 / 1.70 in light (was 1.71 / 1.75 / 1.69), and the mix now carries a little of
  each backdrop's hue. So it still draws the same line, and `ui.css` and `verify-crumb.ts` are
  unchanged. A new check in section 9 (`:554`, beside the top-bar tab's) recomputes the mix as
  `color-mix` does in sRGB and fails under 1.6:1 on any backdrop in either theme.
- **The MANUAL** (`docs/MANUAL.md:941`, §4 after the top-bar tabs) says what the three backdrops
  are, where each shows, that they are apart in hue and a little in lightness, and that `make test`
  fails if two come too close.

*Not done / not decided:* not looked at in a browser, in either theme; the person confirms they are
distinct at a glance (wave-11.md §5, "U1 in both themes"). The colours were chosen by computing
OKLCH, not by eye. No backdrop was added and `--you` is unchanged, as decided. The chroma floor of
0.03 is this lane's own, to make the hue check mean something; the spec asked only for the 60°.

*Verified:* with the old six values put back in `tokens.css`, section 9 failed 4 checks: dark hues
"--here 256° and --here-project 220°"; light floor "--here and --here-project 1.059; --here and
--here-agent 1.058"; light chroma "--here C 0.024"; light hues "--here 260° and --here-project 219°".
With the new ones every check in section 9 passes in both themes, `lib/verify-crumb.ts` passes
unchanged, `pnpm -r typecheck` is clean and `make test` is green: 28 PASS. Earlier runs stopped on
the daemon's fixed test ports (`EADDRINUSE` on 7799, 7801; 3143 held on IPv4) and two fs-watcher
checks under a load of 15, while other tracks ran their own tests; none of it touches this lane.

### Amendment 158 — post-merge, applied. **A nested repo's changes show as its own: badges, roll-up and diffs inside `inner/`.**

Daemon (`workspace/changes.ts`, `workspace/git.ts`, `workspace/service.ts`, `workspace/tree.ts`,
`workspace/watcher.ts`, `workspace/verify.ts`) and docs (`docs/MANUAL.md`,
`docs/adr/0003-wave-7-visibility.md`, `TODO.md`). This lane came from analysis, not from the user: it
is docs/plans/wave-11.md §3 E2 (N5), run as track 4 of docs/plans/wave-11-tracks.md on 15 Oct 2026.
*Amends Amendment 90*, whose bullet "Changes stay the outer repo's own, by design (ADR 0003)" said a
nested repo's own changes don't show, and closes the gap ADR 0003's Consequences left open. Nothing on
the wire changes: a `Change` is the same shape, at a longer path.

- **Each dirty nested repo is scanned as its own.** `scanChanges` (`changes.ts:63`) now runs
  `scanRepo` (`:94`) on the worktree, which runs `status` and `numstat` on one repo. An entry whose
  path is a folder holding `.git` (`isNestedRepo`, `:205`, the same boundary test as the tree's) is a
  nested clone's `?? loose/` or a gitlink's ` M inner`: it is dropped, and `scanRepo` runs again in
  that folder with the folder as the prefix of every path it finds, down to `MAX_NESTED_DEPTH` (4,
  `:88`, as the tree's). A nested repo the outer status doesn't name is clean and costs nothing. A
  nested repo git can't read gives no changes; the root failing still throws, as before.
- **Each diff comes from the repo that owns its path.** `ownerOf` (`changes.ts:191`) gives the deepest
  nested repo folder above a path, or `''`, counting no more than `MAX_NESTED_DEPTH` of them, as
  `scanChanges` does. `diff` (`git.ts:321`) takes that folder as a prefix
  (`--src-prefix=a/inner/`, so the patch names the path the worktree knows) and passes
  `--ignore-submodules=all`, which leaves out the gitlink's "Subproject commit" entry. One file's diff
  (`#diffForPath`, `service.ts:839`) asks the owner's `status` and `diff`; the whole diff
  (`service.ts:515`) is the root's, then each nested owner's in path order, then the untracked
  patches. A deleted nested file opens as the owner's last copy (`#goneFile`, `service.ts:446`).
- **The tree counts them as nested.** `buildTree`'s union (`tree.ts:381`) puts a changed path inside a
  nested repo into that repo's share of the cap with its listed files, not the outer repo's own, so
  a deleted nested file still shows and Amendment 90's budget still drops nested files first.
- **Live badges.** The watcher (`#emitBatch`, `watcher.ts:218`) groups a batch by `ownerOf` and asks
  each repo its own `check-ignore`, `numstat` and `status`, so an edit inside `inner/` is counted by
  inner's git as it happens. Before, the outer repo's `check-ignore` fails outright for a path inside
  a submodule, so a batch holding one had none of its ignored paths filtered out.

*Not done / not decided.* A worktree with no git at its root still takes its changes from the
projection alone, nested repos or not. A nested repo whose HEAD moved (a commit made inside it)
no longer shows as a changed gitlink, since its files are clean against its own HEAD. A
submodule set to `ignore = all` in `.gitmodules` hides its dirt from the outer status, so it isn't
scanned. Past four levels a path is owned by the fourth repo down, which sees only an opaque folder,
so the file gets no badge, no diff from its own route or the whole diff, and no live edit: the
tree lists the fifth repo's folder, marked, with nothing in it.

*Verified.* `workspace/verify.ts` §15 (`:1494`) makes a nested clone dirty (a changed `inner/app.js`,
a new `inner/fresh.txt`, a removed `inner/README.md`), an untracked clone with a change and a clean
one, and checks: the outer status shows them as opaque entries; the watcher reports inner's edit
with inner's counts; `scanChanges` lists them at full paths with no `?? loose-clone/` and no `inner`
entry, and nothing for the clean clone or `vendor-lib/`; the tree badges them inside `inner/`, keeps
the deleted file, rolls `inner/` up and counts them in its totals; an inner file's diff, from the
route and the file pane, is `git -C inner diff` of it with the `inner/` prefix; the deleted file
opens as inner's copy; the whole diff holds every patch and no "Subproject commit". A chain of
repos each nested in the last, one past `MAX_NESTED_DEPTH`: the second's change is listed at its
full path with its own counts, badged and rolled up, and its diff, alone and in the whole diff, is
that repo's own; the fourth is still scanned; the fifth is not, leaves no opaque entry and gets no
diff. One watcher batch with an outer-ignored file and an edit inside `inner/` reports the edit and
not the ignored file. Put back, it is all clean again. `make test` green.

### Amendment 157 — post-merge, applied. **A message can wait for the agent instead of a time: it goes when the agent's turn ends `done`, one per turn.**

Daemon (`db/migrations/250_scheduled_trigger.sql` new, `session/schedule.ts`, `routes/schedule.ts`,
`session/supervisor.ts`, `session/verify-schedule.ts`), shared (`wire.ts`), web (`agent/endpoints.ts`,
`agent/scheduled.tsx`, `agent/composer.tsx`, `agent/agent.css`, `lib/verify-schedule.ts`), docs
(`docs/MANUAL.md`, `TODO.md`). The user, 14 Oct 2026, in TODO's "Queue work for an agent until it is
done": "Beside **⏲ later**'s date and time, a **queue** choice: the message waits until the agent's turn
ends … then goes as if you had pressed send. Several queued messages go one per turn, in order". This is
docs/plans/wave-11.md S2 (lane R3), with *Decided (14 Oct): it's sent when the agent's turn ends as `done`.
A pending question doesn't count. On `failed` or `paused` it keeps waiting and shows that. One message
per turn.* *Amends Amendment 111*, whose clock sent "each row with no error and `at` ≤ now" and whose
`ScheduleMessageRequest` was `{ at, text }`: the clock now reads only rows whose trigger is `'at'`, and
the request's `at` is optional.

- **The trigger** (`250_scheduled_trigger.sql:13`). `scheduled_messages.trigger TEXT NOT NULL DEFAULT
  'at'`, checked to `'at' | 'done' | 'slot'`, so every row already there stays a timed one. `'slot'` is
  reserved for wave 11's A2 and nothing writes it. A row that isn't `'at'` has `at` = `created_at`
  (`insertScheduled`, `schedule.ts:104-115`), and `due()` (`:137`) reads only `'at'` rows.
- **Wire** (`wire.ts:836-856`). `ScheduleTrigger`; `ScheduledMessage.trigger`; `ScheduleMessageRequest
  { at?, trigger?, text }`.
- **The route** (`routes/schedule.ts:52-63`). `{ trigger: 'done', text }` → 201, with no time to check.
  It is refused (400, "send the message now") for an agent that is already `done` or was `stopped`,
  since no turn of its would end to send it. `'slot'` and anything else → 400 "trigger is 'at' or 'done'".
- **Sending** (`supervisor.ts:1466-1467`, `#sendWhenDone` `:1488`). At the end of `#settle`, only on
  the branch that writes `done`, the agent's oldest `'done'` row with no error (`nextWhenDone`,
  `schedule.ts:142`, by `created_at`, then id) goes through `sendMessage`, as Amendment 111's do, and is
  deleted. It goes before `#rollUpJob`, so the job of an agent about to go again isn't finished and
  merged under it. One per turn falls out of this: the message starts the next turn, and the next row
  waits for that one to settle `done`. A question (`blocked`, which doesn't settle), `failed` and
  `paused` never reach it, so the row waits through them. A refusal other than "cannot receive messages
  yet" (a budget, a folder gone) sets `error`, as for a timed one. It does nothing when a relaunch is
  already wanted (`#resumeWanted`) or the job is being stopped, which would make a second run.
- **A paused fleet** (`#owedWhenDone`, `supervisor.ts:1476`; `release`, `:2440-2444`). While
  everything is paused, `sendMessage` still launches (Amendment 111), so a turn that ends `done` then
  is remembered instead, and `release` sends its message if the agent is still `done`. Agents the
  pause paused send theirs at the done that follows their resume.
- **A restart.** The rows are in the database; nothing reads them at start or on a tick, so none
  goes until the agent's next turn settles `done`. The owed set is in memory: a restart during a
  paused fleet leaves that row for the next done turn.
- **Web.** `queueWhenDone` (`endpoints.ts:187`) posts `{ trigger: 'done', text }`. The composer has
  **⏲ when done** beside **⏲ later** (`composer.tsx:301-302`, `:591`), which queues what is typed and
  clears it, and is disabled with the route's reason as its title for a `done` or `stopped` agent
  (`whenDoneRefusal`, `scheduled.tsx:33`). `ScheduledList` shows such a row as **⏲ when done** with what
  it waits on (`whenDoneWaits`, `:44`): *when this turn ends*, *after its next turn*, *waiting: it asked
  you something*, *waiting: it failed, and goes after a turn that ends done*, *waiting: it is paused*,
  or *after the one before it* for all but the first. ✕ cancels it as before. `.ag-later-btn:disabled`
  (`agent.css:1849`) is tokens only.

*Not done / not decided:* `'slot'` (a message waiting for a free slot) is only a value in the CHECK;
A2 builds it. "Done" is the turn, not the job, as decided: nothing waits for a job to finish. A row
that failed (`error`) is skipped by `nextWhenDone` and stays until you clear it, like a timed one. The
list's order is still Amendment 111's (by `at`, which for these is when they were queued). The owed
set doesn't survive a restart.

*Verified:* daemon `session/verify-schedule.ts` §8 (`:342`), 35 new checks on the fake SDK, with a fake
turn that ends `failed`. Nothing is sent while the agent is working, and a tick doesn't read it as due.
The oldest is sent once on `done`, resuming its own session, with only its text, and the job stays
`working`. The refusals (done, stopped, `'slot'`, an unknown trigger) make no row. A question doesn't
send it. Two queued messages take two turns. On `failed` it waits and goes after a later done. ✕
cancels it. The row is in the database file as `'done'`, a paused agent and a fresh `Scheduler` don't
send it, and the next done does. A row inserted without a trigger reads as `'at'`. A paused fleet
holds it, a turn of yours that ends done during the pause holds it too, and the pause ending sends it.
With the `#settle` call taken out, 19 of them fail. Web `lib/verify-schedule.ts` §5 (`:115`), 10
checks: `whenDoneRefusal` and `whenDoneWaits`, and the composer, endpoint and list wiring.
`pnpm -r typecheck` clean; `make test` green.

### Amendment 156 — post-merge, applied. **Branches can pull and rebase a branch; a pushed branch rebased is refused at push, since it needs a force Conductor never does.**

Daemon (`workspace/branches.ts`, `routes/branches.ts`, `workspace/verify-branches.ts`), shared
(`src/wire.ts`), web (`branches/rules.ts`, `branches/route.tsx`, `branches/verify.ts`) and docs
(`docs/MANUAL.md`, `TODO.md`). The user, 14 Oct 2026: "Execute … docs/plans/wave-11.md … following
§0"; this is the plan's lane I1, item N3 (`docs/plans/wave-11.md:391`), with the decision of 14 Oct
(`:761`): "Rebasing a pushed branch is allowed, with a force-needed warning; Conductor never forces".
*Amends Amendment 109*, whose Branches screen landed work only by merging and pushing: it can now
also bring a branch up to its upstream and rebase it onto the target. Nothing it did before changes;
push gains one refusal.

- **Two actions** (`shared/src/wire.ts:954`, `:960`): `pull{branch}` and `rebase{branch, onto?}`,
  parsed at `branches.ts:215-217` (`onto` must be a string not starting with '-'; it defaults to the
  target, `intoOf`). `BranchInfo.rebased?` (`wire.ts:891`) marks a branch Conductor rebased while it
  had an upstream and that has diverged from it since (`branches.ts:443`).
- **Pull** (`pullOne`, `branches.ts:726`). `ownCheckout` (`:710`) refuses, with 409, a live agent, a
  branch that isn't checked out, and tracked changes. Then 409 for no upstream; a fetch of the branch's
  own remote with `--no-prune`, `sshEnv()` and `REMOTE_TIMEOUT_MS` (`:734`; skipped for a local `.`
  upstream); the upstream's full refname from `for-each-ref` (`:741`), since `refs/heads/x@{upstream}`
  doesn't resolve; 409 "nothing to pull" when it isn't behind; 409 "diverged — merge or rebase", with
  both counts, when it is also ahead; and `merge --ff-only` in the checkout (`:754`).
- **Rebase** (`rebaseOne`, `branches.ts:765`). It is refused with 400 onto itself, then by
  `ownCheckout`, then with 409 for unrelated histories or nothing to rebase. It runs
  `rebase --no-autostash -- refs/heads/<onto>` in the branch's checkout. On any failure it runs
  `rebase --abort` (`:782`), then returns `{ok: false, conflict: {branch, files}}` as `mergeOne` does,
  or rethrows when there were no conflicted files.
- **Never forced.** A branch rebased with an upstream goes into `rebasedSincePush` (`branches.ts:120`).
  Its next push is refused before it reaches the remote: 409 "<branch> was rebased after it was
  pushed", with `FORCE_SENTENCE` (`:124`) as the detail (`:973-974`). A remote rejection of a branch
  in the set gets the same refusal (`:982`), and a push that goes through clears it. The rules header
  says so. No `--force`, `--force-with-lease`, `-f` or `+` refspec was added; the verify reads the
  source to check.
- **Web.** `rules.ts:159-205` adds `FORCE_SENTENCE` (the daemon's words), `showPull`/`pullReason`
  (no upstream, live, not checked out, "diverged — merge or rebase"; a level branch isn't refused,
  since pull fetches first), `pullConfirm`, `showRebase`/`rebaseReason` (the target, live, not checked
  out, unrelated, nothing to rebase) and `rebaseConfirm`, which warns "Careful: <FORCE_SENTENCE>." when
  the branch has an upstream. `pushReason` returns the sentence for a `rebased` branch (`:126`).
  `route.tsx:635` puts **Pull** and **Rebase onto main** beside Push; their confirms are at
  `:692` and `:704`, like Push's. The result says "Pulled (sha)." or "Rebased onto main (sha).", adding
  the warning when the answer's listing marks the branch `rebased` (`:782-786`). A rebase's conflict
  says "the rebase was undone, and <branch> is as it was" (`:800`).
- **Docs.** `docs/MANUAL.md` gains "Pull and rebase a branch" after "Delete merged branches", and a
  sentence in the Branches row of the screens table.

*Not done / not decided:* `rebasedSincePush` is in memory, so after a restart Push is offered again and
the remote's own "the push was rejected" is what you see. The web always rebases onto the target; the
daemon's `onto` has no picker. Pull's `merge --ff-only` is local and runs without `sshEnv` or the
timeout; only its fetch talks to the remote. Tracked changes aren't in the listing (its count includes
untracked files), so the web leaves that refusal to the daemon's 409.

*Verified:* daemon `verify-branches.ts` section 14 (`:921`), with an origin and a second clone that
moves it: a fast-forward pull lands origin's commit with no merge commit, and a second pull is
"nothing to pull"; a diverged pull is refused and moves neither side; no upstream, not checked out,
tracked changes (pull and rebase) and a live agent (pull and rebase) are 409s; a rebase onto main
rewrites the branch onto main with a clean checkout; a second rebase, onto a branch it already has,
onto itself (400) and onto `--onto` (400) are refused; a conflicting rebase reports `c.txt`, leaves no
rebase in progress, a clean tree and the branch where it was; a pushed branch rebases, is listed
`rebased` (↑2 ↓1), and its push is a 409 with `FORCE_SENTENCE`, leaving origin untouched; and the
source has no force. The old "unknown action" check used `rebase`, now a real action; it uses `squash`
(`:475`). Daemon: 214 checks PASS. Web `branches/verify.ts` section 11 (`:393`): the reasons, the
confirms with and without the warning, Push's refusal after a rebase, and the route's buttons, confirms
and result text. `pnpm -r typecheck` clean; `make test`: 28 PASS.

### Amendment 155 — post-merge, applied. **A role an orchestrated stack lists runs on its persona's model when that is an exact id, not on sonnet.**

Web only (`spawn/orchestrated.ts`, `spawn/presets.ts`, `spawn/custom.ts`, `spawn/Pipeline.tsx`,
`spawn/verify.ts`); the daemon and `shared` are unchanged. The user, 14 Oct 2026: "Execute wave 1 of
docs/plans/wave-11.md … following §0", and 15 Oct, "Run track 5 of `docs/plans/wave-11-tracks.md`"; this
is the plan's item O1 (lane D2, §3 "an exact persona model falls back to sonnet"). *Amends Amendment 128*,
whose listed role held only a tier, and *Amendment 148*, which said "a role added there … whose persona
names no tier, is still sonnet": a persona that names an exact id is now listed on it. A persona on a
tier, or with no model, is listed exactly as before. `docs/MANUAL.md` § Choose who works on it, "An
orchestrated pipeline", says what the picker shows.

- **What was wrong.** `tierOf` (`orchestrated.ts:36`) turns any model that is not a tier into
  `sonnet`, and `ListedRole` held only that tier, so `helperRolesFor` sent `tiers.sonnet` as the role's
  `HelperRole.model`. A developer persona set to `us.anthropic.claude-opus-4-1-…` ran its helpers on
  Sonnet, though a Custom row with the same persona ran on the id (`personaPicks`, `custom.ts:196`).
- **`ListedRole.model?`** (`orchestrated.ts:31`): the persona's exact id, from `exactOf` (`:43`), which
  is the persona's model when it is neither a tier nor empty. `defaultListed` (`:59`) and `withRole`
  (`:80`) build each role with `listedAs` (`:49`): its tier as before (`tierOf`, so `sonnet` under an
  exact id), plus `model` when the persona names one. `withTier` (`:65`) drops `model`, since a tier
  picked is a choice over the persona's id; `withModel` (`:70`) puts an exact id back, keeping the tier.
- **`helperRolesFor`** (`presets.ts:341`) passes each listed `model` to `toAgentSpecs` as that role's
  pick (`:356`), the same `RoleModels` a Custom row's persona fills, so `modelFor` gives the exact id and
  `HelperRole.model` (`:362`) carries it. `tier` and `tiers` are sent as before, so `helperModel`
  (`shared/src/stack.ts:318`) still works off `tier`: with no `tier` asked it returns `role.model`, the
  exact id (`:323`); `haiku` gives `tiers.haiku`; anything dearer than the listed `sonnet` is refused.
- **`unresolvedListed`** (`orchestrated.ts:129`) skips a role with an exact id: it has an id to send,
  so Spawn doesn't wait on its tier.
- **Saved setups** (`parseListed`, `custom.ts:270`) keep a listed role's `model` when it is a string
  that is not a tier; a setup saved before this has none, and lists its roles on their tiers.
- **The role select** (`Pipeline.tsx:110`) shows the exact id, its own or its persona's, as the first
  option above the tiers (`:129`), selected while the role runs on it (`value={l.model ?? l.tier}`);
  picking a tier calls `withTier`, picking the id calls `withModel`. Its title names the id. The row
  note (`rowOverrides`, `:97`) is unchanged: it reads the role as its tier, which is what the read-only
  pin goes by. Off Claude the row still shows the launch's one model.
- **The daemon already ran it.** Nothing there sets a model per role; it keeps what Spawn sent:
  `parseHelperRoles` takes `model` as given (`routes/session.ts:207-212`; on Claude, `refusal`,
  `:210`, refuses a nickname, and an id the gateway doesn't list when it said what it serves,
  `session/models.ts:316`, as for any row; elsewhere `checkProviderModels` checks it against the
  engine's list, `:352`); it is stored on the orchestrator (`store.ts:728`) and read back by
  `getHelperRoles` (`store.ts:485`); `startHelper` (`session/supervisor.ts:1736`) takes the role's
  model from `helperModel` (`:1755-1757`), writes it on the helper's row (`:1782`), and the run starts
  its backend with `model: agent.model` (`:1255`).

*Not done / not decided:* off Claude every role still runs on the launch's one model, exact id or not
(`specsOn`, `engine.ts:67`, Amendment 80). A helper has no engine of its own: an OpenRouter id on a
Claude launch is sent to Claude, refused at launch only where the gateway lists what it serves and
otherwise failing when the helper runs, as a Custom row with that persona does today. The tier under an exact Claude id
is `sonnet`, not read from the id, so an orchestrator under an exact Opus id may ask for sonnet or haiku
but not opus. A persona changed in Settings after the list was edited, or a saved setup's list, is not
re-read from the persona; choosing the preset again does that.

*Verified:* `web/src/spawn/verify.ts` §21, after the tier checks: "a persona with an exact Claude id is
listed with it, and its tier is the fallback sonnet"; "and one with an exact non-Claude id too"
(`anthropic/claude-sonnet-4.5`); "both reach the launch request as the role's model, its tier kept
beside it"; "the roles on a tier are as they were"; "tier personas are listed with no exact id, and send
what they always sent" (the default list's specs are byte-for-byte the same JSON); "the daemon runs a
helper on the exact id, and a cheaper tier is still the tier's" (`helperModel`); "a role added with an
exact id keeps it"; "a tier picked for it drops the exact id, and the exact id can be picked back"; "a
role with an exact id does not wait for a tier"; "a saved setup keeps the exact id, and a tier written as
one is not an exact id"; "off Claude every role still runs on the launch's one model (Amendment 80)";
and from `Pipeline.tsx`'s source, "the role select shows the exact id it runs on" and "its row note still
reads the role as its tier, as Amendment 147 has it". With `helperRolesFor` passing `{}` as on `main`, 2
fail, the request carrying `us.anthropic.claude-sonnet-5` for both exact roles. §25 (Amendment 147)
passes unchanged. `pnpm -r typecheck` clean; every `make test` suite PASS ("Track A spawn: PASS"), the last nine
run again on their own after another job's verify held ports 7802 and 7811.

### Amendment 154 — post-merge, applied. **The docs link only to files in git, and `make test` checks that they do.**

Docs (`README.md`, `TODO.md`, `docs/MANUAL.md`, `docs/adr/0001-preset-stacks.md`,
`docs/adr/0002-edit-running-stack.md`, `docs/plans/multi-provider-lanes.md`,
`docs/plans/multi-provider-backends.md`, `docs/checks/ui-test-plan.md` new) and the build
(`scripts/verify-docs-links.mjs` new, `Makefile`). The user, 14 Oct 2026: "Execute wave 1 of
docs/plans/wave-11.md … following §0"; this is the plan's lane F (§2, "Docs: D1, D2, D3, the test plan
and ADR 0001"), with *Decided (14 Oct): D2 drops the links.* *Amends Amendment 81*, which said
`docs/ARCHITECTURE.md` lives outside git and left README's link to it: the links are gone. Nothing in the
app changes; `docs/MANUAL.md` changes only where it linked that file and in its two lists of reading roles.

- **D1, the next number.** `TODO.md:14` said "The next amendment is 148", which was stale by the next
  merge. It now says the next number is the top one in CONTRACT.md plus one.
- **D2, no `docs/ARCHITECTURE.md`.** README's line under the title (`README.md:7`) points to the decision
  records in `docs/adr/` instead; its links under the suites (`:160`) and after Layout (`:185`) are taken
  out, and the Layout line for `docs/` (`:180`) says "decision records (adr/)" where it said "the
  architecture guide". `docs/MANUAL.md:5-6` points to `adr/`. `docs/adr/0002-edit-running-stack.md:116`
  says there is no architecture guide, so the ADRs and the amendments carry it. The two plans
  (`multi-provider-lanes.md:14`, `multi-provider-backends.md:199`) no longer name the file. CONTRACT's
  own mentions (Amendments 81 and 89) are history and are left as written.
- **D3, auditor.** The reading-role lists at `docs/MANUAL.md:372-373` and `:443-444` read "reviewer,
  debugger, analyst, auditor", as `READ_ONLY_ROLES` (`shared/src/stack.ts:119`) and MANUAL `:552` do.
- **The UI test plan.** `docs/checks/ui-test-plan.md` holds a heading and one line: the person pastes the
  plan in there. The browser check in TODO ("Look at what was built in Amendments 99-129 in a browser",
  `TODO.md:116`) links it.
- **ADR 0001's handoff line** (`docs/adr/0001-preset-stacks.md:14-15`) cited `supervisor.ts:685-689`,
  `handoff.ts:37-45` and an 8,000-character cap on the final reply, all gone since Amendments 101, 104
  and 120. It now describes the whole conversation as text with the `hand_off` summary on top
  (`#promptFor`, `supervisor.ts:1168-1190`; `handoffSection`, `handoff.ts:392`), a chain carrying the
  earlier parts inside each upstream's own launch prompt, the cap of a quarter of the window shared out
  (`handoffCap` `:79`, `shareCap` `:209`) and `dropRepeats` (`:313`), with a dated note saying it was
  corrected. The ADR's decision (E and F) is unchanged; the note says the reviewer now sees the plan
  inside the developer's conversation unless the cap leaves it out.
- **The link check** (`scripts/verify-docs-links.mjs`, in `make test` after the install check,
  `Makefile:175`). It reads README.md, TODO.md, docs/MANUAL.md and every tracked `.md` under `docs/`,
  takes `[text](target)` links (`:31`) and reference definitions (`:32`), skips http(s), mailto, pure
  `#anchor` links, fenced code blocks (`:48`) and inline code spans, strips the `#fragment`, resolves
  the rest against the linking file's folder (a leading `/` from the repo root) and needs it in
  `git ls-files` (`:71`). Only `.md` targets are checked. It prints `docs links: PASS — N links in M
  files`, or each bad link as `file:line → target` and exits 1.

*Not done / not decided:* links to anything but a `.md` file (README's `mockups/conductor.html`, folder
links such as `docs/adr/`) are not checked, as the plan asks only for `.md`. CONTRACT.md
and PLAN.md are not read by the check, since the plan names README, MANUAL, TODO and `docs/`. ADR 0001's
risk "Plan-aware review" (`:97`) and "Handoff growth, if G is ever taken" (`:98`) still read as of
Amendment 82; only the stale factual line was to change. The UI test plan itself is the person's to paste.

*Verified:* before the D2 edits the check failed with 4 of 34 links (`README.md:7`, `:160`, `:186` →
`docs/ARCHITECTURE.md`; `docs/MANUAL.md:6` → `ARCHITECTURE.md`), and the two plans' and ADR 0002's
mentions were not links, so were found by `git grep`. After: `docs links: PASS — 31 links in 46 files`;
no other link was broken. Breaking TODO's new link on purpose gave `TODO.md:116 →
docs/checks/ui-test-plann.md` and exit 1, then was put back. A throwaway probe file showed a good
`#fragment`, a title, `<…>`, `/README.md` and `../TODO.md` pass, a bad `#fragment`, a bad `../` and a bad
reference definition fail, and http, mailto, `#anchor`, a code span, a ``` fence and a `~~~~` fence
holding a ``` line are skipped. `pnpm -r typecheck` clean; `make test`: 28 PASS.

### Amendment 153 — post-merge, applied. **An empty folder .gitignore excludes is not listed in Files, inside an untracked folder or under an ignored one.**

Daemon only (`workspace/tree.ts`, `workspace/verify-files-verbs.ts`). The user, 14 Oct 2026: "Execute
wave 1 of docs/plans/wave-11.md … following §0"; this is the plan's item N7 (lane E1, §2 "an ignored
empty folder inside an untracked folder is listed"). *Amends Amendment 138*, whose *Not done* said "An
empty folder that git ignores is listed if it sits inside an untracked folder (`emptyUnder` reads the
disk there)": it no longer is. `docs/MANUAL.md` § Files tabs says which empty folders show.

- **What was wrong.** `untrackedDirs` names only folders git calls untracked, but `emptyUnder` then
  read the disk under each and never asked git again. In an untracked `scratch/` with
  `scratch/.gitignore` saying `ign/` and `*.tmp`, the empty `scratch/ign`, `scratch/x.tmp`,
  `scratch/deep/ign` and `scratch/ign/kid` were all in the tree, though
  `git ls-files -o -i --directory` (what `git status --ignored` reads) names the first three ignored.
- **One level at a time** (`emptyUnder`, `tree.ts:163`): every untracked folder starts the first
  level together (`:361`); each folder opened adds its subfolders to the next, and that whole list
  goes to the existing `checkIgnore` in one `git check-ignore --stdin` (`:183`). What git calls
  ignored is dropped before it is opened, so nothing under it is read or listed. That is at most 13
  `git` processes a tree read, one per depth, where a call per folder could have been 2,000.
- **`MAX_EMPTY_PROBES`** (`:150`) still counts folders opened, 2,000 a tree read, and the 12-deep
  bound and the stop at a `.git` (Amendment 90) are as they were. The budget is spent breadth first
  now, not depth first, so past it what is missed is the deepest folders, not the last untracked one.
- **No git, or a nested repo.** With no git there are no untracked folders and `emptyUnder` is not
  called; `walkFiles` lists every empty folder, as before. A folder holding a `.git` is not opened, so
  no path asked about lies past a nested repo's boundary; the nested repo's own folder is asked about
  by the outer repo's rules, which is how `git status` reads it. `checkIgnore` never throws: a failed
  `git` (128, no repo) reads as nothing ignored, which lists that level as before.

*Not done / not decided:* a folder holding only ignored files is still not empty, so not listed, as
before: it is not what N7 named. An empty folder that git ignores inside a tracked folder never was
listed (`classifyLevel` reads only what `ls-files` gives), so nothing changed there.

*Verified:* `workspace/verify-files-verbs.ts`, the job's "new folder" section, beside Amendment 138's
own empty-folder checks (`:173`):
- "git calls these ignored" (`scratch/ign/`, `scratch/x.tmp/`, `scratch/deep/ign/`, from real
  `git ls-files -o -i --directory --exclude-standard`);
- "an ignored empty folder under an untracked one is hidden, by name and by glob";
- "and so are an ignored folder's own empty folders" (`scratch/ign/kid`, the prune);
- "a plain empty folder under an untracked one is shown, at any depth";
- "Files lists nothing git calls ignored" (no listed folder is at or under one git names);
- "a nested repo in the untracked folder still reads: 200, and its folder is there";
- and for the project folder with no git (`:195`), "a folder with no git lists every empty folder,
  .gitignore or not".

With `tree.ts` put back as on `main`, 3 of the 7 fail (the two "hidden" checks and "Files lists
nothing git calls ignored", naming `scratch/deep/ign,scratch/ign,scratch/ign/kid,scratch/x.tmp`).
`pnpm -r typecheck` clean; `make test`: 27 PASS, "Amendment 138 files: PASS — 108 checks".

### Amendment 152 — post-merge, applied. **The bootstrap `/api/workspaces` routes open and remove a workspace only in a project that exists, in one of its own folders.**

Daemon only (`routes/workspace.ts`, `workspace/worktree.ts`, `workspace/service.ts`,
`session/supervisor.ts`, `workspace/verify.ts`, `workspace/verify-files-verbs.ts`). The user, 14 Oct
2026: "Execute wave 1 of docs/plans/wave-11.md … following §0"; this is the plan's item A4 (lane C,
§2 "`/api/workspaces` takes any input"). *Amends Amendment 2*, whose "Not changed" kept the three
routes as bootstrap and said "Expect these to be gated or removed at I4": they are gated, not
removed, since the Files screen still lists and opens through them. The route header's note says so
(`routes/workspace.ts:36`). Nothing a person sees changed, so `docs/MANUAL.md` is unchanged.

- **What was wrong.** `POST /api/workspaces` took any `jobId`, `projectId`, `repoPath`, `branch` and
  `baseRef`. A `jobId` of `a/b` cut a worktree at `.conductor/wt/a/b`, `../x` reached git as a path
  out of `wt`, an unknown project or any folder on disk was opened, and a bad ref was a 500 with
  git's usage text. `DELETE` answered 200 for a job it had never seen, read `force=yes` as true,
  and removed a worktree an agent was working in.
- **`jobId` has the daemon's shape, loosely** (`JOB_ID`, `routes/workspace.ts:107`): `job_` then 1–64
  of `[A-Za-z0-9_-]`, as `metrics.ts`'s `PROJECT_ID` is loose. No `/` and no `.`, so
  `<repo>/.conductor/wt/<jobId>` stays under `wt`. Absent, it is `newId('job')` (`:466`). A bad one
  is a 400 on POST (`:452`) and DELETE (`:493`).
- **The project must exist** (`:460`): the `projectId` given, or the project whose path is
  `repoPath`, which is what the Files screen sends (`useWorkspace.ts:470`, `{repoPath, isolation}`).
  Neither is a 404.
- **`repoPath` must be the project's folder or one of its directories**, by `dirRoot`'s own rule
  (`service.ts:308`, called at `routes/workspace.ts:470`): 404 for a folder that is not one of its
  own, 410 for one that is gone. `dirRoot` compares exact paths, not real ones, so a subfolder,
  `<folder>/../<name>`, a trailing `/` or a link to the folder is not the project's.
- **`branch` and `baseRef` pass `git check-ref-format`** (`:472`): `branch` by `branchNameProblem`,
  the rule launches use (Amendment 115), and `baseRef` by the new `baseRefProblem`
  (`worktree.ts:118`, `--allow-onelevel`, so `HEAD`, `main` and a sha pass), which refuses a leading
  `-` first. Either one is a 400 with the sentence.
- **A folder git cannot use is a 400.** `ensure`'s "is not a git repository" and "has no commits yet"
  throw `RepoUnfitError` (`worktree.ts:109`, `:206`, `:262`), which `fail` answers with 400
  `{error: 'could not open the workspace', detail}` (`routes/workspace.ts:125`). Its `name` stays
  `Error`, so the supervisor's "could not prepare a … workspace: …" reads as before.
- **DELETE** reads `force` as `recursive` is read (`recursiveOf`, `:494`): `1`/`true`, `0`/`false` or
  absent, else 400. It is 409 while an agent of the job is busy (`:496`), by `deleteProject`'s test
  for one agent, now `supervisor().isBusy` (`supervisor.ts:1921`), naming the roles in `detail`.
  It is 404 for a workspace whose project is gone (`:507`), and 404 for a job with no workspace
  (`service.ts:229`), where it was 200 `removed: false`.
- **GET takes `?projectId=`** (`routes/workspace.ts:433`): that project's workspaces, 404 for an
  unknown one. Without it, all of them, as before.
- **Unchanged.** `workspace().open` in-process (Track A's jobs), `POST /api/jobs`, and the Files and
  folder verbs.

*Not done / not decided:* `repoPath` outside the project is a 404, `dirRoot`'s own status, not the
400 or 403 the plan offered: the plan said to reuse `dirRoot`, and it answers 404. The `jobId` rule
is loose rather than `newId`'s exact `job_xxxxxxxx-xxx`. The exact shape would have renamed a dozen
fixed test ids across the verify files for no safety the loose rule lacks. Workspaces opened
before this, in no project, are listed still and refused on DELETE.

*Verified:* `workspace/verify.ts` §1b (`:208`), "the bootstrap routes refuse what they cannot vouch
for":
- "jobId "../x" → 400", and the same for `a/b`, empty, `prj_abc`, `job_../x`, `job_a.b` and `7`, "and
  no worktree was cut for any of them, inside .conductor/wt or out of it";
- "an unknown projectId → 404"; "no projectId, and repoPath is no project → 404";
- "repoPath … is not the project's → 404" for the temp folder, a subfolder, `/../scratch-repo`, a
  trailing `/` and a link to the folder;
- "branch a..b → 400", and the same for baseRef, `-x` and `refs/../x`, with no worktree cut;
- "the screen's request finds the project by its folder → 201", "and its job id is the daemon's own
  shape";
- "not a repository → 400, saying so"; "no commits → 400, saying so"; "one of the project's other
  folders → 201";
- "GET ?projectId= lists that project's workspaces", "and only those", "an unknown project there →
  404";
- "DELETE of a job with no workspace → 404"; "… of a jobId of the wrong shape → 400"; "force=yes →
  400" (and `TRUE`, empty), with the worktree still there;
- "DELETE while an agent of the job is live → 409, naming it" (with `isLive` stood in, as
  `session/verify.ts` does), with the worktree still there; "once it is not, force=1 removes it";
- "DELETE of a workspace whose project doesn't exist → 404".

The project ids the file already used are now rows (`:185`, and `prj_temp`, `prj_gone`,
`prj_nogit` where their folders are made). §11's "publishes a project for it, named from the repo"
now opens in-process, as Track A does, under a project with no row (`:1018`).
`verify-files-verbs.ts:305` named `prj_verbs`, which was no project: it now adds the repo as one and
uses its id (the input fixed, not the rule). The other callers the plan names (`workspace/verify.ts`
§7, `session/verify.ts`) pass unchanged. With `routes/workspace.ts`, `service.ts`, `worktree.ts`
and `supervisor.ts` put back as on `main`, 41 of §1b's 42 checks fail: `a/b` cut
`.conductor/wt/a/b`, `prj_nope` and any folder opened, and bad refs were 500s. `pnpm -r typecheck`
clean; `make test`: 27 PASS.

**Follow-up (15 Oct, review).** Two findings of the review, fixed. Daemon only; nothing a person
sees changed (the Files screen POSTs no `jobId` and sends no DELETE), so `docs/MANUAL.md` is
unchanged.
- **DELETE no longer removes a worktree with unfinished work.** `isBusy` sees only a run in flight,
  so an agent paused at a ceiling, `queued` behind a cap or waiting to retry, or `blocked` on a
  parked request had its worktree removed. The route now asks `hasUnfinishedWork`
  (`supervisor.ts:1933`): busy, or a status other than `done`, `failed` and `stopped`
  (`ENDED_STATUSES`, `supervisor.ts:347`; the statuses are `AgentStatus`, `shared/src/events.ts:26`).
  The live runner still counts, since the status can lag a run that is starting. The 409 names each
  agent's role and status, `builder (paused)`, in `error` and `detail` (`routes/workspace.ts:503`).
  `deleteProject`'s test is unchanged: there a stale `working` row must not make a dead project
  unremovable, whereas here the row is what says the worktree is still wanted.
- **A `jobId` stays in its project.** `ensure` reused a job's workspace whatever project the
  request named, so a POST for project B with a `jobId` open under A got A's workspace back with a
  201, and one whose workspace was removed was re-created under B. `#ensureLocked` now refuses,
  first and inside the job's lock, when the stored record's project, or Track A's jobs row's when
  there is no record, is not the request's: `JobElsewhereError` (`worktree.ts:118`, `:211`), a 409
  "job … already has a workspace in another project" (`routes/workspace.ts:127`). The same project
  reuses as before. The two in-process callers of `open` never cross projects: `createJob`
  (`supervisor.ts:811`) opens a fresh `newId('job')` under its own project, and `restoreFolder`
  reads the job's own project and does not call `ensure`.

*Verified:* `workspace/verify.ts` §1b: "POST with a jobId open under another project → 409, saying
so", "and the workspace is unchanged", "the same POST naming its own project → the same workspace"
(`:363`); "DELETE while an agent of the job is queued behind a cap, with no runner → 409, naming its
role and status", the same for "paused at a ceiling" and "waiting on a request", each with the
worktree still there (`:392`); "once every agent of the job is done, force=1 removes it" (`:411`).
With the source put back as before, all but the same-project check fail (the POST was 201 with
`prj_b`'s record, each DELETE 200). `pnpm -r typecheck` clean; `make test`: 28 PASS.

### Amendment 151 — post-merge, applied. **Send-backs are counted per lane, a role with a name, so new work under a new name starts while the total allows; and an orchestrated stack's helpers in all are a launch choice, up to 48.**

Shared (`stack.ts`, `wire.ts`), daemon (`session/store.ts`, `session/supervisor.ts`, `session/handoff.ts`,
`routes/helpers.ts`, `routes/session.ts`, `session/verify.ts`), web (`spawn/orchestrated.ts`,
`spawn/Pipeline.tsx`, `spawn/presets.ts`, `spawn/route.tsx`, `spawn/verify.ts`), and `docs/MANUAL.md`.
The user, 14 Oct 2026: "Conductor won't let me start a 4th developer. It counts every developer start
against the "sent back at most 2 times" rule, even when it's a new lane." Answer: "Fix the rule in code".
*Amends Amendment 128*: its "a role is started at most three times in all" is now a lane (a role and
the `name` it was started with) started at most three times; and its "`helpers` is then 1 to
`pipelineHelperCap(roles)`" is now up to `max(pipelineHelperCap(roles), PIPELINE_HELPERS_MAX)`, with
`pipelineHelperCap` still the default. No migration: a running job keeps the cap it was launched with.

- **What was wrong.** `startHelper` refused a start when `startedAsRole` (`COUNT(*)` of the
  orchestrator's helpers with that `helper_role`) reached `1 + SEND_BACKS_MAX`, so the fourth
  developer was refused even when it was new work under a new name, not a send-back. The rule
  meant "send the same work back at most twice", but nothing told one piece of work from another.
- **A lane is the role and the normalised `name`.** `helperSlug` (`shared/stack.ts:207`) is the
  normalisation the stored name already used (lowercase, runs of anything else to `-`, trimmed, 24
  characters), moved to shared so the count and the name agree. `startedInLane(db, orchId, role,
  name?)` (`store.ts:504`) counts the orchestrator's helpers of that role whose stored name is the
  lane's stem (`<role>-<slug>`, or `<role>` with no name) or that stem with the `-N` added while a
  name is taken. A new name is a first start; the same name again is a send-back; unnamed starts are
  one lane, so they keep the limit they had. `startedAsRole` is gone.
- **The refusal names the lane** (`sendBackRefusal(role, started, lane?)`, `stack.ts:253`; called at
  `supervisor.ts:1744`): "You have started the developer for “w11-a1” 3 times: once, and then you
  sent its work back 2 times, which is the most you may. …", the rest of the sentence unchanged.
  With no name it reads as before.
- **The orchestrator is told.** `pipelineSection` step 3 (`handoff.ts:575`): give each new piece of
  work its own `name`, send work back with the same `name`, at most `SEND_BACKS_MAX` times a lane.
  `pipelineReportClosing` (`handoff.ts:610`) says the same when it is woken. The roles'
  `start_helper` description and its `name` parameter (`routes/helpers.ts:119`, `:133`): a new name
  is new work, the same name a send-back. The ordinary `start_helper` is unchanged.
- **Helpers in all, a launch choice.** `PIPELINE_HELPERS_MAX = 48` (`stack.ts:200`). The daemon takes
  `helpers` above 0 and up to `max(pipelineHelperCap(roles), 48)` for a stack with `helperRoles`
  (`routes/session.ts:280`), saying "from 0 to 48" past it; an ordinary orchestrator is still held to
  `HELPERS_MAX` (8). The total still refuses a start past it, whatever the lane. Wire docs
  (`wire.ts:211`, `:231`).
- **Spawn shows it.** The listed roles' head line reads "may start up to [N helpers in all], as these
  roles and no others" (`Pipeline.tsx:77`), a select styled as the "+ up to N helpers" picker, from
  one per role to the default one at a time, then in fours to 48 (`helperChoices`,
  `orchestrated.ts:87`). It defaults to `helperCapFor(list)` (`helpersInAll`, `:100`), is kept for the
  launch as the per-role helpers are and put back by choosing a preset (`route.tsx:291`, `:313`), and
  is sent as `helpers` (`toAgentSpecs`' `helpersInAll`, `presets.ts:405`). `sendBackWords`
  (`orchestrated.ts:111`) says lanes.
- **Unchanged.** `roleRefusal`, the read-only pin, the tier rules, `HELPERS_MAX`, and running jobs.

*Not done / not decided:* the lane is read back from the stored name (`agents.role`); no column
keeps the `name` as given. A name of only digits, or one ending in `-<digits>` (`api-2`), can share a
count with the lane it looks like (`developer` and `developer-2`; `api` and `api-2`). That only
counts more starts than there were, so it refuses sooner, never later; a `helper_name` column would
end it, and was left out to keep this without a migration. "Remembered like the other launch
choices" is taken as the per-role helpers count is kept: for the launch, until the preset changes,
not as a Settings default, which Spawn keeps only for the preset, pills and budget. A Custom setup
does not save the number.

*Verified:* `session/verify.ts` §25b (`:6680`), on a four-role stack: "the pure rules: a lane is the
role and the name, as it is stored; the most in all is 48"; "a 4-role stack defaults to 12 helpers,
as before"; "… launched with 48 helpers in all → 201, and keeps 48", "and with 49 → 400, saying the
most", "… with 13 … → 201, and keeps 13"; "an ordinary orchestrator is still held to HELPERS_MAX (8),
not 48"; the prompt, `start_helper` and closing-line checks; "three starts of the developer under
three names all start: three lanes, each its first start", "and a fourth new name still starts,
since the total allows it", "the same name again is a send-back of that lane, twice; the name is
normalised as it is stored", "counted per lane from the database", "the same name at its fourth
start is refused, and the refusal names the lane", "while another lane of the same role can still be
sent back", "starts with no name keep the limit they had: three, as one lane", "other roles have
their own lanes", "and the total still refuses past the cap the launch chose, whatever the lane".
§25's unnamed checks now read "a fourth start of the same role, with no name, is refused" (`:6556`)
and the cap check "and no more helpers than PIPELINE_HELPERS_MAX → 400" (`:6483`). `spawn/verify.ts`
§27 (`:1616`): the choices, the default, what is sent, the select and its reset, and the words. With
`supervisor.ts` put back as it was on `main`, eight of the new checks fail, the fourth new name
among them, refused with "You have started the developer 3 times"; with `routes/session.ts` put back
too, the 13- and 48-helper launches are refused with "from 0 to 12". `pnpm -r typecheck` clean;
`make test`: 27 PASS.

### Amendment 150 — post-merge, applied. **With two calls of one tool waiting for you, each call parks on its own request and each answer reaches only its own call.**

Daemon only (`arbiter/index.ts`, `session/verify.ts`). The user, 14 Oct: "Execute wave 1 of
docs/plans/wave-11.md … following §0"; this is the plan's item A3 (lane B, §2 "the arbiter matches
the wrong request"). Amends Amendment 30, whose "two things were left alone" kept case 1 applying a
staged decision "to the next call of the same tool name, not the same `toolUseId`", and the
by-name match in case 2 it described. Nothing a person sees changed: Needs You's cards and words
are the same, so `docs/MANUAL.md` is unchanged.

- **What was wrong.** PreToolUse's case 2 took the first open request matching `toolUseId ||
  toolName`, and `openRequestsForAgent` lists them oldest first, so with two Bash calls waiting a
  call for the second parked on the first. Staged decisions were one per agent (`#decided:
  Map<agentId, …>`): answering the second request overwrote the first's answer, and case 1 gave
  whichever was staged to the next call of that tool, so an allow for `git push` could run as the
  allow for `rm -rf build`.
- **Requests already store their input** (the plan's §8 question). `requestPermission` writes
  `input: ask.input` (`arbiter/index.ts:398`) into `requests.input`, read back as
  `RequestRecord.input` (`store.ts:946`). Nothing new is stored, and no migration.
- **Case 2 matches the call's own request** (`arbiter/index.ts:310`). By `toolUseId` first; then by
  name only when that can't be another call's: exactly one open request of the tool, or one with
  the same input. Copilot asks again under a fresh id (`backends/copilot.ts:442`), which is why the
  name fallback stays. A call of the tool that is neither of the waiting ones is no longer parked
  on one of them: it goes on to `canUseTool` and asks for itself.
- **Staged decisions are one per request** (`#decided: Map<agentId, PendingDecision[]>`,
  `arbiter/index.ts:182`), appended by `decide` (`:540`) and taken by `#takeStaged` (`:732`): the
  request's `toolUseId`, or the same tool with the same input when the call comes back under a
  fresh id. `PendingDecision` carries the request's input for that (`:169`). Inputs compare after a
  JSON round trip, as the stored one had (`sameInput`, `:761`).
- **Unchanged.** The single-request park and the MCP decline (`:323`, Amendment 30), `clearStaged`
  and `cancelForAgent` dropping all of an agent's staged decisions, and `hasStagedDecision`.
  `stagedFor` (`:723`), read for the resume nudge and the fork's note, returns the latest decision
  answered, which is what one-per-agent held before.

*Not done / not decided:* a staged decision no longer reaches a call of the same tool whose input
differs. That covers the interrupt path (`#escalate`), where the model is nudged to "make that exact
call again" under a new id: if it changes the command, it asks again rather than being allowed. It
also covers Amendment 131's "an agent that asks again anyway still gets your answer": that now holds
only when it asks the same questions. The plan asks for exactly this ("consumed by id, or by name
plus equal input"); recorded here because 131 states the old behaviour. With several decisions
staged, the resume nudge still names one call, the latest, as before.

*Verified:* `session/verify.ts` §14, after the MCP-decline checks (`:2054`), with two parked Bash
requests on their own agent and job: "with two Bash calls waiting, a call for the second parks on
the second", "and under a fresh id, on the one with its input", "a third Bash call, neither of
them, is not parked on either"; then, with only the second answered (allow), "the second's allow
never runs the first's command" (the first's call parks on the first); then with the first denied
too, "both answers, given before the calls come back, survive: each to its own call". At `:2102`:
"a call under a fresh id, with one of its tool waiting, still parks". Amendment 30's "an MCP call
behind a waiting one is declined" and "a built-in one is still parked with it" pass unchanged. With
`arbiter/index.ts` put back as it was on `main`, five of the six new checks fail (the third Bash
call parked on the first; the allow ran the first's call; the second's answer was gone). `pnpm -r
typecheck` clean; `make test`: 27 PASS.

### Amendment 149 — post-merge, applied. **A run that throws before it begins gives its slot back and fails as a launch, rather than holding the slot for good and crashing the daemon.**

Daemon only (`session/supervisor.ts`, `session/verify.ts`). The user, 14 Oct: "Execute wave 1 of
docs/plans/wave-11.md … following §0"; this is the plan's item A1 (lane S1, §2 "a throw before
`try` leaks a slot"). Amends Amendment 47 (the slot limit) and F13/F20 (a failure has its reason):
the failed launch they describe now also covers what throws before the run. Nothing a person sees
changed, so `docs/MANUAL.md` is unchanged.

- **What was wrong.** `#launch` took the slot (`this.#active.add`, `supervisor.ts:1225`) and only
  then opened its `try` at the call to `runner.run`. In between ran `#openRun`, the status writes,
  `emit`, `#pushEntities` and `createBackend` with its arguments (`#reachable`, `#rolesScope`,
  `personaScope`). A throw there skipped the `finally` that frees the slot, left the row `working`
  so `pump` passed over it for good, and rejected a promise every caller had dropped with `void`,
  which on Node 22 ends the process. `#launchWithPrompt` had the same shape (`:2144`).
- **The `try` starts at the slot** (`supervisor.ts:1230`, `:2149`). Everything after `#active.add`
  is inside the `try` whose `finally` frees the slot (`:1282`, `:2192`), so a throw anywhere before
  the run ends through the catch that was already there: `launch_failed` from `#launch` (`:1273`),
  `resume_failed` from `#launchWithPrompt` (`:2185`), with what was thrown as its detail, then
  `recordRunEnd`, `#settle` and `pump` as for any failed run. No second failure path. The code
  moved is unchanged, only indented; `began` is now read just before it rather than after.
- **Nothing is launched and forgotten.** The five `void` calls — `pump` (`:970`), a decision that
  landed while a run unwound (`:1296`), the hand-off ask after a restart (`:1651`), `resumeParked`
  (`:1948`) and `sendMessage` (`:1993`) — each end in a `.catch` that logs
  `[supervisor] <id> launch threw` or `resume threw`, so what still throws after the slot is freed
  (`#settle`, `pump`) is a line in the log, not a crash.

*Not done / not decided:* if `#settle` itself throws (the database failing), the slot is freed and
the error logged, but the row can stay `working`; that is a database fault, not this item. A launch
that throws before its run is counted as a run in Metrics (`recordRunEnd`), as one that throws
inside it already was.

*Verified:* `session/verify.ts` §13, beside the launch-failure checks (`:1753`): the `copilot`
engine is replaced through `registerBackend` with one whose `create` throws, one slot is left
free, and each agent has its own job. "a launch that throws before its run begins fails as
launch_failed, saying what", "and gives its slot back", "so the next queued agent starts in it";
then through `POST /api/agents/:id/message` to a finished agent: "a resume that throws before its
run begins fails as resume_failed" and "and the queued one starts, with no slot kept by the one
that failed" (exactly one more slot in use than before). The real engine and the slot setting are
put back after. Without the change to `supervisor.ts` the same run ends the process on Node 22 with
the unhandled `Error: no copilot backend`. `make test`: 27 PASS.

### Amendment 148 — post-merge, applied. **The developer runs on opus and every role but the architect on sonnet; a reading role runs read-only shell commands without asking.**

Asked for (14 Oct), two things. Amends Amendments 41 (the tier per role), 67 (a reading role
has no unattended shell), 126 (the built-ins' tiers "as they were") and 147 (the plan row's note).

**1. The default model per role.** The developer moves to the opus tier, the architect stays
there, and every other built-in role is on sonnet: the validator and scribe as before, and now
the reviewer, debugger and analyst too. Both places that keep a tier per role changed: each
preset row (`PRESETS`, `spawn/presets.ts`: full, bug fix, review only, analysis, Analysis Only,
one agent) and each built-in persona (`BUILT_IN_PERSONAS`, `spawn/personas.ts`). The
orchestrated pipeline's orchestrator is the architect persona and stays on opus. The roles it
lists by default follow their personas, so they are now developer on opus and validator,
reviewer and scribe on sonnet (`defaultListed`, `orchestrated.ts`); a role added there, or a
Custom row whose persona names no tier, is still sonnet (`tierOf`, `custom.ts`). Nothing in the
daemon or `shared` sets a tier per role; they only check and resolve one. A tier is still turned
into the newest model the catalog serves at launch (`lib/models.ts`): today opus is Opus 5.5 and
sonnet Sonnet 5.5, and no model id is written down. `TIER_HINTS` said opus is "what the presets
give to roles that design or judge", which stopped being true for the reviewer; it now says opus
goes to the architect and the developer, and sonnet to every other role.

A persona you edited keeps your model (only what differs from a built-in is stored), and a saved
Custom setup or a running agent keeps the tier or id it has.

**2. A reading role runs read-only shell without asking.** Until now every reading role (the
reviewer, debugger and analyst, the old auditor, and any row with a **write: off** persona) was
pinned to no unattended shell, so every Bash call it made that Claude Code's own read-only check
did not pass reached Needs You (seen: piped `git diff … | grep … | head`, `for` loops over
branches, `cd` before `git`). The owner's choice: read-only commands run without asking,
anything else still asks, and the write tools stay denied. For every reading role, not only the
reviewer.

- `READ_ONLY_BASH` (`shared/src/stack.ts`, beside `WRITE_TOOLS`) is the list, in Claude Code's
  rule syntax: `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`,
  `Bash(git blame:*)`, `Bash(grep:*)`, `Bash(cat:*)`, `Bash(head:*)`, `Bash(tail:*)`,
  `Bash(ls:*)`, `Bash(wc:*)`, `Bash(diff:*)`, `Bash(stat:*)` and `Bash(pwd)`.
  `READ_ONLY_BASH_DENIED` denies `Bash(git diff *--output*)`, `Bash(git log *--output*)` and
  `Bash(git show *--output*)`: `--output=<file>` is the one way those can write, and git refuses
  an abbreviated `--output`.
- `rowAutonomy` (`spawn/presets.ts`) adds both to a reading row's rope: the list to
  `allowedTools`, the denials to `disallowedTools` with `WRITE_TOOLS`. Bare `Bash` is still never
  in it, so any command off the list still goes to `canUseTool` and asks, and the arbiter's "run
  shell unattended" answer (`allowedUnattended`, Amendment 67) never applies to it. A Spawn row,
  a preset row and an orchestrator's listed reading role (`helperRolesFor`, so its helpers) all
  get it. An agent added to a running job gets the same (`addedAutonomy`, `spawn/stack.ts`),
  from a reader's template or a writer's, without listing anything twice.
- The plan row's note (`rowOverrides`) no longer says "asks before shell". With **run shell
  unattended** on, a reading row says `read-only shell only`; with it off, `read-only shell
  unattended`, since the row now does something the pills did not grant. The resulting SDK
  options summary (`describeAutonomy`) says `runs some shell commands unattended, asks before
  the rest` for such a rope, and an agent's inspector shows `bash asks · 14 allowed rules`
  (`agent/inspector.tsx`; hover for the list) beside the denied ones.
- The rules reach Claude Code as they are: `allowedTools` and `disallowedTools` pass to the SDK
  unchanged (`session/backends/claude.ts`), and Claude Code applies prefix and `*` rules itself.
  For Copilot and OpenRouter, which apply no rules, Conductor's `toolRuleFor`
  (`arbiter/index.ts`) does, and it learned three things to match Claude Code: each part of a
  shell line (`git log | head`) may be covered by a different allow rule; a deny rule's `*`
  matches anywhere (only a deny: an allow-always saved as an exact `rm *.o` stays exact); and an
  allow never covers a part that writes with `>`, `>>` or `&>` (`> /dev/null` and `2>&1` are let
  be), so `Bash(cat:*)` cannot write with `cat a > b`.

**What was left off the list, and why.** Checked on 14 Oct against the Claude Code the SDK runs
(2.1.284): a prefix rule lets every option of its command through, and Claude Code then skips
its own check of those options (under `Bash(sed -n:*)`, `sed -n '1w out' f` wrote `out`; under
`Bash(git diff:*)`, `git diff --output=out` wrote `out` until the deny above was added). So:
`sed`, even `sed -n` (`w` writes, `e` runs a command); `find` (`-delete`, `-exec`, `-fprint`);
`rg` (`--pre` runs a program); `sort` (`-o` writes, seen); `uniq` (a second file is its output);
`file` (`-C` writes `magic.mgc`); `tee` and `xargs`; every git command that changes the tree,
the index or the refs (`checkout`, `reset`, `stash`, `restore`, `switch`, `clean`, `commit`,
…); and `make` and the test runners, which write build output, since the code has no notion of
a safe test command. Claude Code's own read-only check still runs the plain forms of most of
these without asking (`find . -name x`, `rg x`, `sed -n 1p f` did, and it refused `find -fprint`
and `git diff --output` by itself). A redirect into a file is asked about by Claude Code
whatever the rules say (`cat a > b`, seen), and so is a read outside the agent's folders
(`cat /etc/hostname`, `ls /etc/ssh`, seen). On Copilot and OpenRouter, Conductor's gate does
not look at the paths a shell command names, so there `cat /etc/hostname` runs unasked: a read,
not a write, and left as it is.

**Not changed.** A writing role's shell is still the **run shell unattended** pill. The write
tools are still denied outright, a reading role's mode is still plan or ask me, MCP is still
off, and `readOnlyRefusal` (the daemon's check) is unchanged and passes these ropes. A running
agent keeps the rope it launched with: a reviewer launched before this asks as it did until it
is launched again. What Claude Code double-checks whatever the rules say still asks a reading
role: a `for` loop, `$VARIABLES` or `$(…)`, and `cd` into another folder before `git`. The pill's "Conductor
answers those for you" (Amendment 67) is for unattended shell, which a reading role never has.

**Verified:** `spawn/verify.ts` §26 (new, 32 checks): every preset row and built-in persona is
on its tier (architect, orchestrator and developer opus; the rest sonnet), and the hints and
the listed roles agree; the list has no command that writes or runs another (sed, find, rg,
sort, uniq, file, tee, xargs, make, test runners, git that changes anything); the reviewer,
debugger and analyst in every preset, with shell on or off and in every mode, have exactly the
list, no bare `Bash`, and the write tools and `--output` denied; a write:false persona, an
orchestrator's listed readers and an added agent the same; no writing role gets it; the
inspector counts the allowed rules. §2's
per-preset check now asserts the list as well as no bare `Bash`, and §5, §13, §16, §20, §21
and §25 assert the new tiers and the new wording. `session/verify.ts` (5 new checks): under the
reading rope, on the engines Conductor gates itself, read-only commands run alone and piped; a
redirect, a command off the list, `sed -n`, `find -delete`, `git checkout` and `cd x && git
diff` ask; `--output` anywhere on the line is refused; a deny's `*` matches anywhere and an
allow's does not. `make test`: 25 PASS. `preview/verify.ts` and `terminal/verify.ts` fail on this machine, the same
checks failing on unchanged `main` (Vite's file watcher stops with ELOOP on the scratch repo's
`inner/loopback` symlink under Node 24.18; the terminal's alternate screen and `pwd -P`), so not
from this change.

### Amendment 147 — post-merge, applied. **What you click on Spawn is what runs: a persona's tool rules no longer go over the pills.**

Found (14 Oct), the TODO.md item "A Custom launch loses the interaction, guardrails and effort
you chose": on Spawn with **custom…**, the **interaction**, **guardrails** and **effort**
clicked there were not always what the launched agents ran with.

**Root cause.** On Spawn, each row's tool rules were laid over the pills you clicked: through
`pillsWith` (`spawn/personas.ts`, now removed) inside `toAgentSpecs` (`spawn/presets.ts`), and
through `withTools` in `spawn/stack.ts` for a job's "+ agent" (also removed). So the built-in
architect persona `{bash: true, network: true, push: false}` always ran shell and network
unattended and could never push, whatever the launch's pills said — seen in this very job,
where the architect had `git push` denied while its helpers did not.

Effort and the interaction mode were traced end to end and were never lost: the daemon keeps
them as sent (`session/supervisor.ts:170`, `:1748`), the runner passes them to the SDK
(`session/backends/claude.ts:213`, `:240`), and the composer shows the stored values. What
looked like lost effort and interaction came from the persona override above, and from the
read-only pin on a reading role, which nothing on the row said.

**The rule now:**
1. A persona's `bash`, `push`, `network` and `mcp` no longer change an agent's autonomy
   anywhere: a Custom row, a preset row, a role an orchestrated stack lists, and a job's "+
   agent". The launch's pills, effort and mode are what run (`rowAutonomy`, `spawn/presets.ts`).
2. Only a persona's `write: false` still counts, making the row a reading row as a reading role
   already is: write tools denied, nothing auto-accepted, no unattended shell, no MCP, and mode
   `plan` if that was chosen, else `default`.
3. Each Spawn plan row, and each role an orchestrated stack lists (`Pipeline.tsx`), shows a
   short note under it when the pin changes what was clicked — `rowOverrides`
   (`spawn/presets.ts`): for example `reads only (reviewer): no file edits, asks before shell,
   no MCP, mode ask me`. A writing row says nothing.
4. Settings → Personas now offers only **write files**; the shell, push, network and MCP
   buttons are gone, since they did nothing any more (`TOOL_RULES`, `settings/route.tsx`).
   Stored values for those keys still parse and are kept on save (`PersonaTools`,
   `spawn/personas.ts`), but are ignored.

**Backwards compatible.** A persona saved with `bash`, `push`, `network` or `mcp` set still
round-trips through the editor and the setting; those fields are simply never read again. A
job already running keeps the autonomy it launched with, untouched.

**Verified:** `spawn/verify.ts` §25 (new, 26 checks): a Custom row, a preset row and a listed
role all follow the pills rather than the persona's `bash`/`push`/`network`/`mcp`, including
the Full preset's architect taken by role name and a job's "+ agent"; a reading role or a
`write: false` persona is still pinned, by role name and by a writing role given a reading
persona alike; `rowOverrides` says nothing for a writing row and the right words for a pinned
one, naming the role or the persona; and the plan rows and the listed roles render it.
`lib/verify.ts` §29 and `settings/route.tsx` check the editor offers one tool rule, not five.
`make test`: 27 PASS.

### Amendment 146 — post-merge, applied. **Every agent, project and the fleet show what was spent today and over its whole life; removing an agent or a job no longer lowers a total.**

Daemon (migration `db/migrations/240_spend_totals.sql` new, `session/store.ts`, `daily.ts`, `hub.ts`,
`session/supervisor.ts`, `session/backends/claude.ts`, `session/backends/copilot.ts`,
`session/verify.ts`), shared (`wire.ts`) and web (`lib/store.ts`, `shell/spend.ts`, `shell/shell.tsx`,
`shell/shell.css`, `shell/navtree.ts`, `shell/Navigator.tsx`, `fleet/project.tsx`, `fleet/card.tsx`,
`fleet/lane.tsx`, `fleet/order.ts`, `fleet/fleet.tsx`, `fleet/fleet.css`, `agent/inspector.tsx`,
`agent/composer.tsx`, `agent/agent.css`, and `lib/verify.ts`, `agent/verify.ts`, `shell/verify.ts`).
The user, 14 Oct: "the limits for each agent are day limits, it should reset on the next day.
however, also keep track of the total for each agent/project/fleet (and display where
appropriate)". Amends Amendments 59 (the status bar's figure), 124 and 129 (the lifetime figure
shown as information).

- **The limits were already per day; nothing changed there.** Checked: every cap reads today's
  spend. `agentBudget`/`budgetState`/`capState` (`shared/src/budget.ts`) read `spentOn(agent, today)`;
  the daemon's `budgetRefusal`, `budgetNote`, `runLimit` (`session/budget.ts`, the SDK's
  `maxBudgetUsd` from `spentToday(db, id).usd`, `backends/claude.ts:208`), the Copilot/OpenRouter
  token stop (`backends/copilot.ts`, `budgetRefusal` after each call), the `budget_over` alerts
  (`session/alerts.ts`, `agentBudget` and `spentOn(a, day)` for a job) and the job's ceiling
  (`jobBudgetState(..., jobCostToday(...))`, `session/supervisor.ts:1030`) all count today; the
  web's `budgetOf` (`shell/autonomy.ts:97`) too. `agents.cost_usd` is read only as the agent's
  lifetime figure, and by `lifetimeCost` to work out a run's growth (`scope.spentUsd`), never as a
  limit. No limit read the lifetime figure, so none was fixed.
- **A project's spend is its own record.** Migration 240 adds `project_spend_daily(project_id, day,
  cost_usd, tokens, PRIMARY KEY(project_id, day))`, with **no foreign key** to `agents` or
  `projects`. `addSpendToday` (`session/store.ts`) credits it in the same write as
  `agent_spend_daily`: both upserts in one `SAVEPOINT spend` (which nests inside a caller's
  transaction as well as standing alone, so neither is ever credited without the other), with the
  project read from the agent's row; an agent that no longer exists records nothing in either. So it
  grows by the same deltas: Claude's dollars by the growth of the lifetime cost, Copilot's and
  OpenRouter's input plus output tokens per call. Removing an agent, a job (`deleteAgent`,
  `deleteJob`) or a project's agents leaves its rows; `deleteProject` leaves them too, unread, as
  `cost_daily` keeps the fleet's money.
- **The backfill, once, in the migration.** First every dated row already in `agent_spend_daily`
  (today's and the days before it that 210 kept), summed per project and day, so today and the days
  since 210 start right. Then one **"before" row per project, on day `'0000-00-00'`**: the project's
  `SUM(agents.cost_usd)`, and for the engines that report no dollars `SUM(input_tokens +
  output_tokens)` (lifetime figures there; Claude's token columns are its last run's), less what the
  dated rows already hold, never negative, and only where something is left. A row in the same table
  rather than a `project_spend_base` table: a project's total is one `SUM` over its rows, and today
  is `day = localDay()`, which `'0000-00-00'` never is. What agents removed before the migration
  spent cannot be given back to their project; the fleet's total has it.
- **The fleet's all-time total is `SUM(cost_daily.cost_usd)`** (`costTotal`, `session/store.ts`).
  `cost_daily` has no foreign key, and no removal touches it (`deleteAgent`, `deleteJob` and
  `deleteProject` say so), so it already kept every removed agent's money. Dollars only, as today's
  figure is.
- **On the wire** (`shared/src/wire.ts`). `Snapshot.costTotal?: number` and
  `Snapshot.projectSpend?: ProjectSpend[]`, with `ProjectSpend { projectId, today, total, tokensToday,
  tokensTotal }` (`projectSpend`, `session/store.ts`: every project there is, zeros when it spent
  nothing). The `cost` frame keeps `costToday` and adds both, optional, so a page or a recording from
  before reads it as it did. `spendFigures(db)` is the three together; the supervisor's snapshot
  contributor sends them, `buildSnapshot` (`hub.ts`) copies the two new scalars, and
  `broadcastSpend(db)` (`daily.ts`) sends the frame: from Claude's result when its cost grows (it
  was `costToday` alone, `backends/claude.ts`), from each Copilot or OpenRouter call that adds
  tokens (new: a token engine's growth moved no frame before), and at the day change (`DayWatch`, so
  today reads zero and the totals do not move).
- **The page** (`lib/store.ts`). `State.costTotal` and `State.projectSpend`, null until a daemon says
  them; a snapshot sets both (null from one before this), a `cost` frame sets each only when it
  carries it. `useStatusBar()` returns `costTotal`; `useProjectSpend()` the list. The words are pure,
  in `shell/spend.ts`, so `lib/verify.ts` checks them: `totalWords`, `TOTAL_TITLE`,
  `projectPairWords`, `projectSpendOf`, `agentPairWords`.
- **The status bar** (`shell/shell.tsx`, `DailySpend`): today's spend as before (with its meter when
  a daily budget is set), then **· $X total** (`sh-spend-total`), whose hover is "spent by every agent
  since Conductor started counting, kept when agents are removed". A daemon before this sends no
  total, and the bar shows today alone.
- **A project: today $a · total $b.** On each Fleet card's footer (`fl-card-spend`), in the Project
  screen's header after its tag (`pj-headspend`), and in its column's **spend** line, which summed
  the current agents' `costUsd` (`fleet/project.tsx:323`) and so lost what a removed agent or job had
  spent. Dollars; a project whose agents ran on engines that report only tokens reads tokens
  (`today 3.4k tok · total 41k tok`), and one that ran on both reads `today $1.20 + 3.4k tok · total
  $8.40 + 41k tok`. From a daemon before this the pair is read from the project's current agents, as
  it was (`projectSpendOf`). Fleet's **Sort by → spend** orders by the project's total
  (`sortFacts(projects, agents, pending, spent?)`, `fleet/order.ts`; the navigator's `navProjects`
  passes the same list), the current agents' sum when there is none.
- **An agent: today and total side by side**, where one figure was: the Project lane (`fleet/lane.tsx`,
  was "Spent over its whole life" alone), the details panel's **spent** line (`agent/inspector.tsx`,
  was **lifetime**, and **not reported** on a token engine) and the composer's budget line
  (`agent/composer.tsx`, was "$4.10 spent today" with the lifetime in its hover): **today $4.10 ·
  total $31.40**. In the unit `capabilitiesOf(...).costUsd` says: on an engine that reports no
  dollars it is **today 110 tok · total 230k tok**, the total being its input plus output tokens. The
  budget meter and bar stay on today; the total is in the quiet ink (`ag-budget-total`), never in a
  budget's colours.
- **Design tokens only** in the new CSS (`sh-spend-pair`, `sh-spend-total`, `fl-card-spend`,
  `pj-headspend`, `pj-spendpair`, `ag-budget-total`): `--ink2`, `--ink3`, `--mono`, `--fs-sm`.
- **Verified.** `session/verify.ts` §28: the snapshot carries the total and every project's pair; a
  credited run raises the agent's, the project's and the fleet's totals and every page hears it in
  one `cost` frame; a token engine's call grows the project's tokens; removing the agent, then its
  job, keeps the project's and the fleet's; the day change resets today and not the totals, and its
  frame says so; and the backfill, on a scratch database migrated to 230 with agents that have
  lifetime spend, dated days, a token engine and none: dated days copied, the "before" row the
  rest, a project with no days gets its lifetime, one that spent nothing no row, and
  `projectSpend` reads today and the total right. `lib/verify.ts`: the store with and without the
  new fields (an old snapshot still renders), the status bar's text and hover, the project's pair in
  each unit and its fallback, the Fleet sort, an agent's pair in each unit and on a stale day, and
  the screens drawing them. `agent/verify.ts` and `shell/verify.ts` follow the new code.

### Amendment 145 — post-merge, applied. **What needs you is seen in light mode too.**

Reported 14 Oct: "the Needs you banner / text is not highlighted enough in the light mode". The rail's
backdrop was `--need` mixed 13% into transparency (`shell/shell.css`, `.sh-alert.is-live`); in light,
`--need` is a dark brown (`#8a4d00`), so the mix was a beige close to the page, and the navigator's
Needs you heading had only its text colour.
- **Token** `--need-wash` (`shared/src/tokens.css`): dark `#3a2b17`, light `#ffcf6b`, a clear amber.
- **Rail.** Backdrop `--need-wash`, fading only after 55%, with a 4 px `--need` bar at the left; the
  label at 600, the note in `--ink2`. Hover saturates it.
- **Navigator.** `.sh-nav-head.is-need` gets the same backdrop and a 3 px bar.
- **Verify:** `lib/verify.ts`: in both themes `--need`, `--ink`, `--ink2` are ≥ 4.5:1 on `--need-wash`
  (light `--need` 4.58), and `--need-wash` stands off `--bg` and `--bg2` by ≥ 1.15:1 (light 1.20).

### Amendment 144 — post-merge, applied. **Merge and clean up when a job finishes, by the agent's setting or a card.**

Daemon (`session/finish.ts` new, `session/supervisor.ts`, `session/alerts.ts`, `routes/session.ts`,
`db/migrations/230_finished.sql` new, `session/verify-finish.ts` new), shared (`wire.ts`), web
(`spawn/autonomy.ts`, `agent/composer.tsx`, `attention/alerts.ts`, `attention/AlertCard.tsx`,
`shell/describe.ts`, and the verify files). From the wave 10 plan (Lane K), with Q6 as decided on
13 Oct: a setting on the agent, "merge and clean up when done"; when it is on and the merge is
clean it happens by itself; when it is off, or the merge can't run cleanly, Needs You offers it.

**The setting** (`shared/src/wire.ts`). `Autonomy.mergeWhenDone?: boolean`, absent is off. The
daemon's `parseAutonomy` (`routes/session.ts:114`) keeps it only when it is `true`, so a launch, an
added agent and `POST /api/agents/:agentId/autonomy` (which merges over the stored autonomy) all
take it, and `false` or anything else removes it. Labelled **merge into main and clean up when
done** (`MERGE_WHEN_DONE_LABEL`, `spawn/autonomy.ts`), with one hint (`MERGE_WHEN_DONE_HINT`): the
branch is merged, then the job, its folder and its branch are removed, its agents can't be
messaged afterwards, their transcripts stay, and it never pushes.
- **Spawn.** A pill of `PILLS` (`spawn/autonomy.ts:84`), off in `defaultPills`; `toAutonomy` adds
  `mergeWhenDone: true` when it is on (`:192`) and changes no tool list, so every agent of the
  launch has it, a reading role too. Being a pill, **Settings → What Spawn starts from** shows it
  and keeps it in `conductor.launch.pills`; a saved set from before reads it as off.
- **The composer.** A pill with the guardrails (`agent/composer.tsx:150-160`), so it folds with
  them; it sends `{ mergeWhenDone: on }` alone.

**When a job finishes** (`session/supervisor.ts:1888`). `#rollUpJob` calls `#finished(jobId)` only
on the way into `done` (not when it settles `failed`, and not on a roll-up that changes nothing).
`finishJob` (`session/finish.ts`) runs after it, never throws (a failure is logged and the job left
as it is), and `Supervisor.finishing(jobId)` is the run in flight, for the verify. It does nothing
for a job that isn't isolated in a worktree of its own, or whose branch isn't ahead of the target
(`resolveTarget`'s, as the Branches screen draws). Otherwise, through `projectRepo`
(Amendment 143), as the Branches screen would:
- **The setting asked** (any agent of the job has `mergeWhenDone`), every agent of the job is
  `done` (a paused one may still need the folder), and Amendment 110's `previewMerge` gives no
  reason (so the target is checked out, clean, and nothing is live on either side) and no
  conflicts (`[]`; `null`, "this git can't tell", counts as not clean): the branch is merged with
  `branchAction` `merge` (the screen's merge, `--no-ff`, into the target), then removed with
  Amendment 143's `delete` and `forgetJob: true` (the job as DELETE /api/jobs/:jobId removes it,
  then `git worktree remove`, `prune`, `git branch -d`). This is the user's explicit opt-in. Each
  of the job's agents gets a synthetic `user_text` note in its transcript: what was merged into
  what, the short sha, and that the job, its folder and its branch were removed and the
  transcript stays. Needs You gets an information card, **Merged**.
- **Any step refuses, it stops there.** A preview reason, a conflict, an agent not done, or a
  merge that conflicts anyway (undone, as always): nothing is merged, and the card below says why
  (`detail`). A merge that went in with a clean-up that was then refused (an untracked file in the
  folder, say): the **Merged** card says it was not cleaned up and why, the agents' notes say so,
  and the job, its folder and its branch stay. No "merge?" card is raised for a branch already
  merged.
- **Otherwise** (the setting off): nothing moves, and Needs You asks.
- Nothing here pushes. Push stays a separate, confirmed action on the Branches screen.

**The cards** (`db/migrations/230_finished.sql`, `finishAlerts` in `session/finish.ts:194`). One row
of `job_finishes` per outcome (`offer` or `merged`), with the branch, the target, how far ahead,
the job's agents, the sha, whether it was cleaned up and why not. No foreign key to `jobs`: the
clean-up it reports removes the job. Alerts are derived from it, as the others are from what is
stored, so a restart keeps them; dismissals are `alert_dismissals`, and a write refreshes Needs You
(`onFinishesChanged`).
- **`finished`** (`Alert.kind`), id `finished:<row>`: the newest offer per job, while that job is
  still there and `done` (a job that runs again asks again when it next finishes; one that was
  removed has nothing left to offer). `branch`, `into`, `ahead`, `agentIds`, and `detail` when the
  setting asked and something refused.
- **`merged`**, id `merged:<row>`: every one, until dismissed. `sha`, `cleaned`, and `detail` when
  not cleaned up; `agentIds` empty once cleaned up.
- **Wire.** `AlertKind` gains `'finished' | 'merged'`; `Alert` gains `branch?`, `into?`, `ahead?`,
  `sha?`, `cleaned?`.

**Web** (`attention/alerts.ts`, `AlertCard.tsx`, `shell/describe.ts`).
- **Finished: merge into <target>?** (`alertTitle`; the top bar's word is "finished: merge?"),
  labelled **Finished** in `--need`, with the branch and its commits, and "not merged by itself"
  with the reason when there is one. Its buttons (`alertActions`, `:198`): **merge and clean up**
  first, which asks (`finishedConfirm`, `:213`: "Merge <branch> into <target>, then remove job
  <id>, its folder and its branch? Its agents can't be messaged afterwards; their transcripts
  stay."), then `mergeAndClean` (`:239`); **merge** (`mergeFinished`, `:222`): the preview first,
  refused with its reason or its conflicts named, then `POST …/branches { action: 'merge', branch,
  into }`, and the card is dismissed; the job, its folder and its branch stay. **open Branches**
  (`openBranches`), and dismiss. `mergeAndClean` is the same merge, then `{ action: 'delete',
  branch, forgetJob: true }`; a refused clean-up says "merged as <sha>, but not cleaned up: <the
  daemon's sentence>".
- **Merged**, in `--done`: the branch, the merge's short sha, "not cleaned up" with why when so, and
  a line saying the agent's setting did it and nothing was pushed. Open the agent (when it is still
  there), open Branches, dismiss.

**Verify.** daemon `session/verify-finish.ts` (port 7817, 38 checks, a real repo with real
worktrees, a fake SDK whose runs end at once, so each job settles through `#rollUpJob`): the
setting through the autonomy route (on, off, anything but true is off); on with a clean merge:
main has the merge commit, the job row and its agent are gone, its folder and branch are gone, its
transcript is kept with the note naming the sha, the **Merged** card says cleaned with the sha, and
no "merge?" card; on with a conflict: the card naming the file, main unmoved, nothing removed; on
with main's checkout dirty: the card with the merge's reason, nothing merged; on, merged, with an
untracked file in the folder: merged, the card says not cleaned up and why, everything still there,
the note says so; off: the card with no reason, nothing moved, then the card's calls: the preview
clean, merge keeps the job, folder and branch, dismiss puts the card away; off, merge then delete
with `forgetJob` removes the job, folder and branch, keeps the transcript, and the card goes with
the job; no card for a branch that isn't ahead or a job in the project folder; nothing pushed.
web `attention/verify.ts` §11 (16 checks): the buttons and their order, what they carry, the
confirm text, the titles and the top-bar word, and the calls behind them against a stand-in daemon
(preview then merge; preview, merge, then delete with `forgetJob`; a conflict or a reason stops
before the merge; a refused clean-up says the merge went in), and the card's wiring.
`spawn/verify.ts` §24 (9 checks): the pill, its words and hint, off by default, `toAutonomy` with
and without it, every spec of a launch, Settings keeps it and an older saved set reads it off.
`agent/verify.ts` (3 checks): the composer's pill, the field it sends, with the guardrails.

**Not done / not decided:**
- **Only `done`.** A job that settles `failed` gets no card.
- **Only into the target.** The card and the setting merge into the branch the Branches screen
  compares with when the job finished; the label says "main" as the plan words it.
- **The card stays after a merge made elsewhere** (on the Branches screen, say) until it is
  dismissed or pressed; pressing it then says there is nothing to merge.
- **No push.** As decided: pushing stays on the Branches screen.

### Amendment 143 — post-merge, applied. **Delete merged branches safely, one or all, never a folder an agent can still resume in.**

Daemon (`workspace/branches.ts`, `workspace/project-repo.ts` new, `routes/branches.ts`,
`workspace/verify-branches.ts`), shared (`wire.ts`), web (`branches/rules.ts`, `branches/route.tsx`,
`branches/branches.css`, `branches/endpoints.ts`, `branches/verify.ts`). From the wave 10 plan (Lane J).
It takes back Amendment 109's "no branch is ever deleted".

**The rule, from 9 Oct.** A `done` job's agent can be messaged again, and it then needs its folder:
removing a done job's worktree broke a user's agent (Amendment 114 is what that agent saw). So
nothing here removes a folder or a branch a job's agent could resume on, unless you choose to forget
that job too, and the job's transcripts are always kept.

**Wire** (`shared/src/wire.ts`). `BranchAction` gains `{ action: 'delete'; branch; forgetJob? }` and
`{ action: 'clean_merged'; forgetJobs? }`. `BranchActionResult` gains `removed?: string[]` (in order),
`kept?: { branch, why }[]` (clean_merged: each merged branch it left, with the sentence `delete`
refused it with) and `forgotJobs?: string[]` (the jobs removed first). Nothing else changed.

**`delete`** (`workspace/branches.ts`, `deleteOne` `:708`). Parsed like every action (`:221`): an
unknown branch or one starting with `-` is 400, and so is a `forgetJob` that isn't a boolean. Every
check runs before anything changes, each a 409 with one plain sentence, in this order:
- it is the **target** ("… is the branch everything is compared with; it isn't deleted here");
- it is checked out in the **project's own folder** (`rootBranch`, or a worktree at the project's
  path), read from `git worktree list` afresh rather than the listing's `worktree`;
- it isn't **merged** into the target: no target branch at all, no shared history, or `ahead > 0`
  ("… has N commits main doesn't; it isn't merged, and git branch -d would refuse it");
- what `git branch -d` will judge it by: its upstream when it has one (`upstream.ahead > 0` is
  refused, "… and git branch -d checks against it; push it first"), else HEAD where `-d` runs, which
  is the target's checkout (else the repo's top level, checked with `merge-base --is-ancestor` first).
  So `-d` can't refuse after the folder has gone;
- its worktree has **uncommitted** files, `status --porcelain`, untracked ones included (a folder that
  can't be read is refused too);
- a job on it has a **live** agent (`working`, `blocked`, `queued`), even with `forgetJob`;
- a job **owns** it (any job of the project on that branch, or whose folder is that worktree, plus
  the listing's `jobId`) and `forgetJob` isn't set: *"job <id>'s agents can still be messaged, and
  they need this folder; remove the job, or choose 'forget the job too'"* (`ownedSentence`, `:689`).

Past them: with `forgetJob`, each owning job is removed first exactly as DELETE /api/jobs/:jobId
removes it (`Supervisor.deleteJob`: the job row and its agents go, the events table keeps their
transcripts, the workspace is forgotten rather than closed); then `git worktree remove -- <path>`
(never `--force`), `git worktree prune`, and `git branch -d -- <name>` (never `-D`) in the target's
checkout. A git refusal there is a 409 with git's words. Remotes are never touched. The answer is
`{ ok: true, merged: [], removed: [name], forgotJobs, output }` (git's "Deleted branch …").

**`clean_merged`** (`:914`). Every branch but the target with `ahead === 0` and history in common
(`mergedBranches`, `:785`), oldest tip first, one at a time, each against a fresh listing, through
the same `deleteOne` with `forgetJobs` as its `forgetJob`. A refusal doesn't stop it: the branch is
listed in `kept` with its sentence. `{ ok: true, merged: [], removed, kept, forgotJobs }`. Unmerged
branches are not listed.

**The store's side** (`workspace/project-repo.ts`, new). `projectRepo(db, projectId, forgetJob)` builds
the `BranchRepo` from the store as `routes/branches.ts` did (target, `live`, `rootLive`,
`setDefault`), plus `BranchRepo.jobs` (`BranchJobs`, `branches.ts:72`): the project's jobs read afresh
each time, and `forgetJob`, which the route passes as `supervisor().deleteJob`. The `jobId`/`live`
lookup is re-read after each forgotten job. `openRepo` takes it as a last optional argument (no jobs,
nothing to forget, by default). Amendment 144 opens a project's branches through the same function.

**Screen** (`branches/route.tsx`, `rules.ts`).
- **Delete** in the action bar of every branch (`route.tsx:637`), disabled with its reason from
  `deleteReason` (`rules.ts:233`) otherwise: the daemon's checks in its order, worded for the bar.
  The jobs that own a branch are `ownersOf` (`:216`): the listing's `jobId` and every job of the
  project in the store on that branch. With one, a checkbox **forget its job too (its transcripts
  stay)** (`FORGET_LABEL`) sits beside it, unticked each time a branch is selected; ticked, the
  delete sends `forgetJob: true`. **Delete** asks first (`deleteConfirm`, `:255`), naming the branch,
  its folder (or that it has none), that origin keeps its copy, and, forgetting, the jobs and that
  their agents can't be messaged afterwards while their transcripts stay.
- **⌫ Clean up merged (n)** in the head (`route.tsx:298`), n the branches that would go with the
  checkbox as it is (`cleanState`, `:266`); disabled with a reason when nothing is merged, or when
  every merged branch is kept for a reason even with jobs forgotten. Its confirm lists each branch
  that would go as `branch · folder · job` (`cleanLine`), then each that would stay with why, the
  same checkbox (sending `forgetJobs: true`), **Clean up** and Cancel.
- The result says what went and which jobs were forgotten (`removedText`), and lists each kept
  branch with its sentence. Styles: `.br-clean-list`, `.br-check` (tokens only).

**Verify.** daemon `workspace/verify-branches.ts` §13 (47 checks; 183 in all), in a repo of its own
whose project folder is on a branch that isn't the target: each refusal (the target, the folder's
branch, unmerged, a commit the upstream lacks, an untracked-only folder, a live job even with
`forgetJob`, a done job without it, bad `forgetJob`, `-` and unknown names) leaves the branch, and the
folder where there is one; a plain merged branch and one with a clean folder are removed (folder,
worktree entry and branch gone, "Deleted branch" said); a pushed one goes locally and stays on
origin; a done job's branch with `forgetJob` removes the job row and its agent, keeps its events, and
removes its folder and branch; the source uses `'branch', '-d'` and never `-D` or a forced worktree
remove; `clean_merged` removes the plain one and keeps a stopped job's, an uncommitted one, the live
one, the unpushed one and the folder's own, each with its sentence, never listing the target or an
unmerged branch; with `forgetJobs` it removes the job-owned one too, oldest tip first, transcripts
kept; origin's refs are exactly as before. web `branches/verify.ts` §10 (29 checks): every
`deleteReason` sentence, the owners, the confirm texts, `cleanState` with and without forgetting,
the result text, and the route's Delete, checkbox, confirm, actions sent and kept list.

**Not done / not decided:**
- **Remote branches** are never deleted, here or anywhere.
- **A job's folder that is the project folder** (`in_place`, `branch` isolation): the job still owns
  the branch, so it is kept unless forgotten; the folder itself is never removed (the branch checked
  out there is refused).
- No undo. A deleted branch's commits are in the target (that is what merged means), and git's
  reflog keeps the tip for a while.

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

### Amendment 141a — post-merge, applied. **The scheduler lifts only a hold it put on.**

Found 13 Oct by lane F: `Scheduler.#once` (`daemon/src/session/schedule.ts`) called `release()` whenever
no pause was set and the supervisor was held, so a hold someone else put on (a verify file freezing the
queue with `supervisor().hold()`) was lifted within 5 s and queued agents started. `#holding` records
that the hold is the scheduler's; only then, or on the first tick after a start, does it release.
**Verify:** `session/verify-schedule.ts` (43 checks) and `workspace/verify-methodology.ts` (93, with no
stray launch) pass.

### Amendment 141 — post-merge, applied. **The terminal, the rest of the plan: settings, add-ons, paths into Files, a Terminal dock under every screen, a `terminals` frame and the headless mirror.**

Daemon, web and shared. From `docs/plans/full-terminal.md` §4-§7 and the wave 10 plan (Lane H);
it finishes what Amendment 112 left out. Q5 stands: no tmux, so a daemon restart still ends every
shell.

**H1: settings.**
- Three settings, in Settings (9) under **Terminal**, with rules in the daemon
  (`daemon/src/terminal/prefs.ts:49-55`, through `settingRule`, `settings.ts:33`):
  `conductor.terminal.fontSize` (9 to 24, default 13), `conductor.terminal.scrollback` (1,000 to
  100,000, default 5,000) and `conductor.terminal.shell` (one of the shells this machine has,
  default the one Amendment 112 picked). The keys, ranges and the parser (`termNumber`, digits
  only, so `5e3` and `13.5` are refused) are shared (`shared/src/wire.ts:1096-1106`).
- **The shells.** `findShells` (`daemon/src/terminal/shell.ts`): `$SHELL`, then `/etc/shells`
  (absolute paths only, comments skipped), then `/bin/zsh`, `/bin/bash`, `/bin/sh`, each only if
  it is there, no repeats; two with the same name are labelled with their path. `pickShell` takes
  the setting when it names one of those that is still there, else falls back as before.
  `GET /api/terminals/shells` → `{ shells: TermShell[], default }` (`routes/term.ts:133`). A new
  terminal runs the chosen shell; open ones keep theirs. `TermInfo.shell` says which ran.
- **Settings screen.** `TermNumber` and `TerminalSection` (`web/src/settings/route.tsx:186-275`) in
  the `SlotsSection` pattern: a draft written on Enter or blur, Esc puts it back, the default
  written as nothing; the shell is a select of the daemon's list, and a setting naming a shell no
  longer there is shown as such. The Terminal dock's height joins the layout reset.
- **Xterm reads them** (`web/src/agent/Xterm.tsx`): the font size and scrollback at creation, and
  a change applies to an open terminal; a new font size re-fits, so the shell gets its new size.
  The fixed `fontSize: 13` and `scrollback: 5000` are gone.

**H1: add-ons** (`web/package.json`): `@xterm/addon-search` 0.16.0, `addon-web-links` 0.12.0,
`addon-clipboard` 0.2.0, `addon-webgl` 0.19.0 and `addon-unicode11` 0.9.0.
- **Find**: ⌘F on macOS, Ctrl-Shift-F elsewhere, opens a find bar in the terminal's corner; typing
  searches as you go, Enter is next, Shift-Enter previous, Esc closes it and gives the terminal its
  focus back.
- **The key map** is `termKey` (`web/src/terminal/keys.ts`): find, copy (with a selection only),
  paste and clear are ⌘F/⌘C/⌘V/⌘K on macOS and Ctrl-Shift-F/C/V/K (and Shift-Insert to paste) on
  Ubuntu; everything else is the shell's, Ctrl-C included. Paste is left to the browser, so
  xterm.js bracket-pastes it. `wantsCopy` (Amendment 112) is now one row of it.
- **URLs** open in a new browser tab (`noopener`).
- **OSC 52** (`vim`, `tmux` copying to the clipboard) writes the clipboard; a read is answered
  with nothing, so a program cannot see what you copied elsewhere.
- **WebGL**, with xterm.js's DOM renderer when WebGL is not there (the addon throws on load) or
  the context is lost (`onContextLoss` disposes it). Unicode 11 widths for wide characters and
  emoji (`allowProposedApi`).
- **Mouse reports as bytes.** `t.onBinary` (`Xterm.tsx:225`) is sent as a new client frame,
  `{ t: 'bin', d: <base64> }` (`TermClientFrame`, `shared/src/wire.ts:1086-1090`); the daemon
  writes the bytes themselves (`routes/term.ts`, `parseClientFrame` refuses anything that is not
  base64). Sent as `in`, an X10 mouse report past column 95 was UTF-8 encoded on the way and each
  byte over 127 became two. `Pty.write` takes a `Buffer` (`terminal/pty.ts:22`).

**H1: paths open in Files.** A link provider (`Xterm.tsx:152`) finds file paths in each line
(`findPathLinks`, `web/src/terminal/paths.ts`): `path:line`, `path:line:col` and tsc's
`path(line,col)`, or a path with a `/` in it; a bare word such as `node.js`, a version, a time and
the inside of a URL are not. Each is taken relative to the folder the terminal started in and must
stay inside its worktree (an agent's) or project folder (the dock's): `termFileTarget` resolves it
with `files/links.ts`' `resolveDocLink`, so `..` past the root, `~`, another folder and a
`/w/job-evil` beside `/w/job` are plain text. Clicking opens Files (5) on that root
(`navigate(SCREEN.files, { jobId, path, line })`). Files learned `&line=`: `followLink` keeps the
line wanted per tab (`web/src/files/useTabs.ts:147-166`), and the pane shows the file raw with that
line marked and scrolled to the middle, once (`FilePane.tsx`, `rawAround` in `files/links.ts`).
The cell mapping counts a wide character as two cells.

**H2: project terminals.** `TermScope = { kind: 'agent'; agentId } | { kind: 'project'; projectId }`
(`shared/src/wire.ts:1024`), on every `TermInfo`. The manager (`daemon/src/terminal/service.ts`)
lists by scope; each terminal also carries its job and project, so removing a job ends its agents'
terminals as before, and removing a project (`closeProject`, `service.ts:274`, called from
`supervisor.ts:709`) ends its own and any of its agents'. Same cap (16 live, of either kind), same
lifetime rules. New routes (`routes/term.ts:123-131`): `GET` and `POST
/api/projects/:projectId/terminals`, the shell starting in the project folder; 404 for an unknown
project.

**H2: the `terminals` frame.** `ServerFrame` gains `{ type: 'terminals'; scope; terminals }`
(`shared/src/wire.ts:909`), the scope's whole list, broadcast whenever a terminal in it opens, exits,
is closed or is forgotten (`TerminalManager.onChange`, wired to the hub at `routes/term.ts:70`). It
never carries output. The web store hands it to `web/src/terminal/live.ts` (`lib/store.ts:197`),
and every terminal panel showing that scope takes the new list, so a terminal opened in one browser
tab is listed in the others.

**H2: the Terminal dock** (plan D8b; `web/src/terminal/dock.tsx`). Under every screen, above the
status bar (`shell/shell.tsx:334`): the terminals of the project you are on (the one the navigator
highlights, `currentProject`, `shell/navtree.ts:344`), in tabs, each in the project folder, **+**
for another. Ctrl-` opens and closes it from anywhere, a terminal included (Xterm lets the key
through), and so does the status bar's **▸ terminal** (`shell.tsx:231`). Its height is dragged at
its top edge and kept (`TERMINAL_DOCK`, `shell/panels.ts:96`, `conductor.terminalDockH`), and
whether it is up is a setting (`conductor.terminal.dock`). The tabs are `TermTabs`
(`web/src/agent/TermPanel.tsx`), the Agent tab's, made scope-generic; `TermPanel` is it for an
agent, with the runner fallback. The Project screen dock's placeholder terminal tab
(`fleet/dock.tsx:65`, "not yet assigned") now opens the Terminal dock.

**H2: the headless mirror** (`daemon/src/terminal/mirror.ts`). `@xterm/headless` 6.0.0 and
`@xterm/addon-serialize` 0.14.0 (`daemon/package.json`), loaded lazily through `createRequire`.
Each terminal has one, at the PTY's size and with the scrollback setting, fed every byte the shell
prints, resized with it. A page that attaches is sent its `serialize()` (screen, alternate screen,
cursor, modes and scrollback) as the first binary frame, instead of the last 512 KB of raw output;
so reattaching mid-`vim` draws `vim`'s screen. The snapshot waits for the emulator to have parsed
every write before it (`write('', cb)`), and output arriving meanwhile is held for that page and
sent after it (`service.ts:180`), so nothing is lost or doubled. The socket protocol is unchanged
for the page: binary frames, the screen first. If the packages do not load, a terminal keeps the
raw 512 KB replay (`ring.ts`), as it does if serializing fails. The mirror's own backlog counts
toward the pause at 1 MB (`#throttle`, `service.ts:346`), as a slow page's does, since xterm.js
drops a write queue past 50 MB.

**Verified.** `daemon/src/terminal/verify.ts`, 141 checks (100 before): §1 the shells found, the
setting's pick and its fallback, `bin` parsed and non-base64 dropped, the mirror loads; §4 bytes
sent as `bin` reach the shell as bytes (`od` reads `41 fc 0a`) and text as UTF-8 (`41 c3 bc`); §6 a
page reattaching after 900 KB of output gets the screen and its 5,000 lines, under 256 KB, ending at
the tail; §6b with the mirror forced off, the old 512 KB replay; §6c after a program switches to the
alternate screen, clears it, places three lines by cursor moves and leaves the cursor mid-screen, a
page reattaching (its bytes drawn in a fresh headless terminal) is on the alternate screen with each
line where it was put and the cursor at row 3 column 7, the shell's screen behind it comes back on
leaving, and it is live after; §11b a project terminal opens in the project folder, is listed with
its scope and not in an agent's list, closes, and 404s for an unknown project; the hub sends a
`terminals` frame for each open, close and exit (listed exited, with its code), for the agent's
scope apart, carrying only `type`, `scope` and `terminals`; §11c each setting refuses out of range
(`8`, `25`, `13.5`, `5e3`, `999`, `100001`, an unknown shell) with the range, and takes good values;
`/api/terminals/shells` lists `/bin/sh` as the default; a chosen shell is what a new terminal runs;
with scrollback 1000, a page reattaching after `seq 1 3000` gets 1,000 lines plus the screen; §12
removing the project ends its own terminal too, and the hub says it has none. `web/src/agent/verify.ts`
§ "the terminal, the rest of the plan": the key maps on both OSes (and what is left to the shell),
Ctrl-`, path parsing (`path:line:col`, tsc's form, a full stop, words that are not paths, URLs) and
`termFileTarget`'s inside/outside rules, `rawAround`, the settings readers and field messages, the
dock flag, `bin` keeping 0xfc one byte, the frame reaching only its scope's panel, and the wiring
from the source. **A person checks** `vim`, `htop`, `less` and mouse mode in a browser, WebGL and
the DOM fallback, and Ubuntu (plan §5).

### Amendment 140 — post-merge, applied. **The retry delays and the budget ceiling are settings, the first retry has its card, a new day continues what only its budget paused, and the navigator has the meters.**

Shared, daemon and web (`shared/src/{retry,budget,index}.ts`, `daemon/src/session/{retry,budget,
alerts,supervisor,store}.ts`, `daemon/src/routes/session.ts`, `web/src/lib/settings.ts`,
`web/src/settings/{budgets.ts,route.tsx}`, `web/src/shell/{navtree.ts,Navigator.tsx,autonomy.ts,
describe.ts,shell.css}`, `web/src/agent/{reconnecting.ts,inspector.tsx}`,
`web/src/attention/AlertCard.tsx`, `web/src/spawn/route.tsx`). The wave 10 plan's Lane G, with §6 Q3
and Q4 both yes. Amends Amendments 123 (the retry), 124 and 129 (the ceiling, and midnight). No
migration.

- **`conductor.retryDelays`** (`shared/src/retry.ts`, new): one to five whole numbers of seconds,
  separated by commas, each from 1 to 1800; how many there are is how many tries. Default
  `5, 15, 30, 60, 300`, the list that was fixed at `daemon/src/session/retry.ts:26`. The rule
  (`parseRetryDelays`, `retryDelaysProblem`) is shared, so the daemon's `settingRule` (400 with "one
  to 5 whole numbers of seconds, separated by commas, each from 1 to 1800") and the Settings field
  read it the same way. `RETRY_DELAYS_MS` and `MAX_RETRIES` stay as the defaults; `retryDelaysMs()`
  is the schedule in force, read from the cached settings (`settings.ts:46`) each time a wait is
  decided (`decideRetry`, which takes `delays?` for a pure call), so a change applies to the next
  failure and a wait already counting keeps its time. `of` in the retry and the card is the set
  list's length.
- **`conductor.budgetCeiling`** (`shared/src/budget.ts`): a number from 1 to 10, default 2
  (`BUDGET_CEILING`, `:35`). `ceilingOf(budget, ceiling = budgetCeiling())` reads it on every call,
  rounded to a millionth (25 × 1.1 is 27.5). Shared imports neither side: each says where its copy
  of the settings is through `readBudgetCeilingFrom` (the daemon's file, `daemon/src/session/
  budget.ts`; the page's map, `web/src/lib/settings.ts`), and a value that is not one reads as 2.
  `capState`, `budgetState`, `jobBudgetState`, `runLimit`, `budgetRefusal` and `budgetNote` all go
  through `ceilingOf`, so the warning, the stop, the SDK's limit and the sentences move with it at
  the next check. A change re-reads the alerts and pumps (a job held at the old ceiling may start);
  it wakes nothing paused, as raising a budget wakes nothing. The words: `ceilingWords()` is "twice"
  at 2, else "1.5×", in `failureSentence`, the inspector, the over-budget card and Spawn's hints.
- **The first retry's card** (Q3). `RETRY_CARD_FROM = 1` (shared), read by the daemon's alert
  (`RETRY_ALERT_FROM`) and by the agent's line and banner (`describe.ts`, `reconnecting.ts`), which
  are amber from it. It was 2. The card's id is the bout's, so it chimes once, at the first retry, as
  every alert chimes at once (`dueForChime`), and later retries update it. Claude Code's own
  in-flight retries (the Model API alert, `ALERT_FROM_ATTEMPT`) are unchanged.
- **A new day continues a budget pause** (Q4). `Supervisor.newDay` (Amendment 129's day turn): with
  `conductor.budgetResumeAtMidnight` on (the default; `on` or `off`, 400 otherwise), an agent
  paused ONLY by a budget, at its own ceiling (`budget_exhausted`) or held for its job's
  (`job_budget_reached`, the job not still at its ceiling), with room on the new day
  (`continuations`, pure, in `budget.ts`; a renewed note counts, since it is still only a budget
  pause), is resumed as ▶ resume resumes it (`resumeAgent(id, note)`): queued, with
  `newDayNote(day)` ("a new day's budget began (2033-02-11) — continuing") on the status event, and
  on its next run told `NEW_DAY_NUDGE` (a synthetic turn, as every resume prompt; it outranks only
  the plain wake). Queued, so the slots, the job's figure and a pause of everything (`supervisor().held`,
  in which `pump` starts nothing) still decide when it runs. A pause you made, a hold's, a strand,
  a failure or any other note is left. With the setting off, Amendment 129 as it was: the pause is
  rewritten as renewed and nothing resumes. Returns how many it continued or rewrote.
- **At start** (`Supervisor.catchUpDay`, from `routes/session.ts` after the scheduler has put back a
  pause of everything and before the first pump): a daemon that was down at midnight saw no turn, so
  a paused agent whose last status event is from an earlier local day (`lastStatusDay`, new in
  `store.ts`) gets what the turn would have given it, continued or (off) renewed. A budget pause
  written today is not touched. Amendment 129 left these until the next midnight.
- **Settings (9).** Under Agents, the waits (`RetryDelaysRow`); under Spend, the ceiling
  (`CeilingRow`) and **at midnight, continue agents the day's budget paused** on/off
  (`MidnightRow`). The two fields are `SlotsSection`'s pattern: a draft checked as it is typed, the
  problem in the field's sentence (`web/src/settings/budgets.ts`), written on Enter or blur, put
  back by Esc, the default written as nothing.
- **The navigator's meters.** `NavAgent.budget` is `budgetOf` (the Fleet lane's figure, the same
  day), `NavJob.budget` the sum of its agents' (`sumBudgets`, `shell/autonomy.ts`: dollars when any
  budget is in dollars, and then only those; null when none has a budget). `Navigator.tsx` draws the
  Fleet's `pj-meter` with `data-tone` on the agent row and the job heading, with a hover
  (`meterTitle`); `shell.css` only sizes it (`.pj-meter.sh-nav-meter`, no colour), and the panel
  imports `fleet/fleet.css` so the tones are there on every screen. No budget, no bar.
- **Not done.**
  - A page re-reads the ceiling when it next renders; a meter already drawn changes at its next
    redraw, not the instant the setting does.
  - The job's meter in the navigator is its agents' budgets added up, not the daemon's job ceiling
    (`jobCap`), which an uncapped agent lifts. It is a picture, not the stop.
  - A continued agent whose job is at its ceiling after all (a budget lowered between the turn and
    the pump) is paused again by `pump` with the job's note, as before.
  - Retries still do not survive a restart (Amendment 123).
  - Not looked at in a browser, in either theme.

**Verified:** `session/verify.ts` (1,388 checks, 60 new): §23 with a set list (`2, 7`: two tries,
waits of 2 s and 7 s through the supervisor, the transcript saying them, the third failure failed;
bad lists 400 with the sentence; 30 min × 5 taken; removing it puts the default back), and the card
from the first retry with the same id at the second, every tab told at the first; §24 with the
ceiling set (bad values 400; at 1.5 a $25 budget stops at $37.50, the warning goes, the refusal and
the pause note say $37.50; at 1 the budget is the stop; at 10 the SDK is given $210 of $250); §26,
Amendment 129's checks, now with the continue off; §27 (31 checks): the setting's rule; at the turn,
one at its ceiling and one held for its job continued within one free slot, each with the note, the
running one resuming its session told `NEW_DAY_NUDGE` with the whole new day's $50, the second
going when the slot frees, a person's pause and a strand left, a later message ordinary, a second
turn nothing; with everything paused, continued but not run until `release`; `continuations` pure;
at start, an earlier day's pause continued and today's left, a second look nothing, and with the
setting off renewed instead. §17q (Amendment 103's day turn) runs with the continue off. Web:
`shell/verify.ts` §11 (17 checks: the rows' meters, tones, the job sum, units never added, a stale
day, the hover, the ceiling set, the source and the CSS), `lib/verify.ts` §38 (17 checks: the rows'
rules and values, the page reading the ceiling, the rows' pattern, the daemon's rules), and the
retry tone in `lib/verify.ts`, `agent/verify.ts`, `attention/verify.ts` (the first retry's card
chimes once), `spawn/verify.ts`. `pnpm -r typecheck` and `make test` green.

### Amendment 139 — post-merge, applied. **A branch only on origin is tracked, Spawn lists the branches you can name, and a refusal is a sentence.**

Daemon, shared and web (`daemon/src/workspace/{git,worktree,branches}.ts`,
`daemon/src/session/supervisor.ts`, `daemon/src/routes/workspace.ts`, `shared/src/wire.ts`,
`web/src/spawn/{launch.ts,route.tsx}`). The wave 10 plan's Lane F: the four "Not done" of Amendment 115.
No migration.
- **A branch only on origin is tracked.** `branchExists` looks at `refs/heads/` only, so a name that
  existed only as `origin/<name>` was cut fresh from `HEAD`, with none of origin's commits. In
  `#addNamed`, after the same refusals in the same order (a name git rejects, 400; the default branch,
  409; one checked out somewhere, 409), a name with no local branch whose `refs/remotes/origin/<name>`
  exists (`originBranchExists`, new in `git.ts`) is added with
  `git worktree add --track -b <name> -- <path> origin/<name>`: a local branch at origin's tip with
  its upstream set, so a push goes back there. **Nothing fetches**: it is origin as last fetched (the
  Branches screen's **fetch**), and a name on neither is cut from `HEAD` with no upstream, as before.
- **`BranchesResponse.remoteOnly?: string[]`** (`wire.ts`, optional, so an older web reads the answer
  as it did). `listBranches` lists `for-each-ref refs/remotes/origin` (`originNames`), leaves out
  `origin/HEAD`, and removes every name with a local branch (`remoteOnlyNames`, pure), sorted. Empty
  for a repo with no origin. The Branches screen does not show it.
- **Spawn's branch picker.** (2)'s name field gets a `<datalist>` (`list="sp-branch-list"`), so it is
  still free text and a new name still works. `getBranches` is called when (2) is chosen and again
  when the project changes (not for a folder with no git); a failed fetch lists nothing.
  `branchOptions(res, defaults)` (pure, `launch.ts`) builds the list: the local branches first, in the
  daemon's order, then the origin-only ones labelled **on origin**. A local branch a named launch
  refuses is listed with why, not hidden: the project's default (`Project.defaultBranch`, the same one
  `branchProblem` refuses; the compared-with branch is not a default) as **default branch (refused:
  choose 1)**, one an agent is on as **an agent is on it (checked out)**, one some worktree has
  (the project's own folder included) as **(checked out)**. `pickedNote` puts a sentence under the
  field for the name typed: an origin-only one says a local branch tracking `origin/<name>` is made;
  a checked-out one says the launch will be refused, drawn as the field's problem note but **not**
  holding the launch back, since the list is what was true when it was fetched and the daemon has the
  last word. The pill's hint and the empty field's note say a branch only on origin is tracked.
- **`restoreFolder`, said plainly.** After `worktree prune`, and before `worktree add`, when
  `listWorktrees` shows the job's branch checked out at another path, it throws `FolderGoneError`:
  "`<branch>` is checked out in `<path>`; remove that worktree or check out another branch there, then
  recreate". `POST /api/jobs/:jobId/folder` already answers that error with 409 and the sentence;
  before, git's refusal was a 500. The project's own folder on that branch is named by its path.
- **`POST /api/workspaces`.** `fail()` answers a `LaunchBranchError` with its own status and
  `{ error: 'could not use that branch', detail: <the sentence> }`, the shape `POST /api/jobs` uses.
  The route still does not pass `named`, so nothing raises it there today; it is no longer a 500 if
  something does.
- **Not done.**
  - Spawn does not fetch, so a branch pushed to origin since the last fetch is neither listed nor
    tracked: it is cut from `HEAD` as a new one. **fetch** on the Branches screen first.
  - Only `origin`: a branch on another remote is not listed or tracked.
  - A browser's `<datalist>` cannot be greyed per option, so a refused branch says so in its label.
    Not looked at in a browser, in either theme.
  - The bootstrap `POST /api/workspaces` still resets an explicitly named branch with `-B`
    (Amendment 115's note stands).

**Verified:** `workspace/verify-methodology.ts` §11 (93 checks in all, 14 new), against a bare origin
with two branches the repo has never had locally, fetched once, one of them pushed to again since: the
listing's `remoteOnly` is both, sorted, without `HEAD` or `main`; `remoteOnlyNames` pure; a launch
naming one is 201, on a local branch whose upstream is `origin/<name>`, at origin's tip as fetched
with origin's file in it, and the later push is not there (nothing fetched); then it is not in
`remoteOnly`, naming it again is the usual 409, a bad name is still 400, the default still 409, and a
name on neither is cut from `HEAD` with no upstream. `session/verify-folder.ts` §5 (23 checks, 5 new):
the job's branch in another worktree → 409 with the sentence exactly, and nothing made; in the project's
own folder → 409 naming it; once free, recreated on its branch as before. `spawn/verify.ts` §22 (15 checks): the picker's order and labels, a daemon with no `remoteOnly`,
a name both local and on origin listed once, a compared-with branch that is not the default offered,
the two notes, a checked-out pick still launching, and the screen's source (the datalist, its fetch and
its keys). Also `workspace/verify-branches.ts`, `workspace/verify.ts`, `branches/verify.ts`,
`pnpm --filter @conductor/web verify` and `pnpm -r typecheck` green.

### Amendment 138 — post-merge, applied. **Files makes folders, renames and deletes, and the navigator's folders get a `+`.**

Shared (`wire.ts`), daemon (`workspace/paths.ts`, `workspace/service.ts`, `workspace/tree.ts`,
`workspace/git.ts`, `workspace/watcher.ts`, `routes/workspace.ts`, `workspace/verify-files-verbs.ts` new)
and web (`files/deleting.ts` and `files/DeleteConfirm.tsx`, new; `files/FileTree.tsx`,
`files/NewFileForm.tsx`, `files/naming.ts`, `files/tabs.ts`, `files/useTabs.ts`, `files/useWorkspace.ts`,
`files/route.tsx`, `files/files.css`, `files/verify.ts`, `shell/Navigator.tsx`, `shell/shell.css`,
`shell/verify.ts`). Asked 13 Oct, in the wave 10 plan (lane E, and Q2: a folder with files in it can be
deleted, after a confirm and a second "Are you sure?" naming how many files go). Amendment 121 left
"new folders, rename and delete" not done, and the navigator's folders (Amendment 92) with no `+`. No
migration.

- **Routes**, for a job (`/api/jobs/:jobId/…`) and a project folder
  (`/api/projects/:projectId/dir/…?dir=`), addressed as the two PUT routes are. One handler per verb,
  registered for both by `verbs(prefix, rootOf)` (`routes/workspace.ts:240`, `:304`, `:394`):
  - `POST …/folders { path }` → 201 `CreateFolderResponse`. `mkdir -p`; anything at the name (a file,
    a folder, a link) is a 409 "<path> already exists"; a folder in the name that is a file is a 409
    "… cannot be made: a folder in that name is a file". **`folders`, not `folder`**: `POST
    /api/jobs/:jobId/folder` is already Amendment 114's (put back a job's deleted worktree,
    `routes/session.ts:702`), and Fastify refuses a second route on it at boot.
  - `POST …/rename { from, to }` → `RenameResponse { from, to, type }`. `from` missing is a 404; `to`
    taken is a 409, except by `from` itself under another case (same inode and device, names equal
    but for case), which on a case-insensitive filesystem is the rename someone fixing `readme.md`
    means; a folder into itself is a 400, and so is `to` equal to `from`. Folders above `to` are made.
    A plain file moves by hard link then unlink (`moveNew`, `service.ts:886`), so a name an agent took
    since the check is not replaced, for the reason `publishNew` exists (Amendment 121); a folder, a
    link and a case-only rename use `rename`. A link is moved as the link.
  - `GET …/entry?path=` → `EntryResponse { path, type, files, folders, capped?, tracked }`: what a
    delete would take, counted on disk (`filesUnder`, `service.ts:909`), ignored files and
    `node_modules` included, since a recursive delete takes those too and the tree lists neither. It
    stops at 50,000 entries and says `capped`. `tracked` is how many git has (`trackedCount`,
    `git.ts:183`, a `:(literal)` pathspec), null when the root is not a repo. Read-only, no lock.
  - `DELETE …/entry?path=[&recursive=1]` → `DeleteEntryResponse { path, type, files }`. A file or a
    link (never what it points at) goes; a folder only when empty, or with `recursive=1`. Not empty
    without it is a 409 "<path> is not empty: it holds N files". A folder with a `.git` anywhere in it
    is a 409 even with it ("… holds a git repository (vendor/lib/.git); delete it outside Conductor"):
    a nested clone's history may be the only copy. `recursive` is read as strictly as `createOnly`:
    `1`/`true`, `0`/`false` or absent; anything else is a 400.
- **One gate, `resolveEntry`** (`paths.ts:149`). It is `resolveForWrite` with one difference: the
  parent is canonicalised (the nearest existing ancestor realpath'd, missing segments put back) and the
  last segment kept as typed, so a link is the link. Same refusals, all 400 through `fail()`: `..`, an
  absolute path, anything under `.git` (any case, any depth), a link out of the root. Two more: the
  root itself (`.`, `src/..`), which no verb may make, move or delete; and a `.git` reached through a
  link (`gl -> .git`, then `gl/config`), checked again on the canonical path.
- **Lock and log.** Every change runs under the same per-root lock as a write (`#lockKey`,
  `service.ts:613`: `job:<id>`, or `dir:<path>`). The files a rename or delete changed are handed to
  the watcher in one batch (`Watcher.touchAll`, `watcher.ts:208`), as a write's path is with `touch`,
  so emission stays in one place and a job's tree and the log hear of it at once: a renamed tracked
  file is a `file_edit` deleted for the old path and created for the new, a deleted one stays in the
  tree as a deleted change to review (Amendment 29). A folder made or emptied is no `file_edit` (the
  log is of files), and a project folder has no watcher; the screen re-reads the tree for both.
- **Empty folders are in the tree** (`tree.ts`). `git ls-files` lists files, so a new folder was on
  disk and nowhere on screen. In a repo, `untrackedDirs` (`git.ts:194`, `ls-files -o --directory`)
  names the untracked folders, run beside `listFiles`, and `emptyUnder` (`tree.ts:159`) opens them, at
  most 2,000 folders per read, for the ones with nothing listable; they go in as Amendment 90's empty
  directories already did. With no git, `walkFiles` lists an empty folder as itself. The deny-list
  (`node_modules` and the rest) still applies.
- **Files tree** (`FileTree.tsx`, `TreeVerbs`). A folder row has **+/** (new folder) after its **+**,
  and every row on disk has **✎** (rename) and **⌫** (delete), all siblings of the row's button, shown
  on hover and focus and always where there is no hover. A file row is now a `.c5-filerow` holding its
  button and those. On a focused row **F2** renames and **Delete** or **⌘⌫** deletes. Each tree's
  heading has **+/** beside its **+** (`route.tsx` `RootSection`). One box at a time in a section.
- **The box is `NewFileForm`**, with a `kind`: `folder` starts at `new-folder` and may end in `/`
  (`checkFolderName`, `naming.ts:93`); a rename starts at the entry's whole path with its last name
  selected, a file's without its extension (`prefillRename`, `naming.ts:82`), opens in the row's place,
  and Enter on the name it already has puts it away. Enter commits, Esc cancels, the daemon's sentence
  shows under it. A made folder is opened in the tree, with its ancestors.
- **Delete asks** (`deleting.ts`, pure; `DeleteConfirm.tsx` draws it under the row). A file is one
  confirm naming it, saying whether git has it. An empty folder is one confirm. A folder with files is
  a first confirm naming the folder and how many files it holds, then a second, "Are you sure? N files
  go with notes/, and this cannot be undone from Conductor.", whose yes alone sends `recursive=1`
  (`deleteSteps`, `deleting.ts:91`; `onYes`, `:127`). The count is the daemon's (`GET …/entry`); the
  tree's own count shows until it lands and the button waits for it, because the tree leaves out what a
  recursive delete takes. The focus starts on **keep it**, and Esc is it, as in the tab strip's confirm.
- **Open tabs follow** (`tabs.ts`, pure: `renameTabs` `:361`, `closeUnder` `:389`, `tabsUnder`, `renamedPath`).
  A rename moves every tab on the path, or inside the folder, to the new path in the same place in the
  strip with its view and scroll, the front tab stays in front, and the folders opened and closed under
  it keep that state. `followRename` (`useTabs.ts:223`) moves their unsaved edits first, so the sweep in
  `update` keeps them: what you were typing stays. A delete closes the tabs at or under it once the
  delete has landed (`closeDeleted`); their unsaved edits are named in the first step ("Your unsaved
  edit to docs/a.md goes with it."), which is the asking a dirty tab's close does, said once for all.
- **Client** (`useWorkspace.ts:423-463`): `createFolder`, `renameEntry`, `entryInfo`, `deleteEntry`,
  next to `createFile`, each through `rootEndpoint` and each re-reading its root's tree when it lands;
  a refusal rejects with the daemon's sentence and re-reads nothing. A renamed file's last copy is
  carried to its new name, so its tab shows at once.
- **Navigator +** (`Navigator.tsx:201-384`). Each folder node and each folder row in it has a **+**
  (`AddButton`, a sibling of the row's button, `aria-label` "New file in …", hover and focus as the
  Files tree's, `.sh-nav-add` in `shell.css`). It opens the same `NewFileForm` in place; the file is
  made with `createFile`, opened ready to type with `openNew`, then Files is shown on it
  (`navigate(SCREEN.files, navFileLink(…))`). Only a new file here; rename and delete are on Files.
- **Not changed:** writes and `createOnly`, `resolveForWrite`, Amendment 114's `…/folder`. Colours are
  existing tokens only (`--surf`, `--line2`, `--ink`, `--ink3`, `--fail`, `--bg2`).
- **Not done:** drag and drop to move; renaming or deleting the root folder of a tree (refused by
  design); a rename or delete in the navigator; the Files tree and the navigator have not been looked at
  in a browser in either theme. An empty folder that git ignores is listed if it sits inside an
  untracked folder (`emptyUnder` reads the disk there). The tree read now runs one more `git ls-files`
  (in parallel with the first).

**Verify:** `workspace/verify-files-verbs.ts` (101 checks, a temp repo opened as an in_place job and a
plain folder as a project's directory, port 7838): for each root, a new folder and its parents (201,
in the tree while empty), 409 on a taken name, on a file and under a file, three at once give one 201
and two 409; rename of a file, of a folder into new folders, of a link (as a link), 404 from missing,
409 onto a file and onto a folder, 400 into itself and to the same name, a case-only rename (the disk
asked whether it is case-blind; on macOS it is) and, there, another file onto a case-different name is
409; `entry` counts files and folders and says what git has (null without git); delete of a file and a
link (never its target), 404 when gone, 409 without recursive (and with `recursive=0`), 400 for
`recursive=yes`, gone with `recursive=1`, an empty folder without it, 409 for a folder holding a `.git`;
`..`, `../outside.txt`, an absolute path, `/etc`, `.git`, `.git/hooks/pre-commit`, `.GIT/config`,
`src/../.git/x`, `.` and `src/..` refused by every verb (folder, delete, entry, rename from and to),
`.git` through a link and a link out of the root refused; empty folders inside untracked and tracked
ones listed, `node_modules` still not. For the job, a renamed tracked file emits its deletion and the
new file, a deleted folder emits each tracked file as deleted and the tree keeps them. A job with no
workspace and a folder not the project's are 404s, no `dir` is a 400. `files/verify.ts` "new folder,
rename and delete": `renameTabs` (order, front tab, other roots, folder state, view and scroll, a
displaced tab, no-ops), `tabsUnder` and `closeUnder`, the live store moving an unsaved edit with a
rename and dropping it with a delete, `deleteSteps` and `onYes` (one step for a file and an empty
folder, two for a folder with files, the count repeated, recursive only on the second yes, waiting for
the daemon's count, "1 file goes", "at least", unsaved edits and git named), `countTreeFiles`,
`prefillFolder`, `prefillRename`, `checkFolderName`, the tree drawn with and without `verbs` (which rows
get which buttons, siblings of the row's button, the + still first, rename in place, the folder box
and the confirm under their rows, F2 and Delete), the four client calls for both roots with their
re-reads, the screen's wiring, the navigator's `+` on folder rows and nodes, and tokens only in the
new CSS. `shell/verify.ts`'s "fetched with the Files screen's own hook" now accepts the import naming
more than `useFileTree`.

### Amendment 137 — post-merge, applied. **A browser opens the sockets in token mode with `?token=`.**

Daemon only (`daemon/src/index.ts`, `daemon/src/terminal/verify.ts`). Asked in the 12 Oct TODO's loose
end "Token mode" and the wave 10 plan (Lane D). With `CONDUCTOR_TOKEN` set, the feed socket (`/ws`) and
the terminal socket (`/ws/term/:id`) were refused to a browser even with the right `?token=`. The
cause: the bearer hook in `index.ts` runs on every request, the WebSocket upgrade included, and wanted
`Authorization: Bearer …`, which a browser cannot set on a WebSocket. `/ws` had this before the
terminal existed, and `terminal/verify.ts` §15 asserted the refusal ("exactly as /ws is"). The web
already sends `?token=` from `VITE_CONDUCTOR_TOKEN` on both sockets (`web/src/lib/feed.ts:87-89`,
`web/src/agent/term.ts:41-45`); nothing there changes.

- **The two sockets are checked by `?token=`.** In the bearer hook, a request with
  `Upgrade: websocket` whose path is `WS_PATH` or starts with `/ws/term/` (`isBrowserSocket`) is let
  through on a `?token=` equal to the token, and on nothing else: no token, a wrong one, or only a
  bearer header is 401, answered on the raw socket and ended, as the guard's 403 is, so a refused
  upgrade cannot hold `app.close()` open.
- **Constant time.** The token is compared with `crypto.timingSafeEqual` (`isToken`), a different
  length refused before comparing. The bearer header and the websocket `verifyClient` use it too.
- **Unchanged:** the localhost Host/Origin guard (`guard.ts:41`) runs first, so a foreign Origin is
  403 whatever its token; every other request, including a plain GET to `/ws` or `/api/...` carrying
  `?token=`, still needs the bearer header; `/preview/` is still exempt.

**Verified:** `terminal/verify.ts` §15, against a daemon started with a token (21 checks): for the
feed and the terminal socket, `?token=` alone connects, and from a local Origin; no token, a bearer
header without `?token=`, a wrong token of the same length, a shorter or longer one, and a foreign
Origin with the right token are each refused; a plain HTTP request with `?token=` is 401, with the
bearer header 200, with a wrong one 401. Against the old hook, the four "connects" checks fail.

### Amendment 136 — post-merge, applied. **Metrics say what they mean, and can be read for one project.**

Daemon (`db/migrations/220_metrics_project.sql` new, `session/metrics.ts`, `routes/metrics.ts`,
`session/verify.ts`). Wire (`MetricsCounts.claudeCalls`, `MetricsResponse.project`, and `MetricsProject`
at the end of the Metrics section of `shared/src/wire.ts`). Web (`metrics/rules.ts`, `metrics/route.tsx`,
`metrics/endpoints.ts`, `metrics/metrics.css`, `metrics/verify.ts`, `lib/verify.ts`). Asked 13 Oct (wave
10, Lane C; Q1 answered yes): fix the three "Not done" items of Amendment 122 about what its rates mean,
and add the per-project filter it left out. The causes, from 122's own notes: (1) the Errors tile divided
retries by every engine's calls, though only Claude reports a retry (`api_retry` comes from
`backends/claude.ts` alone), so with Copilot or OpenRouter agents in the range the rate read lower than
Claude's own; (2) "per call" divided a Claude turn's `duration_api_ms`, which covers its subagents and
their side-by-side calls, by `num_turns`, so it was not the length of one API call; (3) the total's speed
added every engine's output tokens over every engine's model time; (4) `metrics_daily` is keyed
`(day, provider, model)` and had no project.

- **The retry rate is out of Claude's calls.** `MetricsCounts` gains `claudeCalls`, the calls of rows whose
  provider is `claude` (`RETRIES_REPORTED_BY` in `session/metrics.ts`), summed by the daemon for the
  total, each model and each day. `derive` (`rules.ts`) divides `retries` by it, and the Retried cell is
  `retries/claudeCalls`. When another engine ran in the range (`otherEnginesRan(models)`), the Errors tile
  says "6 of Claude's 200 calls retried (3.0%)" and its hover says why; with Claude alone it reads as
  before ("6 of 250 calls retried"); with no Claude calls it says only Claude reports retries, not "0 of
  50". A non-Claude row's retries stay a dash.
- **Time is per turn, subagents included.** `apiPerCallMs` is `apiPerTurnMs`; the tile reads "2.0 s per
  turn, subagents included", the column is **Per turn**, and both hovers say a Claude turn's subagents can
  run side by side, so it is not the length of one API call. Copilot and OpenRouter, which time each call,
  are one turn per call, so the same words hold.
- **Speed is each model's own, averaged.** A row's speed is still its timed output tokens over its model
  time. The total tile's is `averageSpeed(models)`: the mean of the models' own speeds, said as "(average
  of N models)" when there are several, instead of all tokens over all time, which mixed a fast small
  model's seconds with a slow large one's. The spec asked for per run then averaged; the rows are daily
  sums per model, so per model is the finest figure there is. (A Claude run's output tokens, its
  subagents' included, are still credited to its main model's timed tokens, as in 122.)
- **Per project: a table of its own.** Migration `220_metrics_project.sql` adds `metrics_project_daily
  (day, project_id, provider, model, …the same twelve counters…)`, keyed `(project_id, day, provider,
  model)`, and `metrics_meta.project_since`, the instant it began. It is not a re-key of `metrics_daily`:
  that table, every row in it and every query on it are untouched, and the all-projects view still reads
  it. `bump` writes both tables from the same call, with the agent's `projectId` (read when the result
  arrives, kept with the run's credit for `recordRunEnd` and the `failed` that follows), inside a
  SAVEPOINT (`atomically`) so the two never disagree, including when a status event is heard inside
  someone else's transaction. Like `metrics_daily` it references nothing: removing a job, an agent or a
  project leaves the counts. Counts from before the migration have no project and are under all projects
  only.
- **Route.** `GET /api/metrics?range=…&projectId=…`. Without `projectId`, as before, with `project: null`.
  With it: 400 for an id that is not the shape of one (`/^[A-Za-z0-9_-]{1,64}$/`), an empty one or a
  repeated one; 404 for a project that is not there; otherwise that project's counts from
  `metrics_project_daily`, `project: { id, name }`, `since` the day per-project counting began (so `all`
  starts there), and no `before` line (the agent rows from before recording cannot say whose runs were
  whose). A bad range is still 400 first.
- **Web.** A project picker in the head, after the range: **All projects**, then each project by name
  (`projectChoices`), kept as the setting `conductor.metricsProject` like the range; a remembered project
  that has been removed is All projects again (`asProject`). The screen shows an answer only for the range
  and project it asked for. With a project picked, a short note above the tiles says "Counts for alpha start
  on Tue 13 Oct, when per-project counting was added. Earlier runs are under All projects only."
  (`projectNote`), and How these are counted says the same. `.mt-project` uses tokens only.
- **Hotkey comment.** `lib/verify.ts` §15's made-up screen named `'8'` "a hotkey no real screen has";
  Metrics has had `8` since 122 and every digit is a real screen's now, so it uses `'x'`, and a new check
  reads every `route.tsx` to confirm no real screen registers it.
- **Not done.** (1) Nothing was looked at in a browser: the picker's place in the head and both themes
  are held by the stylesheet checks only. (2) The retry rate's whole is "the `claude` provider's calls",
  a constant beside the reader, not a backend capability; an engine that starts reporting retries needs it
  changed. (3) A Claude run's output tokens are credited to its main model, so a model's speed with busy
  subagents on another model is still a blend; the rows cannot split it.

**Verified:** `session/verify.ts` §22 (15 new checks): with Copilot calls in the range, the total's
`claudeCalls` is the Claude rows' calls and less than all calls; a Claude row's `claudeCalls` is its calls,
a Copilot row's none, every retry on a Claude row; `?projectId=` names the project and its A, B and
gpt-4.1 rows equal the all-projects ones, with no `before` and `since` the per-project start; the project
table has the rows; another project's OpenRouter agent (`recordCall` twice, `recordRunEnd`) is in its own
view and the all-projects one and not this one's, an empty project is an empty report and not a 404; an
unknown project is 404; `..%2F`, an empty id and two ids are 400, and a bad range with a project is still
400. `metrics/verify.ts` (new §2b and §6b, more in §3, §4, §7): mixed-engine fixtures (opus 200 calls with
6 retries, Copilot 50): the rate is 3.0%, not 2.4%; the tile says "of Claude's 200 calls" only when another
engine ran; Copilot alone says only Claude reports retries; speed averages 200 and 100 to 150 tok/s, not
189; Per turn and its hovers; the picker's choices, the remembered project, the note, the request's
`&projectId=` and the route's 400/404. `lib/verify.ts` §15: the made-up key is one no screen uses.
`pnpm -r typecheck`, `pnpm --filter @conductor/web verify`, `metrics/verify.ts` and `session/verify.ts` pass.

### Amendment 135 — post-merge, applied. **Needs You's `project / role` label uses the Agent screen's backdrop.**

Web only (`attention/route.tsx`, `lib/verify-crumb.ts`, `shell/ui.css` (a comment)), and
`docs/MANUAL.md`. No behaviour, wire or daemon change, no migration, no new token. Asked: a TODO.md
loose end (12 Oct, "Label backdrops (127)"), taken into the wave 10 plan as Lane B: "Needs You's
`project / role` header stays on `--here`, so it no longer matches the Agent screen it came from."
It finishes Amendment 127, whose own **Not done** said the same.
- **The label for the request in focus** (`project / role`, `route.tsx`) is now
  `ui-crumb is-agent`, so it sits on `--here-agent`'s wine rose, the Agent screen's backdrop, in
  both themes. It names an agent, the one whose request you are answering, so it reads as that
  agent's screen at a glance. The text is unchanged, and so is the layout: `is-agent` sets
  `--crumb` and nothing else (Amendment 127).
- **The other two Needs You headers stay on `--here`**: `needs you / N alerts` (alerts only) and
  `needs you / nothing` (queue clear). They name the screen, not an agent or a project, so they
  keep Fleet's slate blue, like Preview, Files and Branches. Neither is a project-only label, so
  nothing on Needs You uses `is-project`.
- **Checked**: `lib/verify-crumb.ts` section F no longer counts Needs You among the screens that
  stay on `--here`. It finds the span that starts with `{focused.projectName}` and fails unless its
  class is exactly `ui-crumb is-agent`, and fails unless `route.tsx` has three crumbs, that one and
  two plain `ui-crumb`. Fleet, Preview, Files and Branches are still checked to carry neither class.
- **Not done**: not looked at in a browser, in either theme. Amendment 127's question stands: the
  three backdrops differ only a little in lightness, so say if Needs You's label and Fleet's are
  too alike once seen.

**Verified:** `lib/verify-crumb.ts` (PASS, section F's two new checks among them),
`attention/verify.ts` (PASS), `attention/verify-needs-panel.ts` (PASS), `lib/verify.ts` (PASS),
`pnpm --filter @conductor/web typecheck` (clean).

### Amendment 134 — post-merge, applied. **`make start` says when the install is out of date, and starts nothing.**

Make and scripts only (`scripts/check-install.mjs` new, `Makefile`, `scripts/verify-check-install.mjs`
new). Asked 13 Oct, in the wave 10 plan (lane A, from the "Right now" list in `TODO.md`). After a pull
that adds a package, `make start` started the daemon and Vite against a `node_modules` that didn't have
it, and the browser showed Vite's `Failed to resolve import` overlay, which looks like a bug in the
code. The cause: nothing compared the install with `pnpm-lock.yaml` before starting.

- **The check** (`scripts/check-install.mjs`). pnpm writes a copy of the lockfile to
  `node_modules/.pnpm/lock.yaml` on every install, and when the install is current the two are the
  same byte for byte (checked 13 Oct). `installState(root)` reads both: `current`, `stale` when they
  differ, `missing` when there is no copy (no `node_modules`, or an install that didn't finish). Paths
  are from the script's own location, not the cwd; `--root <dir>` points it at another checkout.
- **Current:** exit 0, says nothing. **Stale or missing:** one line on stderr, *"Dependencies are out
  of date: run `make install` (or `pnpm install`), then start again."*, and exit 1. With
  `CONDUCTOR_AUTO_INSTALL=1` it runs `pnpm install --frozen-lockfile --prefer-offline` in the checkout
  instead (output shown) and exits with its code, so a lock that no longer matches `package.json`
  still stops the start.
- **Makefile.** A `check-install` target runs it. `start` depends on it before anything else, so a
  stale install starts no process and writes no pid. `restart` is `check-install stop start`: it checks
  before it stops, so a stale install doesn't take down what is running and then refuse to start it.
- **Unchanged:** `make install`, `pnpm dev`, `make fixture` and `make attention` don't check.

**Verify:** `scripts/verify-check-install.mjs` (24 checks: temp checkouts under the system temp dir for
current, stale, no `node_modules`, no copy and line endings alone; the CLI on each with a fake `pnpm`
first on the PATH, so "starts nothing" is seen, not assumed; `CONDUCTOR_AUTO_INSTALL=1` runs the
frozen, offline-first install in the checkout and passes its exit code through; and with no `--root`
it checks its own repo from any cwd). In `make test`. By hand, 13 Oct: a newline appended to
`pnpm-lock.yaml`, `make start` and `make restart` printed the sentence, exited non-zero, and created
no run directory; the lock put back, the check passed.

### Amendment 133 — post-merge, applied. **An agent's turn ending ends its process, so nothing it starts is left to die in the background.**

Daemon only (`session/background.ts` new, `session/backends/claude.ts`, `session/verify.ts`,
`session/verify-background.ts` new). ADR 0010. Reported 12 Oct: an architect designed and
executed a plan, then said the agents after it "exited when the session ended" without doing
their work. The cause: a Claude run ends at its first `result` and closes its input
(`claude.ts`), so the Claude Code process exits, and a subagent it started with
`run_in_background: true` dies with it. A background subagent reports back by waking the main
loop for another turn, and nothing can wake a process that has gone. It is not Conductor's
stacks: those start on `hand_off`, after the turn.

- **Every Claude agent is told** (`TURN_END_LINE`), appended to its system prompt after its
  persona's own (Amendment 68), so an agent without a persona now carries a system prompt
  `append` too: when its turn ends its process ends, and background subagents, workflows,
  background shell commands and scheduled wake-ups die with it. Run subagents in the
  foreground; several in one message still run in parallel.
- **A background `Agent` (or `Task`) call runs in the foreground.** The PreToolUse hook returns
  `updatedInput` with `run_in_background: false` and an `additionalContext` note saying why. On
  the observe path it sends no permission decision, so the guardrails and `canUseTool` still
  decide whether it runs; on the allow path the rewrite rides with the allow. Checked against
  the real SDK (0.3.284) on 12 Oct: the call ran in the foreground and its answer came back as
  its result, with and without an allow.
- **`Workflow` is declined** with the reason and what to do instead, since it only runs in the
  background.
- **Left alone:** background `Bash` (a dev server for this turn's tests is meant to stop with
  it; the line warns), and the Copilot engine, which has no background subagents.

**Verified:** `session/verify-background.ts` (17 checks: the pure rules, then a real runner's own
hook, as the SDK calls it) and `session/verify.ts`'s persona checks, which now expect the line.

### Amendment 132 — post-merge, applied. **A question is held until you answer it, and takes no slot meanwhile.**

Asked 12 Oct, after 131: "when I finally answer, why can't it pick up where it left off", then "do never
set aside". Parking a question ends its process, and Claude Code can't revive the cancelled call: the
agent comes back one message later (131's answered nudge), not mid-call. So a question isn't parked.
- **Arbiter.** `QUESTION_DEFER_AFTER_MS` is `null` (never) unless `CONDUCTOR_QUESTION_DEFER_AFTER_MS` is
  set; no longer follows `CONDUCTOR_DEFER_AFTER_MS`. A question gets no timer, page open or not
  (`parks` is false for it), so it is held until answered, paused, or the daemon stops. `Held.question`
  marks it; `#unhold` (every removal from `#held`) calls `AgentControl.slotsChanged` when it was one;
  `waitingOnQuestion(agentId)`. Permissions are unchanged: 90 s, or at once with no page open.
- **Supervisor.** `#slotsUsed()`: live runs except those `waitingOnQuestion`. `pump()`, `resumeParked`
  and `slots` use it in place of `#active.size`. `slotsChanged()` pushes the slots frame and pumps, so a
  question starting to wait frees its slot for queued work. Answered, it counts again, which can take
  the live count past the limit for a while; nothing is stopped for that.
- **Unchanged:** a pause parks a question at once (`parkForAgent`), and `recoverOrphans` parks one a
  restart left; answering either resumes with 131's nudge.
- **Verify:** `session/verify-answer.ts` §2 (held with no page open, takes no slot, queued work starts,
  the answer goes into the waiting call with no new run, counts again), 21 checks.

### Amendment 131 — post-merge, applied. **A question you answer after a while comes back as your answer.**

Reported 12 Oct: "when an Architect is waiting for an answer, if I take a while to respond it loses
track of what it was doing. I give an answer and it still does not proceed." Cause, from the event log
and the architect's own session file: a question was held 90 s (`DEFER_AFTER_MS`), then parked by
`interrupt()`, which Claude Code records as the tool result *"The user doesn't want to proceed with
this tool use … STOP what you are doing and wait for the user"*. On the answer, the agent was resumed
with *"Your AskUserQuestion call was approved by the human. Make that exact call again now"*, with no
answer in it: it had to re-ask to get it (PreToolUse applies the staged answer), against a transcript
telling it to stop. Of 25 answered questions, 13 were parked; it recovered most of the time, and when
it didn't the answer was lost.
- **Hold questions longer.** (Superseded by 132: never.) `QUESTION_DEFER_AFTER_MS`, default 30 minutes
  (`CONDUCTOR_QUESTION_DEFER_AFTER_MS`, else `CONDUCTOR_DEFER_AFTER_MS` when only that is set). A held
  question costs a slot and no tokens, and answering it is the live path: no interrupt, nothing lost.
  Permissions keep 90 s. With no page open a question still parks at once.
- **Say the answer.** `#resumePrompt`, for a staged `answer`: `answeredNudge(questions, answers,
  response)` — what happened ("put to one side … came back as 'the user doesn't want to proceed'.
  Ignore that."), each question with its answer, anything you added, then "Carry on … Do not ask this
  question again." The staged decision stays, so an agent that asks again anyway still gets your answer.
- **Verify:** `session/verify-answer.ts` (port 7814, 15 checks, fake SDK). In `make test`.

### Amendment 130 — post-merge, applied. **Only a project you haven't looked at since it finished says FINISHED.**

Web only (`fleet/rest.ts`, new; `fleet/card.tsx`, `fleet/project.tsx`, `lib/verify.ts`). Reported
12 Oct: on the Fleet page every project said FINISHED, so there was no telling which one had
just finished and needed a review.
- **Why.** Amendment 87 made **finished** the mark for a job you haven't seen. Amendment 93 then
  made the rolled-up `done` status read `finished` as well (`STATUS_WORD.done`), in the same
  filled green tag. A project you reviewed last week looked like one that ended a minute ago.
  A project with no agents at all rolls up to `done` (`rollupStatus([])`), so it said FINISHED
  too, and so did its card's stripe.
- **The rule** (`restOf(status, agentCount, unseenFinished)`, pure): no agents is `empty`, read
  **no agents**; `done` with no unseen finished job is `done`, read **done**; anything else is
  the status as it was. Both quiet words use the `idle` tone, unfilled, and the card's left edge
  goes to `idle` with them. The loud, filled **finished** is drawn only for an unseen finished
  job, as Amendment 87 had it, and is untouched.
- **Where.** The Fleet card's headline and stripe; the Project screen's header and each job
  group's tag (which also no longer says finished twice when the group is unseen). Opening the
  project marks its jobs seen as before, and the green mark turns into **done**.
- **Not changed.** `STATUS_WORD.done` stays `finished` for an agent (the agent rows, the lanes, the
  Agent screen's header): Amendment 105 keeps the per-agent mark in the navigator and the tabs.
  Amendment 93's filled tags and edges, and the daemon, are untouched.
- Checked in `lib/verify.ts` §37: the rule for each case, and that the card and the Project screen
  draw through it. Looked at in headless Chrome against the live daemon: the cards that had been
  opened read DONE, the two empty projects read NO AGENTS, and the two with an unseen finished job
  kept the green FINISHED.
- **Not done.** The Fleet sort, **needs you first**, still ranks a seen `done` project the same as
  an unseen one; putting just-finished projects above the rest is a separate choice.

### Amendment 129 — post-merge, applied. **An agent's budget, and a job's, count what was spent today and go back to zero at midnight.**

Shared (`budget.ts`, `events.ts`, `wire.ts`), daemon (migration `210_spend_daily.sql`, `session/store.ts`,
`session/budget.ts`, `session/supervisor.ts`, `session/alerts.ts`, `session/backends/claude.ts`,
`session/backends/copilot.ts`, `daily.ts`, `session/verify.ts`) and web (`shell/autonomy.ts`,
`shell/describe.ts`, `lib/store.ts`, `agent/*`, `attention/*`, `fleet/*`, `spawn/*`, `settings/route.tsx`).
A TODO.md item (10 Oct, under "Look at what was built in Amendments 99-128"), and the user's decision of 12 Oct:
"the caps should be per day". **This replaces the lifetime rule of Amendment 77 and the lifetime figures of
Amendment 124**; the rest of 124 (a budget warns at 1x, a ceiling at 2x stops, the colours of 125) stands, now
read against today's spend. The daily budget of Amendment 59 (the whole machine's day total, a separate warn-only
figure in Settings and the status bar) is unchanged.

- **What an agent spent today is its own record.** Migration 210 adds `agent_spend_daily(agent_id, day, cost_usd,
  tokens)`, keyed by the daemon's local day (`localDay()`, the day `cost_daily` and the status bar use, and which
  `setDayClock` moves in tests), with `ON DELETE CASCADE` to `agents`. It grows by DELTAS as usage arrives, the way
  `addCostToday` does for the machine's day: Claude by the growth of the lifetime dollar cost at each result
  (`outcome.costUsd - previous`, never negative, from `lifetimeCost`, so a resumed run adds only the difference and
  a session that saved no total adds what it reports); Copilot and OpenRouter by the input plus output tokens each
  model call adds (`#count`). Nothing is derived from the agent row: `agents.cost_usd` stays the LIFETIME figure,
  Claude's `input_tokens` and `output_tokens` still hold only the last run's main loop, and Metrics
  (`session/metrics.ts`) is untouched.
- **It is on the wire, with its day.** `Agent.spentToday?: { day, usd, tokens }` (`DaySpend`, `events.ts`), added
  at the end of the interface. Every agent the daemon reads carries it, stamped with the day it was read for
  (`listAgents`, `getAgent`, `agentsForJob`, `helpersOf` and `unreportedHelpers` join the table). The `usage` event
  carries the same figure as `today?: DaySpend`, so an open page folds it without waiting for the agent to be
  pushed; one without it (a recording, an event from before) adds the growth of the lifetime figures to what the
  tab had (`spentAfterUsage`, shared).
- **One rule, in `@conductor/shared`.** `agentBudget(agent, today = localDayOf())` and `budgetState(agent, today)`
  read `spentToday` when its day is the day asked about and read 0 when the stamp is older or absent. The daemon's
  `session/budget.ts` wraps them with its own `localDay()`; the web's `budgetOf(agent, today?)` calls the shared one
  with the browser's. So **a page left open past midnight draws its bars at zero at its next render**, before the
  daemon says anything. `tokensSpent` (the lifetime tokens) is gone; `spentOn(agent, today)` replaces it.
- **Every cap reads today's spend.** `budgetRefusal` (every launch, resume, message and re-run), `budgetNote` and the
  pause note, `runLimit` (the SDK's `maxBudgetUsd` is the ceiling less what was spent TODAY when the query starts,
  read from the store when each query starts, so a run moved past a call it can't make gets a fresh figure), the
  Copilot/OpenRouter token stop, the `budget_over` alerts (agent and job), the job budget (`jobCostToday`, the sum
  of its agents' spend today, against `jobCap`, the sum of their budgets) and the web's `budgetOf`. Past the budget
  an agent still only warns; twice it stops, as before.
- **The lifetime number stays, as information.** The details panel's bar reads **today $4.10 of $25**, and the
  Agent section's *spend* row is now **lifetime $31.40** (title: "Everything this agent has spent, over its whole
  life. The budget counts only today."). The composer's spent figure reads **$4.10 spent today** with the lifetime
  figure in its tooltip; the Fleet lane's right-hand dollar figure is the lifetime one and says so in its title.
- **Wording says daily everywhere.** Spawn: **⏱ budget per agent per day $** (and in tokens) with a tooltip,
  `$25` default unchanged, the "resulting SDK options" line (`budget $25 a day`), Settings' default field. Composer:
  `over today's budget: $27 of $25 — a warning only; stops at $50`; folded line `$4.10 of $25 today`,
  `over today's budget: …, stops at $50`, `budget reached today: …`; the budget fields' labels say per day; the
  notice for a lowered budget compares with today's spend and with the ceiling (it used to compare lifetime spend
  with the budget, and said "will not run again" at the budget although only the ceiling stops). Agent screen:
  tags `budget reached today` and `over today's budget`, the tab's tooltip `of its daily budget`. Needs You: the
  cards are **Over its daily budget** and **Budget reached for today**; the notification texts say daily; failure
  sentences `stopped at twice its $25 daily budget`, `stopped on its daily budget, now raised to $35`. The daemon's
  notes: `budget reached for today — spent $50.20 of its $25 daily budget, which stops it at $50`; the refusal
  `The Builder has spent $50.20 of its $25 daily budget today, which stops it at $50 — raise it to continue, or it
  renews at midnight.`; the job's hold is `job budget reached for today`. All keep the prefix `budget reached` /
  `job budget reached`, which is what `budgetStop` reads, so older pauses are still recognised.
- **A `budget_over` warning's id now carries the day** (`budget_over:<agent>:<budget>:<unit>:<day>`, and the job's
  likewise): a warning put away today does not hide tomorrow's.
- **Midnight.** `daily.ts` gains `onDayTurn(fn)`, another listener on the watch of Amendment 103 (which still
  broadcasts the status bar's total and refreshes the alerts, unchanged); the supervisor registers
  `Supervisor.newDay(day, was)` in `initSupervisor`. On a turn it:
  - rewrites the pause of an agent paused at its ceiling (`budgetStop` = `budget_exhausted`), and of one held for
    its job's (`job_budget_reached`), when it is no longer at the ceiling today, to say its budget is **renewed
    for the new day** and that continue needs no raise (`renewals`, a pure function in `session/budget.ts`, with
    `renewedNote` and `isRenewedNote`). **Nothing is resumed by itself**: that would spend with no one watching.
    `budgetRefusal` reads today, so a plain **continue**, **resume** or message goes through and the agent runs
    against the new day's ceiling. The pause is rewritten with the usual `#pause`, so it is a new status event, a
    new Needs You card id, and a dismissal of yesterday's does not hide it; the alert carries `renewed: true`
    (`Alert.renewed?`), and the card says "Nothing resumes by itself".
  - leaves alone any pause that is not a budget pause, one that already says renewed (so a second turn rewrites
    nothing), and one still at the ceiling on the new day (a clock moved back to a day it had spent on);
  - pushes the agents that spent on the day before, so open pages redraw at zero;
  - calls `budgetChanged()` (the over-budget warnings of yesterday clear) and `pump()`.
- **Existing data.** An agent that existed before migration 210 has no rows, so it has spent nothing today and a
  budget it had reached is renewed the first time it starts. Its lifetime figure is kept as it was.
- **A run in flight across midnight.** Its delta is credited to the day its result arrives (the usage that comes in
  after midnight is the new day's); the `maxBudgetUsd` it was launched with stays what it was. Claude's spend is known
  only when a turn ends, so a run that crosses midnight is counted whole on the new day.
- **Removing an agent removes its days** (the cascade). The machine's `cost_daily` keeps the money, as before.
- **Checked** (`session/verify.ts` §26, `lib/verify.ts`, `agent/verify.ts`, `attention/verify.ts`): spend accrues per
  day, by the growth of the lifetime figure; a resume adds only the difference, and a session with no saved total
  adds what it reports; the cap reads today and not the lifetime (an agent with $80 in its life and nothing today
  runs, with the whole $50 ceiling); a day change takes an over-budget agent under its budget and clears the warning;
  an agent paused at the ceiling and an agent held for the job's stay paused with the renewed wording and continue
  with no raise; a person's pause is not touched; a second turn rewrites nothing; the job's figure resets; a run
  that crosses midnight is credited to the new day with its launch limit; a token budget (a real Copilot backend
  on the fake client) renews, is not stopped by its lifetime tokens, stops at twice the day's and continues the
  next day; removing an agent removes its rows; the pure rewrite; the web's `budgetOf` reads 0 for a stale stamp;
  the store folds a usage event with and without the daemon's figure and does not carry yesterday's into today.
- **Existing asserts changed, deliberately.** Fixture agents made with `costUsd` / tokens in `session/verify.ts`
  are agents whose whole life was today: `fixture()` also records the same figures in `agent_spend_daily`. The
  fake token engine and `usage()` in §24 add each call's tokens to the day as the real backend does. Plain-object
  agents given to `budgetRefusal`/`budgetState` carry `spentToday`. The expected sentences and notes changed to the
  daily wording above, in `session/verify.ts`, `lib/verify.ts`, `agent/verify.ts`, `attention/verify.ts` and
  `spawn/verify.ts`; the folded-line, `overSays`, `describeAutonomy` (`budget $25 a day`) and the Spawn-pill
  source checks changed with their text.
- **Not done.**
  - **Nothing resumes by itself at midnight**, by design (above); a person presses continue.
  - **A daemon that restarts after midnight does not rewrite the pauses** (there was no turn to see). The card still
    offers a plain continue, because the web reads the state, but it does not carry the "renewed" wording until the
    next turn.
  - **`agent_spend_daily` is never pruned**: one small row per agent per day it spent.
  - **A Claude run's spend is counted when its turn ends**, as before, so mid-turn the bar does not move; the SDK
    ceiling still stops it.
  - **The job's budget is in dollars only**, and its spend today is the sum of its agents' dollars (Claude); a
    token-capped agent still uncaps the job's dollar cap (Amendment 77).
  - **The time zone is the daemon's local one** (Amendment 103); an open page in another zone reads the stamp against
    its own day, so it can show a renewal a few hours before or after the daemon's.
  - **Nobody has looked at it in a browser, in both themes**, and nothing ran on a real model.

### Amendment 128 — post-merge, applied. **Orchestrated stacks: one agent runs the others, with the roles it may start listed before launch.**

Shared (`wire.ts`, `stack.ts`), daemon (`routes/helpers.ts`, `routes/session.ts`, `session/handoff.ts`,
`session/store.ts`, `session/supervisor.ts`, `session/backend.ts`, `session/backends/copilot.ts`, migration
`200_orchestrated.sql`, `session/verify.ts`), web (`spawn/orchestrated.ts` and `Pipeline.tsx` new,
`spawn/presets.ts`, `engine.ts`, `route.tsx`, `spawn.css`, `shell/ui.tsx` and `ui.css`, `fleet/lane.tsx`,
`fleet/card.tsx`, `fleet/fleet.css`, `agent/tabs.ts`, `agent/agent.tsx`, `agent/agent.css`, and the verify
files), and `docs/MANUAL.md`. The TODO.md item "Orchestrated stacks: one agent runs the others" (asked
8 Oct; decided 10 Oct, the recommended answers). It is built on the orchestrator and helpers of
Amendment 51 and keeps them as they were: this is a new kind of stack beside the fixed ones, picked in
Spawn, and the fixed stacks with `hand_off` (Amendment 104) are untouched.

**Decided (10 Oct, from the item's open questions):**
- **The roles are listed before launch.** Spawn shows which roles the orchestrator may start (developer,
  validator, reviewer and scribe by default) and the model tier of each, editable like the other plan rows:
  remove a role, change its tier, add another. The orchestrator can start those roles and no others.
- **It may send work back twice per role** (start the role again, as the developer after a failed review).
  A role is started at most three times in all; the next start is refused with a sentence telling the
  orchestrator to ask the user with the question tool.
- **Its helpers do not get `hand_off`.** The orchestrator's own judgement of each result replaces it.
- **The orchestrator looks different** wherever agents are shown, in neutral ink and never a status colour,
  and only in a stack of two or more agents.

**Wire** (`packages/shared/src/wire.ts`, each at the end of its interface):
- **`AgentSpec.helperRoles?: HelperRole[]`**, new type `HelperRole`: `id` (the persona's id, which is the
  name `start_helper` is given as `role`), `tier?`, `model` (the exact id the tier meant at launch),
  `brief?`, `systemPrompt?`, `skills?`, `autonomy` (pinned the way Spawn pins that role), and `tiers?`
  (what every tier meant at launch, so a cheaper one can be asked for). Spawn resolves all of it, so the
  daemon needs no copy of the personas, which live in the browser's setting.
- **`Agent.pipelineRoles?: string[]`**: the ids, present only on the orchestrator of an orchestrated stack.
  It is what marks the agent as one on Fleet, Project and the Agent tabs. The roles' prompts stay off the
  wire, as a persona's do.

**Daemon:**
- **Role-aware helpers.** `start_helper` takes a `role` and optionally a `tier`
  (`Supervisor.startHelper(orch, task, name?, role?, tier?)`). A helper started as a role runs with that
  persona's system prompt and skills (stored on its row, so a resume keeps them), the role's model and
  rope, a brief made of the persona's brief, then the orchestrator's `task`, then what to reply with
  (`pipelineHelperBrief`), and is named for the role (`developer`, then `developer-2` when it is sent back).
  Refused with a sentence: a role not listed (naming the ones that are and saying to ask the user), no role
  on an orchestrator that lists some, a role or a tier on one that lists none, a role or tier that is not
  text, a tier dearer than the one listed (the tier in Spawn is what the user chose to spend on that role;
  an orchestrator may ask for a cheaper one), a tier on an engine without tiers, and a fourth start of one
  role. Without a role it is as it was: the orchestrator's model and permissions, `helperBrief`, its
  persona. An ordinary orchestrator's tool schema and prompt are byte for byte what they were.
- **A reading role stays read-only.** `readOnlyRefusal(role, autonomy)` (shared) is checked when the stack
  is launched (400, naming the role and what is missing) and again when each helper is started, so a row
  whose stored rope would let a reviewer write starts nothing. The roles' autonomy comes from the same
  `toAgentSpecs` that pins a reader in any stack.
- **Counted from the database.** Migration `200_orchestrated.sql` adds `agents.helper_roles` (the roles, as
  JSON, on the orchestrator) and `agents.helper_role` (on a helper, the role it was started as). The
  send-back limit counts `helper_role`, so it holds across a restart. Both are off the wire apart from the
  ids in `pipelineRoles`.
- **A pipeline prompt.** `pipelineSection` (`handoff.ts`), in place of `orchestratorSection` for an
  orchestrator that lists roles: run the steps in order, one at a time; a helper is told the job
  instruction and the `task` and sees the folder, not the conversation, so write the brief in full; read
  each result before the next; send work back when a step fails, at most twice per role; ask the user with
  the question tool when unsure; its helpers have no `hand_off`; the roles it may start with their tiers and
  which only read. `helperReport` takes a closing line, and an orchestrated stack's orchestrator is woken
  with `pipelineReportClosing` (read it, write the next brief or send the work back, ask) instead of "check
  their work, combine it". The helper's whole conversation is passed as before (Amendment 120). The old
  parallel-work prompt stays for ordinary orchestrators.
- **A helper never hands off and is never held.** `Supervisor.#waiters` returns nothing for an agent with a
  `parentId`, whoever is wired to wait for it, so `toolAccess`, `hand_off` and the hold in `#settle` all
  agree. Before, only the orchestrator was left out of a helper's waiters.
- **Launch checks** (`routes/session.ts`, `parseHelperRoles`): ids as `^[a-z][a-z0-9-]{0,30}$` and unique,
  at most `PIPELINE_ROLES_MAX` (8) roles, a model that is not a nickname, a tier of opus, sonnet or haiku,
  a brief, system prompt and skills under the persona limits, an autonomy in the engine's unit, and the
  read-only check. `helpers` is then 1 to `pipelineHelperCap(roles)` (each role once and sent back twice:
  4 roles, 12 helpers) instead of 0 to `HELPERS_MAX` (8), which an ordinary orchestrator still is. On
  Copilot and OpenRouter each role's model is checked against the engine's list like the spec's.
- **The tools.** `toolsFor(access)` gives an orchestrator with roles a `start_helper` whose schema names the
  roles (`role`, an enum, required), the tiers and a task described as the full brief. Claude's endpoint
  answers `tools/list` with it per agent; Copilot and OpenRouter build the same definition in-process from
  `RunnerScope.roles`.

**Web:**
- **The preset "orchestrated pipeline"** (`spawn/presets.ts`): one row, `orchestrator`, the architect
  persona on opus, flagged `orchestrates`. `toAgentSpecs` takes the listed roles as a tenth argument and
  gives that row `helpers` (`helperCapFor`) and `helperRoles` (`helperRolesFor`, built by `toAgentSpecs`
  itself so a role is launched exactly as in a fixed stack). The "+ up to N helpers" picker is not offered
  on it.
- **The list** (`spawn/orchestrated.ts`, pure; `Pipeline.tsx`): `defaultListed`, `withTier`, `withoutRole`,
  `withRole`, `offeredRoles`, `unresolvedListed`. It is state of this launch only; choosing a preset puts
  the default back. A listed tier the model API serves no model for blocks the launch and names the role.
  Off Claude every role runs on the launch's one model and the tier picker is a plain label; an engine that
  cannot start helpers lists none.
- **One agent needs no orchestrator.** `showsOrchestrator(agents)` (shared) is true for two or more.
  `orchestratedFor(preset, listed)` turns an orchestrated preset with no role listed into the full
  pipeline's architect row, with no helpers, no list sent and nothing that says it orchestrates; the plan
  keeps the "+ add a role…" control and says "No role listed, so this launches one architect agent".
- **The look** (`OrchestratorMark` in `shell/ui.tsx`, `.is-orch` rules): a "◆ orchestrator" mark in the plan
  and the diamond alone on a Project lane, a Fleet card row and an Agent tab, with a heavier edge in `--ink2`
  (left on the plan row and the Fleet row, top on the lane and the tab). `marksOrchestrator(agent, jobAgents)`
  is the one rule all four ask: it has `pipelineRoles`, is not a helper, and its stack is two or more agents.
  No status colour (`--live`, `--done`, `--need`, `--fail`, `--you`, `--queue`, `--idle`) is used, and
  `lib/verify.ts` checks that from the CSS and measures the contrast in both themes (12.2:1 and 13.3:1 for
  the mark's text, 8.1:1 or more for the edge).

**Not done / not decided:**
- **An ordinary orchestrator (anonymous helpers) is not marked.** Only an orchestrator with listed roles
  is, so "+ up to N helpers" on a fixed stack's row looks as it did.
- **The tier ceiling.** The item said "a model tier" for `start_helper` without saying whether it could
  override the user's. It can only ask for the listed tier or a cheaper one.
- **The lone architect.** With every role removed the launch is the full pipeline's architect, not a
  developer. The item says "launches that one agent plainly" and the row's persona is the architect.
- **Not saved in a Custom setup.** The roles are not part of a saved setup, and Custom has no orchestrated
  row (as helper counts are not saved either, Amendment 51).
- **No role-level budget or per-role brief edit in Spawn.** A role's brief is its persona's; edit it in
  Settings → Personas.
- **Not tried against a real model.** Everything above is checked with the fake SDK. Whether an orchestrator
  on opus writes good briefs, judges a review well, and stops at the second send-back needs a real run and
  spend, and a person watching.
- **Not looked at on a real project in a browser**, apart from headless Chrome on macOS in both themes
  against a replayed fixture: the Spawn plan with the roles, with one agent, and the Project screen.

**Verified:**
- `session/verify.ts` §25 (inside the lock): the pure rules; the migration's columns; the launch's 400s
  (a reader with a rope that lets it write, a missing write tool, a bad tier, id, model or list, no
  helpers, too many); the orchestrator's row, its role ids on the wire and its prompts kept off it; the
  pipeline prompt (roles, tiers, reads only, ask, send back, no `hand_off`) and not the parallel one;
  `tools/list` naming the roles; a helper started as a role (its model, rope, persona, brief, run options);
  a cheaper tier honoured and a dearer one refused; an unlisted role, no role, a non-text role refused; the
  send-back count (named apart, counted from the database, the fourth refused with the question-tool
  sentence); a helper with no `hand_off`, no tools, and no hold even with an agent waiting for it; the
  orchestrator woken with each helper's whole conversation and the pipeline closing; an ordinary
  orchestrator unchanged (prompt, schema, model, brief); a stored loose reader refused at start; a stack
  on Copilot with the roles reaching its backend's scope. 1,253 checks.
- Six mutations were caught: the helper guard in `#waiters` removed; the read-only check at start removed;
  the pipeline closing not used; a tier with no role allowed; the send-back limit off by one; a dearer
  tier allowed.
- `spawn/verify.ts` §21: the preset, the default list and its tiers, the specs and request body, the
  roles editable (remove, tier, add, no duplicates, at most eight), a single agent shows no orchestrator,
  another engine, and the CSS. `agent/verify.ts`: the tab mark, only with two or more agents, never a
  helper. `lib/verify.ts`: neutral ink, contrast in both themes, and the lane, row and tab asking the one
  rule. Five existing source checks in `spawn/verify.ts` (the `toAgentSpecs` call, the personas hand-on,
  the helpers picker) were widened to allow the new argument and condition.
- `pnpm -r typecheck`, `pnpm --filter @conductor/web verify` and every web verify file in the Makefile:
  pass. `session/verify.ts`, `verify-schedule.ts` and `verify-folder.ts`: pass, inside the lock.

### Amendment 127 — post-merge, applied. **The Project and Agent screens each have their own backdrop for the label at the top.**

Shared (`tokens.css`) and web (`shell/ui.css`, `fleet/project.tsx`, `agent/agent.tsx`,
`agent/agent.css` (a comment), `lib/verify.ts`, `lib/verify-crumb.ts`), and `docs/MANUAL.md`.
No behaviour, wire or daemon change, no migration. A TODO.md item (7 Oct, "Project and Agent,
beyond the label"; its one remaining bullet): "one backdrop colour per screen, so you can tell
Project from Agent at a glance." It finishes Amendments 97 and 107, which put the label on one
backdrop, `--here`, on every screen.
- **Two new tokens, both themes**, next to `--here`: `--here-project` (`#002a35` dark, `#c4ecf9`
  light; a petrol blue) and `--here-agent` (`#4d283e` dark, `#f5cfe3` light; a wine rose).
  Neither hue is a status colour (§5.1), nor `--you`'s violet: the status hues are red (`--fail`),
  amber (`--need`), green (`--done`), teal (`--live`), `--queue`'s blue-grey and `--idle`'s grey, and
  the two sit at about 220° and 345° on the colour wheel (OKLCH), clear of all of them. They
  are not equal to any of them either, and a check says so.
- **`--here` stays** for Fleet, Needs You, Preview, Files and Branches, unchanged (`#1f3047` /
  `#d6e0f0`). Only the Project and Agent labels moved.
- **One class still draws the label.** `.ui-crumb` (`shell/ui.css`) now reads its backdrop from
  `--crumb`, which is `--here` by default, and mixes its border from `--crumb` the way Amendment
  97 did (60% of the backdrop, 40% `--ink3`). `.ui-crumb.is-project` and `.ui-crumb.is-agent`
  each set `--crumb` and nothing else, so the Agent button's hover border (`.ag-crumb:hover`,
  `agent.css`) still wins as before. `project.tsx` is `ui-crumb is-project` and `agent.tsx` is
  `ui-crumb ag-crumb is-agent`. The text cue (`project / role`, `project / ⑂ branch`) is unchanged.
- **Apart without colour vision.** The hues differ, and so does the lightness, as far as the
  contrast floor lets it (below). Luminance ratio between each pair, dark then light: `--here`
  and `--here-project` 1.14 / 1.06; `--here` and `--here-agent` 1.07 / 1.06; `--here-project`
  and `--here-agent` 1.22 / 1.12. In both themes the Agent backdrop sits on the prominent side
  of `--here` (lighter in dark, darker in light) and the Project backdrop on the quiet side.
- **Checked**: `lib/verify.ts` fails unless `--ink`, `--ink2` and `--ink3` are at least 4.5:1 on
  each of the three backdrops in both themes (Amendment 97's check, now over `--here-project`
  and `--here-agent` too), that the three backdrops are three different colours, that none is
  a status colour or `--you`, and that any two differ in lightness by at least 1.04:1. The
  inks on `--here-project` are 12.3, 7.5 and 5.6 in dark and 13.9, 7.7 and 5.1 in light; on
  `--here-agent` they are 10.1, 6.1 and 4.6 in dark and 12.4, 6.9 and 4.6 in light. A token
  missing from the light theme fails the existing "none leaks through" check.
  `lib/verify-crumb.ts` section A now reads `--crumb`, E reads `is-agent`, and a new section F
  checks the border mix, the two modifier rules, that the hover rule is not outranked, that
  Project and Agent carry their class, and that no other screen does.
- **Why the lightness spread is small.** The label's `/` and `project` text use `--ink3`,
  which must stay 4.5:1 on the backdrop. In the dark theme that caps a backdrop at about 3.6% of
  white's luminance, and `--here` is already at 2.9%; in the light theme the floor is about 68%
  and `--here` is at 74%. So the three can only be a few percent apart in lightness, and the
  hue carries most of the difference.
- **Not done**: the screens were not looked at in a browser, in either theme (nobody could from
  here). The colours were only rendered as flat swatches, to see the hues. Needs You's third header
  (`project / role` for the request in focus) stays on `--here`, so it no longer matches the
  Agent screen it came from, as Amendment 107 said it would; if it should, it is one class
  (`is-agent`) on `attention/route.tsx`, with one line in `verify-crumb.ts` F. Other screens
  that name a project (Preview, Files, Branches) stay on `--here`.

### Amendment 126 — post-merge, applied. **The built-in roles are told how to work, and how to close.**

Web only (`spawn/personas.ts`, the three briefs in `spawn/presets.ts`, `spawn/verify.ts`), and
`docs/MANUAL.md` and `docs/plans/role-definitions.md`. The daemon and `packages/shared` are not
touched, and there is no migration. A TODO.md item (asked 8 Oct, decided 10 Oct: all seven at
once): "Better instructions for the built-in roles". It builds option B of
[docs/plans/role-definitions.md](docs/plans/role-definitions.md), which is refreshed (it numbered
itself Amendment 96, its line numbers predated the merge) and marked built.
- **What changed.** The developer, validator, reviewer, scribe, debugger and analyst each have a new
  `description`, `brief` and `systemPrompt`; before, only the architect had a system prompt and the
  other six had a one-sentence brief. The architect keeps its prompt and gains one rule. Each system
  prompt is a line of purpose, five or six rules about *how* to work, and a closing line "End with:"
  and the headings of its reply. A prompt is 830 to 1,340 characters, about 300 tokens.
- **Why the system prompt.** A preset keeps its own brief and takes only the persona's system
  prompt and skills (and, apart from `write: false`, no tool rule — Amendment 147), so the
  system prompt is the one field that reaches every stack
  (Claude appends it to Claude Code's, `backends/claude.ts`; Copilot and OpenRouter send it as an
  appended system message, `backends/copilot.ts`).
- **The closing headings are the hand-off.** Since Amendment 104 an agent that others wait for calls
  `hand_off` with a `summary`, and since Amendment 101 the next agent is given that summary first,
  whole and outside the cap, above the whole conversation. So every closing line ends "If you have
  the `hand_off` tool, that is its `summary`; otherwise it is your last reply" (one helper,
  `endWith`). The agent that nobody waits for has no tool, and the headings are its last reply.
  The headings: architect Context, Options, Decision, Consequences, Plan, Risks and open
  questions; developer Changed, How I checked, Departures from the plan, Left undone; validator
  Verdict, Checks, Failures, Not covered; reviewer Verdict, Findings (ranked), What I checked; scribe
  Updated, Corrected, Not documented and why; debugger Symptom, Reproduction, Root cause, Evidence,
  Fix belongs at, Regression test, Confidence; analyst Overview, Map, Flows, Decisions encoded, Open
  questions, Not read.
- **`HANDOFF_CAP` is gone** (Amendment 101 replaced it with about a quarter of the next model's
  window). A `summary` is printed whole, up to `HANDOFF_SUMMARY_MAX` (20,000 characters), outside
  that cap, and the last reply is never cut or dropped, so a reviewer's ranked findings are not cut.
- **The architect.** Its added rule is about its hand-off, not "your last reply" as the proposal
  said: "The developer starts from your hand-off, so make the plan stand alone: name every file, and
  don't refer to 'above'." Its last line, "Write the result as: …", is now "End with: …" with the
  same six headings (bold now), so that all seven end the same way. This is the one edit to the
  architect beyond the one rule.
- **Commits.** Checked, not assumed: nothing in Conductor commits for an agent or asks one to. A
  job's worktree is cut with `git worktree add -B <branch>`; the Changes list and the Files badges
  are what differs from `HEAD` (`workspace/changes.ts`, `git status` and `numstat`), so a commit by
  an agent would empty them; the Branches screen (Amendment 109) merges commits only ("Uncommitted
  work in the branch's worktree isn't merged"), and its **Commit…** commits a branch's uncommitted
  work with the user's message. So the developer's rule stays: "Don't commit, push or rewrite git
  history unless the job says to", and now says why (the changes stay in the working tree, for the
  user to review and commit and for the agents after it to read).
- **The reviewer reads the working tree.** Because the developer leaves its work uncommitted, the
  proposal's "read the diff against the base branch" would miss it (and a new file is not in
  `git diff`). The reviewer is told to read `git status` and `git diff`, and any commits on the
  branch since it forked.
- **The question tool.** The developer's rule names it for both engines, "AskUserQuestion, or
  ask_user", as Amendment 100's line does. The architect's existing line still says AskUserQuestion.
- **Three preset briefs are aligned**: the full stack's validator ("Change tests, not the code under
  test."), its reviewer ("Report findings with file and line, most severe first. Change no files."
  for "Report findings; do not rewrite."), and the bug fix's developer ("Fix the root cause the
  debugger identified. Add the regression test it describes, and check that it fails before your
  fix and passes after."). Every other preset brief is as it was. Tools and model tiers are
  unchanged for all seven, and `push` is left to the launch: only the architect says anything
  about it (`push: false`, as before).
- **Decided, where the item did not settle it**: the validator reports and does not fix the code;
  nothing gates on the reviewer's verdict (the scribe waits for the reviewer finishing, not for it
  approving); the model tiers stay; all seven at once, not four first; the `hand_off` and
  whole-context items were already built (Amendments 101 and 104), so the closing headings are the
  summary.
- **No migration.** Only edits that differ from a built-in are stored (`withPersona`), so someone
  who never edited a built-in gets the new text at once, and someone who did keeps their edit.
  **Reset** gives them the new text. Checked in `spawn/verify.ts` §19: a validator whose brief was
  edited keeps the brief and gets the new system prompt; a replaced system prompt is kept, and
  Reset gives the new one.
- **Checked** (`spawn/verify.ts` §19): every built-in has a non-empty `systemPrompt` whose last
  line starts "End with: " and ends with the `hand_off`/last reply sentence; each role's headings
  are in its closing line, in bold and in order; a prompt is under 3,000 characters; the architect
  keeps its rules and has the new one, and the stale "last reply is handed to" is gone; every
  description is one short line; the limits that are words are in the words (developer: no commit,
  push or rewrite; validator: tests and fixtures only; reviewer, debugger, analyst: change no files;
  scribe: documentation only); tiers and tool rules are as they were and no built-in but the
  architect sets `push`; the three aligned preset briefs, and the others as they were; every
  preset, and a Custom row, sends the persona's system prompt; a reading role is still pinned
  read-only; the edit and Reset cases above. Two older checks quoted what changed and were updated:
  §16's validator description, and §13's "a persona with nothing to append sends no system prompt"
  (which used the validator as its example of a persona without one; it now edits the validator's
  prompt down to nothing first).
- **Docs.** `docs/MANUAL.md` has a table of what each built-in is told and what it ends with, after
  the Personas paragraph. `docs/plans/role-definitions.md` is the text as built, with a "Changes
  from the first draft" section.
- **Not done**: the comparison the TODO item asked for before keeping the text, running the bug fix
  and full stacks on one known bug with the old prompts and the new and comparing the hand-offs. It
  needs real agent runs and spend, so there is still no evidence that the new text does better.
  Nothing enforces "tests only" or "docs only" (option C of the proposal): they are words, and the
  diff is where to check. Whether an agent really puts the headings in its `hand_off` summary is up
  to the model; nothing checks it. The paragraph of `docs/MANUAL.md` that says "only the final reply
  is passed on … a reply over 8,000 characters is cut" (under "You'll see the agent plan before
  launching") was already stale after Amendment 101 and is not changed here. Not run by this lane:
  `make test`, the daemon smoke test, the daemon's `session/verify.ts` (nothing daemon-side changed).

### Amendment 125 — post-merge, applied. **An agent's budget is coloured as it fills, like the daily budget.**

Web only (`shell/spend.ts`, `shell/autonomy.ts`, the details panel, the composer, the Agent
screen's tabs, the Project lane and the Fleet card). A TODO.md item (10 Oct): "use the same
thresholds and tokens as the status bar's daily meter for each agent's spend against its budget".
- **One helper, `toneOf(fraction)` in `shell/spend.ts`**, is the status bar's own rule pulled out:
  green (`ok`), yellow from 75% (`warn`), red from 95% (`over`). `dailyMeter` now calls it, and
  `budgetOf(agent).tone` (the agent's budget, Amendment 124) calls it, so the two cannot drift. The
  tokens are the daily meter's too: `--done`, `--need` and `--fail`, no colour of any theme's own,
  and the contrast checks in `lib/verify.ts` already clear all three at 4.5:1 on every surface in
  both themes.
- **From 100% it reads red and says over.** The tone is `over` (red) from 95%, and `Budget.over` /
  `state` mark 100%: the bar stays full, the percentage goes past 100, and each place says it in
  words (below). A budget in tokens (Copilot, OpenRouter) colours the same way, in tokens.
- **Where it is drawn:**
  - **The details panel's bar** (`inspector.tsx`, `.ag-bar`) fills green, yellow, red; its
    percentage goes red when over.
  - **The composer's budget line** (`composer.tsx`): the box's border and the spent figure take
    the tone (green is the default, so they only change when they should), with a small meter
    beside the figure (`BudgetMeter`, `.ag-meter`); the "over budget: ... a warning only; stops
    at ..." line under it takes it too. **The folded summary** carries the same small meter and its
    text goes yellow, then red. An unsafe interaction mode is still the alarm (`is-alarm`); the
    budget is no longer part of it, since it now has its own colours.
  - **The agent's tab** (`agent/tabs.ts`: `AgentTab.budget`; `agent.tsx`): a thin bar along the foot
    of the tab, and the percentage in its hover text.
  - **Its Fleet card, in both places an agent is on one:** the Project screen's lane (`fleet/lane.tsx`)
    has its meter in the tone and the figure in the tone, and says `· over`; the Fleet screen's card
    (`fleet/card.tsx` `AgentRow`) has a small meter on each agent's row.

**Verified:** `lib/verify.ts` ends with a section for it: green, yellow and red at 74.99/75/94.99/95
percent and over the budget; `toneOf` equals the daily meter's tone for every step from 0 to 240%;
the thresholds are the status bar's `WARN_AT` and `OVER_AT`; a token budget colours the same;
no budget has no colour; the status bar's bar fills with `--done`, `--need`, `--fail` and each of the
four new fills (composer meter, tab bar, lane meter, Fleet row meter) uses the same three, and so does
the details panel's bar; none of those CSS rules has a hex, `rgb()` or `hsl()`; each component carries
the tone as `data-tone`. `agent/verify.ts` checks the tab's bar for each tone and for a token budget.
The existing check on the composer's folded-line markup, the exact shape of `budgetOf`, and the old
"budget is the alarm" check were updated to the new markup. `pnpm -r typecheck`, the web verify files,
and a `vite build` into a scratch folder pass.

**Not done:**
- **Nobody has looked at it in a browser, in either theme.** The colours are the daily meter's tokens,
  so the contrast checks cover them, but how the tab's 2px bar, the 30px bar on a Fleet row and the
  composer's meter sit against their neighbours is for a person to see.
- **The navigator's agent rows have no meter.** The TODO named the details panel, the composer, the
  tab and the Fleet card; the navigator draws rows from the same `agentTabs` result, which now carries
  `budget`, so it is one line to add.
- **The job's budget, and the daily one, are unchanged**: the daily meter is as it was, and a job has
  no meter of its own (its warning is the Over budget card of Amendment 124).

### Amendment 124 — post-merge, applied. **An agent's budget warns instead of stopping it, and a ceiling at twice the budget stops it.**

Daemon, shared and web (`shared/src/budget.ts` new, `session/budget.ts`, `session/alerts.ts`,
`session/backends/claude.ts`, `session/supervisor.ts`, `attention/*`, the composer). A TODO.md
item (10 Oct): "the agent keeps working past its budget, and once it goes over, Needs You raises a
warning that asks to raise the budget (with +$10 / +$25)". Its open questions are taken as the TODO
itself suggested, since the user said to execute all of it:
- **There is a hard ceiling, at 2× the budget**, so a runaway agent can't spend without limit.
- **The job's budget changes the same way**: it warns at the sum of its agents' budgets and holds
  agents still to start at twice the sum.
- **While over, the composer says** `over budget: $27 of $25 - a warning only; stops at $50`
  (tokens, for an engine that reports no dollars).

What changed:
- **The thresholds are one pure copy, in `@conductor/shared` (`budget.ts`).** `BUDGET_CEILING = 2`,
  `ceilingOf`, `capState(spent, budget)` and `budgetState(agent)` give `'ok'` under the budget,
  `'over'` from it (a warning) and `'ceiling'` from twice it (the stop), for dollars and for
  tokens alike (Amendment 77). `agentBudget(agent)` is the budget an agent has, in its unit.
  `session/budget.ts` re-exports them and applies them; the web reads the same functions
  (`shell/autonomy.ts` `budgetOf` now carries `ceiling`, `state`, `pct`), so the daemon and the
  screens cannot disagree about where the line is.
- **What stops an agent is the ceiling.** The SDK is given what is left of it
  (`runLimit`: `maxBudgetUsd` = twice the budget minus the lifetime spend, where it was the budget
  minus the spend). `budgetRefusal` (every launch, resume and message, and the Copilot/OpenRouter
  backend after each usage update) refuses at the ceiling, not the budget. Between the two a
  message is accepted and the agent works on. The stop is exactly as before: `budget_exhausted`,
  paused, not failed, the **Budget reached** card, the sentence on a 409. Only the figures moved,
  and the note and the sentence now say where it stops: `budget reached — spent $50.20 of its
  $25 budget, which stops it at $50`; `The Builder has spent 1.2M of its 500k-token budget, which
  stops it at 1M — raise it to continue.` The prefix `budget reached` is unchanged, so
  `budgetStop` and the alert still read it.
- **A new alert kind, `budget_over`** (additive, at the end of `AlertKind`; `Alert.unit?` at the end
  of `Alert`; `spent` and `budget` are reused from `daily_budget`). `Alerts.#budgetOver()` derives
  it from what is stored: an agent that is `working`, `queued`, `blocked` or `done` and between its
  budget and its ceiling. A `paused`, `stopped` or `failed` agent has none (nothing is spending, or
  it has its own card). Its id is `budget_over:<agent>:<budget>:<unit>`: one warning per budget, so
  a dismissal (stored, as for every alert) lasts until the budget is raised and passed again, and
  `since` holds still while the spend grows. It is re-checked on every `usage` event and when an
  agent's autonomy changes (`budgetChanged()`, called from `Supervisor.setAutonomy`), so raising the
  budget clears it with no status change to say so. For a job (`cause: 'job_budget_over'`, `jobId`,
  no `agentIds`): the sum of its agents' budgets (dollars, so only when every agent has one), for a
  job with more than one agent that still has something working, queued or blocked.
- **The job's hard stop moved to twice the sum.** `#overBudget` (the pump's check before a queued
  agent starts, and the re-run's) is `jobBudgetState(...) === 'ceiling'`. Agents that are already
  running were never stopped by the job's budget, only by their own, and still aren't.
- **Claude's spend is known at the end of a turn**, so a Claude agent's warning arrives with the
  `result` that crossed the budget (the agent is then `done`, and a message to it works on). The
  ceiling still stops it mid-turn, through the SDK. A token budget is counted on every model call,
  so its warning can come while the agent works.
- **Web.** The Over budget card (label `Over budget`, amber, no "needs you" notification wording)
  offers **+$10** and **+$25** (**+100k tokens** and **+500k tokens** for a token budget) that raise
  the budget and nothing else (`AlertAction` `raise` has `onlyRaise`); a job's raises the working
  agent that has spent the most (`jobRaiseTarget`). The **Budget reached** card raises when the agent
  is at its ceiling, and now does so in tokens too: before, a token-capped agent's card offered only
  a continue that the daemon refused. The Agent screen's header says **over budget** while it works
  and **budget reached** only at the ceiling; the composer's placeholder, its folded line and its
  open line (`over budget: ...`) say where it stops; the details panel's percentage reads past 100%
  and says so. An agent's tab counts the warning but does not turn blocked for it.

**Existing tests changed, deliberately** (each used the budget as the stop; they now use the
ceiling): `session/verify.ts` §11 (the SDK limit 30, then 26, not 5 and 1; the pause at $50.20 not
$25.20; the note, the 409 sentence and the raise to $60 not $35; `agt_spent` at $50; a running
total of $51, since a smaller one would read as a restart from zero; §12's `26.5` is `51.5` for the
same reason); §17d's restart fixture at $50; §17m (token figures: refused at 1M, the fake engine
ends at 1.25M, the notes and sentences in tokens); §19's re-run fixture at $50 and its sentence.
`attention/verify.ts` (the stopped card raises at a cost of $10 on a $5 budget, `$0.02` on `$0.01`;
the notification text), `agent/verify.ts` (`over` is from the budget, `state` is the stop; the
exact shape of `budgetOf`), `lib/verify.ts` (`stopped at twice its $5 budget`).

**Verified:** `session/verify.ts` ends with a section for this amendment: the thresholds at their
edges in both units; over at 1× keeps working and raises the warning once (the SDK given the
remainder under the ceiling, a message accepted, one alert with a stable id and time, every tab
told, the snapshot); the raise clears it with no status change; a new budget is a new alert and a
dismissal lasts; the ceiling pauses as before with the note and the 409; a paused, stopped or failed
agent has no warning; a token budget warned mid-run, then stopped at 1M, then raised; the job warned
at 52 of 50 while its queued agent still starts, and held at 100 of 50 until one budget is raised.
Mutations caught: the SDK given the budget (10 checks fail); refusing at the budget (20); no
`budget_over` alerts (7); the job held at its budget (7). `pnpm -r typecheck`, the web verify files
for what changed, and `verify-schedule.ts` and `verify-folder.ts` pass.

**Not done:**
- **Spawn still says "stop each agent after $"** (`spawn/route.tsx`, and `spawn/verify.ts` asserts the
  label). The figure it sets is the budget, which now only warns. The pill and the MANUAL's name for it
  were left, since Spawn is another lane's; rename it ("warn each agent after") with its test.
- **The ceiling is fixed at twice the budget.** Nothing sets another multiple, per agent or
  globally.
- **The warning for Claude is at the end of the turn that crossed the budget**, not during it: the
  SDK reports a turn's cost only in its `result`. A single turn can run from under the budget to the
  ceiling with no warning in between.
- **The status bar's daily meter, and Settings, are unchanged.**

### Amendment 123 — post-merge, applied. **When the model can't be reached, the agent waits 5 s, 15 s, 30 s, 60 s and 5 min and tries again, then fails as it did.**

Daemon (`session/retry.ts`, new; `session/supervisor.ts`, `session/alerts.ts`, `session/backend.ts`,
`session/backends/claude.ts`, `copilot.ts`, `copilot-events.ts`, `routes/session.ts`,
`session/verify.ts`), shared (`events.ts`, `wire.ts`) and web (`agent/Reconnect.tsx`,
`agent/reconnecting.ts`, `agent/agent.tsx`, `agent/agent.css`, `agent/endpoints.ts`,
`attention/AlertCard.tsx`, `attention/alerts.ts`, `shell/describe.ts`, three verify files).
`docs/MANUAL.md` §3 (Alerts) and §7. No migration. Asked for on 8 Oct; the decisions below were the
recommended answers given on 10 Oct, taken when the user said to execute the TODO.
- **Before:** the SDK retried a model call by itself and Conductor only reported it (Amendment 28).
  When the run then ended in error, `#settle` wrote `failed` at once, and a failed agent fails its job.
- **What retries** (`decideRetry`, pure, in `session/retry.ts`): a run that ended in error because of
  the model API where waiting can help, by `classifyRetry`: no response at all (`unreachable`),
  throttled or overloaded (`throttled`), a 5xx or 408 (`server`). **Not:** `auth` (a login, account or
  billing error, which needs a person and shows as before), a budget stop, your own stop or pause, an
  interrupted run (`aborted_streaming`, `aborted_tools`), a limit of the agent's own (`blocking_limit`,
  `max_turns`, `prompt_too_long` and the rest), an error the API answers the same every time (a 4xx
  that is not 408 or 429, `invalid_request`, `model_not_found`, `max_output_tokens`), and any failure
  with no API error behind it.
- **What the API said** is carried on the run's outcome as `RunOutcome.apiFailure` (`{ httpStatus,
  error }`, optional). Claude sets it from the SDK's `api_retry` message, from an assistant message that
  carries `error` (an API error written in the model's place; `unknown` is not taken), or from a failed
  result that names `api_error_status`, and clears it on any real reply. Copilot, and OpenRouter on the
  same class, set it from `session.error` (`errorType`, `statusCode`) through `apiFailureOf` in
  `copilot-events.ts`, or from a thrown error whose message says the connection failed (`ECONNRESET`,
  `fetch failed`, …). `classifyRetry` moved to `retry.ts` and is re-exported from `alerts.ts`.
- **The schedule:** `RETRY_DELAYS_MS = [5 s, 15 s, 30 s, 60 s, 5 min]`, five tries at most. The sixth
  failure in a row is `failed`, as before, with the failed (or gave-up) alert. A try is used when its
  wait starts. **A real reply from the model starts the count again** (`modelAnswered` also calls
  `retryBook().answered`); an API error written as a reply is not one. What a retry spends counts
  against the agent's budget like any run. Continuing a failed agent gets five tries again.
- **No new status.** A waiting agent is `queued`, as one is for a slot or after a restart
  (Amendment 53). `#settle` calls `#waitToRetry`, which writes `queued` and a status event carrying
  `retry: { cause, attempt, of, delayMs }` (new, optional, on `StatusPayload`) and the transcript line
  "the model is busy — trying again in 30 s (3 of 5)". `pump()` skips an agent that is in
  `retryBook()`; its timer (unref'd) calls `pump()`, which starts it like any queued agent, with its
  own session (`sdkSessionId`) and **`RETRY_NUDGE`**: the model couldn't be reached, a running tool call
  was stopped, background work is gone.
- **Slot and job.** Its slot is freed when its run ends (`#active` is cleared before `#settle`), and
  it takes one again when its time comes; with none free it waits for one like any queued agent. Its
  job stays `working`: `#rollUpJob` does not count a queued agent as settled, and `#settle` returns
  before it.
- **`RetryBook`** (`retry.ts`) holds the tries used and the waits, on an injected `Clock`, so
  `session/verify.ts` drives it with a fake one. `retryBook()` is the daemon's one instance;
  `resetRetryBook(clock)` replaces it for checks. In memory on purpose.
- **A restart** forgets the waits. `reconcile` sees a `queued` agent with a session whose last status
  event carries `retry` and resumes it as any agent a restart interrupted: `RESTART_NUDGE`, which wins
  over `RETRY_NUDGE`, and five tries again.
- **What ends a wait:** the timer; **retry now**; any pause (`#pause`), terminate, delete, re-run from
  here (`rerunFrom`), or a message from you (`#launchWithPrompt`), which is the try, with your words;
  and shutdown, which clears the timers.
- **Routes**, at the end of `routes/session.ts`: `POST /api/agents/:agentId/retry-now` →
  `{ ok: true }`, and `POST /api/agents/:agentId/stop-retrying` → `StopRetryingResponse { agent }`
  (new, last in `wire.ts`). Both 404 for no such agent and 409, with the sentence in `detail`, when the
  agent is not waiting; retry now is also refused while everything is paused until a time
  (Amendment 111). **stop retrying** writes `failed` with the reason and detail the failed run ended
  with, so it reads as it would have before retries.
- **What you see.** Agent screen: a banner above the transcript, "Reconnecting in 30 s (3 of 5)", the
  cause, **retry now** and **stop retrying** (`agent/Reconnect.tsx`; the line is worked out in
  `agent/reconnecting.ts` and `shell/describe.ts` from the last status event, and counts down each
  second). Fleet's agent rows and the Project lanes read "reconnecting in 30 s (3 of 5)" through
  `currentAction`. Needs You: a new alert kind **`reconnecting`** (`AlertKind`, new `Alert.retryAt`),
  held in memory like a connection alert, one per agent with one id for the whole bout so it updates
  rather than repeats, from the second retry (`RETRY_ALERT_FROM = 2`): the first waits 5 s and is a
  blip. Its buttons are **retry now**, **stop retrying** and **open agent**; it is not dismissable and
  clears when the try starts. Amber from the second retry, `queue` before. Tokens only, both themes.
- **Not changed:** the SDK's own retries and the `connection` alert, which still raise for a login
  or network that stays down and say "gave up" if the last of the five fails. An agent restarted after
  a retry is not asked to hand off by Amendment 119's rule (only a restart resume is).
- **Not done:** the waits are not saved, so a restart gives five tries again; the delays are not
  settings; an agent that retries and then ends its turn without `hand_off` is held as any other
  (Amendment 119's one-time request is for a restart resume only, though `RETRY_NUDGE` says the same
  about background work); nobody has watched the banner or the card in a browser, in either theme.
**Verified:** `session/verify.ts` §21, with a fake clock: each delay in turn (5 s, 15 s, 30 s, 60 s,
5 min), nothing starts a moment early, and each try resumes the agent's own session with
`RETRY_NUDGE`; the sixth failure is `failed` with the job failed; the job stays working while an
agent waits and a sibling finishing does not settle it; the slot is free while it waits and taken
again when it resumes, with one slot; a reply starts the count again and an API error written as a
reply does not; `auth` and billing, a budget stop, your own pause and stop, an interrupted run, the
agent's own limits and a 400 are not retried; retry now (route, no clock, the timer gone, the count
kept) and stop retrying (route, `failed` with the run's reason, the job failed); pausing or stopping a
waiting agent removes its timer and count; a pause-all holds the try until release; a restart forgets
the wait and resumes the agent with `RESTART_NUDGE` and five tries; the card is in the alert list,
the frames and the snapshot from the second retry; Copilot and OpenRouter wait on a throttle and a
lost connection, resume their session with the nudge, reset on a reply, and fail on a login or a bad
query. `web`: `attention/verify.ts`, `agent/verify.ts`, `lib/verify.ts` for the line, the banner, the
card's buttons and the wiring.

### Amendment 122 — post-merge, applied. **A Metrics tab (8): model usage, calls, time and errors, in total and per model.**

Daemon (`session/metrics.ts` new, `routes/metrics.ts` new, `db/migrations/170_metrics.sql` new,
`session/backends/claude.ts`, `session/backends/copilot.ts`, `session/backends/copilot-events.ts`,
`session/supervisor.ts`, `session/verify.ts`). Wire (`UsagePayload` in `shared/src/events.ts`,
`MetricsRange`, `MetricsCounts`, `MetricsModelRow`, `MetricsDay`, `MetricsBefore`, `MetricsResponse` at
the end of `shared/src/wire.ts`). Web (`web/src/metrics/` new, `shell/nav.ts`, `shell/shell.tsx`,
`lib/screens.ts`, `branches/verify.ts`). Asked 8 Oct: a tab reporting, in total and per model, input and
output tokens, the number of calls, how long a call takes, and the error rate. Nothing showed them
together: Diagnostics has counts and today's cost only.
- **What is kept, and why not from the agents.** One table of its own, `metrics_daily`, a row per local
  day, engine and model, added to as results arrive: input, output and cache-read tokens, dollars, calls,
  retries, runs, failed runs, run time, model-call time, and the calls and output tokens that time
  covers. It references nothing, so removing a job or an agent (which deletes its `agents` and
  `agent_runs` rows) leaves it alone, and `agents.model` being overwritten by a model switch cannot
  credit everything to the last model. Three small tables go with the agent (`ON DELETE CASCADE`):
  `metrics_baseline` (the last cumulative figures per agent and model), `metrics_agent` (what the agent
  had spent when metrics first saw it, and one running API-time total) and the one-row `metrics_meta`
  (`since`, the instant recording began).
- **The trap the item named, checked.** A Claude result carries CUMULATIVE `modelUsage` and
  `total_cost_usd`, and "a resumed or forked session continues from the totals its transcript saved, when
  it has them", so a resume's first result already includes the earlier runs. Its `usage`, which
  `setAgentUsage` writes to the agent row, is the MAIN LOOP's and the LATEST TURN's only. So: **a Claude
  agent's row holds its last run's main-loop tokens, while its dollars are lifetime**, and the tab reads
  neither. What a result adds is the difference from the last one, per model (`resultDelta`). It is
  "continued" when its dollars are at least what the agent had spent, the test `lifetimeCost` already
  makes; a lower total started again from zero (the transcript kept none) and is wholly new, and the
  baseline carries on as the sum. A total that went down on a continued session adds nothing, never a
  negative. `duration_api_ms` is taken to be one running total for the session like the dollars (the SDK's types
  do not say; its sibling fields are cumulative), so it is differenced the same way; a build that reports it per turn instead
  reads as fresh each time, and the running total follows.
- **An agent from before metrics.** Its first result since only sets the baseline (the running totals
  include runs never seen), unless that result started again from zero. Its calls and run are counted.
  Its tokens and dollars count from its second run on. Without this, its first resume would add its whole
  history again.
- **What the `usage` event gains** (additive, at the end of `UsagePayload`): `model` (Claude: the model
  that did the most in the run; Copilot and OpenRouter: the model of the call), `calls` (a Claude
  result's `num_turns`; 1 per Copilot call), `durationMs` (Claude's `duration_ms`) and `apiMs` (the
  model-call time this event adds: Claude's `duration_api_ms` since the last result, or a Copilot call's
  own `duration`). Absent where the engine did not say. `inputTokens`, `outputTokens` and `costUsd` keep
  their meaning. Claude's per-model tokens are taken from `modelUsage` (folded by `canonicalModel`),
  with the result's own `usage` used only when it has no `modelUsage`.
- **A run is credited to one model.** Runs, failed runs, run time, calls and model-call time go to the
  model that did the most in the run (Claude: most tokens added; Copilot: the first model called, which
  is the agent's own, since a sub-agent's calls come after). Tokens and dollars are exact per model. An
  alias such as `opus` is matched to the canonical name the SDK reported (`matchModel`), so a run's
  counts and its tokens land on one row.
- **Runs and errors.** The supervisor times every run itself, the same way for both engines
  (`recordRunEnd`, in `#launch` and `#launchWithPrompt`, after `run()` returns and before `#settle`), and
  counts it. A run FAILED is the `failed` status event that `#settle` writes right after a run's end:
  there is no second copy of that rule, so a stop of your own, a pause and a budget stop are runs and not
  failures, and a refused launch (folder gone) is not a run. Retried calls are `api_retry` events,
  counted into the run that went through them (only Claude reports them). Both subscriptions are started
  by `routes/metrics.ts`.
- **Route.** `GET /api/metrics?range=today|7d|all` (default `today`; anything else 400) →
  `MetricsResponse`: `total`, `models` (one per engine and model, biggest first), `days` (newest first,
  only days with something), `from`/`to`/`since` as local days, and for `all` a `before` object. `today`
  is the daemon's local day (`localDay`); `7d` is today and the six before it; `all` starts at the
  earliest day recorded. Sums only; the screen makes every rate. `costUsd` is null on a row of an engine
  whose backend does not report dollars (`capabilities.costUsd`), and on the total when none does.
- **Before metrics were recorded.** `before` (range `all` only) sums, from the agent rows, every
  agent still present that spent before metrics saw it: for an agent metrics has seen, what its row held
  at that moment (`metrics_agent.pre_*`), otherwise what it holds. Each is credited to the model the agent
  has now, and the screen says so, and that a Claude agent's row holds its last run's tokens only. Agents
  already removed before this shipped are not there; nothing can recover them.
- **Web.** `web/src/metrics/` registers screen 8 (`id: 'metrics'`, order 80, hotkey `8`): five figures
  (tokens, calls, time per run, errors, cost), a table per model (in, out, cached, calls, per run, per
  call, speed, failed, retried, cost, with a share bar under the name and the engine beside a non-Claude
  model), a table per day for 7 days and all, the labelled "Before metrics were recorded (no per-call
  data)" line with its caveat, and a fold-out "How these are counted". Range buttons Today / 7 days / All,
  kept as the setting `conductor.metricsRange`. It re-reads on arrival, on focus, on a change of range and
  700 ms after today's spend or any agent's status changes. Every rate is a division in `rules.ts` of two
  sums the engine really reported: time per call divides only the timed calls, tokens per second only the
  tokens of those calls, and an engine that gave no time has a dash, never 0 or NaN. A token engine's cost
  is a dash. The only colour besides ink is `--fail`, on the Errors tile and a failed count. `shell.tsx`
  says `1–8 screens`; `nav.ts` has `SCREEN.metrics` and `openMetrics`; `lib/screens.ts` reserves 8.
  `branches/verify.ts`'s status-bar check reads `1–8` now.
- **Not done.** (1) The Errors tile's "retried of calls" divides by every engine's calls although only
  Claude reports a retry, so with Copilot agents in the range it reads lower than Claude's own; the
  per-model rows are exact (another engine's retries show a dash). (2) A Claude run's model-call time
  covers the whole query pipeline, subagents included, but `calls` is the main loop's turns, so per-call
  time on a run with parallel subagents is an overestimate. (3) Tokens per second pairs a run's model-call
  time with ALL the output tokens of the run, credited to its main model. (4) Agents already removed
  before this shipped, and runs before it, have no per-call data and are not in the tables. (5) No
  per-project or per-agent filter, and no chart over time beyond the day table. (6) Nothing was looked at
  in a browser: not the layout, not either theme (the stylesheet is tokens only and a check holds it to
  that); and `duration_api_ms` being cumulative was taken from the SDK's documentation of the other
  cumulative fields and could not be confirmed against a real run.
**Verified:** `session/verify.ts` §21, with a fake `query()` whose result carries `modelUsage`,
`num_turns`, `duration_api_ms` and `duration_ms`: the arithmetic on plain values (canonical folding, a
continued result, a fresh one, a baseline-only one, a falling total, model choice, alias matching, day
maths); one run adds one set of rows and the `usage` event names the model with calls and time; the agent
row holds the main-loop tokens, not the model's; a RESUMED run adds only the difference (1600 in, not
2600) and today's spend still grows by the run's own $0.40; a session that started again from zero is
wholly new; a model switch splits the totals and leaves model A as it was; a failed run is a run and a
failed run, a budget stop and a stop of your own are runs and not failures; a result with no `modelUsage`
still counts; an agent from before metrics is in the "before" line, its first resume only sets the
baseline and its second adds the difference, and the line keeps what its row held then; a Copilot agent's
calls, with and without a duration, a sub-agent's call on another model, no dollars, and its `usage`
events; removing the job keeps every row and figure and drops only the agent's bookkeeping; the three
ranges and their days on dates of their own, a 400 for another range, and `today` by default.
`web/src/metrics/verify.ts` (in `make test`): the rates, durations, dollars and dashes, the tiles, the
rows, the labelled line, the registration on 8, the status bar, `nav.ts`, the daemon's ranges matching,
no two screens on a key, and the stylesheet tokens-only and set for both themes.

### Amendment 121 — post-merge, applied. **Make a new file from the Files tree, and open it ready to type.**

Shared (`wire.ts`), daemon (`workspace/service.ts`, `routes/workspace.ts`, `workspace/verify.ts`) and web
(`files/naming.ts` and `files/NewFileForm.tsx`, new; `files/FileTree.tsx`, `files/route.tsx`,
`files/useWorkspace.ts`, `files/useTabs.ts`, `files/FilePane.tsx`, `files/files.css`, `files/verify.ts`).
A TODO.md item (8 Oct): "Create a new file while browsing directories". No migration.
- **`WriteFileRequest.createOnly?: boolean`**, added at the end of the interface. With it, the daemon
  looks at the name before writing, under the same lock as any write: a file, a folder or a link
  (even one to nothing, which `lstat` sees and `stat` does not) holding it is a 409, "<path> already
  exists", and nothing is written. Without it a PUT replaces the file as before, so editing is
  unchanged. Both PUT routes, a job's and a project folder's, take it. Missing folders are still made;
  a folder in the name that is already a file is a 409 with its own sentence ("… cannot be made: a
  folder in that name is a file") instead of a 500.
- **The lock does not cover an agent.** Between the check and the write another process can take the
  name, and a rename would replace what it wrote. With `createOnly` the temp file is published with a
  hard link (`publishNew`), which fails with EEXIST if the name is taken, and the temp name is dropped
  either way. A filesystem with no hard links falls back to the rename, and the check made under the
  lock stands.
- **`createOnly` that is not true or false is a 400**, not taken for absent: a client that sent
  `"true"` and had it ignored would replace the file it meant to protect.
- **The path gate is the same one** (`workspace/paths.ts`): `..`, an absolute path and anything under
  `.git` (any case, any depth) are 400, with or without `createOnly`.
- **A `+` on every folder row, and on each tree's heading** (`FileTree.tsx`, `route.tsx`
  `RootSection`). It shows when you point at the row or tab to it, and always where there is no hover.
  It is a sibling of the row's button, not inside it. Arrow keys still walk the rows only. The
  Navigator's folders (Amendment 92) have none; the item said the Files tree only.
- **The box** (`NewFileForm`) opens under the row with the folder already in the name and the file
  name selected: `docs/notes/untitled.md`, `untitled` selected. Enter makes the file, Escape or the
  **✕** puts the box away. `checkName` (`naming.ts`) answers the mistakes a keyboard makes before the
  round trip, with a sentence: nothing typed, `..`, an absolute path or drive, `.git`, a trailing `/`,
  a backslash, a control character, a segment over 255 bytes. `a//b` and `./a` are tidied to `a/b` and
  `a`, so the tab opens under the path that was written. Any other name is allowed, with folders in it
  if it has them. The daemon's own sentence (a name taken, a path refused) shows under the input, the
  box stays open, and what was typed stays to be fixed; the error clears when it is edited.
- **Making it** (`createFile`, `useWorkspace.ts`): a `writeFile` of `''` with `createOnly`, then
  `refreshRoot(root)`. A project folder's tree is never watched, so nothing else would re-read it; a
  job's worktree does emit `file_edit` and the refresh is then one coalesced refetch more, so it is
  done for both. A refused write refreshes nothing. It works in a running agent's worktree: the file
  belongs to no agent, as with any human edit.
- **Then it opens ready to type** (`openNew`, `useTabs.ts`): the daemon's spelling of the path is
  opened in front, `putEdit` starts the editor on an empty draft (draft equals file, so nothing is
  unsaved until you type), and the pane takes the cursor the first time it shows (`takeFocus`). An
  image name (`x.png`) opens with no editor, since the pane has none for it.
- **An empty file renders.** `FilePane` draws "This file is empty." (plus "✎ edit to write in it." when
  it can be edited) instead of a blank pane. The daemon already read an empty file (not "binary", not
  gone), and an empty draft already worked (`edit?.draft ?? file.raw`).
- **Not changed:** editing (`writeFile` without `createOnly`) and the Navigator. Colours are
  existing tokens only (`--surf`, `--line2`, `--ink`, `--live`, `--fail`), so
  both themes get the box.
- **Not done:** new folders, rename and delete (separate items in TODO.md); the box does not close when
  you click elsewhere, only on Escape, **✕** or a made file; a name that differs only by case from
  one that exists is refused only on a case-insensitive filesystem; the box and the `+` have not been
  looked at in a browser in either theme.
**Verified:** `workspace/verify.ts` §16: a PUT of a new name makes the file and its folders (empty, with
`html` for markdown, in the tree, a `file_edit` with no agent); `createOnly` on a taken name is a 409
ending "already exists" and writes nothing (a file, a folder, a link to nothing), three concurrent
creates of one name give one 200 and two 409, a file written by something else first is kept, and
`publishNew` refuses a name taken after the check and drops its temp file; the plain PUT still replaces,
and `createOnly: false` is the same; `createOnly: "true"` is a 400; `..`, a climb in the middle, an
absolute path and `.git` (three ways) are 400 with and without it, and nothing lands outside; a folder
in the name that is a file is a 409 with its sentence; no `.conductor-write-*` is left behind; the same
for a project folder (new file and folders, 409 on a taken name and on a file that was there before
Conductor looked, `..` and `.git` refused). `files/verify.ts` "a new file from the tree": `prefill`,
`checkName` for every rule above, the tree drawn with a `+` on each folder (none without the props), the
`+` beside the row's button and not inside it, the root's box first and a folder's box under its row
with the folder in it, an empty folder's box; Enter and Escape, arrow keys kept in the box, a refusal
shown under it; `createFile` sends `{path, content: '', createOnly: true}` to the job's route or the
project's, bumps that root's refresh count once, and bumps nothing when refused (the daemon's sentence
is what shows); an edit's save has no `createOnly` and no refresh; `openNew` puts the tab in front with
an empty draft and the cursor asked for once, and none for an image; the wiring in `route.tsx` and
`FilePane.tsx`; the CSS uses tokens only.

### Amendment 120 — post-merge, applied. **The hold is on the wire, the re-run note outlives a restart, and the handoff is tighter.**

Shared (`wire.ts`, `rerun.ts`), daemon (`session/handoff.ts`, `session/windows.ts` new, `session/store.ts`,
`session/supervisor.ts`, `session/models.ts`, `session/backends/copilot.ts`, `session/verify.ts`, migration
`160_rerun_note.sql`) and web (`fleet/HandOffChip.tsx` and `fleet/handoffchip.css` new, `fleet/card.tsx`,
`fleet/lane.tsx`, `attention/alerts.ts`, `shell/nav.ts`, `agent/verify.ts`, `attention/verify.ts`), and
`docs/MANUAL.md`. Two TODO.md items, both found on 10 Oct: "Loose ends from the stack work (Amendments
99-104)" (all but its Spawn bullet) and "Tighten the whole-conversation handoff (Amendment 101)".

**The line about asking.**
- **`STACK_ASK_LINE` no longer says the agents after it start without the answer.** Since `hand_off`
  (Amendment 104) an agent that others wait for is held when its turn ends without handing off. The line
  now says a question in the reply "is only the end of your turn: it is not put to anyone, and if agents wait
  for you, you are held as not handed off", and that the question tool puts it in Needs You and holds you,
  and the agents after you, until the user has answered. It is read by an agent nobody waits for as well
  (the last in a chain), so it says only what is true of both. The tests quoted the constant itself, so
  they follow it; a new one checks the wording.
- An agent launched under Amendment 100's wording has that wording taken out of its prompt when the next
  agent is given its conversation (`AMENDMENT_100_ASK_LINE`, never sent again), so it is not passed on as
  if it were that agent's brief.

**The hold on the wire.**
- `Agent.handoffHeld?: boolean`, at the end of the type: present, and true, only while the agent is `done`
  and held (the `handoff_held` column of migration 130). Every other agent's shape is what it was. `toAgent`
  sets it, so it is in the snapshot, in `entities` frames, and in `GET` responses.
- **One copy of the rule, in shared.** `heldRefusal(agent)` (`shared/src/rerun.ts`) is the sentence
  ("architect stopped without handing off, so the agents after it haven't started. Hand it off in Needs You
  first."), and `rerunPlan` returns it as the plan's `refusal` before any other, still listing who is after
  the agent. `Supervisor.rerunFrom` lost the check and the sentence it had of its own: it asks `rerunPlan`,
  so the 409 and the Agent screen's button say the same words from the same call. The button was already
  disabled with `plan.refusal` as its hover text (Amendment 102), so `agent.tsx` is unchanged.
- **The Fleet card and the Project lane.** An amber **not handed off** chip, "hand off in Needs You →"
  (`fleet/HandOffChip.tsx`, tokens only in `fleet/handoffchip.css`), under the agent's row on the card
  (it cannot nest in the row, which is a button) and between the lane's head and its tail. It opens that
  agent's card in Needs You by its alert id (`openAlert(alertId)`, new in `shell/nav.ts`, the same deep link
  a notification uses); if the person dismissed the card, it says "open the agent" and goes to the Agent
  screen, where a reply works the agent again. It is there when the agent is held and an agent is still
  waiting for it, the daemon's rule for the alert (`handOffChip` in `attention/alerts.ts`, pure). **Decision:
  a chip, not `HandOffPanel`.** The summary box is built on the Needs You card's `atn-*` styles and wants a
  card's width; a Fleet card or a lane is small and the whole of it is one button that navigates, so a text
  box inside it would fight the click and the keys. The chip stops both, as the card's `…` menu does.
  `openAttention()` is unchanged: the top bar passes it as a click handler.

**The re-run note is durable.**
- Migration `160_rerun_note.sql`: `agents.rerun_pending TEXT`, a JSON array of the roles whose reply
  changed, NULL when no note is waiting. `rerunFrom` sets it (`setRerunPending`) where it used to put the
  agent in the supervisor's `#rerunPending` map; `#takeRerunNote` reads it and clears it when taken;
  `terminateAgent` clears it. A daemon that restarts between the press and the agent's start still resumes
  it with the note. Off the wire. The map is gone.

**Real windows.**
- `session/windows.ts` keeps what the engines reported, by provider and exact id: OpenRouter's
  `context_length` (read in `openRouterModels`), Copilot's `capabilities.limits.max_context_window_tokens`
  (`copilotModels`), and the gateway's `max_input_tokens` on `GET /v1/models` (`askGateway`, recorded in
  `catalog()`; checked against the Models API reference: `number or null`). Claude Code's own list has no
  window. A model whose list gave none, or a nonsense one (zero, negative, not a number), has none.
- `contextWindow(model, reported?)` and `handoffCap(model, reported?)` take it and fall back to the floor
  table, which is unchanged. The supervisor looks it up (`#handoffCapOf`, by the agent's provider and exact
  model) in `#promptFor` and the re-run note. A `[1m]` model is not looked up: the list gives the base
  model's window, and `[1m]` is the 1,000,000 one the floor already says.
- **Still an estimate.** The cap is a quarter of the window, counted in characters at 3 to a token. There is
  no tokenizer in the repo, and none that runs offline for every engine, so tokens are not counted; this was
  the TODO's second half ("and count tokens") and it is not done. What changed is the window.

**Repeated text is dropped before the cap is spent on it.**
- `dropRepeats(upstream)` (`handoff.ts`, pure; `handoffSection` calls it first). An agent's launch prompt holds
  what the agents before it said, so an agent waiting for several that share a parent sees the parent's part in
  each of their prompts, and again if it waits for the parent too. In the user turns of each upstream
  (where a part is quoted), a run of paragraphs said above is replaced by `(repeated from above, left out
  here)`: said in the voice of another upstream (its summary, replies and tool lines) wherever it is in the
  list, or shown by an earlier upstream's user turns (the first copy stays). A run starts at a paragraph of 60
  characters or more and takes the shorter ones said above with it. Replies are never touched, nor a short
  paragraph that stands alone, nor text only one upstream said. A chain where C waits only for B has nothing
  to drop: A's part is there once, inside B's. **The TODO's chain case is therefore not a repeat** as it is
  worded; only the shared-parent case is.
- Order matters only for which copy stays: if the parent is listed after the agents that quote it, its own
  part stays and the quotes go.

**Orchestrator helper reports.** `helperReport(helpers, cap)` now gives each helper's whole conversation
(its task, replies, one line per tool), shared out within a quarter of the orchestrator's window with the
same `shareCap`, oldest first, last reply whole, repeats dropped, instead of the last reply cut at 8,000
characters. `HELPER_REPLY_CAP` is gone. It was a small change in `handoff.ts`, but it needs
`#takeHelperReport` in `supervisor.ts` to pass the helpers' turns and the cap, which is outside the regions
the plan lets this lane touch; the edit is six lines and no other lane touches that function. An
orchestrator's wake-up prompt is therefore bigger than before (up to a quarter of its window, not 8,000
characters per helper).

**Checked.**
- `session/verify.ts` §17 (end): the new line's wording and that it names both tools; the old line taken out of
  an old prompt; a reported window used as is and a bad one ignored; the cap at 8,192 tokens is 6,144
  characters; `recordWindows` by provider and exact id, `[1m]`; `dropRepeats` and `handoffSection` with three
  agents sharing a parent (the plan, its summary and its tool lines once; the opening sentence and each
  agent's own brief and reply kept), with the parent listed first, last, or not at all; a chain, two agents
  saying the same long thing in their own voice, a short paragraph in both, and objects handed back when
  nothing is dropped; a cap too small for the three as they were cuts nothing now; `helperReport` (whole
  conversation, failed helper marked, shared cap, oldest first, 12,000 characters whole). The three
  helper-report assertions of §17, §17c and §19 that pinned the 8,000-character cut and the bare reply were
  changed to match.
- `session/verify.ts` §21 (new, last): a held architect: `handoffHeld` on the agent, in `GET /api/snapshot` and
  in an `entities` frame on an open socket; `rerunPlan` refuses with the sentence, still listing the
  developer, and `POST /rerun` answers 409 with the same string; a second `Supervisor` on a second connection to
  the file finds the hold, pumps and starts nothing, refuses the re-run in the same words, then
  `handOffByUser` through it starts the developer in that Supervisor with the summary, and the first connection
  sees the field gone; a re-run pressed on a held Supervisor leaves `rerun_pending` in the row, a second
  Supervisor on a reopened file starts the developer with the note (not the wake nudge) and clears the column,
  and terminating clears a waiting note; OpenRouter's `context_length`, Copilot's window and the gateway's
  `max_input_tokens` recorded (the last read from a local server shaped like the Models API response, with
  `null` and a missing field); an agent on a model reported at 2,000 tokens is given ~1,500 characters and one
  with none the floor; a diamond run by the real supervisor: the architect's plan and summary are in the
  scribe's prompt once and the three agents' own replies and summaries are all there.
- `attention/verify.ts` §7 and `agent/verify.ts` §11: `handOffChip` (held, waiting, who is named, dismissed,
  not held, not done, nobody waiting), the wiring of the chip in the card and the lane, stopping the click,
  `openAlert` and `openAttention` as they were, tokens only; the re-run button on a held agent is there and
  blocked with the daemon's sentence, and the screen has no rule of its own.

**Not done.**
- **A re-run of a parked agent against the real SDK** (the item's fifth bullet). It resumes a session that ended
  on `tool_deferred` with a prompt; only a fake backend has run it. It costs money and needs a person watching
  (plan: "Not done by design"). Untouched.
- **Spawn (99)**: removing a Custom row re-chaining the rows that waited for it, and a job's `preset` label.
  Another lane's.
- **Tokens are not counted**, as above. The characters-per-token figure is a guess that errs small.
- **The real window is in memory.** After a daemon restart it is empty until a model list is asked for again
  (opening Spawn, or `GET /api/models`), so a stack that resumes straight after a restart is capped by the
  floor until then. The floor is small for most models and too big for a model with an unusually small window.
  Persisting them (a table in migration 160) is a small step if wanted. Claude Code's result message carries
  `modelUsage[model].contextWindow` for a Claude run, which would fill this without a list; reading it belongs
  in `backends/claude.ts`'s `result` case, which the usage, retry and budget lanes edit, so it is left.
- **The chip is not the summary box.** Hand-off happens in Needs You (or the Agent screen's Needs panel); the
  chip only gets you there. A dismissed card is not brought back by the chip.
- Not looked at in a browser: the chip on the card and the lane in both themes, and the disabled re-run
  button on a held agent.
- Not run by this lane: `make test`, the daemon smoke test, the workspace and preview suites.

### Amendment 119 — post-merge, applied. **An agent a restart interrupted is told its background work is gone, and asked once to hand off.**

Daemon only (`session/supervisor.ts`, `session/verify.ts`). Reported on 10 Oct from a session whose
analyst was running background search helpers when Conductor restarted. It resumed (Amendment 53),
found them stopped, answered "No response requested", and ended its turn with no `hand_off`. The hold
of Amendment 104 did its job: the agents after it did not start with nothing. But you had to ask why,
twice, before it picked the work up.
- **The restart nudge says what a restart takes.** `RESTART_NUDGE` already warned about a tool call
  that was still running. It now adds that anything the agent had running in the background, such as
  background agents or tasks it started itself, was stopped with it and will not report back: do that
  work again, and do not end the turn until it is done. Conductor's own helpers are unaffected; they
  are agents, and resume on their own.
- **Asked once, before the hold.** `#restartRuns` marks a run that began as a restart resume (it was
  given `RESTART_NUDGE`). If that run ends where `#holdsHandoff` would hold it, `#settle` does not
  write `done`: `#askToHandOff` resumes the agent in its own session with `HANDOFF_ASK` (shown as
  `auto`), and it stays `working`. If that run also ends without `hand_off`, it is held as before,
  with the alert and the card. Asked once, because the second run did not begin as a restart resume.
- **Where it is not sent.** With no session to resume, while everything is paused until a time
  (Amendment 111), when the job is paused, halting or failed, at a cap, or with the folder gone:
  nothing starts by itself there, so the hold stands and you are asked. A run that ends in any other
  way (failed, parked on a question, waiting for helpers) takes its mark with it and asks nothing.
- **Not changed.** An agent that did not begin its run from a restart is held at once. One that
  called `hand_off` is not asked, and what waits for it starts. The mark is in memory: a second
  restart gives the agent a new restart run and so a new request, which is right, since it lost
  its background work again.
**Verified:** `session/verify.ts` §20, "a restart is the likeliest reason an agent forgot": the nudge
text; a restart-resumed analyst that ends without `hand_off` is resumed in its session with
`HANDOFF_ASK`, working, not held, no alert, the developer queued; ending that run the same way holds
it with the alert and no third run; one that hands off after the restart starts the developer and is
not asked.

### Amendment 118 — post-merge, applied. **A scheduled message opens to its whole text.**

Web only (`agent/scheduled.tsx`, `agent/agent.css`, `agent/verify.ts`). Asked for on 9 Oct: "when I
create a command to be run at a later time, it shows up as a line above the command entry area.
Allow me to click on the scheduled commands and see what the content is." The line above the
message box (Amendment 111) showed only the first line, with the rest in a hover title. Each line
is now a button (`.ag-sched-open`, `aria-expanded`, ▸/▾) that opens the whole message beneath it,
with its line breaks kept and scrolling past 14em, and says when it will be sent and when it was
scheduled. ✕ stays its own button, so opening never cancels. More than one can be open. Tokens only.
**Verified:** `agent/verify.ts`, "a scheduled message opens to its whole text".

### Amendment 117 — post-merge, applied. **Choose a project's default branch, and check its folder out on it.**

ADR 0009 §1: Amendment 113 let you *draw* against a branch other than the one `createProject`
recorded; this lets you *set* that recorded branch, and optionally move the project's own
folder onto it — "put Conductor on that branch" without a terminal.
- **Migration** (`db/migrations`, 150). `projects.default_branch_set INTEGER NOT NULL DEFAULT 0`:
  whether `defaultBranch` was chosen on this screen, or is still just whatever was checked out
  when the project was added. `setDefaultBranch(db, projectId, branch)` writes it and flips the
  flag, returning the updated project; `defaultBranchIsSet(db, projectId)` reads the flag.
- **Daemon** (`workspace/branches.ts`). `set_default` on `BranchAction`: `{ branch, checkout }`.
  Validated like every other action — an unknown branch or one starting with `-` is 400. With
  `checkout`, three refusals before anything moves, each 409: the project's own folder has
  tracked changes, an agent is `working`/`blocked`/`queued` in a job isolated `in_place` or
  `branch` there, or the branch is checked out in a worktree that isn't that folder. Clear, it
  runs `git switch` in the project's own path. Either way the pick is stored first, and
  `resolveTarget`'s tiers gain one: a user-set recorded branch now beats origin's default and
  the registration-time fallback, though a branch chosen on the screen (Amendment 113) still
  wins over it. The in-memory `target`/`targetFrom` are updated right there too, so the POST's
  own answer — and the `branches` frame broadcast with it — already draws against the new pick,
  not what was true when the request started.
- **Routes** (`routes/branches.ts`). `set_default` writes through `setDefaultBranch` and
  broadcasts `{ type: 'entities', projects: [updated] }`, so every screen holding that project
  learns its new `defaultBranch` without a re-fetch; `listBranches` also answers `rootBranch`
  (what the folder has checked out, or `null` detached), `rootClean`, and `rootLive`.
  (`BranchesResponse.rootBranch?`, `.rootClean?`, `.rootLive?` were added ahead of this
  amendment as consequences of ADR 0009 §1; nothing else in the wire contract changed.)
- **Web.** The head gains a line beside **compared with**: **default: `<branch>`** alone, or
  **default: `<branch>` · folder on `<branch>`** once the folder is known, in warning tone when
  the two differ. The selected branch's bar gets **Make default** (disabled only when it already
  is) and **Make default and check out**, which confirms first — the folder may be Conductor's
  own, and whatever is running from it runs the new branch's code the moment it switches.
- **Verify:** daemon `verify-branches.ts` §12, a second repo kept apart from §1-11's so its
  permanently-live fixture job can't block a checkout; web `branches/verify.ts` §9.

### Amendment 116 — post-merge, applied. **"You asked" reads in your colour, `--you`.**

Web only (`agent/agent.css`, `agent/verify.ts`). ADR 0009 §3. The pinned bar at the top of the
transcript (`LastAsk`, `.ag-lastask`) is what you last typed, so it now matches your turns
below it (Amendment 106): a 3px `--you` left edge, a border mixed from `--you` and `--line`,
`color-mix(in srgb, var(--you) 10%, var(--bg2))` behind it (still opaque, since it scrolls over
live text), and its **You asked** label and text in `--you`. Hover lights the border to
`--you`. `--you` is ≥ 6.6:1 on every surface (Amendment 106), and a 10% tint of it keeps that.
**Verified:** `agent/verify.ts`, "You asked" is `--you`.

### Amendment 115 — post-merge, applied. **Pick a git methodology per launch: the default branch in place, a branch you name, or a new branch per launch.**

ADR 0009 §4, accepted by default on 9 Oct ("let me specify what git branch methodology you should use"),
built on 10 Oct as lane M of `docs/plans/todo-wave-10.md`. Spawn's three isolation pills are now three
choices of what the agents do with git; the daemon takes a branch name and checks it. No migration.
- **The three choices** (`web/src/spawn/launch.ts`, `METHODS`). (1) **default branch**, in the folder,
  sends `isolation: 'in_place'`: the agents work in the project's folder on what is checked out there
  (normally the default branch, Amendment 117), still drawn as a hazard in `--fail`. (2) **new branch:**
  sends `isolation: 'worktree', branch: <name>`. (3) **new branch per launch** sends `isolation:
  'worktree'` and nothing else, `conductor/<jobId>` as before, and is still the built-in default. A "text
  input command" is a launch from Spawn; a follow-up message stays on its job's branch, as it always did.
  The `branch` isolation ("branch in place") is not offered in Spawn any more; the API still accepts it
  and the `branch` row of a job is unchanged.
- **Daemon** (`workspace/worktree.ts`, `POST /api/jobs` in `routes/session.ts`, `createJob`).
  `CreateJobRequest.branch` (already in `wire.ts`) is read by the route: an empty or non-string name, or
  a name with an isolation other than `worktree`, is 400. `createJob` hands `WorktreeMgr.ensure` the name
  with `named: true` and the project's recorded default (`recordedDefault`, with whether Amendment 117
  chose it). `ensure` then, for a named branch only and only when it creates the worktree (a reuse skips
  all of it):
  - `branchNameProblem`: `git check-ref-format --branch`, and the name must come back unchanged (that
    option also expands `@{-1}`); `@` alone and a leading `refs/` are refused as well. → **400** with the
    reason.
  - `branchRefusal` (pure): the project's default branch → **409**. "Default" is the recorded
    `defaultBranch` and also what `resolveTarget` gives with no screen pick (chosen default, then
    origin/HEAD, then the recorded one, then main/master); the Branches screen's compare-with pick is a
    view, not a default, so it is not refused. A branch some worktree has checked out, including the
    project's own folder → **409**, naming where.
  - Under one lock per repo (`repo:<root>`), so two launches naming one branch at once cannot both pass
    the check: an existing branch is added with `git worktree add -- <path> <branch>`, **never `-B`**
    (it would reset the branch and lose its commits); a new one with `git worktree add -b <branch> --
    <path> HEAD`. The old `-B` stays for the implicit `conductor/<jobId>` name only, and for the
    bootstrap `POST /api/workspaces`, which does not pass `named`.
  - A refusal is a `LaunchBranchError(status, message)`; `createJob` lets it through unwrapped and the
    route answers `{ error: 'could not use that branch', detail: <the sentence> }` with its status.
    Nothing is made: no job, no worktree, no branch.
- **Web.** Spawn step 3 reads "git — which branch the agents work on", with the pills numbered 1 to 3.
  Choosing (2) shows a name field under them (`aria-invalid`, the reason in words); the launch waits until
  it holds a name `branchProblem` accepts. That check is `git`'s rule written out and the project's
  default branch (`Project.defaultBranch`), so the common mistakes cost no round trip; the daemon has the
  last word, and a 409 from it shows in the launch error. A project with no git moves the launch to (1)
  and, on a repo again, back to whatever it had. The name is cleared after a launch on it: that branch is
  taken by the job just started. `launchBody` builds the request; `branch` is sent for (2) only.
  Settings → Spawn's defaults offers the same three, under the same key `conductor.launch.isolation`:
  `in_place` and `worktree` keep their meaning, `named` is new, and a stored `branch`, or anything else,
  reads as the built-in default. Choosing (2) as the default stores no name, so Spawn opens on it with
  the field empty and will not launch until it is filled in. `LaunchDefaults.isolation` is now
  `LaunchDefaults.method`.
- **Spawn (99), removing a Custom row** (`spawn/order.ts`, `removeRow`, called by `custom.ts`'s
  `removeRole`). Rows that waited for the removed row are re-chained, as a pure function: a row that
  waited for **exactly** the removed row now waits for **the row that was above the removed one**
  (for no one if it was the first); a row that waited for it **and others** keeps the others; a row that
  did not wait for it is untouched. The removed row's own waits are not inherited: the row above is
  always above every row that waited for the removed one, so every wait still points up and the daemon
  takes it (Amendment 98), and it is what the "waits for the row above" default means. Before, the wait
  was only dropped, so a row that waited for exactly it started with nothing.
- **Spawn (99), the `preset` label.** It is sent in the launch body as `preset` and copied to
  `CreateJobRequest.preset` by the route; **nothing reads it** (`createJob` ignores it, a job has no
  preset column, `shared/src/stack.ts` says a launched job does not remember its preset). Its value was
  the preset's own name even when its rows were moved or its ticks changed. It is now `presetLabel(label,
  changed)`: `<Preset> (changed)` when this launch's rows are not the preset's (`!sameStack(preset.roles,
  base.roles)`, so moving a row and moving it back is not a change), the plain name otherwise; a Custom
  setup is sent under its own name, as before. Nothing else needed to change.
- **Docs.** `docs/MANUAL.md`: "Choose which branch the agents work on", the Custom-row removal rule, the
  `(changed)` label, the Settings wording, two troubleshooting rows.
- **Not done.**
  - A branch that exists only on a remote (`origin/feature/x`, no local branch) is treated as new and cut
    from HEAD; git's own `worktree add` would have made a tracking branch from the remote. Nothing says
    which the person means.
  - There is no way to pick an existing branch from a list in Spawn; you type its name. The Branches
    screen has the list.
  - `restoreFolder` (Amendment 114) on a job whose named branch is checked out elsewhere by then fails
    with git's message, not a sentence of ours.
  - The bootstrap `POST /api/workspaces` still resets an explicitly named branch for `worktree`
    isolation (`-B`), as before; it is "expected to be gated or removed". It would answer 500, not 400/409,
    for the new refusals if it ever passed `named`, which it does not.
  - Not looked at in a browser, in either theme: the three pills, the name field and its note, the
    Settings row. The colours are tokens the contrast checks already measure (`--ink3`, `--fail`).
**Verified:** `workspace/verify-methodology.ts` (was a stub; 79 checks), against a throwaway repo with the
agents held and the SDK throwing if anything reaches it: the pure rules; (3) unchanged; a named new
branch (worktree under `.conductor/wt`, cut from the folder's HEAD, folder untouched); a named existing
branch keeps its tip and its commits (no `-B`); 400 for an invalid name, an empty or non-string `branch`
and `branch` with another isolation, with no job, worktree or branch made; 409 for a branch a job's
worktree has, a worktree of your own, the project's own folder, the recorded default (also with the
folder on another branch) and a default chosen on the Branches screen; two launches on one branch at
once give 201 and 409; `in_place` unchanged, with and without git; the `branch` isolation still accepted.
`spawn/verify.ts` §19: the three choices, their bodies and keys, (2) needing a name, `branchProblem`
against `git check-ref-format --branch` on a list of names, the setting's values and defaults, the screens'
source, the re-chain on removal (chain, first row, last row, fan-in, every wait still above its row, a
Custom setup still launches), the preset label. Also `workspace/verify-branches.ts`, `branches/verify.ts`
and `pnpm --filter @conductor/web verify` unchanged and green.

### Amendment 114 — post-merge, applied. **An agent whose job's folder is gone is told so, and the folder can be recreated.**

Reported 9 Oct: a standalone architect "stopped without results". Its job's worktree had been removed
(in a branch clean-up) while it could still be resumed; every resume handed Claude Code a cwd that
didn't exist, which failed as "native binary … failed to launch (ENOENT)" and settled as
`iteration_error`, five times. Asked: "can't you identify if this job folder is gone?"
- **Supervisor.** `#refuseGone(agentId, job)` before `#launch` and `#launchWithPrompt` start anything:
  no folder → `#settle` with `terminalReason: 'folder_gone'` and `folderGoneDetail(path, restorable)`,
  so it is `failed` with the sentence and Needs You shows it. `sendMessage` checks first and throws
  `FolderGoneError`; the message route answers 409 with that sentence, and nothing changes.
- **Recreate.** `restoreFolder(jobId)`, `POST /api/jobs/:jobId/folder` → `{ path, branch, from:
  'branch' | 'base', base? }`: `worktree prune`, then `worktree add -- <path> <branch>` when the job's
  branch exists, else `worktree add -b <branch> -- <path> <target>` with Amendment 113's target. Each of
  the job's agents gets a synthetic note in its transcript saying what came back and that uncommitted
  work is gone. 409 (with the sentence) when the folder is there, the job isn't `worktree` isolation, or
  the project folder is gone too; 404 no such job.
- **Web.** `folder_gone` reads "lost its folder: it was deleted". A `failed` alert with that cause offers
  **recreate folder and continue** (`restore`: POST, then `continueAgent`) in place of continue.
- **Verify:** daemon `session/verify-folder.ts` (port 7813, 18 checks, real worktrees, fake SDK); web
  `attention/verify-folder.ts`. Both in `make test`.

### Amendment 113 — post-merge, applied. **The Branches screen draws against a branch that exists, and you can choose it.**

Reported 9 Oct: `git branch` lists seven branches, "why does it not show that on the Branches page".
Cause: the screen drew everything against the project's `defaultBranch`, which `createProject` takes
from whatever was checked out when the project was added (`supervisor.ts:428-432`) and never updates.
For this repo it was `cleanup`, deleted since, so there was no target: every branch read as sharing no
history with it, ahead 0, and the rail was empty. Other projects had feature branches recorded.
(112 is held for the terminal plan, `docs/plans/full-terminal.md`.)
- **Daemon** (`workspace/branches.ts`). `resolveTarget(root, recorded, chosen)`: the first local branch
  of the chosen one, origin's default (`symbolic-ref refs/remotes/origin/HEAD`), the recorded one,
  `main`, `master`, the checked-out one, any. `openRepo` takes `chosen` and resolves it; the listing
  carries `targetFrom`. The project's `defaultBranch` is not changed: it is still what was checked out.
- **Choosing.** The setting `conductor.branchTarget.<projectId>` (`branchTargetKey` in shared), read by
  `routes/branches.ts`; a change to any such key broadcasts `{ type: 'branches', projectId }`.
- **Wire.** `BranchTargetSource`, `BranchesResponse.targetFrom?`.
- **Web.** **compared with ▾** in the screen's head: **automatic — <target>** (removes the setting) and
  every local branch; beside it, where an automatic one came from (`targetFromWords`).
- **Verify:** daemon `verify-branches.ts` §11; web `branches/verify.ts` §8.

### Amendment 112 — post-merge, applied. **A full terminal on macOS and Ubuntu.**

Daemon (`terminal/pty.ts`, `ring.ts`, `shell.ts`, `service.ts`, `routes/term.ts`, a one-line close in `session/supervisor.ts`), shared (`wire.ts`), web
(`agent/Xterm.tsx`, `TermPanel.tsx`, `term.ts`, `agent.css`, `agent.tsx`) and `docs/MANUAL.md`. Asked for on 9 Oct: "a full terminal
capability… the terminal is lack luster." Design accepted by default on 9 Oct (ADR 0009 §2, cut down from `docs/plans/full-terminal.md`).
**Windows was dropped on 10 Oct:** nothing is built or tested for it.
- **Dependencies (§3), pinned, no others:** `@lydell/node-pty` 1.2.0-beta.15 (daemon); `@xterm/xterm` 6.0.0 and `@xterm/addon-fit`
  0.11.0 (web). The first native module Conductor ships: prebuilt for darwin and linux on x64 and arm64 (its optional per-platform
  packages), so nothing is compiled and no `onlyBuiltDependencies` entry is needed. Added from the lockfile edits of the abandoned wave 9 attempt.
- **`terminal/pty.ts`**, the only file that names the library. `ptyStatus()` and `loadPty()` load it lazily with `createRequire` and
  return "unavailable", with a one-line reason, if it will not load or the platform is not darwin or linux. Output is delivered as
  bytes (`encoding: null`), so a UTF-8 character split between two reads stays whole in the browser.
- **The shell** (`shell.ts`): `$SHELL` if it exists, else `/bin/bash`, else `/bin/sh`, always with `-l` (the daemon is often started
  from the dock launcher without your profile's PATH). Environment: the daemon's own, `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `NO_COLOR` removed, and `CONDUCTOR_TOKEN` removed as the command runner does. `cwd` is the job's worktree; a missing folder is 410.
- **Limits and lifetime** (`service.ts`): at most **16 live** terminals (an ended shell does not count); the 17th is 409, "16 terminals
  are open already. Close one first." The last **512 KB** of each terminal's output is kept (`ring.ts`, raw bytes, realigned to a UTF-8
  character boundary when trimmed) and replayed first to a page that attaches, with nothing lost between the replay and the live
  output. A terminal ends when its shell exits (it stays listed as `exited`, with its code and output, for 10 minutes, or until
  closed), when it is closed (SIGHUP, then SIGKILL after 3 s; the shell's foreground command goes with it), when its **agent**, **job**
  or **project** is removed (`deleteAgent`, `deleteJob` and `deleteProject` each call `terminals().closeAgent` or `closeJob`), or when
  the daemon stops (the route's `onClose` waits for every shell to go). It is **not** ended when the page closes or reloads.
- **Back-pressure.** A page whose socket is more than 1 MB behind pauses the shell (`pty.pause()`) until it is down to 256 KB, so a
  `cat` of a huge file cannot grow the daemon without bound. The buffer is written either way.
- **Routes** (`routes/term.ts`, auto-registered): `POST /api/agents/:agentId/terminals` → 201 `{ id }` (optional body `{ cols, rows }`, so the
  prompt is drawn at the panel's size; 404 no such agent, 409 at the cap, 410 folder gone, 503 no PTY); `GET /api/agents/:agentId/terminals` →
  `{ available, reason?, terminals: [{ id, cwd, startedAt, exited, exitCode }] }`; `DELETE /api/terminals/:id` → `{ closed: true }`, 404
  for an unknown id, and it returns once the shell has gone.
- **The socket**, `GET /ws/term/:id`. Server to page: **binary** frames, the replay first; the socket closes with 1000 when the shell
  ends or the terminal is closed, and 4404 for an id nobody has. Page to server, JSON: `{ t: 'in', d }` (at most 1 MB) or
  `{ t: 'resize', cols, rows }`; anything else is ignored. More than one page may attach to a terminal; input from any is taken, and
  the size is the last resize. It is registered on the same app as `/ws`, so the same `onRequest` hooks and the plugin's `verifyClient`
  stand in front of it: a non-local Host or Origin is turned away before the route (`guard.ts`), and with `CONDUCTOR_TOKEN` set it
  needs what `/ws` needs. Nothing is re-implemented.
- **Wire** (`shared/src/wire.ts`, at the end): `TermInfo`, `TermListResponse`, `TermCreateRequest`, `TermCreateResponse`,
  `TermClientFrame`, `TERM_WS_PREFIX`.
- **Web.** The Agent screen's **›_ terminal** tab is now `TermPanel`: tabs, one per terminal, **+** to open another, **×** to close one;
  the first visit to an agent with none open opens one (a terminal closed on purpose stays closed, for as long as the page is open).
  `XtermView` draws the selected one with `@xterm/xterm` and `addon-fit`: it fits the panel (a `ResizeObserver`, 50 ms debounce), sends
  the size when the socket opens and on every change, resets the screen on each attach (the replay brings it back), and on a dropped
  connection retries at 0.5 s doubling to 10 s with a "reconnecting…" note. Leaving the tab only lets go of the socket. A tab whose
  shell ended says so, with the exit code, and offers **↻ new terminal**. Ctrl-Shift-C copies on Linux; the app's single-key hotkeys
  already skip a textarea, which is what xterm types into.
- **The runner is the fallback.** When `GET` says `available: false`, the tab shows the old command runner (`agent/Terminal.tsx`,
  `session/terminal.ts`, unchanged) under a banner with the daemon's reason. Fallback cases: the library does not load, or the platform is
  not macOS or Linux.
- **Both themes.** The xterm palette is made from the existing tokens (`xtermTheme`): the well as background, `--ink` as text,
  `--live` as the cursor, the status tokens as the six ANSI colours, and each bright colour is that colour a quarter of the way to
  `--ink`. ANSI black is dark and white is light in both themes. Every colour a program prints in is 4.5:1 or better on the well,
  checked in verify; the new CSS uses tokens only.
- **Not done.** The project-level Terminal dock (plan D8b) and any terminal outside an agent; shells that survive a daemon restart
  (a restart ends them and the screen is not saved); the plan's headless mirror (a raw 512 KB replay is used, so a full-screen program
  that ran longer than the buffer may redraw only after its next update); WebGL rendering, search, link and clipboard addons; a
  Settings entry for shell, font size or scrollback (13 px and 5,000 lines are fixed); the plan's `terminals` hub frame, so a
  terminal opened in one browser tab shows in another only on its next refresh; **Windows** (dropped). `onBinary` (mouse reports above
  column 223 in legacy mode) is not forwarded. Not looked at: the terminal was driven in headless Chrome (a command, colour, resize,
  reload and replay, a second tab, exit, close, the fallback banner, both themes) but not with `vim`, `htop` or `less`, and not on Ubuntu.
- **Also changed in passing:** `spawn/verify.ts`'s "no drag library" check pinned the whole dependency list; it now expects the two xterm
  packages as well.
- **Known, not from this change:** with `CONDUCTOR_TOKEN` set, `/ws` (and so `/ws/term`) is refused to a browser even with `?token=`
  right, because the `Authorization` header check in `index.ts` also runs on the upgrade and a browser cannot set that header on a
  WebSocket. The terminal behaves exactly as `/ws` does.
**Verified:** `terminal/verify.ts` (84 checks, a real PTY on macOS, `/bin/sh` with a home of its own): the ring, shell choice, environment,
frame parsing and size clamp; with the PTY forced off, GET says `available: false` with the reason, POST is 503, and the runner
still runs a command; echo of a command and its output; `TERM`, `COLORTERM`, and `NO_COLOR` and the token absent; the shell's cwd
and its creation size; `stty size` follows a resize; a frame that is not JSON is ignored; closing the page leaves the shell running and
a new page is replayed what it missed, then goes live; a second page sees the same stream; the replay is at most 512 KB and is the
end of the output; DELETE ends the shell and a foreground `sleep` under it, the page's socket closes 1000, a second DELETE is 404;
unknown id is 404 (DELETE, GET and POST by agent) and 4404 on the socket; `exit 3` closes the socket 1000, stays listed as
exited with code 3, does not count against the cap, and a later page gets its output; 16 open, the 17th is 409, closing one makes
room; a socket with a foreign Origin or `Origin: null` is refused and sees no byte, a local Origin attaches, and a foreign Origin is 403
on GET and POST; removing an agent, a job and a project each end their shells and nothing else's; a page 8 MB behind pauses `yes`
(under 1 MB received) and resumes when it drains; closing the daemon ends a shell and the command under it; and a child daemon with
`CONDUCTOR_TOKEN` set refuses the socket without the right `?token=` and the credential, exactly as `/ws` does. If no PTY loads, the run
prints a `SKIP:` line and checks only the fallback. Web `agent/verify.ts` (the tab mounts `Xterm` when available and the runner
otherwise, the runner is not mounted beside a working terminal, tabs, first-visit open, URL, frames, reconnect delay, close codes, copy
key, palette in both themes at 4.5:1 with sixteen distinct colours, tokens-only CSS, the hotkey guard, the Vite `/ws` proxy, the two pinned
packages) and `spawn/verify.ts`. `vite build` passes.

### Amendment 111 — post-merge, applied. **Pause everything until a time; send a message to an agent at a time.**

Asked 9 Oct: "add an option to pause all activity until a specified date/time (local time zone)" and
"add option to submit requests to an agent at a specified date/time (local time zone)".

**Time.** The browser turns a `datetime-local` value (local, no zone) into an ISO instant
(`web/src/lib/when.ts`), and shows instants back in local time with the zone's short name. The daemon
compares instants and never reads or sets a zone.

**Pause everything.** The setting `conductor.pauseUntil` (`PAUSE_UNTIL_KEY` in shared/wire.ts), an ISO
instant, through `PATCH /api/settings` like any other; its rule refuses what isn't a time or is more than
a year ahead. `session/schedule.ts` watches it.
- **Supervisor.** `#hold`, read as `held`. `pump()` returns at once while held, so nothing queued starts
  by itself. `hold()` sets it and pauses every `working` agent through `pauseAgent(id, HOLD_NOTE)`
  (`pauseAgent` gains the note; ⏸ still sends `'paused by the user'`). `release()` clears it, resumes
  every `paused` agent whose last status note is `HOLD_NOTE` through `resumeAgent` (one at its budget is
  re-paused with the budget's note), and pumps. The note is how the end of a pause knows which agents
  it paused, after a restart too; one you paused yourself stays paused. Blocked agents keep their
  question; `sendMessage` still launches directly, so a message you send gets through.
- **The clock** (`Scheduler`). Looks every 5 s (`SCHEDULE_TICK_MS`, an interval, as the day watch does,
  so sleep and a moved clock don't lose it), on every change to the setting, and once at start. In
  session.ts it starts after `reconcile()` and before `pump()`, and holds at once if the pause is on, so
  nothing queued slips out first. A tick: in the future and not held → `hold()`; not in the future →
  `release()` if held (or on the first tick, so a restart past the time wakes what it paused), and the
  setting is removed once past. Ticks never overlap.
- No alert: a hold note isn't a budget note, so Needs You says nothing.

**Scheduled messages.** Migration `140_scheduled.sql`: `scheduled_messages (id, agent_id → agents ON
DELETE CASCADE, at, text, created_at, error)`. Wire: `ScheduledMessage { id, agentId, at, text,
createdAt, error }`, `ScheduleMessageRequest { at, text }`, `Snapshot.scheduled?`, and the frame
`{ type: 'scheduled', scheduled }` (the whole list, soonest first, after every change).
- **Routes** (`routes/schedule.ts`, new). `GET /api/scheduled`; `POST /api/agents/:agentId/scheduled`
  → 201 `{ message }`, 404 no such agent, 400 no text or longer than 100,000 characters, or a time that
  isn't one, passed more than a minute ago, or more than a year ahead (`timeProblem`); `DELETE
  /api/scheduled/:id` → `{ removed }` or 404. Each broadcasts the list; a POST also ticks.
- **Sending.** On a tick, not while paused, each row with no error and `at` ≤ now goes through
  `Supervisor.sendMessage(agentId, text)`, as if you had pressed send: into a live run, or resuming the
  session. Sent, the row is deleted. "cannot receive messages yet" (no session) leaves it to try again;
  any other refusal (a budget) sets `error` and it is not tried again.
- **Web.** The store keeps `scheduled` from the snapshot and the frame (`useScheduled`). The composer
  gets **⏲ later** beside send, opening `LaterRow` (a local date and time, **in 1 h**, **tomorrow 09:00**,
  **schedule**), which posts what is typed and clears it on success; `ScheduledList` above the box shows
  this agent's, each with when, how long from now, its first line and ✕ (`DELETE`); a failed one shows
  `couldn't send: <reason>` in `--fail`. The status bar gets `PauseAll`: **⏸ pause all…** opens a panel
  (date and time, quick picks, what it will do, **pause until**), and while on reads **⏸ all paused
  until <time> · in …** with **▶ resume now** (removes the setting). Tokens only, no `--need`.
- **Verify:** daemon `session/verify-schedule.ts` (port 7812, 43 checks, fake SDK); web
  `lib/verify-schedule.ts`. Both in `make test`.

### Amendment 110 — post-merge, applied. **Merge any branch into any other, previewed; the composer's settings fold from a chevron header.**

Asked 9 Oct: "collapsing the agent details in the panel for agent input should be like the other areas
you can open/close and not in a dedicated button called settings", and "the Branches should be more
graphical, give me options to merge from a branch to another branch (like main)". Chosen from mock-ups:
the summary row folds; the branch graph with a "merge into" picker.

**Branches.**
- **Wire.** `BranchAction`'s merge gains `into?: string`; absent is the target, so every existing
  caller is unchanged. `BranchActionResult.into?` says where a merge went. New `BranchMergePreview
  { branch, into, ahead, behind, commits, conflicts: string[] | null, reason: string | null }`.
- **Route.** `GET /api/projects/:projectId/branches/preview?branch=&into=` → `BranchMergePreview`. Reads
  only, no lock. 400 for a name starting with `-`, an unknown branch, or merging a branch into itself.
- **Merge into another branch** (`workspace/branches.ts`). `planMerge` does the checks a merge makes
  before it needs a checkout, in the old order (known, not into itself, not live), counting ahead,
  behind and a merge base against `into` (the listing's numbers when `into` is the target).
  `intoCheckout`: the target is `mergeCheckout`, as before; any other branch merges in the worktree it
  is checked out in, refused with 409 when it is checked out nowhere (it is never checked out for the
  occasion), when an agent is working on it, or when its checkout has tracked changes. Then 409
  nothing to merge or unrelated histories, as before. `mergeOne` is unchanged, so the message is
  `Merge branch '<b>' into <into>` and a conflict is aborted the same way. `merge_all` still goes
  into the target only.
- **Preview.** The same `planMerge` and `intoCheckout`, so `reason` is the sentence the POST would
  answer with (`error — detail`). `conflicts` comes from `merge-tree --write-tree --name-only
  --no-messages` (git 2.38): no checkout or index is touched. Exit 1 is a conflict, its paths after
  the tree id; any other failure is `null`, "can't tell", so the merge itself still needs nothing
  newer than 2.30.
- **Screen** (`branches/route.tsx`, `rules.ts`, `graph.tsx`, `endpoints.ts`). The action bar gets
  **merge into** ▾: every other local branch, the target first, starting on the target (the target's
  own bar starts on none, so main can be merged into a job branch). A preview is asked whenever the
  branch, the choice or any branch's head or uncommitted count changes; stale answers are dropped. A
  line under it says the commits that would move, how far the other way, and the conflicts (or that
  this git can't tell), with the first five subjects. `intoReason`: into the target it is
  `mergeReason`; otherwise live on either side, `into` not checked out, then the preview's reason;
  known conflicts refuse in both cases, naming the file count. The button reads **Merge N commits**,
  the confirm names where it goes, and into the target the POST sends no `into`. The graph outlines
  the branch it would go into, dashed, with "⇠ <branch> merges here". The result names `res.into`.
- **Verify:** daemon `workspace/verify-branches.ts` §10 (109 checks in all); web `branches/verify.ts` §7.

**Composer** (`agent/composer.tsx`, `agent/agent.css`, `shell/ui.tsx`, `shell/Navigator.tsx`). The
**settings ▸/▾** button beside Send is gone. The fold is the first thing in the row: a header button
with the navigator's chevron and **agent**; folded, the one-line summary sits inside it, so the
summary is what you click to open. Same setting (`conductor.agentSettings`), same rows hidden, Send
where it was. `Chevron` moves from Navigator.tsx to `shell/ui.tsx` and both use it. Checked by
`agent/verify.ts` §9.

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
    alike, never a reader's for a writer, else Spawn's defaults. The persona's tool rules went
    over it (superseded by Amendment 147: the launch's pills decide, not the persona), a reading
    role or persona is pinned as `toAgentSpecs` pins one, and the cap is its own. Escape closes
    the editor.
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
(§14's shell-and-no-push check is gone under Amendment 147: a Custom architect row now
follows the launch's pills, not the persona's tool rules.)

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

(The tool-rules part of this is superseded by Amendment 147: only a persona's `write: false`
still applies; shell, push, network and MCP are the launch's pills alone.)

Built in three lanes, as planned in `docs/plans/personas-and-nav-order.md`, after a serial
step 0 that fixed the shared contract.

- **Step 0:** `AgentSpec` gains `persona?`, `systemPrompt?` and `skills?`.
  `web/src/spawn/personas.ts` holds `Persona`, `BUILT_IN_PERSONAS` (the eight roles,
  with reviewer, debugger and analyst `write: false`), and the `conductor.personas`
  setting. That setting stores only the edits to built-ins, plus your own personas
  whole, so a later build's built-ins still reach you. The file also has `personasFrom`,
  `withPersona`, `resetPersona`, `withoutPersona`, `newPersonaId`, `personaFor`, `isEdited`
  and `pillsWith` (`pillsWith` removed in Amendment 147).
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
    exact id via `ModelSelect`. (Amendment 147 cut this to one three-way tool rule,
    **write files**; the other four did nothing and are gone from the editor.)
- **Lane C (presets and Custom):**
  - `toAgentSpecs(…, personas?)`: a role's persona (`personaOf`, from `r.persona ?? r.role`;
    `''` means none) gives the spec `persona`, `systemPrompt` and `skills`. Its tool rules
    go over the pills through `pillsWith`, and `write: false` makes the role read-only.
    A persona can't make a reading role write. Without personas, the output is unchanged.
    (Amendment 147: `pillsWith` is gone, and only `write: false` still acts — the launch's
    pills decide the rest.)
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
