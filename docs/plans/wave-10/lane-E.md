# Wave 10, lane E: Files, the rest of the verbs (Amendment 138)

The text below goes into `CONTRACT.md`, `docs/MANUAL.md` and the `Makefile`'s `test:` target at
merge. The lane edits none of them itself, so lanes merging in order don't collide.

## CONTRACT

Insert at the top of §9, above the highest amendment there at merge.

```markdown
### Amendment 138 — post-merge, applied. **Files makes folders, renames and deletes, and the navigator's folders get a `+`.**

Shared (`wire.ts`), daemon (`workspace/paths.ts`, `workspace/service.ts`, `workspace/tree.ts`,
`workspace/git.ts`, `workspace/watcher.ts`, `routes/workspace.ts`, `workspace/verify-files-verbs.ts` new)
and web (`files/deleting.ts` and `files/DeleteConfirm.tsx`, new; `files/FileTree.tsx`,
`files/NewFileForm.tsx`, `files/naming.ts`, `files/tabs.ts`, `files/useTabs.ts`, `files/useWorkspace.ts`,
`files/route.tsx`, `files/files.css`, `files/verify.ts`, `shell/Navigator.tsx`, `shell/shell.css`,
`shell/verify.ts`). Asked 13 Oct, in the wave 10 plan (lane E, and Q2: a folder with files in it can be
deleted, after a confirm and a second "Are you sure?" naming how many files go). Amendment 121 left
"new folders, rename and delete" not done, and the navigator's folders (Amendment 92) with no `+`. No
migration.

- **Routes**, for a job (`/api/jobs/:jobId/…`) and a project folder
  (`/api/projects/:projectId/dir/…?dir=`), addressed as the two PUT routes are. One handler per verb,
  registered for both by `verbs(prefix, rootOf)` (`routes/workspace.ts:240`, `:304`, `:394`):
  - `POST …/folders { path }` → 201 `CreateFolderResponse`. `mkdir -p`; anything at the name (a file,
    a folder, a link) is a 409 "<path> already exists"; a folder in the name that is a file is a 409
    "… cannot be made: a folder in that name is a file". **`folders`, not `folder`**: `POST
    /api/jobs/:jobId/folder` is already Amendment 114's (put back a job's deleted worktree,
    `routes/session.ts:702`), and Fastify refuses a second route on it at boot.
  - `POST …/rename { from, to }` → `RenameResponse { from, to, type }`. `from` missing is a 404; `to`
    taken is a 409, except by `from` itself under another case (same inode and device, names equal
    but for case), which on a case-insensitive filesystem is the rename someone fixing `readme.md`
    means; a folder into itself is a 400, and so is `to` equal to `from`. Folders above `to` are made.
    A plain file moves by hard link then unlink (`moveNew`, `service.ts:886`), so a name an agent took
    since the check is not replaced, for the reason `publishNew` exists (Amendment 121); a folder, a
    link and a case-only rename use `rename`. A link is moved as the link.
  - `GET …/entry?path=` → `EntryResponse { path, type, files, folders, capped?, tracked }`: what a
    delete would take, counted on disk (`filesUnder`, `service.ts:909`), ignored files and
    `node_modules` included, since a recursive delete takes those too and the tree lists neither. It
    stops at 50,000 entries and says `capped`. `tracked` is how many git has (`trackedCount`,
    `git.ts:183`, a `:(literal)` pathspec), null when the root is not a repo. Read-only, no lock.
  - `DELETE …/entry?path=[&recursive=1]` → `DeleteEntryResponse { path, type, files }`. A file or a
    link (never what it points at) goes; a folder only when empty, or with `recursive=1`. Not empty
    without it is a 409 "<path> is not empty: it holds N files". A folder with a `.git` anywhere in it
    is a 409 even with it ("… holds a git repository (vendor/lib/.git); delete it outside Conductor"):
    a nested clone's history may be the only copy. `recursive` is read as strictly as `createOnly`:
    `1`/`true`, `0`/`false` or absent; anything else is a 400.
- **One gate, `resolveEntry`** (`paths.ts:149`). It is `resolveForWrite` with one difference: the
  parent is canonicalised (the nearest existing ancestor realpath'd, missing segments put back) and the
  last segment kept as typed, so a link is the link. Same refusals, all 400 through `fail()`: `..`, an
  absolute path, anything under `.git` (any case, any depth), a link out of the root. Two more: the
  root itself (`.`, `src/..`), which no verb may make, move or delete; and a `.git` reached through a
  link (`gl -> .git`, then `gl/config`), checked again on the canonical path.
- **Lock and log.** Every change runs under the same per-root lock as a write (`#lockKey`,
  `service.ts:613`: `job:<id>`, or `dir:<path>`). The files a rename or delete changed are handed to
  the watcher in one batch (`Watcher.touchAll`, `watcher.ts:208`), as a write's path is with `touch`,
  so emission stays in one place and a job's tree and the log hear of it at once: a renamed tracked
  file is a `file_edit` deleted for the old path and created for the new, a deleted one stays in the
  tree as a deleted change to review (Amendment 29). A folder made or emptied is no `file_edit` (the
  log is of files), and a project folder has no watcher; the screen re-reads the tree for both.
- **Empty folders are in the tree** (`tree.ts`). `git ls-files` lists files, so a new folder was on
  disk and nowhere on screen. In a repo, `untrackedDirs` (`git.ts:194`, `ls-files -o --directory`)
  names the untracked folders, run beside `listFiles`, and `emptyUnder` (`tree.ts:159`) opens them, at
  most 2,000 folders per read, for the ones with nothing listable; they go in as Amendment 90's empty
  directories already did. With no git, `walkFiles` lists an empty folder as itself. The deny-list
  (`node_modules` and the rest) still applies.
- **Files tree** (`FileTree.tsx`, `TreeVerbs`). A folder row has **+/** (new folder) after its **+**,
  and every row on disk has **✎** (rename) and **⌫** (delete), all siblings of the row's button, shown
  on hover and focus and always where there is no hover. A file row is now a `.c5-filerow` holding its
  button and those. On a focused row **F2** renames and **Delete** or **⌘⌫** deletes. Each tree's
  heading has **+/** beside its **+** (`route.tsx` `RootSection`). One box at a time in a section.
- **The box is `NewFileForm`**, with a `kind`: `folder` starts at `new-folder` and may end in `/`
  (`checkFolderName`, `naming.ts:93`); a rename starts at the entry's whole path with its last name
  selected, a file's without its extension (`prefillRename`, `naming.ts:82`), opens in the row's place,
  and Enter on the name it already has puts it away. Enter commits, Esc cancels, the daemon's sentence
  shows under it. A made folder is opened in the tree, with its ancestors.
- **Delete asks** (`deleting.ts`, pure; `DeleteConfirm.tsx` draws it under the row). A file is one
  confirm naming it, saying whether git has it. An empty folder is one confirm. A folder with files is
  a first confirm naming the folder and how many files it holds, then a second, "Are you sure? N files
  go with notes/, and this cannot be undone from Conductor.", whose yes alone sends `recursive=1`
  (`deleteSteps`, `deleting.ts:91`; `onYes`, `:127`). The count is the daemon's (`GET …/entry`); the
  tree's own count shows until it lands and the button waits for it, because the tree leaves out what a
  recursive delete takes. The focus starts on **keep it**, and Esc is it, as in the tab strip's confirm.
- **Open tabs follow** (`tabs.ts`, pure: `renameTabs` `:361`, `closeUnder` `:389`, `tabsUnder`, `renamedPath`).
  A rename moves every tab on the path, or inside the folder, to the new path in the same place in the
  strip with its view and scroll, the front tab stays in front, and the folders opened and closed under
  it keep that state. `followRename` (`useTabs.ts:223`) moves their unsaved edits first, so the sweep in
  `update` keeps them: what you were typing stays. A delete closes the tabs at or under it once the
  delete has landed (`closeDeleted`); their unsaved edits are named in the first step ("Your unsaved
  edit to docs/a.md goes with it."), which is the asking a dirty tab's close does, said once for all.
- **Client** (`useWorkspace.ts:423-463`): `createFolder`, `renameEntry`, `entryInfo`, `deleteEntry`,
  next to `createFile`, each through `rootEndpoint` and each re-reading its root's tree when it lands;
  a refusal rejects with the daemon's sentence and re-reads nothing. A renamed file's last copy is
  carried to its new name, so its tab shows at once.
- **Navigator +** (`Navigator.tsx:201-384`). Each folder node and each folder row in it has a **+**
  (`AddButton`, a sibling of the row's button, `aria-label` "New file in …", hover and focus as the
  Files tree's, `.sh-nav-add` in `shell.css`). It opens the same `NewFileForm` in place; the file is
  made with `createFile`, opened ready to type with `openNew`, then Files is shown on it
  (`navigate(SCREEN.files, navFileLink(…))`). Only a new file here; rename and delete are on Files.
- **Not changed:** writes and `createOnly`, `resolveForWrite`, Amendment 114's `…/folder`. Colours are
  existing tokens only (`--surf`, `--line2`, `--ink`, `--ink3`, `--fail`, `--bg2`).
- **Not done:** drag and drop to move; renaming or deleting the root folder of a tree (refused by
  design); a rename or delete in the navigator; the Files tree and the navigator have not been looked at
  in a browser in either theme. An empty folder that git ignores is listed if it sits inside an
  untracked folder (`emptyUnder` reads the disk there). The tree read now runs one more `git ls-files`
  (in parallel with the first).

**Verify:** `workspace/verify-files-verbs.ts` (101 checks, a temp repo opened as an in_place job and a
plain folder as a project's directory, port 7838): for each root, a new folder and its parents (201,
in the tree while empty), 409 on a taken name, on a file and under a file, three at once give one 201
and two 409; rename of a file, of a folder into new folders, of a link (as a link), 404 from missing,
409 onto a file and onto a folder, 400 into itself and to the same name, a case-only rename (the disk
asked whether it is case-blind; on macOS it is) and, there, another file onto a case-different name is
409; `entry` counts files and folders and says what git has (null without git); delete of a file and a
link (never its target), 404 when gone, 409 without recursive (and with `recursive=0`), 400 for
`recursive=yes`, gone with `recursive=1`, an empty folder without it, 409 for a folder holding a `.git`;
`..`, `../outside.txt`, an absolute path, `/etc`, `.git`, `.git/hooks/pre-commit`, `.GIT/config`,
`src/../.git/x`, `.` and `src/..` refused by every verb (folder, delete, entry, rename from and to),
`.git` through a link and a link out of the root refused; empty folders inside untracked and tracked
ones listed, `node_modules` still not. For the job, a renamed tracked file emits its deletion and the
new file, a deleted folder emits each tracked file as deleted and the tree keeps them. A job with no
workspace and a folder not the project's are 404s, no `dir` is a 400. `files/verify.ts` "new folder,
rename and delete": `renameTabs` (order, front tab, other roots, folder state, view and scroll, a
displaced tab, no-ops), `tabsUnder` and `closeUnder`, the live store moving an unsaved edit with a
rename and dropping it with a delete, `deleteSteps` and `onYes` (one step for a file and an empty
folder, two for a folder with files, the count repeated, recursive only on the second yes, waiting for
the daemon's count, "1 file goes", "at least", unsaved edits and git named), `countTreeFiles`,
`prefillFolder`, `prefillRename`, `checkFolderName`, the tree drawn with and without `verbs` (which rows
get which buttons, siblings of the row's button, the + still first, rename in place, the folder box
and the confirm under their rows, F2 and Delete), the four client calls for both roots with their
re-reads, the screen's wiring, the navigator's `+` on folder rows and nodes, and tokens only in the
new CSS. `shell/verify.ts`'s "fetched with the Files screen's own hook" now accepts the import naming
more than `useFileTree`.
```

## MANUAL

**1. Screen table, row `5` Files** (`docs/MANUAL.md`, the `| **`5`** | **Files** | … |` row). Replace
the last two sentences:

> A **`+`** on a folder row, or on a tree's heading, makes a new file there and opens it ready to type in. See [Making a new file](#making-a-new-file).

with:

```markdown
A **`+`** on a folder row, or on a tree's heading, makes a new file there and opens it ready to type in; **+/** beside it makes a folder. See [Making a new file](#making-a-new-file). **✎** and **⌫** on a row rename and delete it. See [Renaming and deleting](#renaming-and-deleting).
```

**2. "The navigator", the Files bullet.** Replace:

> A file's row opens it on the Files screen; the
>   navigator stays where it is.

with:

```markdown
A file's row opens it on the Files screen; the
  navigator stays where it is. A folder, and each folder in it, has a **+** when you point at
  it or tab to it: it opens the Files tree's new-file box in place, and the file it makes opens
  on the Files screen ready to type in.
```

**3. "Making a new file", first paragraph.** Replace:

> Every folder row in the Files tree has a **`+`** at its right, which shows when you
> point at the row or tab to it. Each tree's heading has one too, for the top of that
> tree.

with:

```markdown
Every folder row in the Files tree has a **`+`** at its right, which shows when you
point at the row or tab to it. Each tree's heading has one too, for the top of that
tree. The folders in the navigator have the same **+**.
```

**4. "Making a new file", after its last paragraph** (the one ending "since Conductor doesn't watch
those."), add:

```markdown
**+/**, beside the **+**, makes a folder the same way: the box starts at `new-folder` in the
folder you asked from, a name ending in `/` is fine, and folders above it are made too. A name
that is taken is refused. The new folder opens in the tree, empty, ready for a **+**.

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
```

## Makefile test line

Add to the `test:` target (a tab before it, like the others), after the `verify-branches.ts` line:

```makefile
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/workspace/verify-files-verbs.ts
```
