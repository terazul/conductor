# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 95 has been cleared;
the last of it on 8 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 99.
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

- [ ] **Choose who each agent waits for, in any stack.** Asked for (8 Oct). For example:
  the developer waits for the architect. An agent can only wait for agents above it in the
  stack.
  - **Presets can't be changed today.** Each preset's dependencies are fixed in code
    (`dependsOnRoles` in `packages/web/src/spawn/presets.ts:67-92`, copied as-is at
    `presets.ts:317`).
  - **Custom setups already do this.** Each row has **waits for** (`spawn/RoleRow.tsx:25`,
    toggled at `spawn/CustomSetup.tsx:66`), and a dependency must be above it
    (`spawn/custom.ts:67-68`). Adding an agent to a running stack checks for loops
    (`spawn/stack.ts:180-191`).
  - **The daemon enforces "above you"** since Amendment 98 (`parseAgentSpecs`,
    `packages/daemon/src/routes/session.ts`). What's left is the web.
  - **Show it on preset rows.** Each preset row shows its **waits for** and lets it be
    changed. Reuse `RoleRow` (`spawn/RoleRow.tsx:48`: no roles given, no **waits for** shown).
  Decide:
  - whether changing a preset row turns it into an unsaved Custom setup (as loading a saved
    one does, `spawn/route.tsx:586-594`), or changes it for this launch only.
  *Decided (8 Oct): an agent's place in the stack sets what it can wait for. You move rows
  around in Spawn to change who waits for whom.*
  *Decided (8 Oct): each row waits for the one directly above it by
  default, and the **waits for** ticks stay for waiting on several rows above (the reviewer
  waits on three today, `presets.ts:85`). Moving a row re-checks its ticks. A change to a
  preset row applies to this launch only.*

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

- [ ] **Tell stack agents to ask with the question tool, not in prose.** Asked for (7 Oct).
  One line in the prompt Conductor builds (`#promptFor`, `supervisor.ts:809-828`), for
  agents in a stack: ask the user with the question tool. A question asked that way already
  holds the agent in Needs You and starts nothing after it (`arbiter/index.ts:339`; `#settle`
  at `supervisor.ts:975-985`). The architect above asked in prose. Check that OpenRouter
  models get the question tool too: Copilot handles it (`backends/copilot.ts`), and OpenRouter
  runs on the same backend (`backends/index.ts:51-56`).
  *Decided (8 Oct): yes. It doesn't replace `hand_off`: an agent can still end with "I'll
  wait".*

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

## Seeing what's happening

- [ ] **Project and Agent, beyond the label.** Asked for (7 Oct). The label at the top has its
  own backdrop now (Amendment 97), and the top bar's **Project** and **Agent** tabs read
  louder (Amendment 95). Still open:
  - one backdrop colour per screen, so you can tell Project from Agent at a glance. Today
    both use `--here` (`packages/shared/src/tokens.css`).

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
