# Wave 10: today and all-time totals for each agent, project and the fleet (Amendment 146)

The text below is for the merge to apply. This change does not edit CONTRACT.md, docs/MANUAL.md,
the Makefile or TODO.md. Cut from main at 01d1ff3 (Amendment 145).

## CONTRACT

### Amendment 146 — post-merge, applied. **Every agent, project and the fleet show what was spent today and over its whole life; removing an agent or a job no longer lowers a total.**

Daemon (migration `db/migrations/240_spend_totals.sql` new, `session/store.ts`, `daily.ts`, `hub.ts`,
`session/supervisor.ts`, `session/backends/claude.ts`, `session/backends/copilot.ts`,
`session/verify.ts`), shared (`wire.ts`) and web (`lib/store.ts`, `shell/spend.ts`, `shell/shell.tsx`,
`shell/shell.css`, `shell/navtree.ts`, `shell/Navigator.tsx`, `fleet/project.tsx`, `fleet/card.tsx`,
`fleet/lane.tsx`, `fleet/order.ts`, `fleet/fleet.tsx`, `fleet/fleet.css`, `agent/inspector.tsx`,
`agent/composer.tsx`, `agent/agent.css`, and `lib/verify.ts`, `agent/verify.ts`, `shell/verify.ts`).
The user, 14 Oct: "the limits for each agent are day limits, it should reset on the next day.
however, also keep track of the total for each agent/project/fleet (and display where
appropriate)". Amends Amendments 59 (the status bar's figure), 124 and 129 (the lifetime figure
shown as information).

- **The limits were already per day; nothing changed there.** Checked: every cap reads today's
  spend. `agentBudget`/`budgetState`/`capState` (`shared/src/budget.ts`) read `spentOn(agent, today)`;
  the daemon's `budgetRefusal`, `budgetNote`, `runLimit` (`session/budget.ts`, the SDK's
  `maxBudgetUsd` from `spentToday(db, id).usd`, `backends/claude.ts:208`), the Copilot/OpenRouter
  token stop (`backends/copilot.ts`, `budgetRefusal` after each call), the `budget_over` alerts
  (`session/alerts.ts`, `agentBudget` and `spentOn(a, day)` for a job) and the job's ceiling
  (`jobBudgetState(..., jobCostToday(...))`, `session/supervisor.ts:1030`) all count today; the
  web's `budgetOf` (`shell/autonomy.ts:97`) too. `agents.cost_usd` is read only as the agent's
  lifetime figure, and by `lifetimeCost` to work out a run's growth (`scope.spentUsd`), never as a
  limit. No limit read the lifetime figure, so none was fixed.
- **A project's spend is its own record.** Migration 240 adds `project_spend_daily(project_id, day,
  cost_usd, tokens, PRIMARY KEY(project_id, day))`, with **no foreign key** to `agents` or
  `projects`. `addSpendToday` (`session/store.ts`) credits it in the same write as
  `agent_spend_daily`: both upserts in one `SAVEPOINT spend` (which nests inside a caller's
  transaction as well as standing alone, so neither is ever credited without the other), with the
  project read from the agent's row; an agent that no longer exists records nothing in either. So it
  grows by the same deltas: Claude's dollars by the growth of the lifetime cost, Copilot's and
  OpenRouter's input plus output tokens per call. Removing an agent, a job (`deleteAgent`,
  `deleteJob`) or a project's agents leaves its rows; `deleteProject` leaves them too, unread, as
  `cost_daily` keeps the fleet's money.
- **The backfill, once, in the migration.** First every dated row already in `agent_spend_daily`
  (today's and the days before it that 210 kept), summed per project and day, so today and the days
  since 210 start right. Then one **"before" row per project, on day `'0000-00-00'`**: the project's
  `SUM(agents.cost_usd)`, and for the engines that report no dollars `SUM(input_tokens +
  output_tokens)` (lifetime figures there; Claude's token columns are its last run's), less what the
  dated rows already hold, never negative, and only where something is left. A row in the same table
  rather than a `project_spend_base` table: a project's total is one `SUM` over its rows, and today
  is `day = localDay()`, which `'0000-00-00'` never is. What agents removed before the migration
  spent cannot be given back to their project; the fleet's total has it.
- **The fleet's all-time total is `SUM(cost_daily.cost_usd)`** (`costTotal`, `session/store.ts`).
  `cost_daily` has no foreign key, and no removal touches it (`deleteAgent`, `deleteJob` and
  `deleteProject` say so), so it already kept every removed agent's money. Dollars only, as today's
  figure is.
- **On the wire** (`shared/src/wire.ts`). `Snapshot.costTotal?: number` and
  `Snapshot.projectSpend?: ProjectSpend[]`, with `ProjectSpend { projectId, today, total, tokensToday,
  tokensTotal }` (`projectSpend`, `session/store.ts`: every project there is, zeros when it spent
  nothing). The `cost` frame keeps `costToday` and adds both, optional, so a page or a recording from
  before reads it as it did. `spendFigures(db)` is the three together; the supervisor's snapshot
  contributor sends them, `buildSnapshot` (`hub.ts`) copies the two new scalars, and
  `broadcastSpend(db)` (`daily.ts`) sends the frame: from Claude's result when its cost grows (it
  was `costToday` alone, `backends/claude.ts`), from each Copilot or OpenRouter call that adds
  tokens (new: a token engine's growth moved no frame before), and at the day change (`DayWatch`, so
  today reads zero and the totals do not move).
- **The page** (`lib/store.ts`). `State.costTotal` and `State.projectSpend`, null until a daemon says
  them; a snapshot sets both (null from one before this), a `cost` frame sets each only when it
  carries it. `useStatusBar()` returns `costTotal`; `useProjectSpend()` the list. The words are pure,
  in `shell/spend.ts`, so `lib/verify.ts` checks them: `totalWords`, `TOTAL_TITLE`,
  `projectPairWords`, `projectSpendOf`, `agentPairWords`.
- **The status bar** (`shell/shell.tsx`, `DailySpend`): today's spend as before (with its meter when
  a daily budget is set), then **· $X total** (`sh-spend-total`), whose hover is "spent by every agent
  since Conductor started counting, kept when agents are removed". A daemon before this sends no
  total, and the bar shows today alone.
- **A project: today $a · total $b.** On each Fleet card's footer (`fl-card-spend`), in the Project
  screen's header after its tag (`pj-headspend`), and in its column's **spend** line, which summed
  the current agents' `costUsd` (`fleet/project.tsx:323`) and so lost what a removed agent or job had
  spent. Dollars; a project whose agents ran on engines that report only tokens reads tokens
  (`today 3.4k tok · total 41k tok`), and one that ran on both reads `today $1.20 + 3.4k tok · total
  $8.40 + 41k tok`. From a daemon before this the pair is read from the project's current agents, as
  it was (`projectSpendOf`). Fleet's **Sort by → spend** orders by the project's total
  (`sortFacts(projects, agents, pending, spent?)`, `fleet/order.ts`; the navigator's `navProjects`
  passes the same list), the current agents' sum when there is none.
- **An agent: today and total side by side**, where one figure was: the Project lane (`fleet/lane.tsx`,
  was "Spent over its whole life" alone), the details panel's **spent** line (`agent/inspector.tsx`,
  was **lifetime**, and **not reported** on a token engine) and the composer's budget line
  (`agent/composer.tsx`, was "$4.10 spent today" with the lifetime in its hover): **today $4.10 ·
  total $31.40**. In the unit `capabilitiesOf(...).costUsd` says: on an engine that reports no
  dollars it is **today 110 tok · total 230k tok**, the total being its input plus output tokens. The
  budget meter and bar stay on today; the total is in the quiet ink (`ag-budget-total`), never in a
  budget's colours.
- **Design tokens only** in the new CSS (`sh-spend-pair`, `sh-spend-total`, `fl-card-spend`,
  `pj-headspend`, `pj-spendpair`, `ag-budget-total`): `--ink2`, `--ink3`, `--mono`, `--fs-sm`.
- **Verified.** `session/verify.ts` §28: the snapshot carries the total and every project's pair; a
  credited run raises the agent's, the project's and the fleet's totals and every page hears it in
  one `cost` frame; a token engine's call grows the project's tokens; removing the agent, then its
  job, keeps the project's and the fleet's; the day change resets today and not the totals, and its
  frame says so; and the backfill, on a scratch database migrated to 230 with agents that have
  lifetime spend, dated days, a token engine and none: dated days copied, the "before" row the
  rest, a project with no days gets its lifetime, one that spent nothing no row, and
  `projectSpend` reads today and the total right. `lib/verify.ts`: the store with and without the
  new fields (an old snapshot still renders), the status bar's text and hover, the project's pair in
  each unit and its fallback, the Fleet sort, an agent's pair in each unit and on a stale day, and
  the screens drawing them. `agent/verify.ts` and `shell/verify.ts` follow the new code.

## MANUAL

Old:

```
  stops the agent at its ceiling, twice it by default (§6). The agent's details say spend **not reported**.
  Fleet's **spend today** stays Claude's dollars only. OpenRouter still bills you, so
```

New:

```
  stops the agent at its ceiling, twice it by default (§6). The agent's details, its lane and its
  composer show its tokens, today and in total, where a Claude agent's show dollars.
  The status bar's spend, today and in total, stays Claude's dollars only; a project's shows its
  tokens beside its dollars. OpenRouter still bills you, so
```

Old:

```
(An agent's own spend today goes with the agent: a removed agent has no budget left.)
```

New:

```
(An agent's own spend today goes with the agent: a removed agent has no budget left. Its
project's spend, today and in total, keeps what it spent, and so does the status bar's total.)
```

Old:

```
its **lifetime** spend as a plain line,
```

New:

```
what it spent today beside what it has spent over its whole life as a plain line (**today $4.10 · total $31.40**; in tokens on an engine that reports no dollars),
```

Old:

```
- **The details panel shows both figures.** The bar says **today $4.10 of $25**, which is
  what the budget counts; **lifetime $31.40** under *Agent* is everything the agent has
  spent, for information.
```

New:

```
- **The details panel shows both figures.** The bar says **today $4.10 of $25**, which is
  what the budget counts; **spent today $4.10 · total $31.40** under *Agent* is today's beside
  everything the agent has spent, for information. Its lane on Project and the composer's budget
  line show the same pair; an engine that reports no dollars shows both in tokens.
```

Old:

```
- **Today's spend is in the status bar**, and in `make status`. It counts dollars only, so
  Copilot and OpenRouter agents, capped in tokens (§2, "Choose the engine"), add nothing
  to it.
```

New:

```
- **Today's spend is in the status bar**, and in `make status`. It counts dollars only, so
  Copilot and OpenRouter agents, capped in tokens (§2, "Choose the engine"), add nothing
  to it. After it the status bar shows **· $X total**: everything every agent has spent since
  Conductor started counting, kept when agents, jobs or projects are removed.
- **Each project shows today $a · total $b**, on its Fleet card and in the Project screen's
  header and column. Its total keeps what removed agents and jobs spent (from before this, it
  counts only the agents the project still had). An engine that reports no dollars adds its
  tokens beside the dollars.
```

Old:

```
The project (and its job's branch) is the label at the top,
```

New:

```
The project (and its job's branch) is the label at the top, with what the project spent, **today $a · total $b**, after its state (removing an agent or a job keeps it),
```

Old:

```
coloured like the status bar's daily budget (below).
```

New:

```
coloured like the status bar's daily budget (below). The card's footer says what the project spent, **today $a · total $b**, kept when its agents are removed.
```

Old:

```
**recently active**, **spend** or **newest**
```

New:

```
**recently active**, **spend** (the project's total) or **newest**
```

## Makefile test line

none
