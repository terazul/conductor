# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 95 has been cleared;
the last of it on 8 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 127.
- Open items are `- [ ]`. A question that needs the user's answer before building is under
  **Decide:**, and the answer goes beside it in italics, as *Decided (date): …*.
- A real terminal (xterm.js) is planned, for macOS and Ubuntu only: see Wave 9 below. The
  terminal is a command runner on the Agent screen today (Amendment 58).

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
*Built (8 Oct): the question-tool line (Amendment 100), choosing who each agent waits for
(99), passing the whole conversation as text (101), re-run from here (102) and the
`hand_off` tool (104).*

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

## Wave 9: decided, not yet built

- [ ] **Clear out wave 9's worktrees and branches once its lanes are merged.** Found (10 Oct). The
  job `job_07af774e-eb6` is `done`, but its folder `.conductor/wt/job_07af774e-eb6` (with `w9/d`,
  `w9/m`, `w9/t` under `.claude/worktrees/`) and branch `conductor/job_07af774e-eb6` are still
  there, and `conductor/job_91cc23e2-9b7` is a recreated folder. `w9/d` is merged. `w9/m` and `w9/t`
  hold the two lanes above, which aren't started. **Ask first** which folders are still in use: a
  `done` job's agent can be messaged again, and its folder is needed then (Needs You → recreate
  folder makes it again from its branch, or from `main`, without anything that wasn't committed).

## Loose ends and checks from Amendments 99–104

- [ ] **Look at Amendments 99–104 in a browser, in both themes.** Found (10 Oct). `make test` passes
  and the colour checks hold, but nobody has seen these. Look at:
  - Spawn: the ↑ ↓ buttons and the drag grip on a preset's rows and a Custom setup's rows, the
    **waits for** ticks on preset rows, and **↺ back to …** (99).
  - The Agent screen: **↻ re-run after this** on an agent with agents after it, its armed state and
    its banner (102).
  - Needs You: the **Not handed off** card, **hand off**, and the summary box (104).
  - The status bar: a tab left open past midnight reads $0.00 today (103). Moving the system clock
    forward is enough to see it.

- [ ] **A re-run of a parked agent, tried against the real SDK (Amendment 102).** Found (10 Oct).
  A re-run resumes a session that ended on `tool_deferred` with a prompt. `sendMessage` already does
  that for a message, but only a fake backend has run it, and a real run costs money and needs a
  person watching. Try it once on a real parked agent. The other loose ends of Amendments 99-104
  were built in 115 and 120.
## Files

## Seeing what's happening

- [ ] **Project and Agent, beyond the label.** Asked for (7 Oct). The label at the top has its
  own backdrop now (Amendment 97), and the top bar's **Project** and **Agent** tabs read
  louder (Amendment 95). Still open:
  - one backdrop colour per screen, so you can tell Project from Agent at a glance. Today
    both use `--here` (`packages/shared/src/tokens.css`).

- [ ] **An agent's own cap doesn't go back to zero at midnight.** Asked for (8 Oct), with
  the status bar's "$N today", which is fixed (Amendment 103: the daemon now tells open pages
  when the day changes). What's left is the other budget you might have meant: an agent's or
  job's own cap, the composer's "$4.10 of $25" (`budgetUsd`, `budgetTokens`). These are
  lifetime caps by design (Amendment 77), so they never reset.
  Decide:
  - whether this is what you saw not resetting.
  - if so, whether it becomes a per-day cap (spend since midnight), which changes what
    "budget reached" means for a long-running agent, or stays a lifetime cap.
  The day is the daemon's own time zone (`localDay` uses local `Date` parts, and nothing sets
  `TZ`), so it is your machine's zone unless the daemon is started under another.

## Agents
