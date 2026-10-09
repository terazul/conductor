# ADR 0009 — Choose the default branch, a full terminal, a git methodology per launch, "You asked" in --you

- **Status:** accepted (9 Oct 2026). To be built as Amendments 112, 114, 115 and 116. The plan
  is [docs/plans/wave-9.md](../plans/wave-9.md).
- **Asked for (9 Oct):**
  1. "let me select what branch is the default branch and put conductor on that branch";
  2. "make the full terminal available to Ubuntu and macOS for now (ignore Windows)";
  3. "in the section 'YOU ASKED …' make that highlighted";
  4. "let me specify what git branch methodology you should use: (1) keep on current default
     branch, (2) new branch name, (3) new branch for each text input command".
- **Decided by the architect.** The user declined the question round and said "continue", so
  each open choice takes the recommended default. Each is listed below as *Default*, and each
  can be reversed.

## Context

All references are on `main` at `0ed14e8`.

- **Default branch.**
  - `Project.defaultBranch` (`shared/src/wire.ts:34`) is captured once, when the project is
    added (`daemon/src/session/supervisor.ts:428-440`).
  - It is stored in `projects.default_branch` (`db/migrations/001_core.sql:15`) and can't be
    edited: `updateProject` sets only the name and path (`session/store.ts:205-222`), and
    `PATCH /api/projects/:id` takes only `{name?, path?}` (`routes/session.ts:362-382`).
  - The Branches screen's target is picked by `resolveTarget` (`workspace/branches.ts:86-122`),
    in this order: the screen's pick, origin/HEAD, the recorded branch, main/master, then HEAD.
    The recorded branch comes third because it was usually stale (Amendment 113).
  - Nothing runs `checkout` in a project folder except `branch` isolation
    (`workspace/worktree.ts:185-195`).
- **Terminal.**
  - The Agent screen's terminal is a command runner (Amendment 58). It runs
    `spawn($SHELL, ['-c', cmd])` with stdin ignored and `TERM=dumb`
    (`session/terminal.ts:77-79`), and streams output as hub frames (`wire.ts:775-777`).
  - `docs/plans/full-terminal.md` is a proposed design (Amendment 112), with
    @lydell/node-pty, @xterm/xterm, and a socket per terminal kept off the hub.
  - Route files can add their own `{ websocket: true }` routes (`daemon/src/index.ts:58-68`,
    `:105-118`).
  - There are no platform checks anywhere.
- **"You asked".** `LastAsk` (`web/src/agent/agent.tsx:55-93`) is the sticky
  `.ag-lastask` (`agent/agent.css:389-436`), drawn in `--bg2` with a `--line` border. Your own
  turns already read in `--you` (Amendment 106, `agent.css:56-94`).
- **Methodology.**
  - `Isolation` is `'worktree' | 'branch' | 'in_place'` (`wire.ts:70`), chosen by pills in
    Spawn (`spawn/route.tsx:218-238`, `:539-547`) and defaulting to the setting
    `conductor.launch.isolation`.
  - The branch is always `conductor/<jobId>` (`worktree.ts:111`). `EnsureRequest.branch`
    exists (`:67`), but nothing passes it, and `CreateJobRequest` (`wire.ts:205-213`) has no
    branch field.
  - A follow-up message resumes the same job and worktree (`supervisor.ts:1411-1435`,
    `:1603`). A new job, and so a new branch, comes only from Spawn (`POST /api/jobs`).

## Decisions

### 1. Choose the default branch, and check it out (Amendment 114)

- **New action** `{ action: 'set_default'; branch: string; checkout: boolean }` in
  `BranchAction`.
  - It writes `projects.default_branch` and marks it chosen, with a new column
    `default_branch_set INTEGER NOT NULL DEFAULT 0` in a new migration.
  - With `checkout`, it runs `git switch -- <branch>` in `project.path`.
- **`resolveTarget`** puts a *chosen* recorded branch first, ahead of origin/HEAD. A recorded
  branch that was only captured at add time keeps its place behind origin/HEAD, as in
  Amendment 113.
- **Checkout is refused (409)** when any of these hold:
  - `project.path` has tracked changes;
  - an `in_place` or `branch` job in this project has a live agent;
  - the branch is checked out in another worktree, which git also refuses.
- **`BranchesResponse`** gains `rootBranch: string | null`, what `project.path` has checked
  out, so the screen can say "the folder is on X".
- **Screen 7:** a selected branch gets **Make default**, and **Make default and check out**,
  which needs a confirm. The header shows "default: X · folder on Y".
  - For the Conductor repo itself, the confirm says that the running daemon and web app run
    from this folder and will change under you. It names the folder; nothing special-cases
    Conductor.

### 2. A full terminal on macOS and Ubuntu (Amendment 112)

This is `docs/plans/full-terminal.md`, cut down. *Defaults:*

- **D1, the PTY library: `@lydell/node-pty`**, prebuilt for darwin/linux × x64/arm64, so
  nothing is compiled. It sits behind `terminal/pty.ts`, which returns null if it fails to
  load, so the library can be swapped in one file.
- **D6, the command runner:** the real terminal replaces it, and the runner stays only as the
  fallback. Fallback cases: Windows (`process.platform === 'win32'`), or a PTY that won't
  load. A banner says why.
- **D8, where it appears:** the Agent screen's terminal tab only, with `cwd` set to the
  job's worktree. The project dock is left for later.
- **Reattach:** each terminal keeps a raw ring buffer of its last 512 KB, replayed on attach,
  instead of the plan's headless mirror (D3). That's simpler, and it's good enough for
  shells. A full-screen app redraws on the resize sent at attach.
- **Shape:**
  - Routes:
    - `POST /api/agents/:agentId/terminals` → `{ id }`;
    - `GET /api/agents/:agentId/terminals` → `{ available, reason?, terminals: [{ id, cwd,
      startedAt, exited }] }`;
    - `DELETE /api/terminals/:id`.
  - Socket: `GET /ws/term/:id`, with the same local-only guard and `?token=` check as `/ws`.
    - Server → client: binary output. On attach, the buffer is replayed first.
    - Client → server: JSON, `{ t: 'in', d: string }` or `{ t: 'resize', cols, rows }`.
  - Shell: `$SHELL`, else `/bin/bash`, else `/bin/sh`, with `-l`. The environment gets
    `TERM=xterm-256color`, `COLORTERM=truecolor`, and `NO_COLOR` removed.
- **Limits:**
  - at most 16 live terminals;
  - a terminal is killed when its shell exits, when it's closed, when its agent or job is
    removed, or when the daemon stops;
  - it is not killed when the page closes.
- **Web:** `@xterm/xterm` and `@xterm/addon-fit`, in a new `agent/Xterm.tsx`, with tabs for
  more than one terminal.
- **Dependencies** are added by this lane only. They're named here, since CONTRACT §3 says
  dependencies must be declared: `@lydell/node-pty` (daemon), `@xterm/xterm` and
  `@xterm/addon-fit` (web).

### 3. "You asked" in --you (Amendment 116)

- `.ag-lastask` gets a `--you` border and `color-mix(in srgb, var(--you) 10%, var(--bg2))`
  as its background. Its `ui-lab` and text use `--you`.
- The ≥ 4.5:1 contrast check moves to `--you` on that background, in both themes.

### 4. A git methodology per launch (Amendment 115)

Spawn's isolation pills become three methodology choices:

| Choice | Sends | Means |
|---|---|---|
| **(1) Default branch, in the folder** | `isolation: 'in_place'` | The agent works in the project folder on what's checked out there, normally the default branch (decision 1). |
| **(2) New branch: [name]** | `isolation: 'worktree', branch: <name>` | A worktree on the branch you name. *Default:* its own worktree, so the folder and other jobs are untouched. |
| **(3) New branch per launch** | `isolation: 'worktree'` | As now: `conductor/<jobId>`. *Default:* a "text input command" is a launch from Spawn. A follow-up message stays on its job's branch. |

- **Wire:** `CreateJobRequest.branch?: string`, allowed only with `worktree`.
- **Daemon:**
  - It validates the name with `git check-ref-format --branch` (400 if invalid).
  - It refuses (409) a branch that's already checked out in another worktree, or that is the
    project's default branch.
  - An existing branch is added with `worktree add <path> <branch>`, never `-B`, because `-B`
    would reset its commits. A new one gets `worktree add -b <branch> <path> HEAD`.
- **The `branch` isolation** ("branch in place") is no longer offered in Spawn. The API still
  accepts it, so existing jobs are unchanged.
- **The setting `conductor.launch.isolation`** offers the same three. Choosing (2) as the
  default leaves the name empty, and Spawn won't launch until you fill it in.

## Consequences

- **Checking out in the project folder is a write the daemon now makes to your checkout.**
  It's refused on any tracked change and while anything works in place. For Conductor's own
  repo it moves the running app's code under it, and the confirm says so.
- **The terminal is a real shell, running as you, reachable from the browser.** It is
  bounded by the same localhost-only guard and optional token as the rest of the API. That
  is the same trust the command runner already had.
- **A native module ships for the first time.** If it fails to load, the runner still works.
- **Hard to undo:** the migration. It only adds a column with a default, so it's safe for old
  rows.

## Testing

- **(114)** `workspace/verify-branches.ts`:
  - set_default writes the branch, and the target follows it;
  - checkout switches the folder;
  - a dirty folder gives 409;
  - a live in-place job gives 409;
  - a branch checked out elsewhere gives 409;
  - `rootBranch` is right.

  `branches/verify.ts` covers the new disabled reasons and the header line.
- **(112)** `terminal/verify.ts` (new; it skips with a notice when no PTY loads):
  - create, attach, `echo hi`, and receive `hi`;
  - resize;
  - detach and reattach replays;
  - DELETE kills the process;
  - the cap of 16 holds;
  - an unknown id gives 404;
  - a non-local Origin on the socket is refused.

  Web source checks in `agent/verify.ts`: the tab mounts `Xterm` when available, and the
  runner otherwise.
- **(115)** `session/verify.ts` or a new `workspace/verify-methodology.ts`:
  - a named new branch;
  - a named existing branch keeps its commits;
  - an invalid name gives 400;
  - a branch checked out elsewhere gives 409;
  - `in_place` is unchanged.

  `spawn/verify.ts` covers the three pills, (2) needing a name, and the request body.
- **(116)** `agent/verify.ts`: `.ag-lastask` uses `--you`, and the contrast check passes.
