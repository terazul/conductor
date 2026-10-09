# Plan: wave 8, built in parallel, then merged to main and pushed (Amendments 107–109)

Three changes, built side by side in their own worktrees, merged into this job's branch,
tested once together, then merged into `main` and pushed:

| Lane | Amendment | What | Design | Touches |
|---|---|---|---|---|
| C | 107 | One "where you are" label on every screen | [ADR 0006](../adr/0006-one-crumb-everywhere.md), [plan](one-crumb-everywhere.md) | web CSS + crumb classNames |
| A | 108 | Needs You as a side panel on the Agent screen | [ADR 0007](../adr/0007-needs-panel-on-agent.md) | web: attention, agent, shell/panels |
| B1 | 109 | Branches: daemon half | [ADR 0008](../adr/0008-branches-screen.md) | daemon: workspace/branches.ts, routes/branches.ts |
| B2 | 109 | Branches: screen 7 | [ADR 0008](../adr/0008-branches-screen.md) | web: branches/*, shell/nav.ts, shell/shell.tsx |

The user asked for this on 9 Oct: "the plan should try to parallelize the execution, merge
all branches to main, commit and push when done." That is the authority for step 6's push
to `origin/main`.

## Step 0: the shared ground, committed before anything forks (one agent, about 15 min)

These are the only edits the lanes would otherwise collide on. Make them once, on this
branch (`conductor/job_07af774e-eb6`), and commit them as `chore: lay out wave 8 (107–109)`:

1. **`packages/shared/src/wire.ts`:** add ADR 0008's types exactly as written
   (`BranchCommit`, `BranchInfo`, `BranchesResponse`, `BranchAction`,
   `BranchActionResult`), and the `{ type: 'branches'; projectId: string }` member of
   `ServerFrame` (`wire.ts:618-644`). Then `pnpm -r typecheck`. If `lib/store.ts:129-182`
   switches on frames exhaustively, add a no-op `case 'branches':` there too; lane B2
   fills it in.
2. **`CONTRACT.md`:** above Amendment 106 (`:199`), three headings with one-line
   placeholders, in this order: `### Amendment 109 — …`, `### Amendment 108 — …`,
   `### Amendment 107 — …`. Each lane replaces only its own body, so the merges are clean.
3. **`TODO.md:13`:** "The next amendment is 110."
4. **Verify stubs.** Create each file below as a stub that prints `pending` and exits 0, and
   add its line to the `Makefile` `test:` target. The daemon lines go after
   `session/verify.ts`, using the same `tsx --no-warnings=ExperimentalWarning` form.
   - `packages/web/src/lib/verify-crumb.ts` (C)
   - `packages/web/src/attention/verify-needs-panel.ts` (A)
   - `packages/web/src/branches/verify.ts` (B2)
   - `packages/daemon/src/workspace/verify-branches.ts` (B1)

   Lanes fill their own file and touch nobody else's.
5. **`packages/web/src/shell/panels.ts`:** add `AGENT_NEEDS` from ADR 0007 now. Lane A uses
   it, and nobody else touches this file.
6. `make test` green, then commit.

Docs (`docs/MANUAL.md`) are left to the scribe after the merge, in one pass. The three
lanes would otherwise all edit the same screens table (`MANUAL.md:714-725`).

## Steps 1–4: the lanes, all at once

The developer starts four sub-agents in one message, in parallel. Each works in its own
worktree, created from the step 0 commit:

```sh
git worktree add .claude/worktrees/w8-c  -b w8/107-crumb     HEAD
git worktree add .claude/worktrees/w8-a  -b w8/108-needs     HEAD
git worktree add .claude/worktrees/w8-b1 -b w8/109-branches-daemon HEAD
git worktree add .claude/worktrees/w8-b2 -b w8/109-branches-web    HEAD
```

`.claude/worktrees/` is gitignored (`.gitignore`).

The developer waits for all four in the same turn: no agent may be left running when its
turn ends. Each lane:

- reads its ADR and works only on the files in its row;
- fills its own verify stub;
- writes its CONTRACT body;
- runs `pnpm -r typecheck` plus its own verify file;
- commits on its branch with the Co-Authored-By trailer.

Lanes run only their own verify, never the whole `make test`, because parallel runs hit
"database is locked" (`docs/plans/merge-wave-7-branches.md`). Each lane reports its branch,
its commit and what it didn't do.

**Lane C (107):** [one-crumb-everywhere.md](one-crumb-everywhere.md) steps 1–7, with its
tests in `lib/verify-crumb.ts` and not in `lib/verify.ts`. It touches `agent.tsx:611` and
three crumb lines in `attention/route.tsx`. Lane A's edits to those two files are elsewhere.

**Lane A (108):** follow ADR 0007's decision.
1. `attention/NeedsPanel.tsx`, with a pure `needsFor(agentId, pending, alerts)` exported for
   the tests.
2. `attention/AlertCard.tsx`: add `onAgentScreen`.
3. `agent/agent.tsx`:
   - `needsOpen` state;
   - the banner `onClick` at `:694-706`;
   - a **needs you · N** header button near `:623`;
   - the other tabs' amber counts open that agent with the panel (`:592-603`);
   - `<NeedsPanel>` in `<Inspector>`'s place at `:760-762`;
   - `i` and the details button close it.
4. CSS for the panel in `attention/attention.css`, as `.atn-side`, with a width equal to
   `AGENT_NEEDS.fallback` and no border.
5. Add `AGENT_NEEDS` to `lib/verify.ts` §10b (`:505-557`) and to `settings/route.tsx:61-65`.
6. Tests in `attention/verify-needs-panel.ts`.

Keep these existing source checks passing: `agent/verify.ts:474-482`, `:687-693`,
`attention/verify.ts:444`, and `shell/verify.ts:219-223`.

**Lane B1 (109, daemon):** follow ADR 0008's git, routes and locks.
1. `workspace/branches.ts`: listing, merge, merge_all, commit, push and fetch.
   - Use `git()` from `workspace/git.ts`. Add an optional `{ env, timeoutMs }` parameter to
     `git()`, defaulting to today's behaviour, for push and fetch.
   - Check branch names against `for-each-ref` output, and pass `--` before them.
2. `routes/branches.ts`: the two routes, using the error codes in the ADR and the store
   for `jobId`/`live`. Broadcast `{ type: 'branches', projectId }` after each POST
   (`hub.ts:234`).
3. `workspace/verify-branches.ts`: every case in ADR 0008 § Testing. Use a scratch repo
   plus a bare `origin` in `tmpdir()`, on a port no other verify uses (not 7801).

Don't touch `packages/web`.

**Lane B2 (109, web):** build against the step 0 wire types. Lane B1's routes aren't
available yet, so the pure layout and the screen are tested with fixtures.
1. `branches/route.tsx` (screen 7), `branches/graph.tsx` (SVG, with a pure
   `layout(BranchesResponse)`), `branches/endpoints.ts` (`getBranches`, `branchAction`),
   and `branches/branches.css` (tokens only).
2. `shell/nav.ts`: `SCREEN.branches` and `openBranches`.
3. `shell/shell.tsx:215`: "1–7 screens".
4. `lib/screens.ts:25-35`: the reserved table.
5. `lib/store.ts`: handle the `branches` frame by bumping a revision the screen listens to.
6. Reword `lib/verify.ts:820-828`.
7. Tests in `branches/verify.ts`.
8. Use the crumb class `ui-crumb`. It arrives with lane C. Until then it renders plain.

Don't touch `packages/daemon`.

## Step 5: merge the lanes, test together, review, document

1. On `conductor/job_07af774e-eb6`, merge each lane with
   `git merge --no-ff --no-edit w8/<lane>`, in the order C, A, B1, B2. Expect clean
   merges. If one conflicts, it will be in `agent.tsx` (C and A) or `CONTRACT.md`: keep
   both sides and re-run that lane's verify.
2. `make test`, in full, once. Fix anything broken on this branch, not in a lane.
3. By hand: the checks in each ADR's § Testing. For the branches screen, use a throwaway
   branch. Don't push it to origin unless it's deleted there afterwards.
4. **Reviewer:** review the merged diff (`git diff main...HEAD`) against the three ADRs,
   reading `workspace/branches.ts` and `routes/branches.ts` most closely, because they're
   the first code that writes history and pushes. Fix what it finds, then `make test`.
5. **Scribe:** `docs/MANUAL.md`.
   - The screens table (`:714-725`): row 7 for Branches; the Agent row's Needs You panel;
     the crumb on Needs You, Preview and Files.
   - A short "Landing an agent's work" section: merge, commit, push, what each refuses,
     and how to undo a merge (`git revert -m 1`).
   - Fix the stale `7 Spawn` in `CONTRACT.md:81-93`.
   - Set ADRs 0006, 0007 and 0008 to "built as Amendment N".

## Step 6: merge everything to main, commit, push

This was asked for, so it's done without a further prompt. Stop and ask only if something
below fails.

1. Commit anything left on this branch, then confirm `make test` is green on it.
2. In the main checkout (`/Users/dtavares/development/conductor`, which is on `main`):
   - check `git status --porcelain` is empty, and stop if it isn't;
   - `git merge --no-ff --no-edit conductor/job_07af774e-eb6`.
3. **"All branches."** Run `git for-each-ref refs/heads --format='%(refname:short)'` and,
   for each branch other than `main`, `git rev-list --count main..<b>`. Merge any with
   commits not on main (`--no-ff`).
   - On 9 Oct, `conductor/job_91cc23e2-9b7` had none, being an ancestor of main.
   - The `w8/*` lane branches are already in through this branch.
   - On a conflict, `git merge --abort` and ask the user.
4. `make test` on main.
5. `git push origin main`, with no force.
6. Clean up the lanes:
   - `git worktree remove .claude/worktrees/w8-*`;
   - `git branch -d w8/107-crumb w8/108-needs w8/109-branches-daemon w8/109-branches-web`.

   `-d`, not `-D`, so only merged branches go. Leave the `conductor/*` branches alone: a
   Conductor job still uses its own.

## Risks to watch while building

- **The daemon and web may be running from the main checkout.** Merging into it changes
  their files under them. Vite reloads, and the daemon may need a restart (`make` target).
  Say so in the final report.
- **Push needs your SSH key in ssh-agent.** With `BatchMode=yes`, a locked key fails fast
  with git's message instead of hanging. That applies to step 6's push too, which runs from
  an agent's shell: if it fails on auth, stop and tell the user rather than retrying.
- **`AGENT_NEEDS` width.** On a narrow window, with the navigator at 236 px and the panel at
  340 px, the transcript gets tight. `share: 0.5` caps the panel.
