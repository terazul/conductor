# Plan: the seven TODO items of 7 Oct (Amendments 90–94)

## Context

On 7 Oct, TODO.md was cleared of the 43 items finished through Amendment 87, and the user
added seven. They fall into four areas:

| # | Item (TODO.md) | Area |
|---|---|---|
| 1 | Open nested repos and sub-repos as folders in Files | daemon tree |
| 2 | Files opens on the project you're in | Files screen and nav memory |
| 3 | Open folders, and files, from the left panel | navigator |
| 4 | Make "finished" easier to see | status marks |
| 5 | Make "working" easier to see | status marks |
| 6 | Show which agents finished, not only which jobs | status marks and seen |
| 7 | Make "Project" and "Agent" easier to see | top bar or screen headers |

Facts the lanes rely on:

- `git ls-files -co --exclude-standard` (`packages/daemon/src/workspace/git.ts:123-127`) lists a
  nested repo as one entry: `inner/` if it's untracked, `inner` if it's a submodule. This was
  checked in a scratch repo on 7 Oct. `buildTree` makes that entry a childless file leaf
  (`packages/daemon/src/workspace/tree.ts:140-169`).
- The project-folder tree endpoint already exists: `GET /api/projects/:projectId/dir/tree`
  (`packages/daemon/src/routes/workspace.ts:204`). So the navigator needs no new endpoint.
- A Files link `{ jobId: dirRoot(projectId, dir), path }` already opens a file
  (`packages/web/src/files/tabs.ts:319-336`).
- "The project you're in" is a variable in memory, `remembered` (`packages/web/src/shell/nav.ts:55-74`),
  and Files reads it once each time it mounts (`files/route.tsx:226-235`).
- Every status tag is one component, `Tag` (`shell/ui.tsx:47-55`), styled in `shell/ui.css:62-108`.
  The navigator has its own tag, `.sh-nav-tag` (`shell/shell.css:584-603`).
- "Seen" is per job (`packages/web/src/lib/seen.ts:68-113`, Amendment 87).
- The highest amendment in CONTRACT.md is 89.

## Wave 0: decisions before any code

TODO.md lists them under **Decide:**. Lanes can't start until each one is answered:

1. **Nested repos (item 1):** show their own changes, or browse only? And mark them as repos?
2. **Navigator folders (item 3):** fetch each folder when it's opened, or share the Files
   screen's tree? Mark changed files there too?
3. **Finished and working (items 4–5):** what "more visible" means. For example: a filled badge,
   a coloured card edge, a larger word, or a pulse while working.
4. **Agents finished (item 6):** an unseen mark per agent, or just **finished** on every done
   agent? Shown on the navigator's agent rows and the agent tabs too?
5. **Project and Agent (item 7):** the top-bar tabs, or the name in each screen's header?

Item 2 needs no decision, but it does need its failure reproduced first (lane B, step 1).

**Answered (7 Oct)**, with the design in [ADR 0003](../adr/0003-wave-7-visibility.md):

1. Browse all the way down and mark the folder as a repo, with its branch (`FileNode.repo`).
   Its changes don't show.
2. *(Architect's default)* Use `useFileTree(folder.root)`, mounted only while the folder is open.
   No change marks.
3. A filled badge and a 3px coloured left edge on the card and the lane. The working dot pulses,
   except under reduced motion.
4. Every done agent plainly shows **finished** (`STATUS_WORD.done`). Unseen stays per job.
5. The top-bar tabs.

## Options

| | Run order | Cost | Risk |
|---|---|---|---|
| **One item at a time** (TODO.md's standing rule, 30 Sep) | 7 items in sequence | Slowest | None from overlap |
| **Four lanes split by file, in one worktree; two small joins after** (as on 6 Oct) | Wave 1: 4 lanes; wave 2: 2 joins | Fastest | Lanes share a worktree, so each is barred from the others' files |
| **One worktree per lane, merged after** | Parallel | Merge work on CONTRACT, MANUAL and TODO | Conflicts in `shell.css` and `Navigator.tsx` |

## Decision (proposed)

Use four lanes split by file, as on 6 Oct. Agents don't edit CONTRACT.md, docs/MANUAL.md or
TODO.md. They return the text, and the integrator applies it, then commits each amendment
separately after a green `make test`. If the user prefers the standing rule, run the lanes
one at a time in the order A, B, C, D, E. The file ownership below still holds.

| Lane | Amendment | Items | Owns |
|---|---|---|---|
| **A. Nested repos** | 90 | 1 | `packages/daemon/src/workspace/tree.ts`, `workspace/git.ts`, `workspace/verify.ts`, `fixtures/make-scratch-repo.sh` (add a nested repo and a submodule) |
| **B. Files follows the project** | 91 | 2 | `packages/web/src/shell/nav.ts`, `files/route.tsx`, `files/tabs.ts`, `files/useTabs.ts`, `files/verify.ts`, `agent/route.tsx` and `agent/agent.tsx` (only the lines that say which project you're in) |
| **C. Navigator folders** | 92 | 3 | `packages/web/src/shell/navtree.ts`, `shell/Navigator.tsx`, `shell/shell.css` (the `.sh-nav-*` rules), `shell/verify.ts` |
| **D. Status marks** | 93 | 4, 5, 6 | `packages/web/src/shell/ui.tsx`, `shell/ui.css`, `fleet/card.tsx`, `fleet/project.tsx`, `fleet/lane.tsx`, `fleet/fleet.css`, `lib/seen.ts`, `lib/verify.ts`, `attention/notify.ts` (only if per-agent finished changes the badge) |
| **E. Project and Agent** | 95 | 7 | wave 2. The top bar's `.sh-screens` rules in `shell/shell.css` and `shell/shell.tsx`, or the screen headers in `fleet/project.tsx` and `agent/agent.tsx`, depending on decision 5 |

## Plan

1. **Wave 0:** the user answers decisions 1–5. Their answers go into TODO.md as
   *Decided (date): …*.
2. **Wave 1, in parallel:** lanes A, B, C and D.
   - **A.** Extend `buildTree` so that a listed entry which is a directory on disk is
     enumerated with its own `listFiles`, or with `walkFiles` if it has no git. Graft the
     result under that entry's path. Keep `NEVER_LISTED` and one shared `MAX_TREE_ENTRIES`
     budget across all nested repos, and report `truncated` as now. Guard against a
     nested repo that is a symlink back up the tree. Test it in `workspace/verify.ts`
     against the scratch repo: a nested clone's file shows up at its full path, a
     submodule's too, the cap still holds, and `node_modules` inside a nested repo stays
     hidden.
   - **B.** First reproduce the bug. Open a project's agent by URL (and by reload), then
     press `5`. Do the same from the Project screen with Files already holding another
     project's job. Then make one rule: the route's project, else the last project opened.
     A link that names a file still wins. Add `files/verify.ts` checks on `arrive` for
     each path.
   - **C.** Add a navigator node per directory under **Files**. A folder opens and closes
     like the other nodes (its id kept in settings, `navtree.ts:16`). A file click calls
     `navigate('files', { jobId: dirRoot(...), path })`. Fetch the tree as decision 2
     says. Add `shell/verify.ts` checks for the node ids and the link a file builds.
   - **D.** Restyle `Tag`, the card, the lane and the job header as decisions 3 and 4 say.
     If an agent gets its own unseen mark, extend `seen.ts` with agent ids alongside job
     ids, keeping the stored format readable by today's parser. Add `lib/verify.ts` checks:
     the contrast check (`lib/verify.ts:401-430`) still passes in both themes, and an
     agent is unseen, then seen.
   Each lane runs `pnpm -r typecheck` and its own verify file, not `make test`, because the
   lanes share a worktree.
3. **Wave 2, after A, C and D are committed:**
   - Amendment 94 carries the changes onto other surfaces:
     - D's filled marks on the navigator's job and agent rows (`Navigator.tsx:123-126`,
       `161-163`; `.sh-nav-tag`) and on the agent tabs;
     - `repo.branch` beside a nested repo's folder in the Files tree and the navigator.
   - Lane E (Amendment 95). It touches `shell.css` too, so it waits for C.
4. **Integrate:**
   - apply each lane's CONTRACT, MANUAL and TODO text;
   - tick the items in TODO.md;
   - run `make test`;
   - commit Amendments 90–95 one at a time, staging each lane's files.
5. **By hand:** `make restart`, then check each of the following in both themes:
   - a project with a nested repo opens all the way down in Files and in the navigator;
   - `5` from an agent opens that agent's project;
   - a cheap two-agent job shows **working**, then each agent's **finished**.

## Risks and open questions

- **Tree size.** Nested repos can be large. Without a single shared entry budget, one
  `vendor/` clone could fill the tree and hide the outer repo's files. Lane A must test this.
- **Speed.** `git ls-files` runs once per nested repo on every tree request, and the watcher
  (`workspace/watcher.ts`) may refresh often. Lane A should measure a project with several
  nested repos before relying on it.
- **Changes in nested repos.** `workspace/changes.ts` only sees the outer repo. If decision 1
  says nested changes should show, lane A grows into `changes.ts` and the diff routes. That
  may be worth its own amendment.
- **Lanes share a worktree.** A lane that strays outside its files can clobber another's. The
  integrator checks `git diff --stat` per lane before committing.
- **The badge.** If per-agent finished counts in the tab badge, it can double-count against
  the job's mark. Lane D decides one or the other, never both.
- **Untracked file.** `docs/plans/status-7-oct.md` was written in this worktree by another
  session on 7 Oct. It isn't part of this plan. Commit it or remove it separately.
