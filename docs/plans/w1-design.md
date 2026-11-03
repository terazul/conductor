# W1 design: never give up on the model, wait for it to come back, then resume

**Status:** design for wave 13 track 1 (Amendment 192), against `main` at `1661089`. The spec is
TODO.md "Never give up on the model…" (TODO.md:104-150), with
[wave-13-tracks.md](wave-13-tracks.md) §2 W1 and §3. Line numbers below are on `1661089`.

## What changes, in one paragraph

Today an agent whose five short tries fail is `failed` (`decideRetry`'s `out_of_tries`,
`session/retry.ts:179`), and a failed agent fails its job. After W1 that agent is **`paused`
with a note** that says it is waiting for the model, and it joins its provider's **outage**: one
per provider, held by a new `session/outage.ts`, which probes the provider on the retry clock at
30 s, 1, 2, 5 and 15 min, then every 15 min, with no limit. When a probe answers, one agent (the
**canary**) is resumed; once the model answers it, the rest follow a few seconds apart. Its job
reads as running the whole time. Needs You shows one card per provider, with **retry now** and
**stop waiting**.

## 1. How "waiting for the model" is stored

- **The status:** `paused`, set the way `#pause` (`supervisor.ts:1063`) and Pause all set it.
  The status event's `error` is the note
  `modelWaitNote(cause)` = `"<why> — waiting for it to come back; it carries on by itself then"`
  (the `why` from `WHY`, `retry.ts:194`), so the transcript reads "can't reach the model —
  waiting for it to come back; it carries on by itself then". It is read back with
  `lastStatusNote` (`supervisor.ts:147`, as `release` reads `HOLD_NOTE` at `:2582`), and
  `isModelWaitNote(note)` (in `@conductor/shared`, so the web can say it too) matches the
  suffix. `AgentStatus` (`shared/src/events.ts:26`) is unchanged.
- **The provider, the cause and why the run ended:** one new optional field on that status event,
  `StatusPayload.outage?: { provider: string; cause: RetryCause; reason: string | null }`
  (`events.ts:137`), plus the run's `detail`, as a failure carries it. The provider is the
  agent's engine (`agent.provider`, `'claude'` when unset). `reason` is the run's
  `terminalReason`, so **stop waiting** fails the agent exactly as the run would have
  (`stopRetrying`, `supervisor.ts:1530`, does the same from the RetryBook today).
- **Since:** that status event's `ts`. The outage's own `since` is its earliest agent's.
- **A restart:** the event log keeps all of it, so `reconcile` can rebuild the outage
  (§5). **No migration 330.** Nothing new needs a column: the wait is the status, the note and
  the event, and the outage's schedule is in memory and starts again from 30 s after a restart,
  which is what a person restarting would want.

## 2. Which agents wait

- `decideRetry` (`retry.ts:169`) gets a third answer, in place of `no('out_of_tries')` at
  `:179`: `{ retry: 'outage', cause, retryAt? }`. `NoRetry` loses `'out_of_tries'`.
  `ACCOUNT_ERRORS` (`:54`, `needs_a_person`) and `NEVER_BETTER` (`:85`, `not_api`) answer as
  before, so an auth error still goes straight to Needs You as `failed`.
- `ApiFailure` (`:79`) gains `retryAt?: number`: the time the API said to come back
  (a `Retry-After`, or a usage limit's reset). When it is later than this try's delay, the short
  tries are skipped: the agent waits in the outage straight away, and the outage doesn't probe
  before that time (§3). `EndedRun` gains `now?` for that comparison, so the rule stays pure.
- `RetryBook` (`:262`) gains `spent(agentId)`: the short tries are marked used, so an agent
  the outage resumed that fails again rejoins the outage at once instead of starting five more
  short tries. `answered` (`:328`) clears it, as it clears the count.
- `#waitToRetry` (`supervisor.ts:1473`) acts on the new answer: it cancels any RetryBook wait,
  writes the paused status of §1 and calls `outages().join(...)`. A job being stopped
  (`#halting`) still fails, as it does at `:1489`.
- Since Amendment 180 no budget pauses anything, so the TODO's "Conductor's own budget pause"
  line is moot. A ⏸, Pause all or a stop is a decision, not an outage: `#settle`'s `byUser`
  return (`:1335`) happens before the retry branch, so none of them reaches it.
- **New launches** (§3 Decided) go through the same `#settle` branch: they try the short
  delays, then join.

## 3. The probe

- **Where:** `session/outage.ts`, an `OutageBook` on `retry.ts`'s `Clock` (`:209`), one outage
  per provider. Its schedule is `[30 s, 1, 2, 5, 15 min]`, then 15 min forever. `checks` counts
  probes.
- **What it asks:** `probes[provider]()`, an injectable map (as `modelSources`, `models.ts:56`),
  so verify answers for it.
  - **claude:** a new `probeGateway()` in `models.ts`, next to `askGateway` (`:104`):
    `GET <base>/v1/models?limit=1` with the credential when there is one (`endpoint`, `:65`)
    and none when there isn't (a Claude login: then it tests that the host answers). **Up** is
    any HTTP answer but 429, 529 or 5xx. **Down** is no answer, or one of those. It returns the
    `Retry-After` header too.
  - **copilot:** `copilotModels(true)` (`backends/copilot.ts:230`). The SDK caches `listModels`
    in the client's `modelsCache` until the client stops, so `fresh` clears that first.
    Otherwise a cached list would read as up.
  - **openrouter:** `openRouterModels(true)` (`:246`). It fetches the public list.
  - Up means it didn't throw. Both Copilot probes are imported lazily, as `backends/index.ts`
    already does, because of the arbiter cycle.
- **Also runs** on **retry now**, after Pause all is released, and when the clock jumps: a
  heartbeat every 60 s, only while an outage exists, that finds `now` more than 2 min past its
  last beat (a laptop asleep: Node's timers don't count the sleep) and probes at once.
- **Retry-After / a usage limit's reset:** an agent's `retryAt` (from its `ApiFailure`), or a
  probe's `Retry-After`, sets the outage's `notBefore`. The next probe is at
  `max(schedule, notBefore)`. **Retry now** still probes.
  - Claude: `#onMessage` (`backends/claude.ts:557`) remembers a `rate_limit_event` whose
    `rate_limit_info.status` is `rejected` (`resetsAt` is in seconds) and puts it on a throttled
    `apiFailure`.
  - Copilot and OpenRouter: `apiFailureOf` (`backends/copilot-events.ts:198`) reads
    "retry after N" from the message.

## 4. The resume

- **States:**
  - probing → a probe is up →
  - **canary:** the agent that joined first is resumed through the supervisor's handler →
  - `outages().answered(canary)` (called from `modelAnswered`, `alerts.ts:742`, next to
    `RetryBook.answered`) → **releasing:** the next agent at once, the rest `STAGGER_MS` = 5 s
    apart → the outage ends when no agent is left in it.
- **If the canary fails again** it rejoins (its tries are `spent`, §2), and the outage goes back
  to probing at the next step of the schedule, not back to 30 s.
- **If the canary is stopped or removed:** probing again.
- **The handler** is `Supervisor.#fromOutage(agentId)`. It answers:
  - `'held'` while `#hold` (Pause all): the outage stays probing and resumes nothing;
  - `'gone'` when the agent is no longer paused on the wait note;
  - or it resumes the agent. `retryBook().spent`, `#retryRuns.add` (so it is told RETRY_NUDGE,
    `#resumePrompt`, `:1258`), `#reopenJob`, queued with the note "the model answered a check —
    trying again", pump.
- **Pause all:** `hold()` (`:2566`) pauses only `working` agents, so a waiting agent is left
  waiting. `release()` (`:2578`) still resumes only `HOLD_NOTE` agents, then calls `checkNow`
  on every outage, which probes and resumes as above.

## 5. After a restart

`reconcile` (`supervisor.ts:496`) gains a pass: an agent that is `paused` and whose last status
event carries `outage` rejoins its provider's outage, with `since` from that event's `ts`. It is
not added to `#restarted` (`:501`), so it is never told RESTART_NUDGE. When the outage resumes it,
it is told RETRY_NUDGE, as any retry is.

## 6. How the job reads

- **The daemon:** `#rollUpJob` (`:1936`) counts `paused` as settled (`:1949`), which would mark a
  job `done` or `failed` while its agents wait. A paused agent whose note is the model-wait note is
  not settled, so the job stays `working` (running).
- **The web:** `rollupStatus` (`shared/src/events.ts:406`) works on statuses alone, so the note is
  taken into account before it is called. `useProjectStatus` and `useJobStatus`
  (`web/src/lib/store.ts:496-506`) and the Project screen's `worstOf` (`fleet/project.tsx:238`)
  count an agent named in an open outage alert (`agentIds`) as `working`. The agent's own row
  still says paused: "waiting for the model" (`describe.ts`'s `currentAction`).

## 7. The card, the agent and the status bar

- **The alert:** Alerts gains `#outages()`, kind `connection` (the outage alert that exists,
  `alerts.ts:419`), one per provider. Its id is `connection:outage:<provider>:<since>` and it
  carries `provider`, `agentIds`, `since` and three new optional fields: `waiting` (how many),
  `nextCheckAt` (ISO) and `limitResetsAt` (ISO, the `notBefore`). It refreshes on
  `onOutageChanged`. The SDK-retry connection alert and the per-agent `reconnecting` alert stay,
  for the short tries.
- **The card** (`web/src/attention/AlertCard.tsx`, actions in `attention/alerts.ts:134`): "can't
  reach the model since 14:02 — 6 agents waiting, next check 14:47", with **retry now**
  (`POST /api/outages/:provider/retry-now`), **stop waiting**
  (`POST /api/outages/:provider/stop-waiting`, which ends every agent in it `failed` as today) and
  **agents** (open the first).
- **On each agent:** the agent screen's reconnect bar (`web/src/agent/Reconnect.tsx`) also shows
  for a paused model-wait agent, with **retry now** and **stop waiting**. These go to the routes
  that exist (`routes/session.ts:1113-1142`), which `retryNow`/`stopRetrying` now answer for a
  waiting agent too.
- **The status bar** (`web/src/shell/shell.tsx:250`): "⚠ Claude down" while an outage alert
  exists.
- Routes and wire fields are additive, and every new field is optional.

## 8. Risks, and how each is tested

| Risk | Answer | Check (daemon §35 unless said) |
|---|---|---|
| The job fails or finishes while its agents wait | `#rollUpJob` leaves model-waiting agents unsettled | an agent whose tries are spent is paused with the note, and its job is `working` |
| A Copilot list served from the SDK's cache reads as up | `fresh` clears `modelsCache`; the canary catches a false up anyway | the canary fails again → the outage is probing, the agent waiting, nothing else resumed |
| A Claude login has no credential to probe with | unauthenticated probe: any answer but 429/529/5xx is up | `probeGateway` against a local server: 401 is up, 503 is down, no server is down |
| Bedrock or Vertex aren't probed through `/v1/models` | the canary is the real test | covered by the canary check above |
| The laptop sleeps through the schedule | 60 s heartbeat, a gap over 2 min probes at once | a clock jump probes before the step is due |
| A restart loses the wait | `reconcile` rebuilds it from the status event | a restart mid-wait rejoins, no RESTART_NUDGE |
| Pause all and an outage both resume | `'held'`; `release` resumes `HOLD_NOTE` only, then checks | Pause all during an outage resumes nothing until released |
| A thundering herd of resumes | one canary, then 5 s apart | one resumes, then the rest staggered |
| The probe hammers a provider with a limit | `notBefore` from `Retry-After` / `resetsAt` | a `Retry-After` is honoured, and retry now still probes |
| Track 2's edits to `supervisor.ts` | W1 stays in `#settle`'s retry branch, `#waitToRetry`, `reconcile`, `hold`/`release`, `#rollUpJob`, `retryNow`/`stopRetrying` | the rebase |

The rest of the Verify list (stop waiting ends `failed`; auth still goes straight to Needs You; a new
launch joins after its short tries; the schedule backs off to 15 min and stays) are checks in §35
too. Section 23's checks of the old "fails after the last retry" now assert the wait instead, and
each is listed in the commit and the final report. The web gets section 41 for the card's words and
buttons, and for the agent's **stop waiting**.

**Not checked by a machine:** a real outage (the network off mid-run), and the screens in a
browser. Both are left for the person's checklist (TODO "Checks that need a person").
