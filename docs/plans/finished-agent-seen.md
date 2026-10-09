# Plan: an agent's "finished" clears once you've opened it (Amendment 105)

Design and reasons: [ADR 0005](../adr/0005-finished-agent-seen.md). Web only: no daemon, wire
or database change. One commit, with its CONTRACT amendment and a green `make test`.

**Status: built (9 Oct), `make test` green, not committed, not yet checked in a browser.**
Steps 1-7 are done; step 8's `make test` is done and the hand check is still open. Where the
build differs from the steps below, it says so under "As built" at the end.

## Steps

1. **`packages/web/src/lib/seen.ts`**: add the agent half below the job half, matching its
   style and doc comments:
   - `SEEN_AGENTS_KEY = 'conductor.seenAgents'`, `SeenAgents { since; agents }`.
   - `parseSeenAgents` / `serializeSeenAgents`: the same rules as `parseSeen`/`serializeSeen`
     (`seen.ts:42-60`). Missing or broken gives `since: null`.
   - `unseenDoneAgents(agents, seen)`: `since === null` gives `[]`. Otherwise
     `status === 'done'`, `endedAt` not null, `endedAt > since`, and no entry or
     `endedAt >` the one seen.
   - `markAgentsSeen(seen, ids, agents)`: as `markSeen` (`seen.ts:93-107`). Drop unknown
     ids, keep each id's current `endedAt`, and return null when the serialised value is
     unchanged.
   - Live: `markAgentSeen(id, agents)` reads `readSetting(SEEN_AGENTS_KEY)` now and writes
     only a change. It does nothing for an undefined id or an agent that isn't unseen.
     `useUnseenAgents()` returns a memoised `Set<string>` of ids from `useAgents()` and
     `useSetting(SEEN_AGENTS_KEY)`.
   - `startSeenOnce` (`seen.ts:127-131`) also writes `SEEN_AGENTS_KEY` from `new Date()` if it
     is missing. Update the file's header comment to say agents are kept too.
2. **`packages/web/src/attention/always.tsx:78-83`**: in the same effect, after
   `markJobsSeen(...)`, call `markAgentSeen(onAgent, agents)`. It stays behind
   `if (!visible) return`. Add `useUnseenAgents()` to the deps only if it's needed to re-fire.
   `agents` already changes when an agent ends, so the agent you're watching is marked as it
   finishes. Update the comment above it.
3. **`packages/web/src/shell/navtree.ts`**:
   - add `finished: boolean` to `NavAgent` (`:55-62`), with the comment "Done, and you
     haven't opened it since (Amendment 105)".
   - `navTree(..., finished, finishedAgents: ReadonlySet<string> = new Set())`
     (`:136-143`); the rows (`:164-170`) set `finished: t.status === 'done' && finishedAgents.has(t.id)`.
     Note that `t.status` is `blocked` when something waits on you (`agent/tabs.ts:51`), so a
     held hand-off shows the need, not finished. That's right.
   - fix any other `NavAgent` literals the type checker finds.
4. **`packages/web/src/shell/Navigator.tsx`**: `const unseenAgents = useUnseenAgents();`
   next to `useUnseenJobs()` (`:455`). Pass it into `navTree` (`:469-470`, deps too).
   `AgentRow` (`:138`) shows the tag on `a.finished`.
5. **`packages/web/src/agent/agent.tsx`**: `const unseenAgents = useUnseenAgents();` near
   the tabs (`:571`). The tag (`:599`) becomes
   `t.status === 'done' && unseenAgents.has(t.id)`. Update the comment above it.
   The header `Tag` (`:617`) stays as it is.
6. **Tests**, all run by `make test` (`Makefile:164-176`):
   - `packages/web/src/lib/verify.ts`: a new numbered section after 31 (`:1169-1205`) with
     the cases listed in ADR 0005 § Testing. Add a short clause to the PASS line (`:1274`).
     *(Built as section 34, not "after 31": 32 and 33 already existed.)*
   - `packages/web/src/shell/verify.ts`: `navTree` with and without an unseen set. Change
     the source check `:429-431` to `a.finished &&`, and update `:358` to the new `navTree` call.
   - `packages/web/src/agent/verify.ts:477-478`: check the new tab condition and the
     `useUnseenAgents` import.
   - a source check that `always.tsx` calls `markAgentSeen` inside the visible guard (in
     `attention/verify.ts`, next to any existing Notifier checks).
     *(Built in `lib/verify.ts` section 34 instead: the existing `always.tsx` checks are in
     section 31 there, not in `attention/verify.ts`.)*
7. **Docs**:
   - `CONTRACT.md`: Amendment 105 above Amendment 104 (`:199`), "post-merge, applied", in the
     house format. Say that it narrows Amendment 94 for the navigator rows and the tabs.
   - `docs/MANUAL.md:648-682`, "When a job finishes": the paragraph on the navigator and
     tabs (`:671-674`) now says an agent's **finished** there stays until you open the agent,
     and comes back if it finishes again. The lane and header still say finished plainly.
     Remove "which is still the only thing 'unseen' tracks" (`:665-666`).
   - `TODO.md:14`: the next amendment is 106. *(Now 107: Amendment 106 was added too.)*
   - ADR 0005: set Status to "built as Amendment 105" once it's merged.
8. `make test`, then check by hand with the steps in ADR 0005 § Testing (`make` targets or
   `/run` to start the daemon and web app).

## As built

Differences from the steps above:

- **Tests.** The `always.tsx` guard check is in `lib/verify.ts` section 34 (see step 6). The
  validator added `packages/web/src/lib/verify-seen-agents.ts` (40 checks), wired into
  `make test` by one `Makefile` line after `shell/verify.ts`. It uses the real `settings.ts`
  store without a daemon and covers: `startSeenOnce` writing both keys once with the same
  `since`; the upgrade case (`seenJobs` present, `seenAgents` absent); an old-bundle
  rewrite of `seenJobs` leaving `seenAgents` alone; the finish, open, re-run, finish-again
  lifecycle; two quick marks both landing; and the navigator and tab source conditions.
  Putting the tab tag back to status-only makes it fail, which was checked and restored.
- **`shell/verify.ts`.** The `groupByJob` literals gained `finished: false`; `:358` now expects
  `…, finished, unseenAgents)`; the `AgentRow` check is `a.finished &&` and also asserts the
  old status-only form is gone.
- **`agent.tsx`.** `useUnseenAgents()` is called with the other hooks (~`:445`), not "near the
  tabs": `AgentScreen` has an early return (~`:531`), so a hook after it would break hook
  order.
- **Amendment 106, not in this plan.** The user also asked that the text they type in the
  output areas get a different, more highlighted colour. The architect did not plan it, so
  the developer built it as its own amendment: new token `--you` (violet, `#c4a8ff` dark,
  `#6236b0` light) in `packages/shared/src/tokens.css`; `.ag-msg.is-you:not(.is-auto)` in
  `agent/agent.css` (label, left bar and text in `--you` on a 10% tint); `agent/transcript.tsx`
  adds `is-auto` for synthetic turns, which keep the neutral look; `'you'` added to the TEXT
  list in `lib/verify.ts` section 9; an `agent/verify.ts` "Your turns" section; CONTRACT
  Amendment 106, the MANUAL screen-3 row. Contrast was measured at at least 4.5:1 on every
  surface and, with the tint, 6.09:1 (dark) and 5.16:1 (light) at worst. The CONTRACT says
  "about 5:1", which is true, but no test asserts the tinted figure. Violet is the
  developer's default; the user has not confirmed it.
- **Docs.** CONTRACT Amendment 105 (above 104; 106 is above it), the MANUAL "When a job
  finishes" paragraph rewritten, `TODO.md` now says the next amendment is 107.

## Known limits (reviewer and validator, none blocking)

- A corrupted `conductor.seenAgents` value is never repaired: `startSeenOnce` writes only when
  the key is missing, so no agent would say **finished** again. `seenJobs` behaves the same.
  Pinned by a LIMITATION check in `verify-seen-agents.ts` section F. A fix would be to write
  when `parseSeenAgents(...).since === null`. Left alone unless the user wants it.
- An agent that finishes while its screen is open and the tab is in front is marked seen at
  once, so its own tab never says **finished**. Intended (the ADR says so) but it may surprise.
- `markAgentsSeen` drops entries for agents missing from the list it is given, as the job half
  does. The store hydrates all agents at once, so a partial list is theoretical.
- `pnpm --filter @conductor/web build` fails with ELOOP while copying
  `packages/web/public/fixtures/scratch-repo` (git-ignored, created by
  `fixtures/make-scratch-repo.sh` during `make test`). Not caused by 105 or 106; worth a
  CLEANUP item.

## Commits

Nothing is committed (the user has not asked). One commit per amendment is the house rule, but
**105 and 106 share hunks** in `CONTRACT.md`, `docs/MANUAL.md`, `TODO.md`, `lib/verify.ts` (the
`'you'` TEXT entry) and `agent/verify.ts`, so splitting needs `git add -p`. The earlier
statement that only 105 touches the shared files was wrong. The 105 commit also takes the
untracked `docs/adr/0005-finished-agent-seen.md`, this plan, `lib/verify-seen-agents.ts` and the
`Makefile` line. `TODO.md`'s "next amendment is 107" belongs with the second commit (106); the
first commit would say 106.

## Still open

- Hand check in a two-agent stack: the first agent finishes and its row and tab say
  **finished**; open it and both clear; re-run it and both say it again once it ends.
- Hand check of Amendment 106: typed turns read violet in both themes, **auto** turns stay plain.
- The user to say whether violet is the colour they want.

## Not in scope

- Desktop notifications or a tab-badge count per agent.
- Opening a project clearing its agents' tags.
- Any change to failed or stopped agents: they have no **finished** tag now, and they still
  won't.
