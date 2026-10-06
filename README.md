# Conductor

Orchestrator for many Claude Code agents across many projects, in a browser.

**How to use it: [docs/MANUAL.md](docs/MANUAL.md)** — start there if you want to get work done. Its §0 covers installing, starting and stopping.

**How it's built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the code, the architecture and how to change it, written for a coding agent picking it up cold.

Design reference: [mockups/conductor.html](mockups/conductor.html) — open it directly, press `a` for interaction notes.
Plan and architecture: [PLAN.md](PLAN.md) · Build rules and amendment log: [CONTRACT.md](CONTRACT.md)

---

## Prerequisites

| | |
|---|---|
| Node | **22+** (uses the built-in `node:sqlite`, so no native build step) |
| pnpm | 10+ |
| `claude` | The Claude Code CLI, **authenticated**. The Agent SDK spawns it and inherits its credentials, so if `claude` works in your terminal, agents will run. |
| optional: GitHub Copilot | To run agents on Copilot: a Copilot login (`copilot login`, `gh auth login`, or `GH_TOKEN`). The runtime ships with `@github/copilot-sdk`; nothing else to install. |
| optional: `OPENROUTER_API_KEY` | To run agents on OpenRouter's models. Or add the key in Settings (`9`). It is never shown, logged or sent anywhere but OpenRouter. |

```bash
node -v && pnpm -v && claude --version
```

## Run it

```bash
make install
make start
make browser
```

`make install` also puts Conductor on your dock, with its own icon: in the Dock on
macOS (`~/Applications/Conductor.app`), and in the Ubuntu dock's favourites on Linux.
Clicking it starts Conductor if it isn't running, then opens it — so after the first
install, the icon is all you need. `make install DOCK=no` skips it, `make dock` adds it
later, `make undock` takes it off again.

`make` with no target lists everything. The main ones:

| | |
|---|---|
| `make start` | daemon + web, detached, waits until both answer |
| `make status` | what's up, plus live jobs, agents, blocked count and spend |
| `make stop` | stops both, and clears the ports if a child was orphaned |
| `make restart` | stop then start |
| `make browser` | opens the app — refuses if it isn't up, rather than opening a dead tab |
| `make dock` / `make undock` | the dock icon, on or off (macOS, Ubuntu) |
| `make logs` | tail both logs |
| `make fixture` | web only, replaying a recorded session — **no daemon, no cost** |
| `make attention` | web only, replaying the attention queue |
| `make test` | every suite |
| `make zip` | zip the project as committed into `dist/` (no node_modules, databases or logs) |
| `make manual` | open the user manual |
| `make clean` | stop, drop the db in `~/.conductor/` and the logs (leaves settings and worktrees alone) |

`make status` is the one to reach for when something seems wrong:

```
  daemon    up on 127.0.0.1:7777  pid 44703
            seq 412 · 1 browser client(s) · up 46s
  web       up on localhost:5173
            127.0.0.1 refuses — Vite is on ::1, use localhost

  projects  2
  jobs      2
  agents    4  (2 working, 1 blocked, 1 queued)
  blocked   1   <-- needs you
            web-ui · uiux · Bash · parked · 760s
  servers   1
  slots     3/7 live
  spend     $4.18 today
```

Without `make`, it's `pnpm install` then `pnpm dev`, and the app is at:

```
http://localhost:5173
```

> **Use `localhost`, not `127.0.0.1`.** Vite binds `::1` only, so
> `http://127.0.0.1:5173` refuses the connection while `localhost` works. This
> cost two separate agents and me a wrong conclusion each during the build —
> a working server that looks dead. The same applies to any dev server an agent
> starts, which is why `DevServer.host` records the family it answered on.

To stop: `Ctrl-C`. If a port stays bound after a hard kill:

```bash
lsof -ti :7777 | xargs kill -9
lsof -ti :5173 | xargs kill -9
```

## First thing to do: press `0`

`0` is **Diagnostics**. It shows the raw feed — cursor position, entity counts,
the event tail, the sparkline buckets, the attention queue. If a screen looks
wrong, check here first: it tells you whether the problem is the data or the UI.

Screens: `1` Fleet · `2` Project · `3` Agent · `4` Needs you · `5` Files ·
`6` Preview · `9` Settings · `0` Diagnostics. Spawn has no key: it opens from **+ new work** on Fleet, the navigator's **+**, or **+ spawn agent** on a project.

## Look around without spending anything

Two recorded fixtures replay through the exact same store the live WebSocket
feeds, so every screen works with **no daemon and no API cost**:

```bash
# a two-agent job mid-flight: transcript, sparklines, diffstat, dev server
VITE_FIXTURE=session-basic pnpm --filter @conductor/web dev

# the attention queue: an aged parked `rm -rf` request and a held question
# with HTML option previews
VITE_FIXTURE=permission-requests pnpm --filter @conductor/web dev
```

The second one is the thing worth seeing — it's what the whole app exists for.
Try clearing the queue with only `⏎` and `⇥`.

## Run real agents

> **This spends real money.** Each agent is a live Claude Code session. Spawn sets a
> budget per agent ($25 by default); an agent that reaches it is paused until you raise it.

1. `make start`, open `http://localhost:5173`
2. Click **+ new work** on **Fleet**, or **+** in the navigator, to open **Spawn**
3. Point it at a git repo, pick isolation (**worktree** is the default and the
   right one), pick a preset, set the autonomy pills, launch
4. Press `1` for **Fleet** to watch, `4` when the amber rail lights up

Autonomy is per job. Tighter settings mean more amber interrupts; looser means it
runs longer untouched. `disallowedTools` survives every permission mode — it's
the real safety net.

Worktrees are created under `<repo>/.conductor/wt/<jobId>`, one per **job**.

### If you just want something to point it at

```bash
bash fixtures/make-scratch-repo.sh    # a small git repo with a dirty worktree
```

## Tests

```bash
make test
```

Every suite must be green. In order:
- `pnpm -r typecheck`;
- the daemon smoke test (event log → hub → cursor replay, storage, settings, the guard);
- the web verifies: the store (`src/lib/verify.ts`), then spawn, agent, attention, files
  and shell;
- the daemon verifies: workspace, preview and session, against a scratch repo that
  `fixtures/make-scratch-repo.sh` rebuilds.

None of them reach the real SDK or spend anything. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
says what each one covers and how to add to it.

The spike that cleared the durability gate is kept as runnable evidence:

```bash
pnpm --filter @conductor/daemon spike all   # hold | park | resume | observe | escalate
```

## Layout

```
packages/shared/    frozen contract — event union, wire types, design tokens,
                    derived helpers (rollupStatus, sparkline, diffstat,
                    resolveFileEdits)
packages/daemon/    session engine + arbiter · workspace + worktrees · preview
                    proxy · event log · WS hub · sqlite
packages/web/       shell + navigator + 9 screens (8 with a key, plus Spawn) ·
                    feed (WS cursor) · store (projection)
fixtures/           recorded sessions, scratch repo generator
mockups/            the design, as clickable HTML
docs/               the manual, the architecture guide, plans
```

Everything the UI shows is a projection of one append-only event log. The browser
holds a cursor and resubscribes from it after a reconnect, so a dropped socket replays
rather than losing state. The full map is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known gaps

- **Browser checks are by hand.** The screens have been driven in headless Chrome
  (`packages/web/scripts/cdp.mjs`), but that isn't part of `make test`: the suites check
  everything up to the bytes a browser receives and the payloads its buttons send.
- **Auth is off by default.** The daemon binds `127.0.0.1` (`CONDUCTOR_HOST`), refuses a
  Host or Origin that isn't local, and that's the guard. Set `CONDUCTOR_TOKEN` to require a
  bearer token on REST and the WS upgrade. Don't expose the daemon; phone notifications
  need egress only.
- **No iframe `sandbox` on the preview.** Same-origin is what defeats the frame
  blockers, so a previewed app shares Conductor's origin. Fine for your own
  agent-written code on a loopback daemon; tighten before anything else.
- **Copilot and OpenRouter agents report no dollars.** Their budgets are in tokens, and
  Fleet's spend today counts Claude's dollars only. A request they are waiting on when
  the daemon restarts expires rather than coming back. See
  [MANUAL §6](docs/MANUAL.md#6-money).
- **No context-window percentage.** Usage reports tokens and spend, not a
  percentage, until it can be derived honestly. A misleading number is worse
  than none.
- **SPA routers under the preview path prefix** may not match exact pathnames
  after an in-app navigation. Initial render is unaffected.
- **Text size and contrast are tunable in one file.** All sizes and greys live in
  `packages/shared/src/tokens.css`; nothing else hardcodes either. See
  [MANUAL §9](docs/MANUAL.md#9-making-it-easier-to-read).

## Environment variables

| | |
|---|---|
| `CONDUCTOR_PORT` | daemon port (default `7777`) |
| `CONDUCTOR_HOST` | daemon bind address (default `127.0.0.1`; keep it local) |
| `CONDUCTOR_DATA` | where Conductor keeps its database and `settings.json` (default `~/.conductor`, created only once you allow it) |
| `CONDUCTOR_DB` | sqlite path, instead of the one in `CONDUCTOR_DATA`. Skips the first-start question; settings then last as long as the daemon |
| `CONDUCTOR_SLOTS` | max concurrent live agents when Settings (`9`) hasn't set one (default `7`) |
| `OPENROUTER_API_KEY` | the OpenRouter key; wins over one saved in Settings |
| `CONDUCTOR_DEFER_AFTER_MS` | hold→park threshold (default `90000`) |
| `CONDUCTOR_TOKEN` | enables bearer auth; the web app sends `VITE_CONDUCTOR_TOKEN` |
| `CONDUCTOR_LEGACY_DB` | the pre-`~/.conductor` database to offer to bring in (default `packages/daemon/conductor.db`) |
| `CONDUCTOR_ORIGIN` | where Vite proxies `/api`, `/ws` and `/preview` (default `http://127.0.0.1:7777`) |
| `LOG_LEVEL` | daemon log level (default `info`) |
| `VITE_FIXTURE` | replay a fixture instead of connecting |

A held request pins a live process; a parked one lives on disk and costs nothing.
Below `DEFER_AFTER` requests are held (cache stays warm, and "edit & run" is only
possible on this path); beyond it they park. With no browser connected they park
immediately — nobody can answer.
