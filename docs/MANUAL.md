# Conductor — user manual

How to run several Claude Code agents across several projects without losing track of them.

§0 covers installing, starting and stopping it. The rest is about *using* it. Why the code
is built the way it is, for anyone changing it: the decision records in [adr/](adr/).

---

## 0. Install, start, stop

### What you need

| | |
|---|---|
| **Node 22+** | Conductor uses Node's built-in `node:sqlite`, so there is no native build step. |
| **pnpm 10+** | The repository is a pnpm workspace. |
| **`claude`**, signed in | The Claude Code CLI. Every agent is a Claude Code session started through the Agent SDK, and it uses your credentials. If `claude` works in your terminal, agents will run. |
| *optional:* a GitHub Copilot login | Only to run agents on Copilot (§2, "Choose the engine"). `copilot login`, `gh auth login` or `GH_TOKEN` all work. |
| *optional:* an OpenRouter key | Only to run agents on OpenRouter. Set `OPENROUTER_API_KEY`, or add it in Settings (`9`). |

```bash
node -v && pnpm -v && claude --version
```

**What agents bring with them from Claude Code.** Conductor starts each agent with Claude
Code's normal settings, so an agent gets what `claude` would get in that folder:
- your user settings (`~/.claude/settings.json`);
- the project's `.claude/settings.json` and `.claude/settings.local.json`, read from the
  folder the agent works in, which is usually its worktree;
- `CLAUDE.md` files, your MCP servers, and your installed plugins and skills.

Conductor adds its own rules on top: the pills, the deny rules, read-only roles and the
budget. An agent's **persona** (§2) can add to Claude Code's system prompt, and can narrow
the skills it's offered to a list.

### Install

```bash
make install
```

This runs `pnpm install`, and also puts a **Conductor icon on your dock**: in the Dock on
macOS (`~/Applications/Conductor.app`), or in the Ubuntu dock's favourites. Clicking the
icon starts Conductor if it isn't running, then opens it. After the first install, the
icon is all you need. `make install DOCK=no` skips the icon, `make dock` adds it later,
and `make undock` takes it off.

### Start

```bash
make start      # starts the daemon and the web app, and waits until both answer
make browser    # opens the app
```

The app is at **`http://localhost:5173`**. Use `localhost`, not `127.0.0.1`. The web
server listens only on IPv6 loopback, so `http://127.0.0.1:5173` refuses the connection
and looks exactly like a crash.

`make start` runs two processes in the background:
- the **daemon**, on `127.0.0.1:7777`, which runs the agents and keeps the records;
- the **web app**, on `localhost:5173`, which is what you look at.

Their logs and process ids are in `.conductor/run/` in the checkout. `make logs` follows
both logs.

Before it starts anything, `make start` checks that `node_modules` is the install
`pnpm-lock.yaml` asks for. After a pull that adds a package it isn't, and `make start` says
**Dependencies are out of date** and starts nothing: run `make install`, then start again.
`CONDUCTOR_AUTO_INSTALL=1 make start` installs by itself instead.

For working on Conductor itself, `pnpm dev` runs both in the foreground instead. Its
daemon restarts whenever its code changes. The daemon `make start` runs doesn't restart
on its own.

### The first start asks where to keep your data

The first time, the page asks **Where should Conductor keep its data?** Answer **Allow**
to keep everything in `~/.conductor/`. Until you answer, the daemon writes nothing under
your home folder. §7 explains the choices, including bringing your history from an older
install.

### Check that it's working

```bash
make status
```

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

In the app, press **`0`** for Diagnostics. It shows the raw feed from the daemon. If a
screen ever looks wrong, this tells you whether the problem is the data or the display.

### Stop and restart

```bash
make stop       # stops both, and frees the ports if a process was left behind
make restart    # stop, then start
```

Stopping is safe at any time, even with agents working or waiting for you. §7 says what
happens to each of them.

**Restart after you pull or change Conductor's code.** The web app reloads itself, but
the daemon keeps running the code it started with. The build tag at the right end of the
status bar turns amber with a `⚠` when the daemon is behind.

### Try it without spending anything

```bash
make fixture     # replays a recorded job, plus an agent on OpenRouter
make attention   # replays the attention queue: a parked request and a question
```

Each of these runs the web app on its own, with no daemon and no API cost. If Conductor
is already running on port 5173, the replay uses the next free port, `5174`, and its
terminal shows the address. They replay recorded data through the
same code as a live session, so what you see is real behaviour. Try clearing the queue in
`make attention` with only `⏎` and `⇥`.

If you want a repository to point real agents at, `bash fixtures/make-scratch-repo.sh`
makes a small one, with some uncommitted changes in it.

### Every make target

| | |
|---|---|
| `make start` / `make stop` / `make restart` | Start or stop the daemon and the web app. `start` and `restart` first check the install is current, and start nothing (stop nothing) when it isn't. |
| `make status` | What's running, plus jobs, agents, who's blocked, slots and today's spend. |
| `make browser` | Opens the app, or refuses if it isn't running. |
| `make logs` | Follows both logs. |
| `make fixture` / `make attention` | Recorded replays, with no daemon and no cost. |
| `make test` | Every test suite. |
| `make clean` | Stops everything, then deletes the database in `~/.conductor/` and the logs. Your settings and worktrees stay. |
| `make zip` | Zips the project as committed into `dist/`. |
| `make manual` | Opens this manual. |
| `make dock` / `make undock` | The dock icon, on or off. |

`make` on its own lists them.

### Where things are kept

| | |
|---|---|
| `~/.conductor/conductor.db` | Projects, jobs, agents, every transcript, open requests, your "allow always" rules and the day's spend. |
| `~/.conductor/settings.json` | Settings, panel sizes, folds, open Files tabs and notification choices. They're the same in every browser. |
| `<repo>/.conductor/wt/<jobId>` | Each job's git worktree. These are ordinary worktrees. |
| `.conductor/run/` in the checkout | The daemon's and web app's logs and process ids. |

### Environment variables

You don't need any of these. Set them before `make start`.

| | |
|---|---|
| `CONDUCTOR_PORT` | The daemon's port. Default `7777`. |
| `CONDUCTOR_HOST` | The address the daemon listens on. Default `127.0.0.1`. Don't change it: listening only on this machine is Conductor's main protection. |
| `CONDUCTOR_TOKEN` | Makes the daemon require this token on every request. The web app sends it when `VITE_CONDUCTOR_TOKEN` is set to the same value: as an `Authorization: Bearer` header on HTTP requests, and as `?token=` on the feed and terminal sockets, since a browser cannot set a header on a WebSocket. |
| `CONDUCTOR_DATA` | Where the database and `settings.json` go. Default `~/.conductor`. |
| `CONDUCTOR_DB` | A database file to use instead, which also skips the first-start question. Settings then last only until the daemon stops. `:memory:` keeps nothing at all. |
| `CONDUCTOR_SLOTS` | How many agents run at once, when Settings hasn't said. Default `7`. |
| `CONDUCTOR_DEFER_AFTER_MS` | How long a request is held before it parks. Default `90000` (90 seconds). |
| `CONDUCTOR_QUESTION_DEFER_AFTER_MS` | The same for an agent's question. Unset by default: a question is held until you answer it. Set it to put questions aside after that many milliseconds. |
| `ANTHROPIC_BASE_URL` | Where Conductor asks which models are served. Agents use it too, through Claude Code. |
| `OPENROUTER_API_KEY` | The OpenRouter key. It wins over one saved in Settings, and is never shown, logged or stored. |
| `LOG_LEVEL` | How much the daemon logs. Default `info`. |

---

## 1. The idea

You start **jobs**. A job is one piece of work in one project, carried out by one
or more **agents** working in an isolated git worktree.

Agents run unattended until they hit something only you can decide — a shell
command that looks destructive, or a genuine question about what you want.
Then they stop and wait. Conductor's whole purpose is making sure you find out
quickly and can answer in seconds.

Three things are worth internalising before you start:

**Amber means you.** Every other colour is status: teal working, red broken,
green done, grey idle. Amber appears only when a human is required. If nothing is
amber, nothing needs you. This is the only signal the interface really has, so
it is never used for decoration.

**A flat sparkline means stuck, not idle.** The bars on each agent are real tool
calls per 15 seconds. A busy agent's bars move. Flat grey bars mean it has
stopped doing things — thinking, or wedged.

**Everything you see is derived from one event log.** Nothing in the UI is
guesswork, and nothing is optimistic: if a screen says an agent is blocked, the
daemon has confirmed it.

---

## 2. Your first job

Start Conductor (§0) and open `http://localhost:5173`: `make start` and then
`make browser`, or click its dock icon.

### Add a project

On **Fleet** (`1`), click **+ add project**, or the **+ add a project** tile. The form
asks for the new project's folders:

- **main folder**: where agents work, and where worktrees are cut from. Usually a
  git repository.
- **name**: optional. It defaults to the main folder's name.
- **referenced folders**: optional, as many as you like. Agents can read and edit
  these too, in place. Use them for a shared library, a docs repo or a spec folder the
  work depends on. **+ reference** or `⏎` adds one to the list, and **✕** takes it off.

**add project** sends it all at once. Every folder is checked first, so one typo refuses
the whole project rather than creating half of it. If a project already has that main
folder, nothing is added, and the form says so. That project's folders are on its card.

Spawn lists the projects you have to pick from; its **+ add a project on Fleet…** brings
you here. Folder fields complete as you type, so you don't have to type all of a path or
know it from memory:

| Key | |
|---|---|
| **`⇥`** | Complete. Fills in as far as the matches agree, like a shell. |
| **`↑` `↓`** | Move through the list. |
| **`⏎`** | On a highlighted folder, step into it. Otherwise, add the project (main folder) or the folder (referenced). |
| **`⎋`** | Close the list; again to cancel. |

`~` works, so `~/src/pro⇥` gets there in a few keystrokes. Folders that are git
repositories are marked **⑂ git** in the list, and once you've typed a real folder
the line underneath tells you whether it's a repo — which decides which git choice
you can use, so it's better to learn it here than at launch.

The list only ever shows **folders**, never files, and hides dotfolders until you
type the dot yourself.

Rules that matter:

- The directory must exist.
- For **new branch:** or **new branch per launch** it must be a **git repository**. If it
  isn't, you'll get `not a git repository` when you launch, and no job is created
  — nothing half-made to clean up.
- A non-git directory works with **default branch** — the `⚠ 1 · default branch` pill, which
  works in the folder as it is. You keep the file tree,
  the change badges and in-pane editing; what you lose is anything defined against
  a commit. The branch reads `(no git)`, every changed file counts as new, and
  there's nothing to revert to — so the badges tell you what an agent wrote, not
  how it differs from a known-good state. `git init` first if you want that.

### Describe the work

Write what you'd tell a colleague. Specific beats polite:

> Refresh tokens aren't rotated — a replayed token stays valid until expiry.
> Rotate on every exchange and revoke the ancestor chain. Tests first.

### Choose which branch the agents work on

Step 3 is a git methodology, three choices:

| | |
|---|---|
| **1 · `⚠ default branch`** *(in the folder)* | The agents work in the project's own folder, on whatever is checked out there: normally the default branch (the Branches screen can set it and check it out), or no branch when the folder isn't a repo. Nothing is cut off from your own files, and there is nothing to revert to. The only choice that needs no git. |
| **2 · `⑂ new branch:`** *(a name you give)* | A separate worktree on the branch you name. A branch that exists is used as it is, with its commits; one that is only on origin gets a local branch that tracks `origin/<name>`, with origin's commits; a new one is cut from what the folder has checked out. Your folder and your other jobs are untouched. **A name field appears under the pills, and the launch waits until it has a name git accepts.** The field lists the project's branches as you type: local ones first, then those only on origin, marked **on origin**. The default branch and branches checked out somewhere are listed too, marked, because a launch on them is refused. You can still type a new name. |
| **3 · `⑂ new branch per launch`** *(default, recommended)* | A fresh git worktree at `<repo>/.conductor/wt/<jobId>` on a new branch `conductor/<jobId>`. Your own checkout is never touched. |

A "text input command" here means a launch from Spawn. A follow-up message to an agent stays on
its job's branch.

**What choice 2 refuses.** A name git does not take (a space, `..`, a leading `-`, `.lock` at the
end, `@{`, and so on) is a 400 with the reason. The project's **default branch** is refused, and so
is a branch **checked out somewhere already**: in another job's worktree, in a worktree of your own,
or in the project's folder. These are a 409, and the message says where. Nothing is made when a
launch is refused. A branch that exists is never reset: its commits are kept.

**A branch on origin.** Spawn does not fetch. A branch is "on origin" as of the last fetch (the
Branches screen's **fetch**), so a branch pushed since then is not listed, and naming it cuts a new
branch from what the folder has checked out. Fetch first.

**The setting.** **Settings → What Spawn starts from → git branch** offers the same three. If you
make choice 2 the default, Spawn opens on it with the name empty, and will not launch until you
give one. Spawn clears the name after a launch on it, because that branch is taken by the job you
just started.

One worktree per **job**, not per agent — agents in a job share it and are
coordinated, because worktree-per-agent would make merge conflicts the product.

If the project you picked in step 2 has no git in it, choices 2 and 3 are **struck
through** and `default branch` is selected for you, with a line saying which
folder and why. Both of the others create a branch, so there is nothing to argue
about — `git init` the folder and re-add it if you want them.

The older **branch in place** isolation (a new branch in your own checkout) is no longer offered in
Spawn. Jobs that were launched with it are unchanged.

### Choose who works on it

| Preset | |
|---|---|
| **full build pipeline** | architect designs it, then developer builds it, validator tests what was built, reviewer judges it against the plan, and scribe records it, one after another. The reviewer and the scribe are also handed the architect's plan. The default. |
| **orchestrated pipeline** | one architect, the **orchestrator**, runs the others: it starts developer, validator, reviewer and scribe one at a time, reads what each did, writes the next one's brief, sends work back when a review fails, and asks you when it is unsure. You choose the roles it may start. See "An orchestrated pipeline" below. |
| **bug fix** | debugger finds the root cause, developer fixes it. |
| **review only** | one reviewer. Judges a change; reports findings. |
| **analysis** | analyst explains how the code works, then scribe writes that into the project's docs. |
| **Analysis Only** | analyst explains how the code works, then scribe writes the findings down. |
| **one agent** | a single developer, no structure. |
| **custom…** | the agents you add yourself. One of them can orchestrate: see "An orchestrated pipeline" below. |

**Who waits for whom.** The plan under the presets lists the agents in the order they run, and
each row waits for the one above it. Move a row with its **↑ ↓** buttons (they work from the
keyboard) or by dragging its **⋮⋮** grip onto another row, and it waits for whatever is above
it in its new place. Under every row but the first, **waits for** has a box for each row above
it: tick several to wait for more than one (the reviewer in the full pipeline waits for three).
Moving a row keeps the ticks that still point above it and drops the rest, and a row that
waited only for the one above it keeps doing that. This is for this launch only. A job launched from a
preset you moved or ticked is labelled **<preset> (changed)**, not the preset's own name. It isn't
saved, and it doesn't turn the preset into a Custom setup. Click the preset again, or **↺ back
to** it in the plan, to put it back. An agent can only wait for one above it.

**custom…** opens an editor with one row per agent:
- Pick a **persona** for the row: it fills in the role name, brief and model, and brings
  its system prompt and skills. Its tool rules no longer change what the row runs with —
  only **write: false** does, pinning the row as a reading row (Amendment 147); the plan row
  then says so underneath, for example "reads only (reviewer): no file edits". A row named
  like a persona, such as the first `developer` row, runs as that persona, and its picker
  says so; pick **no persona** for a plain role.
- Give each row a role: keep the persona's or type your own, like `developer-api`. Two
  rows can share a persona.
- Optionally give it a brief of its own, on top of the job prompt; empty uses the
  persona's. Its model can be changed in the plan preview, for this launch only.
- Tick which agents above it it **waits for**. It's handed their conversations and the
  summary each handed off with, like any agent that waits. A new row waits for the one above it. Move a row with **↑ ↓** or by
  dragging its **⋮⋮**, as in the plan above; its ticks follow the same rule.
- **Remove** a row and the rows that waited for it are re-chained: one that waited for exactly the
  removed row now waits for the row that was above it (for no one, if the removed row was the
  first), and one that waited for it and others keeps the others.
- Tick **orchestrates** on a row to have it run a pipeline, as the **orchestrated pipeline**
  preset's orchestrator does: the roles it may start are listed under it in the plan, edited the
  same way, and saved with the setup. One row at a time: ticking one unticks the others. It is
  offered only on an engine that can start helpers.

**Personas** (Settings → **Personas**) are what each role is. Each one holds a name, a
description, a brief, a **system prompt** (added to Claude Code's own, not replacing it),
a default model, one tool rule — **write files**, on, off or the launch's choice — and
**skills** to preload. Shell, push, network and MCP are the launch's pills alone now,
whatever a persona stores for them (Amendment 147); only **write: false** still acts,
pinning the row as a reading role. With skills listed, the agent is offered only
those skills. The built-ins (architect, developer, validator, reviewer, scribe, debugger,
analyst) can be edited, and **reset** puts one back as it shipped; they can't be deleted.
Builder, documenter and uiux were built-ins until 6 Oct. An edit you made to builder is now
developer's, and one to documenter is now scribe's. A saved setup's row that used builder
or documenter runs as developer or scribe, and one that used uiux runs with no persona. **+ new persona** adds your own, which can be deleted. The **architect** designs before
anyone builds: it reads the code, weighs two or three options, picks one, and writes the
plan and an ADR in `docs/adr/` without changing source code. It runs on opus, may run
shell and write its documents, and never pushes. In a Custom setup, put a developer after
it (waiting for it), and the developer starts from its plan. Presets use the persona of
the same role for its system prompt and skills, and keep their own brief and model. A
persona with **write: off** reads only, and a reading role (reviewer, debugger, analyst,
auditor) never writes, whatever its persona says. When a persona or a reading role pins a row read-
only, the plan says so underneath: "reads only (reviewer): no file edits, read-only shell
only, no MCP, mode ask me." Editing a persona changes what new launches and saved setups
get. A running or sleeping agent keeps what it launched with.

**What the built-in roles are told** (since 10 Oct, each has a system prompt; the text is in
Settings → **Personas**). Every one is a line of purpose, a few rules about *how* to work, and
a fixed ending, so what the next agent reads has the same shape every time:

| Role | Its job | Its reply ends with |
|---|---|---|
| architect | a design someone can build from: evidence with file and line, options and their cost, a decision, a plan | Context, Options, Decision, Consequences, Plan, Risks and open questions |
| developer | the smallest change that does the job, following the plan and the code around it, run through the project's typecheck and tests | Changed, How I checked, Departures from the plan, Left undone |
| validator | evidence: writes the missing tests, runs the whole suite, and **reports** a bug it finds rather than fixing it | Verdict, Checks, Failures, Not covered |
| reviewer | a verdict you can act on: what was asked first, then correctness and quality, findings ranked blocker, should fix or nit; changes no files | Verdict, Findings, What I checked |
| scribe | documentation that is true today: the code wins over the plan, citations kept; documentation only | Updated, Corrected, Not documented, and why |
| debugger | the root cause, proved in four steps (reproduce, isolate, cause, confirm); writes no fix | Symptom, Reproduction, Root cause, Evidence, Fix belongs at, Regression test, Confidence |
| analyst | a map you can check: starts from the entry points, cites file and line for every claim; changes no files | Overview, Map, Flows, Decisions encoded, Open questions, Not read |

Those headings are the **summary** an agent gives `hand_off` when others wait for it (see
"Handing off to the next agent"), and its last reply when none do. The developer does not
commit, push or rewrite history unless the job says to: its changes stay in the working
tree, where **Files** shows them and the agents after it read them, and you commit them from
**Branches** (**Commit…**). The reviewer's verdict is words in a reply; nothing waits for it or
stops on it. The tools of the built-ins are as they were, and only the architect says
anything about pushing (it never does). Their models changed on 14 Oct (Amendment 148): the
architect and the developer are on opus, the other five on sonnet. A stack's preset keeps its own brief, so the
system prompt is what reaches every stack. If you had edited a built-in, you keep your edit;
**reset** puts back the new text.

**Several agents on one role.** In the plan preview, each row's last picker reads
**1 agent**. Change it to **+ up to N helpers**, and that agent orchestrates:

- It's told it may start up to N helpers with a `start_helper` tool. It splits the work
  into parts that don't touch the same files, starts a helper for each, and ends its turn.
- Each helper is an agent in the same job and folder, with the orchestrator's model,
  permissions and per-agent budget. It takes a slot like any agent, and its lane sits
  under the orchestrator's (**↳ helper of developer**).
- While they work the orchestrator waits, **queued**, and gives its slot back. Once every
  helper has ended (a failed one counts, and it's told which), it starts again in its own
  session with what each one was told and said: its task, its replies and a line for each
  tool it called, within the same share of the model's window an agent in a stack is given
  (below). It can then check, combine, or start more.

The job's budget is the sum of its agents' budgets, so each helper adds one agent's budget. It
works as an agent's does: Needs You warns when the job passes it, and agents still to start
are held only at its ceiling, twice it unless Settings says otherwise (§6).

**An orchestrated pipeline.** The other presets fix the order before you launch and have each
agent judge its own work and hand it on (`hand_off`). **orchestrated pipeline** is the other
kind: one agent, the **orchestrator** (the architect persona, on opus), decides the order while
it runs and judges every step. Pick it beside the fixed ones, and keep the fixed ones for work
whose steps you already know.

- **The roles it may start are listed under its row before you launch.** Unless you change
  them: developer, validator, reviewer and scribe, each on the tier its persona asks for
  (opus, sonnet, sonnet and sonnet). Change a role's **tier** with its picker, remove one
  with **×**, or add another (architect, debugger, analyst or a persona of your own) with
  **+ add a role…**. A persona whose model is an exact id rather than a tier (set in
  Settings → Personas) is listed on that id: the picker shows it above the tiers, and its helpers
  run on it. Pick a tier to change that for this launch; pick the id to go back to it. The tier
  under an exact id is sonnet, which only sets how far down the orchestrator may ask. Off Claude
  every role still runs on the launch's one model. It can start those roles and no others. The list is for this launch only;
  choosing the preset again puts the default back. A Custom setup's row can orchestrate too
  (tick **orchestrates**): the same list goes under that row, and a saved setup keeps it.
- **How it works.** It plans the steps, then starts one role at a time with `start_helper`,
  giving it a `role` and a `task` it writes in full: a helper is told the job instruction and that
  task and sees the folder, but not the orchestrator's conversation. It ends its turn and waits,
  **queued**, giving its slot back. When the helper has ended it is woken with that helper's
  **whole conversation**: what it was told, what it said, and a line for each tool it called
  (the same text, within the same share of the window, as for an agent in a stack). It reads
  it before it decides whether the step is ready, and then writes the next brief. A step that
  stopped is not a step that is ready.
- **Each helper runs as its role.** It has that persona's system prompt (what the built-in roles
  are told, above), skills, tools and model, and its lane is named for the role and the work's
  name (`developer-api`, `reviewer`, …), under the orchestrator's. A reading role (reviewer,
  debugger, analyst, auditor) stays read-only: the write tools are denied outright, whatever the pills
  say. The orchestrator may
  ask for a **cheaper tier** than the one listed for a step that is easy (`tier` on
  `start_helper`); a dearer one than you chose is refused.
- **Each piece of work has a name.** The orchestrator gives each new piece of work its own
  `name` on `start_helper` (`api`, `parser`, `w11-a1`); the role and the name together are that
  work's **lane** (the helper is named for both: `developer-api`). A new name is new work, so
  four developers on four pieces of work all start, as long as the helpers in all allow it.
- **It can send work back**, at most **twice per lane**. After a failed review it starts the
  developer again with the **same name** and a new brief that says what failed; that is the
  first send-back. The second is the last: one role with one name is started at most three
  times in all, and a fourth start is refused with a sentence that names the lane ("You have
  started the developer for “api” 3 times: …") and tells it to ask you with the question tool,
  which puts the question in **Needs You**. Another lane of the same role can still be sent back.
  Starts with no name are one lane together, so they keep the three starts they had. It also asks
  you, in the same way, whenever it is unsure: a choice that is yours, a result it cannot judge,
  a step that keeps failing.
- **Its helpers have no `hand_off`.** The orchestrator's own judgement of each result replaces
  it, so a helper is never **held** as "not handed off" and never waits in Needs You for you to
  hand off for it.
- **Cost.** Each helper takes a slot and one agent's budget, so the job's budget is the sum of
  its agents' budgets, as for helpers above. The launch allows the orchestrator as many helpers
  as the roles listed times three (four roles, twelve helpers) unless you choose another number:
  the head of the listed roles reads **may start up to [12 helpers in all]**, and the select goes
  from one per role up to **48**, for a plan of many lanes. Every start counts against it, new work
  and send-backs alike. It is for this launch, like the list; choosing the preset again puts the
  default back. The orchestrator wakes with a growing conversation each time and is the one
  agent to put on a strong model; a fixed stack costs less. If it misjudges a step the mistake
  runs through every step after it, where a fixed stack's agents each judge their own.
- **How it looks.** The orchestrator wears a **◆ orchestrator** mark and a heavier edge in plain
  ink, no status colour, in the plan, on its Project lane and Fleet card row (◆) and on its
  Agent tab (◆), and the ◆ on its row in the navigator. Only a stack of two or more agents has
  one. Take every role off the list and it is one agent: the plan says so, the mark and the
  helper cap are gone, and it launches as the full pipeline's architect on its own. A Custom
  row with every role taken off launches as the agent you made, plainly.
- **On Copilot or OpenRouter** every role runs on the launch's one model, with no tiers to
  choose between; the rest is the same.

Each row gets its model in the plan preview, like the presets. Each role can appear only
once, and a role that only reads (`reviewer`, `analyst`, …) stays read-only here too. Name
the setup and **save** it, and it appears beside the presets, in every browser; a row that
orchestrates is saved with the roles listed under it. **✕** then **forget it** removes a saved one.

**analysis is not review under another name.** A reviewer judges a change and
answers "is this right" — there's a diff, and the output is findings. An analyst is
pointed at code nobody has read yet and answers "how does this work" — no diff, and
the output is a map. Use it on a codebase you've inherited.

The analyst writes nothing. The **scribe** waits for it, is handed its report, and
writes it into the project's documentation: the README, `docs/`, and any architecture or
decision records. So the map outlives the job. The scribe **does write files**, and
it's told to change documentation only. That limit is its brief, not its tools: there's
no tool that can edit `README.md` but not `index.ts`. Check its diff like any other
change. With worktree isolation, the docs land in the job's worktree, not in your
checkout, until you take them.

**The model** is chosen per role by the preset — opus for the roles that design and build
(the architect, the orchestrator and the developer), sonnet for every other role (validator,
reviewer, scribe, debugger, analyst; Amendment 148) — and that's the default. Each row of the plan preview
has its own model picker showing the **exact model id** that role will get, such as
`us.anthropic.claude-opus-5-5`. Change a row to give that role a different model: opus
for the reviewer of a risky change and a cheaper model for the scribe, say. Hover a row to see the tier its
preset gave it.

The **model** picker above the plan sets every row at once. It shows that model while
every row is on it, and `per role` otherwise. Choosing `per role` puts every row back on
its preset's tier. Switching preset keeps a model you gave every row, and drops the
per-row picks.

The list is what your model API serves right now. Conductor asks it (`GET /v1/models` on
`ANTHROPIC_BASE_URL`), and uses Claude Code for the display names. Claude models come
first. Models that aren't Claude are listed under **Other models · may not handle Claude
Code's tools**. They're served, but an agent needs tool calls that work the way Claude's
do, so try one on something small first. `↻` asks again; otherwise the list is kept for
ten minutes.

An agent keeps the exact id it was launched with, never a nickname like `opus`, so the
model can't change under it when your settings do. The preset's `opus` is turned into an
id at launch. If your API serves no model for a tier (no haiku, say), the plan preview
row says `haiku · not served`, and launch waits until you pick a model in that row.

If the model API can't be asked, the list comes from Claude Code instead, with a note
saying so. That's what your settings name, not what's served, so it can include models
that will fail.

You'll see the agent plan before launching — which agents run in parallel and which
wait on others. A `reviewer` typically sits queued until `developer` and `validator`
both finish, and starts itself.

An agent that waited is told what the ones before it said. Its first message is the job
prompt, then each earlier agent's whole conversation under its role (what you told it, what it
replied, and a line for each tool it called, though not what the tools returned), then its own
brief. So the developer in **bug fix** starts with the cause the debugger reported, and the
reviewer in the full pipeline starts with what the architect, developer and validator
concluded. It is sent once, at launch. You can read exactly what the agent was told as the
first turn of its transcript.

The agents further up are passed on too, by their summaries. In a chain architect → developer →
scribe, the scribe hears the developer whole and the architect's summary under **[architect, via
developer]**, though it waits only for the developer. Each one further up is there once, however
many paths lead to it, and the furthest comes first. Only what it said when it handed off goes
on: one that never handed off, or that you ran it without, is left out. These summaries share the amount below with the
conversations, so when there isn't room one is cut, and a line says how much of it was left out.
**↻ re-run after this** (below) tells an agent the same. The files come the other way: every agent in a job works in the
same folder, so what an earlier agent changed is already there.

How much of it is passed on is about a quarter of the next agent's model's context window,
shared between the agents it waited for. The window is the real one when the engine says what
it is (OpenRouter's, Copilot's, a Claude gateway's when it reports one, and for Claude the
window each finished run reports, which wins over a list's); when it doesn't, Conductor
assumes a small one, so an unknown model is given less rather than more. The
amount is counted in characters, at about three to a token: it is an estimate, not a count.
Over it, the oldest goes first and the last reply is always whole. When the agent waits for
several that were each given the same earlier text (three agents that share a parent), that
text is passed on once, and a line says where it went. The windows are kept across a restart
of the daemon, so a resumed stack uses the real ones at once.

Roles that only read — reviewer, debugger, analyst, and auditor (from older analysis
jobs) — are marked
**read-only** in that plan, and it's enforced rather than advertised: the file-writing
tools are denied outright for them, so they stay read-only even if you've set the
autonomy pills wide open, and even if you approve a prompt. They can still run shell
commands — an analyst that can't run `git log` can't tell you how the code got this
way. Since 14 Oct (Amendment 148) the read-only ones run without asking, whatever the shell
pill says: `git status`, `git diff`, `git log`, `git show`, `git blame`, `grep`, `cat`,
`head`, `tail`, `ls`, `wc`, `diff`, `stat` and `pwd`, alone or piped into each other.
`--output` on `git diff`, `log` or `show` is refused, since it writes a file. Every other
command still stops and asks, and so does one of those that writes into a file with `>`.
`sed`, `find`, `rg`, `sort` and the rest are left off on purpose: each has an option that
writes or runs something else (`sed -n '1w f'`, `find -delete`, `rg --pre`, `sort -o`), and
running the tests can write build output. Claude Code itself still lets their plain forms
through. What Claude Code double-checks (a `for` loop, `$VARIABLES`, `cd` into another folder
before `git`) still asks.

### Choose the engine

Under the presets, **engine** chooses what the launch's agents run on. Every agent in one
launch runs on the same engine, and an agent keeps its engine for life.

| Engine | Runs on | Needs |
|---|---|---|
| **Claude** | Claude Code, through the Agent SDK. The default, and everything else in this manual. | `claude`, signed in |
| **Copilot** | GitHub Copilot, through `@github/copilot-sdk`, with Copilot's models. | A Copilot login |
| **OpenRouter** | OpenRouter's models, through the same Copilot SDK, with your key. No GitHub login is needed. | An OpenRouter key |

An engine that can't start agents is struck through, and the line under it says why: no
login, or no key. Settings (`9`) → **Providers** says whether Copilot sees a login, and
takes the OpenRouter key: paste it and **save**, or **clear** it. Once saved, the key is
never shown again. It is kept in `~/.conductor/secrets.json`, readable only by you, and
never in `settings.json`. `OPENROUTER_API_KEY` in the daemon's environment wins over it.

On Copilot or OpenRouter, **model** is one id for every agent in the launch, such as
`anthropic/claude-sonnet-4.5`. The field lists what the engine offers, and you can type
any id. An id the engine doesn't list is refused at launch.

These agents work like Claude ones: the same transcript, the same Needs you and the same
deny rules. Conductor itself refuses a tool on an agent's deny list, on every engine, even
under **bypass permissions**. Their badge on Fleet cards, Project lanes and the Agent
screen names the engine. Some things are different:

- **Budgets are in tokens, not dollars.** Neither engine reports what a run cost, and
  Conductor won't estimate it. The budget pill reads **budget per agent per day 5M tokens**
  and counts input plus output tokens, per day. Like a dollar budget it warns at that figure and
  stops the agent at its ceiling, twice it by default (§6). The agent's details, its lane and its
  composer show its tokens, today and in total, where a Claude agent's show dollars.
  The status bar's spend, today and in total, stays Claude's dollars only; a project's shows its
  tokens beside its dollars. OpenRouter still bills you, so
  watch its dashboard.
- **No plan mode.** **plan first** is hidden, and a preset that plans first asks you
  instead.
- **A request they wait on doesn't survive a daemon restart.** Conductor holds the request
  while you decide, with no time limit. A Claude agent parks it and picks it up later,
  but these engines can't. If the daemon stops first, the request shows as **expired**,
  and the agent carries on without it.

### Choose how much rope

**First, how the agents interact with you** — one choice for the whole launch:
**ask me** (every edit and every command the pills don't allow waits for you),
**auto-accept edits** (the default: edits go ahead, commands still ask), **plan first**
(it plans and changes nothing until you approve), **auto** (Claude Code decides what's
worth asking), or **⚠ bypass permissions**, which says plainly that nothing will ask you
and nothing will reach Needs You. The pills below still decide the tool rules in every
mode, so no push and no network hold even under bypass, and a reading role stays
read-only whatever you pick — a persona's **write: off** pins a row the same way, and the
plan says so underneath it. The default is in **Settings** → launch defaults, and a
running agent's mode can still be changed from its composer.
Every switch in this row reads the same way: **on means the agent may do it
unattended.** A ⚠ appears on a switch that is *off* and will therefore stop and ask you.

**What "run shell unattended" covers.** Claude Code double-checks some shell commands
whatever you've allowed: a `cd` before a `git` command (another folder's git hooks could
run), commands with `$VARIABLES` or `$(…)`, cloning. With the pill on, Conductor answers
those for you, so they never reach Needs you. The deny rules still hold (no push unless
allowed), and a reading role never gets unattended shell: only its read-only commands run
without asking (above), and Conductor doesn't answer the double-checked ones for it. **Allow MCP tools** does the
same for your MCP servers' tools (Jira, Lucid, Obsidian…), which no other pill covers;
it's off by default, and a reading role never gets it, since some of those tools change
things outside the folder. Both are in a running agent's guardrails too.

**Allow all session** on a request now works even when Claude Code offers no rule of its
own, which it doesn't for the commands it double-checks. It allows that exact command
from then on, for the project; a different command still asks.

| | |
|---|---|
| **run shell unattended** | Off (the default) means every shell command waits for you. |
| **allow git push** | Off adds a deny rule on `git push` that survives every mode. |
| **allow network** | Off blocks WebFetch and WebSearch. |
| **allow MCP tools** | Off (the default) means every MCP tool call waits for you. |
| **merge into main and clean up when done** | Off (the default) means a finished job's branch waits for you: Needs You asks **Finished: merge into main?**. On, when the job finishes on a branch of its own and the merge would be clean, the branch is merged into main, then the job, its folder and its branch are removed. Its agents can't be messaged afterwards; their transcripts stay. Nothing is pushed. See "When a job finishes" (§3). |
| **⏱ budget per agent per day $** | What each agent may spend **per day**, $25 by default: it counts what the agent spends today and starts again at zero at midnight, your machine's. Leave it empty for no limit. Past it the agent keeps working and Needs You warns; it stops at the ceiling, twice the figure unless Settings (9) says otherwise. See §6. |

Whether file edits go ahead unattended is now set by the interaction mode above
(**auto-accept edits**), not by a pill.

Separately, **effort** — `low` · `medium` · `high` · `xhigh` · `max` — is how hard the
model thinks, not what it's allowed to do, which is why it has its own row. `high` is the
default. You can change it per agent after launch from the Agent screen (`3`); like the
permission mode, it applies from that agent's **next** run.

See §5. The default is a reasonable middle: edits auto-accepted inside the
worktree, shell commands ask first.

### Launch

Press **`1`** for **Fleet** to watch. The job appears with its agents; the
sparklines start moving.

### Add an agent to a running job

A job doesn't have to stay the stack you launched. On the Project screen (`2`), each job's
header has **+ agent**. It opens one row, the same one Spawn's Custom setup uses: a role, a
persona, a brief, and **waits for**, which lists this job's agents (not helpers, and not one
that was stopped). Under it:

- **also feeds**: the job's agents that haven't started yet. Tick one and it waits for the new
  agent too, which puts the new one in the middle. Add a tester that waits for the developer
  and feeds the reviewer, and the reviewer now hears the tester as well.
- **model**: the model picker on Claude, a model id on another engine.
- **budget**: the new agent's own budget, in dollars, or in tokens on an engine that reports no
  dollars. It is required, as on Spawn, and the job's budget grows by it.

It runs on the job's engine, with the job's permissions (taken from an agent in it that
writes, or reads, as this one will). Its persona's tool rules don't change that, apart
from **write: off** (Amendment 147): a reading role, or a reading persona, is kept
read-only regardless. Change its permissions afterwards in its inspector, as for any
agent.

**+ add** checks it first and says what's wrong: a role already in the job, a loop (it would
wait for an agent that waits for it), feeding an agent that has already started, or no cap.
Adding to a finished job opens it again. The agent starts as soon as what it waits for is done
and a slot is free.

### Handing off to the next agent

An agent that others wait for hands off by saying so. It is given a `hand_off` tool (Claude over
Conductor's tool endpoint, Copilot and OpenRouter in-process, like `start_helper`) and told to
call it when it is done, with a **summary** of what the next agents need. The agents after it
start once its turn ends, and are told that summary first, above the whole conversation they
are given. The last agent in a chain has nobody to hand off to: it has no tool, and finishes
**done** as before.

**A summary short of its headings is kept, and the agent is told.** The headings are the ones in
bold on the "End with:" line of the system prompt the agent was launched with (a built-in's are
in the table under "Choose who works on it"; an edited persona's are its own). Each must open a line
of the summary: as a Markdown heading (`## Plan`), in bold or italic (`**Plan**`, `- **Plan:**`),
or plain with a colon or on a line of its own (`Plan:`). The same word opening a sentence
("Plan to …") or inside one doesn't count, nor does another name for it (**Departures** for
**Departures from the plan**). If one is missing, the summary is still saved and the agents after
it still start with it, but `hand_off` answers *Handed off, but your summary has no heading for
Plan. It is saved …* and asks the agent to call it again with the whole summary, which replaces
the first. A prompt with no "End with:" line, or nothing bold on it, has no headings, and nothing
is checked.

If its turn ends **without** calling it, nothing after it starts. It stays **done**, and Needs
You shows **Not handed off**: *architect stopped without handing off, so the agents after it
have not started*, with the agents waiting listed.

- **hand off** opens the summary for editing, filled in with the agent's last reply. Change it
  to say what the next agents need, and **hand off with this** sends exactly that text; they
  start. Putting it away (**dismiss**) leaves them waiting. If what is in the box has no
  heading for one of the agent's headings, the box says so under it (*missing: Plan*); it is a
  warning, and **hand off with this** still sends it.
- **Reply to it instead**, in the box on the card: the agent works again, and hands off when
  it is done.
- The hold is kept if the daemon restarts. The job stays working while one is held.
- **Fleet and the Project screen show it too.** The agent's row on its project's card on Fleet,
  and its lane on the Project screen, have an amber **not handed off** chip: *hand off in Needs
  You →*. It opens that card in Needs You. If you dismissed the card, the chip says *open the
  agent* instead, where a reply works it again and it hands off when it is done. The chip goes
  once it has handed off or nothing is left waiting for it.
- An agent that **a restart interrupted** is told that anything it had running in the background
  was stopped with it. If it still ends its turn without handing off, Conductor asks it once to
  hand off, in the same session, before it comes to you. If it ends without handing off again,
  you get the card as above.

An agent you write to after it has finished is a new run. If the agents after it have all run
already, nothing is held, and **↻ re-run after this** (below) works as before. Re-run asks each
agent that has agents after it to hand off again, since its old summary was about the old plan;
if it doesn't, it is held the same way. **↻ re-run after this** on an agent that is held is
greyed out, with the reason as its hover text (*architect stopped without handing off, so the
agents after it haven't started. Hand it off in Needs You first.*): none of them has started, so
there is nothing to run again. Hand it off first.

### Run the agents after one again

You can talk to an agent after it has finished: ask the architect to change the plan, and it
answers. The agents after it were given the old plan. **↻ re-run after this**, in the Agent
screen's header, starts them again with the new one. It is there only when the agent has
agents after it, and it is manual on purpose, so a conversation with the architect doesn't
re-run the whole stack on every message.

The first press says what it will do, in a banner under the header, and a second commits:

- **Who.** Everything after it, however far down: the agents that wait for it, and the ones
  that wait for those. They go in order. An agent starts again only once the agents it waits
  for are done again, and it hears their new replies.
- **In their own conversations.** Each agent goes back into the session it had, told that its
  input changed and what the agents before it said last. It isn't a fresh start.
- **Running ones are stopped first.** An agent after it that is still working has an out of
  date input, so it is stopped (its conversation is kept), then resumed like the rest. A
  question it was waiting on you for is cancelled, and a helper it has working is stopped
  too.
- **The folder is left alone.** Nothing is reset or cleaned up. The agents see what is
  there and fix what no longer fits.
- **An agent that hasn't started yet** is left alone, and reads the new reply when it does.

The button is greyed out, with the reason as its hover text, when the agent is still
working or waiting for you (re-run once it has finished its reply), is paused or failed, or
has written nothing, or is held for not handing off (hand it off in Needs You first), or when
an agent after it was stopped (remove it from the stack first)
or is only just starting. If an agent after it has reached its ceiling today (twice its daily budget by default), or the job has,
the daemon refuses when you press it and says so (raise the budget first). The sentence shows in
the same place. Nothing is stopped or started on a refusal.

Pressing it is kept: if the daemon restarts before an agent starts again, that agent still
starts with the note that its input changed, and not with the ordinary wake-up message.

---

## 3. The core loop: when an agent needs you

**The amber rail across the top is the only thing that ever moves up there.** When
it lights up it names who is waiting and for how long, then any alerts (below). Click
it, or press **`4`**. With nothing waiting it reads **nothing needs you**.

You'll also get a browser tab badge, and a desktop notification and a sound if you turn
them on (see Notifications, below). The badge keeps working while you're on other
screens.

### Permission requests

A card shows the **exact command**, the working directory, the rule it tripped,
and whether it can be undone. Four ways to answer:

| Key | Action | |
|---|---|---|
| **`⏎`** | **Allow once** | Runs this one call. |
| **`a`** | **Allow all session** | Persists a rule so you stop being asked for matching calls. This is how you stop being interrupted twelve times by the same thing. |
| **`e`** | **Edit & run** | Change the command, then run your version. **Only available on *held* requests** — see below. |
| **`⎋`** | **Deny** | Blocks it, with room to say why. The agent reads your reason and adapts, so "don't delete it, archive it instead" is more useful than a bare no. |

`⏎` answers and immediately loads the next blocked agent. `⇥` skips. **You can
clear the entire queue without touching the mouse.**

### Questions

Sometimes an agent asks rather than acts, with two to four options. Because
Conductor runs in a browser, options can carry a **rendered preview** — a small
mockup or a code sample — so you can compare rather than imagine. Multi-select
questions use checkboxes, and there's always an "Other" box if none of the
options is what you want (`o` picks it). `⎋` on a question clears your choices.

### Alerts

Needs you also shows things that stopped without asking you anything. They're listed
below the requests, one card each, and each card's first button is the one that fixes it:

| Alert | When | What you can do |
|---|---|---|
| **Agent failed** | An agent ended with an error. The card says why, in words. | **continue** (when its session can be resumed), open it, or dismiss. |
| **Over its daily budget** | An agent, or its job, has spent more **today** than its daily budget and is still going. A warning only: nothing is paused, and it stops at the ceiling (twice the budget unless Settings says otherwise). The card says what it spent today, the budget, and where it stops. For a job, the card names the agents in it. | **+$10** or **+$25** (**+100k tokens** or **+500k tokens** on an engine that reports no dollars), which raise the daily budget and clear the warning, or open it, or dismiss it. Dismissing lasts until you raise the budget and it is passed again, or until midnight: a new day's warning is a new card. |
| **Budget reached for today** | An agent reached its ceiling today (twice its daily budget, unless Settings says otherwise) and was paused. | **+$10 and continue** or **+$25 and continue**, which raise its budget and wake it, or open it. At midnight the budget starts again and Conductor continues the agent for you, so the card goes; its transcript says a new day's budget began. With **at midnight, continue agents the day's budget paused** off in Settings (9), it stays paused instead: the card says the budget is **renewed for the new day**, and **continue** needs no raise. The same for an agent held for its job's budget. |
| **Model API** | The model API isn't answering: the network, your login, or an outage. | Nothing while Claude Code is still retrying. The alert clears itself once the model answers. If it gives up, **retry** wakes the agents it stopped. |
| **Reconnecting** | The model couldn't be reached and Conductor is going to try again for you: *Reconnecting in 30 s (3 of 5)*. It appears from the first try, and chimes like any alert (see "When the model can't be reached", §7). | **retry now** tries at once. **stop retrying** gives up and the agent ends failed. Open the agent. It goes away by itself when the try starts. |
| **Dev server down** | A dev server an agent started has stopped answering. | Open its preview, or dismiss. |
| **Daily budget** | Today's spend reached the daily budget set in Settings. | A warning only: nothing is stopped. Change the budget in Settings. |
| **Note due** | One of your project notes is due or late. | **✓ mark done**, open the project, or dismiss it for the day. |
| **Not handed off** | An agent that others wait for ended its turn without calling `hand_off` (see "Handing off to the next agent"). It is done; the agents after it stay queued. | **hand off**, which opens the summary to edit before it goes; a reply box, so the agent works again; open it, or dismiss. |
| **Waiting** | An agent waits on one that failed or was stopped. Behind a failed one, such as the reviewer after a failed developer, it stays queued and starts once that one is done. Behind a stopped one it is paused (see "Stopping an agent", §7). | Behind a failed one: **continue** it (when its session can be resumed), open it, or dismiss. Behind a stopped one: **resume** the waiting agent to run without it, open the stopped one, or dismiss. |
| **Finished: merge into main?** | A job on a branch of its own finished, and its branch has commits main lacks. When its agent had **merge into main and clean up when done** on but the merge couldn't run by itself, the card says why (a conflict, named; main's checkout has changes; an agent not done). | **merge and clean up**, which asks first, then merges and removes the job, its folder and its branch (its agents can't be messaged afterwards; their transcripts stay); **merge**, which only merges, so the job and its folder stay and its agents can still be messaged; **open Branches**; or dismiss. |
| **Merged** | Its agent's **merge into main and clean up when done** merged a finished job's branch. The card names the branch and the merge commit, and whether the job, its folder and its branch were removed; when they weren't, why. | Open Branches, or dismiss. |

An alert stays until the daemon says the problem is gone, or until you dismiss it.
Dismissing is remembered across reloads.

### When a job finishes

A job on a branch of its own (**new branch:** or **new branch per launch**) that finishes
with commits main lacks is not merged by itself, unless you asked. Ask per agent: tick
**merge into main and clean up when done** in Spawn (Settings can make it what Spawn starts
from), or in an agent's settings on the Agent screen. Then, when the job finishes, every
agent in it is done and the merge would be clean, Conductor merges it into main the way the
Branches screen does, then removes the job, its folder and its branch. Its agents can't be
messaged afterwards; their transcripts stay, each with a note saying what was merged and
removed, and Needs You shows a **Merged** card with the merge commit. If anything refuses —
a conflict, main's checkout has changes, an agent that isn't done — nothing is merged and
you get the **Finished: merge into main?** card instead, saying why. Nothing is ever pushed:
push from the Branches screen.

### Notifications

The browser tab's title and icon show how many things need you, and turn red once a
request has waited 12 minutes. Two more are off until you turn them on, in the panel on
the right of Needs you: **desktop notifications** (your browser asks permission the first
time), and a **sound**. The sound plays once a request has waited 60 seconds, and at once
for an alert. These work on every screen.

### When a job finishes

When nothing in a job can go on by itself, the job has **finished**: every agent has ended,
done, failed or stopped, or is paused, or is queued behind one of those. Until you've
seen it, its Fleet card, its group on the Project screen and its group in the navigator say
**finished** (green, or red if an agent in it failed), and the tab's count includes it. With
desktop notifications on you also get one, **<project> · job finished** or **job ended with
a failure**, with the job's prompt; clicking it opens the project. A finished job doesn't
chime and never turns the tab red: nothing is waiting on you.

Only that green **finished** means there is something new to look at. A project at rest reads
a quiet grey **done**, with a grey edge, once you've opened it since its last job ended, and
a project that has never run an agent reads **no agents**. Open the project (or one of its
agents) and the green mark turns into **done**.

Finished and working are easy to spot even past a glance: the **finished** and **N
working** tags are filled with their colour rather than tinted by it, and the Fleet card
and the agent lane carry the same colour as a thin edge down their left side. The
working dot pulses gently, about every two seconds, so a card that's actively running
doesn't look identical to one that's merely alive; it holds still if your system is set to
reduce motion. Every agent that has ended successfully says **finished** in its own lane
and in the Agent screen's header, plainly — not just the job it belongs to.

The same filled look reaches the navigator and the Agent screen's own tabs: an agent's
row in the navigator reads filled **working** or filled **finished**, a job group there
does too, and a done agent's tab on the Agent screen says **finished**. There, an agent's
**finished** is news: it stays until you open that agent (with the tab in front), then
clears, and comes back if the agent finishes again — re-run or continued. Opening its
project doesn't clear it. The green Dot still says it's done afterwards. Agents that
finished before you first ran this version count as seen.

A folder that is its own git repository — a nested clone or a submodule — shows its
branch beside its name, quietly, as **⑂ branch-name** (or **⑂ detached** with no commits
or a detached HEAD), in both the Files tree and the navigator's folder rows.

Opening the project, or one of the job's agents, is seeing it. That only counts while the
tab is in front, so a job that ends while you're in another window still waits for you. On
the Project screen the groups you came to see keep saying **finished** until you leave. A
job you continue that finishes again is new again. What you've seen is kept in Settings, so
it's the same in every browser. Jobs that finished before you first ran this version count
as seen.

### Held vs parked — the one distinction worth knowing

| | |
|---|---|
| **held** | The agent's process is alive, waiting. Its context stays warm. Answering is instant. |
| **parked** | It waited longer than 90 seconds, so its session was written to disk and the process released. Answering resumes it — about 0.7 seconds plus one replayed turn. |

**A question is never parked by the clock.** An agent that asked you something is held
until you answer, however long that is and whether or not a page is open, so your answer
goes straight into the waiting question and it carries on mid-thought. While it waits it
uses no tokens and doesn't take one of the agents-running-at-once slots, so queued work
still starts. Only pausing it, or a daemon restart, puts a question aside; then answering
resumes the agent with your answers, in words, and it carries on rather than asking again.

Two practical consequences:

- **Edit & run only works on held requests.** The mechanism that parks a session
  discards a modified command, so Conductor refuses the edit rather than
  silently running the original. If you want to edit, answer promptly.
- **A parked agent costs nothing and survives a restart.** You can stop the
  daemon with agents blocked, come back tomorrow, and answer then.

If no browser is connected, requests park immediately — there is no point pinning
a process for someone who can't answer.

While a call waits for you, the agent's other calls to the same tool wait with it,
except MCP tools (Lucid, Jira…). Those are turned down with a note to try again once
you've answered, because a parked MCP call can't be picked back up.

The queue ages visibly: a request waiting twelve minutes looks worse than one
waiting forty seconds, and the oldest is always first.

---

## 4. The screens

| Key | Screen | What it's for |
|---|---|---|
| **`1`** | **Fleet** | Everything at once. One card per project, coloured by its unhappiest agent. Glance here. Each agent row on a card has a small meter for its budget, coloured like the status bar's daily budget (below). The card's footer says what the project spent, **today $a · total $b**, kept when its agents are removed. A card says **finished**, in green, when one of its jobs has ended and you haven't opened the project since, and a quiet **done** (or **no agents**) otherwise (see [When a job finishes](#when-a-job-finishes)). **▦ density** in the header fits more cards on screen, until you leave Fleet. **Sort by** in the header orders the cards by **needs you first**, **my order**, **name**, **working** (most agents working now), **recently active**, **spend** (the project's total) or **newest**. Drag a card onto another to put it there, or use **← move earlier** / **→ move later** in its **…** menu; either switches to **my order**, starting from what you see. Your order is kept in Settings, so it's the same in every browser, and a new project goes at the end. **Notes:** each card shows your newest note on the project under its path, and a count (**✎ 3 notes**, or **+ note**) in its footer. Click it to add a note (**⌘⏎** adds), and **⧉ copy**, **✎ edit** or **✕ delete** one; newest first. **⧉** beside the card's note line copies it without opening the project. Copy puts the note's text on the clipboard as written, and needs Conductor open on localhost (or https). A note can be **due**: **due today**, or pick a date, when adding or editing it. Due today is amber, late is red, on the card, its count, and in the list, and the card shows the most urgent due note rather than the newest. A due or late note also shows in **Needs You** (**✓ mark done**, **open project**, or dismiss it for the day). Tick a note's box to mark it done: it stays, greyed, and stops nagging. Notes are yours: agents don't see them, and removing the project forgets them. The same notes, with the same add, copy, edit and delete, are in the Project screen's column and the Agent screen's inspector (that agent's project's). |
| **`2`** | **Project** | The project (and its job's branch) is the label at the top, with what the project spent, **today $a · total $b**, after its state (removing an agent or a job keeps it), on a petrol-blue backdrop of its own, not the Agent screen's wine rose or Fleet's slate blue. One project's agents as lanes, each streaming its recent actions with a meter of its spend against its budget, grouped by job. The meter is green, turns yellow from 75% of the budget and red from 95%, and past 100% it reads red and says **over**, the same colours as the daily budget in the status bar. A job that finished since you last looked says **finished** on its group while you're here. Each job's header has **+ agent**, to add one to that job ([Add an agent to a running job](#add-an-agent-to-a-running-job)). The left column has the project's facts, its notes and its actions: **+ spawn agent**, **▤ open files** and **◈ open preview**. The dock along the bottom can be dragged taller. Its **▸ terminal** tab opens the Terminal dock (below). |
| **`3`** | **Agent** | The project and agent you're on are the label at the top, on its own coloured backdrop (wine rose, where the Project screen's is petrol blue and Fleet's slate blue, deep in the dark theme and pale in the light one, so you can tell them apart at a glance); click it to go back to the project. A tab for every agent in the project across the top, newest job first. A thin bar along the foot of an agent's tab shows how full its budget is, in the same green, yellow and red. A tab turns amber, with a count, when that agent needs you, so a blocked agent isn't hidden behind the one you're reading. The full transcript. Your turns are marked so you can scan a long conversation for what you actually said: what you typed, its **you** label and the bar beside it are violet, a colour no status uses (a turn Conductor sent for you, labelled **auto**, stays plain), and the last thing you asked stays pinned at the top while you scroll. Agent output renders as markdown — headings, tables, lists nested to any depth with their numbering kept, task boxes, quotes, code blocks and diagrams. Every tool call collapses to one line, diffs included — click to expand; any reply folds to one line too, by clicking the agent's name beside it, and **⌃ fold all** in the header folds every reply there is so far. Replies always arrive open, and folds are remembered per agent. A turn Conductor sent, labelled **auto**, folds the same way, by clicking **auto**. In an orchestrator's transcript (an agent that can start helpers) those turns start folded to their first line, its helpers' report among them, so the page opens to the orchestrator's own replies; open one and it stays open, and **⌃ fold all** folds them with the replies. Anywhere else they arrive open, like a reply. A **start_helper** line shows the task the orchestrator gave its helper. Reply, switch interaction mode, set guardrails (allow bash / write / web / MCP tools / git push, and merge into main and clean up when done), change its effort, model or budget, or interrupt, from the bottom panel, which you can drag taller by its top edge. The **▸ agent** header at the start of the row under the message box folds the guardrails and the interaction, effort, model and budget rows away, like any other fold: click it and they close, leaving one line of what they're set to beside it with a small meter for the budget (the line goes yellow from 75% of the budget and red from 95%, and says where the agent stops once it is over; it is red too when the mode is unsafe); click that line to open them again. It applies to every agent. **⏎** sends a reply and **⇧⏎** starts a new line. Past its budget an agent keeps working: the line under the budget says **over today's budget: $27 of $25 - a warning only; stops at $50**, and raising the budget is how an agent that reached its ceiling carries on (or waiting for midnight, when the budget starts again and Conductor continues it). The details panel on the right (**details**, or `i`) shows its usage, with today's spend against the daily budget as a bar (**today $4.10 of $25**; green, yellow from 75%, red from 95%, and a percentage past 100% when it is over), what it spent today beside what it has spent over its whole life as a plain line (**today $4.10 · total $31.40**; in tokens on an engine that reports no dollars), tokens in and out, its todo list, the files it touched and its project's notes. What you type there is kept, per agent, if you switch to the terminal, another agent, another screen or reload the page, until you send it or close the browser tab; Spawn's prompt is kept the same way. Its **›_ terminal** tab is a full terminal in this agent's folder (its worktree): a real shell (the one chosen in Settings, else your `$SHELL`, as a login shell, else bash, else sh) with colour, your keys, tab completion and your shell's own history, so `vim`, `less`, `top`, `ssh`, REPLs and `git add -p` work, and `cd` and `export` last. It runs as you. Opening the tab for the first time opens one terminal; **+** opens another, in tabs, up to 16 live at once, and **×** on a tab closes it and ends the shell and anything running in it. Leaving the tab, switching screens or reloading the page does *not* end a shell: coming back reattaches to it and draws its screen as it is, with the scrollback above it, so a build you started is still going and a `vim` or `htop` you left is drawn as you left it. **⌘F** (**Ctrl-Shift-F** on Ubuntu) finds text in it; **Esc** closes the find bar. A link printed in it opens in a new browser tab, and a file path (`src/app.ts:12:3`, `src/x.tsx(40,7)`, or any path with a `/` in it), if it is inside the worktree, opens in Files at that line. Programs that copy with OSC 52 (`vim`, `tmux`) can write your clipboard, never read it, and the mouse works in programs that use it. A shell ends when you type `exit`, when you close its tab, when its agent, job or project is removed, or when the daemon stops (a daemon restart does not bring shells back). A tab whose shell ended says so, with its exit code, and **↻ new terminal** opens a fresh one. If the terminal library can't load on this machine (or on Windows, which isn't built), the tab shows the old command runner under a banner that says why: **⏎** runs one command at a time with no input, **↑ ↓** go back through what you typed, **■ stop** sends Ctrl-C, and its output is kept until **clear** or a daemon restart. **Waiting on you · answer →**, or **needs you · N** in the header, opens a side panel with everything waiting for this agent (its permission requests, its questions and the alerts that name it), so you can answer without leaving; the amber count on another agent's tab opens that agent with its panel. `i` or ✕ brings the details back. |
| **`4`** | **Needs you** | The attention queue. §3. When a request is in focus its header label (`project / role`) sits on the Agent screen's wine-rose backdrop, so it matches the agent it came from; with nothing to answer, its `needs you` label, like Preview's, Files' and Branches', sits on the same slate-blue backdrop as Fleet's. |
| **`5`** | **Files** | Pick a project and see **its directories and nothing else** — one tree each, plus a job's worktree if you pick a job. Files opens on the project you're in: the one a link named, else the one the route itself names, else the last one you had open anywhere — including the one an agent's screen just showed you, even if you got there by a reload. See [A project's directories](#a-projects-directories). Each tree has badges showing which agent touched what and how recently. Markdown renders properly, so this is where you read `PLAN.md` while it's being written. A ` ```mermaid ` block is drawn as its diagram (flowcharts, sequence diagrams and the rest), with **source** to see the code; one that can't be drawn shows its code and why. Agent replies draw them too. Images open in the pane too — PNG, JPEG, GIF, WebP, AVIF, SVG and favicons, on a checkerboard so transparency reads as transparency. You can edit text in place — if an agent rewrites the file under you, you're told rather than overwritten. Every file you open gets a **tab**, from any job, and each tab keeps its view, scroll position and unsaved edit when you go to another screen and come back. See [Files tabs](#files-tabs). A **`+`** on a folder row, or on a tree's heading, makes a new file there and opens it ready to type in; **+/** beside it makes a folder. See [Making a new file](#making-a-new-file). **✎** and **⌫** on a row rename and delete it. See [Renaming and deleting](#renaming-and-deleting). Drag a row onto a folder, or use **→/** beside it, to move it there. See [Moving a file or folder](#moving-a-file-or-folder). |
| **`6`** | **Preview** | The dev server the agent started, embedded. Device widths for responsive checks, and console errors you can send straight back to the agent as a new instruction instead of copy-pasting. |
| **`7`** | **Branches** | The project's local branches, drawn as a graph: main along the top (or the branch you pick in **compared with** — **automatic** is origin's default branch, else the one checked out when the project was added, else `main`), each branch forking off it with its commits, how far it is ahead of and behind main, its uncommitted files, where it stands against origin, and **live** while an agent works on it. **⟳ Fetch** refreshes origin. Pick a branch and choose where it goes in **merge into**: main to start with, or any other branch, such as main into a job's branch to bring it up to date. The branch it would go into is outlined in the graph, and a line under the picker says how many commits would move, which ones, and whether they would conflict, before you press **Merge N commits** (a merge commit; undo it with `git revert -m 1 <sha>`). Merging into a branch other than main runs in the worktree it is checked out in, so it needs one, with no uncommitted changes and no agent working there; one that would conflict is refused, with the files named. You can also **Commit…** its uncommitted work with your message, or **Push to origin** (confirmed, never forced). **Pull** brings a branch up to its upstream, and **Rebase onto main** replays its commits on top of main; both are confirmed (see [Pull and rebase a branch](#pull-and-rebase-a-branch)). **⇉ Merge all into main** merges every branch that is ahead, oldest first, and stops at the first conflict. A merge runs only when main's checkout has no uncommitted changes, and a conflict is undone with its files listed. Nothing runs on a branch an agent is working on. **Delete** removes a branch that is merged into main, and its folder (see [Delete merged branches](#delete-merged-branches)); **⌫ Clean up merged (n)** does it for every merged branch at once. When the project has more than one repo (an extra directory that is a repo, or one nested in either, as Files shows them), **repo** in the header picks which one the screen shows (see [Branches in another repo](#branches-in-another-repo)). |
| **`8`** | **Metrics** | What the models were used for, in total and for each model: **tokens** (in, out and read from cache), **calls** to the model, **time** (how long a run takes, and where the engine says, how long a model call takes and how fast it writes), **errors**, and **cost**. Choose **Today**, **7 days** or **All**; the last two also list each day. Beside them, pick **All projects** or one project to count only its agents' runs; the choice is remembered. A project's counts start from when per-project counting was added (the screen says the day), so earlier runs are under **All projects** only. Five figures sit across the top, then one row per model (an agent that switched model is split between them, and a model on Copilot or OpenRouter says so beside its name). **Failed** is runs that ended failed out of all runs, and **Retried** is model calls the SDK had to try again out of Claude's calls, since only Claude reports a retry; when Copilot or OpenRouter agents ran too, the Errors figure says "of Claude's calls". Time is model time **per turn, subagents included**: a Claude turn's subagents can run side by side, so it is not the length of one API call. The speed at the top is the average of each model's own. Your own stop, a pause and a budget stop are runs but never failures. Copilot and OpenRouter report tokens and no dollars, so their cost reads **—**, never $0.00; their time per turn is known only when the runtime says. A dash is a number nobody measured, not zero. It keeps counting after you remove a job or an agent, and starts when you first run a version with Metrics: agents that had already spent are listed in one line, **Before metrics were recorded (no per-call data)**, from their own totals, each credited to the model the agent has now (a Claude agent's row holds its last run's tokens only), and an agent from before takes its first run after the update to start counting tokens. **How these are counted** at the bottom of the screen says the rest. |
| | **Spawn** | Start new work. It has no tab or key. Open it with **+ new work** on Fleet or **+** at the top of the navigator, or with **+ spawn agent** on the Project screen, which aims it at that project. |
| **`9`** | **Settings** | **Personas**: what each role is (see below); where Conductor keeps its data; how many agents run at once; how long an agent waits before each try when the model can't be reached (one to five waits in seconds, each from 1 to 1800, default **5, 15, 30, 60, 300**; how many there are is how many tries); a **daily budget** (then the status bar shows today's spend as a bar: green, yellow from 75%, red from 95%, and reaching it is a warning in Needs You, though nothing is stopped; it resets at local midnight); the **ceiling**, the multiple of an agent's daily budget at which it is paused (from 1 to 10, default 2; between the budget and the ceiling it is only warned about); **at midnight, continue agents the day's budget paused** (on by default; off leaves them paused, renewed, until you continue them); what Spawn starts from (preset, model, git branch, interaction mode, the autonomy pills, effort, budget per agent per day); **Allowed always**, the rules you've granted (§10); **Terminal**: the font size (9 to 24, default 13; an open terminal redraws at the new size), the scrollback (1,000 to 100,000 lines, default 5,000) and the shell new terminals run (one of the shells this machine has: `$SHELL` and `/etc/shells`); theme (also switched from the right end of the status bar: system, light, dark); and resetting panel sizes and folds. Every setting is kept in `~/.conductor/settings.json`, so it's the same in every browser. |
| **`0`** | **Diagnostics** | The raw feed. Your first stop when something looks wrong. |

**The Terminal dock**, under every screen, holds the shells of the project you're on (the one the navigator highlights), each started in the project's folder. **Ctrl-`** opens and closes it from anywhere, a terminal included, and so does **▸ terminal** in the status bar; the Project screen's **▸ terminal** tab opens it too. The first time it opens for a project it opens a terminal; **+** opens another, and **×** on a tab ends that shell. Drag its top edge to make it taller; the height is remembered. Closing the dock, or moving to another project, doesn't end a shell: they are the daemon's, and a terminal opened in one browser tab is listed in the others. They end when you close them, when the project is removed, or when the daemon stops. They count toward the 16 live terminals with the Agent screen's.

Across the top of every screen, the tab you're not on reads a little louder than it used
to — darker ink, heavier weight — so the row doesn't fade into the background between
glances. The tab you *are* on stands out further still: its own ink colour, a faint tint
of it washed under the label, and a 3px underline in place of the old 2px hairline.

**The label at the top** (where you are) sits on one of three backdrops: a slate blue on Fleet,
Needs You, Preview, Files and Branches, a petrol blue on the Project screen and a wine rose on the
Agent screen (and on Needs You's label for the request in focus). They are deep in the dark theme
and pale in the light one. The three are well apart in hue, a sixth of the way round the colour
wheel or more, and a little apart in lightness too, so they tell apart without colour vision; the
gap in lightness is small because the label's grey text must stay readable on all three. None of
them is a status colour or your violet. The colours are `--here`, `--here-project` and
`--here-agent` in `packages/shared/src/tokens.css`, and `make test` fails if a change brings two
of them too close.

**The navigator**, the panel down the left of every screen, lists your projects. A
project's name opens its Project screen, and its **▸** opens it to three submenus:

- **Agents**: grouped by job, newest first. Each group is headed by the job's prompt on
  one line, with its agent count, the dot of its unhappiest agent and, in amber, how
  many things in it need you. A job that finished and you haven't seen says **finished**
  there, never in amber. Under it is one row per agent, each with its status dot,
  the ◆ when it is an orchestrator (as on its Agent tab), plus a count when one needs you. A
  click opens the agent, and the navigator stays
  where it is. Groups start open; click a group's heading to close it. A project with
  one job still shows its group. Helpers are listed in their job like any agent.
- **Needs you**: this project's waiting requests and alerts, one row each. The heading
  turns amber, with a count, when anything waits. A click opens that item in Needs you.
- **Files**: the project's folders, its main one first. A folder opens and closes like any
  other row here, and while open shows its directories as a tree — folders first, then
  files, nested as deep as the folder goes. A file's row opens it on the Files screen; the
  navigator stays where it is. A folder, and each folder in it, has a **+** when you point at
  it or tab to it: it opens the Files tree's new-file box in place, and the file it makes opens
  on the Files screen ready to type in. A file or folder inside it has **✎** and **⌫** too, with
  **F2** and **Delete** on a focused row: they open the Files tree's own rename box and delete
  question, in place, and open tabs follow as they do on Files. The folder itself has neither.
  Nothing here marks a changed file; for that, open the folder
  on Files itself.

Every project, submenu and job group opens and closes on its own, and what's open is
remembered.
Projects are listed in the Fleet's **Sort by** order and follow it when it changes.
Dragging a project onto another in the navigator moves it there and switches the sort
to **my order**, as dragging a Fleet card does; dropping below the last project puts it
last.
**+** at the top adds a project: it opens Fleet's add-a-project form. To start work in a
project, use **+ spawn agent** on its Project screen. The icon at the far left of the top bar hides or
shows the navigator. On the Agent screen, an icon at the far right does the same for
the details panel (the same as **details** or `i`). A Fleet card always opens its
Project screen, whose left column shows that project's details, notes and actions. The
amber bar across the top still lights up from any screen.

Side panels and docks can be dragged to size by their edge: the navigator, the Project
screen's column and bottom dock, the Agent inspector and composer, the Needs you
queue, the Files tree and the Preview console. Arrow keys move a focused edge, and
double-clicking one puts that panel back to its usual size. Sizes are remembered in
this browser, and a panel sized on a big monitor shrinks to fit a smaller window,
then comes back when you do.

### Files tabs

Clicking a file in the tree, or a file name in an agent's transcript, opens it in a
tab. The tabs sit above the pane, and they can come from different jobs. A tab from
another job shows that job's name beside the file name. Two open files with the same
name show their folder too.

- **Switch** by clicking a tab, or with the arrow keys, `Home` and `End` once one has
  focus.
- **Close** with the tab's **`×`**, a middle-click, or `Delete`. The tab you were
  on before takes its place.
- **⑂ review full diff** opens every change in the job's worktree as a tab of its
  own. Press it again to close that tab.

Each tab remembers its view (rendered, raw or diff), where you'd scrolled to, and an
edit you haven't saved. You keep all of that when you go to another screen and come
back. The tabs, views and scroll positions also survive a reload. **Unsaved edits don't**:
reloading with one pending brings up the browser's "leave site?" prompt. A tab with
unsaved work shows **●**. Closing it asks first, and the file on disk is not touched
either way.

**Links in a rendered file open the file they point to**, in a tab, the way they
would on GitHub. `../Service-Mesh/notes.md` is relative to the file you're reading, and
`/README.md` is the repo root. If the file's own folder has no such file but the repo
root does, the root's is opened, because agents often write links that way. A
`#section` link scrolls to that heading. Cmd-click opens the link in a new browser tab.
Links to the web open in a new browser tab as usual. A link that leads out of the
worktree isn't a link. Images next to the file show up too.

A rendered file **fills the pane**, so wide tables and code blocks have room. If
long lines are hard to read on a wide screen, **¶ column** keeps it to a reading
column; that choice is remembered for every file in this browser. **⎙ PDF** prints the
rendered file on its own, on white, whichever theme you're in. Pick **Save as PDF**
in the print dialog to get a file named after the one you're reading.

A file an agent **deleted** stays in the tree with a **deleted** badge, because git
still has it. Opening it shows git's last copy, read-only, under a banner saying so.
A tab whose file can't be opened any more says why and offers **retry** and **close
tab**. It doesn't blank out.

### Making a new file

Every folder row in the Files tree has a **`+`** at its right, which shows when you
point at the row or tab to it. Each tree's heading has one too, for the top of that
tree. The folders in the navigator have the same **+**. It opens a box under the row with the folder already in the name and the file
name selected (`docs/notes/untitled.md`), so typing replaces `untitled.md` and keeps
the folder.

- **Enter** makes the file, **Esc** (or the **✕**) puts the box away.
- **Any name works**, `.md`, `.txt`, `Makefile` or nothing at all after the dot. A name
  with folders in it, such as `docs/notes/x.md`, makes the folders.
- **A name that is taken is refused**, whether it is a file, a folder or a link, with
  "… already exists" under the box. Nothing is replaced, so you can't empty a file by
  asking for it again. Change the name and press Enter. The same goes for `..`, an
  absolute path and anything under `.git`, which are never written.
- **It opens ready to type.** The new file opens in a tab with the editor already on it
  and the cursor in it; **⌘S** saves, and **Esc** stops editing, leaving the file empty.
  Until you type, nothing is unsaved. An empty file shows "This file is empty" rather than a blank pane.

It works in a job's worktree too, including while an agent is running there: the file
is yours, not the agent's, like any edit you make. In a project's own folders the tree
is read again for you, since Conductor doesn't watch those.

**+/**, beside the **+**, makes a folder the same way: the box starts at `new-folder` in the
folder you asked from, a name ending in `/` is fine, and folders above it are made too. A name
that is taken is refused. The new folder opens in the tree, empty, ready for a **+**.
An empty folder shows in the tree when git would call it untracked; one your `.gitignore`
excludes, and anything under it, does not, as `git status --ignored` has it. In a folder with no git,
every empty folder shows.

### Renaming and deleting

Every row in the Files tree, file or folder, has **✎** (rename) and **⌫** (delete) beside it,
shown when you point at the row or tab to it. On a focused row, **F2** renames and **Delete**
(or **⌘⌫**) deletes.

- **Rename** opens the name box in the row's place with the whole path in it and the name
  selected (a file's without its extension), so typing renames it and a different folder in the
  path moves it there. **Enter** renames, **Esc** leaves it as it was. A name that is taken is
  refused, except the same name in another case (`readme.md` → `README.md`), which is a rename.
  A folder can't be moved into itself. Open tabs follow: a tab on the file, or on anything in the
  folder, is now on the new path, with its view, scroll and any unsaved edit.
- **Delete** asks first, under the row. A file: one question naming it, and whether git has it
  (git keeps its last commit; a file git doesn't have is gone for good). An empty folder: one
  question. A folder with files in it: first **Delete notes/ and the 12 files in it?**, then
  **Are you sure? 12 files go with notes/**; only the second yes deletes. The count is of what is
  on disk, ignored files and `node_modules` included, so it can be more than the tree shows.
  **keep it** (or **Esc**) is the default. A folder with a git repository inside is never
  deleted from here. Open tabs on what was deleted close; an unsaved edit in one is named in the
  question first.

A file git has stays in the tree after you delete it, with a **deleted** badge, as one an agent
deleted does. Nothing outside the tree's folder, and nothing under `.git`, can be renamed or
deleted, and neither can the tree's own folder.

### Moving a file or folder

Drag a row in the Files tree onto a folder row to move it into that folder, or onto the tree's
heading to move it to the top. The row you drag fades and the folder it would land in is marked; a
file row takes nothing. Without a mouse, **→/** beside **✎** opens the name box in the row's place
with the folder it is in already filled in and selected: type another folder (empty is the top)
and press **Enter**, or **Esc** to leave it.

A move is a rename, so the same rules hold: a folder can't go into itself or anything in it, and a
name already taken in the target folder is refused, with the reason under that folder. Dropping it
on the folder it is already in, or choosing that folder, does nothing. Open tabs follow the move
with their view, scroll and any unsaved edit, and the target folder opens to show it. Moving isn't
offered in the navigator; open the folder on Files.

### A project's directories

A project can have **more than one folder**. The **main** folder is its path: jobs start
there, and worktrees are cut from it. The others are **referenced** folders that its agents
may also read and edit, and they're the only other ones the Files screen shows. To see a
folder on Files, add it to the project; nothing else is listed.

Give a project its referenced folders when you add it, or later: **`1`** → the **`…`**
on the project's card → **`▤ folders…`**:

- The main folder is at the top, marked **main · agents work here**. To change it, use
  **✎ edit project**.
- **add a referenced folder** takes a path, with completion as you type. `~` is your home
  folder. Adding one the project already has just says so.
- **✕** beside a directory, then **forget it**, removes it **from Conductor only**.
  The folder and everything in it stay where they are; Conductor stops showing it and
  agents stop being given it.

**What agents get.** An agent still works in its job's worktree, or in place in the
main folder, exactly as before. From its next run it can also reach the project's
referenced folders, and **edits them in place**: they are not worktrees, so there's no
branch to review and nothing to merge. A directory that has gone missing is left
out, and the run goes ahead without it.

**On Files (`5`)**, the column starts with a **Project** picker. It opens on the project
you were last looking at, on the Project screen or in an agent. A folder under **Files**
in the navigator opens Files on that folder. Choosing another project in the picker makes
it the one `2` opens on.
A link from a transcript opens its own job's files instead. Below the picker you get one
tree per directory, each with its own changed-file count. **↻** re-reads a directory,
since Conductor watches only job worktrees, not these. Picking a **job** as well adds
its worktree at the top of the list, marked **◉ watching**. If the job runs in place in
the first directory, that tree is the job's. Tabs from different directories sit side
by side like tabs from different jobs, and **⑂ review full diff** is for whichever
tree your open file is in. A folder inside a larger git repository shows only its own
changes. A nested repo inside a folder — a clone someone checked in, or a submodule — opens the same
way, all the way down, with its own folder marked by its branch. Its changes show as its
own, four levels deep (Amendment 158): a file changed inside it is badged at its own path, its
folder adds up its files' lines, and the file's diff is the nested repo's diff of it. A nested
repo with nothing changed shows no badge at all.

### Editing or removing a project

**Removing** is in two places, Spawn and Fleet, because either is somewhere you
might notice the list is wrong:

- **Spawn** → section **`2 · where`** → the **`×`** on the row. For a path you just
  mistyped, without leaving the screen you're setting up.
- **`1`** → the **`…`** on the project's card → **⌫ remove project**. For a project
  you're finished with.

The navigator lists projects too, but has no remove.

**Editing** is on the Fleet card only: **`1`** → **`…`** → **`✎ edit project`**.

It changes the name and the path. The name is cosmetic. The path is
not — it is what worktrees were cut relative to, so changing it moves nothing:
existing worktrees, transcripts and job records keep pointing at the old directory,
and only new work uses the new one. The panel says so, in amber, whenever the project
already has jobs. Two paths are refused: one that doesn't exist, and one another
project already holds.

Removing asks first either way, and the question tells you what it's about to forget:
the jobs, the agents and the recorded spend.

Adding a folder you already have registered does **not** create a second project — it
selects the one that already points there, and says so.

It removes the project **from Conductor only**. Nothing is deleted from your
machine:

- your files are untouched — Conductor never had a copy of them;
- worktrees under `<repo>/.conductor/wt/` stay exactly where they are;
- every branch an agent made still exists, commits and all.

What goes is the bookkeeping: the project, its jobs and agents, their transcripts,
any pending requests, the change badges and the dev-server registration. That part
is not recoverable — add the folder again and you get a clean project with no
history, not the old one back. The worktrees and branches are still on disk, so
finished work is still there to merge; what you've lost is Conductor's record of
who did it.

Two things it deliberately keeps: the append-only event log, and the day's spend
total. A removal isn't a refund, and the daily budget shouldn't reset because you tidied
up. (An agent's own spend today goes with the agent: a removed agent has no budget left. Its
project's spend, today and in total, keeps what it spent, and so does the status bar's total.)

If any agent in the project is still running, the removal is **refused** and names
the ones in the way. Interrupt them on the Agent screen first — Conductor won't
kill work in flight on a button labelled "remove".

### Delete merged branches

On the Branches screen (`7`), select a branch and press **Delete**, or press
**⌫ Clean up merged (n)** in the head to do every merged branch at once. Either asks
first, naming each branch, its folder and its job. A branch goes with its folder:
`git worktree remove` (never forced), then `git branch -d` (never `-D`). Origin is never
touched: a branch you pushed stays there.

**Delete** is greyed, with the reason beside it, when the branch:

- is main (the branch everything is compared with), or is checked out in the project's
  own folder;
- isn't merged into main: it has commits main doesn't, or it has commits its upstream on
  origin doesn't (`git branch -d` checks against that; push it first);
- has uncommitted files in its folder, untracked ones included;
- has an agent working, blocked or queued on it;
- belongs to a job. **A finished agent can still be messaged, and it needs its folder
  then**, so a job's branch stays unless you tick **forget its job too (its transcripts
  stay)**. Ticked, the job is removed first, as **✕** on the Project screen removes it:
  its agents can't be messaged afterwards, and their transcripts and spend stay in the
  history.

**Clean up merged** tries every merged branch, oldest first, one at a time, with the same
checkbox for the jobs. The ones it can't remove stay, and the result lists each with the
reason.

### Pull and rebase a branch

On the Branches screen (`7`), select a branch. Both run in the branch's own checkout, so it
must be checked out somewhere, with no tracked changes and no agent working on it. Each asks
first.

**Pull** is offered when the branch has an upstream. It fetches that remote (never pruning),
then fast-forwards the branch to it: never a merge commit, never forced. It is refused when
there is nothing to pull, and when the branch has diverged from its upstream (each has commits
the other lacks): the reason says **diverged — merge or rebase**, and you choose.

**Rebase onto main** replays the branch's commits on top of main, rewriting them. It is
refused when the branch already has everything on main, or shares no history with it. On a
conflict the rebase is undone, so the branch and its folder are as they were, and the files
are listed, as a merge's are.

**A pushed branch can be rebased, but Conductor won't push it afterwards.** Its commits on
origin are the old ones, so the next push needs a force, which Conductor never does. The
confirm says so before you rebase: "this branch is pushed; after rebasing, the next push needs
a force, which Conductor never does — you'd do it yourself". After the rebase, **Push to
origin** is greyed with the same sentence. To publish it, push it yourself in a terminal.
Conductor keeps this in memory, so after a restart Push is
offered again and origin's rejection is what you see.

### Branches in another repo

A project can hold more than one repo: an extra directory that is a repo, or a repo nested
inside the project's folder or an extra directory (up to four levels down), the ones Files
marks with their branch. When it does, the Branches header has a **repo** picker. It starts on
the project's own folder each time you open the project, and lists the others by where they
are, such as `myapp/vendor/lib`.

Picking one shows that repo's branches, and every action (merge, commit, push, pull, rebase,
fetch, delete, clean up) runs in that repo only, against its own origin. Two repos can have a
branch of the same name; they are separate. Another repo is always drawn against its origin's
default branch, else the branch it has checked out, else `main` or `master`: **compared with**
and **Make default** are only for the project's own folder. Jobs are only in the project's own
folder, so no branch in another repo belongs to a job. The branch it has checked out is **live**
while an agent that can reach the repo is working, and nothing runs on it then. Every agent can
reach the project's extra directories, so for a repo in one of those any working agent counts;
for a repo nested in the project's own folder, an agent working in that folder (in place or on a
branch of its own) does, and one in a worktree of its own doesn't.

---

## 5. How much rope to give an agent

Set per job, at launch — and changeable per agent afterwards, from the **interaction**
row at the bottom of the Agent screen (`3`). All six modes are selectable there; Spawn
offers five, without **don't ask**. The names below are the Agent screen's; Spawn calls
**plan only** "plan first".

| Mode | Behaviour |
|---|---|
| **plan only** | Explores and proposes, never edits. Good for "tell me what you'd do". |
| **ask me** | Asks before anything that needs approval. |
| **auto-accept edits** *(usual choice)* | File edits inside the worktree go through; shell commands still ask. |
| **don't ask** | Anything that would prompt is denied instead. A fixed, predictable tool surface. |
| **auto** | A model classifier answers the permission prompts in your place. |
| **⚠ bypass** | Approves nearly everything, and nothing reaches Needs you. Only in a throwaway worktree you don't mind losing. |

Two things hold regardless of mode:

- **`disallowedTools` survives every mode**, including bypass. It's the real
  safety net — put genuinely destructive patterns there, not in a softer setting.
  The Guardrails panel on the Agent screen distinguishes a rule that names a whole tool
  (`Bash` → **denied**) from one that names a command within it (`Bash(git push:*)` →
  **asks · 1 denied rule**). A tool missing from the allow-list *asks*; it is not denied.
  The SDK removes those tools from the agent's context entirely, so a read-only
  role stays unable to edit files even if you switch it to bypass. It *can* run
  shell unattended in that mode, which is the part worth thinking about.
- An agent's questions to you are never answered for you. Conductor adds no other
  "always ask" rule: don't count on any mode to stop before a destructive command.
  What must never happen belongs in `disallowedTools`, which no mode overrides.

Changing autonomy on a running agent takes effect on its **next** run, not
mid-flight — the permission mode is fixed for the life of one query. The Agent screen
says so under the mode row while an agent is working.

---

## 6. Money

Each agent is a live Claude Code session billed at normal API rates. Several at
once adds up quickly.

- **Set a budget per agent** in Spawn: **⏱ budget per agent per day $**, $25 by default.
  It is **per day**: it counts what the agent spends *today* (your machine's local day) and
  goes back to zero at midnight, whatever the agent spent yesterday. It used to be a
  lifetime figure, across all the agent's runs; it is not now. The job's budget is the
  sum of its agents' budgets, counted the same way. **It warns; it doesn't stop.** Past its
  budget an agent keeps working, the composer says **over today's budget: $27 of $25 - a
  warning only; stops at $50**, and Needs You raises an **Over its daily budget** card with
  **+$10** and **+$25**. What stops a runaway agent is a ceiling at **twice the budget** (Settings (9)
  sets the multiple, from 1 to 10): an
  agent that reaches it is **paused**, not failed, and Needs You then offers **+$10 and
  continue** or **+$25 and continue**, or you can raise it in the agent's composer. Raising
  the budget raises the ceiling with it. A budget in tokens works the same way (the ceiling
  is the same multiple of the tokens). Claude's spend is known when a turn ends, so the warning for a Claude
  agent arrives with the turn that crossed the budget; the ceiling still stops it in the
  middle of a turn.
- **At midnight the budgets start again, and what only the budget paused carries on.** An
  agent that is over its budget is under it again, and its warning goes. An agent that was
  paused at the ceiling, or held for its job's budget, is continued as ▶ resume would, and its
  transcript says a new day's budget began; it waits for a slot like any queued agent, and
  while everything is paused until a time it waits for that. A pause you made, or any other, is
  left. If Conductor was not running at midnight, it does this when it starts. To have them
  wait for you instead, turn off **at midnight, continue agents the day's budget paused** in
  Settings (9): then the pause and its Needs You card say the budget is **renewed for the new
  day**, and **continue** (or a message) carries it on with no raise. Every open page redraws its bars at zero
  without a reload. A run that is going when midnight passes is counted on the day its
  result arrives, and keeps the limit it started with.
- **Settings (9) has the three.** Under **Agents**: *when the model can't be reached, wait before
  each try* (seconds, commas between; one to five waits, each from 1 to 1800; default
  `5, 15, 30, 60, 300`). Under **Spend**: *an agent stops at its daily budget times* (from 1 to 10,
  default 2; 1 stops it at the budget itself), and *at midnight, continue agents the day's budget
  paused*, **on** or **off** (on by default). A field says what is wrong as you type and is kept on
  Enter or when you leave it; **Esc** puts it back. Each applies at once, to every agent.
- **The details panel shows both figures.** The bar says **today $4.10 of $25**, which is
  what the budget counts; **spent today $4.10 · total $31.40** under *Agent* is today's beside
  everything the agent has spent, for information. Its lane on Project and the composer's budget
  line show the same pair; an engine that reports no dollars shows both in tokens. Agents that existed before daily budgets have nothing recorded for
  today, so a budget they had reached is renewed the first time they start.
- **Every budget fills in the same colours as the daily one.** Green while there's room,
  yellow from 75% of the budget, red from 95%, and from 100% it reads red and says **over**.
  You see it in the details panel's bar, the composer's budget line and its folded summary,
  the agent's tab, its lane on Project and its row on a Fleet card. A budget in tokens colours
  the same way.
- **A job's budget works the same way.** When the job passes the sum of its agents' budgets
  today, Needs You warns, and agents still to start go ahead. At the ceiling times the sum
  they are held (**job budget reached**) until you raise a budget, or until the next day,
  when they are continued (unless that setting is off).
- **The daily budget in Settings** (the status bar's meter) is a different, warn-only figure: the whole
  machine's spend today. It also starts again at midnight.
- **Today's spend is in the status bar**, and in `make status`. It counts dollars only, so
  Copilot and OpenRouter agents, capped in tokens (§2, "Choose the engine"), add nothing
  to it. After it the status bar shows **· $X total**: everything every agent has spent since
  Conductor started counting, kept when agents, jobs or projects are removed.
- **Each project shows today $a · total $b**, on its Fleet card and in the Project screen's
  header and column. Its total keeps what removed agents and jobs spent (from before this, it
  counts only the agents the project still had). An engine that reports no dollars adds its
  tokens beside the dollars.
- **Metrics** (`8`) adds spend up by model, with tokens, calls, time and errors, for
  today, 7 days or all of it, for every project or one, and keeps it after a job or agent is
  removed. Copilot and
  OpenRouter show tokens there, not dollars.
- **Parked agents cost nothing.** Blocked work isn't burning anything.
- **Settings** (`9`) → **agents running at once** (default 7, up to 32) caps concurrent
  *live* agents, and extra ones queue. It applies at once: raising it starts queued agents,
  and lowering it stops nobody, so nothing new starts until fewer than the limit are
  running. `CONDUCTOR_SLOTS` sets the default when Settings hasn't. A message sent to a
  finished agent restarts it straight away when a slot is free. When every slot is taken it
  **waits for a slot**: the agent reads *queued*, the composer says *Waiting for a slot: it
  goes when one frees*, and the message sits above the box as **⏲ waiting for a slot**, where
  ✕ cancels it and the agent goes back to what it was. It is kept in the database, so it
  survives a restart, and it goes, word for word, in the agent's own session, as soon as a slot
  frees, ahead of the agent's other waiting messages. Several go one per turn, oldest first.
  A message due at its time, and the ask to hand off when an agent ends without `hand_off`,
  wait the same way.
  Parked agents don't occupy a slot, and nor does an agent waiting on a question it asked
  you. When you answer, it counts again, so for a moment more may run than the limit.
- Cheaper models for mechanical roles is the easiest saving — validators and
  scribes rarely need the strongest model.

To look around without spending anything:

```bash
make fixture     # a recorded job, plus an agent on OpenRouter
make fixture FIXTURE=session-basic   # the two-agent job alone
make attention   # the attention queue, with a parked request and a question
```

Both replay through the same machinery as live data, so what you see is real
behaviour.

---

## 7. When things go wrong

**Start here:** `make status`. It reports the daemon, the web app, and the fleet —
jobs, agents by status, who's blocked and for how long, slots, spend. Its `build`
line gives the commit the daemon is running, when that commit was made, and when the
daemon started.

**Which code is running.** The right end of the status bar shows it as
`branch@commit`, with a `*` when the daemon started with uncommitted changes. Hover
over it for the commit date and the start time. **Diagnostics** (`0`) → **Build**
shows the same, plus the Node version. The web app reloads itself when files change;
the daemon doesn't. So after you pull or commit, the daemon keeps running the code it
started with. Conductor checks for this every minute and turns the tag amber with a
`⚠`. `make restart` fixes it.

| Symptom | Cause |
|---|---|
| An agent fails with a 400 about its model, or the composer says the API **no longer serves** it | The model was retired. Pick another in the agent's composer; it applies from the next reply. Agents from before exact ids may show a **nickname** warning. They still run, on whatever your settings say the nickname means. |
| The model list says **not checked against the model API** | Conductor couldn't read a credential or reach `ANTHROPIC_BASE_URL/v1/models`; the note says which. A Claude.ai login isn't a credential Conductor can use for this. The list shown is Claude Code's. |
| Browser won't connect | Use `http://localhost:5173`, **not** `127.0.0.1:5173`. Vite binds IPv6 loopback only; the IPv4 address refuses and looks exactly like a crash. |
| `make start` says **Dependencies are out of date**, or the browser shows Vite's **Failed to resolve import** overlay | A pull changed `pnpm-lock.yaml` and `node_modules` is still the old install. `make start` and `make restart` check this first and start nothing, so a running app is left as it was. Run `make install` (or `pnpm install`), then `make start`. `CONDUCTOR_AUTO_INSTALL=1 make start` installs by itself instead (`pnpm install --frozen-lockfile --prefer-offline`). |
| Screens blank, feed says reconnecting | Daemon is down. `make start`. The browser holds its cursor and replays the gap, so you lose nothing. |
| `not a git repository` on launch | **New branch:** and **new branch per launch** need a git repo — they create a branch, so there is no way round it. Use the first pill, `⚠ default branch`, which doesn't, or `git init` the directory. |
| A launch on **new branch:** is refused (409) | The branch you named is the project's default branch, or is checked out already (the message says where: another job's worktree, a worktree of yours, or the project's folder). Name another branch, or finish the work where it is checked out. |
| The terminal tab shows a banner and a command runner | The terminal library (`@lydell/node-pty`, a native module) didn't load; the banner says why. Run `pnpm install` again without `--no-optional`, and not on a `node_modules` copied from another machine, then `make restart`. |
| The terminal says **16 terminals are open already** | That's the most live shells at once, the Agent screen's and the Terminal dock's together. Close a tab you're done with (× ends its shell). |
| Port already in use | `make stop` clears both ports, including children orphaned by a hard kill. |
| The dock icon says **Conductor didn't start** | It tried `make start` through your login shell, then again on the PATH recorded at install, and nothing answered. What `make start` said is in `.conductor/run/dock.log`. Run `make start` in a terminal to see it live. |
| The dock icon says **Conductor moved** | The icon points into the checkout it was installed from. Run `make dock` from where the checkout is now. |
| No dock icon on Linux | Pinning is GNOME's (stock Ubuntu). Elsewhere Conductor is in the app menu — pin it from there. `make dock` puts it back if it was removed. |
| An agent **was waiting on a tool that is no longer there** (`tool_deferred_unavailable`) | It resumed onto a call to an MCP tool (Lucid, Jira…) before that server had reconnected, and the SDK won't run it. Conductor now moves the session past the lost call and carries on, telling the agent what the call was and what you decided. You'll see that note as an `auto` turn. If it can't, the failure says it could not be moved past the call. An agent that failed this way earlier recovers the same way: send it a message. |
| A fix you just made isn't there | The status bar's build tag is amber: the daemon is still on the commit it started from. `make restart`. |
| An agent seems stuck | Check its sparkline. Flat means no tool calls — it may be thinking, or wedged. Open the Agent screen and read the tail; interrupt and redirect if needed. |
| A decision didn't take | The card stays up saying the agent isn't unblocked yet until the daemon confirms. If it reports a failure, the agent really is still blocked. Conductor won't pretend otherwise. |
| Numbers disagree between screens | Worth reporting. Every serious bug found while building this was caught exactly this way. |
| Can't remove a project | An agent in it is still running. The refusal names it — interrupt it on the Agent screen, then remove. |
| Can't change a project's path | Either the directory doesn't exist, or another project already points at it. The refusal says which. |
| An agent says **lost its folder: it was deleted** | Its job's worktree was removed, by `git worktree remove`, a clean-up or by hand, while the agent could still be resumed. Nothing is started there. In Needs You, **recreate folder and continue** puts the worktree back at the same path: on its branch with what was committed there, or, when the branch was deleted too, on a new branch of that name from the branch the Branches screen compares with. Then the agent carries on in its own session, told that uncommitted work is gone. A job working in a folder of its own (branch or in place isolation) can't be recreated: put the folder back. If its branch is checked out somewhere else by then, recreating is refused and the message says where: remove that worktree or check out another branch there, then recreate. |
| Removed a project by mistake | The files, worktrees and branches are all still there (§4). Add the folder again; you get a fresh project, and the old transcripts and spend history are gone for good. |
| **Delete** on the Branches screen is greyed | The reason is beside it: the branch isn't merged into main (merge it first), has uncommitted files (commit or discard them), has an agent on it (wait), is checked out in the project's folder (switch it), or belongs to a job, whose agents may still be messaged and need its folder. Tick **forget its job too** only when you are done with that job. |

**When the model can't be reached.** Claude Code retries a model call by itself first. If it
gives up and the run ends because of the model API, and not because of anything the agent did,
Conductor waits and tries again, up to five times, **5 s, 15 s, 30 s, 60 s and 5 min** after
each failure (Settings (9) sets the waits, one to five of them, so how many tries too), resuming
the agent in its own session. That covers no network, a busy or
throttled API, and server errors. It does not cover a refused login or a billing problem (those
need you, and show as before), a budget stop, an agent you paused or stopped, or an error the
model would give the same way every time, such as a prompt that is too long. It is the same for
Claude, GitHub Copilot and OpenRouter agents.

- While it waits the agent is **queued**: the Agent screen shows *Reconnecting in 30 s (3 of 5)*
  above the transcript with **retry now** and **stop retrying**, and Fleet and the Project
  screen's lines say *reconnecting in 30 s (3 of 5)*. From the first try Needs You has the same
  card, and it chimes like any alert, once for the whole wait.
- It **gives up its slot** while it waits, so something else can run, and takes one again when
  its time comes. If every slot is taken then, it waits for one like any queued agent.
- Its **job stays working**. A failed agent fails its job; a waiting one does not.
- When it tries again it is told the model couldn't be reached, that a tool call that was
  running was stopped, and that anything it had running in the background is gone.
- Any **real reply from the model** starts the count again: the next failure waits the first
  delay (5 s by default). An
  error message that the SDK writes in the model's place is not a reply. What a retry spends
  counts against the agent's budget like any run.
- After the last try fails (the fifth, by default), the agent is **failed**, as it always was, and
  Needs You says so. **stop retrying** does the same at once. Continuing a failed agent gives it
  its tries again.
- **Retries do not survive a restart.** The daemon forgets the waits, and an agent that was
  waiting resumes on its own like one the restart interrupted, with all its tries again.

**Stopping an agent**, in increasing order of finality, all on the Agent screen (`3`):

| | |
|---|---|
| **⎋ interrupt** | Stops the current run. The agent stays and can be redirected. |
| **⏸ pause** | Puts it to sleep: frees its slot and keeps its conversation. **▶ resume** wakes it in the same session, once a slot is free. |
| **✕ terminate** | Ends it for good. Confirms first, and is not undoable. |

**Pausing is sleeping.** A paused agent holds no slot and costs nothing, and it keeps
its transcript and its SDK session for as long as you like, across daemon restarts.
When you wake it, it is told it was paused. A tool call that was running when you
paused is stopped, and its transcript shows **stopped before it finished**, so the
agent is told to check what that call did. If the agent was waiting on your answer,
pausing keeps the question in Needs You, and answering it wakes the agent. If its job
was paused, waking the agent reopens the job.

**Pausing everything until a time.** **⏸ pause all…** in the status bar, on every screen,
asks for a date and time in your own time zone, with **1 h** and **tomorrow 09:00** as
quick picks. From then until that time:

- every working agent is paused, as **⏸ pause** pauses it: its conversation is kept and its
  slot freed, and its transcript says *paused with everything until the scheduled time*;
- nothing starts by itself: queued agents, new jobs you start, and agents you **▶ resume**
  wait in the queue;
- an agent waiting on your answer keeps its question, and a message you send still goes
  through, because those are you acting (with every slot taken, it waits for a slot first);
- a message scheduled for that time waits too.

The status bar reads **⏸ all paused until <time> · in 3 h**, and **▶ resume now** ends it
early. At the time, the agents the pause paused carry on in their own sessions, and the
queue starts. One you paused yourself stays paused. If the daemon was off when the time
came, it does this when it starts. The time is kept in `settings.json`, so it survives a
restart, and is removed once it has passed.

**Sending a message later.** Type the message, then press **⏲ later** beside **send**. Pick
a date and time (your time zone, with **in 1 h** and **tomorrow 09:00**), and press
**schedule**. It waits above the message box as **⏲ tomorrow 09:00 EDT · in 13 h** and its
first line, with ✕ to cancel it. At its time it goes to the agent exactly as if you had
pressed send then: into a run that is going, or waking an agent that had finished. It is
then in the transcript, and gone from the list. It goes out at most a few seconds late,
and if the daemon was off at its time, as soon as it starts. An agent that hasn't started
yet gets it once it has. One that can't take it (it has reached its budget's ceiling, say) shows
**couldn't send** with the reason, in red, until you clear it; it isn't tried again.
Removing the agent removes its scheduled messages.

**Sending a message when it is done.** **⏲ later** waits for a time; **⏲ when done**, beside
it, waits for the agent. Type the message and press it while the agent is working: the
message goes, as if you had pressed send, when this turn ends **done**. Done means its turn,
not its whole job. A question it stops to ask you doesn't count, and it keeps waiting through a
turn that **failed** or a pause, yours or everything's, until a later turn ends done. Queue
several and they go one per turn, in order, each once the agent is done with the one before. They
wait in the same list above the message box as **⏲ when done**, with what each is waiting on
(*when this turn ends*, *waiting: it failed…*, *after the one before it*) and ✕ to cancel. They
survive a restart, and go at the agent's next turn that ends done. The button is off for an agent
that is already done or was stopped, since no turn of its would end: send the message now
instead.

A terminated agent reads **stopped** — not "finished", which would claim it had. Its
transcript and spend stay, and nothing on disk is touched: the worktree, the branch and
every file it wrote are exactly where they were. To stop a whole job at once, use
**✕ terminate** on that job's header on the Project screen (`2`).

**The agents waiting on one you stop are paused, not left waiting.** Stop the architect
of a full pipeline and the developer, which waited for it, goes **paused** with the note
*waits for architect, which was stopped — resume to run without it, or remove it*. Nothing
starts by itself, so nothing is spent until you choose. The agents further down
(validator, reviewer, scribe) still wait on the developer. Then you can:

- **resume** the developer. It runs without the architect, and its first prompt still
  includes what the architect wrote last, marked *stopped, so it may not have finished
  its part*.
- **remove** the architect. The developer then waits on whatever the architect waited on
  (nothing, here), and starts.

Nothing in the job can go on by itself until you choose, so the job counts as finished
meanwhile. Resuming opens it again. An agent waiting on one that **failed** stays queued
instead: continue the failed one, and the waiting one starts once it is done.

**Remove from stack** is in terminate's confirm: it stops the agent and takes it out of its
job in one go. A banner under the header says what that does to the rest of the job, such as
*scribe will wait for architect instead*.

**Terminate stops it; remove clears it away.** Once an agent has ended, the same button
becomes **✕ remove** — that deletes the agent and its transcript from Conductor so it
leaves the screen. Removing also takes it out of the stack. Each agent that waited on it
and hasn't started waits on what it waited on instead. With architect → developer →
scribe, removing the developer makes the scribe wait for the architect, and hear the
architect's last reply. Agents that have already started are left as they are. On the Project screen, a job whose agents have all ended offers
**✕ remove** on its header, which takes the job and every agent in it.

Removal never touches your files, and it keeps two things on purpose: the event log, so
the history stays honest, and the day's spend, because the money was spent.

**Interrupting** is safe — press the interrupt button on the Agent screen, then
tell it something different. Streaming input means you can redirect mid-task
without discarding the session.

**Restarting the daemon** is safe, and so is rebooting. Everything Conductor knows lives in
one folder, `~/.conductor/`:

- `conductor.db` holds projects, jobs, agents, every transcript, open requests, your
  "allow always" rules and the day's spend.
- `settings.json` holds theme, panel sizes, folds, open Files tabs and notification
  choices, the same in every browser.

Quit it, reboot, come back tomorrow — it is all there.

**The first start asks first.** Conductor writes nothing under your home folder until you
allow it. On the first start the page asks **Where should Conductor keep its data?**:

- **Allow** creates `~/.conductor/`, readable only by you.
- **Not now** runs in memory. Nothing is saved, a line on every screen says so, and the
  next start asks again. Its **save to ~/.conductor** button copies the session there for
  the next start to open.

If there's an older database in `packages/daemon/conductor.db`, from before this folder
existed, the question offers **Bring my history** (ticked) and says how many projects and
agents it holds. It's copied into `~/.conductor/`, projects, chats and agent sessions
included. The old file is read, never changed, and left where it is. Untick it to start
empty. `CONDUCTOR_DATA` moves the folder. `CONDUCTOR_DB` names a
database directly and skips the question.

**Removing keeps the record; cleanup clears it.** Removing a project, job or agent
keeps its events in the database, even though no screen can show them any more.
**Diagnostics** (`0`) → **Storage** shows how many there are and how big the file is.
**⌫ clean up** deletes them after asking. Everything you can still open stays, your
spend history stays, and no file on disk changes. Nothing is deleted unless you press
the button.

What cannot survive is a **running process**. So on startup:

- Agents **blocked** on you come back answerable, parked rather than held.
- Agents **mid-work** resume on their own, in their own sessions. The transcript says
  "the daemon restarted mid-run — resuming it", and each one is told the restart happened
  and to check any tool call that was cut short. They wait for free slots like any
  agent. One already at its ceiling is paused instead, and one that had no session yet
  starts from its prompt.
- Agents **waiting to be tried again** because the model couldn't be reached (§7) resume the
  same way, told the restart happened, with all their tries again if they fail.
- Agents that were **queued** simply start when a slot frees.
- A **dev server** an agent started is its own process and is not managed by Conductor; if
  it died with your session, the next launch detection picks up a new one.

`make clean` deletes the database in `~/.conductor/`, which is the way to start from
nothing. It leaves `settings.json`, and the worktrees under `.conductor/wt`.

Worktrees live at `<repo>/.conductor/wt/<jobId>` and are ordinary git worktrees —
inspect them, `git log` them, or remove them by hand if you prefer.

---

## 8. Keyboard

| | |
|---|---|
| `1`–`8`, `9`, `0` | screens (anywhere, unless you're typing in a field) |
| `i` | show or hide the Agent screen's details panel |

On **Needs you** (`4`):

| | |
|---|---|
| `⏎` | answer the blocked agent, then advance to the next |
| `⇥` / `⇧⇥` | next / previous request without answering |
| `a` | allow for the whole session |
| `e` | edit the command, then run it (held requests only) |
| `⎋` | deny, with a reason; on a question, clear your choices |
| `↑` `↓` / `j` `k` | move between options in a question |
| `␣` | choose the highlighted option |
| `o` | choose "Other" on a question |
| `⌘⏎` | commit an edited command or a denial |

Elsewhere:

| | |
|---|---|
| `⏎` / `⇧⏎` | in an agent's composer: send / new line |
| `⏎`, `↑` `↓` | in the command runner (the terminal tab's fallback): run / step through earlier commands. In a real terminal your keys go to the shell, and the screen keys (`1`–`9`, `i`) are off while it has focus |
| `` ⌃` `` | open or close the Terminal dock, from anywhere |
| `⌘F` `⌘C` `⌘V` `⌘K` | in a terminal on macOS: find, copy the selection, paste, clear |
| `⌃⇧F` `⌃⇧C` `⌃⇧V` `⌃⇧K` | the same on Ubuntu (and `⇧Insert` pastes). `⌃C` alone is always the shell's interrupt |
| `⌘⏎` | launch, on Spawn; add a note |
| `⇥` `↑` `↓` `⏎` `⎋` | in a folder field: complete, move, step in, close (§2) |

---

## 9. Making it easier to read

Text sizes and the grey levels are all defined in one place:
`packages/shared/src/tokens.css`.

**To make everything bigger, change these eight numbers:**

```css
--fs-2xs: 11px;    /* uppercase display labels only */
--fs-xs:  11.5px;
--fs-sm:  12.5px;
--fs-md:  13.5px;  /* the most common size in the UI */
--fs-base: 14.5px;
--fs-lg:  15.5px;  /* body text */
--fs-xl:  17px;
--fs-2xl: 21px;
--fs-3xl: 25px;
```

Nothing else in the codebase hardcodes a font size, so scaling the whole
interface is one edit. Adding 2px to each is a noticeable step up; the layout
absorbs it, though you may also want to raise `--topbar` and `--statusbar` just
below.

**For more contrast**, raise the text ramp:

```css
--ink:  #ece7de;   /* primary   — 15.6:1 on the darkest surface */
--ink2: #bdb5a9;   /* secondary  — 8.1:1 */
--ink3: #a79b8d;   /* labels     — 6.0:1 */
```

Those ratios are measured against `--surf2`, the darkest common background.
WCAG AA wants 4.5:1 for normal text and AAA wants 7:1, so there's room to push
`--ink3` toward `#b5a899` (7.1:1) if labels still read faint. Keep the three
levels distinguishable or the visual hierarchy flattens.

The status colours are all AA or better already and shouldn't need touching —
and `--need` in particular should not change, since the whole interface depends
on amber being instantly recognisable.

## 10. Habits that pay off

**Answer quickly or don't watch at all.** Under 90 seconds an agent stays warm
and you can edit its command. Past that it parks — which is fine, and cheap, but
you lose the edit option. There's no benefit to hovering in between.

**Use "allow all session" freely.** It's the difference between supervising and
being pestered. The rule is visible in the agent's guardrails, so you can always
see what you've granted, and you can take it back.

**Settings** (`9`) → **Allowed always** lists every rule for a project. Each shows what it
allows (`Bash · npm test:*`), which agent asked and when, and whether Claude Code kept its
own copy in a settings file. **revoke…** then **revoke** makes Conductor ask again from the
next matching call. A running agent keeps what its session was already given until its
next run.

Revoking changes only Conductor. If Claude Code also wrote the rule into a settings file,
such as the project's `.claude/settings.local.json`, the line says which file and which
entry. Conductor never edits that file, so remove the entry yourself to stop it there too.
A rule covers what Claude Code's syntax says: `npm test:*` is `npm test` and anything after
it, not `npm tester`.

**Say why when you deny.** The agent adapts to your reason. A bare denial usually
means it tries something adjacent and stops again.

**Read `PLAN.md` on the Files screen while the work happens**, rather than the
transcript. A good agent keeps it current, and it's a much faster read.

**Trust the amber and ignore the rest.** If the rail is dark, the fleet doesn't
need you — go and do something else. That's the entire point.
