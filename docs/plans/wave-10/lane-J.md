# Wave 10, Lane J: delete merged branches safely (Amendment 143)

The text below is for the merge to apply. This lane does not edit CONTRACT.md, docs/MANUAL.md,
the Makefile or TODO.md.

## CONTRACT

### Amendment 143 — post-merge, applied. **Delete merged branches safely, one or all, never a folder an agent can still resume in.**

Daemon (`workspace/branches.ts`, `workspace/project-repo.ts` new, `routes/branches.ts`,
`workspace/verify-branches.ts`), shared (`wire.ts`), web (`branches/rules.ts`, `branches/route.tsx`,
`branches/branches.css`, `branches/endpoints.ts`, `branches/verify.ts`). From the wave 10 plan (Lane J).
It takes back Amendment 109's "no branch is ever deleted".

**The rule, from 9 Oct.** A `done` job's agent can be messaged again, and it then needs its folder:
removing a done job's worktree broke a user's agent (Amendment 114 is what that agent saw). So
nothing here removes a folder or a branch a job's agent could resume on, unless you choose to forget
that job too, and the job's transcripts are always kept.

**Wire** (`shared/src/wire.ts`). `BranchAction` gains `{ action: 'delete'; branch; forgetJob? }` and
`{ action: 'clean_merged'; forgetJobs? }`. `BranchActionResult` gains `removed?: string[]` (in order),
`kept?: { branch, why }[]` (clean_merged: each merged branch it left, with the sentence `delete`
refused it with) and `forgotJobs?: string[]` (the jobs removed first). Nothing else changed.

**`delete`** (`workspace/branches.ts`, `deleteOne` `:708`). Parsed like every action (`:221`): an
unknown branch or one starting with `-` is 400, and so is a `forgetJob` that isn't a boolean. Every
check runs before anything changes, each a 409 with one plain sentence, in this order:
- it is the **target** ("… is the branch everything is compared with; it isn't deleted here");
- it is checked out in the **project's own folder** (`rootBranch`, or a worktree at the project's
  path), read from `git worktree list` afresh rather than the listing's `worktree`;
- it isn't **merged** into the target: no target branch at all, no shared history, or `ahead > 0`
  ("… has N commits main doesn't; it isn't merged, and git branch -d would refuse it");
- what `git branch -d` will judge it by: its upstream when it has one (`upstream.ahead > 0` is
  refused, "… and git branch -d checks against it; push it first"), else HEAD where `-d` runs, which
  is the target's checkout (else the repo's top level, checked with `merge-base --is-ancestor` first).
  So `-d` can't refuse after the folder has gone;
- its worktree has **uncommitted** files, `status --porcelain`, untracked ones included (a folder that
  can't be read is refused too);
- a job on it has a **live** agent (`working`, `blocked`, `queued`), even with `forgetJob`;
- a job **owns** it (any job of the project on that branch, or whose folder is that worktree, plus
  the listing's `jobId`) and `forgetJob` isn't set: *"job <id>'s agents can still be messaged, and
  they need this folder; remove the job, or choose 'forget the job too'"* (`ownedSentence`, `:689`).

Past them: with `forgetJob`, each owning job is removed first exactly as DELETE /api/jobs/:jobId
removes it (`Supervisor.deleteJob`: the job row and its agents go, the events table keeps their
transcripts, the workspace is forgotten rather than closed); then `git worktree remove -- <path>`
(never `--force`), `git worktree prune`, and `git branch -d -- <name>` (never `-D`) in the target's
checkout. A git refusal there is a 409 with git's words. Remotes are never touched. The answer is
`{ ok: true, merged: [], removed: [name], forgotJobs, output }` (git's "Deleted branch …").

**`clean_merged`** (`:914`). Every branch but the target with `ahead === 0` and history in common
(`mergedBranches`, `:785`), oldest tip first, one at a time, each against a fresh listing, through
the same `deleteOne` with `forgetJobs` as its `forgetJob`. A refusal doesn't stop it: the branch is
listed in `kept` with its sentence. `{ ok: true, merged: [], removed, kept, forgotJobs }`. Unmerged
branches are not listed.

**The store's side** (`workspace/project-repo.ts`, new). `projectRepo(db, projectId, forgetJob)` builds
the `BranchRepo` from the store as `routes/branches.ts` did (target, `live`, `rootLive`,
`setDefault`), plus `BranchRepo.jobs` (`BranchJobs`, `branches.ts:72`): the project's jobs read afresh
each time, and `forgetJob`, which the route passes as `supervisor().deleteJob`. The `jobId`/`live`
lookup is re-read after each forgotten job. `openRepo` takes it as a last optional argument (no jobs,
nothing to forget, by default). Amendment 144 opens a project's branches through the same function.

**Screen** (`branches/route.tsx`, `rules.ts`).
- **Delete** in the action bar of every branch (`route.tsx:637`), disabled with its reason from
  `deleteReason` (`rules.ts:233`) otherwise: the daemon's checks in its order, worded for the bar.
  The jobs that own a branch are `ownersOf` (`:216`): the listing's `jobId` and every job of the
  project in the store on that branch. With one, a checkbox **forget its job too (its transcripts
  stay)** (`FORGET_LABEL`) sits beside it, unticked each time a branch is selected; ticked, the
  delete sends `forgetJob: true`. **Delete** asks first (`deleteConfirm`, `:255`), naming the branch,
  its folder (or that it has none), that origin keeps its copy, and, forgetting, the jobs and that
  their agents can't be messaged afterwards while their transcripts stay.
- **⌫ Clean up merged (n)** in the head (`route.tsx:298`), n the branches that would go with the
  checkbox as it is (`cleanState`, `:266`); disabled with a reason when nothing is merged, or when
  every merged branch is kept for a reason even with jobs forgotten. Its confirm lists each branch
  that would go as `branch · folder · job` (`cleanLine`), then each that would stay with why, the
  same checkbox (sending `forgetJobs: true`), **Clean up** and Cancel.
- The result says what went and which jobs were forgotten (`removedText`), and lists each kept
  branch with its sentence. Styles: `.br-clean-list`, `.br-check` (tokens only).

**Verify.** daemon `workspace/verify-branches.ts` §13 (47 checks; 183 in all), in a repo of its own
whose project folder is on a branch that isn't the target: each refusal (the target, the folder's
branch, unmerged, a commit the upstream lacks, an untracked-only folder, a live job even with
`forgetJob`, a done job without it, bad `forgetJob`, `-` and unknown names) leaves the branch, and the
folder where there is one; a plain merged branch and one with a clean folder are removed (folder,
worktree entry and branch gone, "Deleted branch" said); a pushed one goes locally and stays on
origin; a done job's branch with `forgetJob` removes the job row and its agent, keeps its events, and
removes its folder and branch; the source uses `'branch', '-d'` and never `-D` or a forced worktree
remove; `clean_merged` removes the plain one and keeps a stopped job's, an uncommitted one, the live
one, the unpushed one and the folder's own, each with its sentence, never listing the target or an
unmerged branch; with `forgetJobs` it removes the job-owned one too, oldest tip first, transcripts
kept; origin's refs are exactly as before. web `branches/verify.ts` §10 (29 checks): every
`deleteReason` sentence, the owners, the confirm texts, `cleanState` with and without forgetting,
the result text, and the route's Delete, checkbox, confirm, actions sent and kept list.

**Not done / not decided:**
- **Remote branches** are never deleted, here or anywhere.
- **A job's folder that is the project folder** (`in_place`, `branch` isolation): the job still owns
  the branch, so it is kept unless forgotten; the folder itself is never removed (the branch checked
  out there is refused).
- No undo. A deleted branch's commits are in the target (that is what merged means), and git's
  reflog keeps the tip for a while.

## MANUAL

1. docs/MANUAL.md:879, the end of the Branches row of the screens table. Existing text:

```
A merge runs only when main's checkout has no uncommitted changes, and a conflict is undone with its files listed. Nothing runs on a branch an agent is working on, and no branch is ever deleted. |
```

Replacement:

```
A merge runs only when main's checkout has no uncommitted changes, and a conflict is undone with its files listed. Nothing runs on a branch an agent is working on. **Delete** removes a branch that is merged into main, and its folder (see [Delete merged branches](#delete-merged-branches)); **⌫ Clean up merged (n)** does it for every merged branch at once. |
```

2. docs/MANUAL.md:1109-1111, a new section at the end of "Editing or removing a project", before
"## 5". Existing text (the anchor):

```
If any agent in the project is still running, the removal is **refused** and names
the ones in the way. Interrupt them on the Agent screen first — Conductor won't
kill work in flight on a button labelled "remove".
```

Replacement:

```
If any agent in the project is still running, the removal is **refused** and names
the ones in the way. Interrupt them on the Agent screen first — Conductor won't
kill work in flight on a button labelled "remove".

### Delete merged branches

On the Branches screen (`7`), select a branch and press **Delete**, or press
**⌫ Clean up merged (n)** in the head to do every merged branch at once. Either asks
first, naming each branch, its folder and its job. A branch goes with its folder:
`git worktree remove` (never forced), then `git branch -d` (never `-D`). Origin is never
touched: a branch you pushed stays there.

**Delete** is greyed, with the reason beside it, when the branch:

- is main (the branch everything is compared with), or is checked out in the project's
  own folder;
- isn't merged into main: it has commits main doesn't, or it has commits its upstream on
  origin doesn't (`git branch -d` checks against that; push it first);
- has uncommitted files in its folder, untracked ones included;
- has an agent working, blocked or queued on it;
- belongs to a job. **A finished agent can still be messaged, and it needs its folder
  then**, so a job's branch stays unless you tick **forget its job too (its transcripts
  stay)**. Ticked, the job is removed first, as **✕** on the Project screen removes it:
  its agents can't be messaged afterwards, and their transcripts and spend stay in the
  history.

**Clean up merged** tries every merged branch, oldest first, one at a time, with the same
checkbox for the jobs. The ones it can't remove stay, and the result lists each with the
reason.
```

3. docs/MANUAL.md:1271, after the "lost its folder" row of the troubleshooting table. Existing text
(the anchor):

```
| Removed a project by mistake | The files, worktrees and branches are all still there (§4). Add the folder again; you get a fresh project, and the old transcripts and spend history are gone for good. |
```

Replacement:

```
| Removed a project by mistake | The files, worktrees and branches are all still there (§4). Add the folder again; you get a fresh project, and the old transcripts and spend history are gone for good. |
| **Delete** on the Branches screen is greyed | The reason is beside it: the branch isn't merged into main (merge it first), has uncommitted files (commit or discard them), has an agent on it (wait), is checked out in the project's folder (switch it), or belongs to a job, whose agents may still be messaged and need its folder. Tick **forget its job too** only when you are done with that job. |
```

## Makefile test line

none
