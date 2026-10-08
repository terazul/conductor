# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 95 has been cleared;
the last of it on 8 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 101.
- Open items are `- [ ]`. A question that needs the user's answer before building is under
  **Decide:**, and the answer goes beside it in italics, as *Decided (date): …*.
- Later, not planned: a real terminal (xterm.js). The terminal is a command runner on the
  Agent screen today (Amendment 58).

## Stacks: handing off from one agent to the next

Do these first. Found (7 Oct) on a five-agent stack (`job_394bb67f-40d`, prompt "No actions
yet, wait for us"). The architect replied "I'll wait" and was marked **done**. That started
the developer, which found no plan and was marked done, then the validator, reviewer and
scribe the same way: the whole stack ended in 62 seconds (events 5236–5289). When the user
answered the architect at 19:40, only the architect ran again.
Why: an agent's turn ending with no error, nothing open and no helpers is marked `done`
(`#settle`, `packages/daemon/src/session/supervisor.ts:951-1026`, done at `:1018`). The
scheduler starts an agent once every dependency is `done` (`pump` and `#depsSatisfied`,
`supervisor.ts:708-748`). Replying to a finished agent resumes only that agent (`sendMessage`,
`supervisor.ts:1209-1235`). The handoff is the upstream agent's last text, sent once in the
first prompt (`#promptFor`, `supervisor.ts:809-828`; `handoff.ts:8-18`).
*Decided (7 Oct): the `hand_off` tool, the question tool and re-run from here, in that
order. Not chosen: guessing from the reply whether it waits (wrong in both directions),
automatic re-runs on every reply (cost and overwritten work), and a per-job "hand off
automatically or ask me" setting (the `hand_off` item makes it unnecessary).*
*Decided (8 Oct): first, choose who each agent waits for, and pass the whole context. The
five items below run in this order.*
*Decided (8 Oct, later): the question-tool item is one line, so it goes first. The rest keep
the order above.*

- [ ] **Pass the whole context of the agent before, not its last reply.** Asked for (8 Oct).
  The next agent should get everything the agent before it knew, so it knows what to do.
  - **Today it gets the last reply only.** That's the agent's last text, sent once in the
    first prompt and cut at 8,000 characters (`#promptFor`,
    `packages/daemon/src/session/supervisor.ts:809-828`; `handoff.ts:8-18`;
    `eventlog.ts:135-144`). Your stack above handed on "I'll wait" and nothing else.
  - **The whole context is already kept.** It's in two places: the event log has every
    message, reply and tool call per agent (`forAgent`, `eventlog.ts:116-123`), and a Claude
    session can be read back or forked (`getSessionMessages` and `forkSession`,
    `session/backends/claude.ts:79-80`; already used at `claude.ts:709`, Amendment 30).
  Decide how:
  - **As text:** the agent's whole conversation (your messages, its replies, a line per tool
    call). Works across Claude, Copilot and OpenRouter, and for an agent waiting on several
    (the reviewer waits on three, `presets.ts:85`).
  - **As a forked session:** the next agent starts inside the previous agent's session. That
    is the most complete, but it works only from Claude to Claude, and only from one agent.
  - **Size:** a whole context can be bigger than the next model's window, and every agent
    after it pays for those tokens. Decide the limit (the next model's window, less room to
    work), and what goes first when over (oldest first, keeping the last reply whole).
  With the `hand_off` item, the agent's summary goes on top of the context.
  *Decided (8 Oct): as text, not a forked session. Your messages, the agent's replies and one
  line per tool call, with tool output left out. The `hand_off` summary goes on top. The cap
  is about a quarter of the next model's window; when over, drop the oldest first and keep
  the last reply whole. The job instruction stays at the top of the prompt and is not part of
  the cap (`#promptFor` already puts it first).*

- [ ] **An agent hands off only by saying so: a `hand_off` tool.** Asked for (7 Oct). An
  agent that other agents wait on hands off by calling `hand_off`, with a `summary` of what
  the next agents need. Ending its turn without calling it doesn't start them. Instead the
  agent goes to Needs You as "stopped without handing off", with **hand off** and the reply
  box. Your stack above would have stopped there after the architect.
  - **The tool.** Add it to `MCP_TOOLS` in `packages/daemon/src/routes/helpers.ts`, beside
    `start_helper`. Claude gets it over the per-agent MCP endpoint
    (`session/backends/claude.ts:128`), and Copilot and OpenRouter in-process
    (`backends/copilot.ts:387-413`). Both capability rows already have `helperTools: true`
    (`backends/index.ts:28`, `:41`). Today the tools go only to orchestrators (`helperCap ?`
    at `claude.ts:194` and `copilot.ts:387`). Give `hand_off` to every agent with an agent
    waiting on it. The last agent in a chain doesn't get it, and finishes as it does now.
  - **The hold.** In `#settle`, before `done` (`supervisor.ts:1018`): if an agent waits on
    this one and `hand_off` wasn't called this run, hold it instead. Keep the hold across a
    daemon restart. The alerts table (`db/migrations/040_alerts.sql`) is the likely home, with
    a new `AlertKind` (`packages/shared/src/wire.ts`), as Amendment 85 added one.
  - **The handoff.** The next agents get the `summary`, on top of the whole context from the
    item above.
  - **Needs You.** The new alert and its **hand off** button: `attention/alerts.ts`,
    `AlertCard.tsx`, `attention/describe.ts`.
  Decide:
  - whether the hold is an agent status (for example `ready`) or only an alert beside `done`.
  - whether the button lets you edit the summary before it goes.
  Tests in `session/verify.ts`: a turn that ends without `hand_off` holds, and its dependants
  stay queued; `hand_off` then the end of the turn starts them with the summary; the last
  agent still finishes `done`; the hold survives a restart.
  *Decided (8 Oct): build it as described. The hold is an alert beside `done`, not a new
  status, and you can edit the summary before it goes.*

- [ ] **Re-run from here.** Asked for (7 Oct). A button on an agent in a stack: start the
  agents after it again with its latest reply, once you've changed what it said. It's
  manual on purpose, so a conversation with the architect doesn't re-run the whole stack on
  every message. Start at `sendMessage` (`supervisor.ts:1209-1235`) and `pump`
  (`supervisor.ts:708-731`).
  Decide:
  - whether the agents re-run fresh, or resume their own sessions with a note that the input
    changed.
  - what happens to work they already did in the worktree.
  - what happens to an agent after it that is still running: stop it, or wait for it.
  *Decided (8 Oct): build it. The agents resume their own sessions with a note that their
  input changed. Work already done in the worktree is left alone, so the agent sees it and
  fixes it. An agent after it that is still running is stopped first, since its input is now
  stale.*

- [ ] **Orchestrated stacks: one agent runs the others.** Asked for (8 Oct), as a design
  question. A new kind of stack you pick in Spawn, beside the fixed ones. An orchestrator
  starts each agent, reads what it did, decides when the step is ready, and writes the next
  agent's brief in full. It can send work back (start the developer again after a failed
  review) and asks you when unsure. It answers the same problem as the items above: a stop
  isn't "ready", and the next agent gets only a last reply.
  - **Built on the orchestrator and helpers (Amendment 51).** An agent given **+ up to N
    helpers** gets `start_helper` and `list_helpers` (`MCP_TOOLS`,
    `packages/daemon/src/routes/helpers.ts:24-44`). It ends its turn, waits, and is woken with
    each helper's reply (`#awaitHelpers`, `session/supervisor.ts:1095`; `helperReport`,
    `session/handoff.ts:91-97`). This works on Claude, Copilot and OpenRouter.
  - **What's missing:**
    - **Role-aware helpers.** Every helper runs on "your model and permissions"
      (`helpers.ts:28`; `startHelper`, `supervisor.ts:1036`), with no role or persona. A
      reviewer started this way can edit files, and a scribe can't be put on a cheaper model.
      `start_helper` should take a role or persona and a model tier, and a reading role should
      stay read-only (`readOnlyRefusal`, `packages/shared/src/stack.ts:136`).
    - **A pipeline prompt.** `orchestratorSection` is written for parallel work: "split the
      work into parts that can run in parallel without touching the same files"
      (`handoff.ts:69-79`). A pipeline needs the opposite. Run the steps in order, read each
      result before the next, ask the user with the question tool when unsure, and send work
      back when a review fails.
    - **A preset.** "orchestrated pipeline": one orchestrator row, with the roles it may start
      listed (`spawn/presets.ts`).
  - **Trade-offs against a fixed stack with `hand_off`:**

    | | fixed stack with `hand_off` | orchestrated |
    |---|---|---|
    | Order | fixed, shown in Spawn before launch | decided while it runs |
    | Who judges a step ready | each agent judges its own | one agent judges all |
    | Context for the next agent | the agent's own summary | a full brief the orchestrator writes |
    | Loops (review, then fix) | no | yes |
    | Cost | lowest | higher: the orchestrator re-reads its growing conversation each time it wakes, and wants a strong model |
    | Failure | one agent's misjudgement | the orchestrator's misjudgement carries through every step |

    Keep both. `hand_off` stays for plain stacks.
  - **To try it today, with no change:** in Spawn's **custom…**, one row named
    `orchestrator` with the architect persona and **+ up to 4 helpers**, and the steps in its
    brief (plan; then a helper to implement it; then one to review; then one to document; each
    waiting for the last). Every helper has its model and permissions, so the "reviewer" can
    still write.
  Decide:
  - whether an orchestrated stack lists its roles before launch (which roles it may start, and
    on which models), or leaves them all to the orchestrator.
  - how many times it may send work back before it asks you.
  - whether its helpers also get `hand_off`, or its own judgement replaces it.
  *Decided (8 Oct): the orchestrator row looks different from the others wherever agents
  are shown (Spawn, its Fleet lane, the agent tabs). It appears only when the stack has two
  or more agents; one agent needs no orchestrator.*

## Files

- [ ] **Create a new file while browsing directories.** Asked for (8 Oct). From the file tree,
  make a new file, such as a `.md` or `.txt`, in the folder you're looking at, and start
  writing in it.
  - **The daemon can already do it.** `PUT /api/jobs/:jobId/file` and
    `PUT /api/projects/:projectId/dir/file?dir=…` (`routes/workspace.ts:161`, `:244`) take
    `{ path, content }`, make any missing folders and write atomically (`writeOf`,
    `workspace/service.ts`). So a path that doesn't exist becomes a file. The path gate still
    applies: no `..`, no absolute path, nothing under `.git` (`workspace/paths.ts`). No new
    route is needed for the plain case.
  - **But it overwrites.** Typing the name of a file that exists replaces it with an empty
    one. `WriteFileRequest` (`shared/src/wire.ts:404`) has no "only if new". Either the web
    checks the tree first, which races with an agent writing the same name, or an optional
    field such as `createOnly` makes the daemon answer 409. That is an additive wire change,
    so it needs an amendment.
  - **The web has the call but not the control.** `writeFile` (`files/useWorkspace.ts:376`)
    already reaches either route from a root key, a job or a project folder. `FileTree.tsx` has
    nothing that creates. A **+** on a folder row, and on the root, would ask for a name with
    the folder already filled in. The tree is drawn at `files/route.tsx:614`.
  - **A project folder's tree won't refresh by itself.** It is never watched, so a write there
    emits no `file_edit`, and the screen re-reads only what it saved (`writeOf`'s comment). Call
    `refreshRoot(root)` (`useWorkspace.ts:43`) after the write. In a job's worktree the watcher
    does it, and the file belongs to no agent, as with any human edit.
  - **Then open it, ready to type.** Open the new file in a tab and start the editor on it
    (`putEdit`, `files/useTabs.ts`). An empty file has to open; check that an empty `raw`
    renders.
  Decide:
  - where: the Files tree only, or the navigator's folders too (Amendment 92;
    `shell/Navigator.tsx:277` uses the same tree hook).
  - the name: any name, a default `.md` when none is typed, or only `.md` and `.txt`. And
    whether a name with new folders in it, such as `docs/notes/x.md`, is allowed. The daemon
    would make them.
  - when the name is taken: refuse with `createOnly`, or ask to replace.
  - whether it works in an agent's running worktree. The file lands beside what the agent is
    writing.
  Not asked for, and separate items if wanted: new folders, rename and delete.
  Tests: `files/verify.ts` for the control, the name checks and the refresh after a write;
  `workspace/verify.ts` for a PUT that makes a new file and its folders, `..` and `.git`
  refused, and, with `createOnly`, a 409 on a name that exists.

## Seeing what's happening

- [ ] **Project and Agent, beyond the label.** Asked for (7 Oct). The label at the top has its
  own backdrop now (Amendment 97), and the top bar's **Project** and **Agent** tabs read
  louder (Amendment 95). Still open:
  - one backdrop colour per screen, so you can tell Project from Agent at a glance. Today
    both use `--here` (`packages/shared/src/tokens.css`).

- [ ] **Today's spend doesn't go back to zero at midnight.** Asked for (8 Oct). When the day
  restarts, the budget should read zero again, at midnight in your time zone.
  Read from the code, not yet reproduced. Two different budgets could be meant:
  - **The daily budget** (Amendment 59), the status bar's "$N today" and the Settings meter
    (`shell/shell.tsx:194`, `settings/route.tsx:213`). The daemon counts it right: one
    `cost_daily` row per local day (`localDay`, `session/store.ts:617`; `costToday`, `:630`).
    What's missing is telling the page. The status bar only learns the number when a tab
    connects (the hello snapshot) and from a `cost` frame, which is sent only when a Claude
    run's spend grows (`session/backends/claude.ts:604`; `case 'cost'` at
    `web/src/lib/store.ts:170`). A tab left open past midnight keeps yesterday's total until
    the next spend or a reload. The "daily budget reached" alert is fine: it has its own
    midnight timer (`#atMidnight`, `session/alerts.ts:147`) and its id carries the date.
  - **An agent's or job's own cap**, the composer's "$4.10 of $25" (`budgetUsd`,
    `budgetTokens`). These are lifetime caps by design (Amendment 77), so they never reset.
  The fix for the first: at the day's end the daemon sends a `cost` frame with the new day's
  total, so every open status bar reads zero. Reuse the midnight timer in `alerts.ts`, or put
  one in `daily.ts` beside `costChanged`. One long timer can fire late if the machine sleeps
  through midnight, so check the day on a short interval, or when a tab becomes visible.
  The day is the daemon's own time zone (`localDay` uses local `Date` parts, and nothing sets
  `TZ`), so it is your machine's zone unless the daemon is started under another.
  Decide:
  - which budget you saw not resetting: the status bar's "today", or an agent's cap.
  - if it's an agent's cap: whether it should become a per-day cap (spend since midnight),
    which changes what "budget reached" means for a long-running agent, or stay a lifetime cap.
  Tests in `session/verify.ts`, with a fake clock: spend on day 1, move the clock past
  midnight, and a `cost` frame carries 0 and a standing daily alert clears.

- [ ] **A Metrics tab: model usage, calls, time and errors.** Asked for (8 Oct). A new tab
  that reports, in total and per model: input and output tokens, the number of calls to the
  model, how long a call takes (model performance), and the error rate. Nothing shows these
  together today; Diagnostics (key `0`) has counts and today's cost only.
  - **Recorded today:**
    - Tokens and cost, on each agent row (`input_tokens`, `output_tokens`, `cost_usd`) and in
      one `usage` event per finished run (`session/backends/claude.ts:588-621`). Copilot and
      OpenRouter add up per call and report no dollars (`copilot.ts:519-527`; `costUsd:
      false`, `backends/index.ts:41`).
    - Errors: `api_retry` events with the cause and HTTP status (`claude.ts:549-558`), failed
      agents with a reason, and each run's `terminal_reason` (`agent_runs`,
      `db/migrations/010_session.sql`).
    - Time: an agent's start and end, each run's start and end, and each tool call's duration.
      Not the time a model call takes.
  - **Not recorded:**
    - **Calls and their time.** The SDK's result carries `num_turns` (model round-trips),
      `duration_ms` (the whole run) and `modelUsage` (tokens and cost per model); Conductor
      stores none of them. Copilot's `assistant.usage` is one event per call but is only summed
      (`copilot-events.ts:36`, `:128`). Check whether either engine reports a time per call.
    - **The model on a usage.** The `usage` event doesn't name one, and `agents.model` is
      overwritten when the model is switched (`setAgentModel`, `session/store.ts:588`), so a
      per-model total built from agent rows credits everything to the last model.
    - **A denominator for the error rate** (calls, or runs).
  - **History is lost on removal.** Removing a job or agent deletes its `agents` and
    `agent_runs` rows; `events` and `cost_daily` stay (`session/store.ts:226-249`). Build the
    tab from events, or from a table of its own keyed by day and model as `cost_daily` is, not
    from agent rows.
  - **Check first:** `setAgentUsage` overwrites a Claude agent's tokens with the latest
    result's (`claude.ts:611`) while its cost is lifetime. Find out whether a resumed agent's
    row holds only its last run before any total is taken from rows.
  - **Start:** add `model`, `calls` and `durationMs` to the `usage` event (additive, so an
    amendment), fed from `modelUsage`, `num_turns` and `duration_ms`. Then a daemon route that
    adds them up by model and day, and a screen beside Diagnostics (`SCREEN`,
    `web/src/shell/nav.ts:36-45`).
  Decide:
  - the range: today, 7 days or all, and whether it splits by day.
  - "performance": time per model call, tokens per second, or time per run. Per run is the
    only one both engines can give without new data.
  - "error rate": failed runs over runs, retried calls over calls, or both. And whether your
    own stop and a budget stop count as errors (suggested: no).
  - whether runs from before this ships appear (agent rows give totals, with no per-call data)
    or the tab starts empty.
  - which key opens it. `9` is Settings and `0` is Diagnostics.
  Tests in `session/verify.ts`: the `usage` event carries model, calls and time, a model switch
  splits the totals, and removing an agent keeps its history. A web check for the tab and its
  per-model rows.

## Agents

- [ ] **When the model can't be reached, try again after 5 s, 15 s, 30 s, 60 s and 5 min,
  then stop.** Asked for (8 Oct). An agent whose run ends because the SDK stopped working
  resumes on its own, five times at most, then stops as it does today.
  - **Today:** the SDK retries a model call by itself first, and Conductor only reports it
    (`api_retry`, `session/backends/claude.ts:549-558`; the Needs You alert from the second
    attempt, `session/alerts.ts:40-43`). When the run then ends with an error, the agent is
    `failed` at once (`#settle`, `packages/daemon/src/session/supervisor.ts:1003-1012`), and a
    failed agent fails its job (`supervisor.ts:1131`). Nothing retries after that. Only a daemon
    restart resumes agents on its own (`RESTART_NUDGE`, `supervisor.ts:175-179`, `286-289`).
  - **Which failures retry.** The ones where waiting can help: no network, throttled or
    overloaded, and server errors. Not a login or billing problem (`classifyRetry`,
    `alerts.ts:45-63`: `auth` needs a person), not a budget stop, not your own stop or pause.
  - **How.** Instead of `failed`, the agent waits for the next delay, then resumes its own
    session (`sdkSessionId`, as `pump` does at `supervisor.ts:723-729`) with a nudge like the
    restart one. A real reply from the model resets the count (`modelAnswered`,
    `claude.ts:542-544`). After the fifth retry fails it's `failed`, as now. Retries count
    against the agent's budget like any run.
  - **What you see.** "Reconnecting in 30 s (3 of 5)", with **retry now** and **stop
    retrying**, on the agent and in Needs You (`attention/alerts.ts`, `AlertCard.tsx`). Its job
    stays live while it retries.
  - **Both engines.** Copilot and OpenRouter end their runs through the same `#settle`. Check
    how their errors are classified (`backends/copilot-events.ts`).
  Decide:
  - whether a waiting agent keeps its slot or frees it until its next try.
  - whether retries survive a daemon restart (the next try's time saved), or a restart
    simply resumes it, as it does now.
  Tests in `session/verify.ts`, with a fake clock: each delay in turn, a reply resets the
  count, `auth` doesn't retry, and the sixth failure is `failed`.

- [ ] **Better instructions for the built-in roles.** Asked for (8 Oct). The new text for all
  seven is already written, as option B of [docs/plans/role-definitions.md](docs/plans/role-definitions.md).
  This item is building it.
  - **Today:** only the architect has a system prompt (`spawn/personas.ts:63`). The developer,
    validator, reviewer, scribe, debugger and analyst have a one-sentence brief
    (`personas.ts:87-92`). A preset keeps its own brief and takes only the persona's system
    prompt, skills and tool rules, so the system prompt is the one field that reaches every
    stack. It is appended to Claude Code's own (`session/backends/claude.ts:231`) or sent as
    Copilot's system message (`backends/copilot.ts:398`). The brief goes into the prompt after
    "Your role is …" (`#promptFor`, `session/supervisor.ts`).
  - **What changes:** `description`, `brief` and `systemPrompt` for six roles, and one rule
    added to the architect's, in `personas.ts`. Each system prompt ends with a fixed set of
    headings for its last reply ("End with: …"), since that reply is what the next agent reads.
    Three preset briefs in `spawn/presets.ts` are aligned with them: the full stack's
    validator and reviewer, and the bug fix's developer. Tools and models stay as they are.
  - **No migration.** Only edits that differ from a built-in are stored, so someone who never
    edited one gets the new text at once, and someone who did keeps their edit. **Reset**
    gives them the new text.
  - **The proposal needs a refresh first.** It numbers itself Amendment 96, which the merge
    used (the next is 99), and its `presets.ts` line numbers predate that merge.
  Decide:
  - whether to settle the `hand_off` and whole-context items first. The closing headings are
    what the next agent reads, and `hand_off`'s `summary` changes that. Should the `summary`
    be the closing block? Also check `HANDOFF_CAP` (8,000 characters, `session/handoff.ts:18`):
    a reviewer's ranked findings could be cut.
  - whether jobs expect agents to commit in their worktrees. The developer prompt says not to
    commit, push or rewrite history unless the job says to. Not checked yet.
  - the proposal's own open questions: should every built-in say `push: false`, or leave it to
    the launch (its default)? May the validator fix the code (it says no)? Should anything
    gate on the reviewer's verdict (nothing does)? Do the model tiers stay?
  - all seven at once, or the developer, validator, reviewer and debugger first. The scribe and
    analyst already have workable preset briefs.
  Tests in `spawn/verify.ts`: every built-in has a non-empty `systemPrompt` ending in an
  "End with:" line, and any check that quotes an old brief or description is updated (grep
  first). There is no evidence yet that the new text does better. Before keeping it, run the
  bug fix and full stacks on one known bug with the old prompts and the new, and compare the
  hand-offs.
