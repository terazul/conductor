# G1 design note: GitHub pull requests, opt-in, including "when done"

**Status:** design only, 15 Oct 2026, against `main` at `e1be4bd`. For the OK the lane spec asks for
([wave-11.md](wave-11.md) "I3 — G1", §6 G1, track 3 of [wave-11-tracks.md](wave-11-tracks.md)). No
code yet. Migration **280**. The build step folds this into the lane's amendment. Line numbers are
as of `e1be4bd`.

## 1. The setting

- **Where.** A daemon setting in `~/.conductor/settings.json` (`settings.ts:1-40`), like
  `conductor.budgetResumeAtMidnight`. Its key and parsers go in shared, as `budget.ts:86-94` does:
  `PULL_REQUESTS_KEY = 'conductor.pullRequests'`, values `on` | `off`, **absent = off**.
  `pullRequestsOn(v) => v === 'on'`. A `settingRule` (`settings.ts:33`) refuses anything else at
  the PATCH. The daemon reads it on every use with `readSettings()`, so a change applies at once.
- **Shown** in Settings as a new section, "Pull requests" (`settings/route.tsx:1060`), with on/off
  pills copied from `MidnightRow` (:288-312). Under it goes one line of what the gate says now
  (§2).
- **Off guarantees** (each one is tested):
  - no `gh` process runs at all, not even `auth status`;
  - `BranchesResponse.github` is absent;
  - Spawn, the composer and Settings → Launch defaults show no new pill;
  - the finished card has no Open PR;
  - `open_pr` → 409;
  - the card notes keep today's wording, word for word.

  One small exception: an agent launched with `openPrWhenDone` while the setting was on, whose
  job finishes after it was turned off, gets the ordinary finished card. It says why:
  "pull requests are off in Settings".

## 2. The gate

New `daemon/src/workspace/github.ts`, the only file that runs `gh`.

- **`parseGithubOrigin(url) → { owner, repo } | null`.** It accepts exactly these:
  - `git@github.com:o/r` and `git@github.com:o/r.git`;
  - `https://github.com/o/r`, with an optional `.git` and an optional trailing `/`;
  - `ssh://git@github.com/o/r(.git)`. This is the same host, and `gh` reads it. It is an open
    choice below.

  The owner must match `[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`. The repo must match
  `[A-Za-z0-9._-]{1,100}`, and may not be `.` or `..`. It refuses:
  - other hosts, including **GitHub Enterprise** (it would need `--hostname`, a per-host
    `auth status` and hosts we can't test);
  - `github.com.evil.com`, `http://`, `git://`, user-info in https, and extra path segments.
- **`githubGate(root) → GithubGate`**, in order:
  1. Setting off: return `{ on: false, ready: false }` and stop there.
  2. `git remote get-url origin` (no cache; one local git call), then parse it.
  3. `gh auth status --hostname github.com`, with a 10 s timeout. The result is cached for
     **60 s for the whole daemon** (sign-in belongs to the machine, not the repo). Calls that
     arrive while one is running share it. The cache is dropped when `conductor.pullRequests`
     changes (`onSettingsChanged`).

  The `why` texts:
  - "no origin";
  - "origin isn't on github.com (<host>)";
  - "gh isn't installed" (ENOENT);
  - "gh isn't signed in to github.com: <first line of its stderr>".
- **Per repo.** Branches has several repos since N4 (`project-repo.ts:198-215`). The gate is
  the opened repo's own origin, worked out per `?repo=`.
- **How the web learns it:**
  - **Branches:** a `github` field, stamped by the route next to `repo`/`repos`
    (`routes/branches.ts:60-64`). It is not in `listBranches`, which every action calls twice.
  - **Spawn, the composer and Needs You:** they have no Branches listing. They use a small new
    `GET /api/projects/:projectId/github?repo=` → `GithubGate` (open choice). The web caches it
    per project for the page's life, and fetches again on a `settings` change of the key.

## 3. `open_pr`

`BranchAction | { action: 'open_pr'; branch; title?; body? }`. It is parsed in
`parseBranchAction` (`branches.ts:197-262`) and runs in `act()` under the repo's lock, like push.

1. **The gate first.** Off, not GitHub, or not signed in → `BranchError(409, …)`, with no push
   and no `gh pr create`.
2. **Push, with the existing code.** The `push` case (`branches.ts:968-986`) becomes
   `pushOne(root, state, b)`, used by both actions:
   - it calls `known` and `refuseLive`;
   - a branch rebased after it was pushed gets the N3 refusal (`FORCE_SENTENCE`);
   - the refspec is explicit, without `+`, and run with `sshEnv()` and `REMOTE_TIMEOUT_MS`;
   - it always runs: on a branch that is already up to date, the push does nothing.

   The target itself is refused (400 "open a pull request from a branch other than <target>"),
   and so is a branch that isn't ahead (409 "nothing to open a pull request for").
3. **`gh pr create`**, with these arguments:
   `--repo github.com/<o>/<r> --head=<b> --base=<target> --title=<t> --body-file -`.
   - The body goes on stdin.
   - It has the same 60 s timeout, and `cwd` is the repo root.
   - `--head` means `gh` never offers to push the branch itself. `--repo` means a second remote
     (`upstream`) can't make it guess or prompt.
4. **What comes back.** The answer is the `https://github.com/<o>/<r>/pull/<n>` URL from stdout
   (matched exactly; anything else → 502 "gh answered without a pull request URL").
   - **An existing PR:** `gh` exits 1 with "a pull request for branch … already exists:
     <url>". That URL is pulled out and returned with `prExisting: true`. The push has already
     updated that PR, so this is a success.
   - **Any other failure:** 502 "gh pr create failed", with stderr in `detail` and "the push to
     origin went through" at the end. A timeout is 504. The push is never undone.

- **Base:** the screen's `target` (`repo.target`: chosen, else `origin/HEAD`, else the project's
  default, else main or master, `branches.ts:159-185`). That is what "ahead" and the merge already
  mean, so the PR is the same comparison the screen draws. There is no pre-check that origin has
  it: `gh`'s refusal is the answer.
- **Which branches:** any local non-target branch the screen lists, the same as Push. It isn't
  limited to job branches.
- **The live rule:** refused while an agent is on the branch (`refuseLive`, as Push is).
- **All repos:** it works on every `?repo=`. Push already does, and the gate is per repo. A
  nested or extra repo has no jobs (`openOther` matches none), so it takes the fallbacks below.
- **The title**, when the request has none:
  - the first non-empty line of the job's prompt, trimmed;
  - if the branch has no job, the tip commit's subject (`BranchInfo.subject`).

  Control characters are taken out, and it is cut to 200 characters (GitHub allows 256). A title
  in the request must be one line of 1-256 characters, or it's a 400.
- **The body**, when the request has none. See the finding in §10: the last stage never has a
  hand_off summary. In order:
  1. the job's last stage's hand_off summary (`getHandoff`, `store.ts:561`). "Last stage" means
     a top-level agent nothing waits for; the newest one if there are several;
  2. else that agent's last reply: the last `agent` turn of
     `turnsFromEvents(eventLog().conversation(id), job.prompt)`, as `supervisor.ts:1179` reads it;
  3. else, and for a branch with no job, the branch's commits as bullets (`BranchInfo.commits`,
     up to 20).

  It ends with "Opened by Conductor from job `<id>`." It is cut to 60,000 characters (GitHub's
  limit is 65,536), with "… (cut: N more characters)". A body in the request over 60,000 is a
  400.
- **The text comes from the store side.** `BranchRepo` gets an optional
  `prText(branch) → { title, body } | null`. `project-repo.ts` `openOwn` supplies it, the same way
  it supplies `lookup`, so `branches.ts` stays narrow.
- **A record for Needs You.** When the branch belongs to a job, a successful `open_pr` writes a
  `job_finishes` row of kind `pr`, through `finish.ts` `recordPr()`. It goes through
  `BranchRepo.onPrOpened?(branch, url, sha)`. That gives the "PR opened" card, whichever button
  opened it.

## 4. When done

- **`Autonomy.openPrWhenDone?: boolean`.** It copies every `mergeWhenDone` site:
  - `wire.ts:197`;
  - `routes/session.ts:114,124` (`parseAutonomy`);
  - `composer.tsx:152-161` (the pill);
  - `spawn/autonomy.ts:38-40` (the label/hint), :84 (`PILLS`), :123 (`defaultPills`), :192
    (`toAutonomy`);
  - and Settings → Launch defaults, which renders `PILLS` (`settings/route.tsx:600`).

  The pill is shown only while `gate.ready`.
- **Exclusive on the server.** `parseAutonomy` throws on both `true`, which is a **400** on
  `POST /api/jobs`, `POST /api/jobs/:id/agents` and `POST /api/agents/:id/autonomy`.
  "Last wins" can't be defined there: the autonomy POST merges into the stored value (:889).
- **Exclusive in the UI.** Turning one pill on sends the other as `false` in the same patch.
  - Spawn: `togglePill` (`spawn/route.tsx:520`) clears the pair's other pill.
  - The composer: the flip is `on ? { openPrWhenDone: true, mergeWhenDone: false } : { openPrWhenDone: false }`,
    and the same for merge.
- **In `finish.ts`**, after the checks at :112-120 and before :129:
  1. **Both kinds of agent.** One agent wants a merge and another a PR (the per-agent rule
     can't stop that): `offer("its agents asked for both a merge and a pull request, so
     neither was done by itself")`.
  2. **Neither wanted.** As today: `offer(null)`.
  3. **A merge wanted.** Today's flow, unchanged.
  4. **A PR wanted.** In order:
     - `notAllDone` → offer, as today;
     - the setting is off → offer("pull requests are off in Settings");
     - the gate isn't ready → offer(gate.why);
     - otherwise `branchAction(repo, { action: 'open_pr', branch })`;
     - on any refusal → `offer(sentence(err))`. A failure after the push says the push went
       through (§3). The card's Open PR is then the one-press retry.
     - On success: the `pr` row, a synthetic note in each agent's transcript (see below), and the
       outcome `{ outcome: 'pr', url, existing }`.

     The note: "Your branch X was pushed to origin and a pull request into <target> was opened:
     <url>, because 'open a pull request when done' was on. Nothing was merged; the job, its
     folder and the branch stay."
  - **Kept, not cleaned up.** The PR is open and unmerged. Review may need the agents again.
    `delete` refuses an unmerged branch anyway (`branch -d`). Conductor never merges the PR.

## 5. Cards

- **Finished (`finished`).** Its actions (`web/src/attention/alerts.ts:198-204`) gain
  `{ id: 'open_pr', projectId, branch, jobId }`. It is placed first when the agent asked for a
  PR, after merge otherwise, and only while the project's gate is ready. Pressing it calls
  Branches' `open_pr` and shows the URL or the sentence, the way `mergeFinished` (:222-235)
  shows its result.
- **PR opened**, new: kind **`pr_opened`**, id `pr:<row id>`, `cause: 'pull request opened'`.
  - Fields: `branch`, `into`, `ahead`, `sha` (the tip pushed), and a new **`prUrl`**.
  - `agentIds` are the job's agents (still there).
  - Actions: open the link (`<a target=_blank rel="noopener noreferrer">`, shown only if it
    matches `^https://github\.com/[^/]+/[^/]+/pull/\d+$`), open the agent, Branches, dismiss.
  - It is information only, until dismissed (`alert_dismissals`, as `merged` is).
  - `finishAlerts` (`finish.ts:194-229`) shows a job's offer only while it is that job's newest
    `offer`-or-`pr` row. So opening a PR replaces the finished card.
- **The reworded notes.** These apply only while the setting is on. Off keeps today's text.
  - Finished, `AlertCard.tsx:282`. Today: "Pushing stays on the Branches screen." New: "Open PR
    pushes the branch to origin, never forced, and opens a pull request into {into}; Conductor
    never merges it."
  - Merged, :290-291. Today: "Nothing was pushed." New: "Nothing was pushed: it merged here. 'Open
    a pull request when done' pushes and opens a PR instead."
  - `finish.ts:21`'s comment becomes "Merging never pushes; opening a pull request pushes first."

## 6. Migration 280

`packages/daemon/src/db/migrations/280_pr_url.sql`:

```sql
-- 280_pr_url — Track 3. A finished job's branch that ended in a GitHub pull request (Amendment N, G1).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- A third kind of `job_finishes` row (230), beside 'offer' and 'merged':
--   • kind 'pr' — the branch was pushed to origin and a pull request into `target` opened, or
--                 found already open; `pr_url` is its link and `sha` the tip pushed. Nothing was
--                 merged and nothing cleaned up (`cleaned` 0). Written by "open a pull request
--                 when done" (session/finish.ts) and by Open PR on a job's branch.
-- Null on every other row. Conductor never merges a pull request.
ALTER TABLE job_finishes ADD COLUMN pr_url TEXT;
```

`kind` has no CHECK in 230, so `'pr'` needs no change to the table. In `finish.ts`:
- `FinishRow` gains `pr_url: string | null`, and `kind` gains `'pr'`;
- `record()`'s INSERT (:69-72) gains the column (`null` for offer and merged);
- `finishAlerts` reads it into `prUrl`.

## 7. Wire (all additive)

```ts
// shared/src/github.ts (new, re-exported like budget.ts)
export const PULL_REQUESTS_KEY = 'conductor.pullRequests';
export const pullRequestsOn = (v: string | null | undefined): boolean => v === 'on';
export interface GithubGate {
  on: boolean;          // the setting
  ready: boolean;       // on, origin on github.com, gh signed in
  repo?: string;        // "owner/name", when origin parses
  why?: string;         // when on and not ready
}
// wire.ts
interface Autonomy { openPrWhenDone?: boolean }                      // beside mergeWhenDone, :197
type BranchAction = … | { action: 'open_pr'; branch: string; title?: string; body?: string };
interface BranchActionResult { prUrl?: string; prExisting?: true }
interface BranchesResponse { github?: GithubGate }                    // absent when off
type AlertKind = … | 'pr_opened';
interface Alert { prUrl?: string }
// web/src/attention/alerts.ts
type AlertAction = … | { id: 'open_pr'; projectId: string; branch: string; jobId: string } | { id: 'pr_link'; url: string };
```

`Finish` (`finish.ts:37-40`) gains `| { outcome: 'pr'; url: string; existing: boolean }`.

## 8. Tests

- **The fake `gh`.** It is `$ROOT/bin/gh`, a `#!/bin/sh` script. Each run, it appends its argv,
  its stdin and `git --git-dir=$ORIGIN rev-parse --verify refs/heads/<head>` to `$ROOT/gh.log`.
  That last one proves the push came before `gh`. It answers by the mode it reads from
  `$ROOT/gh.mode` each call, so a test changes the mode without a restart:
  - `ok`: prints a URL;
  - `exists`: exit 1, with the "already exists:" text;
  - `fail`: exit 1, with stderr;
  - `unauthed`: `auth status` exits 1.
- **Putting it on PATH.** The verify sets `process.env.PATH = $ROOT/bin:…` before `build()`.
  `github.ts` passes `{ ...process.env, GH_PROMPT_DISABLED: '1', … }` to `execFile`, and Node
  resolves `gh` through that env's PATH.
- **A GitHub origin that pushes to a local repo.** The test repo's origin `url` is
  `git@github.com:o/r.git`, for the gate, and its `pushurl` is the local bare repo
  (`git remote set-url --push`), so the push really lands.

| File | Section "G1" checks |
|---|---|
| `workspace/verify-branches.ts` | the parser: the three accepted forms, ± `.git`/`/`, and refusals (gitlab, GHE host, `github.com.evil.com`, http, extra segments, `-o`, `..`); off → `open_pr` 409, an empty `gh.log`, no `github` in the listing; `unauthed` → 409 with the why, and `github.ready` false; `ok` → the argv exactly, stdin = the body, origin had the branch when `gh` ran, `prUrl` returned, a `pr` row; `exists` → `prExisting`; `fail` → 502 with stderr, and origin still has the branch; a live branch or a rebased-after-push one → 409 with no `gh` run; the title and body fallbacks with no job; the target → 400; a nested `?repo=` with its own GitHub origin works |
| `session/verify-finish.ts` | `openPrWhenDone` → outcome `pr`, the target's sha unchanged, the job, worktree and branch kept, the transcript note, the `pr_opened` card, and the older offer hidden; both flags on one agent → 400 on the three routes; one flag on each of two agents → offer with the why; `gh` fails → offer whose why says the push went through; the flag stored with the setting off → offer "pull requests are off" |
| `web/src/attention/verify.ts` | the finished card's actions with the gate ready and not ready (no `open_pr`); `pr_opened`'s actions and labels, and a non-GitHub `prUrl` not made a link; the notes, word for word, in both setting states |
| `web/src/spawn/verify.ts`, `branches/verify.ts` | the exclusive toggle and `toAutonomy`; the pill hidden unless the gate is ready; Branches' `openPrReason` (`rules.ts`, beside `pushReason` :123) |

**P5** (person check) is a real PR on a throwaway GitHub repo, once by the button and once when
done.

## 9. Security

- No shell anywhere: `execFile('gh', [...])` with fixed argument arrays, in the one file.
- Values go after `=` (`--head=…`, `--base=…`, `--title=…`), so a value can't become a flag.
  Branch names are already refused when they start with `-`.
- The body goes on stdin (`--body-file -`, written to `child.stdin` as `checkIgnore` does,
  `git.ts:379-398`), never in argv, and never in a temp file.
- The env is `process.env` plus `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`,
  `GH_SPINNER_DISABLED=1`, `NO_COLOR=1` and `GIT_TERMINAL_PROMPT=0`. Conductor reads, stores and
  passes no token: `gh` uses its own sign-in.
- Never forced: the push is the existing code. Never merged: no `gh pr merge` or `gh api`
  anywhere, and a verify check greps the source for them.
- `prUrl` is stored only when it matches the exact URL pattern, and checked again before the
  link is drawn.

## 10. What contradicts the spec, and the open choices

**Found in the code:**
- **No hand_off summary on the last stage.** Only an agent that other agents wait for gets the
  `hand_off` tool (`supervisor.ts:1616-1624`). So a one-agent job, and the last stage of a
  pipeline, never has a hand_off summary, and "the body is the hand_off summary" would mostly be
  empty. Proposal: the fallbacks in §3, which are N13's "summary or last reply" (§6 N13).
- **Paths.** The spec's `workspace/finish.ts` (tracks §1) is `session/finish.ts`. Its
  `attention/alerts.ts` is `web/src/attention/alerts.ts` (actions). The daemon's cards are built
  in `finish.ts` `finishAlerts`.
- **Amendment 144 says "No push. As decided: pushing stays on the Branches screen"**
  (CONTRACT.md, Amendment 144). G1 amends that. §6 G1 decides it, so this isn't a stop.
- **No TODO.md entry for G1.** The build step adds one and ticks it (wave-11 §0).

**Open choices, each with a proposal:**
1. Open choice: accept `ssh://git@github.com/o/r(.git)` too? Proposal: yes; it is the same host,
   `gh` reads it, and it costs one pattern. GitHub Enterprise: no.
2. Open choice: how Spawn, the composer and Needs You learn the gate. Proposal: a new
   `GET /api/projects/:projectId/github?repo=`; Branches gets it inline.
3. Open choice: how long `gh auth status` is cached. Proposal: 60 s for the whole daemon, a 10 s
   timeout, dropped on a settings change. The press itself is the real test.
4. Open choice: the base. Proposal: the screen's target, not origin's default.
5. Open choice: what an "already exists" answer means. Proposal: success, with that PR's URL and
   `prExisting`.
6. Open choice: Open PR on any branch, or only a job's. Proposal: any non-target branch that is
   ahead, as Push is.
7. Open choice: every `?repo=`, or the project's folder only. Proposal: every repo; push already
   works there.
8. Open choice: the body's source. Proposal: the last stage's summary, else its last reply, else
   the commits, plus a footer line, cut at 60,000 characters.
9. Open choice: a draft PR? Proposal: no, a normal PR; Conductor never merges it either way.
10. Open choice: after a PR when done, clean up or keep? Proposal: keep the job, folder and
    branch.
11. Open choice: both flags at the server. Proposal: 400. Across two agents: no automatic action,
    and a card that says why.
12. Open choice: the notes with the setting off. Proposal: today's text, word for word ("nothing
    changes with it off"). The new wording only while on.
13. Open choice: Open PR on Branches for a job's branch also makes a "PR opened" card. Proposal:
    yes; one record of what became of a job, whichever button did it.

## Size, and what can be cut

About **5 agent runs**, L as §7 says:
- 2 for the daemon (`github.ts`, `open_pr`, the migration, `finish.ts`, the route and the
  endpoint, with their verify sections);
- 1-2 for the web (Settings, Branches, the pills, the cards, with their verifies);
- 1 for the review and fixes.

**"When done" can be cut on its own.** It is the `Autonomy` field, the two pills with their
exclusivity, and step 4 of §4 in `finish.ts`, with their checks. That is about 1 run.
Everything else (the setting, gate, button, `pr_opened` card and migration) stands without it.
Cut, the `pr` row is written only by Open PR.
