# Cleanup plan

State at time of writing (2026-09-26): all three packages typecheck clean, `make test`
passes (exit 0, 558 checks), and nothing since `f60e508` is committed: about 40 modified
files and 9 new ones on `main`.

Every finding below was checked against the running daemon, the live
`packages/daemon/conductor.db`, or the source. None of them is a guess.

---

## Findings

### F1 · The daemon trusts any Host and any Origin — **high**

`packages/daemon/src/index.ts` binds `127.0.0.1`, and the comment calls that "the primary
security boundary". Binding is not enough on its own:

- `curl -H 'Host: attacker.example:7777' http://127.0.0.1:7777/api/snapshot` → **200**.
  With DNS rebinding, any web page you visit can read the full snapshot: projects, paths
  and transcripts.
- The same page can then `POST /api/jobs` with `mode: 'bypassPermissions'`. That lets it
  run shell commands on this machine.
- The WebSocket at `WS_PATH` has no `verifyClient` unless `CONDUCTOR_TOKEN` is set. Any
  origin can subscribe to the live event stream (cross-site WebSocket hijacking).
- `CONDUCTOR_TOKEN` is opt-in and is off in normal use.

**Fix.** Add an `onRequest` hook that allowlists `Host`: `127.0.0.1:PORT` and
`localhost:PORT`. Vite's proxy already rewrites Host with `changeOrigin: true`, so the web
app keeps working. Also allowlist `Origin` when the header is present: `localhost:5173`
and the daemon's own origin. Apply both checks in the WebSocket `verifyClient`. Leave
`/preview/*` alone; it is iframed from the daemon's own origin. Add checks to the smoke
suite: foreign Host → 403, foreign Origin → 403, and no Origin (curl, `scripts/status.mjs`)
→ allowed.

### F2 · The DB path depends on the current directory — **medium**

`openDb(file = process.env.CONDUCTOR_DB ?? 'conductor.db')` opens the file relative to the
cwd. A stray 0-byte `conductor.db` sits at the repo root (Sep 25 14:40); the real one is
`packages/daemon/conductor.db`. If the daemon starts from any other directory, it silently
opens a new empty database, and "Conductor forgot all my projects" looks exactly like
data loss. The Makefile `clean` target already had to work around this.

**Fix.** Resolve the default path against the daemon package directory (`HERE`), not
`process.cwd()`. Log the absolute DB path at startup. Delete the stray root file.

### F3 · Removing a project leaks soft-removed workspace rows — **low**

`WorktreeMgr.remove()` (behind `DELETE /api/workspaces/:jobId`) soft-deletes: it sets
`removed_at` and keeps the row and its `file_changes`. `deleteProject` sweeps
`workspace().list()`, which filters on `removed_at IS NULL`, so those rows are never
collected. The live DB proves it: `job_bd5cbc2d-0be` belongs to project `prj_35b1bbe0`,
which no longer exists, and still has 1 workspace row and 6 `file_changes` rows.

**Fix.** Have `deleteProject` sweep by `project_id` including soft-removed rows, with a
new store method so `list()` keeps its meaning. Run a one-time startup sweep of rows where
`removed_at IS NOT NULL AND job_id NOT IN jobs`.
**Don't** sweep live workspace rows that have no job: the Track C snapshot publishes those
as synthetic jobs on purpose.

### F4 · Web error handling is copy-pasted and parsed with regexes — **low**

`api()` in `lib/feed.ts` folds status and body into one string: `"METHOD /path → STATUS
body"`. Callers then parse it back out, in three different ways:

- `agent/endpoints.ts` `explain()` and `daemonSaid()` use a regex on `→ 409`.
- `files/useWorkspace.ts:68` uses a different regex on `"error":"…"`.
- `files/route.tsx`, `files/FilePane.tsx` and `preview/route.tsx` show the raw
  `err.message`. That is how "is not wired up yet" and "no such project" reached you
  unexplained.

`removeProject` and `ProjectRemoval` are also defined twice, in `spawn/endpoints.ts` and
`fleet/endpoints.ts`.

**Fix.** Give `api()` an `ApiError` class carrying `{status, body, daemonSays}`. Move
`explain()` into `lib/` and use it in every screen. Keep one `removeProject` and have the
other screen import it.

### F5 · Hardcoded colours block the light theme — **low, but blocks T1**

`styles.css:55` hardcodes the top bar as `linear-gradient(180deg, #1a1816, #141211)`, and
`styles.css:76` hardcodes the baton tail as `#8a5a12`. CONTRACT §3 forbids hex outside
tokens. Under a light theme the top bar would stay dark.

**Fix.** Add two tokens, `--top-a`/`--top-b` (or derive the gradient from `--surf` and
`--bg`), and `--need-deep`.

### F9 · Making the composer taller adds empty space, not lines — **medium (you hit this)**

Dragging the Agent screen's resize handle (Amendment 25) sets a pixel height on
`.ag-composer-wrap`. `.ag-composer` stretches to fill it (`flex: 1`, `agent.css:955`),
but it is not a flex container itself. So `.ag-cbox` inside it keeps its natural height,
and so does the textarea, which is fixed by `rows={2}` (`composer.tsx:250`). The extra
height collects as blank space under the last row, and you still type into two lines.

**Fix.** Make `.ag-composer` and `.ag-cbox` flex columns inside the wrap. Give
`.ag-input` `flex: 1` and a two-line minimum, and keep every row below it `flex: none`.
Dragging up then gives the textarea every pixel. Dragging down shrinks the textarea to
two lines before the wrap starts to scroll. Scope the rules to `.ag-composer-wrap` so
nothing else that uses `.ag-composer` changes.

### F10 · A lost connection to the model is invisible — **medium (you hit this)**

At 14:43:21 on 2026-09-26 you sent the Builder (`agt_d67e74e8-b81`) a question. The
screen showed "working" and nothing else for 4 min 40 s. The SDK session log for that run
(`~/.claude/projects/…/114bb186-….jsonl`) shows why: 10 failed attempts, each
`getaddrinfo ENOTFOUND api-ai-us.ssnc-corp.cloud` (DNS or VPN), with retry delays growing
from 0.6 s to 34 s. The 11th attempt got through at 14:48:00. Had it failed too, the run
would have ended as `failed` with no reason a person could act on.

The SDK does report every retry: `SDKAPIRetryMessage` (`type: 'system'`,
`subtype: 'api_retry'`, with `attempt`, `max_retries`, `retry_delay_ms`, `error_status`
and `error`; see `sdk.d.ts:3383`). But `Runner.#onMessage` (`session/runner.ts:415`)
only handles `assistant` and `result`, so every retry is dropped.

**Fix.**
- **Capture.** In `#onMessage`, map `api_retry` to a new `api_retry` event carrying the
  attempt, the retry cap, the delay and the cause. Classify the cause:
  - `unreachable`: `error_status` is null, so there was no HTTP response (DNS, VPN,
    offline).
  - `auth`: `authentication_failed`, `cloud_credential_error` or a 401/403.
  - `throttled`: `rate_limit`, `overloaded`, 429 or 529.
  - `server`: anything else, such as 5xx.
- **Agent screen.** While retrying, the header's current action reads, for example,
  "can't reach the model API — retry 3/10 in 12s", instead of a bare "working".
- **Needs You.** Raise an entry when a human has to act: the cause is `unreachable` or
  `auth`, and it is on at least its 2nd attempt or has been failing for 20 s. A single
  blip must not page anyone (§5.1: `--need` means a human is required). `throttled` and
  `server` stay on the Agent screen only, unless the retries run out.
  - Make it **one entry per outage, not one per agent**. When the VPN drops, every
    running agent fails at once, and five identical cards bury the real questions.
  - The entry names the endpoint when the daemon can read it from `ANTHROPIC_BASE_URL`,
    lists the affected agents, and says what to check ("DNS lookup failed — is the VPN
    up?").
  - It **clears itself** on the next `assistant` message from any affected agent. Nobody
    should have to dismiss a problem that has already gone away.
- **When retries run out.** The agent currently ends as `failed` with a bare
  `terminal_reason`. Keep the entry open, reword it to "gave up after 10 attempts", and
  add a **retry** action that resumes the session through the existing message route. In
  this incident, a message resumed a finished agent without trouble. Confirm the same
  works for a `failed` one.
- **Contract.** Recommended: a new snapshot entity, `Alert { id, kind, cause, endpoint?,
  agentIds, since, attempt, maxRetries }`, rendered at the top of the Needs You queue and
  counted in the top bar's "needs you" badge. **Don't** add it as a new
  `PendingRequest.kind`: a pending request is a tool call waiting for approve or deny,
  with a `requestId`, a `toolName` and a `blockMode`, and an outage has none of those.

**Verify.**
- `session/verify.ts`: feed `#onMessage` synthetic `api_retry` messages, one per cause.
  Check the cause classification, that attempt 1 raises no alert, that attempt 2 raises
  one, that the next `assistant` message clears it, and that two agents failing at once
  share one alert.
- By hand: start the daemon with `ANTHROPIC_BASE_URL=https://conductor-test.invalid` and
  send an agent a message. The Needs You entry should appear within about 20 s. Restore
  the variable and resume; the entry should clear with no click.

### F11 · Default budget is $5 per agent; make it $25 — **requested**

`spawn/route.tsx:364` starts the "⏱ stop each agent after $" field at `'5'`. Your first
real analysis job spent $5.90 answering one question and stopped with
`budget_exhausted`. The job cap is the per-agent figure times the number of agents, so
a 4-agent plan gets a $100 job cap from the new default.

**Fix.** Change the default to `'25'`. Update the check that pins it
(`spawn/verify.ts:185`, `defaults.budgetUsd === 5`) and the mockup pill
(`mockups/conductor.html:1107`, "stop after $5").

### F12 · A budget can't be raised once the agent is running — **requested**

The only place to set a budget is Spawn, before launch. After that, the cap can only be
changed with `curl` against `POST /api/agents/:id/autonomy`. The route already merges a
partial `budgetUsd` over the stored autonomy.

Three things make this worse than it looks:
- **The cap is per message, not per agent.** It becomes the SDK's `maxBudgetUsd`
  (`runner.ts:176`), and the SDK counts only "the spend since this query() call started"
  (`sdk.d.ts`, `total_cost_usd`). Every reply you send gets a fresh $5. "Stop each agent
  after $5" is not what happens.
- **The usage bar compares two different things.** The inspector
  (`inspector.tsx:68`) shows the agent's lifetime spend against that per-message cap. The
  Builder reads "$6.64 of $5 · 133%" and can still be resumed.
- `docs/MANUAL.md:323` ("the daemon pauses the job when it's hit") is also only half true.
  The job cap is checked only in `pump()` (`supervisor.ts:449`), which gates **queued**
  agents. A resumed agent never passes through it.

**Fix.**
- **Make the cap a lifetime cap**, so that the label, the bar and the behaviour all agree.
  `#buildOptions` passes `maxBudgetUsd: cap − agent.costUsd` (the agent's cost is already
  cumulative across resumes). `sendMessage` refuses to resume at or over the cap with a
  sentence, not a failed run: "The Builder has spent $25.10 of its $25 budget — raise it
  to continue."
- **Add a budget control to the Agent screen's bottom panel**, in the guardrails row
  next to the effort pills: "budget $[25] · $6.64 spent". Include one-click **+$10** and
  **+$25** buttons, because raising the cap is the common case. Clearing the field
  removes the cap. The control patches `{ autonomy: { budgetUsd } }` through the existing
  `setAutonomy`, with the same optimistic-draft pattern `pickEffort` uses
  (`composer.tsx:232`), so there's no new route.
- **Out of budget is not broken.** When an agent stops on its cap, show "budget reached"
  in the header with the control in reach, not `--fail` red. Once L8 has landed, raise it
  in Needs You as well: a person has to decide.
- **The job cap follows the agents.** Have `#overBudget` compare against the sum of the
  agents' current caps, not the stored `job.budgetUsd`. Otherwise raising one agent still
  leaves its queued siblings paused at the old total. `Job.budgetUsd` stays in the wire
  as the figure Spawn launched with.

**Verify.**
- `session/verify.ts`: an agent with $20 spent and a $25 cap runs with
  `maxBudgetUsd: 5`. At $25 spent, a message is refused with the sentence and the status
  doesn't change. Raise the cap to $35 and the same message resumes.
- A 2-agent job at $50: raise agent 1 to $40, and its queued sibling still launches.
- In the browser: click **+$10** on a stopped agent, send "continue", and it resumes.
  The inspector bar and the composer field show the same numbers.

### F13 · Errors don't reach Needs You — **requested**

When an agent fails, the only sign is its status turning red wherever you happen to look.
The Agent header shows the SDK's raw reason as the subject (`describe.ts:173`); the live
DB has two, `budget_exhausted` and `blocking_limit`. Needs You, the tab title and the
favicon badge (`attention/always.tsx`) count only `PendingRequest`s, which means
permission prompts and questions. So a failure that happens while you are on another
screen, or another tab, stays silent until you go and look. The job does nothing in the
meantime, because a failed agent can't make progress without you. That is exactly what
Needs You is for.

**Fix.** Use F10's `Alert` entity for failures as well, not only connection loss.

| Raises an alert | Why a person is needed |
|---|---|
| An agent ends `failed`, for any terminal reason except an interrupt, pause or terminate that you asked for | Nothing resumes it except you |
| An agent stops on its budget (F12) | Raise the cap or stop; only you can decide |
| The model API is unreachable, or login fails (F10) | Fix the VPN or the login |
| A dev server goes `down` without anyone stopping it | The preview you may be relying on is gone |

| Does **not** raise one | Why not |
|---|---|
| A tool call that fails inside a run (`tool_end ok: false`) | The agent sees it and deals with it; paging you for a failed `grep` is noise |
| An error from a button you just clicked | It is already shown inline, where you clicked |
| A job going `failed` | It is the rollup of its agents' failures, which already alerted |
| Console errors in the preview pane | They are the app's output, not Conductor's |

- **Say it in a sentence.** Each known terminal reason gets one, for example
  `budget_exhausted` → "spent its $25 budget". An unknown reason shows as itself, followed
  by "— see the transcript". The Agent header uses the same sentence, so the two never
  disagree.
- **Actions.** Every failure entry has **open agent**. Where resuming makes sense it also
  has **continue**, which uses the existing message route, and **raise budget** for F12.
  Every entry has **dismiss**.
- **It outlives a reload.** Derive failure alerts from agent status: a `failed` agent is
  an open alert until it is resumed, removed or dismissed. Then a reload or a daemon
  restart can't lose one. Only the dismissal needs storing. Connection alerts (F10) stay
  in memory, because they describe the present.
- **The notification ladder counts alerts** alongside pending requests: the tab title,
  the favicon badge and the opt-in Web Notification. Failures skip the 60-second wait
  before the sound. They don't age into urgency; they already need you.

**Verify.**
- `session/verify.ts`: the classification tables above, one case per row. A failed
  agent's alert survives a daemon restart and clears when a message resumes the agent.
- In the browser: fail an agent (give it a $0.01 budget), move to Fleet, and check that
  the tab title and the Needs You count go up. **continue** from the entry resumes the
  agent and clears the entry.

### F14 · An agent's model can't be changed after launch — **requested**

The model is chosen at Spawn, per role from the preset or by one job-wide override
(`spawn/route.tsx:367`, `MODELS` in `spawn/presets.ts:30`), and then it's fixed. There's
no route that writes `agents.model`, and the Agent screen doesn't show the model at all
in its bottom panel. To go from opus to sonnet for a cheap follow-up, or up to opus when
sonnet gets stuck, you currently have to spawn a new job and lose the conversation.

Two facts make this cheaper than autonomy was:
- **It can apply to a live run.** The runner uses streaming input (`runner.ts:467`
  pushes onto `#input`), and in that mode the SDK's `Query.setModel()`
  (`sdk.d.ts:2720`) changes the model for subsequent responses. Permission mode and the
  tool lists can't do that, which is why the autonomy route answers
  `appliesTo: 'next run'`.
- **Resuming already reads the stored model.** `#launchWithPrompt` builds the runner from
  `agent.model` (`supervisor.ts:743`), so once the column is written, the next message
  uses it.

**Fix.**
- **Wire:** `POST /api/agents/:id/model` with `SetModelRequest { model }` in
  `shared/src/wire.ts`. Accept the three aliases in `MODELS` and nothing else (400 with a
  sentence otherwise). It answers `{ model, appliesTo: 'now' | 'next run' }`.
- **Daemon:** a `setAgentModel` in `db/`. `Supervisor.setModel(agentId, model)` writes it,
  calls a new `runner.setModel()` when a runner is live (which awaits
  `#query.setModel()`), and broadcasts the agent with `#pushEntities`. The autonomy route
  doesn't broadcast, so without this a second tab would show the old model.
- **Web:** a **model** pill row in the composer's guardrails row, beside the effort pills.
  Import `MODELS` from `spawn/presets.ts` rather than copying it, so the two pickers
  can't drift. Use the same optimistic-draft pattern as `pickEffort`
  (`composer.tsx:232`). The consequence line says "applies to the next reply" or "takes
  effect on the next run", depending on `appliesTo`. The inspector and the Agent header
  show the model too.
- **Say so in the transcript.** Append a synthetic `user_text` ("switched to sonnet"),
  the way `runner.send(text, true)` already marks lines the daemon wrote. A change in
  tone mid-transcript then has a visible cause, and the frozen event union doesn't grow.
- Cost needs nothing: `costUsd` comes from the SDK's `total_cost_usd`, which prices each
  turn at the model that ran it.

**Verify.**
- `session/verify.ts`: setting the model on a stopped agent writes the column and the
  next resume passes it to `query()`. On a live runner it calls `setModel` and answers
  `appliesTo: 'now'`. An unknown model is a 400 with a sentence, and the column is
  unchanged.
- In the browser: switch a running Builder from opus to sonnet. The next assistant
  message's `model` is sonnet in the SDK log, the transcript shows the switch line, and a
  second tab shows the new model without a reload.
- Switch to haiku on a long transcript. If the API refuses because the context is too
  large, that refusal has to reach you as a sentence (and, after L8, an alert). A
  silently failed run is not acceptable.

### F15 · Opening an agent lands at the top of its transcript, not the latest reply — **requested**

The only scroll rule is "follow the stream" (`agent.tsx:270-279`): when a new event
arrives, it scrolls to the bottom **only if you're already within 220px of it**, so that
reading history isn't yanked away from you. That's right while you stay on the page, but
wrong when you arrive. A freshly mounted scroller has `scrollTop = 0`, so a transcript of
any length is more than 220px from its bottom and the rule never fires. You land on the
oldest events and have to scroll down to see what the agent just said. Amendment 27 makes
this happen every time: after a reload the history arrives a moment after mount, with the
scroller still at the top. Switching agents is worse. The scroll container is the same
element for every agent, so the new transcript opens wherever the previous one left the
scroll position.

**Fix.**
- **Arrive at the bottom.** Keep a ref holding the agent id you last landed on. When
  `active` changes, or when that agent's events first become non-empty (history landing
  after mount), set `scrollTop = scrollHeight` and record the id. Use a `useLayoutEffect`,
  so you don't see the top flash before the jump.
- **Then follow as today.** After the landing, the 220px rule stands unchanged.
- **Tell a reader who scrolled up.** When new events arrive while you're scrolled up, show a small
  "↓ latest" pill over the bottom of the transcript. Clicking it jumps down. Without it,
  the follow rule's restraint reads as "nothing is happening".
- Don't remember a scroll position per agent. You come back to an agent to see what it
  did last, and the pinned "what you last told this agent" bar (`agent.tsx:40`) already
  gets you back to your own message.

**Verify.**
- Pull the decision into a pure `scrollIntent({ landedOn, agentId, eventCount,
  fromBottom })` → `'jump' | 'follow' | 'stay'` and test it in `agent/verify.ts`: a new
  agent jumps, history landing after an empty mount jumps, a later event within 220px
  follows, and one further up stays.
- In the browser: open the Builder, and it shows the latest reply. Reload the Agent page,
  and once the history loads it's at the bottom. Switch to another agent and back, and
  both land at the bottom. Scroll up while the agent works, and the pill appears and the
  page doesn't move.

### F16 · File names in a transcript aren't links to the Files screen — **requested**

Files already has a deep link, `navigate('files', { jobId, path })` (Amendment 3,
`files/route.tsx:81`), but nothing in the transcript uses it. `openFiles()`
(`shell/nav.ts:79`) doesn't even take a path. File names show up in three places, and all
three are dead text:
- **Tool rows.** `read`, `edit` and `write` show `file_path` as their subject
  (`transcript.tsx:282`), and so does the `+N −M` row of an edit.
- **The agent's prose.** The paths it names are inline code
  (`` `../README.md` ``, `` `…/authz-openapi-v1.yaml` ``), rendered as a bare `<code>`
  (`markdown.tsx:92`).
- **Markdown links.** `[x](src/a.ts)` stays as raw text, because `safeHref` allows only
  `http(s)` (`markdown.tsx:75`).

**The catch is the path.** Tool inputs carry **absolute** paths, and Files takes a path
**relative to the job's worktree**. The daemon rejects absolute paths and anything that
resolves outside the worktree (`workspace/paths.ts`, escapes 1 and 2), and that's a
security boundary, not an oversight. Plenty of what agents name really is outside it. In
the live DB, the Builder read files under `~/.claude/projects/…/memory/`, and its reply
names a file in a different repo (`gcp-platform-authorization/authz-openapi-v1.yaml`).

**Fix.**
- **One resolver:** `linkablePath(raw, worktreePath) → string | null`.
  - Strip a trailing `:line` or `:line:col`. The Files pane has no line anchor.
  - An absolute path under `worktreePath + '/'` becomes relative. The `+ '/'` guards
    against `/wt/job-evil`, the same trap the daemon guards against.
  - A relative path is taken as relative to the worktree, since agents run there.
    `..` segments that climb out, or anything else, give `null`.
  - Do **not** widen the daemon's rule to make more paths clickable.
- **Tool rows** link whenever the resolver returns a path. The tool really did touch it.
  The link targets the file name, not the whole row, because the row still expands or
  collapses.
- **Prose code spans and relative markdown links** link only when the path is in the job's tree
  (the same `/api/jobs/:id/tree` Files already fetches, one request per job). Code spans
  that merely look like files (`` `${name}.png.part` ``, elided `` `…-stage-gates.md` ``)
  must not become broken links. Pass a `linkFile(raw) → href | null` callback into
  `renderMarkdown`, so the renderer stays pure and testable.
- **Real anchors.** Render `<a href="#files?jobId=…&path=…">` rather than an `onClick`.
  Build it with an exported `hrefFor(screenId, params)`, factored out of `navigate()`
  (`lib/nav.ts:30`), so the two can't disagree about the format. Then Cmd-click opens a
  new tab for free, and Back returns to the agent (at the bottom, thanks to F15). Add a
  `path` argument to `openFiles()` for callers that aren't links.
- **Outside the worktree:** leave it as plain text, with a `title` saying "outside this
  job's worktree", so it's clear why that one isn't clickable.

**Verify.**
- `agent/verify.ts`, for `linkablePath`:
  - an absolute path inside the worktree becomes relative;
  - an absolute path outside gives `null`;
  - the `/wt/job-evil` prefix gives `null`;
  - `../` climbing out gives `null`;
  - `src/a.ts:42` becomes `src/a.ts`;
  - a Windows-style or `~` path gives `null`.
- Also in `agent/verify.ts`: a code span that names a file in the tree renders an `<a>`,
  and one that doesn't renders `<code>` only. This goes next to the existing
  `renderToStaticMarkup` escaping checks, because an `href` built from model output is
  exactly what those checks exist for.
- In the browser: click the file on an Edit row, and Files opens with that file selected.
  Press Back, and you're on the agent at the latest reply. Hover a path outside the
  worktree to see why it isn't a link.

### F17 · The Files tree is a fixed 268px wide — **requested**

`.c5-col` is `width: 268px; flex: none` (`files/files.css:27`), and tree rows truncate
with an ellipsis (`.c5-name`, `files.css:153`). In a nested repo, or with long document
names like this project's `…-and-stage-gates.md`, the part of the name that tells files
apart is the part cut off. There's no way to widen it. The one resizable panel in the app
is the composer's height (Amendment 25, `agent.tsx:237` `startResize` and the
`.ag-resize` handle), and it only works vertically.

The project rail on the far left (`.sh-rail`, `--rail: 60px`) isn't part of this. It
holds initials, not names, so more width wouldn't show anything new.

**Fix.**
- **One splitter component, not a second copy.** Build new `shell/Splitter.tsx` from the
  composer's handle, taking an axis:
  - pointer capture, so a fast drag doesn't lose the handle;
  - arrow keys move it 24px, for keyboard parity;
  - the same 7px handle with a 1px line that turns `--live` on hover and focus.

  Move the composer onto it **after L10 merges**, since L10 is in `agent.tsx`. Until
  then, two copies is the smaller risk.
- **Files uses it horizontally.** The handle sits between `.c5-col` and the file pane in
  `files/route.tsx` and replaces the column's `border-right`.
  - Width: default 268px, clamped between 180px and 60% of the screen. Re-clamp on
    window resize, so a width saved on a big monitor can't squeeze the file pane on a
    laptop.
  - Double-click the handle to go back to 268px.
- **Persist it** in `localStorage`, the way the composer height is (`COMPOSER_KEY`). The
  screen remounts on every navigation, and F16 is about to send you there a lot more
  often.
- **Accessibility:** `role="separator"`, `aria-orientation="vertical"` (the line is
  vertical even though the drag is horizontal), and `aria-valuenow`, `aria-valuemin` and
  `aria-valuemax`. ARIA requires the values on a separator that can take focus.

**Verify.**
- A check for the clamp in `lib/verify.ts`: below the minimum, above 60%, and a stored
  width wider than the current window.
- In the browser:
  - drag the tree wider, and long names stop truncating;
  - reload, and the width is kept;
  - Tab to the handle, and the arrows move it;
  - narrow the window, and the file pane keeps its room;
  - double-click to reset.

### F18 · The Agent screen's inspector can't be hidden — **requested**

The right-hand inspector (`agent/inspector.tsx`: Agent, Usage, Todo, Files touched,
Guardrails) is always rendered (`agent.tsx:419`) at a fixed 246px (`.ag-insp`,
`agent.css:851`). Nothing turns it off.

**Hiding it alone gains nothing on most screens.** The transcript is capped at
`max-width: 780px` (`.ag-trans`, `agent.css:18`), and so is the pinned last-ask bar
(`agent.css:262`). On a 1440px laptop the pane is already wider than that with the
inspector showing, so hiding it would just add 246px of blank margin. It only helps once
the transcript can use the room.

**Fix.**
- **A toggle in the pane header**, in `fl-panehead-r` next to **⤓ export**. It reads
  "details ⇥" while the panel is shown and "⇤ details" while it's hidden, so it names the
  panel instead of being a bare chevron. When hidden, the inspector is unmounted, not
  `display: none`. It derives everything from the store, so bringing it back costs
  nothing.
- **Hotkey `i`,** handled on the Agent screen with the same guards as the global screen
  keys (`main.tsx:119`: no modifier, and not while typing in an input or textarea). No
  letter keys are taken yet; the screens use digits.
- **Persist it** in `localStorage`, the way the composer height is (`COMPOSER_KEY`),
  because the screen remounts on every navigation. It starts shown. Don't auto-hide it by
  window width: a panel that vanishes by itself looks like a bug.
- **Let the transcript use the space.** Lift the 780px cap on `.ag-trans` and on the
  last-ask bar. Keep prose readable by capping paragraphs and list items at about `80ch`
  instead. Code blocks, diffs, and tool detail are what want width; long prose lines
  don't.
- Nothing essential is lost with it hidden. Since L9, spend, budget and model are all in
  the composer, and status and elapsed time are in the header.

**Verify.** In the browser:
- hide it, and the transcript's code blocks and diffs widen while prose stays about
  80ch;
- reload, and it stays hidden;
- `i` toggles it, but typing `i` in the composer doesn't;
- the button's label always says which state you'll get;
- on a narrow window, hiding it gives the transcript the room.

### F19 · Below about 1250px the top bar's status text runs over the screen tabs — **low**

Found while testing F17 in a 1000px window. `.sh-alert` is `flex: 1; min-width: 0`
(`shell/shell.css:81`), so it shrinks as the window narrows. But it has no `overflow`,
and its right-hand note (`.sh-alert.is-clear em`, "every agent is running
unattended") is `white-space: nowrap`. So the text keeps its 342px and paints across
Fleet, Project and Agent. At 1440px it fits. By 1200px it's 87px too wide, and at
1000px the tab labels can't be read. The "nothing needs you" label also wraps onto
three lines inside a 52px bar.

**Fix.** `overflow: hidden` on `.sh-alert`, and `white-space: nowrap` with an ellipsis
on its label. The note is the part to lose first: it only says what the dot already
says. Hide it with a container query on `.sh-alert`, not a guessed viewport width,
because what decides whether it fits is how many alerts are showing.

**Verify.** Step the window from 1440px down to 1000px, with nothing needing you and
then with a blocked agent. The tabs stay readable, and the badge count never
truncates.

### F20 · A failure the SDK explains is shown as "see the transcript", with nothing in it — **low**

Found while testing L8. A failed `result` message carries the SDK's own explanation in
`errors: string[]` (`SDKResultError`, `sdk.d.ts:5383`). `runner.ts` reads the
`result`'s subtype, `terminal_reason`, `is_error` and usage (about line 460), but never
`errors`. When there's no `terminal_reason` either, the supervisor records the
failure as the bare reason `'error'` (`supervisor.ts:691`). Needs You and the Agent
header then say "ended with an error — see the transcript", and the transcript has
nothing to see.

It happened to the scratch pinger (`agt_99e3b097-495`). It was resumed under a different
`CLAUDE_CONFIG_DIR` from the one its session was saved in, so the SDK couldn't find the
session file. Its last four events are `status working`, the synthetic "Continue…",
a zero `usage`, and `status failed` with the reason `'error'`. There's no text between
them. The SDK knew why it had failed; conductor didn't keep it.

**Fix.** When a `result` has `is_error` and a non-empty `errors`, carry them, one line
each, on the failed status event, in a new optional `detail` field (Amendment 28). The
first plan was to emit them as a `text` event. That was dropped: `text` is the
assistant's prose, and the SDK's words would have read as the agent's own. `error` stays
the code that the sentences, the alert ids and the alert causes key on. The transcript
note reads "failed — ‹detail›", or "failed — ‹code›: ‹detail›" when there is a code. The
failed alert copies the detail, and its card shows it as "sdk said". Don't make up a
sentence for it: the SDK's own words are more use than a guess.

The same fix covers a launch or resume that throws before the SDK answers. The resume
catch recorded no reason at all. The launch catch wrote two failed statuses, the thrown
error and then `launch_failed`. Needs You reads only the last one, so the error was
never shown there. Now each writes one status, with what was thrown as its `detail`.

**Verify.** `session/verify.ts` §13 covers four cases:

- a result with `errors: ['No conversation found…']` gives a status and an alert with
  that detail;
- a resume whose `query()` throws gives one status carrying what was thrown;
- a launch whose `query()` throws does the same;
- the stack lines are cut off.

`agent/verify.ts` checks the three forms of the note. Every check fails with its fix
reverted. Then by hand, resume an agent whose session file is gone, and the transcript
says why.

### F6 · Dead and stale code — **hygiene**

- `packages/daemon/src/session/spike.ts` (753 lines) says of itself: "THROWAWAY… Delete
  after Track A lands." ~~Delete the file and the `spike` script.~~ **Kept, with its
  header corrected.** The README's Verify section keeps it as runnable evidence, and
  `arbiter/index.ts` cites its measurements, so the header was the stale part rather
  than the file. It is the check to re-run after an SDK upgrade.
- The five `.claude/worktrees/track-*` worktrees each have 0 unmerged commits and 0 dirty
  files. Remove them with `git worktree remove` and delete the `track/*` branches. **Ask
  first**, since this deletes directories.
- Delete the root `conductor.db` (F2).

### F7 · Test gaps

- `packages/web/src/attention/` has no verify suite. `aging.ts`, `decisions.ts`,
  `describe.ts` and `interaction.ts` are pure and belong in `make test`, like the spawn
  and agent suites.
- None of F1–F3 has a regression check. Each fix lands with one, and each check must be
  confirmed to fail with the fix reverted.

### F8 · Needs a decision, not a fix

- **Event log retention.** *Decided: keep them, plus a cleanup button in Diagnostics (Amendment 36).* 542 of the 585 events in the live DB belong to agents that
  were removed. That is deliberate (`session/store.ts:143`), and replay is cursor-based,
  so nothing is slow today. But the table only grows. Options: keep everything (the
  current rule), drop events on removal, or keep them with a size cap. My recommendation
  is to keep the current rule and revisit when the table is large enough to matter.
- **Token on by default.** *Decided: it stays opt-in.* Once F1 is fixed, a token adds little for a local-only tool. My
  recommendation is to leave it opt-in, as PLAN.md I5 intends.

---

## Execution

Lanes are split by **file ownership** so they cannot conflict. Lanes in the same wave run
in parallel, for example as worktree-isolated agents with one lane each.

### Wave 0 — serial, before anything else

| Step | What | Why first |
|---|---|---|
| 0.1 | Commit the current uncommitted work as a checkpoint | Cleanup diffs should be reviewable on their own, not mixed into 5k lines of feature work |
| 0.2 | Answer F6 worktree removal and F8 | Decisions shouldn't block lanes halfway through |

### Wave 1 — parallel

| Lane | Findings | Files owned (only this lane touches them) | Verify |
|---|---|---|---|
| **L1 security** | F1 | `daemon/src/index.ts`, `daemon/src/smoke.ts` | smoke: foreign Host/Origin → 403, WS refused, no-Origin allowed |
| **L2 data** | F2, F3 | `daemon/src/db/index.ts`, `workspace/store.ts`, `workspace/service.ts`, `session/supervisor.ts` (`deleteProject` only) | `session/verify.ts` §4: remove project with a soft-removed workspace → rows gone; startup sweep keeps a live job-less workspace |
| **L3 web errors** | F4 | `web/src/lib/feed.ts`, new `web/src/lib/errors.ts`, `*/endpoints.ts`, `files/*.ts(x)`, `preview/route.tsx` | new checks in `lib/verify.ts`: 409 → warn with the daemon's sentence, 404 → the daemon's sentence, non-JSON body → fallback |
| **L4 hygiene** | F6 | `session/spike.ts`, `daemon/package.json`, root `conductor.db`, worktrees | `make test` still green; `git worktree list` shows only `main` |
| **L5 tests** | F7 (attention) | new `web/src/attention/verify.ts`, `Makefile` `test:` line | suite runs in `make test` |
| **L6 tokens** | F5 | `web/src/styles.css`, `shared/src/tokens.css` | `grep '#[0-9a-f]\{3,6\}' packages/web/src/**/*.css` finds nothing |
| **L7 composer** | F9 | `web/src/agent/agent.css` (composer rules only) | in the browser: drag up → the textarea gains lines and nothing is blank below the last row; drag down → the textarea stops at 2 lines, then the wrap scrolls |

Conflict notes:
- L4 and L5 both touch config files (`package.json` and `Makefile`), but different ones.
- L2 edits only `deleteProject` in `supervisor.ts`. Nothing else in this wave touches
  that file.
- L6 and L7 are both CSS, but in different files (`styles.css`/`tokens.css` versus
  `agent.css`).

### Wave 2 — after L6 (and after L3, so the theme toggle's errors go through the new path)

| Lane | What | Files |
|---|---|---|
| **T1 light/dark theme** | The pending request. Add a `[data-theme='light']` token block, following `prefers-color-scheme` by default, plus a toggle in the shell stored in `localStorage`. Darken `--live` and `--need` for light backgrounds: they are 3.88:1 and 4.41:1 today and need ≥ 4.5:1 for AA. | `shared/src/tokens.css`, `shell/shell.tsx`, `shell/shell.css` |

Verify: add a contrast check to `lib/verify.ts` that computes the ratio of every
text/background token pair, for both themes, against 4.5:1.

| Lane | What | Files |
|---|---|---|
| **L9 budget + model** | F11, F12, F14. One lane, because F12 and F14 both add a control to the composer's guardrails row and a pass-through in `runner.ts` and `supervisor.ts`. Runs in parallel with T1, which touches only tokens and the shell. Not in Wave 1, because L2 owns `supervisor.ts` there. | `spawn/route.tsx` (default only), `spawn/verify.ts`, `mockups/conductor.html` (the pill), `agent/composer.tsx`, `agent/agent.css` (budget and model controls only), `agent/endpoints.ts` (`setModel`), `agent/inspector.tsx`, `agent/agent.tsx` (header state), `shared/src/wire.ts` (`SetModelRequest`), `routes/session.ts` (the model route), `db/` (`setAgentModel`), `session/runner.ts` (`#buildOptions`, new `setModel`), `session/supervisor.ts` (`sendMessage`, `#overBudget`, new `setModel`) |

Verify: the F11, F12 and F14 checks, plus `make test`.

| Lane | What | Files |
|---|---|---|
| **L10 agent screen** | F15, F16. Both are the Agent screen's transcript. Starts **after L9 merges**, because both lanes edit `agent/agent.tsx` and `agent/agent.css`. Runs in parallel with L8, which touches neither. | `agent/agent.tsx` (the follow effect only), `agent/agent.css` (the "↓ latest" pill, link style), `agent/transcript.tsx` (tool-row subject), `agent/markdown.tsx` (code spans, `safeHref`), new `agent/links.ts` (`linkablePath`), `agent/verify.ts`, `lib/nav.ts` (`hrefFor`), `shell/nav.ts` (`openFiles` path) |

Verify: the F15 and F16 checks, plus `make test`.

| Lane | What | Files |
|---|---|---|
| **L11 files width** | F17. Runs in parallel with L8 and L10: neither touches `files/`, and `Splitter.tsx` is new. Moving the composer onto the splitter waits until L10 has merged. | new `shell/Splitter.tsx`, `shell/ui.css` (its styles), `files/route.tsx` (the handle), new `files/width.ts` (the clamp, apart so Node can test it), `files/files.css` (`.c5-col`), `lib/verify.ts` (the clamp check), `agent/agent.tsx` and `agent/agent.css` (the composer onto the splitter, once L10 had merged) |

Verify: the F17 checks, plus `make test`.

| Lane | What | Files |
|---|---|---|
| **L12 inspector toggle** | F18. Starts **after L10 merges**, because both lanes edit `agent/agent.tsx` and `agent/agent.css`. If L10 hasn't started yet, fold F18 into L10 instead: it's the same screen and the same files. | `agent/agent.tsx` (header button, `i` key, render condition), `agent/agent.css` (`.ag-trans` and last-ask caps, prose `80ch`) |

Verify: the F18 checks, plus `make test`.

| Lane | What | Files |
|---|---|---|
| **L8 alerts** | F10, F13, F19. One lane, because F10 and F13 are the same `Alert` entity: F10 adds the connection causes, and F13 adds failures, budget stops and dev servers that went down. F19 is the top bar's `.sh-alert`, the element L8 puts more into, so it's fixed and tested here. Starts **after T1 and L9 merge**. T1 and L8 both edit `shell/shell.tsx`: T1 adds the toggle, and L8 adds alerts to the "needs you" badge count. L9 and L8 both edit `runner.ts` and `supervisor.ts`, and L8 reuses L9's "budget reached" state for its Needs You entry. It also comes after L3, so the retry action reports errors through the new path. | `shared/src/events.ts`, `shared/src/wire.ts`, `session/runner.ts` (`#onMessage` only), new `session/alerts.ts`, `session/supervisor.ts` (end-of-run handling only), `routes/session.ts` (alert dismiss), a `db/migrations` file (dismissals), `preview/registry.ts` (unexpected `down` only), `web/src/lib/store.ts`, `shell/describe.ts` (the failure sentences), new `attention/AlertCard.tsx`, `attention/route.tsx`, `attention/always.tsx`, `attention/notify.ts`, `shell/shell.tsx`, `shell/shell.css` (`.sh-alert`, F19) |

Verify: the F10 and F13 checks.

| Lane | What | Files |
|---|---|---|
| **L13 SDK errors** | F20. Starts **after L8 merges**, because both edit `runner.ts`'s `result` handling and the failure sentence L8 wrote. Small enough to run alongside Wave 3's docs. | `session/runner.ts` (`result` only), `session/supervisor.ts` (`#settle` and the launch and resume catches), `session/alerts.ts`, `session/verify.ts`, `shared/src/events.ts` and `wire.ts` (`detail`), `web/src/agent/transcript.tsx` (the note), `web/src/attention/AlertCard.tsx` |

Verify: the F20 check, plus `make test`.

### Wave 3 — serial, last

| Step | What |
|---|---|
| 3.1 | CONTRACT.md §9 amendments for F1 (the Host/Origin rule becomes contract), F2 (DB location), T1, F10 (the `api_retry` event and the `Alert` entity, and that a reconnect resends the pending, servers and alerts lists, which the log doesn't carry), F12 (a budget is a lifetime cap per agent, and the job cap is the sum of its agents' caps) and F14 (the model route, and that a model change applies to a live run) and F20 (the status event's optional `detail`, and the failed alert's copy of it). **Check the top amendment number first**, since you add amendments too (27 is taken). |
| 3.2 | `docs/MANUAL.md`: theme toggle, where the DB lives, and what the alert entries in Needs You mean (lost connection, failed agent, budget reached, dev server down), budgets (the $25 default, raising a budget from the Agent screen, and correcting line 323), and changing an agent's model from the Agent screen, and that file names in a transcript open in Files (and why a path outside the worktree doesn't), and that the Files tree can be dragged wider, and that `i` or the header button hides the Agent inspector. PLAN.md §11: record the F8 decisions. |
| 3.3 | Full `make test`, `make restart`, click through each screen in both themes, then commit per lane. |

### Deliberately not in this plan

- Splitting large files (`supervisor.ts` at 968 lines, `spawn/route.tsx` at 862). They are
  large but coherent, and splitting them now would conflict with every lane above.
- The feature offers from earlier (per-role model override at Spawn, a review/revoke UI
  for allow-always rules). They are features, not cleanup. Changing an agent's model
  after launch was one of these, and is now F14 because you asked for it.
