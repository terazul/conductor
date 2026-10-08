# Plan — build the decided TODO items in parallel (8 Oct 2026)

Source: [TODO.md](../../TODO.md). The next amendment is 99.

## What can start, and what can't

An item can start when its **Decide:** questions are answered. Six are.

| Lane | Item | Amendment | Touches |
|---|---|---|---|
| A | Choose who each agent waits for (move rows in Spawn) | 99 | `packages/web/src/spawn/*` |
| B1 | Tell stack agents to ask with the question tool | 100 | `session/supervisor.ts` (`#promptFor`), `backends/index.ts` check |
| B2 | Pass the whole context of the agent before, as text | 101 | `session/handoff.ts`, `eventlog.ts`, `#promptFor` |
| C | Re-run from here | 102 | `supervisor.ts` (`sendMessage`, `pump`), `routes/session.ts`, `wire.ts`, the Agent screen |
| D | Today's spend back to zero at midnight (the status-bar half) | 103 | `daily.ts`, `alerts.ts`, `hub.ts` |
| E | `hand_off` tool | 104 | `routes/helpers.ts`, both backends, `#settle`, `alerts`, `wire.ts`, Needs You |

B1 and B2 are one lane, in that order, because both edit `#promptFor`. Lane E waits for B2: the
`hand_off` summary goes on top of B2's context text.

**Held, each needing an answer from the user:**

| Item | Needs |
|---|---|
| Orchestrated stacks | Roles listed before launch or not; how many send-backs before it asks; whether its helpers get `hand_off`. Also lane E first. |
| Create a new file while browsing | Where (Files only or the navigator too); what names; what to do when the name is taken; whether it works in a running worktree. |
| Project and Agent, beyond the label | Whether to do it at all. It was a suggestion, not a request. |
| Metrics tab | Range; what "performance" and "error rate" mean; whether old runs show; which key. |
| Model retry | Whether a waiting agent keeps its slot; whether retries survive a restart. |
| Better built-in role instructions | Wait for lane E, then its own four questions. |
| Midnight: an agent's own cap | Which budget was meant; if an agent's, whether it becomes a per-day cap. |

## How the lanes avoid colliding

- **One worktree and branch per lane**, cut from `main` at `.conductor/wt/lane-<name>`. Nobody
  works in the main checkout, where the daemon and Vite are running.
- **Amendment numbers are reserved above**, so no two lanes claim the same one (the 90–92 clash on
  the last merge). A lane uses only its own number in its code comments, commit message and tests.
- **Lanes don't edit `CONTRACT.md` or `TODO.md`.** Every lane adds at the top of the log, so every
  merge would conflict. A lane writes its amendment text to an untracked `AMENDMENT.md` in its
  worktree. The integrator pastes it into the log and takes the item off the TODO in the same
  commit.
- **Tests take turns.** Two `make test` runs at once fail with `database is locked`. Lanes don't
  run `make test` or the daemon's smoke. They run `pnpm -r typecheck`, the verify files for what
  they touched, and the daemon's `session/verify.ts` only while holding a lock directory:

  ```
  until mkdir /tmp/conductor-test.lock 2>/dev/null; do sleep 3; done
  <command>; status=$?
  rmdir /tmp/conductor-test.lock; exit $status
  ```
- **Nothing is pushed.** Lanes commit to their branch only.

## Order

1. **Wave 1, in parallel:** A, B (B1 then B2), C and D.
2. **Integrate in amendment order** (99, 100, 101, 102, 103). For each lane: cherry-pick onto
   `main` in a worktree, resolve `session/verify.ts` (every lane appends its tests at the same
   place; keep both), add the amendment to `CONTRACT.md` and take the item off `TODO.md`, run the full
   `make test` alone, and amend the commit. Fast-forward `main` once every pick is green.
3. **Wave 2:** lane E, from the new `main`. Integrate the same way as 104.
4. **Clean up:** remove the lane worktrees and branches. Restart the stack. The user pushes.

## Risks

- **Textual conflicts in `supervisor.ts`.** B, C and E edit different functions, so most merges
  are clean. If one isn't, the integrator resolves it by hand and re-runs the lane's tests.
- **Lanes that pass alone and fail together.** The full `make test` after each pick is the
  check. A failure goes back to the lane's author as a fix on top of the pick, not as a hand edit.
- **Reserved numbers go unused.** If a lane is dropped, its number is skipped. The log can have a
  gap; it can't have two with the same number.
- **Not reviewed by hand in a browser.** Lane A's drag-to-reorder and lane C's button are UI, and
  `make test` can't see how they look. They need the user's look in both themes before the push.
