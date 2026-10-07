# ADR 0003 — Wave 7: nested repos, Files follows you, navigator folders, louder status

- **Status:** accepted (7 Oct 2026). To be built as Amendments 90–95. The plan is
  [docs/plans/todo-wave-7-oct.md](../plans/todo-wave-7-oct.md).
- **Asked for:** the seven TODO.md items of 7 Oct.
- **Decided by the user (7 Oct):**
  - nested repos are browsed all the way down and marked as repos with their branch. Their own
    changes don't show.
  - finished and working get a filled badge and a coloured edge, plus a pulse while working.
  - every done agent plainly shows **finished**.
  - "Project and Agent" means the top-bar tabs.
- **Decided by the architect, as reversible defaults:** the navigator shares the Files screen's
  tree hook, and it shows no change marks.

## Context

- **Nested repos.** `listFiles` runs `git ls-files -co --exclude-standard`
  (`packages/daemon/src/workspace/git.ts:123-127`). It lists a nested clone as one entry,
  `inner/`, and a submodule as `inner`. `buildTree` (`workspace/tree.ts:120-169`) splits each
  path into segments. Each entry becomes a file leaf with nothing under it. `walkFiles` is used
  only when the root isn't a repo at all (`tree.ts:126-128`). The cap is `MAX_TREE_ENTRIES =
  12_000` (`tree.ts:35`), and `NEVER_LISTED` comes after it (`tree.ts:37-57`).
- **The wire.** `FileNode` (`packages/shared/src/wire.ts:351-362`) has no field that marks a
  repo.
- **Which project you're in.** It's a variable in memory, `remembered`
  (`packages/web/src/shell/nav.ts:55-74`). `openProject`, `openAgent` and `openFiles` set it
  (`nav.ts:78-104`), and so does `highlight`. An Agent screen reached by URL or a reload never
  calls `highlight`. Files reads the value once, when it mounts.
- **The navigator.** Its **Files** node lists only the project's top folders (`NavFolder`,
  `shell/navtree.ts:85-94`). Open nodes are ids kept in settings (`navId`, `navtree.ts:255-260`).
  The Files screen gets a tree with `useFileTree(root)` (`files/useWorkspace.ts:297`). `root` can
  be a project folder's `dirRoot` (Amendment 39).
- **Status marks.** These are `Tag` and `Dot` (`shell/ui.tsx:44-55`). `STATUS_WORD.done` is
  `'done'` (`ui.tsx:33-41`). "Unseen finished" is per job (`lib/seen.ts`, Amendment 87).

## Options and decisions

### 1. Nested repos in the tree (Amendment 90)

| Option | Cost | Risk | Later |
|---|---|---|---|
| A. `git ls-files --recurse-submodules` | tiny | Covers submodules only, not nested clones. Can't be combined with `-o`. | Two mechanisms |
| **B. In `buildTree`, list each nested repo with its own `listFiles` and graft the result under it** (chosen) | small | One `git` process per nested repo per request | Changes for nested repos can be added beside it |
| C. Walk the whole filesystem and ignore git | medium | Loses `.gitignore` | Breaks Amendment 4's "git does the ignoring" |

**Decision: B.**

- **What counts as a nested repo.** An entry is one if `lstat` says it's a directory that isn't a
  symlink, and it contains a `.git` entry. That entry is a directory for a clone and a file for a
  submodule. Use this check, not `isRepo`: `isRepo` answers true for any folder inside the outer
  repo.
- **No `.git` inside.** The entry is shown as an empty directory. An uninitialised submodule looks
  like this.
- **Nested repos inside nested repos.** Recurse, at most 4 levels down. Symlinks are never
  followed, so the tree can't loop back up.
- **Budget.** The outer repo's own paths go first. Nested paths get what's left of the one shared
  `cap`. One large `vendor/` clone can't push out the project's own files. `truncated` and the
  log line report the total dropped, as now.
- **Filters.** `listed()` and `NEVER_LISTED` apply inside nested repos too. A nested repo's
  `.gitignore` applies, because its own `git ls-files` reads it.

**Wire (additive, backward-compatible):**

```ts
// packages/shared/src/wire.ts, FileNode
/** Set on a directory that is its own git repo: a nested clone or a submodule (Amendment 90). */
repo?: { branch: string | null };   // null: detached HEAD, or no commits yet
```

A client that doesn't know the field ignores it. The Files tree shows the mark as the branch name
beside the folder (wave 2). Opening a file inside a nested repo goes through the same file route.
Lane A must check that a read of `inner/x` and an image from it both work, and that no route asks
the outer repo about the file.

### 2. Files opens on the project you're in (Amendment 91)

**One rule:** a link that names a job or a file wins. Otherwise, use the project the route names.
Otherwise, use `recall().projectId`. Otherwise, use the first project.

- `agent/route.tsx` calls `highlight(agent.projectId)` once the agent has loaded.
- Files then follows that project, even if it already holds another project's job: the job gives
  way to the project rule.
- Reproduce the bug before changing anything.

### 3. Navigator folders (Amendment 92)

| Option | Cost | Risk |
|---|---|---|
| A. A new endpoint that lists one level at a time | medium | A second tree API, and nested repos would need handling twice |
| **B. `useFileTree(folder.root)`, mounted only while that folder's node is open** (chosen) | small | Fetches the whole tree for that folder, but only on first open. Same code as Files |

**Decision: B.**

- **Node ids.** A new helper, `navDirId(projectId, root, path)`, returns
  `p:<projectId>:files:<root>:<path>`. The ids are kept in settings the same way as today.
- **Rows.** Folders come first, then files, sorted the way the Files tree sorts them.
- **Clicks.** A folder opens and closes. A file calls
  `navigate('files', { jobId: folder.root, path })`.
- **No change marks.** This is reversible later.

### 4. Status marks (Amendment 93)

- **The tags.** `Tag` tones `done` and `live` become filled:
  - background `--done` or `--live`;
  - text in the ink the contrast check approves;
  - the same `--fs-2xs` size, in a heavier weight.
- **The edge.** The Fleet card and the agent lane get a 3px left edge in the same colour while
  finished or working.
- **The pulse.** The working dot pulses about every 2 seconds. A
  `@media (prefers-reduced-motion: reduce)` rule turns it off.
- **Contrast.** `lib/verify.ts`'s contrast check gains the filled pairs (text on `--done`, text
  on `--live`) in both themes.
- **The word.** `STATUS_WORD.done` becomes `'finished'`, so every done agent says
  **finished**.
- **Unseen.** "Unseen" stays per job (`seen.ts` is unchanged), so the tab badge can't
  double-count.

### 5. Carry-through (Amendment 94, wave 2)

- The navigator's job and agent rows (`Navigator.tsx`, `.sh-nav-tag`) use the filled marks.
- The agent tabs (Amendment 49) do too.
- `repo.branch` shows beside a nested repo's folder in the Files tree and in the navigator.

### 6. Top-bar tabs (Amendment 95, wave 2)

`.sh-screens` (`shell/shell.css:221-262`) changes:

- every tab's ink goes from `--ink3` to `--ink2`, with a heavier weight;
- the open tab gets `--ink`, a tinted background and a 3px accent underline;
- the contrast check covers the new pairs.

## Consequences

- **The wire.** `FileNode.repo` is the only change to it. It's optional, so old clients and
  saved data are unaffected. There's no migration and no new endpoint.
- **Speed.** Each tree request runs one extra `git ls-files` per nested repo, in parallel. A
  project with many nested repos pays for this on each watcher refresh. Lane A measures it.
- **Changes in nested repos** are still invisible to Changes and diffs (`workspace/changes.ts`).
  That's a deliberate gap, and a later amendment can close it.
- **The word "done".** Every UI string that came from `STATUS_WORD.done` now reads
  **finished**. Tests and the MANUAL text that say `done` change with it.

## Testing

- `workspace/verify.ts` runs against the scratch repo, which gains a nested clone and a
  submodule. It checks:
  - a full path inside each nested repo is listed;
  - `repo.branch` is set;
  - `node_modules` inside a nested repo stays hidden;
  - the shared cap holds, and the outer repo's files are kept first;
  - a symlink to `..` doesn't loop.
- `files/verify.ts` checks the project rule for each of these paths:
  - a link that names a file;
  - the route's project;
  - the remembered project;
  - another project's job already open.
- `shell/verify.ts` checks the `navDirId` format and the link a file row builds.
- `lib/verify.ts` checks contrast for the filled tags and the top-bar tabs in both themes.
- Then `make test`, and a check by hand in both themes after `make restart`.
