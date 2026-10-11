# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 95 has been cleared;
the last of it on 8 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 128.
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

## Housekeeping

- [ ] **Clear out wave 9's worktrees and branches.** Found (10 Oct). The job `job_07af774e-eb6` is
  `done`, but its folder `.conductor/wt/job_07af774e-eb6` (with `w9/d`, `w9/m`, `w9/t` under
  `.claude/worktrees/`) and branch `conductor/job_07af774e-eb6` are still there, and
  `conductor/job_91cc23e2-9b7` is a recreated folder. Everything on them is on `main` (the terminal
  and methodology lanes were rebuilt on other branches as 112 and 115). **Ask first** which folders
  are still in use: a `done` job's agent can be messaged again, and its folder is needed then
  (Needs You → recreate folder makes it again from its branch, or from `main`, without anything that
  wasn't committed).

## Checks that need a person

- [ ] **Look at what was built in Amendments 99-127 in a browser, in both themes.** Found (10 Oct).
  `make test` passes and the colour checks hold, but nobody has seen most of it.
  - Spawn: the ↑ ↓ buttons, the drag grip and the **waits for** ticks on preset and Custom rows, and
    **↺ back to …** (99); the three branch pills and the name box (115); the label backdrops of
    the Project, Agent and Fleet screens side by side (127).
  - Files: the **+** on a folder row and on a tree's heading, the name box, and an empty file (121).
  - The Agent screen: the terminal tab (112; checked in headless Chrome on macOS in both themes,
    not on Ubuntu, and `vim`, `htop` and `less` were not tried), **↻ re-run after this** and its
    disabled state for a held agent (102, 120), the reconnecting banner (123), the over-budget line,
    the budget colours in the composer, details bar and tab (124, 125).
  - Fleet and Project: the **not handed off** chip (120) and the budget meter on each agent row (125).
  - Needs You: the **Not handed off**, **Reconnecting** and **Over budget** cards (104, 123, 124).
  - Metrics, key `8` (122).
  - The status bar after midnight (103): a tab left open past midnight reads $0.00 today. Moving the
    system clock forward is enough to see it. If what you saw not resetting was an agent's own
    budget (the composer's "$4.10 of $25"), say so: those are lifetime caps by design (Amendment 77)
    and a per-day cap was never confirmed.

- [ ] **A re-run of a parked agent, tried against the real SDK (Amendment 102).** Found (10 Oct).
  A re-run resumes a session that ended on `tool_deferred` with a prompt. `sendMessage` already does
  that for a message, but only a fake backend has run it, and a real run costs money and needs a
  person watching. Try it once on a real parked agent.

- [ ] **Compare the new built-in role instructions with the old on one real bug (Amendment 126).**
  Found (10 Oct). Run the bug fix and full stacks on one known bug with the old prompts and the new,
  and compare the hand-offs. It needs real agent runs and spend, so it was not done.
