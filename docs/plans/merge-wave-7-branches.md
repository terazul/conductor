# Plan — merge the 7–8 Oct job branches into `main`, then delete them

Design: [ADR 0004](../adr/0004-merge-wave-7-branches.md). A = `conductor/job_394bb67f-40d`,
B = `conductor/job_bfb5570d-a7b`.

## Context

- **Branch A** has seven commits (Amendments 90–95). **Branch B** has four (Amendments 90–92 and a TODO rewrite). Both start from `main` at `3b236be`, and neither is pushed.
- **Tests:** `make test` is green on each branch alone and on the two combined.
- **Conflicts:** only in `CONTRACT.md`, `TODO.md` and `docs/plans/todo-wave-7-oct.md`.
- **Decided by the user (8 Oct):** keep all the functionality on both branches; commit `role-definitions.md` as a proposal; push `main`.

## Options

| | Approach | Verdict |
|---|---|---|
| 1 | Two `--no-ff` merges | Leaves 90–92 doubled in B's commit messages and comments |
| **2** | **Fast-forward A, then cherry-pick B as 96–98** | **Chosen**: linear, one green commit per amendment |
| 3 | Squash each branch to one commit | Breaks "one commit per amendment" |
| 4 | Renumber A as 93–98 | Twice the edits, and A came first |

## Decision

Build on a temporary branch, `integrate/wave-7`, in its own worktree at `.conductor/wt/integrate-wave-7`. The daemon and Vite dev server keep running from the main checkout, untouched. When every step is green, move `main` to it as a fast-forward, push, and clean up.

## Plan

Run `make test` one at a time, never two at once. Two at once fail in `smoke` with `database is locked`.

1. **Save what's untracked before anything is deleted.**
   - Copy `.conductor/wt/job_394bb67f-40d/docs/plans/role-definitions.md` to the main checkout's `docs/plans/`.
   - Delete `.conductor/wt/job_bfb5570d-a7b/docs/plans/status-7-oct.md`. It's junk; ADR 0004 says why.
   - Check: `git -C <each worktree> status --porcelain` is empty.

2. **Create the integration worktree on A.** Run `git worktree add -b integrate/wave-7 .conductor/wt/integrate-wave-7 conductor/job_394bb67f-40d`, then `pnpm install --frozen-lockfile --offline` inside it. A's seven commits are now in, unchanged.

3. **Commit: reconcile TODO.md** (`docs(todo): add the 7–8 Oct requests that are still open`).
   - Start from B's file: `git show conductor/job_bfb5570d-a7b:TODO.md`.
   - Delete the six items A built: "Open nested repos and sub-repos as folders in Files", "Files opens on the project you're in", "Open folders, and files, from the left panel", "Make 'finished' easier to see", "Make 'working' easier to see" and "Show which agents finished, not only which jobs". Also delete the `## Files`, `## Navigator` and `## Seeing what's happening` headings once they're empty.
   - Keep the five "Stacks" items, "Project and Agent, beyond the label" (see the open questions) and the model-retry item.
   - Set the intro line to "The next amendment is 96". The intro paragraph should say items up to Amendment 95 have been cleared.
   - Leave `docs/plans/todo-wave-7-oct.md` as A has it.
   - Check: `grep -c '^\s*- \[ \]' TODO.md` gives 7 (or 6 if the "Project and Agent" item is dropped).
   - Check: `make test` is green.

4. **Cherry-pick `88c0466` as Amendment 96** (`git cherry-pick 88c0466`).
   - Resolve `CONTRACT.md`: the new `### Amendment 96` section goes on top of A's 95, since the log is newest first (`6362b9b`).
   - Resolve `TODO.md` by keeping step 3's text and setting the next amendment to 97.
   - Change "Amendment 90" to "Amendment 96" on the lines this commit adds: `CONTRACT.md` heading, `agent/settingsfold.ts`, `agent/composer.tsx`, `agent/agent.css`, `agent/verify.ts` (the `9 ·` section title) and `MANUAL.md`, if referenced.
   - Find those lines with `git diff HEAD~1 -U0 | grep '^+.*Amendment 90'`. Never `sed` the whole file, since A's own Amendment 90 is cited in A's text.
   - Amend the message to say Amendment 96.
   - Check: `make test` is green.

5. **Cherry-pick `0b9e125` as Amendment 97.** Same method as step 4: 91 becomes 97 in `shared/src/tokens.css`, `fleet/fleet.css`, `agent/agent.css`, `lib/verify.ts`, `CONTRACT.md`, `TODO.md` and the commit message. Then correct the text:
   - In Amendment 97's **Not done** line, "the top bar's **Project** and **Agent** tabs. Both are still open in TODO.md" becomes "the top-bar tabs are Amendment 95".
   - In the TODO.md item "Project and Agent, beyond the label", remove the sub-bullet about the top-bar tabs, which Amendment 95 built. Then set the next amendment to 98.
   - Check: `make test` is green.

6. **Cherry-pick `c8a13cd` as Amendment 98.** 92 becomes 98 in `daemon/src/routes/session.ts`, `daemon/src/session/verify.ts`, `CONTRACT.md` and TODO.md. In TODO.md that's the "daemon enforces 'above you' since Amendment 92" line, and the next amendment becomes 99. Fix the commit message too. Its text cites Amendment 89, which is `main`'s, so leave that alone.
   - Check: `make test` is green.

7. **Commit the docs** (`docs(conductor): ADR 0004 and the merge plan; propose role definitions`). Copy these from the main checkout, where they're untracked: `docs/adr/0004-merge-wave-7-branches.md`, `docs/plans/merge-wave-7-branches.md` and `docs/plans/role-definitions.md`. Mark the ADR status as carried out.

8. **Check the whole branch.**
   - `git log --format=%s main..integrate/wave-7` lists 11 commits, with amendments 90–98, each once.
   - `grep -c '^### Amendment 9[0-8] ' CONTRACT.md` gives 9.
   - `grep -n 'Amendment 9[0-8]' -r packages` shows no number on the wrong feature. Spot-check `settingsfold.ts` (96), `tokens.css` (97) and `routes/session.ts` (98).
   - `make test` is green.

9. **Move `main` and see it running.**
   - `git push . integrate/wave-7:main`. This is fast-forward only and fails if `main` moved.
   - In the main checkout, `git switch main`. This is safe because `conductor/job_ff9d525d-0d8` equals the old `main` and is clean apart from step 1's file and the two new docs, which carry over.
   - Run `make restart` so the daemon loads Amendment 98.
   - Click through by hand in both themes:
     - the Files tree, with a nested repo showing its branch;
     - the navigator's folders;
     - the working and finished marks;
     - the top-bar tabs;
     - the settings fold on the Agent screen;
     - the label backdrop.

10. **Push:** `git push origin main`. Never `--force`. Check: `git rev-list --left-right --count main...origin/main` gives `0 0`.

11. **Delete the job worktrees, then the branches.**
    - In Conductor, remove job `job_bfb5570d-a7b`, which is `done`. Its `forget` touches nothing on disk (`supervisor.ts:1583`). Job A's rows are already gone.
    - Remove the worktrees:
      - `git worktree remove .conductor/wt/job_394bb67f-40d`
      - `git worktree remove .conductor/wt/job_bfb5570d-a7b`
      - `git worktree remove .conductor/wt/integrate-wave-7`
      - No `--force`. If one refuses, stop and look.
    - Then `git worktree prune`.
    - Delete the branches with `git branch -d`, never `-D`: `conductor/job_394bb67f-40d`, `integrate/wave-7` and `conductor/job_ff9d525d-0d8`. All three are merged into `main`, so `-d` accepts them.
    - `conductor/job_bfb5570d-a7b` isn't merged by SHA because its commits were cherry-picked, so `-d` refuses it. Confirm with `git cherry main conductor/job_bfb5570d-a7b`: every line should be `-`, apart from `980f407`, which was rewritten on purpose. Then delete it with `-D`.
    - Remove this session's job (`job_ff9d525d-0d8`) in Conductor when it ends.
    - Check: `git branch` shows only `main`, and `git worktree list` shows one entry.

## Risks and open questions

- **Wrong renumbering.** A blanket replace would turn A's real 90–92 into 96–98. The fix is to edit only lines the pick adds, then check with step 8's grep. To recover, the old SHAs are in ADR 0004 and stay in the reflog for 90 days.
- **Push is public and one-way.** Undoing it needs a force push to a public repo. Step 9's hand check comes before step 10 for that reason.
- **Daemon restart.** Running agents are resumed by the restart nudge (`supervisor.ts:175-179`), and this session is one of them. Run step 9's `make restart` with nothing else working.
- **Untested together by hand.** The combined code passed `make test`, but no one has looked at it in a browser. B's backdrop (97) and A's louder tabs (95) both change the top bar, and only seeing them together shows whether that's too much.
- **Open question:** drop "one backdrop colour per screen" from TODO? It was B's suggestion, not a request. ADR 0003 says "Project and Agent" meant the top-bar tabs, which are built. The default is to keep the item, with only that sub-bullet left, until you say otherwise.
- **Not read:** the full bodies of A's verify suites and B's `settingsfold.ts`. They're trusted on a green `make test`, not reviewed line by line.
