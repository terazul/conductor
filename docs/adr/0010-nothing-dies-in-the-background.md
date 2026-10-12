# ADR 0010 — Nothing an agent starts is left to die in the background

- **Status:** accepted and built as Amendment 133 (12 Oct 2026).
- **Reported (12 Oct):** "I asked the architect to design and execute a plan. It did, but
  then it said the other agents downstream exited when the session ended, and they did not do
  their work. Why is that happening?"
- **Decided by the user (12 Oct):** tell every agent, and enforce it (options 1 and 2 of 3).

## Context

- **A run ends its process when its turn ends.** A Claude run stops at the first `result`
  and closes its input (`packages/daemon/src/session/backends/claude.ts:23-25`, `:517`,
  `:528`). This is on purpose: otherwise each finished agent would pin a slot. A later
  message resumes the session in a new process.
- **Background work can't survive that.** Claude Code's `Agent` tool takes
  `run_in_background: true`. A background subagent reports back by waking the main loop for
  another turn, and nothing can wake a process that has exited. So an architect that fans
  out builders in the background and ends its turn to wait for them loses all of them. This
  happened on 7 Oct (project memory `execute-means-finish-in-one-turn.md`) and again on
  12 Oct. `Workflow` only ever runs in the background. Background `Bash` and scheduled
  wake-ups die the same way.
- **Stacks aren't the cause.** Downstream stack agents start on `hand_off`, after the turn
  (Amendment 104).
- **The hook can already rewrite input.** Conductor's PreToolUse hook sees every call
  (`claude.ts:280-283`) and can return `updatedInput` (`:333`).

## Options

| Option | Cost | Risk | Later |
|---|---|---|---|
| 1. Tell every agent, in its system prompt | One line | The model may not follow it | — |
| 2. Rewrite a background `Agent` call to run in the foreground; decline `Workflow` | Small, in the existing hook | The turn now waits for the subagent, which is what the model wanted anyway. Several calls in one message still run side by side | Can widen to other tools |
| 3. Keep the process alive past `result` while background work runs | Large; it needs the SDK's background-task signals | Gives back the slot savings the design was built for | — |

## Decision

1 and 2, in `session/background.ts`:

- `TURN_END_LINE` is appended to every Claude agent's system prompt, after its persona's own.
- `foregroundInput(tool, input)` turns `Agent`/`Task` with `run_in_background: true` into
  the same call with `false`, plus a note for the model.
  - On the observe path, the hook returns `updatedInput` with **no** permission decision, so
    the guardrails and `canUseTool` still decide whether the call runs.
  - On an allow, the rewrite rides along with it.
  - Checked against the real SDK 0.3.284 on 12 Oct: the subagent ran in the foreground, and
    its answer came back as the call's result, both with an allow and without one.
- `declinedHere('Workflow')` denies it, with a reason that says to use foreground agents.
- Left alone:
  - background `Bash`, because a dev server started for this turn's tests is meant to stop
    with it;
  - the Copilot engine, which has no background subagents.

## Consequences

- An agent that asks for background agents gets them in the foreground. Its turn lasts as
  long as they do, and their answers arrive as tool results.
- Workflows can't run inside Conductor agents.
- Every Claude agent now sends a system prompt `append`. Before, an agent without a persona
  sent none.
- Reversible: one module plus three call sites.

## Testing

`session/verify-background.ts`, 17 checks:

- the pure rules;
- a real runner launched against a fake SDK, whose own PreToolUse hook is then called the
  way Claude Code calls it.

`session/verify.ts`'s persona checks now expect the line.
