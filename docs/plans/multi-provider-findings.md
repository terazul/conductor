# Findings: what `@github/copilot-sdk` 1.0.16 can do

Step 0 of [multi-provider-backends.md](multi-provider-backends.md). These answers come from
the SDK's type definitions and README in `node_modules/@github/copilot-sdk` (paths below are
relative to its `dist/`; `gen/` is `dist/generated/`), from the docs in
`github/copilot-sdk` on `main`, and from what the runtime ships. They are
read-from-source. Each one is checked against the real service by
[copilot-spike.ts](../../packages/daemon/src/session/backends/copilot-spike.ts) where
that matters. Run the spike before trusting a YES in production.

The bundled runtime is `copilotCliVersion` 1.0.90.

## Summary

| #  | Question                                   | Answer  | Capability flag      |
|----|--------------------------------------------|---------|----------------------|
| 1  | Inject input mid-run                       | YES     | —                    |
| 2  | Interrupt a run                            | YES     | —                    |
| 3  | Resume by id after a restart               | YES     | `resume: true`       |
| 4  | Permission callback that can wait minutes  | YES     | —                    |
| 5  | See every tool call without blocking       | YES     | —                    |
| 6  | Defer a call and re-offer it on resume     | PARTIAL | `defer: false`       |
| 7  | Usage per turn                             | PARTIAL | `costUsd: false`     |
| 8  | In-process custom tools                    | YES     | `helperTools: true`  |
| 9  | Built-in tool names and inputs             | PARTIAL | —                    |
| 10 | BYOK with no GitHub login                  | YES     | —                    |
| 11 | Model listing                              | YES     | —                    |

The other two flags:

- **`effort: true`**. `SessionConfig.reasoningEffort` takes
  `low | medium | high | xhigh | max` (`types.d.ts:1609`). `ModelInfo` says which models
  support it.
- **`planMode: false`**. The session has a `plan` mode (`session.rpc.mode.set`,
  `gen/rpc.d.ts:29676`, plus `onExitPlanModeRequest`). It is a different mechanism from
  Claude's, so the flag stays off until step 4 wires it and tests it. Until then the
  control is hidden, not left doing nothing.

The plan says question 10 turning out "no" would stop the work. It is YES, so `openrouter`
runs on this SDK in BYOK mode and no `openai-compat` backend is needed.

## 1. Inject input mid-run: YES

`session.send({ prompt, mode: 'immediate' })` steers the turn in progress.

- The default `'enqueue'` queues the message as the next turn (`types.d.ts:2778`;
  `gen/rpc.d.ts:4003`).
- Steering is best effort. If the turn ends first, the message moves to the queue. If a
  tool is running, the message lands after it.
- `send` returns the message id and does not wait.
- `session.rpc.queue.*` manages pending messages.

This matches what `ClaudeBackend.send` gives the supervisor.

## 2. Interrupt: YES

`session.abort()` (`session.d.ts:297`) stops the turn and leaves the session usable. An
`abort` event carries the reason (`gen/session-events.d.ts:6198`). Tool handlers get an
`AbortSignal`. `sendAndWait`'s timeout does *not* abort (`session.d.ts:153`). Don't use it
as one.

## 3. Resume by id: YES

`client.resumeSession(id, config)` (`client.d.ts:248`). Sessions live in
`$COPILOT_HOME/session-state/<id>/` (`CopilotClientOptions.baseDirectory` sets
`COPILOT_HOME`). `session.disconnect()` keeps them on disk.

- `createSession` takes a caller-chosen `sessionId`. The backend should pass the agent's
  own id, so the id we store is the one we chose.
- On resume, re-supply everything that is not persisted: the BYOK `provider` (keys are
  never written to disk), `onPermissionRequest`, `tools`, `hooks`, `workingDirectory` and
  `additionalDirectories`.
- Concurrent access to one session is undefined. Conductor runs one backend per agent, so
  this holds already.

## 4. A permission callback that can wait for a human: YES

`onPermissionRequest(request, { sessionId })` returns a `Promise` (`types.d.ts:1002`). It
runs off a `permission.requested` event, not an RPC request with a deadline. The SDK
awaits the handler, then answers with `handlePendingPermissionRequest`
(`session.js:761-767`, `:924-941`). No timeout exists on the SDK side. The runtime's side
is unconfirmed; that is what the spike's `hold` (70 s) checks.

- **Request:** a union on `kind`: `shell | write | read | mcp | url | memory | custom-tool
  | hook | …` (`gen/session-events.d.ts:932`).
  - `shell` carries `fullCommandText` and `commands[{identifier, readOnly}]`.
  - `write` carries `fileName` and `diff`.
  - `read` carries `path`.
  - `custom-tool` carries `toolName` and `args`.
- **Answers:**
  - `approve-once`
  - `approve-for-session` (optionally scoped to a tool or a command)
  - `approve-for-location`
  - `approve-permanently`
  - `reject` with `feedback`
  - `user-not-available`
  - `no-result` (leaves it pending)
- **If the handler throws,** the SDK answers `user-not-available` (`session.js:952`).

The arbiter's `PermissionDecision` maps onto these:

| `PermissionDecision`                  | Copilot answer                   |
|---------------------------------------|----------------------------------|
| `allow`                               | `approve-once`                   |
| `allow` with "allow all session"      | `approve-for-session`            |
| `deny` with its message               | `reject` with feedback           |

Only `approve-for-session` needs care, since the arbiter keeps its own rules.

## 5. See every tool call: YES

Every call fires `tool.execution_start {toolCallId, toolName, arguments}`, auto-approved
ones included (`gen/session-events.d.ts:6281`). The call's end fires
`tool.execution_complete {toolCallId, success, result?, error?}` (`:6513`). That event has
no `toolName`, so match it to the start by `toolCallId`.

Events are a subscription and do not block. This does the job of Claude's async
`PreToolUse` hook for the activity feed. The `onPreToolUse` hook exists too, but its input
has no `toolCallId` (`types.d.ts:1111-1205`). Use the events instead.

## 6. Defer and re-offer on resume: PARTIAL

There is no `defer`. `onPreToolUse` answers only `allow | deny | ask` (`types.d.ts:1119`).
Two things come close:

- Leaving a permission request pending, then resuming with
  `ResumeSessionConfig.continuePendingWork: true`. The SDK docs say the runtime re-emits
  `permission.requested` for anything still pending (`types.d.ts:2452-2464`). The default
  (`false`) treats pending work as interrupted.
- Declaration-only tools: those emit `external_tool.requested`, answered later with
  `session.rpc.tools.handlePendingToolCall`.

The re-emit on resume is the unconfirmed part, so `defer` stays `false`. Per the plan, a
request parked on this backend shows as **expired** after a daemon restart rather than
hanging. If the spike's `park` passes (SIGKILL while pending, resume, the call runs), step
4 can turn it on.

## 7. Usage: PARTIAL — tokens and premium requests, never dollars

- `assistant.usage` arrives once per model call (`gen/session-events.d.ts:5792`). Fields:
  - `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
    `reasoningTokens`
  - `cost`, the model's premium-request multiplier (experimental)
  - `copilotUsage.totalNanoAiu`
  - `isByok`

  It is ephemeral, so the backend must count as events arrive.
- `session.rpc.usage.getMetrics()` gives the session's totals, including
  `totalPremiumRequestCost` (`gen/rpc.d.ts:31355`).
- **No field holds dollars.** `ModelInfo.billing.tokenPrices` is a price list, and
  multiplying it out would be estimating, which the plan forbids.
- BYOK requests don't count against Copilot quotas. The provider (OpenRouter) bills them,
  and the SDK doesn't pass OpenRouter's per-call cost through.

So `costUsd: false` on both providers. Step 5 caps on tokens, or on premium requests for
`copilot`.

## 8. In-process custom tools: YES

`defineTool(name, { description, parameters, handler, skipPermission })`
(`types.d.ts:595`), passed in `SessionConfig.tools`.

- `parameters` takes plain JSON Schema; zod is optional (README:815).
- The handler gets `{ toolCallId, signal }` and returns a string or JSON.
- A custom tool raises a `custom-tool` permission request unless `skipPermission: true`.
- A tool whose name clashes with a built-in throws unless it sets `overridesBuiltInTool`.

`start_helper` and `list_helpers` can be registered as they are for Claude.

## 9. Built-in tool names and inputs: PARTIAL

The definitive list is `client.rpc.tools.list({ model })` at runtime (`gen/rpc.d.ts:28542`).
From the runtime's strings and local session logs:

| Claude name        | Copilot name                     | Input                                         |
|--------------------|----------------------------------|-----------------------------------------------|
| `Bash`             | `bash` (`powershell` on Windows) | `{ command, description, initial_wait?, mode? }` |
| `Read`             | `view`                           | `{ path, view_range? }`                       |
| `Grep` / `Glob`    | `grep` / `glob`                  | `{ pattern, path? }`                          |
| `Edit`             | `edit` or `str_replace_editor`   | `{ path, old_str, new_str }` / `{ command, path, … }` |
| `Write`            | `create`                         | `{ path, file_text }`                         |
| `TodoWrite`        | `update_todo`                    | `{ todos: string }` (a markdown checklist)    |
| `AskUserQuestion`  | `ask_user`                       | `{ question, choices? }`                      |
| `WebFetch`         | `web_fetch`                      | `{ url, … }`                                  |
| `Task`             | `task`                           | `{ agent_type, description, prompt, … }`      |

- Some models use `apply_patch` instead. It is a freeform tool, so its input is patch
  text, not JSON. `fileEditFromTool` can't show a diff for it; it falls back to the
  `tool.execution_complete` result.
- The exact required fields for `bash` are unconfirmed.
- `update_todo` is markdown, not Claude's structured list. The todo panel parses the
  checklist.

## 10. BYOK with an OpenAI-compatible URL and no GitHub login: YES

```ts
createSession({
  model: 'anthropic/claude-sonnet-4.5',          // required with a provider
  provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey },
  onPermissionRequest,
});
```

With `new CopilotClient({ useLoggedInUser: false })`. Sources:

- `types.d.ts:2027`: a singular `provider` "makes the entire session BYOK and bypasses
  Copilot API authentication".
- `auth/authenticate.md`: BYOK needs "No GitHub Copilot subscription".
- `setup/bundled-cli.md`: "BYOK (no GitHub auth needed)".

Notes:

- `baseUrl` includes the `/v1`.
- `wireApi` defaults to `completions`.
- OpenRouter isn't named in the docs; they list "Other OpenAI-compatible: vLLM, LiteLLM".
  The spike's `byok` checks it with every GitHub variable removed and an empty
  `COPILOT_HOME`.
- The key is never persisted by the SDK, so the backend passes it on each create and
  resume.

## 11. Model listing: YES

- **Copilot:** `client.listModels()` returns
  `{ id, name, capabilities, policy, billing.multiplier, supportedReasoningEfforts }`
  (`client.d.ts:308`, `types.d.ts:2962`). It is cached after the first call, and it needs
  authentication (see below).
- **BYOK:** the runtime does not list the provider's models. Conductor fetches
  `https://openrouter.ai/api/v1/models` itself (step 6). If the runtime needs a list,
  `CopilotClientOptions.onListModels` replaces its own.

## What else step 4 needs to know

- **Runtime.** The SDK starts a bundled native runtime
  (`@github/copilot-sdk-<platform>`, about 86 MB) over stdio, after copying it to
  `~/Library/Caches/github-copilot-sdk/runtime` (macOS) or `~/.cache` (Linux). There is
  no separate CLI to install. If optional dependencies were skipped, it needs
  `COPILOT_CLI_PATH`.
- **`start()`.** `createSession` starts the client itself, but `getAuthStatus` and
  `listModels` throw "Client not connected" unless `client.start()` was called first.
  Found by running the spike.
- **Authentication.** On this machine `getAuthStatus()` reported
  `isAuthenticated: false`, and `listModels` failed with "Not authenticated". So the
  Copilot path has not been tried here.
  - The runtime looks for credentials in this order:
    1. an explicit token
    2. `COPILOT_GITHUB_TOKEN`
    3. `GH_TOKEN`
    4. `GITHUB_TOKEN`
    5. a stored `copilot` login
    6. `gh auth`
  - The Settings screen should show this status (step 7). Spawn on `copilot` should
    refuse clearly when it is false, like a missing OpenRouter key.
- **Folders.** `SessionConfig.workingDirectory` and `additionalDirectories`.
  `availableTools` and `excludedTools` (patterns like `builtin:bash`) filter what the model
  sees, which is the counterpart of `disallowedTools`. The plan still requires the check
  in Conductor's own permission callback. That callback is the safety net, not the SDK.
- **System prompt.** `systemMessage: { content }` appends, like Claude's preset `append`.
  `mode: 'replace'` drops the runtime's guardrails. Don't use it.
- **Model.** `SessionConfig.model` and `session.setModel(model, { reasoningEffort })`.
  The change takes effect on the next message.
- **Shutdown.** `session.disconnect()` per agent, `client.stop()` on daemon shutdown
  (waits up to 10 s).
- **Native code.** `koffi` is a hard dependency but is loaded only for the in-process
  transport. Conductor uses stdio, so it isn't loaded.

## Running the spike

```sh
cd packages/daemon
npx tsx src/session/backends/copilot-spike.ts auth     # free
npx tsx src/session/backends/copilot-spike.ts models   # free
npx tsx src/session/backends/copilot-spike.ts all      # spends premium requests
OPENROUTER_API_KEY=… npx tsx src/session/backends/copilot-spike.ts byok   # spends credit
```

Each check prints PASS or FAIL with what it saw. `park` SIGKILLs a child process mid-request
and resumes in a fresh one, so "restart" means a real restart, as in `spike.ts`.
