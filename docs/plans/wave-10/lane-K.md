# Wave 10, Lane K: merge and clean up when a job finishes (Amendment 144)

The text below is for the merge to apply. This lane does not edit CONTRACT.md, docs/MANUAL.md,
the Makefile or TODO.md. Built on Lane J (Amendment 143).

## CONTRACT

### Amendment 144 — post-merge, applied. **Merge and clean up when a job finishes, by the agent's setting or a card.**

Daemon (`session/finish.ts` new, `session/supervisor.ts`, `session/alerts.ts`, `routes/session.ts`,
`db/migrations/230_finished.sql` new, `session/verify-finish.ts` new), shared (`wire.ts`), web
(`spawn/autonomy.ts`, `agent/composer.tsx`, `attention/alerts.ts`, `attention/AlertCard.tsx`,
`shell/describe.ts`, and the verify files). From the wave 10 plan (Lane K), with Q6 as decided on
13 Oct: a setting on the agent, "merge and clean up when done"; when it is on and the merge is
clean it happens by itself; when it is off, or the merge can't run cleanly, Needs You offers it.

**The setting** (`shared/src/wire.ts`). `Autonomy.mergeWhenDone?: boolean`, absent is off. The
daemon's `parseAutonomy` (`routes/session.ts:114`) keeps it only when it is `true`, so a launch, an
added agent and `POST /api/agents/:agentId/autonomy` (which merges over the stored autonomy) all
take it, and `false` or anything else removes it. Labelled **merge into main and clean up when
done** (`MERGE_WHEN_DONE_LABEL`, `spawn/autonomy.ts`), with one hint (`MERGE_WHEN_DONE_HINT`): the
branch is merged, then the job, its folder and its branch are removed, its agents can't be
messaged afterwards, their transcripts stay, and it never pushes.
- **Spawn.** A pill of `PILLS` (`spawn/autonomy.ts:84`), off in `defaultPills`; `toAutonomy` adds
  `mergeWhenDone: true` when it is on (`:192`) and changes no tool list, so every agent of the
  launch has it, a reading role too. Being a pill, **Settings → What Spawn starts from** shows it
  and keeps it in `conductor.launch.pills`; a saved set from before reads it as off.
- **The composer.** A pill with the guardrails (`agent/composer.tsx:150-160`), so it folds with
  them; it sends `{ mergeWhenDone: on }` alone.

**When a job finishes** (`session/supervisor.ts:1888`). `#rollUpJob` calls `#finished(jobId)` only
on the way into `done` (not when it settles `failed`, and not on a roll-up that changes nothing).
`finishJob` (`session/finish.ts`) runs after it, never throws (a failure is logged and the job left
as it is), and `Supervisor.finishing(jobId)` is the run in flight, for the verify. It does nothing
for a job that isn't isolated in a worktree of its own, or whose branch isn't ahead of the target
(`resolveTarget`'s, as the Branches screen draws). Otherwise, through `projectRepo`
(Amendment 143), as the Branches screen would:
- **The setting asked** (any agent of the job has `mergeWhenDone`), every agent of the job is
  `done` (a paused one may still need the folder), and Amendment 110's `previewMerge` gives no
  reason (so the target is checked out, clean, and nothing is live on either side) and no
  conflicts (`[]`; `null`, "this git can't tell", counts as not clean): the branch is merged with
  `branchAction` `merge` (the screen's merge, `--no-ff`, into the target), then removed with
  Amendment 143's `delete` and `forgetJob: true` (the job as DELETE /api/jobs/:jobId removes it,
  then `git worktree remove`, `prune`, `git branch -d`). This is the user's explicit opt-in. Each
  of the job's agents gets a synthetic `user_text` note in its transcript: what was merged into
  what, the short sha, and that the job, its folder and its branch were removed and the
  transcript stays. Needs You gets an information card, **Merged**.
- **Any step refuses, it stops there.** A preview reason, a conflict, an agent not done, or a
  merge that conflicts anyway (undone, as always): nothing is merged, and the card below says why
  (`detail`). A merge that went in with a clean-up that was then refused (an untracked file in the
  folder, say): the **Merged** card says it was not cleaned up and why, the agents' notes say so,
  and the job, its folder and its branch stay. No "merge?" card is raised for a branch already
  merged.
- **Otherwise** (the setting off): nothing moves, and Needs You asks.
- Nothing here pushes. Push stays a separate, confirmed action on the Branches screen.

**The cards** (`db/migrations/230_finished.sql`, `finishAlerts` in `session/finish.ts:194`). One row
of `job_finishes` per outcome (`offer` or `merged`), with the branch, the target, how far ahead,
the job's agents, the sha, whether it was cleaned up and why not. No foreign key to `jobs`: the
clean-up it reports removes the job. Alerts are derived from it, as the others are from what is
stored, so a restart keeps them; dismissals are `alert_dismissals`, and a write refreshes Needs You
(`onFinishesChanged`).
- **`finished`** (`Alert.kind`), id `finished:<row>`: the newest offer per job, while that job is
  still there and `done` (a job that runs again asks again when it next finishes; one that was
  removed has nothing left to offer). `branch`, `into`, `ahead`, `agentIds`, and `detail` when the
  setting asked and something refused.
- **`merged`**, id `merged:<row>`: every one, until dismissed. `sha`, `cleaned`, and `detail` when
  not cleaned up; `agentIds` empty once cleaned up.
- **Wire.** `AlertKind` gains `'finished' | 'merged'`; `Alert` gains `branch?`, `into?`, `ahead?`,
  `sha?`, `cleaned?`.

**Web** (`attention/alerts.ts`, `AlertCard.tsx`, `shell/describe.ts`).
- **Finished: merge into <target>?** (`alertTitle`; the top bar's word is "finished: merge?"),
  labelled **Finished** in `--need`, with the branch and its commits, and "not merged by itself"
  with the reason when there is one. Its buttons (`alertActions`, `:198`): **merge and clean up**
  first, which asks (`finishedConfirm`, `:213`: "Merge <branch> into <target>, then remove job
  <id>, its folder and its branch? Its agents can't be messaged afterwards; their transcripts
  stay."), then `mergeAndClean` (`:239`); **merge** (`mergeFinished`, `:222`): the preview first,
  refused with its reason or its conflicts named, then `POST …/branches { action: 'merge', branch,
  into }`, and the card is dismissed; the job, its folder and its branch stay. **open Branches**
  (`openBranches`), and dismiss. `mergeAndClean` is the same merge, then `{ action: 'delete',
  branch, forgetJob: true }`; a refused clean-up says "merged as <sha>, but not cleaned up: <the
  daemon's sentence>".
- **Merged**, in `--done`: the branch, the merge's short sha, "not cleaned up" with why when so, and
  a line saying the agent's setting did it and nothing was pushed. Open the agent (when it is still
  there), open Branches, dismiss.

**Verify.** daemon `session/verify-finish.ts` (port 7817, 38 checks, a real repo with real
worktrees, a fake SDK whose runs end at once, so each job settles through `#rollUpJob`): the
setting through the autonomy route (on, off, anything but true is off); on with a clean merge:
main has the merge commit, the job row and its agent are gone, its folder and branch are gone, its
transcript is kept with the note naming the sha, the **Merged** card says cleaned with the sha, and
no "merge?" card; on with a conflict: the card naming the file, main unmoved, nothing removed; on
with main's checkout dirty: the card with the merge's reason, nothing merged; on, merged, with an
untracked file in the folder: merged, the card says not cleaned up and why, everything still there,
the note says so; off: the card with no reason, nothing moved, then the card's calls: the preview
clean, merge keeps the job, folder and branch, dismiss puts the card away; off, merge then delete
with `forgetJob` removes the job, folder and branch, keeps the transcript, and the card goes with
the job; no card for a branch that isn't ahead or a job in the project folder; nothing pushed.
web `attention/verify.ts` §11 (16 checks): the buttons and their order, what they carry, the
confirm text, the titles and the top-bar word, and the calls behind them against a stand-in daemon
(preview then merge; preview, merge, then delete with `forgetJob`; a conflict or a reason stops
before the merge; a refused clean-up says the merge went in), and the card's wiring.
`spawn/verify.ts` §24 (9 checks): the pill, its words and hint, off by default, `toAutonomy` with
and without it, every spec of a launch, Settings keeps it and an older saved set reads it off.
`agent/verify.ts` (3 checks): the composer's pill, the field it sends, with the guardrails.

**Not done / not decided:**
- **Only `done`.** A job that settles `failed` gets no card.
- **Only into the target.** The card and the setting merge into the branch the Branches screen
  compares with when the job finished; the label says "main" as the plan words it.
- **The card stays after a merge made elsewhere** (on the Branches screen, say) until it is
  dismissed or pressed; pressing it then says there is nothing to merge.
- **No push.** As decided: pushing stays on the Branches screen.

## MANUAL

1. docs/MANUAL.md:615, Spawn's pills table. Existing text (the anchor):

```
| **allow MCP tools** | Off (the default) means every MCP tool call waits for you. |
```

Replacement:

```
| **allow MCP tools** | Off (the default) means every MCP tool call waits for you. |
| **merge into main and clean up when done** | Off (the default) means a finished job's branch waits for you: Needs You asks **Finished: merge into main?**. On, when the job finishes on a branch of its own and the merge would be clean, the branch is merged into main, then the job, its folder and its branch are removed. Its agents can't be messaged afterwards; their transcripts stay. Nothing is pushed. See "When a job finishes" (§3). |
```

2. docs/MANUAL.md:780, the end of the Alerts table. Existing text (the anchor):

```
| **Waiting** | An agent waits on one that failed or was stopped. Behind a failed one, such as the reviewer after a failed developer, it stays queued and starts once that one is done. Behind a stopped one it is paused (see "Stopping an agent", §7). | Behind a failed one: **continue** it (when its session can be resumed), open it, or dismiss. Behind a stopped one: **resume** the waiting agent to run without it, open the stopped one, or dismiss. |
```

Replacement:

```
| **Waiting** | An agent waits on one that failed or was stopped. Behind a failed one, such as the reviewer after a failed developer, it stays queued and starts once that one is done. Behind a stopped one it is paused (see "Stopping an agent", §7). | Behind a failed one: **continue** it (when its session can be resumed), open it, or dismiss. Behind a stopped one: **resume** the waiting agent to run without it, open the stopped one, or dismiss. |
| **Finished: merge into main?** | A job on a branch of its own finished, and its branch has commits main lacks. When its agent had **merge into main and clean up when done** on but the merge couldn't run by itself, the card says why (a conflict, named; main's checkout has changes; an agent not done). | **merge and clean up**, which asks first, then merges and removes the job, its folder and its branch (its agents can't be messaged afterwards; their transcripts stay); **merge**, which only merges, so the job and its folder stay and its agents can still be messaged; **open Branches**; or dismiss. |
| **Merged** | Its agent's **merge into main and clean up when done** merged a finished job's branch. The card names the branch and the merge commit, and whether the job, its folder and its branch were removed; when they weren't, why. | Open Branches, or dismiss. |
```

3. docs/MANUAL.md:782-783, after the Alerts table. Existing text (the anchor):

```
An alert stays until the daemon says the problem is gone, or until you dismiss it.
Dismissing is remembered across reloads.
```

Replacement:

```
An alert stays until the daemon says the problem is gone, or until you dismiss it.
Dismissing is remembered across reloads.

### When a job finishes

A job on a branch of its own (**new branch:** or **new branch per launch**) that finishes
with commits main lacks is not merged by itself, unless you asked. Ask per agent: tick
**merge into main and clean up when done** in Spawn (Settings can make it what Spawn starts
from), or in an agent's settings on the Agent screen. Then, when the job finishes, every
agent in it is done and the merge would be clean, Conductor merges it into main the way the
Branches screen does, then removes the job, its folder and its branch. Its agents can't be
messaged afterwards; their transcripts stay, each with a note saying what was merged and
removed, and Needs You shows a **Merged** card with the merge commit. If anything refuses —
a conflict, main's checkout has changes, an agent that isn't done — nothing is merged and
you get the **Finished: merge into main?** card instead, saying why. Nothing is ever pushed:
push from the Branches screen.
```

4. docs/MANUAL.md:875, the Agent screen's row of the screens table. Existing text:

```
set guardrails (allow bash / write / web / MCP tools / git push)
```

Replacement:

```
set guardrails (allow bash / write / web / MCP tools / git push, and merge into main and clean up when done)
```

## Makefile test line

```
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-finish.ts
```

(after the `src/session/verify-answer.ts` line, the last of `test:`).
