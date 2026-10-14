# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 128 has been cleared;
the last of it on 12 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 148.
- Open items are `- [ ]`. A question that needs the user's answer before building is under
  **Decide:**, and the answer goes beside it in italics, as *Decided (date): …*.
- Not planned: Windows (dropped 10 Oct). The terminal (Amendment 112) and the rest are built and
  tested for macOS and Ubuntu only; the old command runner is the fallback where no PTY loads.

## Right now

- [ ] **Never give up on the model: wait for it to come back, then resume.** Asked for (14 Oct);
  this replaces "back off to every hour". Today an agent that can't reach the model retries on its
  own (`daemon/src/session/retry.ts`: 5 s, 15 s, 30 s, 60 s, 5 min by default, Amendments 123 and
  140), each try a fresh Claude Code process resuming its session. After roughly 7 minutes it is
  `failed`, and it fails its job. The count is in memory (`RetryBook`, retry.ts:258), so a restart
  forgets it. An outage is one thing that hits every agent on the provider (Alerts already shows it as
  one card, `alerts.ts:256`), but each agent retries it separately. Making those separate retries go
  on hourly would leave N processes launching every hour, none of them knowing about the others.
  - **The first tries stay as they are.** These are the agent's own short waits
    (`conductor.retryDelays`), because most blips are over in seconds.
  - **After the last wait, the agent waits for the model, not for a clock.** It isn't `failed`:
    it stays resumable, its session kept, its job not failed. The wait is stored on the agent row
    (a column such as `waiting_model`: cause, provider, since), not only in memory, so it survives
    a restart.
  - **One probe per provider, not one retry per agent.** The daemon asks the provider whether it
    answers, at 30 s, 1, 2, 5 and 15 min, then every 15 min. Claude's probe is the call
    `session/models.ts:80-112` already makes: `GET /v1/models` on `ANTHROPIC_BASE_URL`, with
    the credential it already reads. It's free and starts no process. Copilot and OpenRouter use
    their backend's `listModels()`. A probe also runs at once when the clock jumps (the laptop
    woke from sleep), and when you press **retry now**.
  - **When the probe answers, resume the agents one at a time.** Start one, and once the model
    replies to it (`answered`, retry.ts:330), start the rest a few seconds apart. All at once
    would hit the same rate limit again.
  - **A throttle says when.** If the provider says when it will answer again (`Retry-After`, or a
    usage limit's reset time), wait until then instead of probing, and say so on the card ("the
    model's limit resets at 15:00").
  - **What doesn't wait:**
    - a login or billing problem (`ACCOUNT_ERRORS`, retry.ts:50): it needs a person, and goes
      straight to Needs You, as now;
    - a bad request or a retired model (`NEVER_BETTER`): it would fail the same way every time;
    - Conductor's own budget pause (Amendments 125, 140): that's a decision, not an outage.
  - **Needs You:** one card per provider for the whole outage: "can't reach the model since 14:02 —
    6 agents waiting, next check 14:47". Its buttons: **retry now** (probe now), **stop waiting**
    (on the card for all of them, and on each agent for one; it ends them `failed` as today), and
    a link to the agents. The fleet status bar shows that the provider is down.
  Starts at: `retry.ts` (`decideRetry` returns a third answer, "wait for the model", once the tries
  are spent), a new `session/outage.ts` (the per-provider probe and its schedule, on retry.ts's
  `Clock` so session/verify.ts can drive it), a migration for the column, the supervisor's
  `#settle` and its boot-time resume (a row that is `waiting_model` rejoins its provider's outage),
  and `alerts.ts` for the card.
  **Decide:**
  - Is "waiting for the model" a new agent status, or `paused` with a reason? Hard to undo: it's in
    `shared/src/events.ts:26` and every client reads it.
  - Should the probe cap at 15 min or at an hour?
  - Is there a limit at all: give up after a day, or never?
  - While its agents wait, does a job show as running or as waiting?
  - Are new launches on a provider that's down held, or allowed to try?

- [ ] **Queue work for an agent until it is done.** Asked for (14 Oct). Beside **⏲ later**'s date and
  time, a **queue** choice: the message waits until the agent's turn ends (it is `done`, or stops to
  wait on you after finishing what it was doing), then goes as if you had pressed send. Several
  queued messages go one per turn, in order, each when the agent is done with the one before. They
  show in the same list above the message box (Amendment 111's scheduled messages), as **⏲ when
  done**, cancellable. Settle: whether a queued message also waits for a question it asked you, and
  whether "done" means its turn or its whole job.

- [x] **Push `main`.** Amendments 99-129 are only on this machine. `git push origin main` is a *Done 13 Oct: pushed.*
  fast-forward. The database was copied to `~/.conductor/backups/` before the new migrations (160, 170
  and 200); they have run (checked 12 Oct: `metrics_daily` and the new `agents` columns exist).

- [x] **Make a missing install say so.** Found (12 Oct). After the terminal landed, the browser showed *Done 13 Oct: Amendment 134.*
  Vite's `Failed to resolve import "@xterm/xterm"` overlay until `pnpm install` was run, because
  `make start` doesn't check. `pnpm install --frozen-lockfile --offline` fixed it from the local store.
  Have `make start` (or `make init`) notice that `pnpm-lock.yaml` is newer than `node_modules`, and
  either run the install or stop with one sentence saying to. Add a row to the troubleshooting table
  in `docs/MANUAL.md` too.

- [x] **A throw before a run begins keeps its slot (wave 11, A1).** Found (14 Oct) for docs/plans/wave-11.md. *Done 14 Oct: Amendment 148.*

## Housekeeping

- [x] **Clear out wave 9's worktrees and branches.** *Done 13 Oct: by hand; and Amendment 143 adds a safe clean-up to the Branches screen.* Found (10 Oct). The job `job_07af774e-eb6` is
  `done`, but its folder `.conductor/wt/job_07af774e-eb6` (with `w9/d`, `w9/m`, `w9/t` under
  `.claude/worktrees/`) and branch `conductor/job_07af774e-eb6` are still there, and
  `conductor/job_91cc23e2-9b7` is a recreated folder. Everything on them is on `main` (the terminal
  and methodology lanes were rebuilt on other branches as 112 and 115). **Ask first** which folders
  are still in use: a `done` job's agent can be messaged again, and its folder is needed then
  (Needs You → recreate folder makes it again from its branch, or from `main`, without anything that
  wasn't committed).

## Checks that need a person

- [ ] **Look at what was built in Amendments 99-129 in a browser, in both themes.** Found (10 Oct).
  `make test` passes and the colour checks hold, but nobody has seen most of it.
  - Spawn: the ↑ ↓ buttons, the drag grip and the **waits for** ticks on preset and Custom rows, and
    **↺ back to …** (99); the three branch pills and the name box (115); the label backdrops of
    the Project, Agent and Fleet screens side by side (127); the **orchestrated pipeline** preset, its
    listed roles with their tiers, and the **◆ orchestrator** mark on the plan row, the Project lane,
    the Fleet row and the Agent tab, and no mark on a one-agent stack (128).
  - Files: the **+** on a folder row and on a tree's heading, the name box, and an empty file (121).
  - The Agent screen: the terminal tab (112; checked in headless Chrome on macOS in both themes),
    **↻ re-run after this** and its disabled state for a held agent (102, 120), the reconnecting banner
    (123), the over-budget line, the budget colours in the composer, details bar and tab (124, 125).
  - Fleet and Project: the **not handed off** chip (120) and the budget meter on each agent row (125).
  - Needs You: the **Not handed off**, **Reconnecting** and **Over budget** cards (104, 123, 124).
  - Metrics, key `8` (122).
  - Midnight (103, 129): a tab left open past midnight reads $0.00 on the status bar, and an agent's
    own budget (the composer's "$4.10 of $25 today") reads $0 again, with its over-budget warning
    gone. Moving the system clock forward is enough to see both. An agent paused at its ceiling
    stays paused, and the Budget reached card says its budget is renewed and offers **continue**.
  - The details panel's **today** and **lifetime** lines, and the wording "budget per agent per
    day" in Spawn (129).

- [ ] **Run the new behaviour once against a real model.** Found (12 Oct). Everything in 100-129 passes
  its tests on fakes; nothing has run on the real SDK, Copilot or OpenRouter. It costs money and needs
  someone watching. In this order:
  - A two-agent stack where the first ends its turn without `hand_off`: it is held, the card shows,
    you edit the summary and send it, and the next agent starts with that summary on top (104, 120).
  - An orchestrated pipeline on a small task (128): does it write full briefs, read each result, stop
    sending work back after two and ask you with the question tool?
  - A real outage, with the network unplugged mid-run: the banner counts down 5 s, 15 s, 30 s, 60 s,
    5 min; **retry now** and **stop retrying** work; a reply starts the count again (123).
  - An agent with a $1 budget (124): the warning at $1, the stop at $2, **+$10** raising it.
  - Metrics (122) after a resumed run: a resume adds only the difference. Also check that
    `duration_api_ms` is a running total; the SDK's types don't say, and `session/metrics.ts` assumes it.

- [ ] **A re-run of a parked agent, tried against the real SDK (Amendment 102).** Found (10 Oct).
  A re-run resumes a session that ended on `tool_deferred` with a prompt. `sendMessage` already does
  that for a message, but only a fake backend has run it, and a real run costs money and needs a
  person watching. Try it once on a real parked agent.

- [ ] **Compare the new built-in role instructions with the old on one real bug (Amendment 126).**
  Found (10 Oct). Run the bug fix and full stacks on one known bug with the old prompts and the new,
  and compare the hand-offs. It needs real agent runs and spend, so it was not done.

## Loose ends from Amendments 112-128

Taken from each lane's own "not done" list, found 12 Oct. Checked in the code on 12 Oct: the Needs You
header, the terminal's fixed font and missing add-ons, Custom's missing orchestrated row, the
navigator's missing marks and meters, the in-memory window registry, the fixed 2× ceiling, and the
stale comment in `lib/verify.ts`. The rest are as the lanes reported them.

- [x] **Terminal (112).** *14 Oct: checked by hand, it works on Ubuntu and macOS.* *13 Oct, Amendment 141: settings, find, links, clipboard, WebGL, mouse, paths into Files, the Terminal dock, the terminals frame and the headless mirror are built; still to check by hand in a browser and on Ubuntu; tmux is not wanted (Q5).* Only macOS arm64 ran; Ubuntu is untried, and so are `vim`, `htop` and `less`
  in the browser. Left out of the first version, from `docs/plans/full-terminal.md`:
  - a Terminal dock under every screen (D8b), and shells that survive a daemon restart (tmux, where
    installed);
  - settings for the shell, font size (13 px) and scrollback (5,000 lines), which are fixed in
    `web/src/agent/Xterm.tsx:55-56`;
  - the search, links, clipboard and WebGL add-ons, and mouse reports (`onBinary`);
  - a hub frame so a terminal opened in one tab shows in another, and the headless mirror the plan
    wanted in place of the raw 512 KB replay.
  - **Token mode.** *Done 13 Oct: Amendment 137.* With `CONDUCTOR_TOKEN` set, `/ws` and `/ws/term` are refused to a browser even with
    the right `?token=`, because the `Authorization` check in `index.ts` also runs on the upgrade and a
    browser can't set that header. `/ws` did this before the terminal; it needs its own fix.

- [x] **Git methodology (115).** *Done 13 Oct: Amendment 139.*
  - A branch that exists only on a remote is treated as new and cut from `HEAD`, not tracked.
  - Spawn has no branch picker; you type the name.
  - `restoreFolder` on a job whose named branch got checked out elsewhere fails with git's own
    message. Say it plainly.
  - The old `POST /api/workspaces` bootstrap route answers 500, not 400 or 409, for the new refusals.
    It never passes `named`, so nothing reaches it today.

- [x] **Files (121).** *Done 13 Oct: Amendment 138 (new folder, rename, delete with a double check, and a + on the navigator's folders).* The navigator's folders have no **+**. New folder, rename and delete are
  separate items if wanted. A name that differs from an existing one only in case is refused only on a
  case-insensitive filesystem, such as macOS.

- [ ] **Metrics (122).** *13 Oct, Amendment 136: the Errors rate, time per turn, the speed average, the stale `lib/verify.ts` comment and a per-project filter are done; a chart beyond the day table is not.*
  - The Errors tile divides retried calls by every engine's calls, though only Claude reports retries.
    The per-model rows are exact.
  - Claude's model-call time includes subagents, but `calls` counts main-loop turns, so time per call
    is overestimated when subagents run in parallel; tokens per second pairs a run's API time with all
    of its output tokens.
  - No per-project filter, and no chart beyond the day table.
  - The comment in `web/src/lib/verify.ts` (~line 856) says no real screen has the hotkey `8`; it does now.

- [x] **Retry and budgets (123-125, 129).** *Done 13 Oct: Amendment 140 (delays and ceiling as settings, the card from the first retry, a new day continues budget pauses, navigator meters).*
  - The retry delays are fixed (5 s, 15 s, 30 s, 60 s, 5 min), not settings.
  - A retried agent that then ends its turn without `hand_off` is held as usual; the one-time ask of
    Amendment 119 applies only to restart resumes.
  - The Needs You card for a retry starts at the second retry, so the 5 s first try doesn't chime. Say
    if you want it from the first.
  - The budget ceiling is fixed at 2× (`BUDGET_CEILING`, `shared/src/budget.ts:18`).
  - Budgets count the day's spend (129), and nothing resumes by itself at midnight, so an agent paused
    at its ceiling overnight waits for you. An automatic **continue** at the day change would spend
    money unattended; say if you want it, and for which agents.
  - A daemon restarted after midnight does not rewrite the pauses (there was no day change to see). The
    card still offers a plain continue because the web reads the state, but the note lacks the
    "renewed" wording until the next day change.
  - A Claude run's spend is counted when its turn ends, so a run that crosses midnight is counted
    whole on the new day. It keeps the SDK limit it launched with.
  - The job's budget is dollars only, and a token-capped agent still leaves the job's dollar cap
    uncapped.
  - The navigator's rows have no budget meter, and a job has no meter of its own, only its warning card.
  - Claude's spend is known only when a turn ends, so its over-budget warning arrives with the turn that
    crossed the budget; the ceiling still stops it mid-turn through the SDK.

- [ ] **Hand-off, windows and roles (120, 126).**
  - The model-window registry is in memory (`session/windows.ts`). After a restart a resumed stack uses
    the floor table until a model list is asked for. Claude's result carries
    `modelUsage[model].contextWindow`, which would fill it from the `result` case in
    `session/backends/claude.ts`.
  - The cap on a handed-off conversation is still counted in characters (3 per token); there is no
    tokenizer.
  - Nothing checks that a model actually puts the closing headings in its `hand_off` summary, and "tests
    only" and "docs only" in the role prompts are words, not rules.

- [x] **Label backdrops (127).** Needs You's `project / role` header stays on `--here`, so it no *Done 13 Oct: Amendment 135, for the request in focus.*
  longer matches the Agent screen it came from. Making it match is one class, `is-agent`, on
  `web/src/attention/route.tsx` (the three `ui-crumb` spans), plus one line in `lib/verify-crumb.ts`.
  The lightness gap between the three backdrops is small, because the 4.5:1 floor on `--ink3` caps it;
  tell me if they are too alike once you have seen them.

- [x] **Orchestrated stacks (128).** *Done 13 Oct: Amendment 142 (a Custom row can orchestrate and save its listed roles; the navigator marks orchestrators).* Custom setups can't save the listed roles and have no orchestrated
  row; only the preset does. Role briefs are edited only in Settings → Personas. The navigator tree has
  no orchestrator mark, only the plan row, the Project lane, the Fleet row and the Agent tab.
