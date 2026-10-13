# Wave 10, Lane G: retry and budgets you can set (Amendment 140)

The text below is for the merge to apply; this lane does not edit CONTRACT.md or docs/MANUAL.md.

## CONTRACT

### Amendment 140 — post-merge, applied. **The retry delays and the budget ceiling are settings, the first retry has its card, a new day continues what only its budget paused, and the navigator has the meters.**

Shared, daemon and web (`shared/src/{retry,budget,index}.ts`, `daemon/src/session/{retry,budget,
alerts,supervisor,store}.ts`, `daemon/src/routes/session.ts`, `web/src/lib/settings.ts`,
`web/src/settings/{budgets.ts,route.tsx}`, `web/src/shell/{navtree.ts,Navigator.tsx,autonomy.ts,
describe.ts,shell.css}`, `web/src/agent/{reconnecting.ts,inspector.tsx}`,
`web/src/attention/AlertCard.tsx`, `web/src/spawn/route.tsx`). The wave 10 plan's Lane G, with §6 Q3
and Q4 both yes. Amends Amendments 123 (the retry), 124 and 129 (the ceiling, and midnight). No
migration.

- **`conductor.retryDelays`** (`shared/src/retry.ts`, new): one to five whole numbers of seconds,
  separated by commas, each from 1 to 1800; how many there are is how many tries. Default
  `5, 15, 30, 60, 300`, the list that was fixed at `daemon/src/session/retry.ts:26`. The rule
  (`parseRetryDelays`, `retryDelaysProblem`) is shared, so the daemon's `settingRule` (400 with "one
  to 5 whole numbers of seconds, separated by commas, each from 1 to 1800") and the Settings field
  read it the same way. `RETRY_DELAYS_MS` and `MAX_RETRIES` stay as the defaults; `retryDelaysMs()`
  is the schedule in force, read from the cached settings (`settings.ts:46`) each time a wait is
  decided (`decideRetry`, which takes `delays?` for a pure call), so a change applies to the next
  failure and a wait already counting keeps its time. `of` in the retry and the card is the set
  list's length.
- **`conductor.budgetCeiling`** (`shared/src/budget.ts`): a number from 1 to 10, default 2
  (`BUDGET_CEILING`, `:35`). `ceilingOf(budget, ceiling = budgetCeiling())` reads it on every call,
  rounded to a millionth (25 × 1.1 is 27.5). Shared imports neither side: each says where its copy
  of the settings is through `readBudgetCeilingFrom` (the daemon's file, `daemon/src/session/
  budget.ts`; the page's map, `web/src/lib/settings.ts`), and a value that is not one reads as 2.
  `capState`, `budgetState`, `jobBudgetState`, `runLimit`, `budgetRefusal` and `budgetNote` all go
  through `ceilingOf`, so the warning, the stop, the SDK's limit and the sentences move with it at
  the next check. A change re-reads the alerts and pumps (a job held at the old ceiling may start);
  it wakes nothing paused, as raising a budget wakes nothing. The words: `ceilingWords()` is "twice"
  at 2, else "1.5×", in `failureSentence`, the inspector, the over-budget card and Spawn's hints.
- **The first retry's card** (Q3). `RETRY_CARD_FROM = 1` (shared), read by the daemon's alert
  (`RETRY_ALERT_FROM`) and by the agent's line and banner (`describe.ts`, `reconnecting.ts`), which
  are amber from it. It was 2. The card's id is the bout's, so it chimes once, at the first retry, as
  every alert chimes at once (`dueForChime`), and later retries update it. Claude Code's own
  in-flight retries (the Model API alert, `ALERT_FROM_ATTEMPT`) are unchanged.
- **A new day continues a budget pause** (Q4). `Supervisor.newDay` (Amendment 129's day turn): with
  `conductor.budgetResumeAtMidnight` on (the default; `on` or `off`, 400 otherwise), an agent
  paused ONLY by a budget, at its own ceiling (`budget_exhausted`) or held for its job's
  (`job_budget_reached`, the job not still at its ceiling), with room on the new day
  (`continuations`, pure, in `budget.ts`; a renewed note counts, since it is still only a budget
  pause), is resumed as ▶ resume resumes it (`resumeAgent(id, note)`): queued, with
  `newDayNote(day)` ("a new day's budget began (2033-02-11) — continuing") on the status event, and
  on its next run told `NEW_DAY_NUDGE` (a synthetic turn, as every resume prompt; it outranks only
  the plain wake). Queued, so the slots, the job's figure and a pause of everything (`supervisor().held`,
  in which `pump` starts nothing) still decide when it runs. A pause you made, a hold's, a strand,
  a failure or any other note is left. With the setting off, Amendment 129 as it was: the pause is
  rewritten as renewed and nothing resumes. Returns how many it continued or rewrote.
- **At start** (`Supervisor.catchUpDay`, from `routes/session.ts` after the scheduler has put back a
  pause of everything and before the first pump): a daemon that was down at midnight saw no turn, so
  a paused agent whose last status event is from an earlier local day (`lastStatusDay`, new in
  `store.ts`) gets what the turn would have given it, continued or (off) renewed. A budget pause
  written today is not touched. Amendment 129 left these until the next midnight.
- **Settings (9).** Under Agents, the waits (`RetryDelaysRow`); under Spend, the ceiling
  (`CeilingRow`) and **at midnight, continue agents the day's budget paused** on/off
  (`MidnightRow`). The two fields are `SlotsSection`'s pattern: a draft checked as it is typed, the
  problem in the field's sentence (`web/src/settings/budgets.ts`), written on Enter or blur, put
  back by Esc, the default written as nothing.
- **The navigator's meters.** `NavAgent.budget` is `budgetOf` (the Fleet lane's figure, the same
  day), `NavJob.budget` the sum of its agents' (`sumBudgets`, `shell/autonomy.ts`: dollars when any
  budget is in dollars, and then only those; null when none has a budget). `Navigator.tsx` draws the
  Fleet's `pj-meter` with `data-tone` on the agent row and the job heading, with a hover
  (`meterTitle`); `shell.css` only sizes it (`.pj-meter.sh-nav-meter`, no colour), and the panel
  imports `fleet/fleet.css` so the tones are there on every screen. No budget, no bar.
- **Not done.**
  - A page re-reads the ceiling when it next renders; a meter already drawn changes at its next
    redraw, not the instant the setting does.
  - The job's meter in the navigator is its agents' budgets added up, not the daemon's job ceiling
    (`jobCap`), which an uncapped agent lifts. It is a picture, not the stop.
  - A continued agent whose job is at its ceiling after all (a budget lowered between the turn and
    the pump) is paused again by `pump` with the job's note, as before.
  - Retries still do not survive a restart (Amendment 123).
  - Not looked at in a browser, in either theme.

**Verified:** `session/verify.ts` (1,388 checks, 60 new): §23 with a set list (`2, 7`: two tries,
waits of 2 s and 7 s through the supervisor, the transcript saying them, the third failure failed;
bad lists 400 with the sentence; 30 min × 5 taken; removing it puts the default back), and the card
from the first retry with the same id at the second, every tab told at the first; §24 with the
ceiling set (bad values 400; at 1.5 a $25 budget stops at $37.50, the warning goes, the refusal and
the pause note say $37.50; at 1 the budget is the stop; at 10 the SDK is given $210 of $250); §26,
Amendment 129's checks, now with the continue off; §27 (31 checks): the setting's rule; at the turn,
one at its ceiling and one held for its job continued within one free slot, each with the note, the
running one resuming its session told `NEW_DAY_NUDGE` with the whole new day's $50, the second
going when the slot frees, a person's pause and a strand left, a later message ordinary, a second
turn nothing; with everything paused, continued but not run until `release`; `continuations` pure;
at start, an earlier day's pause continued and today's left, a second look nothing, and with the
setting off renewed instead. §17q (Amendment 103's day turn) runs with the continue off. Web:
`shell/verify.ts` §11 (17 checks: the rows' meters, tones, the job sum, units never added, a stale
day, the hover, the ceiling set, the source and the CSS), `lib/verify.ts` §38 (17 checks: the rows'
rules and values, the page reading the ceiling, the rows' pattern, the daemon's rules), and the
retry tone in `lib/verify.ts`, `agent/verify.ts`, `attention/verify.ts` (the first retry's card
chimes once), `spawn/verify.ts`. `pnpm -r typecheck` and `make test` green.

## MANUAL

Each pair is the exact existing text in docs/MANUAL.md and what replaces it.

1. docs/MANUAL.md:407-408 (orchestrated stacks, the job's budget).

Old:
```
works as an agent's does: Needs You warns when the job passes it, and agents still to start
are held only at twice it (§6).
```
New:
```
works as an agent's does: Needs You warns when the job passes it, and agents still to start
are held only at its ceiling, twice it unless Settings says otherwise (§6).
```

2. docs/MANUAL.md:566 (Copilot and OpenRouter, budgets in tokens).

Old:
```
  stops the agent at twice it (§6). The agent's details say spend **not reported**.
```
New:
```
  stops the agent at its ceiling, twice it by default (§6). The agent's details say spend **not reported**.
```

3. docs/MANUAL.md:610 (Spawn's pills table), inside the row.

Old:
```
Past it the agent keeps working and Needs You warns; it stops at twice the figure. See §6. |
```
New:
```
Past it the agent keeps working and Needs You warns; it stops at the ceiling, twice the figure unless Settings (9) says otherwise. See §6. |
```

4. docs/MANUAL.md:716 (re-run from here).

Old:
```
or is only just starting. If an agent after it has reached twice its daily budget today, or the job has,
```
New:
```
or is only just starting. If an agent after it has reached its ceiling today (twice its daily budget by default), or the job has,
```

5. docs/MANUAL.md:766 (Needs You, **Over its daily budget**), inside the row.

Old:
```
A warning only: nothing is paused, and it stops at twice the budget.
```
New:
```
A warning only: nothing is paused, and it stops at the ceiling (twice the budget unless Settings says otherwise).
```

6. docs/MANUAL.md:767 (Needs You, **Budget reached for today**), the whole row.

Old:
```
| **Budget reached for today** | An agent spent twice its daily budget today and was paused. | **+$10 and continue** or **+$25 and continue**, which raise its budget and wake it, or open it. At midnight the card changes, because the budget starts again: it says the budget is **renewed for the new day**, and **continue** needs no raise. The agent is still paused: **nothing resumes by itself**, since that would spend while no one is looking. The same for an agent held for its job's budget. |
```
New:
```
| **Budget reached for today** | An agent reached its ceiling today (twice its daily budget, unless Settings says otherwise) and was paused. | **+$10 and continue** or **+$25 and continue**, which raise its budget and wake it, or open it. At midnight the budget starts again and Conductor continues the agent for you, so the card goes; its transcript says a new day's budget began. With **at midnight, continue agents the day's budget paused** off in Settings (9), it stays paused instead: the card says the budget is **renewed for the new day**, and **continue** needs no raise. The same for an agent held for its job's budget. |
```

7. docs/MANUAL.md:769 (Needs You, **Reconnecting**), inside the row.

Old:
```
It appears from the second try (see "When the model can't be reached", §7). |
```
New:
```
It appears from the first try, and chimes like any alert (see "When the model can't be reached", §7). |
```

8. docs/MANUAL.md:869 (the Agent screen), inside the row.

Old:
```
and raising the budget is how an agent that reached twice it carries on (or waiting for midnight, when the budget starts again).
```
New:
```
and raising the budget is how an agent that reached its ceiling carries on (or waiting for midnight, when the budget starts again and Conductor continues it).
```

9. docs/MANUAL.md:876 (Settings), inside the row.

Old:
```
**Personas**: what each role is (see below); where Conductor keeps its data; how many agents run at once; a **daily budget**
```
New:
```
**Personas**: what each role is (see below); where Conductor keeps its data; how many agents run at once; how long an agent waits before each try when the model can't be reached (one to five waits in seconds, each from 1 to 1800, default **5, 15, 30, 60, 300**; how many there are is how many tries); a **daily budget**
```

and, in the same row:

Old:
```
it resets at local midnight); what Spawn starts from
```
New:
```
it resets at local midnight); the **ceiling**, the multiple of an agent's daily budget at which it is paused (from 1 to 10, default 2; between the budget and the ceiling it is only warned about); **at midnight, continue agents the day's budget paused** (on by default; off leaves them paused, renewed, until you continue them); what Spawn starts from
```

10. docs/MANUAL.md:1156-1160 (§6, the budget per agent).

Old:
```
  **+$10** and **+$25**. What stops a runaway agent is a ceiling at **twice the budget**: an
```
New:
```
  **+$10** and **+$25**. What stops a runaway agent is a ceiling at **twice the budget** (Settings (9)
  sets the multiple, from 1 to 10): an
```

and

Old:
```
  the budget raises the ceiling with it. A budget in tokens works the same way (the ceiling
  is twice the tokens). Claude's spend is known when a turn ends, so the warning for a Claude
```
New:
```
  the budget raises the ceiling with it. A budget in tokens works the same way (the ceiling
  is the same multiple of the tokens). Claude's spend is known when a turn ends, so the warning for a Claude
```

11. docs/MANUAL.md:1163-1168 (§6, midnight).

Old:
```
- **At midnight the budgets start again, and nothing resumes by itself.** An agent that is
  over its budget is under it again, and its warning goes. An agent that was paused at the
  ceiling stays paused: its pause and its Needs You card now say its budget is **renewed for
  the new day**, and **continue** (or a message) carries it on with no raise. Conductor does
  not restart it for you, because that would spend money while nobody is watching. The same
  goes for agents held for their job's budget. Every open page redraws its bars at zero
```
New:
```
- **At midnight the budgets start again, and what only the budget paused carries on.** An
  agent that is over its budget is under it again, and its warning goes. An agent that was
  paused at the ceiling, or held for its job's budget, is continued as ▶ resume would, and its
  transcript says a new day's budget began; it waits for a slot like any queued agent, and
  while everything is paused until a time it waits for that. A pause you made, or any other, is
  left. If Conductor was not running at midnight, it does this when it starts. To have them
  wait for you instead, turn off **at midnight, continue agents the day's budget paused** in
  Settings (9): then the pause and its Needs You card say the budget is **renewed for the new
  day**, and **continue** (or a message) carries it on with no raise. Every open page redraws its bars at zero
```

12. docs/MANUAL.md:1181-1182 (§6, a job's budget).

Old:
```
  today, Needs You warns, and agents still to start go ahead. At twice the sum they are held
  (**job budget reached**) until you raise a budget, or until the next day.
```
New:
```
  today, Needs You warns, and agents still to start go ahead. At the ceiling times the sum
  they are held (**job budget reached**) until you raise a budget, or until the next day,
  when they are continued (unless that setting is off).
```

13. docs/MANUAL.md:1257-1259 (§7, when the model can't be reached).

Old:
```
Conductor waits and tries again, up to five times, **5 s, 15 s, 30 s, 60 s and 5 min** after
each failure, resuming the agent in its own session.
```
New:
```
Conductor waits and tries again, up to five times, **5 s, 15 s, 30 s, 60 s and 5 min** after
each failure (Settings (9) sets the waits, one to five of them, so how many tries too), resuming
the agent in its own session.
```

14. docs/MANUAL.md:1266-1267.

Old:
```
  screen's lines say *reconnecting in 30 s (3 of 5)*. From the second try Needs You has the same
  card.
```
New:
```
  screen's lines say *reconnecting in 30 s (3 of 5)*. From the first try Needs You has the same
  card, and it chimes like any alert, once for the whole wait.
```

15. docs/MANUAL.md:1274.

Old:
```
- Any **real reply from the model** starts the count again: the next failure waits 5 s. An
```
New:
```
- Any **real reply from the model** starts the count again: the next failure waits the first
  delay (5 s by default). An
```

16. docs/MANUAL.md:1277-1278.

Old:
```
- After the fifth try fails, the agent is **failed**, as it always was, and Needs You says so.
  **stop retrying** does the same at once. Continuing a failed agent gives it five tries again.
```
New:
```
- After the last try fails (the fifth, by default), the agent is **failed**, as it always was, and
  Needs You says so. **stop retrying** does the same at once. Continuing a failed agent gives it
  its tries again.
```

17. docs/MANUAL.md:1280-1281 (retries and a restart).

Old:
```
  waiting resumes on its own like one the restart interrupted, with five tries again.
```
New:
```
  waiting resumes on its own like one the restart interrupted, with all its tries again.
```

18. docs/MANUAL.md:1323 (scheduled messages).

Old:
```
yet gets it once it has. One that can't take it (it has reached twice its budget, say) shows
```
New:
```
yet gets it once it has. One that can't take it (it has reached its budget's ceiling, say) shows
```

19. docs/MANUAL.md:1405 (a restart).

Old:
```
  agent. One already at twice its budget is paused instead, and one that had no session yet
```
New:
```
  agent. One already at its ceiling is paused instead, and one that had no session yet
```

20. docs/MANUAL.md:1408.

Old:
```
  same way, told the restart happened, with five tries again if they fail.
```
New:
```
  same way, told the restart happened, with all their tries again if they fail.
```

21. New text, after item 11's bullet in §6 (a new bullet), for the Settings rows:

```
- **Settings (9) has the three.** Under **Agents**: *when the model can't be reached, wait before
  each try* (seconds, commas between; one to five waits, each from 1 to 1800; default
  `5, 15, 30, 60, 300`). Under **Spend**: *an agent stops at its daily budget times* (from 1 to 10,
  default 2; 1 stops it at the budget itself), and *at midnight, continue agents the day's budget
  paused*, **on** or **off** (on by default). A field says what is wrong as you type and is kept on
  Enter or when you leave it; **Esc** puts it back. Each applies at once, to every agent.
```

## Makefile test line

none
