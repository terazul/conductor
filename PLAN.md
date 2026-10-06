# Conductor — parallel execution plan

Orchestrator for many Claude Code agents across many projects, with a browser UI.
Design reference: [mockups/conductor.html](mockups/conductor.html) (7 screens, `a` toggles annotations).

**Execution model:** 5 Claude Code agents working concurrently in isolated git worktrees, coordinated by a frozen type contract rather than by conversation.

> There is a pleasing recursion here: the file-collision problem these agents must avoid is the same one §7 says Conductor itself has to solve. If the build hits it, that's data.

---

## 1. What the SDK actually gives us

I checked the Agent SDK docs before planning, and two findings shaped the architecture. Everything below is built on them.

| Need | Mechanism | Note |
|---|---|---|
| Drive a session | `query({ prompt, options })` from `@anthropic-ai/claude-agent-sdk`, **streaming input mode** (`prompt` as `AsyncIterable<SDKUserMessage>`) | required for mid-task redirect + `interrupt()` |
| Ask the human | `canUseTool(toolName, input, { signal, suggestions })` → `{behavior:"allow", updatedInput}` \| `{behavior:"deny", message}` | **"The callback can stay pending indefinitely."** |
| "Allow always" | echo `suggestions` entries where `destination === "localSettings"` back as `updatedPermissions` | writes the rule to `.claude/settings.local.json` |
| Clarifying questions | `canUseTool` with `toolName === "AskUserQuestion"`; reply `{questions, answers}` keyed by question text → option `label` | 1–4 questions, 2–4 options each |
| See *every* tool call | `PreToolUse` hook returning `{ async: true }` | finding A |
| Survive a restart while blocked | `PreToolUse` → `permissionDecision: "defer"` | finding B |
| Interrupt | `q.interrupt()` | aborts a pending `canUseTool` in ~32ms |
| Resume | `options.resume: sessionId`, plus `forkSession`, `resumeSessionAt` | id from the **`session_id` field on every message**. `q.getSessionId()` does **not** exist in v0.3.278 — the docs page listed it, Track A's spike proved otherwise |
| Cost / tokens | `SDKResultMessage.total_cost_usd`, `.usage.*` | |
| Escalate to Slack/push | `PermissionRequest` hook | distinct from `canUseTool` |

### Spike results — all three propositions PASS (Track A, SDK v0.3.278)

**The go/no-go gate is cleared. No pivot needed.**

1. **Indefinite hold — PASS.** A `canUseTool` promise held 65s and resolved from outside; the tool then ran. An accidental run held 4+ minutes with the process healthy. No internal timeout.
2. **Park and resume across process death — PASS.** `defer` ends the query with `terminal_reason: 'tool_deferred'`, and — undocumented, but the useful part — the result message carries `deferred_tool_use: {id, name, input}` naming the exact parked call. After killing the whole process tree, a **fresh** process with `options.resume` had the identical call **re-offered automatically**; `PreToolUse` re-fired, `allow` was returned, the write landed. No nudge, no extra model turn.
3. **Full-fidelity observation — PASS.** Under `acceptEdits` with loose `allowedTools` the async `PreToolUse` hook saw **7 of 7** calls; `canUseTool` saw **0**. The SDK now emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` stating finding A almost verbatim — confirmed behaviour, not inference.

**Measurement (a) — event volume.** One busy agent: 0.65 SDK messages/s, 0.25 `tool_start`/s → ~4.5/s at seven agents, so the hub's 10 Hz coalescing has ~15x headroom. With `includePartialMessages: true` the same task hit 7.72/s (231 messages, 205 of them partials) → ~54/s at seven. **Partials stay off**; the transcript renders whole blocks anyway.

**Measurement (b) — resume cost.** 633ms to first message, 678ms to the deferred call being re-offered, plus one replayed turn (~$0.075 on Sonnet). Parking is cheap.

**The two park routes are not equivalent.** `canUseTool` cannot return `defer`, so escalating *held* to *parked* needs another mechanism. `interrupt()` aborts in 32ms, but resume does **not** re-offer the call — it needs a synthetic continuation and the model *re-decides* (~26s, a full extra turn, ~$0.155). So `defer` is exact and ~40x cheaper; `interrupt` is lossy. And `defer` can only come from `PreToolUse`, which fires *before* the SDK decides whether a human is needed at all — deferring pre-emptively would park calls `acceptEdits` was about to approve and stop agents dead. Hence: only park a call already known to need a human, and never reimplement the SDK's permission logic to predict it.

**`DEFER_AFTER` = 90s, confirmed** (env `CONDUCTOR_DEFER_AFTER_MS`). The data would support 30-45s, but holding keeps the prompt cache warm and is the only path that can honour `allow_edited`, so parking early trades a real capability for a small saving. The policy that actually matters is Track A's addition: **with no WebSocket client connected, park immediately.** That targets "nobody can answer" directly instead of using a timer as a proxy for it.

### Finding A — `canUseTool` is not an observation channel

> "The callback never fires for auto-approved tools."

Anything cleared by an allow rule, `acceptEdits`, or `bypassPermissions` never reaches `canUseTool`. It cannot feed the live activity view: in the mode people actually run agents in, it would fire almost never and every sparkline would sit flat while agents worked.

**Consequence — two channels, two jobs:**
- `PreToolUse` hook, no matcher, `{ async: true, asyncTimeout: 30000 }` → fires on **every** call, agent never waits on us. Activity feed, sparkline, audit log.
- `canUseTool` → human decisions only.

### Finding B — `defer` is the durability story

> "…register a `PreToolUse` hook that returns the `defer` decision instead of waiting in the callback, so the process can exit and resume later from the persisted session."

A pending `canUseTool` promise holds a live process. Fine for 40 seconds; not for the 12-minute wait in the mockup, and it dies with the daemon. `defer` ends the query cleanly so the session resumes from disk.

**Consequence — a deadline policy, not one code path:**
- Under `DEFER_AFTER` (default 90s): hold the promise. Agent stays warm.
- Beyond it: `PreToolUse` returns `defer`, query ends, request persists, agent shows as *blocked (parked)*. Answering re-launches with `options.resume`.

Two documented gotchas, both load-bearing:
- With `defer`, `updatedInput` is **ignored** → "edit & run" must take the hold path.
- Precedence is `deny` > `defer` > `ask` > `allow` → a deny rule still beats a park.

---

## 2. Architecture

```
┌─ browser ──────────────────────────────────────────┐
│  React SPA (the 7 screens)                         │
│   REST for commands · WebSocket for the event feed │
└───────────────┬────────────────────────────────────┘
                │  127.0.0.1:7777  (+ bearer token)
┌───────────────▼────────────────────────────────────┐
│  conductord — one long-lived Node process          │
│  Supervisor · Arbiter · EventLog · WorktreeMgr      │
│  ServerRegistry · PreviewProxy · Watcher            │
│  SQLite (WAL)                                       │
└────────────────────────────────────────────────────┘
        │ one SDK query() per agent, streaming input
        ▼   git worktrees under <repo>/.conductor/wt/<job>
```

**Stack:** TypeScript throughout. pnpm workspace. Fastify + `ws`. **`node:sqlite`** (WAL) — the native `better-sqlite3` binding would not build here, and five agents each installing is five chances to fail. Vite + React. Tailwind v4 seeded with the mockup's tokens.

### The event log is the whole design

Everything the UI shows is a projection of one append-only table. Each agent has a monotonic `seq`; the browser holds a cursor and reconnects with `?since=<seq>`, so a dropped socket replays instead of losing state.

```ts
type Event =
  | { kind: 'text';       text: string }
  | { kind: 'tool_start'; toolUseId: string; tool: string; input: unknown }
  | { kind: 'tool_end';   toolUseId: string; ok: boolean; summary: string }
  | { kind: 'file_edit';  path: string; added: number; removed: number }
  | { kind: 'request';    requestId: string; /* needs a human */ }
  | { kind: 'resolved';   requestId: string; decision: Decision }
  | { kind: 'status';     status: AgentStatus }
  | { kind: 'usage';      costUsd: number; inputTokens: number; outputTokens: number };
```

Derived, never stored: agent status, project status (worst of its agents), sparkline (`tool_start` per 15s bucket), diffstat (sum of `file_edit`).

**This type is also the parallelism mechanism.** Freeze it and five agents can build against it without talking to each other.

---

## 3. W0 — the contract (serial, ~1 day, one agent)

Nothing parallelizes until this lands. It is deliberately small and deliberately frozen.

One agent, on `main`, produces:

1. `pnpm-workspace.yaml` + root `package.json` with **every dependency all tracks will need, pre-declared.** No track ever edits root deps.
2. `packages/shared/src/` — `events.ts`, `wire.ts` (REST + WS message types), `status.ts`, `tokens.css` (design tokens lifted from the mockup). **Read-only for all tracks after this.**
3. `packages/daemon/src/index.ts` — Fastify bootstrap with **filesystem route auto-registration** (glob `src/routes/*.ts`). Adding an endpoint = adding a file. No shared route table to conflict on.
4. `packages/daemon/src/db/` — SQLite bootstrap + the migration convention: numbered files, **one per track, append-only, never edit an existing one.**
5. `packages/web/src/main.tsx` — shell mount + **screen auto-registration** (glob `src/*/route.tsx`). Same trick, no shared router.
6. `fixtures/` — a recorded real session as JSONL (`session-basic.jsonl`) plus a `permission-requests.jsonl` and a scratch git repo. **This is the single biggest unlock:** every UI track builds with zero daemon.
7. A `CONTRACT.md` stating the ownership rules in §4 and the escalation rule in §6.

**Gate:** `pnpm -r build` is green and `pnpm dev` serves an empty shell. Then freeze.

---

## 4. The five tracks

All five start the moment W0 lands. Each owns **disjoint directories** and writes nothing outside them.

| Track | Owns (writes only here) | Builds against | Risk |
|---|---|---|---|
| **A — Session engine** | `daemon/src/session/`, `daemon/src/arbiter/`, `daemon/src/routes/session.ts`, `db/migrations/010_session.sql` | the real SDK | **high** |
| **B — Shell, Fleet, Transcript** | `web/src/shell/`, `web/src/fleet/`, `web/src/agent/` | `fixtures/session-basic.jsonl` | low |
| **C — Workspace** | `daemon/src/workspace/`, `daemon/src/routes/workspace.ts`, `web/src/files/`, `db/migrations/030_workspace.sql` | scratch git repo | medium |
| **D — Preview** | `daemon/src/preview/`, `daemon/src/routes/preview.ts`, `web/src/preview/` | a trivial vite app in fixtures | medium |
| **E — Attention UX** | `web/src/attention/` | `fixtures/permission-requests.jsonl` | low |

Tracks C and D are **vertical slices** — daemon and web halves of one feature, owned by one agent. That's intentional: it removes a cross-track dependency that would otherwise need coordination.

### Track A — Session engine *(critical path)*

Starts with the **spike, which is a go/no-go gate on A only** — the other four tracks proceed regardless.

Spike proves three things, in a throwaway script:
1. **Indefinite hold** — `canUseTool` fires, a decision arrives over a socket 3 minutes later, the tool runs.
2. **Park and resume** — `PreToolUse` returns `defer`; query ends; **`kill -9` the process**; restart; `options.resume` picks the session up and the deferred call proceeds with a decision made while the daemon was down.
3. **Full-fidelity observation** — with `permissionMode: 'acceptEdits'` and loose `allowedTools`, the async `PreToolUse` hook still reports every call (finding A, end to end).

If #2 fails, the parked-agent model is wrong: A pivots to "hold a process per blocked agent, cap concurrency hard," and §7's `DEFER_AFTER` question becomes moot. **Nothing else in the plan changes** — which is the point of putting the risk in one track.

Then: `AgentRunner` (wraps `query()`, translates `SDKMessage` → `Event`), the two permission channels, `Arbiter` (pending requests + deadline policy), slot semaphore, cost/token reporting.

Also measure in the spike: event volume from one busy agent (sets the coalescing rate) and wall-clock cost of a resume (sets `DEFER_AFTER`). Publish both numbers to the other tracks — they're the only facts A owes anyone.

### Track B — Shell, Fleet, Transcript

Screens 1, 2, 3. App shell, left rail, project cards with status rollup and sparklines, agent lanes, transcript renderer (collapsed tool calls, inline diffs), composer, inspector. Replays the fixture through the same reducer the live socket will use, so swapping in the real feed at I2 is a one-line change.

### Track C — Workspace

`WorktreeMgr` (create/reuse/destroy under `.conductor/wt/<job>`, lock per worktree), `chokidar` watcher → `file_edit` events, server-side markdown rendering (`remark`, sanitized), file tree with change badges, raw/rendered/diff toggle, in-place `PLAN.md` editing.

### Track D — Preview

The non-obvious part: **you cannot reliably iframe `localhost:3000` from `localhost:7777`.** Different origin, and most dev servers ship `X-Frame-Options`/`frame-ancestors`. So `ServerRegistry` learns ports from `Bash` tool calls, and `PreviewProxy` serves `/preview/:jobId/*` from the daemon's own origin, stripping frame-blocking headers. Plus console capture via injected script, device-width frames, "send errors to agent."

Fully independent — a reverse-proxy problem with no SDK surface.

### Track E — Attention UX *(the differentiator)*

Screen 4. Permission card (exact command, matched rule, reversibility, cwd), the four actions mapped to real returns, `AskUserQuestion` as option cards with `toolConfig.askUserQuestion.previewFormat: 'html'` — we're a browser, so Claude's option previews render natively; a terminal orchestrator can't do this. Queue with aging bars, `⏎` answers and advances, `⇥` skips. Notification ladder: tab badge → Web Notification → sound at 60s.

---

## 5. Collision hotspots

This table is the plan. Parallel agents don't fail at features, they fail at these seven files.

| Hotspot | Why it collides | Rule |
|---|---|---|
| root `package.json`, `pnpm-workspace.yaml` | every track adds deps | **all deps pre-declared in W0.** Tracks edit only their own package's manifest |
| `packages/shared/**` | every track reads it | **read-only after W0.** Need a new event type? Escalate (§6) — do not edit |
| daemon route table | every track adds endpoints | **eliminated** — routes auto-globbed, one file per track |
| web router | every track adds screens | **eliminated** — screens auto-globbed, one file per track |
| DB migrations | every track adds tables | numbered per track (`010`, `020`, `030`…), **append-only, never edit an existing file** |
| Tailwind config / tokens | shared styling | frozen in W0 from the mockup |
| `fixtures/*.jsonl` | tracks add cases | one file per track; never edit another's |

Merge order: `shared` (W0) → A → C, D → B, E. With disjoint ownership the order barely matters, which is the goal.

---

## 6. The one rule that makes this work

> **An agent that needs a change outside its own directories stops and reports it. It does not make the change.**

Cross-track edits are how a parallel build turns into an unmergeable mess. The cost of stopping is minutes; the cost of five agents independently editing `shared/events.ts` is a day of untangling.

Escalations queue up and land as a **contract amendment**: W0's agent (or you) makes the edit on `main`, all tracks rebase. Batch them — aim for one amendment window per integration gate, not a trickle.

---

## 7. Integration gates

| Gate | When | Proves |
|---|---|---|
| **I1** | end of day 2 | every track's *stub* merges cleanly. Validates the ownership model before real code exists — cheap to fix now, expensive later |
| **I2** | ~day 8 | A + B: a real session drives the real UI. Fixtures retired for the transcript |
| **I3** | ~day 11 | A + E: a real permission request round-trips, including one parked and resumed |
| **I4** | ~day 14 | C + D join. Whole app on one screen |
| **I5** | ~day 18 | hardening: `kill -9` with 3 agents live and 2 blocked, everything recovers |

I1 is the one people skip and shouldn't. A stub-only merge on day 2 is the cheapest possible test of whether the ownership boundaries are real.

---

## 8. Timeline

```
day  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
W0   ██
A       ░░░░ spike ░░  ████████████████████████
B       ████████████████████████████
C       ████████████████████████
D       ████████████████
E       ████████████████████████
gates      I1          I2       I3       I4          I5
```

**~3.5 weeks wall clock**, versus ~6–7 sequential.

Not a 5× speedup, and it's worth being clear why: **Track A is the critical path no matter how many agents you add.** It's the biggest, the riskiest, and the only one that can't be parallelized further (the SDK semantics have to be understood by one mind). B, C, D, and E finishing early doesn't shorten A — it just means integration is waiting when A lands instead of the reverse. The saving is real but it's ~2× on wall clock, not 5×.

If you want A shortened, the lever is scope: ship the hold path in A and defer parking to a second pass.

---

## 9. Launch prompts

One per worktree. Each ends with the same two constraints, which is the point.

**Track A**
> Read `PLAN.md` and `CONTRACT.md`. You own Track A: the session engine. Start with the Phase-0 spike as a throwaway script — prove indefinite `canUseTool` hold, prove `defer` + `kill -9` + `options.resume` recovery, prove the async `PreToolUse` hook sees every call under `acceptEdits`. Report all three results and the two measurements (event volume/sec, resume wall-clock) before writing production code. Then build `daemon/src/session/` and `daemon/src/arbiter/`.
> You may write only in `daemon/src/session/`, `daemon/src/arbiter/`, `daemon/src/routes/session.ts`, `db/migrations/010_session.sql`. `packages/shared/` is read-only. If you need a change anywhere else, stop and report it — do not make it.

**Track B**
> Read `PLAN.md` and `CONTRACT.md`. You own Track B: shell, Fleet screen, agent transcript. Build against `fixtures/session-basic.jsonl` — no daemon. Replay the fixture through the same reducer the live WebSocket will use, so the real feed swaps in without a rewrite. Match `mockups/conductor.html` screens 1, 2, 3 closely; the tokens are in `shared/src/tokens.css`.
> You may write only in `web/src/shell/`, `web/src/fleet/`, `web/src/agent/`. `packages/shared/` is read-only. If you need a change anywhere else, stop and report it — do not make it.

**Track C**
> …You own Track C: workspace — worktree lifecycle, file watching, markdown rendering, the Files screen (mockup #5). Test against the scratch repo in `fixtures/`.
> You may write only in `daemon/src/workspace/`, `daemon/src/routes/workspace.ts`, `web/src/files/`, `db/migrations/030_workspace.sql`. …

**Track D**
> …You own Track D: preview — dev-server registry, the reverse proxy at `/preview/:jobId/*` (read §4 on why a plain iframe won't work), console capture, the Preview screen (mockup #6).
> You may write only in `daemon/src/preview/`, `daemon/src/routes/preview.ts`, `web/src/preview/`. …

**Track E**
> …You own Track E: the attention queue (mockup #4) — the feature this app exists for. Build against `fixtures/permission-requests.jsonl`. Include `AskUserQuestion` with HTML option previews. Keyboard-first: `⏎` answers and advances, `⇥` skips.
> You may write only in `web/src/attention/`. …

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **`defer`/resume doesn't work as documented** | Track A spike gate, day 3–5. Contained to one track by design |
| **Agents edit outside their lanes** | §6 rule, stated in every launch prompt; I1 stub merge on day 2 catches it early |
| **Contract churn stalls everyone** | Batch amendments into gate windows; W0 over-specifies rather than under-specifies |
| **Event volume floods the browser** | Server-side coalescing (~10 Hz), `{async:true}` hooks, `seq` cursor for lossless reconnect |
| **Concurrent worktree writes corrupt state** | Resolve the open question below before `WorktreeMgr`; lock per worktree |
| **Cost** — 7 concurrent Opus agents adds up, and so do 5 building this | Per-job budget cap; daily total in the status bar from day one |
| **Security: browser UI that runs arbitrary shell** | Bind `127.0.0.1`, bearer token on REST *and* WS upgrade, never default to `bypassPermissions`, deny rules that survive every mode. Phone notifications need *egress* only |
| **Context-% is an estimate** | Show tokens first; percentage only once derived from the Models API window |
| **SDK under active development** | Pin the exact version; all SDK contact inside `AgentRunner` |

---

## 11. Decisions still open

1. **Agents per worktree.** The mockup shows builder + validator working one project at once; they *will* collide on files. Recommended: one worktree per **job**, agents within it coordinated (sequential handoff, or disjoint scopes enforced by an `Edit(path)` deny rule). Alternatives — worktree per agent (merge conflicts become the product) or a free-for-all (silent corruption) — are both worse. **Needed before Track C writes `WorktreeMgr`.**
2. **`DEFER_AFTER` default.** Set by the spike's resume-cost measurement.
3. **Multi-machine.** Localhost assumed throughout. Remote agents change transport, auth, and file access substantially.
4. **Bring-your-own-agent.** Plan is Claude-Code-specific. `AgentRunner` is the seam, but only if the event model stays driver-agnostic from W0 — cheap now, expensive later.
5. **Event log retention (F8) — decided.** Removal keeps events. Diagnostics has a cleanup button that deletes the events of removed jobs and agents, on request only (CONTRACT Amendment 36). The token stays opt-in (I5).
