# Conductor — user manual

How to run several Claude Code agents across several projects without losing track of them.

§0 covers installing, starting and stopping it. The rest is about *using* it. How the code
works, for anyone changing it: [ARCHITECTURE.md](ARCHITECTURE.md).

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
| `make start` / `make stop` / `make restart` | Start or stop the daemon and the web app. |
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
| `CONDUCTOR_TOKEN` | Makes the daemon require this token on every request. The web app sends it when `VITE_CONDUCTOR_TOKEN` is set to the same value. |
| `CONDUCTOR_DATA` | Where the database and `settings.json` go. Default `~/.conductor`. |
| `CONDUCTOR_DB` | A database file to use instead, which also skips the first-start question. Settings then last only until the daemon stops. `:memory:` keeps nothing at all. |
| `CONDUCTOR_SLOTS` | How many agents run at once, when Settings hasn't said. Default `7`. |
| `CONDUCTOR_DEFER_AFTER_MS` | How long a request is held before it parks. Default `90000` (90 seconds). |
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
the line underneath tells you whether it's a repo — which decides what isolation
you can use, so it's better to learn it here than at launch.

The list only ever shows **folders**, never files, and hides dotfolders until you
type the dot yourself.

Rules that matter:

- The directory must exist.
- For **worktree** or **branch** isolation it must be a **git repository**. If it
  isn't, you'll get `not a git repository` when you launch, and no job is created
  — nothing half-made to clean up.
- A non-git directory works with **in place** isolation — the `⚠ this folder, as-is`
  pill. You keep the file tree,
  the change badges and in-pane editing; what you lose is anything defined against
  a commit. The branch reads `(no git)`, every changed file counts as new, and
  there's nothing to revert to — so the badges tell you what an agent wrote, not
  how it differs from a known-good state. `git init` first if you want that.

### Describe the work

Write what you'd tell a colleague. Specific beats polite:

> Refresh tokens aren't rotated — a replayed token stays valid until expiry.
> Rotate on every exchange and revoke the ancestor chain. Tests first.

### Choose isolation

| | |
|---|---|
| **worktree** — `⑂ new worktree` *(default, recommended)* | A fresh git worktree at `<repo>/.conductor/wt/<jobId>` on a new branch. Your own checkout is never touched. |
| **branch** — `⑂ branch in place` | A branch in your existing checkout. Convenient, but the agent edits the files you have open. Needs git. |
| **in place** — `⚠ this folder, as-is` | No isolation at all: whatever branch you're on, or no branch when the folder isn't a repo. The only one that needs no git, and the only one with nothing to revert to. |

One worktree per **job**, not per agent — agents in a job share it and are
coordinated, because worktree-per-agent would make merge conflicts the product.

If the project you picked in step 2 has no git in it, the first two are **struck
through** and `this folder, as-is` is selected for you, with a line saying which
folder and why. Both of the others create a branch, so there is nothing to argue
about — `git init` the folder and re-add it if you want them.

### Choose who works on it

| Preset | |
|---|---|
| **full build pipeline** | architect designs it, then developer builds it, validator tests what was built, reviewer judges it against the plan, and scribe records it, one after another. The reviewer and the scribe are also handed the architect's plan. The default. |
| **bug fix** | debugger finds the root cause, developer fixes it. |
| **review only** | one reviewer. Judges a change; reports findings. |
| **analysis** | analyst explains how the code works, then scribe writes that into the project's docs. |
| **Analysis Only** | analyst explains how the code works, then scribe writes the findings down. |
| **one agent** | a single developer, no structure. |
| **custom…** | the agents you add yourself. |

**custom…** opens an editor with one row per agent:
- Pick a **persona** for the row: it fills in the role name, brief and model, and brings
  its system prompt, tool rules and skills. A row named like a persona, such as the first
  `developer` row, runs as that persona, and its picker says so; pick **no persona** for a
  plain role.
- Give each row a role: keep the persona's or type your own, like `developer-api`. Two
  rows can share a persona.
- Optionally give it a brief of its own, on top of the job prompt; empty uses the
  persona's. Its model can be changed in the plan preview, for this launch only.
- Tick which agents above it it **waits for**. It's handed their final replies, like any
  agent that waits.

**Personas** (Settings → **Personas**) are what each role is. Each one holds a name, a
description, a brief, a **system prompt** (added to Claude Code's own, not replacing it),
a default model, tool rules (shell, push, network, MCP tools, write: each on, off or the
launch's choice) and **skills** to preload. With skills listed, the agent is offered only
those skills. The built-ins (architect, developer, validator, reviewer, scribe, debugger,
analyst) can be edited, and **reset** puts one back as it shipped; they can't be deleted.
Builder, documenter and uiux were built-ins until 6 Oct. An edit you made to builder is now
developer's, and one to documenter is now scribe's. A saved setup's row that used builder
or documenter runs as developer or scribe, and one that used uiux runs with no persona. **+ new persona** adds your own, which can be deleted. The **architect** designs before
anyone builds: it reads the code, weighs two or three options, picks one, and writes the
plan and an ADR in `docs/adr/` without changing source code. It runs on opus, may run
shell and write its documents, and never pushes. In a Custom setup, put a developer after
it (waiting for it), and the developer starts from its plan. Presets use the persona of
the same role for its system prompt, skills and tool rules, and keep their own brief and
model. A persona with **write: off** reads only, and a reading role (reviewer, debugger,
analyst) never writes, whatever its persona says. Editing a persona changes what new
launches and saved setups get. A running or sleeping agent keeps what it launched with.

**Several agents on one role.** In the plan preview, each row's last picker reads
**1 agent**. Change it to **+ up to N helpers**, and that agent orchestrates:

- It's told it may start up to N helpers with a `start_helper` tool. It splits the work
  into parts that don't touch the same files, starts a helper for each, and ends its turn.
- Each helper is an agent in the same job and folder, with the orchestrator's model,
  permissions and per-agent budget. It takes a slot like any agent, and its lane sits
  under the orchestrator's (**↳ helper of developer**).
- While they work the orchestrator waits, **queued**, and gives its slot back. Once every
  helper has ended (a failed one counts, and it's told which), it starts again in its own
  session with what each one said last. It can then check, combine, or start more.

The job's budget is the sum of its agents' caps, so each helper adds one agent's cap.

Each row gets its model in the plan preview, like the presets. Each role can appear only
once, and a role that only reads (`reviewer`, `analyst`, …) stays read-only here too. Name
the setup and **save** it, and it appears beside the presets, in every browser. **✕** then
**forget it** removes a saved one.

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

**The model** is chosen per role by the preset — opus where something is judged, sonnet
where a decided plan is executed — and that's the default. Each row of the plan preview
has its own model picker showing the **exact model id** that role will get, such as
`us.anthropic.claude-opus-5-5`. Change a row to give that role a different model: opus
for the developer and a cheaper model for the scribe, say. Hover a row to see the tier its
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

An agent that waited is told what the ones before it said last. Its first message is
the job prompt, then each earlier agent's final reply under its role, then its own
brief. So the developer in **bug fix** starts with the cause the debugger reported, and
the reviewer in the full pipeline starts with what the architect, developer and validator
concluded. Only the final
reply is passed on, not the working notes before it, and a reply over 8,000
characters is cut and says so. It is sent once, at launch. You can read exactly what
the agent was told as the first turn of its transcript. The files come the other way:
every agent in a job works in the same folder, so what an earlier agent changed is
already there.

Roles that only read — reviewer, debugger, analyst, and auditor (from older analysis
jobs) — are marked
**read-only** in that plan, and it's enforced rather than advertised: the file-writing
tools are denied outright for them, so they stay read-only even if you've set the
autonomy pills wide open, and even if you approve a prompt. They can still run shell
commands, but each one stops and asks — an analyst that can't run `git log` can't
tell you how the code got this way.

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
  Conductor won't estimate it. The budget pill reads **stop each agent after 5M tokens**
  and counts input plus output tokens. The agent's details say spend **not reported**.
  Fleet's **spend today** stays Claude's dollars only. OpenRouter still bills you, so
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
read-only whatever you pick. The default is in **Settings** → launch defaults, and a
running agent's mode can still be changed from its composer.
Every switch in this row reads the same way: **on means the agent may do it
unattended.** A ⚠ appears on a switch that is *off* and will therefore stop and ask you.

**What "run shell unattended" covers.** Claude Code double-checks some shell commands
whatever you've allowed: a `cd` before a `git` command (another folder's git hooks could
run), commands with `$VARIABLES` or `$(…)`, cloning. With the pill on, Conductor answers
those for you, so they never reach Needs you. The deny rules still hold (no push unless
allowed), and a reading role never gets unattended shell. **Allow MCP tools** does the
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
| **⏱ stop each agent after $** | A lifetime budget for each agent, $25 by default. Leave it empty for no limit. See §6. |

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
- **budget**: the new agent's own cap, in dollars, or in tokens on an engine that reports no
  dollars. It is required, as on Spawn, and the job's cap grows by it.

It runs on the job's engine, with the job's permissions (taken from an agent in it that
writes, or reads, as this one will), plus its persona's tool rules. A reading role, or a
reading persona, is kept read-only. Change its permissions afterwards in its inspector, as
for any agent.

**+ add** checks it first and says what's wrong: a role already in the job, a loop (it would
wait for an agent that waits for it), feeding an agent that has already started, or no cap.
Adding to a finished job opens it again. The agent starts as soon as what it waits for is done
and a slot is free.

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
| **Budget reached** | An agent spent its budget and was paused. | **+$10 and continue** or **+$25 and continue**, which raise its cap and wake it, or open it. |
| **Model API** | The model API isn't answering: the network, your login, or an outage. | Nothing while Claude Code is still retrying. The alert clears itself once the model answers. If it gives up, **retry** wakes the agents it stopped. |
| **Dev server down** | A dev server an agent started has stopped answering. | Open its preview, or dismiss. |
| **Daily budget** | Today's spend reached the daily budget set in Settings. | A warning only: nothing is stopped. Change the budget in Settings. |
| **Note due** | One of your project notes is due or late. | **✓ mark done**, open the project, or dismiss it for the day. |
| **Waiting** | An agent waits on one that failed or was stopped. Behind a failed one, such as the reviewer after a failed developer, it stays queued and starts once that one is done. Behind a stopped one it is paused (see "Stopping an agent", §7). | Behind a failed one: **continue** it (when its session can be resumed), open it, or dismiss. Behind a stopped one: **resume** the waiting agent to run without it, open the stopped one, or dismiss. |

An alert stays until the daemon says the problem is gone, or until you dismiss it.
Dismissing is remembered across reloads.

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
| **`1`** | **Fleet** | Everything at once. One card per project, coloured by its unhappiest agent. Glance here. A card says **finished** when one of its jobs has ended and you haven't opened the project since (see [When a job finishes](#when-a-job-finishes)). **▦ density** in the header fits more cards on screen, until you leave Fleet. **Sort by** in the header orders the cards by **needs you first**, **my order**, **name**, **working** (most agents working now), **recently active**, **spend** or **newest**. Drag a card onto another to put it there, or use **← move earlier** / **→ move later** in its **…** menu; either switches to **my order**, starting from what you see. Your order is kept in Settings, so it's the same in every browser, and a new project goes at the end. **Notes:** each card shows your newest note on the project under its path, and a count (**✎ 3 notes**, or **+ note**) in its footer. Click it to add a note (**⌘⏎** adds), and **⧉ copy**, **✎ edit** or **✕ delete** one; newest first. **⧉** beside the card's note line copies it without opening the project. Copy puts the note's text on the clipboard as written, and needs Conductor open on localhost (or https). A note can be **due**: **due today**, or pick a date, when adding or editing it. Due today is amber, late is red, on the card, its count, and in the list, and the card shows the most urgent due note rather than the newest. A due or late note also shows in **Needs You** (**✓ mark done**, **open project**, or dismiss it for the day). Tick a note's box to mark it done: it stays, greyed, and stops nagging. Notes are yours: agents don't see them, and removing the project forgets them. The same notes, with the same add, copy, edit and delete, are in the Project screen's column and the Agent screen's inspector (that agent's project's). |
| **`2`** | **Project** | One project's agents as lanes, each streaming its recent actions with a spend meter, grouped by job. A job that finished since you last looked says **finished** on its group while you're here. Each job's header has **+ agent**, to add one to that job ([Add an agent to a running job](#add-an-agent-to-a-running-job)). The left column has the project's facts, its notes and its actions: **+ spawn agent**, **▤ open files** and **◈ open preview**. The dock along the bottom can be dragged taller. |
| **`3`** | **Agent** | A tab for every agent in the project across the top, newest job first. A tab turns amber, with a count, when that agent needs you, so a blocked agent isn't hidden behind the one you're reading. The full transcript. Your turns are marked so you can scan a long conversation for what you actually said, and the last thing you asked stays pinned at the top while you scroll. Agent output renders as markdown — headings, tables, lists nested to any depth with their numbering kept, task boxes, quotes, code blocks and diagrams. Every tool call collapses to one line, diffs included — click to expand; any reply folds to one line too, by clicking the agent's name beside it, and **⌃ fold all** in the header folds every reply there is so far. Replies always arrive open, and folds are remembered per agent. Reply, switch interaction mode, set guardrails (allow bash / write / web / MCP tools / git push), change its effort, model or budget, or interrupt, from the bottom panel, which you can drag taller by its top edge. **⏎** sends a reply and **⇧⏎** starts a new line. Raising the budget is how an agent that reached its cap carries on. The details panel on the right (**details**, or `i`) shows its usage, with the budget as a bar, tokens in and out, its todo list, the files it touched and its project's notes. What you type there is kept, per agent, if you switch to the terminal, another agent, another screen or reload the page, until you send it or close the browser tab; Spawn's prompt is kept the same way. Its **›_ terminal** tab runs a command in this agent's folder (its worktree) and shows the output: **⏎** runs, **↑ ↓** go back through what you typed, **■ stop** sends Ctrl-C. It runs as you, one command at a time, with no input, so it suits `git status`, `git diff`, `npm test` and `ls`, and not editors or anything that asks a question. Output is kept until **clear** or a daemon restart. |
| **`4`** | **Needs you** | The attention queue. §3. |
| **`5`** | **Files** | Pick a project and see **its directories and nothing else** — one tree each, plus a job's worktree if you pick a job. Files opens on the project you're in: the one a link named, else the one the route itself names, else the last one you had open anywhere — including the one an agent's screen just showed you, even if you got there by a reload. See [A project's directories](#a-projects-directories). Each tree has badges showing which agent touched what and how recently. Markdown renders properly, so this is where you read `PLAN.md` while it's being written. A ` ```mermaid ` block is drawn as its diagram (flowcharts, sequence diagrams and the rest), with **source** to see the code; one that can't be drawn shows its code and why. Agent replies draw them too. Images open in the pane too — PNG, JPEG, GIF, WebP, AVIF, SVG and favicons, on a checkerboard so transparency reads as transparency. You can edit text in place — if an agent rewrites the file under you, you're told rather than overwritten. Every file you open gets a **tab**, from any job, and each tab keeps its view, scroll position and unsaved edit when you go to another screen and come back. See [Files tabs](#files-tabs). |
| **`6`** | **Preview** | The dev server the agent started, embedded. Device widths for responsive checks, and console errors you can send straight back to the agent as a new instruction instead of copy-pasting. |
| | **Spawn** | Start new work. It has no tab or key. Open it with **+ new work** on Fleet or **+** at the top of the navigator, or with **+ spawn agent** on the Project screen, which aims it at that project. |
| **`9`** | **Settings** | **Personas**: what each role is (see below); where Conductor keeps its data; how many agents run at once; a **daily budget** (then the status bar shows today's spend as a bar: green, yellow from 75%, red from 95%, and reaching it is a warning in Needs You, though nothing is stopped; it resets at local midnight); what Spawn starts from (preset, model, isolation, interaction mode, the autonomy pills, effort, budget per agent); **Allowed always**, the rules you've granted (§10); theme (also switched from the right end of the status bar: system, light, dark); and resetting panel sizes and folds. Every setting is kept in `~/.conductor/settings.json`, so it's the same in every browser. |
| **`0`** | **Diagnostics** | The raw feed. Your first stop when something looks wrong. |

**The navigator**, the panel down the left of every screen, lists your projects. A
project's name opens its Project screen, and its **▸** opens it to three submenus:

- **Agents**: grouped by job, newest first. Each group is headed by the job's prompt on
  one line, with its agent count, the dot of its unhappiest agent and, in amber, how
  many things in it need you. A job that finished and you haven't seen says **finished**
  there, never in amber. Under it is one row per agent, each with its status dot,
  plus a count when one needs you. A click opens the agent, and the navigator stays
  where it is. Groups start open; click a group's heading to close it. A project with
  one job still shows its group. Helpers are listed in their job like any agent.
- **Needs you**: this project's waiting requests and alerts, one row each. The heading
  turns amber, with a count, when anything waits. A click opens that item in Needs you.
- **Files**: the project's folders, its main one first. A folder opens and closes like any
  other row here, and while open shows its directories as a tree — folders first, then
  files, nested as deep as the folder goes. A file's row opens it on the Files screen; the
  navigator stays where it is. Nothing here marks a changed file; for that, open the folder
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
way, all the way down, with its own folder marked by its branch. Its own changes don't show;
only the outer folder's do.

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
total. A removal isn't a refund, and the budget shouldn't reset because you tidied
up.

If any agent in the project is still running, the removal is **refused** and names
the ones in the way. Interrupt them on the Agent screen first — Conductor won't
kill work in flight on a button labelled "remove".

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

- **Set a budget per agent** in Spawn: **⏱ stop each agent after $**, $25 by default.
  It's a lifetime cap for each agent, across all its runs, and the job's cap is the sum
  of its agents' caps. An agent that reaches its cap is **paused**, not failed. Needs
  you then offers **+$10 and continue** or **+$25 and continue**, or you can raise it
  in the agent's composer.
- **Today's spend is in the status bar**, and in `make status`. It counts dollars only, so
  Copilot and OpenRouter agents, capped in tokens (§2, "Choose the engine"), add nothing
  to it.
- **Parked agents cost nothing.** Blocked work isn't burning anything.
- **Settings** (`9`) → **agents running at once** (default 7, up to 32) caps concurrent
  *live* agents, and extra ones queue. It applies at once: raising it starts queued agents,
  and lowering it stops nobody, so nothing new starts until fewer than the limit are
  running. `CONDUCTOR_SLOTS` sets the default when Settings hasn't. A message sent to a
  finished agent restarts it straight away, even when every slot is taken.
  Parked agents don't occupy a slot.
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
| Screens blank, feed says reconnecting | Daemon is down. `make start`. The browser holds its cursor and replays the gap, so you lose nothing. |
| `not a git repository` on launch | Worktree and branch isolation need a git repo — they create a branch, so there is no way round it. Use the third pill, `⚠ this folder, as-is`, which doesn't, or `git init` the directory. |
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
| Removed a project by mistake | The files, worktrees and branches are all still there (§4). Add the folder again; you get a fresh project, and the old transcripts and spend history are gone for good. |

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

A terminated agent reads **stopped** — not "done", which would claim it finished. Its
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
  agent. One already at its budget is paused instead, and one that had no session yet
  starts from its prompt.
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
| `1`–`6`, `9`, `0` | screens (anywhere, unless you're typing in a field) |
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
| `⏎`, `↑` `↓` | in an agent's terminal: run / step through earlier commands |
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
