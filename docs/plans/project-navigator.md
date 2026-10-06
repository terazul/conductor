# Plan: a project navigator in the left panel

The one open TODO.md item, as asked for and decided on 2 October. It's split into two
lanes that touch different files, so they can run at the same time, plus a serial merge.

## What it does

- A **left panel on every screen**, drawn by the shell. It lists the projects, and each has
  a nested submenu:
  - **Agents**: one row per agent in the project, showing its status (dot, and a count when
    something waits on it). A click opens the agent, and the panel stays up.
  - **Needs you**: this project's waiting requests and alerts, one row each. The heading is
    highlighted (amber, with a count) when any wait on you. A click opens that item in
    Needs you (`requestId` / `alertId` deep links, which `attention/route.tsx` already reads).
  - **Files**: the project's folders, main and referenced. A click opens Files on that folder.
- Every project and every submenu opens and closes on its own: opening one never closes
  another. The open set is kept in settings, so it's the same after a reload and in every
  browser.
- A project's name opens its Project screen and highlights it (`highlight`, Amendment 44).
- **Top bar:** a **left-panel** icon (always) shows or hides the panel, and a
  **right-panel** icon, only on the Agent screen, shows or hides the inspector. That uses
  the same `conductor.agentDetails` setting as the screen's own **details** button and `i`.
- **Fleet:** every card's click goes to its Project screen; it used to go to Needs you
  when the project was blocked.
- **Project screen:** its own projects list goes (the panel has it now). The column keeps
  the project's facts, notes and actions, under the project's name.

## Lanes

Each lane works in its own git worktree, on its own branch, from `cleanup`. It touches
only the files it owns, so the merges can't conflict.

### Lane A: the navigator (shell)

Owns `web/src/shell/Navigator.tsx` (new), `web/src/shell/navtree.ts` (new, pure),
`web/src/shell/shell.tsx`, `web/src/shell/shell.css`, `web/src/shell/panels.ts` (a
`NAV_PANEL` width), a new `web/src/shell/verify.ts`, and the `Makefile`'s `test:` line
(to run it).

- `navtree.ts`, pure:
  - `navTree(projects, agents, pending, alerts)` returns, per project: needs count;
    agent rows (reusing `agentTabs` from `agent/tabs.ts` for order, labels and needs);
    needs rows (label, and the deep link's params); and folder rows (main first).
  - Open-state helpers over a set of node ids: `p:<id>`, `p:<id>:agents`,
    `p:<id>:needs`, `p:<id>:files`.
  - The open set is the `conductor.navTree` setting (a JSON array); shown or hidden is
    `conductor.navOpen`.
- `Navigator.tsx` draws the tree with the existing tokens and `Dot`. It's resizable by
  `Splitter` with `NAV_PANEL`, and remembers its width. Rows are buttons, and
  `aria-expanded` sits on toggles.
- `shell.tsx` mounts it inside `.sh-body` before `.sh-screen`, and adds the two top-bar
  icons. The right one shows only when the current screen is `agent` (read with
  `currentRoute`/`onNavigate`).
- `shell/verify.ts` checks `navTree` and the open-state rules under Node.

### Lane B: the Project screen and Fleet

Owns `web/src/fleet/project.tsx`, `web/src/fleet/card.tsx` and `web/src/fleet/fleet.css`,
plus new checks in `web/src/lib/verify.ts`, appended as a new last section.

- `card.tsx`: `open` always calls `openProject(project.id)`.
- `project.tsx`: remove the projects list (`ProjectListRow` and its map). The column
  heads with the project's name and keeps facts, notes and actions. The column's own **+**
  is gone with the list, since the navigator and Fleet both have one.
- `lib/verify.ts`: check the card no longer branches to `openAttention`, and that the
  Project screen no longer maps `projects` into rows.

### Then, serially (main session)

1. Merge lane B, then lane A, onto `cleanup`.
2. `make test`, which must give 9 PASS (10 with lane A's suite).
3. A headless-Chrome run of the real app with a throwaway daemon (`web/scripts/cdp.mjs`):
   the panel shows on Fleet, Project and Agent; submenus open independently; an agent
   click keeps the panel; the icons hide and show both panels.
4. Mutation checks on `navtree.ts`.
5. `docs/MANUAL.md`, CONTRACT Amendment 66, and tick the item in TODO.md.

## Rules for both lanes

- Only the files you own. No new dependencies (CONTRACT §3). Tokens only, no hex
  colours. Match the surrounding comment style.
- Check with `pnpm -C packages/web exec tsc --noEmit -p .` and the web suites
  (`npx tsx src/<suite>/verify.ts`). Don't run `make test` or start a daemon: the
  daemon suites bind fixed ports and two lanes would collide. The main session runs the
  full suite after merging.
- Commit on your branch with a message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
