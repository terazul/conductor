# Multi-provider: how steps 4–8 run in parallel

The steps are from [multi-provider-backends.md](multi-provider-backends.md). Steps 0–3 are
done (Amendments 72–75), and the answers are in
[multi-provider-findings.md](multi-provider-findings.md).

## Lanes

| Lane | Steps | Amendments | Owns | Starts |
|------|-------|------------|------|--------|
| A — engine | 4 | 76 | `session/backends/copilot*.ts`, `session/secrets.ts`, `session/translate.ts`, `arbiter/index.ts`, `backends/index.ts`, `routes/providers.ts` (new), `index.ts` (shutdown only) | now |
| B — budgets and models | 5, 6 | 77, 78 | `session/budget.ts`, `routes/session.ts`, `shared/src/wire.ts`, `session/models.ts` | now |
| C — screens | 7 | 79 | `packages/web/**`, `fixtures/**` | when B is merged, because it needs B's wire fields |
| Docs (me) | 8 | 80 | README, `docs/MANUAL.md`, `docs/ARCHITECTURE.md`, TODO.md | last |

Each lane works in its own worktree (`../conductor-lane-a`, and so on) on its own branch.
I merge each lane by cherry-picking onto `cleanup`. Both A and B add sections at the end
of `session/verify.ts` and both add CONTRACT amendments. I resolve those two files by
hand when merging. Nothing else is shared.

### The contracts between lanes

**A gives (HTTP; C codes against it):**
- `GET /api/providers/openrouter/key` and `PUT` with `{ key: string | null }`. Both
  return `{ set: boolean, source: 'env' | 'settings' | null }`. The key is never
  returned, logged or broadcast. It is stored in `~/.conductor/secrets.json` (mode
  0600), never in `settings.json`, because every setting is broadcast to every tab.
  `OPENROUTER_API_KEY` in the environment wins.
- `GET /api/providers/copilot/login` returns
  `{ authenticated: boolean, login: string | null, note?: string }`.
- The `copilot` and `openrouter` factories are registered, with `listModels()`:
  - `copilot` calls `client.listModels()`.
  - `openrouter` calls `GET https://openrouter.ai/api/v1/models`. The endpoint is
    public, needs no key, and is cached for ten minutes.

**B gives (wire.ts, additive; C codes against it):**
- `Autonomy.budgetTokens?: number | null`. This is a lifetime cap on input plus output
  tokens, for backends with `costUsd: false`.
- `GET /api/models?provider=<id>`:
  - With `claude` or no provider, it returns the `ModelCatalog` exactly as today.
  - With any other provider, it returns
    `ProviderModelList { provider, models: { id, displayName, efforts? }[], note?, fetchedAt }`.
- Spawn checks a non-Claude model id against that provider's list, and so does the
  `/api/agents/:id/model` route. An empty list (the provider couldn't be asked) refuses
  nothing.

**A relies on (already there):** `budgetRefusal(agent)` in `budget.ts`. Once B extends it
to token caps, the Copilot backend stops on a token cap without further work.

## Tests

The daemon suites use fixed ports: smoke 7799/7798, workspace and preview 7801, session
7802. Lanes A and B wrap any daemon suite, and `make test`, in
`lockf /tmp/conductor-verify.lock …`, so two lanes never bind the same port at once.
`pnpm -r typecheck` and the web suites need no lock.

## Rules every lane keeps

Every rule in multi-provider-backends.md applies. In particular:

- Claude's behaviour doesn't change.
- No real network in tests.
- No key in any log, event, database row or response.
- No new dependency.
- One step per commit, each with its amendment.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
