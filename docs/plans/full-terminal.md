# Plan: a real terminal on macOS, Ubuntu and Windows (Amendment 112, when built)

**Status:** proposed, 9 Oct 2026. Not built. The decisions marked **(you)** are open; the rest are the
architect's reversible defaults.

**Asked (9 Oct):** "develop a plan to have a full terminal capability that works across Mac, ubuntu
and windows. the terminal is lack luster."

---

## 1. What there is now

The Agent screen's **›_ terminal** tab (Amendment 58) is a **command runner**, and nothing more.
It was chosen because it needed no new dependency and nothing interactive.

| Where | What it does | Why it falls short |
|---|---|---|
| `daemon/src/session/terminal.ts:79` | `spawn($SHELL \|\| '/bin/sh', ['-c', cmd])`, with `stdio: ['ignore', …]` | No stdin, so nothing interactive: no `vim`, `top`, `ssh`, REPLs, prompts or `git add -p`. One command per process, so `cd` and `export` don't last. |
| `terminal.ts:77` | `TERM=dumb NO_COLOR=1 FORCE_COLOR=0` | No colour, no cursor movement, no full-screen programs. |
| `web/src/lib/terminal.ts` (`stripAnsi`) | Escape codes are stripped | Progress bars and spinners print as junk lines. |
| `terminal.ts:111`, `:133` | `process.kill(-pid, …)` stops the process group | Negative pids are POSIX-only; on Windows this throws. |
| `terminal.ts:79` | `$SHELL -c` | Windows has no `$SHELL`, and `cmd.exe` and PowerShell take other flags. |
| `web/src/agent/Terminal.tsx:49` | Prompt is `cwd.split('/')` | A Windows path (`C:\…`) shows whole. |
| `routes/terminal.ts` | Output goes to **every** tab as JSON `terminal_out` frames through the hub | Fine for a log, but too slow and too chatty for keystroke echo. |
| `terminal.ts:20-21` | 256 KB per run, 20 runs, in memory | A long build overflows it, and a daemon restart forgets it all. |

**Conductor itself has never run on Windows.** Nothing in the daemon checks
`process.platform`. `make`, `scripts/*.sh` and the dock launcher are macOS and bash, and several
places split paths on `/` (`workspace/tree.ts:70,283,348`, `workspace/watcher.ts:253,290`,
`supervisor.ts:438`, and in the web `files/links.ts`, `files/route.tsx:117`). A terminal that works on
Windows needs a daemon that runs there, which is §8.

## 2. What "a full terminal" means here

**Goals**

1. A real PTY: interactive programs, colour, 256-colour and truecolor, cursor movement, full-screen
   programs (`vim`, `htop`, `less`, `lazygit`), Ctrl-C/Ctrl-D/Ctrl-Z, tab completion and your shell's
   own history.
2. One long-lived shell per tab, so `cd`, `export`, virtualenvs and `nvm use` persist.
3. It survives a page reload and switching screens: you reattach to the same shell with its screen
   as it was.
4. Several terminals per agent, and one per project outside any agent, in tabs.
5. The same on macOS (zsh/bash), Ubuntu (bash/zsh/fish) and Windows (PowerShell 7, Windows
   PowerShell, cmd, Git Bash, WSL).
6. Copy and paste the way each OS does it, clickable links, file paths that open in **Files (5)**,
   search, and resizing that follows the panel.
7. In the theme: light and dark from the same tokens as everything else.

**Not goals** (now):

- Surviving a daemon restart with the shell still running. That needs tmux/screen on Unix and has no
  Windows equivalent. The last screen is kept and shown read-only instead (§4.5).
- Remote machines or SSH targets as first-class terminals. You can still run `ssh` in one.
- Letting agents type into your terminal. They have their own Bash tool, with its own permissions.

## 3. Decisions

| # | Decision | Default | Alternatives | Why |
|---|---|---|---|---|
| D1 | PTY library **(you)** | `@lydell/node-pty` 1.2.0-beta, pinned, behind a small adapter, with `node-pty` 1.1.0 as the fallback | `node-pty` alone; `@homebridge/node-pty-prebuilt-multiarch` 0.14 | `node-pty` 1.1.0 ships prebuilds for darwin-x64/arm64 and win32-x64/arm64 **but not Linux**, so Ubuntu needs `build-essential` and `python3` to compile it. The `@lydell` fork publishes all six (darwin, linux, win32 × x64, arm64) as optional per-platform packages, so nothing compiles anywhere, but it is a beta. The adapter means the choice can be swapped in one file. |
| D2 | Front end | `@xterm/xterm` 6.0 with `addon-fit`, `addon-webgl` (falls back to the DOM renderer), `addon-search`, `addon-web-links`, `addon-unicode11`, `addon-clipboard` | hterm; a home-made renderer | xterm.js is what VS Code, Theia and most web IDEs use, and is the only mature option. |
| D3 | Reattach | The daemon keeps a headless mirror of each terminal (`@xterm/headless` 6.0 + `addon-serialize` 0.14) and sends its serialized screen and scrollback on attach | A raw byte ring buffer replayed on attach | Replaying raw bytes corrupts on a cut mid-escape-sequence, and replays a full-screen app's whole history. A serialized screen is exactly what was showing. |
| D4 | Transport | A WebSocket per terminal, `/ws/term/:termId`: binary frames for output, small JSON frames for input, resize and control | Through the hub's `/ws` | The hub is JSON, fans out to every tab and keeps a seq log for replay. A terminal is one stream, one viewer at a time, latency-sensitive and high-volume. Keeping it off the hub keeps both simple. |
| D5 | Lifetime | A terminal lives until you close it, its shell exits, its agent or project is removed, or the daemon stops. It is **not** killed when the page closes. | Kill on disconnect; idle timeout | Reload-proof is the point. A cap (D7) stops them piling up. |
| D6 | The command runner **(you)** | Replace the tab with the real terminal, and keep `session/terminal.ts` only as the fallback when no PTY loads (with a banner saying why) | Keep both, as "Run" and "Terminal" | One terminal is less to explain. The fallback means a failed native load never leaves you with nothing. |
| D7 | Limits | 16 live terminals in all, 10,000 lines of scrollback each (a setting), and refusal with a sentence past the cap | No cap | Each PTY is a process plus a headless mirror. |
| D8 | Where they appear | (a) the Agent screen's terminal tab, cwd = the job's worktree; (b) a **Terminal** dock under any screen for the project you're on, cwd = the project folder, opened with `` Ctrl-` ``. Tabs in both. | Agent screen only | You asked for a full terminal, and much of what you'd run isn't about one agent. |
| D9 | Windows default shell | `pwsh.exe` if it's on PATH, else `powershell.exe`, else `%COMSPEC%` (`cmd.exe`). Git Bash and WSL are offered when found. | Always `cmd.exe` | PowerShell 7 is what a Windows developer expects, and it handles ANSI well under ConPTY. |

## 4. Daemon

### 4.1 Pieces

```
packages/daemon/src/terminal/
  pty.ts        the adapter: load @lydell/node-pty, else node-pty, else null (D1)
  shells.ts     which shell, with which arguments and environment, per OS (§6)
  session.ts    one terminal: its PTY, its headless mirror, its viewer, its limits
  service.ts    every terminal: create, list, attach, resize, close; caps; shutdown
  kill.ts       ending a process tree on each OS
routes/term.ts  REST and the /ws/term/:termId socket
```

`session/terminal.ts` (the runner) stays, used only when `pty.ts` returns null.

### 4.2 The model

```ts
interface TermInfo {
  id: string;                    // term_…
  scope: { kind: 'agent'; agentId: string } | { kind: 'project'; projectId: string };
  title: string;                 // the shell's own title (OSC 0/2), else "zsh · conductor"
  shell: string;                 // what ran: "/bin/zsh", "pwsh.exe"
  cwd: string;                   // where it started
  cols: number; rows: number;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;        // the shell exited, or the daemon restarted (§4.5)
  exitCode: number | null;
  viewers: number;               // tabs attached now
}
```

### 4.3 API

| | |
|---|---|
| `GET /api/terminals?scope=agent:<id>\|project:<id>` | `{ terminals: TermInfo[], pty: 'ok' \| 'fallback', why?: string, shells: ShellChoice[] }` |
| `POST /api/terminals` `{ scope, shell?, cols, rows }` | 201 `{ terminal }`. 409 past the cap; 410 when the folder is gone; 404 no such agent or project. |
| `DELETE /api/terminals/:id` | Ends the process tree (§6), keeps the info and last screen 10 minutes, then forgets it. |
| `PATCH /api/terminals/:id` `{ title? }` | Rename a tab. |
| `GET /ws/term/:id` (upgrade) | The stream, below. |

The hub gets one new frame, `{ type: 'terminals', scope, terminals }`, so every tab's list of
terminals stays current (a terminal opened in one browser tab shows in another). It never carries
output.

### 4.4 The socket

- **Server → client.** First a JSON `{ t: 'hello', info, screen }`, where `screen` is the headless
  mirror's `serialize()` (scrollback included), then **binary** frames of raw PTY output, then JSON
  `{ t: 'exit', code }` when the shell ends.
- **Client → server**, all JSON: `{ t: 'in', d }` for keys and paste, `{ t: 'resize', cols, rows }`,
  and `{ t: 'ping' }`.
- **More than one viewer.** A second tab attached to the same terminal gets the same stream. Input
  from any viewer is taken. The PTY's size is the most recent resize, and the others see a "resized
  in another tab" note. This is what tmux does, and it beats refusing.
- **Back-pressure.** Output is batched every 8 ms or 32 KB, whichever comes first. When a socket's
  `bufferedAmount` passes 1 MB the PTY is paused (`pty.pause()`) until it drains, so `cat` of a
  huge file can't run the daemon out of memory. The headless mirror is always written, so the screen
  is right on reattach whatever was dropped.
- **Guard.** The upgrade goes through the same onRequest guard as every route (`guard.ts:41`: local
  host, local or no Origin) and the same `?token=` check as `/ws` (`index.ts:108-113`). A WebSocket
  is the classic cross-site hole (CSWSH), so the Origin check is not optional here: verify asserts
  that a foreign Origin is refused.

### 4.5 Lifetime

- **Created** by POST, and not on page load: you open one with **+**. The first visit to an empty
  terminal tab opens one for you.
- **Page closed or reloaded:** nothing happens to the shell. Reopening attaches and draws the
  screen as it was.
- **Shell exits:** `exit` frame, the tab says *exited (0)* with **↻ new shell**, and it is
  forgotten after 10 minutes.
- **Agent or project removed:** its terminals are closed first, the same way `deleteAgent` stops a
  runner now.
- **Daemon stops:** every process tree is ended (§6). Each terminal's last screen is written to
  `~/.conductor/terminals/<id>.screen` (capped at 1 MB) with its info. On start they come back as
  ended terminals, *ended: the daemon restarted*, read-only with **↻ new shell in the same folder**,
  and are forgotten after a day.

### 4.6 Environment

- Starts from the daemon's environment, minus `CONDUCTOR_TOKEN` (as the runner does now).
- Adds `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=conductor` and
  `CONDUCTOR_TERMINAL=1`. Also `LANG=en_US.UTF-8` when `LANG` is unset on Unix, so UTF-8 works
  under a daemon started from launchd or systemd with a bare environment.
- macOS and Linux: a **login** shell (`-l`), because the daemon is often started by the dock
  launcher or launchd without your profile's PATH. This is the dock's known pain
  (`MANUAL.md:996`).

## 5. Web

### 5.1 Pieces

```
packages/web/src/terminal/
  Xterm.tsx       one xterm.js instance bound to one socket: attach, reattach, resize, theme
  TermTabs.tsx    the tabs, +, close, rename, the shell picker
  socket.ts       the /ws/term client: reconnect with back-off, ping, binary decode
  theme.ts        tokens → ITheme (background, foreground, cursor, selection, 16 ANSI colours)
  keys.ts         copy, paste and the keys the page must not steal, per OS (§5.3)
  links.ts        URLs open in a new tab; paths open in Files (5) (§5.4)
  dock.tsx        the bottom Terminal dock for the project (D8b), Ctrl-`
```

`agent/Terminal.tsx` becomes `<TermTabs scope={{ kind: 'agent', agentId }} />`, or the old runner
when `pty === 'fallback'`, with the reason above it.

### 5.2 Behaviour

- **Size.** `addon-fit` on a `ResizeObserver` of the panel, debounced to 50 ms, sends `resize`
  when cols or rows change. Dragging the panel taller (it already drags) grows the terminal.
- **Renderer.** WebGL, falling back to the DOM renderer on `webglcontextlost` or when there is
  no WebGL (some VMs and remote desktops).
- **Fonts.** The app's `--mono`, with a terminal font-size setting (default 13) and
  `addon-unicode11` for wide characters and emoji.
- **Theme.** `theme.ts` reads the CSS tokens once per theme change (`useTheme`) and maps them to
  xterm's `ITheme`. The 16 ANSI colours get a palette per theme, checked for contrast against its
  background in verify. `--need` (amber) is not used: it means "you're needed", and nothing in a
  terminal means that.
- **Reconnect.** A dropped socket shows a thin *reconnecting…* bar and retries at 0.5, 1, 2, 4 s, up
  to 10 s. On `hello` the screen is reset to the serialized one, so nothing is doubled.
- **Bell.** `\a` flashes the tab, and the tab gets a dot if it isn't the visible one. No sound.
- **Title.** OSC 0/2 sets the tab's label, so `vim file.ts` shows in the tab.
- **Focus.** Clicking the terminal focuses it. While it has focus the app's single-key hotkeys
  (`1`–`9`, `i`, `⏎` in `shell/`) are off, and Esc-Esc gives focus back to the page.

### 5.3 Keys, copy and paste

| | macOS | Ubuntu / Windows |
|---|---|---|
| Copy | ⌘C (copies when there is a selection) | Ctrl-Shift-C; Ctrl-C copies only with a selection, otherwise it is SIGINT, as Windows Terminal does |
| Paste | ⌘V | Ctrl-Shift-V, Ctrl-V on Windows, Shift-Insert |
| Bracketed paste | on: multi-line paste doesn't run line by line | same |
| Paste of more than 5 lines or 4 KB | asks first, showing the first lines | same |
| Clear | ⌘K | Ctrl-Shift-K |
| Find | ⌘F (addon-search) | Ctrl-Shift-F |
| Option/Alt as Meta | `macOptionIsMeta` setting, off by default so ⌥ types characters | Alt is Meta |

`addon-clipboard` handles OSC 52, so `tmux` and `vim` can copy to your clipboard. It only writes
to the clipboard and never reads it.

### 5.4 Links

- URLs (`addon-web-links`) open in a new browser tab.
- A file path, alone or as `path:line:col`, relative to the terminal's cwd and inside the
  worktree or project, opens in **Files (5)** at that line. This reuses `files/links.ts`, which
  already keeps links inside the worktree. A path outside it is plain text. Windows `C:\…`
  paths are recognised as well as `/…`.

## 6. Per OS

| | macOS | Ubuntu | Windows |
|---|---|---|---|
| PTY | forkpty (node-pty) | forkpty | **ConPTY**, Windows 10 1809 or later; winpty is not supported |
| Default shell | `$SHELL` (zsh), with `-l` | `$SHELL` or `getent passwd $USER`'s, else `/bin/bash`, with `-l` | `pwsh.exe` → `powershell.exe -NoLogo` → `%COMSPEC%` (D9) |
| Also offered when found | bash, zsh, fish | bash, zsh, fish | Git Bash (`…\Git\bin\bash.exe --login -i`), WSL (`wsl.exe ~` with its distros), cmd |
| Ending it | `SIGHUP` to the group, then `SIGKILL` after 3 s | same | `pty.kill()`, then `taskkill /PID <pid> /T /F` for the tree |
| Paths | `/` | `/` | `\` and drive letters. Never split a path on `/`; use `node:path` on the daemon and a small `basename()` that knows both on the web. |
| Line endings | LF | LF | ConPTY gives CRLF; xterm.js renders it. Nothing to convert. |
| Install | prebuilt (D1) | prebuilt with the fork; with `node-pty` alone, `sudo apt install build-essential python3` | prebuilt; nothing to install |

`shells.ts` returns `ShellChoice[]` (`{ id, label, path, args }`) found on this machine, and the
setting `conductor.terminal.shell` picks the default. Spawn uses an argument array (no shell
string), so nothing a user typed is re-parsed.

## 7. Settings

`conductor.terminal.shell`, `conductor.terminal.fontSize`, `conductor.terminal.scrollback`
(1,000–100,000) and `conductor.terminal.macOptionIsMeta`. They go in Settings (9), under
**Terminal**, with rules in the daemon like the other settings (`settings.ts:33`).

## 8. Before Windows: Conductor itself on Windows

The terminal is only half the Windows work. The daemon has to run there too. These are the
known blockers, found by reading the code, not by trying it:

1. `make` and `scripts/*.sh`: add `pnpm start` / `pnpm stop` / `pnpm status` scripts in Node
   (`scripts/status.mjs` is already Node), and keep `make` as a thin wrapper on macOS and Linux.
2. Paths split on `/` in the daemon (`workspace/tree.ts`, `workspace/watcher.ts`,
   `supervisor.ts:438`) and in the web (`files/links.ts`, `files/route.tsx:117`,
   `agent/Terminal.tsx:49`, `agent/inspector.tsx:154`). The wire keeps worktree-relative paths
   POSIX (`toPosix` exists in `workspace/git.ts:397`). Absolute paths stay native, and the web
   gets a `basename()` that splits on both.
3. `process.kill(-pid)` in `session/terminal.ts` (the fallback): use `kill.ts`.
4. The Claude Code CLI and Copilot runtime on Windows: both support it, but `claude` has to be on
   PATH for the daemon's environment.
5. Worktrees on Windows: `core.longpaths` for deep `node_modules`, and file locks (a running
   process holds files open, so `worktree remove` can fail where macOS succeeds). The service
   should report that rather than half-remove.
6. The dock launcher is macOS-only. On Windows, a Start-menu shortcut to `pnpm start` is enough
   for now.

**An alternative that works sooner:** run the daemon in **WSL2** and the browser on Windows.
localhost is forwarded, the daemon is on Linux, and the terminal is a Linux PTY. The plan supports
this from phase 2, and the manual should say so. Native Windows is phase 4.

## 9. Phases

Each phase ends with `make test` green, its CONTRACT amendment and a manual section.

| Phase | What | Done when |
|---|---|---|
| **0. Spike** (½–1 day) | Install `@lydell/node-pty` and `node-pty` with pnpm 10 on Node 22, on macOS arm64, Ubuntu 24.04 x64 and Windows 11 x64. Add them to `pnpm.onlyBuiltDependencies`. Spawn a shell, echo, resize, Ctrl-C, exit. Run `@xterm/headless` + serialize round trip. | A table of what worked where. D1 is confirmed or changed. |
| **1. Daemon PTY service** | `terminal/` (§4.1) for macOS and Linux; REST and `/ws/term`; headless mirror; back-pressure; caps; shutdown; guard and token on the upgrade; the `terminals` hub frame; the fallback to the runner. | `daemon/src/terminal/verify.ts`: a real PTY runs `printf`, `stty size` follows a resize, Ctrl-C ends `sleep`, `exit 3` reports 3, reattach gets the screen, a 50 MB `cat` doesn't grow the heap past a bound, a foreign Origin is refused, the cap refuses the 17th. |
| **2. Web terminal in the Agent screen** | `terminal/` (§5.1) except the dock; theme; keys; reconnect; URL links; replace the tab; fallback banner. | `web/src/terminal/verify.ts` (theme contrast, key maps per OS, link parsing, socket frame decode), plus a hand check of vim, htop, less, git add -p, a REPL, a reload mid-`top`, and two tabs on one terminal. |
| **3. Tabs, project dock, settings, Files links** | Several terminals per scope, the Terminal dock (D8b), Settings → Terminal, paths → Files, find, bell, title, saved last screens after a restart. | Verify extended; manual updated; the old runner's docs removed. |
| **4. Windows** | §6's Windows column in `shells.ts` and `kill.ts`; §8 items 1–3 and 5; CI on `windows-latest`. | The same verify passes on Windows with `pwsh` and `cmd`; a hand check in Windows Terminal's absence (the browser only). |
| **5. CI** | `.github/workflows/test.yml`: `make test` (or its pnpm equivalent) on `macos-latest`, `ubuntu-latest` and `windows-latest`, Node 22. There is no CI today. | Green on all three on a PR. |

Phases 1–3 are one person-week or so. Phase 4 depends on what §8 turns up.

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The `@lydell/node-pty` beta breaks or is abandoned | Medium | It's behind `pty.ts`; fall back to `node-pty` 1.1.0, which compiles on Linux. Pin exact versions. |
| A native module fails to load on someone's machine | Medium | D6: the runner still works, and the banner says what failed and how to fix it (`apt install build-essential python3`). |
| The terminal is remote code execution as you over localhost | Inherent; it is already true of the runner | The same guard as every route, a mandatory Origin check on the upgrade, the token when set, never bound beyond localhost, and verify tests each. The panel keeps saying "runs as you". |
| ConPTY quirks (resize reflow, older Windows 10) | Medium on Windows | Require 1809+, detect and refuse with a sentence below it, and test resize on CI. |
| Memory from many terminals with big scrollback | Low | D7's caps, back-pressure, and scrollback a setting. |
| Hotkeys fight the terminal | High without care | Off while the terminal has focus; Esc-Esc to leave. verify checks the shell's key handler skips when focus is in `.xterm`. |

## 11. Open questions for you

1. **D1:** a prebuilt beta fork that installs everywhere, or stable `node-pty` that needs a compiler on Ubuntu?
2. **D6:** replace the command runner, or keep it as a separate "Run" tab next to the terminal?
3. **D8b:** do you want the project-level Terminal dock under every screen, or only the Agent screen's terminal?
4. **Windows:** native Windows (phase 4, plus §8), WSL2 only, or both?
5. **Restart:** is "ended terminals come back read-only with their last screen" enough, or do you want shells that survive a daemon restart on macOS and Linux (through tmux, if it's installed)?
