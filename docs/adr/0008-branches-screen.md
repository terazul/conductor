# ADR 0008 — A Branches screen (7): see a project's branches, merge into main, commit, push

- **Status:** built as Amendment 109 (9 Oct 2026). The plan is
  [docs/plans/wave-8-needs-panel-branches.md](../plans/wave-8-needs-panel-branches.md), lanes B1 and B2.
- **Asked for (9 Oct):** "a new tab number 7 — show the GitHub branches and give me an
  option to merge a branch into main, merge all branches into main, do a commit and push.
  Graphical if possible."
- **Decided by the user (9 Oct):**
  - **merging** is a merge commit (`--no-ff`);
  - **commit** commits a branch's uncommitted work in its worktree, with your message;
    **push** pushes main or the selected branch to origin;
  - **branches shown:** the repo's local branches, with origin's status for each, and a
    Fetch button.
- **Decided by the architect, as reversible defaults:**
  - the graph is drawn in plain SVG, not mermaid;
  - "main" is the project's `defaultBranch`;
  - nothing is ever forced;
  - every action is refused while an agent on the branch is live;
  - merging needs main checked out somewhere clean;
  - branches are never deleted (not asked for).

## Context

All daemon references are under `packages/daemon/src/`.

- **The daemon never writes history.**
  - Every git call goes through `git(cwd, args)` (`workspace/git.ts:56-77`). That uses
    `execFile`, `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=true`, and throws `GitError` with
    stderr.
  - The only writes are worktree add/remove and checkout (`workspace/worktree.ts:155-266`).
  - There is no merge, commit, push, fetch, log or branch listing anywhere. Nothing uses
    `gh`, octokit or a remote.
  - The only push-related code is the agents' deny rule `Bash(git push:*)`
    (`web/src/spawn/autonomy.ts:172`).
- **Branches and worktrees:**
  - A job's branch is `conductor/<jobId>` (`workspace/worktree.ts:111`), and its worktree
    is `<repo>/.conductor/wt/<jobId>` (`:47`, `:143`).
  - `listWorktrees` parses `worktree list --porcelain` into path, branch and head
    (`workspace/git.ts:340-363`).
  - `Project.defaultBranch` is the branch that was checked out when the project was added
    (`session/supervisor.ts:418-423`; `shared/src/wire.ts:34`).
  - Branches are never cleaned up (`workspace/service.ts:218`, `:240`).
- **Routes and guards:**
  - Each `routes/*.ts` default export is registered automatically (`index.ts:46-67`).
  - Every request is refused unless the host is local and the origin, if any, is local
    (`guard.ts:41-56`, `index.ts:80-103`). There's an optional bearer token.
  - Errors are `{ error, detail? }` (`shared/src/wire.ts:737-740`).
  - `KeyedLock` (`workspace/lock.ts:18`) serialises work per key.
- **The web side:**
  - Screens register themselves through `./*/route.tsx` (`web/src/main.tsx:20-41`). A
    `ScreenDef` is defined at `lib/screens.ts:44-55`.
  - Hotkey 7 is free (Amendment 42; `lib/screens.ts:25-35`).
  - The status bar says "1–6 screens" (`shell/shell.tsx:215`).
  - `api()` is at `lib/feed.ts:184-209`. `mermaid ^12` is a dependency, used via
    `lib/mermaid.ts` with `securityLevel: 'strict'`.
- **Environment:**
  - Git here is 2.53, but users may have older versions, so use nothing newer than 2.30.
  - This repo's remote is `git@github.com:terazul/conductor.git` (SSH).

## Options

### The graph

| Option | Cost | Risk | Later |
|---|---|---|---|
| A. Mermaid `gitGraph` from real history | Medium. Mermaid needs a sequential script (`commit`, `branch`, `checkout`, `merge`), so history has to be rebuilt into one; real DAGs with criss-cross merges don't map cleanly | Fragile layout on real repos; strict mode gives no click handlers, so selecting a branch needs a separate list anyway | Locked to mermaid's look |
| **B. Plain SVG drawn from per-branch facts (fork point, ahead, behind, uncommitted, origin)** | Medium. One React component, no dependency | Low. It shows each branch's relation to main, not every commit | Can grow a commit-level view later |
| C. A text list with badges, no graph | Low | — | Doesn't do "graphical" |

### Where a merge happens

| Option | Risk | Notes |
|---|---|---|
| **A. In the worktree that has main checked out (usually the project folder), only if it has no tracked changes** | Touches your checkout, but only when it's clean, and git refuses to overwrite untracked files | The normal `git merge`; it undoes cleanly with `merge --abort` |
| B. `merge-tree --write-tree` plus `update-ref`, touching no checkout | If main is checked out, its files silently go out of date | Needs git ≥ 2.38 |
| C. A temporary worktree for main | Main can't be checked out twice, so this only works when main isn't checked out | Edge case only |

## Decision

**Graph B, merge A.** If main isn't checked out anywhere, merging is refused with "check
out main somewhere first", which leaves room for C later.

### Wire (shared/src/wire.ts) — a public API, so settle it first

```ts
export interface BranchCommit { sha: string; subject: string; at: string }   // ISO

export interface BranchInfo {
  name: string;                       // 'conductor/job_…', 'main', 'feature/x'
  head: string;                       // sha
  subject: string;                    // tip commit
  at: string;                         // tip commit time, ISO
  isTarget: boolean;                  // the project's defaultBranch
  ahead: number;                      // commits on it not on target
  behind: number;                     // commits on target not on it
  forkedAt: string | null;            // merge-base sha with target; null if unrelated
  commits: BranchCommit[];            // target..branch, newest first, at most 20
  worktree: { path: string; uncommitted: number } | null;  // files changed, incl. untracked
  jobId: string | null;               // set when it is a known job's branch
  live: boolean;                      // an agent on that job is working, blocked or queued
  upstream: { ref: string; ahead: number; behind: number } | null;  // vs its upstream
}

export interface BranchesResponse {
  projectId: string;
  target: string;                     // defaultBranch
  remote: string | null;              // 'origin' if it exists
  targetCheckout: { path: string; clean: boolean } | null;  // where a merge would run
  branches: BranchInfo[];             // target first, then by tip time, newest first
}

export type BranchAction =
  | { action: 'merge'; branch: string }
  | { action: 'merge_all' }
  | { action: 'commit'; branch: string; message: string }
  | { action: 'push'; branch: string }
  | { action: 'fetch' };

export interface BranchActionResult {
  ok: boolean;
  merged: string[];                   // in order, for merge / merge_all
  conflict?: { branch: string; files: string[] };   // merge stopped here, aborted cleanly
  sha?: string;                       // new commit, for commit / merge
  output?: string;                    // git's own words, trimmed, for push / fetch
  branches: BranchesResponse;         // the state after, so the screen redraws once
}
```

### Routes (routes/branches.ts, new)

- `GET  /api/projects/:projectId/branches` → `BranchesResponse`
- `POST /api/projects/:projectId/branches` with a `BranchAction` body → `BranchActionResult`
- Errors are `{ error, detail }`:
  - 404: no such project.
  - 400: not a git repo, an unknown branch, or an empty commit message.
  - 409: the branch is live, main isn't checked out, main's checkout has changes, nothing
    to commit, or a push was rejected.
  - 504: fetch or push timed out.
  - 500: git failed (with stderr).

### Git (workspace/branches.ts, new; uses `git()` and nothing newer than git 2.30)

- **Listing:**
  - `for-each-ref refs/heads --format=…` gives name, sha, subject, committer date and
    upstream.
  - Per branch, `rev-list --left-right --count target...branch` gives ahead and behind,
    `merge-base`, and `log --format=… -n 20 target..branch` gives its commits.
  - The upstream's ahead/behind is `rev-list --left-right --count branch...upstream`.
  - `listWorktrees` shows which worktree has which branch, and `status --porcelain`
    counts the uncommitted files there.
  - `jobId` and `live` come from the store: the jobs whose `branch` matches, and whether any
    agent in them is working, blocked or queued.
- **merge:**
  1. Refuse if the branch is live, or if `targetCheckout` is null or isn't clean
     (`status --porcelain -uno` is empty).
  2. In `targetCheckout.path`, run `merge --no-ff --no-edit -m "Merge branch '<b>' into
     <target>" <b>`.
  3. On failure, collect `diff --name-only --diff-filter=U`, run `merge --abort`, and
     return `conflict`.
  - Uncommitted work in the branch's worktree isn't merged. The screen says so before you
    click.
- **merge_all:** each branch that isn't the target, isn't live and has `ahead > 0`, oldest
  tip first, one merge commit each. It stops at the first conflict (aborted) and returns
  what merged.
- **commit:**
  1. Refuse if the branch is live or has no worktree.
  2. In its worktree, `add -A` (which respects `.gitignore`), then `commit -m <message>`.
  - The author is the repo's own git config.
  - The target branch can be committed too, in its checkout. It's a branch like any other.
- **push:**
  - Run `push <remote> <branch>`, adding `-u` when it has no upstream. Never `--force`.
  - The environment adds `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless you've already
    set one, so SSH can't ask for a passphrase. Credentials come from your ssh-agent or
    credential helper, as they would in a terminal.
  - It times out after 60 s.
- **fetch:** `fetch <remote>`, with no `--prune`, and a 60 s timeout.
- **Locks and events:**
  - Every POST holds `KeyedLock` on `branches:<repoRoot>`, so two actions never interleave.
  - After a POST, a `branches` event is broadcast (`{ type: 'branches', projectId }`, a new
    `ServerFrame` member) so another open tab refreshes.
  - The web also refreshes on mount, on window focus, and when the project's `worktree`
    events change.

### Screen (web/src/branches/, new)

- **Registration:** `route.tsx` exports `screen = { id: 'branches', label: 'Branches',
  hotkey: '7', order: 65 }`. It reads `projectId` from the nav params, otherwise the
  project you're in (`shell/nav.ts`). Add `SCREEN.branches` and `openBranches(projectId)`.
  The status bar changes to "1–7".
- **Header:**
  - the shared crumb (`project / branches`, Amendment 107);
  - origin's name;
  - **⟳ Fetch**;
  - **⇉ Merge all into main (N)**, disabled with the reason when N = 0, main's checkout is
    dirty, or main isn't checked out.
- **Graph (`graph.tsx`), SVG:**
  - main is a horizontal rail across the top, with its recent commits as dots.
  - Each other branch is a row below. A curve leaves the rail at its fork point, then come
    its `ahead` commits as dots (with the subject on hover), then its tip label.
  - Badges on the row:
    - **↓N behind** main;
    - **± N uncommitted** (a hollow dot after the tip);
    - origin **↑a ↓b**, or **not on origin**;
    - **live** (the working colour) when an agent is on it.
  - A merged branch (ahead 0) draws dimmed, joined back into the rail.
  - Colours are tokens only; `--live` is used only for live.
- **Selecting a row** opens an action bar:
  - **Merge into main**, with a confirm naming the branch and N commits.
  - **Commit…**, a one-line message with the job's prompt as the default. Shown only when
    there's uncommitted work.
  - **Push to origin**, with a confirm. Shown when the branch is ahead of its upstream or
    has none.
  - Disabled actions say why: live, dirty main, or nothing to do.
- **Results:** conflicts list the files and say the merge was undone. Push and fetch show
  git's output. Errors use the screen's usual `errorText`.

## Consequences

- You can land agents' work from the UI. Every merge is one commit on main, undone with
  `git revert -m 1 <sha>`.
- **Merge and commit are local.** Push is the one action that leaves the machine, so it's
  confirmed and never forced.
- The daemon now writes history in your repo. That's a new kind of power for a
  localhost-only server, and it's bounded:
  - the same host/origin guard and optional token;
  - fixed argument lists through `execFile`, never a shell;
  - branch names checked against `for-each-ref` output before use, so a name can't become
    an option (`--` is passed before it as well).
- Agents still can't push (`Bash(git push:*)`). Only you can, from this screen.
- Hard to undo: a push. Easy to undo: everything else. The wire types are the part to get
  right first.
- Not done:
  - deleting merged branches or worktrees;
  - remote-only branches;
  - pull or rebase;
  - nested repos and a project's `extraDirs` (only `project.path`'s repo is shown).

## Testing

- **`workspace/verify-branches.ts`** (new, added to `make test`). A scratch repo in
  `tmpdir()` like `workspace/verify.ts:637-688`, with a bare repo as `origin`:
  - listing gives ahead, behind, fork point, uncommitted count and upstream;
  - merge makes a two-parent commit;
  - a conflicting merge returns the files and leaves main clean (no `MERGE_HEAD`);
  - a dirty main checkout gives 409;
  - a live branch gives 409;
  - merge_all merges in order and stops at the conflict;
  - commit with nothing to commit gives 409;
  - commit commits;
  - push to the bare origin works and sets the upstream;
  - a rejected push gives 409 and doesn't force;
  - a branch name starting with `-` gives 400.
- **`branches/verify.ts`** (web, new):
  - the graph's layout function is pure: rows, fork x and dot counts from a
    `BranchesResponse`;
  - the disabled reasons;
  - the screen registers hotkey 7, and nothing else claims it;
  - the status bar says 1–7.
- `lib/verify.ts:820-828` uses a synthetic hotkey 7. Reword it so it doesn't read as
  "7 is free".
- **By hand, on this repo:**
  - tab 7 shows `main` and the `conductor/*` branches;
  - Fetch;
  - commit a scratch change on a test branch, merge it, and see the merge on the rail;
  - push a throwaway branch to origin and delete it there by hand.
