# Plan — build the open TODO items in parallel (10 Oct 2026)

Source: [TODO.md](../../TODO.md). The user said "execute and implement all TODO and parallelize
when possible" (10 Oct). Where an item had open questions, the recommended answer I gave on
10 Oct is taken as decided; each lane lists the ones it uses. Last time's rules still hold:
[todo-parallel-execution.md](todo-parallel-execution.md).

## Lanes

| Lane | Item | Amendment | Migration | Owns (mostly) |
|---|---|---|---|---|
| T | Full terminal, macOS and Ubuntu | 112 (stub in CONTRACT) | — | `daemon/src/terminal/*`, `routes/term.ts`, `web/src/agent/Xterm.tsx`, the Agent terminal tab, `package.json`s, lockfile |
| M | Git methodology per launch, and the two Spawn gaps | 115 (stub in CONTRACT) | 180 | `workspace/worktree.ts`, `POST /api/jobs`, `createJob`, `web/src/spawn/*` (not `personas.ts`, not the briefs in `presets.ts`), `settings/route.tsx` isolation pills |
| L | Loose ends of 99–104, and tightening the handoff (101) | 120 | 160 | `session/handoff.ts`, `session/rerun.ts`, the hold on the wire, the re-run button, `hand_off` surfaces on Fleet |
| F | Create a new file in Files | 121 | — | `files/*`, `workspace/service.ts` write route, `WriteFileRequest.createOnly` |
| X | Metrics tab | 122 | 170 | new `metrics/*` in daemon and web, the `usage` event's new fields, `SCREEN` and the key `8` |
| R | Model retry with back-off | 123 | — | `#settle` retry branch, `session/alerts.ts` retry alert, the retry card and agent line |
| B | Agent budget warns instead of stopping (124), and colours as it fills (125) | 124, 125 | 190 | `session/budget.ts`, the budget code in both backends, `web/src/shell/spend.ts`, composer budget line, inspector bar, tabs, Fleet card |
| P | Better instructions for the built-in roles | 126 | — | `spawn/personas.ts`, the brief strings in `spawn/presets.ts`, `docs/plans/role-definitions.md` |
| U | One backdrop colour per screen (Project vs Agent) | 127 | — | `shared/src/tokens.css`, `fleet/fleet.css`, `lib/verify.ts` colour checks |
| O | Orchestrated stacks (wave 2, after the rest are merged) | 128 | — | `routes/helpers.ts`, `startHelper`, `orchestratorSection`, an orchestrated preset, the orchestrator's look |

Not code, settled in this plan:
- **"An agent's own cap doesn't go back to zero at midnight"**: closed. The status bar half is
  Amendment 103. Agent and job caps stay lifetime caps (Amendment 77); a per-day cap was never
  confirmed and would change what "budget reached" means.
- **"Look at 99–104 in a browser"**: the user's. Nobody can do it for them from here.
- **"Clear out wave 9's worktrees and branches"**: narrowed to the one folder left,
  `.conductor/wt/job_07af774e-eb6`, which waits for the user's yes.

## Rules for every lane

1. **Your own worktree and branch**, cut from `main`. Never the main checkout, where the daemon
   and Vite run, and never another job's folder under `.conductor/wt/job_*`. Never push.
2. **Use only your reserved amendment and migration numbers**, in code comments, test titles,
   the commit message and the migration filename.
3. **Do not edit `CONTRACT.md` or `TODO.md`.** Write the amendment text to an untracked
   `AMENDMENT.md` (or `AMENDMENT-N.md`, one per amendment) at your worktree root, in the style of
   Amendment 98's section, saying what is not done. The integrator pastes it in.
4. **Do not run `make test` or the daemon smoke.** Run `pnpm -r typecheck` and the verify files
   for what you touch (list in the Makefile). Run `packages/daemon/src/session/verify.ts` (and any
   other daemon suite that opens the shared test database) only inside the lock:
   `until mkdir /tmp/conductor-test.lock 2>/dev/null; do sleep 3; done; <command>; s=$?; rmdir /tmp/conductor-test.lock; exit $s`
5. **Add tests at the end of each file's section list**, so merges are easy. Keep logic in pure
   functions so it tests directly.
6. **One commit per amendment**, with a literal heredoc message ending in
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (a hook rejects a message it
   cannot see). Do not commit `AMENDMENT*.md`.
7. **Update `docs/MANUAL.md`** for anything a user will see.
8. **Both themes**: use existing tokens; the contrast checks in `lib/verify.ts` must still pass.
9. **Report honestly**: SHAs, files, every command with pass or fail, what you could not run,
   decisions the item did not settle, and what the integrator must watch.

## Where lanes touch the same files

- `session/supervisor.ts`: L (re-run marker), R (`#settle` retry), B (budget stop in `#settle`
  and `#launch`), M (`createJob`), X (usage). Keep edits inside the function you own.
- `session/backends/claude.ts`: X (`usage` event, ~588), R (`api_retry`, ~549), B (`maxBudgetUsd`,
  ~231). Different regions.
- `shared/src/wire.ts`: F, X, L, R, B, M each add to it. Add at the end of the type or file you
  extend, never in the middle.
- `spawn/*`: M and P. M owns routes, pills, `custom.ts`, `order.ts`; P owns `personas.ts` and
  brief strings only.
- `session/verify.ts`, web `verify.ts` files: everyone appends.
- `composer.tsx`: B only.

## Order

1. **Wave 1, in parallel:** T, M, L, F, X, R, B, P, U.
2. **Integrate in amendment order** (112, 115, 120 … 127), each in the integration worktree:
   apply the lane's commit, resolve conflicts, paste its amendment (replacing the stub for 112 and
   115, at the top of the log otherwise), take its item off `TODO.md`, run the full `make test`
   alone, commit. Fast-forward `main` when all are green.
3. **Wave 2:** lane O from the new `main`, integrated the same way.
4. **Clean up** my worktrees and branches (never `.conductor/wt/job_*`). Nothing is pushed or
   restarted; the user does both.

## Not done by design

- Real-SDK and real-API checks (a re-run of a parked agent; the role text compared old against
  new on a real bug). They cost money and need a person watching.
- Anything that needs to be looked at: drag and drop, the new screens, the new card, in both themes.
