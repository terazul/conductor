# Wave 10, Lane H: terminal, the rest of the plan (Amendment 141)

The text below is for the merge to apply. This lane does not edit CONTRACT.md, docs/MANUAL.md,
the Makefile or TODO.md.

## CONTRACT

### Amendment 141 — post-merge, applied. **The terminal, the rest of the plan: settings, add-ons, paths into Files, a Terminal dock under every screen, a `terminals` frame and the headless mirror.**

Daemon, web and shared. From `docs/plans/full-terminal.md` §4-§7 and the wave 10 plan (Lane H);
it finishes what Amendment 112 left out. Q5 stands: no tmux, so a daemon restart still ends every
shell.

**H1: settings.**
- Three settings, in Settings (9) under **Terminal**, with rules in the daemon
  (`daemon/src/terminal/prefs.ts:49-55`, through `settingRule`, `settings.ts:33`):
  `conductor.terminal.fontSize` (9 to 24, default 13), `conductor.terminal.scrollback` (1,000 to
  100,000, default 5,000) and `conductor.terminal.shell` (one of the shells this machine has,
  default the one Amendment 112 picked). The keys, ranges and the parser (`termNumber`, digits
  only, so `5e3` and `13.5` are refused) are shared (`shared/src/wire.ts:1096-1106`).
- **The shells.** `findShells` (`daemon/src/terminal/shell.ts`): `$SHELL`, then `/etc/shells`
  (absolute paths only, comments skipped), then `/bin/zsh`, `/bin/bash`, `/bin/sh`, each only if
  it is there, no repeats; two with the same name are labelled with their path. `pickShell` takes
  the setting when it names one of those that is still there, else falls back as before.
  `GET /api/terminals/shells` → `{ shells: TermShell[], default }` (`routes/term.ts:133`). A new
  terminal runs the chosen shell; open ones keep theirs. `TermInfo.shell` says which ran.
- **Settings screen.** `TermNumber` and `TerminalSection` (`web/src/settings/route.tsx:186-275`) in
  the `SlotsSection` pattern: a draft written on Enter or blur, Esc puts it back, the default
  written as nothing; the shell is a select of the daemon's list, and a setting naming a shell no
  longer there is shown as such. The Terminal dock's height joins the layout reset.
- **Xterm reads them** (`web/src/agent/Xterm.tsx`): the font size and scrollback at creation, and
  a change applies to an open terminal; a new font size re-fits, so the shell gets its new size.
  The fixed `fontSize: 13` and `scrollback: 5000` are gone.

**H1: add-ons** (`web/package.json`): `@xterm/addon-search` 0.16.0, `addon-web-links` 0.12.0,
`addon-clipboard` 0.2.0, `addon-webgl` 0.19.0 and `addon-unicode11` 0.9.0.
- **Find**: ⌘F on macOS, Ctrl-Shift-F elsewhere, opens a find bar in the terminal's corner; typing
  searches as you go, Enter is next, Shift-Enter previous, Esc closes it and gives the terminal its
  focus back.
- **The key map** is `termKey` (`web/src/terminal/keys.ts`): find, copy (with a selection only),
  paste and clear are ⌘F/⌘C/⌘V/⌘K on macOS and Ctrl-Shift-F/C/V/K (and Shift-Insert to paste) on
  Ubuntu; everything else is the shell's, Ctrl-C included. Paste is left to the browser, so
  xterm.js bracket-pastes it. `wantsCopy` (Amendment 112) is now one row of it.
- **URLs** open in a new browser tab (`noopener`).
- **OSC 52** (`vim`, `tmux` copying to the clipboard) writes the clipboard; a read is answered
  with nothing, so a program cannot see what you copied elsewhere.
- **WebGL**, with xterm.js's DOM renderer when WebGL is not there (the addon throws on load) or
  the context is lost (`onContextLoss` disposes it). Unicode 11 widths for wide characters and
  emoji (`allowProposedApi`).
- **Mouse reports as bytes.** `t.onBinary` (`Xterm.tsx:225`) is sent as a new client frame,
  `{ t: 'bin', d: <base64> }` (`TermClientFrame`, `shared/src/wire.ts:1086-1090`); the daemon
  writes the bytes themselves (`routes/term.ts`, `parseClientFrame` refuses anything that is not
  base64). Sent as `in`, an X10 mouse report past column 95 was UTF-8 encoded on the way and each
  byte over 127 became two. `Pty.write` takes a `Buffer` (`terminal/pty.ts:22`).

**H1: paths open in Files.** A link provider (`Xterm.tsx:152`) finds file paths in each line
(`findPathLinks`, `web/src/terminal/paths.ts`): `path:line`, `path:line:col` and tsc's
`path(line,col)`, or a path with a `/` in it; a bare word such as `node.js`, a version, a time and
the inside of a URL are not. Each is taken relative to the folder the terminal started in and must
stay inside its worktree (an agent's) or project folder (the dock's): `termFileTarget` resolves it
with `files/links.ts`' `resolveDocLink`, so `..` past the root, `~`, another folder and a
`/w/job-evil` beside `/w/job` are plain text. Clicking opens Files (5) on that root
(`navigate(SCREEN.files, { jobId, path, line })`). Files learned `&line=`: `followLink` keeps the
line wanted per tab (`web/src/files/useTabs.ts:147-166`), and the pane shows the file raw with that
line marked and scrolled to the middle, once (`FilePane.tsx`, `rawAround` in `files/links.ts`).
The cell mapping counts a wide character as two cells.

**H2: project terminals.** `TermScope = { kind: 'agent'; agentId } | { kind: 'project'; projectId }`
(`shared/src/wire.ts:1024`), on every `TermInfo`. The manager (`daemon/src/terminal/service.ts`)
lists by scope; each terminal also carries its job and project, so removing a job ends its agents'
terminals as before, and removing a project (`closeProject`, `service.ts:274`, called from
`supervisor.ts:709`) ends its own and any of its agents'. Same cap (16 live, of either kind), same
lifetime rules. New routes (`routes/term.ts:123-131`): `GET` and `POST
/api/projects/:projectId/terminals`, the shell starting in the project folder; 404 for an unknown
project.

**H2: the `terminals` frame.** `ServerFrame` gains `{ type: 'terminals'; scope; terminals }`
(`shared/src/wire.ts:909`), the scope's whole list, broadcast whenever a terminal in it opens, exits,
is closed or is forgotten (`TerminalManager.onChange`, wired to the hub at `routes/term.ts:70`). It
never carries output. The web store hands it to `web/src/terminal/live.ts` (`lib/store.ts:197`),
and every terminal panel showing that scope takes the new list, so a terminal opened in one browser
tab is listed in the others.

**H2: the Terminal dock** (plan D8b; `web/src/terminal/dock.tsx`). Under every screen, above the
status bar (`shell/shell.tsx:334`): the terminals of the project you are on (the one the navigator
highlights, `currentProject`, `shell/navtree.ts:344`), in tabs, each in the project folder, **+**
for another. Ctrl-` opens and closes it from anywhere, a terminal included (Xterm lets the key
through), and so does the status bar's **▸ terminal** (`shell.tsx:231`). Its height is dragged at
its top edge and kept (`TERMINAL_DOCK`, `shell/panels.ts:96`, `conductor.terminalDockH`), and
whether it is up is a setting (`conductor.terminal.dock`). The tabs are `TermTabs`
(`web/src/agent/TermPanel.tsx`), the Agent tab's, made scope-generic; `TermPanel` is it for an
agent, with the runner fallback. The Project screen dock's placeholder terminal tab
(`fleet/dock.tsx:65`, "not yet assigned") now opens the Terminal dock.

**H2: the headless mirror** (`daemon/src/terminal/mirror.ts`). `@xterm/headless` 6.0.0 and
`@xterm/addon-serialize` 0.14.0 (`daemon/package.json`), loaded lazily through `createRequire`.
Each terminal has one, at the PTY's size and with the scrollback setting, fed every byte the shell
prints, resized with it. A page that attaches is sent its `serialize()` (screen, alternate screen,
cursor, modes and scrollback) as the first binary frame, instead of the last 512 KB of raw output;
so reattaching mid-`vim` draws `vim`'s screen. The snapshot waits for the emulator to have parsed
every write before it (`write('', cb)`), and output arriving meanwhile is held for that page and
sent after it (`service.ts:180`), so nothing is lost or doubled. The socket protocol is unchanged
for the page: binary frames, the screen first. If the packages do not load, a terminal keeps the
raw 512 KB replay (`ring.ts`), as it does if serializing fails. The mirror's own backlog counts
toward the pause at 1 MB (`#throttle`, `service.ts:346`), as a slow page's does, since xterm.js
drops a write queue past 50 MB.

**Verified.** `daemon/src/terminal/verify.ts`, 141 checks (100 before): §1 the shells found, the
setting's pick and its fallback, `bin` parsed and non-base64 dropped, the mirror loads; §4 bytes
sent as `bin` reach the shell as bytes (`od` reads `41 fc 0a`) and text as UTF-8 (`41 c3 bc`); §6 a
page reattaching after 900 KB of output gets the screen and its 5,000 lines, under 256 KB, ending at
the tail; §6b with the mirror forced off, the old 512 KB replay; §6c after a program switches to the
alternate screen, clears it, places three lines by cursor moves and leaves the cursor mid-screen, a
page reattaching (its bytes drawn in a fresh headless terminal) is on the alternate screen with each
line where it was put and the cursor at row 3 column 7, the shell's screen behind it comes back on
leaving, and it is live after; §11b a project terminal opens in the project folder, is listed with
its scope and not in an agent's list, closes, and 404s for an unknown project; the hub sends a
`terminals` frame for each open, close and exit (listed exited, with its code), for the agent's
scope apart, carrying only `type`, `scope` and `terminals`; §11c each setting refuses out of range
(`8`, `25`, `13.5`, `5e3`, `999`, `100001`, an unknown shell) with the range, and takes good values;
`/api/terminals/shells` lists `/bin/sh` as the default; a chosen shell is what a new terminal runs;
with scrollback 1000, a page reattaching after `seq 1 3000` gets 1,000 lines plus the screen; §12
removing the project ends its own terminal too, and the hub says it has none. `web/src/agent/verify.ts`
§ "the terminal, the rest of the plan": the key maps on both OSes (and what is left to the shell),
Ctrl-`, path parsing (`path:line:col`, tsc's form, a full stop, words that are not paths, URLs) and
`termFileTarget`'s inside/outside rules, `rawAround`, the settings readers and field messages, the
dock flag, `bin` keeping 0xfc one byte, the frame reaching only its scope's panel, and the wiring
from the source. **A person checks** `vim`, `htop`, `less` and mouse mode in a browser, WebGL and
the DOM fallback, and Ubuntu (plan §5).

## MANUAL

1. docs/MANUAL.md:865, the Agent screen's row (`3`). Existing text:

```
Its **›_ terminal** tab is a full terminal in this agent's folder (its worktree): a real shell (your `$SHELL`, as a login shell, else bash, else sh) with colour,
```

Replacement:

```
Its **›_ terminal** tab is a full terminal in this agent's folder (its worktree): a real shell (the one chosen in Settings, else your `$SHELL`, as a login shell, else bash, else sh) with colour,
```

Existing text:

```
Leaving the tab, switching screens or reloading the page does *not* end a shell: coming back reattaches to it and draws the last 512 KB it printed, so a build you started is still going.
```

Replacement:

```
Leaving the tab, switching screens or reloading the page does *not* end a shell: coming back reattaches to it and draws its screen as it is, with the scrollback above it, so a build you started is still going and a `vim` or `htop` you left is drawn as you left it. **⌘F** (**Ctrl-Shift-F** on Ubuntu) finds text in it; **Esc** closes the find bar. A link printed in it opens in a new browser tab, and a file path (`src/app.ts:12:3`, `src/x.tsx(40,7)`, or any path with a `/` in it), if it is inside the worktree, opens in Files at that line. Programs that copy with OSC 52 (`vim`, `tmux`) can write your clipboard, never read it, and the mouse works in programs that use it.
```

2. docs/MANUAL.md:864, the Project screen's row (`2`). Existing text:

```
The dock along the bottom can be dragged taller. |
```

Replacement:

```
The dock along the bottom can be dragged taller. Its **▸ terminal** tab opens the Terminal dock (below). |
```

3. docs/MANUAL.md:872, the Settings row (`9`). Existing text:

```
theme (also switched from the right end of the status bar: system, light, dark); and resetting panel sizes and folds.
```

Replacement:

```
**Terminal**: the font size (9 to 24, default 13; an open terminal redraws at the new size), the scrollback (1,000 to 100,000 lines, default 5,000) and the shell new terminals run (one of the shells this machine has: `$SHELL` and `/etc/shells`); theme (also switched from the right end of the status bar: system, light, dark); and resetting panel sizes and folds.
```

4. New paragraph, after the screens table (after docs/MANUAL.md:873, before "Across the top of every screen"):

```
**The Terminal dock**, under every screen, holds the shells of the project you're on (the one the navigator highlights), each started in the project's folder. **Ctrl-`** opens and closes it from anywhere, a terminal included, and so does **▸ terminal** in the status bar; the Project screen's **▸ terminal** tab opens it too. The first time it opens for a project it opens a terminal; **+** opens another, and **×** on a tab ends that shell. Drag its top edge to make it taller; the height is remembered. Closing the dock, or moving to another project, doesn't end a shell: they are the daemon's, and a terminal opened in one browser tab is listed in the others. They end when you close them, when the project is removed, or when the daemon stops. They count toward the 16 live terminals with the Agent screen's.
```

5. docs/MANUAL.md:1204, troubleshooting. Existing text:

```
| The terminal says **16 terminals are open already** | That's the most live shells at once. Close a tab you're done with (× ends its shell). |
```

Replacement:

```
| The terminal says **16 terminals are open already** | That's the most live shells at once, the Agent screen's and the Terminal dock's together. Close a tab you're done with (× ends its shell). |
```

6. docs/MANUAL.md:1411, keyboard, "Elsewhere". Existing text:

```
| `⌃⇧C` | in a terminal on Linux: copy the selection (`⌃C` is the shell's interrupt; on macOS `⌘C` copies) |
```

Replacement:

```
| `` ⌃` `` | open or close the Terminal dock, from anywhere |
| `⌘F` `⌘C` `⌘V` `⌘K` | in a terminal on macOS: find, copy the selection, paste, clear |
| `⌃⇧F` `⌃⇧C` `⌃⇧V` `⌃⇧K` | the same on Ubuntu (and `⇧Insert` pastes). `⌃C` alone is always the shell's interrupt |
```

## Makefile test line

none
