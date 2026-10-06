# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

## How to work this list

- [x] **Run the open items in parallel, with several agents.** Done sequentially instead, as decided below: Amendments 42–51. Most items below touch
  different screens, so they can go to separate agents at once rather than one after
  another. Group them by the files they share first: the Spawn items (Add a project,
  Custom setup, orchestrator) all edit `packages/web/src/spawn/route.tsx`, and the shell
  items (project rail, top menu, Settings) all edit `packages/web/src/shell/shell.tsx`.
  Items in the same group go to one agent or run in sequence; separate groups run at once.
  *Decided (30 Sep): sequential instead — one item at a time in one checkout, each
  committed with its own CONTRACT amendment and a green `make test`.*

## Files

- [x] **PDF export for markdown files.** Done: **⎙ PDF** in the pane head (Amendment 32). An "export PDF" action on a rendered `.md` file
  in the Files pane. The daemon already renders and sanitises the HTML
  (`packages/daemon/src/workspace/markdown.ts`), so this is mostly print styling plus
  the browser's print-to-PDF. No new dependencies (CONTRACT §3) unless we escalate.

- [x] **Rendered markdown doesn't use the width of the screen.** Done: it fills the pane, and **¶ column** brings the reading column back (Amendment 32). `.c5-md` is capped at
  `max-width: 720px` (`packages/web/src/files/files.css`), so on a wide window the text
  sits in a narrow column with empty space beside it. Options: widen the cap, make it
  relative to the pane, or add a "fit width" toggle. Tables and code blocks suffer most.

## Layout

- [x] **Resizable left and bottom panels, wherever it makes sense.** Done: the Project column and dock, the Agent inspector, the Needs you queue and the Preview dock drag too (Amendment 34). The Files tree
  (F17) and the Agent composer (L11) already drag, using `packages/web/src/shell/Splitter.tsx`.
  Go through the other screens' side and bottom panels and add the same splitter
  where a fixed size gets in the way. Keep the sizes in localStorage, as those two do.

- [x] **"Add a project" asks for the new project's folders, not a list of old ones.** Done: Fleet's **+ add project** form takes the main folder and referenced ones; Spawn only picks (Amendment 45).
  The **where** step lists the projects that already exist, so it reads as if it's
  asking for the new project's directories, and it isn't. Make adding a project a place
  to add the folders (and files) that belong to it: one is the **main** folder, where
  agents work, and the rest are **referenced** folders they can read and use. Start at the
  where picker in `packages/web/src/spawn/route.tsx` (the "where" field, and the "Add a
  folder as a new project" button) and the "add project" entry on Fleet
  (`packages/web/src/fleet/fleet.tsx`). A project is already a list of directories
  (Amendment 39); what's missing is marking one as main and the rest as referenced, in
  the daemon's project record and in the UI.

- [x] **One projects panel, not two.** Done: the rail is gone; its needs-you marks and **+** are on the Project screen's list (Amendment 43). Clicking the project icon in the left rail opens a
  second panel beside it listing the same projects by name. Keep the named projects
  panel and drop the icon rail. The rail is `ProjectRail` in
  `packages/web/src/shell/shell.tsx`; it also carries per-project badges (`RailPip`), so
  those need to move onto the named panel's rows rather than disappear.

- [x] **Files follows the highlighted project.** Done: Files opens on the project selected in the Project screen's list (Amendment 44). With the second project selected in the
  projects panel, opening Files should show only that project's directories and files.
  Files already shows one project's directories (Amendment 39,
  `packages/web/src/files/route.tsx`); check where it gets that project from and make it
  the one highlighted in the projects panel, not the last one used or the first in the list.

- [x] **Remove Spawn from the top menu.** Done: Spawn has no tab or key and opens from a project's **+** (Amendment 42). The screen stays, reached from the project
  panel and Fleet's "+" (`navigate('spawn', { projectId })`), but it no longer has a tab.
  Screens register themselves (`packages/web/src/lib/screens.ts`), so this needs a way for
  a screen to exist without a nav chip, such as a flag on `ScreenDef`, rather than deleting
  `packages/web/src/spawn/route.tsx`. Its hotkey `7` can go too.

- [x] **A Settings tab in the top menu.** Done: `9`, with storage, the slot limit, launch defaults and look (Amendment 47); the permission rules join it with the next item. One place for behaviour and configuration
  changes that are now spread around or not in the UI at all: defaults for models,
  isolation and autonomy, theme, and the permission rules below. It would be a new screen
  (`packages/web/src/settings/route.tsx`), with a slot added to the reserved table in
  `packages/web/src/lib/screens.ts`.

  The first setting it needs is the **maximum number of agent slots**, now 7. The limit is
  `TOTAL_SLOTS` in `packages/daemon/src/session/supervisor.ts`. It is read once at startup
  from `CONDUCTOR_SLOTS`, and `packages/daemon/src/hub.ts` repeats the same default for the
  status bar. It needs to become a value the daemon stores and can change while running,
  with one source for both. Decide what lowering it does when more agents than the new
  limit are running: probably let them finish and start no new ones until they're under it,
  rather than putting any to sleep.

- [x] **Settings and the database live in the home directory, not the project.** Done: `~/.conductor/`, asked for on first load; settings sync to every browser (Amendment 46). The
  database defaults to `packages/daemon/conductor.db`, inside the Conductor checkout
  (`DEFAULT_DB` in `packages/daemon/src/db/index.ts`; `CONDUCTOR_DB` overrides it). Move
  it, and the settings file the Settings tab will write, to one folder in the user's home
  directory, such as `~/.conductor/`. The first time Conductor needs that folder, it asks
  the user before creating it and says what will go there. It asks once, remembers the
  answer, and doesn't write anything under home until the user agrees. Decide:
  - where the question is asked. The daemon starts before any page is open, so either it
    asks in the terminal, or it starts without storage and the web UI asks on first load.
  - what happens if the user says no. Keep the current location, or run with nothing saved.
  - moving an existing `conductor.db`. Offer to move it in the same question, so no one's
    history is left behind in the old place.
  - what counts as settings. Panel sizes, theme and folds are kept in the browser's
    localStorage today (`packages/web/src/shell/panels.ts`, `theme.ts`, `agent/folds.ts`),
    and job worktrees go in `<repo>/.conductor/wt` (`packages/daemon/src/workspace/worktree.ts`).
    Worktrees are code, not settings, so they probably stay beside the repo; say so in the
    question.
  `smoke.ts` checks the current default path, so it changes with the default.
  *Decided (30 Sep):*
  - *Ask in the web UI on first load, before anything else. Nothing is written under home
    until the user allows it.*
  - *If the user says no: run in memory only, and say plainly, wherever it matters, that
    nothing will be saved. The question can be asked again from Settings.*
  - *Start fresh in `~/.conductor/`; don't move the existing `conductor.db`, and leave it
    where it is.*
  - *Everything is a setting: slots, launch defaults, saved Custom setups, and also theme,
    panel sizes and folds, which move out of localStorage into the settings file.
    Worktrees stay beside the repo.*

- [x] **A restart keeps everything.** Done: the first-start question brings the old history
  into `~/.conductor/`, and agents a restart interrupted resume on their own (Amendment 53).

- [x] **A terminal panel.** Done as a command runner on the Agent screen, the user's choice: **›_ terminal** beside reply (Amendment 58). A real terminal (xterm.js) is still possible later. Open a command line inside Conductor, in the folder you're
  looking at: a job's worktree, or a project's main folder. Likely a tab in the Project
  screen's bottom dock (`packages/web/src/fleet/dock.tsx`), and maybe a dock on Files too.
  The daemon would run the shell and stream it over the socket; a new route file in
  `packages/daemon/src/routes/`, owned by whichever track takes it. Decide:
  - a real terminal or a command runner. A real one, where `vim`, `top` and colours work,
    needs a pseudo-terminal: `node-pty` is a native module, the kind the daemon dropped
    `better-sqlite3` to avoid (`db/index.ts`), and a new dependency needs escalating
    (CONTRACT §3). Without one, each command runs in `sh -c` and its output streams back:
    fine for `git status` or `npm test`, useless for anything interactive.
  - what it can reach. It runs with your own permissions, not an agent's, so it is only
    as safe as the localhost guard and `CONDUCTOR_TOKEN` (CONTRACT §5). Say so on the panel.
  - whether it lasts. Kept when you switch screens, like the Files tabs; ended when the
    daemon restarts, or reattached.

- [x] **A daily budget, and where you are in it.** Done: Settings → Spend, a bar in the status bar, a warning in Needs You (Amendment 59). *Decided: yellow at 75%, red at 95%; warn only; local midnight.* Set a daily spend limit on the Settings
  tab, and see it as a bar in the status bar at the bottom: how much of today's budget is
  spent, green while there's room, yellow as it gets close, red past it. Today's spend is
  already counted (`cost_daily`, `costToday` in `packages/daemon/src/session/store.ts`) and
  sent as `Snapshot.costToday`; the status bar is `StatusBar` in
  `packages/web/src/shell/shell.tsx`, and settings go through `packages/web/src/lib/settings.ts`.
  Decide:
  - where yellow starts. Probably 75% of the budget, and red at 100%, or a setting.
  - whether reaching it does anything: only warn, or also stop starting new agents the
    way the slot limit does, and whether it reaches Needs You like a budget stop does.
  - what "a day" is. `cost_daily` is keyed by date; say whose midnight it resets at.
  - that `costToday` reaches the page as it changes, not only with a snapshot. Check,
    since the slot count didn't (Amendment 47).

- [x] **Fleet cards in your own order.** Done: drag a card, or move it from its menu; a
  header button switches back to needs-you-first (Amendment 54).

- [x] **Sort the Fleet by name, working, my order and more.** Done: **Sort by** in the
  Fleet header (Amendment 57).

- [x] **Notes on each project, shown on its Fleet card.** Done: the newest note and a
  count on the card, and a panel to add, edit and delete them (Amendment 55).

- [x] **The same notes on the Project and Agent screens.** Done: in the Project column and the Agent inspector (Amendment 56). Add, edit and delete the
  project's notes from the Project screen's column and the Agent screen's inspector.
  *Decided (30 Sep): one set of notes per project, the same everywhere. The Agent screen
  shows its agent's project's notes.* Reuse `NotesPanel` (`packages/web/src/fleet/Notes.tsx`).

- [x] **Notes can be due, and a due or late note stands out.** Done (Amendment 63). When adding or editing a
  note, set when it's due: **today**, or pick a date. A note due today or past its date is
  highlighted wherever notes show (the Fleet card, the Project column, the Agent
  inspector), so it isn't forgotten. Notes have no date today: `ProjectNote` in
  `packages/shared/src/wire.ts` is text and timestamps, stored in `project_notes`
  (`packages/daemon/src/db/migrations/080_notes.sql`), written by `insertNote` and
  `updateNote` in `packages/daemon/src/session/store.ts` and the notes routes in
  `packages/daemon/src/routes/session.ts`. So it needs a new migration with a nullable
  `due` date, the field on the wire, and a date control in `NotesPanel`
  (`packages/web/src/fleet/Notes.tsx`). Decide:
  - what the highlight is. Amber like needs-you, a separate colour for late, or both.
    And whether the Fleet card shows the most urgent due note instead of the newest.
  - whether a note can be marked done, so a late note stops nagging without deleting it.
  - whether due or late notes also reach Needs You, as the budget warning does
    (Amendment 59).
  - what "today" is. Local midnight, as the budget uses, and the highlight has to change
    when the day turns over without a reload.
  *Decided (1 Oct): amber for due today, red for late, and the Fleet card shows the most
  urgent due note instead of the newest. Notes can be marked done. Due and late notes also
  reach Needs You. "Today" is local midnight, and turns over without a reload.*

- [x] **Copy a note, and make deleting one easy to find.** Done (Amendment 83). Asked for (6 Oct). In the
  Project column's notes, and on the Fleet page, a **copy** button that puts the note's
  text on the clipboard. Deleting already works everywhere `NotesPanel` shows: it's the
  bare **✕** after **✎ edit** in `NoteRow` (`packages/web/src/fleet/Notes.tsx:180-187`),
  with a "delete it / keep" confirm. But it's easy to miss, and the due picker uses the
  same **✕** to mean "no due date" (`Notes.tsx:53`).
  Plan:
  - a new `copyText(text)` in `packages/web/src/lib/clipboard.ts`, using
    `navigator.clipboard.writeText`. There's no clipboard code yet.
  - **⧉ copy** in `NoteRow`'s actions. The Project column, the Fleet card's panel and the
    Agent inspector all render `NotesPanel`, so one change reaches all three.
  - a copy button on the card's always-visible `LatestNote` line, stopping its click so
    the card doesn't open the project.
  - the delete button labelled **✕ delete**.
  - checks in section 24 of `packages/web/src/lib/verify.ts`.

  It copies the note's text exactly as written, without its due date or age, and the
  button shows **✓ copied** for a moment. Web only: no daemon, wire or migration change.
  *Decided (6 Oct): the card's note line gets copy too. No `execCommand` fallback: on a
  non-secure page such as a LAN IP, the button says it couldn't copy, and why.*

- [x] **Draw mermaid diagrams in rendered markdown.** Done: in Files and in agent replies (Amendment 60). Today a ```mermaid block shows as
  code, in Files and in agent replies. Plan: [docs/plans/mermaid-diagrams.md](docs/plans/mermaid-diagrams.md).

- [x] **What I'm typing to an agent gets wiped out.** Fixed: drafts are kept per agent and for Spawn, through remounts and reloads (Amendment 64). Three times, text typed as
  instructions disappeared from the box. The reply box (`text` in
  `packages/web/src/agent/composer.tsx`) and Spawn's prompt (`prompt` in
  `packages/web/src/spawn/route.tsx`) keep it only in component state, so anything that
  remounts them loses it: switching reply ↔ terminal, switching agent tab or screen, or the
  page reloading (Vite reloads it when the code changes under a running `make start`).
  Keep drafts outside the component, per agent and for Spawn, so they survive all of these.

- [x] **A project navigator: one left panel with each project's agents, Needs you and
  Files.** Done (Amendment 66), in two parallel lanes; plan in [docs/plans/project-navigator.md](docs/plans/project-navigator.md). Asked for (2 Oct):
  - Selecting a project on Fleet takes you to the Project screen.
  - The projects panel on the left gives each project a nested submenu: **Agents** (with
    its own submenu, one row per agent), **Needs you** (this project's only) and **Files**
    (this project's only).
  - Each submenu opens and closes on its own; opening one in one project doesn't close
    anything in another.
  - Clicking an agent keeps the left panel up, so you can go on navigating from it.
  - With **Agents** open, each agent row shows its status.
  - With **Needs you** open, it's highlighted when something there needs you.
  - The left panel can be closed, from an icon in the top bar.
  - The right panel can be closed too, from an icon in the top bar.

  Where it starts:
  - A Fleet card's click is `open` in `packages/web/src/fleet/card.tsx`. It goes to
    **Needs you** when the project is blocked and to the Project screen otherwise, so the
    first point changes the blocked case.
  - The projects panel is the Project screen's column (`pj-col`, `ProjectListRow` in
    `packages/web/src/fleet/project.tsx`). It's part of that screen only, so the Agent and
    Files screens have no left panel. To stay up across them, it has to move into the
    shell (`packages/web/src/shell/shell.tsx`), where the old project rail was before
    Amendment 43.
  - The right panel today is the Agent screen's inspector, which already hides with
    **details** or `i` (`DETAILS_KEY` in `packages/web/src/agent/agent.tsx`). The Project
    and Files screens have no right panel.
  - Per-project Needs you is `projectNeeds` (`packages/web/src/shell/describe.ts`), and
    Files already opens on the highlighted project (Amendment 44).
  - Open and closed state goes in settings (`packages/web/src/lib/settings.ts`), like the
    other panels.

  Decide:
  - whether the Project screen's own column goes, now that the shell has the panel, and
    what the Project screen shows in the middle then.
  - what clicking **Needs you** or **Files** under a project does: open those screens
    filtered to the project, or show the items in the submenu itself.
  - whether Fleet keeps sending a blocked project straight to Needs you.
  - what "the right panel" is on screens that have none, and whether its top-bar icon
    shows only where there is one.
  *Decided (2 Oct): the Project screen drops its projects list and keeps its facts, notes
  and lanes. Agents and Needs you list their items, and a click opens one; Files lists the
  project's folders and opens Files on it. Every Fleet card goes to its Project screen.
  The right-panel icon shows only where there is a right panel.*

- [x] **The navigator lists projects in the Fleet's order.** Done (Amendment 69). The left panel's projects
  should follow the Fleet's **Sort by** (needs you first, my order, name, working,
  recently active, spend, newest), and change when it changes. Today `navTree` in
  `packages/web/src/shell/navtree.ts` keeps the order `useProjects()` gives. The sort is
  `sortProjects` and `fleetSort` in `packages/web/src/fleet/order.ts`, read from the
  `conductor.fleetSort` and `conductor.fleetOrder` settings, so the panel can read the
  same two. The per-project facts the other sorts need (needs-you rank, working, last
  active, spend) are built in a `useMemo` in `packages/web/src/fleet/fleet.tsx`. They
  would move into a pure function both places call, so the two lists can't disagree.
  Decide whether the panel gets its own Sort by control or only follows the Fleet's, and
  whether you can drag projects in the panel to set **my order**.
  *Decided (2 Oct): it follows the Fleet's Sort by, and dragging a project in the panel
  sets my order (and switches to it), as dragging a Fleet card does.*

- [x] **The navigator groups a project's agents by job.** Done (Amendment 86). Asked for (6 Oct). In the left
  panel, a project's **Agents** submenu is one flat list
  (`packages/web/src/shell/Navigator.tsx:211-224`). It should show the agents launched
  together as a group under the project. For example, conductor with two jobs, one of 1
  agent and one of 3, reads:
  ```
  conductor
    Agents
      ▸ <job 1>      1 agent
          builder
      ▸ <job 2>      3 agents
          architect
          developer
          validator
  ```
  Where it starts:
  - The rows come from `navTree` (`packages/web/src/shell/navtree.ts:110-150`), which uses
    `agentTabs` (`packages/web/src/agent/tabs.ts:23`). Those are already ordered by job,
    newest first, and mark each job's first agent with `newJob`. Each row already carries
    its `jobId` (`navtree.ts:143`).
  - The Project screen already groups its lanes by job and heads each group with the
    job's prompt (`packages/web/src/fleet/project.tsx:105`), so the label can match.
  - Open and closed state is a set of node ids (`p:<id>`, `p:<id>:agents`,
    `navtree.ts:15`). A job group would add `p:<id>:job:<jobId>`.
  Decide:
  - what heads a group: the job's prompt, cut to one line (as on the Project screen), or
    its preset name, branch or age.
  - whether a group starts open, and whether a project with only one job still shows a
    group level.
  - whether a group shows its own status and needs count, as a project does.
  - whether helpers (Amendment 51) nest under the agent that made them.
  *Decided (6 Oct): headed by the prompt on one line and the agent count. Groups start open
  and show even for a project with one job. A group shows its unhappiest agent's dot and
  the count of what needs you. Helpers sit in their job, not under the agent that made them.*

## Agents

- [x] **Tabs for each agent in a project.** Done: a tab per agent above the Agent screen, amber when it needs you (Amendment 49). In a project with several agents, opening
  Agents should show a tab per agent in that project, and clicking a tab switches to that
  agent. Start at `packages/web/src/agent/agent.tsx` and `agent/route.tsx`. The Files tab
  strip (`packages/web/src/files/TabStrip.tsx`) may be reusable. Each tab should show
  whether that agent needs you, so a blocked agent isn't hidden behind another one.

- [x] **A "Custom" setup on the launch page.** Done: **custom…** on Spawn, saved by name in the daemon's settings (Amendment 50). Keep the preset setups for quick starts,
  and add a **Custom** one where you add agents yourself and set each one's role and
  model. Presets are `PRESETS` in `packages/web/src/spawn/presets.ts`, and each role
  already has its own model picker (Amendment 41), so Custom is an editable list of roles
  built from the same parts. Decide whether a custom setup can be saved and named for reuse.
  *Decided (30 Sep): a Custom setup can be named and saved; saved setups show beside the
  presets and are kept by the daemon, so every tab and a restart see them.*

- [x] **Several agents working on one role, run by an orchestrator.** Done: **+ up to N helpers** on a Spawn row; helpers nest under it and report back (Amendment 51). When starting an
  agent for a role like builder, offer to put several agents on it. The first one then
  only orchestrates: it splits the work, starts the others and collects what they
  report. Start at the role rows in `packages/web/src/spawn/route.tsx` for the option,
  and at `packages/daemon/src/session/supervisor.ts` and `handoff.ts` for letting one
  agent start others. Decide whether the sub-agents count against the job's slots and
  budget, and how they appear in the project view: nested under the orchestrator, or as
  ordinary agents in the lane.
  *Decided (30 Sep): helpers count against slots and share the job's budget like any
  agent, and show nested under the orchestrator. The orchestrator gets a Conductor tool to
  start helpers, capped at a number set at launch, and hears their final replies.*

- [x] **Put an agent session to SLEEP and RE-AWAKEN it later.** Done: ⏸ pause is sleep. It frees the slot, keeps the session and any pending question, and closes a cut-short tool call. ▶ resume waits for a slot (Amendment 35). Park an agent without
  losing it. It would stop using a slot and stop running, keep its transcript and SDK
  session, and pick up where it left off when woken. Start at the session supervisor
  and runner in `packages/daemon/src/session/`, which already resume sessions.
  Decide what sleeping does to a pending ask or a running tool call.

- [x] **Let the agent's replies fold like tool output.** Done: the agent's name folds a reply to one line, **⌃ fold all** is in the header, and folds are kept per agent (Amendment 33). Tool calls already collapse to
  one line (`ToolCall` in `packages/web/src/agent/transcript.tsx`). An agent's prose
  only gets a fold control when the turn is long (over 1,200 characters or 20 lines;
  `foldable` in `agent/markdown.tsx`), and it starts open. Make every reply foldable,
  and consider a "fold all" control and remembering folds per agent. Replies should
  still start open: output you haven't read shouldn't hide itself (Amendment 18).

- [x] **Pick how an agent interacts with you when you spawn it.** Done: a mode row in Spawn's section 5, defaulted from Settings (Amendment 65). A named choice at
  launch, such as **ask me**, **auto-accept edits**, **plan first** and **auto**, rather
  than working it out from the pills. `Autonomy['mode']` in `packages/shared/src/wire.ts`
  already takes every SDK permission mode (`default`, `acceptEdits`, `plan`, `dontAsk`,
  `bypassPermissions`, `auto`), but `toAutonomy` in `packages/web/src/spawn/autonomy.ts`
  only ever produces `default`, `acceptEdits` or `plan`, from the pills and the
  "plan first" button in `packages/web/src/spawn/route.tsx`. Decide:
  - which modes to offer, and what each one is called on screen. `bypassPermissions`
    skips `canUseTool`, so nothing would reach Needs You; offer it only with a plain
    warning, or leave it out.
  - one choice for the whole launch or one per role row, as the model picker is
    (Amendment 41).
  - how it sits beside the pills: does it replace them, set them, or only the mode?
    `disallowedTools` still applies in every mode (`never push`, no network).
  - whether the default goes in Settings → launch defaults, and whether a sleeping or
    running agent can switch mode later.
  *Decided (1 Oct): ask me, auto-accept edits, plan first and auto, plus bypass permissions
  behind a plain warning. One choice per launch, and it sets only the mode: the pills keep
  the tool rules. Its default is in Settings → launch defaults. Reading roles stay
  read-only whatever is chosen.*

- [x] **Add, edit and delete agent personas.** Done (Amendment 68). Builder, Validator, Reviewer and the rest
  are fixed today: you can't add a new one or change what one is. A role is only a
  name: `KNOWN_ROLES` in `packages/web/src/spawn/custom.ts`, with briefs in `PRESETS` in
  `packages/web/src/spawn/presets.ts`. All that reaches the agent is the sentence "Your role
  is <role>. <brief>" in its prompt (`#promptFor` in
  `packages/daemon/src/session/supervisor.ts`). Every role gets the same tools, skills and
  system prompt. A persona could carry its own system prompt, default model, tool rules
  and skills, and run as an SDK `AgentDefinition` (the `agents` and `agent` options in
  `#buildOptions`, `packages/daemon/src/session/runner.ts`). Its `skills` field preloads
  skills, and the `skills` option hides any it leaves out. Decide:
  - what a persona holds: the brief alone, or a system prompt, model, tools and skills too.
  - where personas live: in the daemon's settings like saved setups (Amendment 50), and
    whether a project can have its own, perhaps read from `.claude/agents/`.
  - whether the built-in personas can be edited or deleted, or only copied, and how to get
    a default back.
  - what happens to a running or sleeping agent, or a saved setup, whose persona changes
    or is deleted.
  *Decided (2 Oct): a persona holds a name, description, brief, its own system prompt, a
  default model, tool rules (shell, push, network, MCP, write) and skills to preload. Kept
  in Settings. Built-ins can be edited and reset to default but not deleted; your own can
  be deleted. Presets use the persona of the same role for its system prompt, skills and
  tool rules, keeping their own brief and model tier. A running or sleeping agent keeps
  what it launched with.*

- [x] **Pick a persona for each agent in a Custom setup.** Done (Amendment 68). In Spawn's **custom…**
  (`packages/web/src/spawn/CustomSetup.tsx`), each row's role is free text with
  `KNOWN_ROLES` as suggestions, and nothing else comes with it. Let each row pick a persona
  from the list above, which fills in its brief, model and the rest. The role name stays
  free so two rows can share a persona (builder-api and builder-ui). Depends on the item
  above. Decide whether a row can change a persona's fields for this launch only, and
  whether a saved setup stores the persona by name or a copy of it.
  *Decided (2 Oct): a saved setup stores each row's persona by name, so editing a persona
  updates the setup; a row can override the brief and model for that launch only.*

- [x] **Run agents on more than Claude: GitHub Copilot and OpenRouter.** Done
  (Amendments 72–81), from `docs/plans/multi-provider-backends.md`. Each agent has an
  engine, chosen in Spawn; Copilot and OpenRouter run on `@github/copilot-sdk`, behind
  Conductor's own permission gate, with budgets in tokens. Not yet tried against the real
  services: run `pnpm --filter @conductor/daemon spike:copilot all` with a Copilot login,
  and `… byok` with `OPENROUTER_API_KEY`.

- [x] **New preset stacks.** Done (Amendment 82). Asked for (2 Oct), to do after the multi-provider work:
  - **full build pipeline** becomes: 1) architect, 2) developer, 3) validator,
    4) reviewer, 5) scribe.
  - A new stack, **Analysis Only**: 1) analysis (the analyst), 2) scribe.

  Presets are `PRESETS` in `packages/web/src/spawn/presets.ts`; the architect persona exists
  (Amendment 70). "developer" isn't a persona yet: it is today's builder, renamed or added.

- [x] **Tell the user when an agent finishes.** Done (Amendment 87). Asked for (6 Oct). Today a finished agent
  only changes its card. The supervisor sets `done`, emits `{kind:'status',status:'done'}`
  and pushes the agent (`packages/daemon/src/session/supervisor.ts:883-891`). The web
  redraws, and that's all: alerts cover failed and paused agents
  (`packages/web/src/attention/alerts.ts`), the tab badge counts pending requests plus
  alerts (`attention/notify.ts:159-166`), and nothing is "unread".
  Decide:
  - what "finished" means: each agent, or only when its whole job ends.
  - where it shows: the tab badge, Needs You, a browser notification (the notify ladder
    in `notify.ts:54`), or only a mark on the card and lane until it is seen.
  Needs the next item.
  *Decided (6 Oct): when a whole job ends, its card, its lane group and its navigator row say
  **finished** until seen. The tab badge counts it, and a desktop notification fires if those
  are on; no chime. Opening the project or one of the job's agents marks it seen.*

- [x] **Where "seen" is kept.** Done (Amendment 87). Asked for (6 Oct). The item above needs to know which
  finished agents the user has already looked at. Nothing records that today.
  Decide:
  - per browser (localStorage, like the drafts), or in Settings, so it's the same in
    every browser.
  - what counts as seen: opening the agent, opening its project, or dismissing it.
  *Decided (6 Oct): in Settings (`conductor.seenJobs`), so it's the same in every browser.
  Opening the project or one of the job's agents, with the tab in front, is seeing it.*

- [x] **Fewer built-in personas.** Done (Amendment 84). Asked for (6 Oct). There are ten
  (`packages/web/src/spawn/personas.ts:63-95`), and some are near-copies: `developer` and
  `builder` differ by one clause of their brief, and `scribe` and `documenter` both write
  docs. Decide which to merge or drop. Saved setups and persona edits store a persona by
  id (Amendment 68), so a removed id needs somewhere to go.
  *Decided (6 Oct): builder, documenter and uiux are dropped. Builder's edits and saved rows go
  to developer and documenter's to scribe, converted on read; uiux's run with no persona. The
  presets that used builder or documenter now run a developer or a scribe.*

- [x] **The full pipeline's developer on sonnet, not opus.** Done (Amendment 84). Asked for (6 Oct). The
  developer row is `model: 'opus'` (`packages/web/src/spawn/presets.ts:62`), and so is the
  `developer` persona (`personas.ts:88`). Decide whether the persona changes too, or only
  the preset row.
  *Decided (6 Oct): both. The preset row and the developer persona run on sonnet.*

- [x] **Reword the validator.** Done (Amendment 84). Asked for (6 Oct). In the full pipeline it now starts after
  the developer (Amendment 82), but its row still says "writes tests first, then
  verifies" (`presets.ts:72-74`). The `validator` persona says the same
  (`personas.ts:89`). Custom rows can still run it in parallel, so maybe only the preset
  row changes.
  *Decided (6 Oct): both. The preset row "tests what was built" against the plan; the persona
  "Tests what was built and reports what fails."*

- [x] **Give the reviewer and the scribe the architect's plan.** Done (Amendment 84). Asked for (6 Oct). The
  handoff only carries the replies of the agents an agent waits for
  (`supervisor.ts:685-689`). In the full pipeline the reviewer waits for developer and
  validator, and the scribe for the reviewer (`presets.ts:82`, `:89`), so neither hears
  the architect. Add `'architect'` to both `dependsOnRoles`: option G in
  `docs/adr/0001-preset-stacks.md`. It costs up to 8k more characters in each first
  prompt (`handoff.ts:18`).
  *Decided (6 Oct): option G. The reviewer waits for architect, developer and validator, and
  the scribe for architect and reviewer; the reviewer's brief adds "and against the
  architect's plan".*

- [x] **Possible bug: a stopped agent never gets an end time.** Done (Amendment 85). Found (6 Oct), not yet
  reproduced. `setAgentStatus` sets `ended_at` only for `done` and `failed`
  (`packages/daemon/src/session/store.ts:534`), so a stopped agent keeps
  `ended_at = null`. Check what reads `ended_at` (durations, sorting, cleanup) before
  deciding whether `stopped` should set it.
  *Decided (6 Oct): confirmed; `stopped` sets it. It is final, and every reader wants it.*

- [x] **Possible bug: an agent whose dependency failed waits forever.** Done (Amendment 85). Found (6 Oct), not
  yet reproduced. `#depsSatisfied` counts a failed or stopped dependency as ended only for
  a helper's orchestrator (`supervisor.ts:638-647`). An ordinary sibling, such as the
  reviewer after a failed developer, stays `queued`, and nothing tells the user why.
  Decide whether it should fail too, pause with a reason, or show in Needs You as
  "waiting on a failed agent".
  *Decided (6 Oct): confirmed. It stays queued, so it starts if the failed one is continued and
  finishes, and Needs You shows a **Waiting** alert with continue and open for the failed one.*

## Permissions

- [x] **See and revoke "allow always" rules.** Done: Settings → Allowed always; the other copy is pointed at, never edited (Amendment 48). Clicking **allow always** on a request
  saves a rule for the whole project, and nothing in the UI lists those rules or takes
  one back. Add a list per project (tool, rule content, when it was granted, which agent
  asked) with a revoke button on each. The rules live in the `session_rules` table
  (`packages/daemon/src/session/store.ts`, "session_rules"), are written by
  `#persistRules` in `packages/daemon/src/arbiter/index.ts`, and are checked at the top of
  the arbiter's decision. Revoking has two halves: delete the row, and undo the copy handed
  to the SDK as `updatedPermissions`. Depending on the suggestion's `destination`, that
  copy may sit in the project's `.claude/settings.local.json`. Decide whether Conductor
  edits that file or only says it's there, since removal otherwise never touches the
  user's files. A live agent keeps what its session was given until its next run; say so
  beside the button.
  *Decided (30 Sep): revoke deletes Conductor's row and only points at the copy in the
  project's settings file (which file, which entry); Conductor never edits it.*
