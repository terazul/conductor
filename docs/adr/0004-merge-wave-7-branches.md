# ADR 0004 — Merge the two 7–8 Oct job branches, then delete them

- **Status:** accepted and carried out (8 Oct 2026). The steps are in
  [docs/plans/merge-wave-7-branches.md](../plans/merge-wave-7-branches.md).
- **Asked for:** "merge these if they're good functionality and remove the junk, then delete the branches" (8 Oct).
- **Decided by the user (8 Oct):** keep all the functionality on both branches; commit the
  untracked `docs/plans/role-definitions.md` as a proposal; push `main` to GitHub afterwards.

## Context

**Two job branches were never merged.** Both start from `main` at `3b236be`, and neither has been pushed (`origin` is `github.com:terazul/conductor`, public, with no PRs).

| Branch | Commits | Amendments | What it does |
|---|---|---|---|
| **A** `conductor/job_394bb67f-40d` (7 Oct) | 7 | 90–95 | Nested repos open all the way down in Files (90); Files opens on your project (91); navigator folders open into a tree (92); filled working and finished marks (93), carried into the navigator and agent tabs (94); louder top-bar tabs (95). Adds ADR 0003 and `docs/plans/todo-wave-7-oct.md`. |
| **B** `conductor/job_bfb5570d-a7b` (8 Oct) | 4 | 90–92 | Rewrites TODO.md with the 7–8 Oct requests (`980f407`); the settings under the message box fold away (90); the project / agent label gets a backdrop (91); the daemon refuses an agent that waits for one listed after it (92). |

**Evidence that the functionality is good:**

- `make test` passes on A alone, on B alone, and on A with B merged (run on 8 Oct in a throwaway worktree, since removed). Note: running two `make test`s at once fails with `database is locked` in `smoke`. That's a test-harness collision, not a branch fault. Run them one at a time.
- Neither branch commits build output, databases, logs or secrets. Every changed file is source, a verify suite or a doc. A scan of both diffs for keys and local paths found nothing.

**What is junk:**

- `docs/plans/status-7-oct.md`, untracked in B's worktree. It's a 7 Oct status snapshot ("all 43 items are checked off"), and B's TODO.md superseded it the next day.
- B's copy of `docs/plans/todo-wave-7-oct.md`. It's A's copy without the answered decisions, and it numbers lane E as 94 where A has 95.
- `conductor/job_ff9d525d-0d8`, the branch this design session runs on. It has no commits of its own (it equals `main`).
- After the merge, both job branches and both worktrees.

**Where they collide:**

- **Amendment numbers.** A's 90–92 and B's 90–92 are different changes. A's own text cross-references them: 94 cites 90 and 93, and 92 cites 90.
- **Merge conflicts.** Only `CONTRACT.md` (the amendment log), `TODO.md` (the "next amendment" line, and B's rewrite against A's clearing) and `docs/plans/todo-wave-7-oct.md` (added by both) conflict. Five other shared files merge cleanly: `MANUAL.md`, `agent.css`, `fleet.css`, `lib/verify.ts` and `agent/verify.ts`.
- **TODO.md disagrees.** A empties it. B lists 13 open items, six of which A built: the two Files items, the navigator item, and three under "Seeing what's happening".

**How the daemon treats these checkouts:**

- Removing a job calls `forget`, which touches nothing on disk (`packages/daemon/src/session/supervisor.ts:1562-1591`, `workspace/service.ts:228-245`).
- Only `close` runs `git worktree remove` (`workspace/worktree.ts:237-279`, `DELETE /api/workspaces/:jobId` at `routes/workspace.ts:304-312`), and it refuses a dirty worktree unless forced.
- Job A's rows are already gone from `~/.conductor/conductor.db`. Job B is recorded as `done`, with a `worktree` workspace row.
- This session's job (`job_ff9d525d-0d8`) uses `branch` isolation in the main checkout.

## Options

| Option | Cost | Risk | Reversible |
|---|---|---|---|
| **1. Merge commits** (`--no-ff`, B then A, conflicts resolved once) | Lowest: one resolution | First merge commit on a linear `main` (0 merges in 4 commits). B's commits keep saying 90–92 in their messages and comments while CONTRACT says otherwise. | Yes, before push |
| **2. Fast-forward A, then cherry-pick B renumbered 96–98** (chosen) | Medium: B's TODO commit rewritten, three small conflicted picks | Hand renumbering. A blanket replace would corrupt A's 90–92, so only lines the pick adds are changed. | Yes, before push. B's SHAs are listed below. |
| **3. Squash each branch to one commit** | Low | Breaks the repo rule of one commit per amendment, each with a green `make test` (TODO.md, "How to work this list") | Yes, before push |
| **4. Renumber A instead (A → 93–98)** | Highest: six amendments, internal cross-references, ADR 0003 and the plan all cite 90–95 | More edits for no gain. A came first (7 Oct). | Yes, before push |

## Decision

**Option 2.** A keeps 90–95 because it came first, and its seven commits land on `main` unchanged as a fast-forward. B's three feature amendments become **96, 97 and 98**:

| B was | Becomes | Commit |
|---|---|---|
| 90 settings fold | **96** | `88c0466` |
| 91 label backdrop | **97** | `0b9e125` |
| 92 launch order check | **98** | `c8a13cd` |

B's docs commit `980f407` isn't picked. It's replaced by one new commit that reconciles TODO.md: B's list, minus the six items A built, with "next amendment is 96". That commit keeps A's `todo-wave-7-oct.md`.

Each pick renumbers only its own added lines and its commit message. Amendment 97's text and the TODO item "Project and Agent" are corrected, since the top-bar tabs B lists as "not done" are done by Amendment 95.

Then:

- `main` is pushed to GitHub as a fast-forward, never forced.
- The worktrees are removed without `--force`, so a surprise dirty file stops the step.
- The four local branches are deleted. `integrate/wave-7` is the temporary branch the plan builds on.

## Consequences

- **History:** `main` stays linear, with one commit per amendment, each green. B's original SHAs exist only in the reflog after deletion. They're listed here for 90 days of recovery: `980f407`, `88c0466`, `0b9e125`, `c8a13cd`, A tip `6362b9b`.
- **Public:** these 11 changes and 3 new docs become public on push. Undoing that would need a force push.
- **Daemon:** Amendment 98 changes `routes/session.ts`, so the running daemon must be restarted to pick it up.
- **Open TODO after merge:** the five "Stacks" hand-off items and the model-retry item.
- **Later work is easier:** the next amendment is 99, and TODO.md matches the code again.

## Not decided here

- Whether "one backdrop colour per screen" stays in TODO. It was B's suggestion, not a request. ADR 0003 records that the user meant the top-bar tabs, which Amendment 95 built. The plan's default is to keep it, with only that sub-bullet left, until the user says otherwise.
- Moving future job work to PRs on GitHub instead of local branches.
