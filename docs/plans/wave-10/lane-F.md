# Wave 10, Lane F: git methodology, finished (Amendment 139)

The text below is for the merge to apply; this lane does not edit CONTRACT.md or docs/MANUAL.md.

## CONTRACT

### Amendment 139 — post-merge, applied. **A branch only on origin is tracked, Spawn lists the branches you can name, and a refusal is a sentence.**

Daemon, shared and web (`daemon/src/workspace/{git,worktree,branches}.ts`,
`daemon/src/session/supervisor.ts`, `daemon/src/routes/workspace.ts`, `shared/src/wire.ts`,
`web/src/spawn/{launch.ts,route.tsx}`). The wave 10 plan's Lane F: the four "Not done" of Amendment 115.
No migration.
- **A branch only on origin is tracked.** `branchExists` looks at `refs/heads/` only, so a name that
  existed only as `origin/<name>` was cut fresh from `HEAD`, with none of origin's commits. In
  `#addNamed`, after the same refusals in the same order (a name git rejects, 400; the default branch,
  409; one checked out somewhere, 409), a name with no local branch whose `refs/remotes/origin/<name>`
  exists (`originBranchExists`, new in `git.ts`) is added with
  `git worktree add --track -b <name> -- <path> origin/<name>`: a local branch at origin's tip with
  its upstream set, so a push goes back there. **Nothing fetches**: it is origin as last fetched (the
  Branches screen's **fetch**), and a name on neither is cut from `HEAD` with no upstream, as before.
- **`BranchesResponse.remoteOnly?: string[]`** (`wire.ts`, optional, so an older web reads the answer
  as it did). `listBranches` lists `for-each-ref refs/remotes/origin` (`originNames`), leaves out
  `origin/HEAD`, and removes every name with a local branch (`remoteOnlyNames`, pure), sorted. Empty
  for a repo with no origin. The Branches screen does not show it.
- **Spawn's branch picker.** (2)'s name field gets a `<datalist>` (`list="sp-branch-list"`), so it is
  still free text and a new name still works. `getBranches` is called when (2) is chosen and again
  when the project changes (not for a folder with no git); a failed fetch lists nothing.
  `branchOptions(res, defaults)` (pure, `launch.ts`) builds the list: the local branches first, in the
  daemon's order, then the origin-only ones labelled **on origin**. A local branch a named launch
  refuses is listed with why, not hidden: the project's default (`Project.defaultBranch`, the same one
  `branchProblem` refuses; the compared-with branch is not a default) as **default branch (refused:
  choose 1)**, one an agent is on as **an agent is on it (checked out)**, one some worktree has
  (the project's own folder included) as **(checked out)**. `pickedNote` puts a sentence under the
  field for the name typed: an origin-only one says a local branch tracking `origin/<name>` is made;
  a checked-out one says the launch will be refused, drawn as the field's problem note but **not**
  holding the launch back, since the list is what was true when it was fetched and the daemon has the
  last word. The pill's hint and the empty field's note say a branch only on origin is tracked.
- **`restoreFolder`, said plainly.** After `worktree prune`, and before `worktree add`, when
  `listWorktrees` shows the job's branch checked out at another path, it throws `FolderGoneError`:
  "`<branch>` is checked out in `<path>`; remove that worktree or check out another branch there, then
  recreate". `POST /api/jobs/:jobId/folder` already answers that error with 409 and the sentence;
  before, git's refusal was a 500. The project's own folder on that branch is named by its path.
- **`POST /api/workspaces`.** `fail()` answers a `LaunchBranchError` with its own status and
  `{ error: 'could not use that branch', detail: <the sentence> }`, the shape `POST /api/jobs` uses.
  The route still does not pass `named`, so nothing raises it there today; it is no longer a 500 if
  something does.
- **Not done.**
  - Spawn does not fetch, so a branch pushed to origin since the last fetch is neither listed nor
    tracked: it is cut from `HEAD` as a new one. **fetch** on the Branches screen first.
  - Only `origin`: a branch on another remote is not listed or tracked.
  - A browser's `<datalist>` cannot be greyed per option, so a refused branch says so in its label.
    Not looked at in a browser, in either theme.
  - The bootstrap `POST /api/workspaces` still resets an explicitly named branch with `-B`
    (Amendment 115's note stands).

**Verified:** `workspace/verify-methodology.ts` §11 (93 checks in all, 14 new), against a bare origin
with two branches the repo has never had locally, fetched once, one of them pushed to again since: the
listing's `remoteOnly` is both, sorted, without `HEAD` or `main`; `remoteOnlyNames` pure; a launch
naming one is 201, on a local branch whose upstream is `origin/<name>`, at origin's tip as fetched
with origin's file in it, and the later push is not there (nothing fetched); then it is not in
`remoteOnly`, naming it again is the usual 409, a bad name is still 400, the default still 409, and a
name on neither is cut from `HEAD` with no upstream. `session/verify-folder.ts` §5 (23 checks, 5 new):
the job's branch in another worktree → 409 with the sentence exactly, and nothing made; in the project's
own folder → 409 naming it; once free, recreated on its branch as before. `spawn/verify.ts` §22 (15 checks): the picker's order and labels, a daemon with no `remoteOnly`,
a name both local and on origin listed once, a compared-with branch that is not the default offered,
the two notes, a checked-out pick still launching, and the screen's source (the datalist, its fetch and
its keys). Also `workspace/verify-branches.ts`, `workspace/verify.ts`, `branches/verify.ts`,
`pnpm --filter @conductor/web verify` and `pnpm -r typecheck` green.

## MANUAL

Existing text (docs/MANUAL.md:278, the table under "Choose which branch the agents work on"):

```
| **2 · `⑂ new branch:`** *(a name you give)* | A separate worktree on the branch you name. A branch that exists is used as it is, with its commits; a new one is cut from what the folder has checked out. Your folder and your other jobs are untouched. **A name field appears under the pills, and the launch waits until it has a name git accepts.** |
```

Replacement:

```
| **2 · `⑂ new branch:`** *(a name you give)* | A separate worktree on the branch you name. A branch that exists is used as it is, with its commits; one that is only on origin gets a local branch that tracks `origin/<name>`, with origin's commits; a new one is cut from what the folder has checked out. Your folder and your other jobs are untouched. **A name field appears under the pills, and the launch waits until it has a name git accepts.** The field lists the project's branches as you type: local ones first, then those only on origin, marked **on origin**. The default branch and branches checked out somewhere are listed too, marked, because a launch on them is refused. You can still type a new name. |
```

Existing text (docs/MANUAL.md:284-288, "What choice 2 refuses"), unchanged, and after it a new paragraph:

```
**A branch on origin.** Spawn does not fetch. A branch is "on origin" as of the last fetch (the
Branches screen's **fetch**), so a branch pushed since then is not listed, and naming it cuts a new
branch from what the folder has checked out. Fetch first.
```

Existing text (docs/MANUAL.md:1216, troubleshooting, the end of the row "An agent says **lost its folder: it was deleted**"):

```
A job working in a folder of its own (branch or in place isolation) can't be recreated: put the folder back. |
```

Replacement:

```
A job working in a folder of its own (branch or in place isolation) can't be recreated: put the folder back. If its branch is checked out somewhere else by then, recreating is refused and the message says where: remove that worktree or check out another branch there, then recreate. |
```

## Makefile test line

none
