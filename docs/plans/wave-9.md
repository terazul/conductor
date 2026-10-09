# Plan: wave 9, built in parallel (Amendments 112, 114, 115, 116)

Design: [ADR 0009](../adr/0009-default-branch-terminal-methodology.md).

| Lane | Amendment | What | Owns |
|---|---|---|---|
| — (step 0) | 116 | "You asked" in `--you` | `agent/agent.css` `.ag-lastask*`, plus its check |
| T | 112 | Full terminal, macOS and Ubuntu | `daemon/src/terminal/*`, `routes/term.ts`, `web/src/agent/Xterm.tsx`, the Agent terminal tab, package.json and lockfile |
| D | 114 | Choose the default branch; check it out | `workspace/branches.ts`, `routes/branches.ts`, `session/store.ts` (project update), a new migration, `web/src/branches/*` |
| M | 115 | Git methodology per launch | `workspace/worktree.ts`, `routes/session.ts` POST /api/jobs, `supervisor.ts` createJob, `web/src/spawn/*`, `settings/route.tsx` isolation pills |

## Step 0: shared ground, on `conductor/job_07af774e-eb6`

1. **116, built here.** It's small, and nobody else touches it.
2. **Wire** (`shared/src/wire.ts`):
   - `BranchAction` gains `| { action: 'set_default'; branch: string; checkout: boolean }`.
   - `BranchesResponse` gains `rootBranch: string | null`.
   - `CreateJobRequest` gains `branch?: string`.

   Lane T adds its own terminal types at the end of the file, and nobody else edits it.
   To keep typecheck green until lane D lands, the daemon answers `set_default` with
   400 "not built yet" and returns `rootBranch: null`.
3. **`CONTRACT.md`:** stubs for 116 (written in full), 115, 114 and 112, above 113.
4. **`TODO.md`:** the next amendment is 117.
5. **Verify stubs, wired into `make test`:** `packages/daemon/src/terminal/verify.ts` (T) and
   `packages/daemon/src/workspace/verify-methodology.ts` (M). Lane D adds its cases to the
   existing `workspace/verify-branches.ts` and `branches/verify.ts`.
6. `make test` green, then commit.

## Lanes, in parallel

Each lane has its own worktree under `.claude/worktrees/w9-{t,d,m}`, on branch
`w9/<lane>`, cut from the step 0 commit. Each lane:

- runs only its own verify files and `pnpm -r typecheck`, never `make test`, because the
  database lock would collide;
- commits on its own branch with both trailers. The repo's governance hook needs
  `Co-authored-by: Durval Tavares + claude-code/us.anthropic.claude-opus-5-5,us.anthropic.claude-sonnet-5 <Durval Tavares@users.noreply.github.com>`;
- replaces only its own CONTRACT stub's body;
- leaves `MANUAL.md` alone.

## Merge

1. Merge into the job branch with `--no-ff`, in the order D, M, T.
2. Run `make test` once.
3. Update `MANUAL.md` in one pass.
4. Merge into `main` locally, with `--no-ff`.

**Not pushed:** this request didn't ask for a push.
