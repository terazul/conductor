# Wave 10, lane A: say when the install is out of date (Amendment 134)

The text below goes into `CONTRACT.md`, `docs/MANUAL.md` and the `Makefile`'s `test:` target at
merge. The lane edits none of them itself, so lanes merging in order don't collide.

## CONTRACT

Insert at the top of §9, above Amendment 133.

```markdown
### Amendment 134 — post-merge, applied. **`make start` says when the install is out of date, and starts nothing.**

Make and scripts only (`scripts/check-install.mjs` new, `Makefile`, `scripts/verify-check-install.mjs`
new). Asked 13 Oct, in the wave 10 plan (lane A, from the "Right now" list in `TODO.md`). After a pull
that adds a package, `make start` started the daemon and Vite against a `node_modules` that didn't have
it, and the browser showed Vite's `Failed to resolve import` overlay, which looks like a bug in the
code. The cause: nothing compared the install with `pnpm-lock.yaml` before starting.

- **The check** (`scripts/check-install.mjs`). pnpm writes a copy of the lockfile to
  `node_modules/.pnpm/lock.yaml` on every install, and when the install is current the two are the
  same byte for byte (checked 13 Oct). `installState(root)` reads both: `current`, `stale` when they
  differ, `missing` when there is no copy (no `node_modules`, or an install that didn't finish). Paths
  are from the script's own location, not the cwd; `--root <dir>` points it at another checkout.
- **Current:** exit 0, says nothing. **Stale or missing:** one line on stderr, *"Dependencies are out
  of date: run `make install` (or `pnpm install`), then start again."*, and exit 1. With
  `CONDUCTOR_AUTO_INSTALL=1` it runs `pnpm install --frozen-lockfile --prefer-offline` in the checkout
  instead (output shown) and exits with its code, so a lock that no longer matches `package.json`
  still stops the start.
- **Makefile.** A `check-install` target runs it. `start` depends on it before anything else, so a
  stale install starts no process and writes no pid. `restart` is `check-install stop start`: it checks
  before it stops, so a stale install doesn't take down what is running and then refuse to start it.
- **Unchanged:** `make install`, `pnpm dev`, `make fixture` and `make attention` don't check.

**Verify:** `scripts/verify-check-install.mjs` (24 checks: temp checkouts under the system temp dir for
current, stale, no `node_modules`, no copy and line endings alone; the CLI on each with a fake `pnpm`
first on the PATH, so "starts nothing" is seen, not assumed; `CONDUCTOR_AUTO_INSTALL=1` runs the
frozen, offline-first install in the checkout and passes its exit code through; and with no `--root`
it checks its own repo from any cwd). In `make test`. By hand, 13 Oct: a newline appended to
`pnpm-lock.yaml`, `make start` and `make restart` printed the sentence, exited non-zero, and created
no run directory; the lock put back, the check passed.
```

## MANUAL

**1. Troubleshooting table**, `docs/MANUAL.md` §7 "When things go wrong" (the `| Symptom | Cause |`
table). Add this row after the `| Browser won't connect | … |` row:

```markdown
| `make start` says **Dependencies are out of date**, or the browser shows Vite's **Failed to resolve import** overlay | A pull changed `pnpm-lock.yaml` and `node_modules` is still the old install. `make start` and `make restart` check this first and start nothing, so a running app is left as it was. Run `make install` (or `pnpm install`), then `make start`. `CONDUCTOR_AUTO_INSTALL=1 make start` installs by itself instead (`pnpm install --frozen-lockfile --prefer-offline`). |
```

**2. §0 "Start"**: after the paragraph that ends "`make logs` follows both logs." (the one starting
"Their logs and process ids are in `.conductor/run/`"), add a paragraph:

```markdown
Before it starts anything, `make start` checks that `node_modules` is the install
`pnpm-lock.yaml` asks for. After a pull that adds a package it isn't, and `make start` says
**Dependencies are out of date** and starts nothing: run `make install`, then start again.
`CONDUCTOR_AUTO_INSTALL=1 make start` installs by itself instead.
```

**3. "Every make target" table**: replace the existing line

```markdown
| `make start` / `make stop` / `make restart` | Start or stop the daemon and the web app. |
```

with

```markdown
| `make start` / `make stop` / `make restart` | Start or stop the daemon and the web app. `start` and `restart` first check the install is current, and start nothing (stop nothing) when it isn't. |
```

The code block line in §0 (`make start      # starts the daemon and the web app, and waits until both
answer`) stays as it is.

## Makefile test line

Add to the `test:` target (a tab before it, like the others):

```makefile
	node scripts/verify-check-install.mjs
```
