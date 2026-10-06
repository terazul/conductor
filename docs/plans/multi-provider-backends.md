# Plan: run agents on more than Claude Code — GitHub Copilot and OpenRouter

Instructions for a coding agent. Read the whole file before touching code.

## Goal

Today every agent is a Claude Code session driven through `@anthropic-ai/claude-agent-sdk`.
Make the agent engine pluggable so a job can run on:

| Provider id  | Runs on                                                         |
|--------------|-----------------------------------------------------------------|
| `claude`     | Claude Agent SDK. The current behaviour, unchanged.             |
| `copilot`    | `@github/copilot-sdk`, using the user's GitHub Copilot login.   |
| `openrouter` | `@github/copilot-sdk` in BYOK mode, pointed at OpenRouter's OpenAI-compatible API. |

Everything downstream of the runner (event log, hub, store, web UI) already speaks
`EventPayload`, not SDK messages. [runner.ts](../../packages/daemon/src/session/runner.ts)
calls itself "the only place in Conductor that touches the Agent SDK", and PLAN.md §11.4
reserves a "bring your own agent" seam. This work widens that seam. It is not a rewrite.

## Rules

- **Behaviour for `claude` must not change.** `make test` stays green after every step.
- **One step, one commit**, each with its own CONTRACT.md amendment (numbers continue after
  70; check the file for the current highest). This is how every earlier item was done.
- **No real API calls in tests.** Fake the SDKs, as `session/verify.ts` already does through
  the swappable `sdk` object in `runner.ts`.
- **No new dependencies** other than `@github/copilot-sdk` (CONTRACT §3). Pin its version.
- **Never log, store or echo an API key.** Read `OPENROUTER_API_KEY` from the environment or
  the settings file, the way `session/models.ts` handles the Anthropic credential.
- **Don't invent numbers.** If a backend can't report a dollar cost or a context percentage,
  report nothing. Do not estimate. (README, "Known gaps".)
- Follow the repo style: comments only where a reader needs help, the same file header
  pattern, TypeScript strict.
- Do not fix unrelated issues. Do not edit the unrelated projects elsewhere in the git repo
  (the repo root is `playground/`; this project is `conductor/`).

## Orientation (read these first)

- `packages/daemon/src/session/runner.ts`: `AgentRunner`. Public surface used by the
  supervisor: `run`, `send`, `interrupt`, `stop`, `setModel`, `agentId`, `isLive`,
  `sessionId`. Also `RunnerScope`, `RunOpts`, `RunOutcome`, `helperTools`.
- `packages/daemon/src/session/supervisor.ts`: constructs runners at two places
  (`new AgentRunner(...)`, around lines 717 and 1108).
- `packages/daemon/src/arbiter/index.ts`: human permission decisions. Imports
  `PermissionResult` from the Claude SDK; that must become a neutral type.
- `packages/daemon/src/session/translate.ts`: maps tool names and inputs to labels,
  summaries, file edits, todos and questions. Assumes Claude tool names (`Bash`, `Edit`,
  `Write`, `TodoWrite`, `AskUserQuestion`).
- `packages/daemon/src/session/models.ts`: model catalogue, Claude-only, with
  `opus/sonnet/haiku` tiers.
- `packages/daemon/src/session/budget.ts`, `store.ts`: budgets and persistence.
- `packages/daemon/src/db/migrations/`: numbered `.sql` files (latest is `100_persona.sql`).
- `packages/shared/src/wire.ts`, `events.ts`: the frozen contract. Changes are additive
  only and each needs an amendment.
- `packages/daemon/src/session/spike.ts`, `session/verify.ts`: the pattern for a spike and
  for fake-SDK tests.
- `Makefile` (`make test`), `CONTRACT.md` (amendment log), `docs/MANUAL.md`.

Run `pnpm install` before anything else. `node_modules` is absent on a fresh checkout and
`make start` does not install.

## Step 0 — Spike: what does the Copilot SDK actually do?

Do not skip this. Everything below depends on the answers. Research the current
`@github/copilot-sdk` docs (https://github.com/github/copilot-sdk, its `nodejs/README.md`
and `docs/`), then write `packages/daemon/src/session/backends/copilot-spike.ts` that
exercises it against the real service (the user will run it; you may not have credentials).

Answer each question with evidence, in `docs/plans/multi-provider-findings.md`:

1. Can input be streamed or injected mid-run (redirect while working)?
2. Can a run be interrupted?
3. Can a session be resumed by id after the process restarts?
4. Is there a permission callback (`onPermissionRequest` or similar) that can **wait for a
   human** for minutes without breaking the session?
5. Is there a hook that sees **every** tool call, including auto-approved ones, without
   blocking it?
6. Can a pending call be deferred and re-offered on resume (Claude's `defer`)?
7. What usage does it report per turn: tokens, premium requests, dollars?
8. Can in-process custom tools be registered (needed for the `start_helper` and
   `list_helpers` helper tools)?
9. What are its tool names and input shapes for shell, file read/edit/write, and todo?
10. BYOK: exact `provider` config for an OpenAI-compatible URL, and whether it works with
    **no GitHub login** at all.
11. How does it list models, for Copilot and for BYOK?

Mark each answer yes, no or partial. A "no" becomes a `false` flag in `capabilities`
(step 1). It does not stop the work.

**If question 10 is "no"** (BYOK needs a GitHub login), `openrouter` gets its own small
`openai-compat` backend instead. Say so in the findings file and stop to ask the user
before building it.

Commit: spike and findings only.

## Step 1 — The backend interface

Add `packages/daemon/src/session/backend.ts`:

- `AgentBackend` interface: exactly what the supervisor uses today (`run`, `send`,
  `interrupt`, `stop`, `setModel`, `agentId`, `isLive`, `sessionId`).
- `BackendCapabilities`: `{ defer, resume, costUsd, effort, planMode, helperTools }`, each
  boolean, set from the step 0 findings.
- `ProviderId = 'claude' | 'copilot' | 'openrouter'`.
- A neutral `PermissionDecision` type to replace the SDK's `PermissionResult` in the arbiter.
- `listModels(): Promise<ProviderModel[]>` on each backend, where `ProviderModel` is
  `{ id, displayName, efforts? }`.

Types only; no behaviour change. Typecheck.

## Step 2 — Move the Claude code behind it

- Move the `AgentRunner` to `session/backends/claude.ts`, named `ClaudeBackend`,
  implementing `AgentBackend`. Keep every line of logic. Keep the exported `sdk` swap point
  so existing tests still work.
- Replace the SDK type import in `arbiter/index.ts` with `PermissionDecision`.
- Leave a re-export at the old path if that avoids churn in `verify.ts`.
- `make test` must be fully green with **no test changes beyond import paths**. That proves
  nothing moved.

## Step 3 — Registry and provider per agent

- `session/backends/index.ts`: `createBackend(provider, db, scope)`.
- Change the two supervisor call sites to use it.
- Migration `110_provider.sql`: add `provider TEXT NOT NULL DEFAULT 'claude'` to the agent
  table. Existing rows stay `claude`.
- Add `provider` (optional, default `claude`) to the spawn request in `shared/src/wire.ts`,
  to the agent wire type and to the REST routes. Additive only.
- A stored `sessionId` is only valid for the provider that made it. Never hand a Claude
  session id to the Copilot backend.
- Tests: spawn with no provider gives `claude`. Spawn with an unknown provider gives a 400
  with a clear message.

## Step 4 — The Copilot backend

`session/backends/copilot.ts`, implementing `AgentBackend` for `copilot` and `openrouter`
(they differ only in the session's connection config).

- One `CopilotClient`, started lazily and stopped on daemon shutdown. One session per agent.
- Translate its events into `EventPayload` and feed the same `#emit` path Claude uses, so
  the transcript, activity feed and sparkline work unchanged. Keep the translation in a
  pure function so it can be tested with recorded events.
- Permissions: route the SDK's permission callback through the existing `arbiter`, so
  Needs you, parking and the `rm -rf` reversibility check work as they do for Claude.
- Enforce `disallowedTools` and the autonomy settings **in Conductor's permission callback**,
  because this SDK will not do it for you. A disallowed call is denied even in the loosest
  autonomy mode. This is the real safety net and must have a test.
- Copilot tool names differ from Claude's. Add a small name-normalising map and use it in
  `translate.ts`, so `toolLabel`, `isWriteTool` and `fileEditFromTool` work for both. Do not
  fork the functions.
- Helper tools: register them if the SDK supports in-process tools (step 0 question 8),
  otherwise set `helperTools: false` and hide the feature for these agents.
- `openrouter` config: base URL `https://openrouter.ai/api/v1`, key from
  `OPENROUTER_API_KEY` or settings, model id required (e.g. `anthropic/claude-sonnet-4.5`).
  Missing key gives a clear spawn-time error, not a mid-run failure.
- Where the SDK lacks `defer`/resume, a parked request on this backend is lost on daemon
  restart. Make that explicit: mark the request as expired in the UI rather than leaving it
  hanging.
- Tests: use a fake client (swap point like `sdk`). Cover a normal turn, a permission wait
  followed by approve, deny, a disallowed tool, interrupt, a resume, and a failed run
  surfacing through the existing alert path.

## Step 5 — Budgets and usage

- A backend may report `costUsd: null`. In `budget.ts`, fall back to a cap on tokens (or
  premium requests, if that is what the SDK reports), and have the UI label the unit
  honestly.
- OpenRouter returns real per-call cost. Use it if the SDK surfaces it; otherwise `null`.
- `spend today` on Fleet sums dollars only. Do not add tokens to dollars.
- Tests for the null-cost path and for the cap being reached.

## Step 6 — Model catalogue per provider

- `GET /api/models?provider=<id>`; default `claude`, existing behaviour unchanged.
- `copilot`: from the SDK's model listing. `openrouter`: `GET /api/v1/models`, cached with
  the same TTL as the Claude list, and reading the key without ever logging it.
- Replace the `opus|sonnet|haiku` assumption with a free-form id plus display name for
  non-Claude providers. Keep the Claude tiers as they are. Additive wire change only.
- Validate a model id against the provider's list at spawn.

## Step 7 — UI

- Spawn (`packages/web/src/spawn/route.tsx`): provider selector, defaulting to `claude`. The
  model picker follows the provider.
- Settings (`packages/web/src/settings/route.tsx`): an OpenRouter section for the key (shown
  as set or unset, never revealed) and an optional base URL; show Copilot login status.
- Composer and details panel: hide or disable controls whose capability is false (plan
  mode, effort, dollar budget bar, helper tools). Never leave a control that silently does
  nothing.
- Agent card: a small provider badge.
- Update the web `verify.ts` suites: spawn payload carries the provider, controls hide on
  capability flags.
- Add a fixture agent on a non-Claude provider so `make fixture` shows it with no cost.

## Step 8 — Docs

- CONTRACT.md: one amendment per step, as above.
- README: Prerequisites gain "optional: Copilot login; `OPENROUTER_API_KEY`". Replace the
  broken link to `docs/ARCHITECTURE.md` (the file does not exist) or create the file.
- docs/MANUAL.md: a Providers section, with what each can and cannot do, and the cost
  caveat.
- Tick the item in TODO.md.

## Acceptance

- `pnpm -r typecheck` and `make test` are green, with no real network access.
- A Claude agent behaves exactly as before: same events, same permission flow, same spend.
- With a Copilot login, an agent spawns on `copilot`, streams a transcript, shows a Needs
  you request for a write or shell call, and resumes after a reply.
- With `OPENROUTER_API_KEY` set, an agent spawns on `openrouter` with a chosen model.
- A disallowed tool is refused on every backend.
- No key appears in logs, the event log, the database or any API response.

## Decisions to ask the user about, not assume

- Step 0, question 10 turning out "no" (BYOK needs a GitHub login).
- Whether a non-Claude agent may resume across daemon restarts if the SDK can't.
- Any change to the frozen contract in `shared/` beyond additive fields.
