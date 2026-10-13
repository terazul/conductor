# Lane C: metrics that say what they mean (Amendment 136)

Built 13 Oct 2026 in its own worktree off `main` at `6404675`. The two sections below are the text to
paste into `CONTRACT.md` and `docs/MANUAL.md` when the lane is merged; this lane does not edit them.

## CONTRACT

### Amendment 136 — post-merge, applied. **Metrics say what they mean, and can be read for one project.**

Daemon (`db/migrations/220_metrics_project.sql` new, `session/metrics.ts`, `routes/metrics.ts`,
`session/verify.ts`). Wire (`MetricsCounts.claudeCalls`, `MetricsResponse.project`, and `MetricsProject`
at the end of the Metrics section of `shared/src/wire.ts`). Web (`metrics/rules.ts`, `metrics/route.tsx`,
`metrics/endpoints.ts`, `metrics/metrics.css`, `metrics/verify.ts`, `lib/verify.ts`). Asked 13 Oct (wave
10, Lane C; Q1 answered yes): fix the three "Not done" items of Amendment 122 about what its rates mean,
and add the per-project filter it left out. The causes, from 122's own notes: (1) the Errors tile divided
retries by every engine's calls, though only Claude reports a retry (`api_retry` comes from
`backends/claude.ts` alone), so with Copilot or OpenRouter agents in the range the rate read lower than
Claude's own; (2) "per call" divided a Claude turn's `duration_api_ms`, which covers its subagents and
their side-by-side calls, by `num_turns`, so it was not the length of one API call; (3) the total's speed
added every engine's output tokens over every engine's model time; (4) `metrics_daily` is keyed
`(day, provider, model)` and had no project.

- **The retry rate is out of Claude's calls.** `MetricsCounts` gains `claudeCalls`, the calls of rows whose
  provider is `claude` (`RETRIES_REPORTED_BY` in `session/metrics.ts`), summed by the daemon for the
  total, each model and each day. `derive` (`rules.ts`) divides `retries` by it, and the Retried cell is
  `retries/claudeCalls`. When another engine ran in the range (`otherEnginesRan(models)`), the Errors tile
  says "6 of Claude's 200 calls retried (3.0%)" and its hover says why; with Claude alone it reads as
  before ("6 of 250 calls retried"); with no Claude calls it says only Claude reports retries, not "0 of
  50". A non-Claude row's retries stay a dash.
- **Time is per turn, subagents included.** `apiPerCallMs` is `apiPerTurnMs`; the tile reads "2.0 s per
  turn, subagents included", the column is **Per turn**, and both hovers say a Claude turn's subagents can
  run side by side, so it is not the length of one API call. Copilot and OpenRouter, which time each call,
  are one turn per call, so the same words hold.
- **Speed is each model's own, averaged.** A row's speed is still its timed output tokens over its model
  time. The total tile's is `averageSpeed(models)`: the mean of the models' own speeds, said as "(average
  of N models)" when there are several, instead of all tokens over all time, which mixed a fast small
  model's seconds with a slow large one's. The spec asked for per run then averaged; the rows are daily
  sums per model, so per model is the finest figure there is. (A Claude run's output tokens, its
  subagents' included, are still credited to its main model's timed tokens, as in 122.)
- **Per project: a table of its own.** Migration `220_metrics_project.sql` adds `metrics_project_daily
  (day, project_id, provider, model, …the same twelve counters…)`, keyed `(project_id, day, provider,
  model)`, and `metrics_meta.project_since`, the instant it began. It is not a re-key of `metrics_daily`:
  that table, every row in it and every query on it are untouched, and the all-projects view still reads
  it. `bump` writes both tables from the same call, with the agent's `projectId` (read when the result
  arrives, kept with the run's credit for `recordRunEnd` and the `failed` that follows), inside a
  SAVEPOINT (`atomically`) so the two never disagree, including when a status event is heard inside
  someone else's transaction. Like `metrics_daily` it references nothing: removing a job, an agent or a
  project leaves the counts. Counts from before the migration have no project and are under all projects
  only.
- **Route.** `GET /api/metrics?range=…&projectId=…`. Without `projectId`, as before, with `project: null`.
  With it: 400 for an id that is not the shape of one (`/^[A-Za-z0-9_-]{1,64}$/`), an empty one or a
  repeated one; 404 for a project that is not there; otherwise that project's counts from
  `metrics_project_daily`, `project: { id, name }`, `since` the day per-project counting began (so `all`
  starts there), and no `before` line (the agent rows from before recording cannot say whose runs were
  whose). A bad range is still 400 first.
- **Web.** A project picker in the head, after the range: **All projects**, then each project by name
  (`projectChoices`), kept as the setting `conductor.metricsProject` like the range; a remembered project
  that has been removed is All projects again (`asProject`). The screen shows an answer only for the range
  and project it asked for. With a project picked, a short note above the tiles says "Counts for alpha start
  on Tue 13 Oct, when per-project counting was added. Earlier runs are under All projects only."
  (`projectNote`), and How these are counted says the same. `.mt-project` uses tokens only.
- **Hotkey comment.** `lib/verify.ts` §15's made-up screen named `'8'` "a hotkey no real screen has";
  Metrics has had `8` since 122 and every digit is a real screen's now, so it uses `'x'`, and a new check
  reads every `route.tsx` to confirm no real screen registers it.
- **Not done.** (1) Nothing was looked at in a browser: the picker's place in the head and both themes
  are held by the stylesheet checks only. (2) The retry rate's whole is "the `claude` provider's calls",
  a constant beside the reader, not a backend capability; an engine that starts reporting retries needs it
  changed. (3) A Claude run's output tokens are credited to its main model, so a model's speed with busy
  subagents on another model is still a blend; the rows cannot split it.

**Verified:** `session/verify.ts` §22 (15 new checks): with Copilot calls in the range, the total's
`claudeCalls` is the Claude rows' calls and less than all calls; a Claude row's `claudeCalls` is its calls,
a Copilot row's none, every retry on a Claude row; `?projectId=` names the project and its A, B and
gpt-4.1 rows equal the all-projects ones, with no `before` and `since` the per-project start; the project
table has the rows; another project's OpenRouter agent (`recordCall` twice, `recordRunEnd`) is in its own
view and the all-projects one and not this one's, an empty project is an empty report and not a 404; an
unknown project is 404; `..%2F`, an empty id and two ids are 400, and a bad range with a project is still
400. `metrics/verify.ts` (new §2b and §6b, more in §3, §4, §7): mixed-engine fixtures (opus 200 calls with
6 retries, Copilot 50): the rate is 3.0%, not 2.4%; the tile says "of Claude's 200 calls" only when another
engine ran; Copilot alone says only Claude reports retries; speed averages 200 and 100 to 150 tok/s, not
189; Per turn and its hovers; the picker's choices, the remembered project, the note, the request's
`&projectId=` and the route's 400/404. `lib/verify.ts` §15: the made-up key is one no screen uses.
`pnpm -r typecheck`, `pnpm --filter @conductor/web verify`, `metrics/verify.ts` and `session/verify.ts` pass.

## MANUAL

In the screens table (`docs/MANUAL.md`, the `8` row), replace this sentence:

> **Failed** is runs that ended failed out of all runs, and **Retried** is model calls the SDK had to try again out of all calls (Claude only).

with:

> **Failed** is runs that ended failed out of all runs, and **Retried** is model calls the SDK had to try again out of Claude's calls, since only Claude reports a retry; when Copilot or OpenRouter agents ran too, the Errors figure says "of Claude's calls". Time is model time **per turn, subagents included**: a Claude turn's subagents can run side by side, so it is not the length of one API call. The speed at the top is the average of each model's own.

and this one, in the same row:

> Choose **Today**, **7 days** or **All**; the last two also list each day.

with:

> Choose **Today**, **7 days** or **All**; the last two also list each day. Beside them, pick **All projects** or one project to count only its agents' runs; the choice is remembered. A project's counts start from when per-project counting was added (the screen says the day), so earlier runs are under **All projects** only.

and this one, in the same row:

> their time per call is known only when the runtime says.

with:

> their time per turn is known only when the runtime says.

In the spend list (the **Metrics** (`8`) bullet), replace:

> - **Metrics** (`8`) adds spend up by model, with tokens, calls, time and errors, for
>   today, 7 days or all of it, and keeps it after a job or agent is removed. Copilot and
>   OpenRouter show tokens there, not dollars.

with:

> - **Metrics** (`8`) adds spend up by model, with tokens, calls, time and errors, for
>   today, 7 days or all of it, for every project or one, and keeps it after a job or agent is
>   removed. Copilot and OpenRouter show tokens there, not dollars.

## Makefile test line

none
