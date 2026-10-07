# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 87 was cleared on
7 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 93.
- Open items are `- [ ]`. A question that needs the user's answer before building is under
  **Decide:**, and the answer goes beside it in italics, as *Decided (date): …*.
- Later, not planned: a real terminal (xterm.js). The terminal is a command runner on the
  Agent screen today (Amendment 58).

## Seeing what's happening

- [ ] **Make "finished" easier to see.** Asked for (7 Oct). When work is completed, the
  **finished** mark is easy to miss.
  Today it's a small tag: `Tag` (`packages/web/src/shell/ui.tsx:47-55`), styled
  `.ui-tag.t-done` at `--fs-2xs`, 11px, with an 8% tint (`shell/ui.css:62-73`, `93-97`).
  It's on the Fleet card (`fleet/card.tsx:602-623`), the Project screen's job header
  (`fleet/project.tsx:126`) and the navigator's job row, as `.sh-nav-tag.is-done`
  (`shell/Navigator.tsx:161-163`, `shell/shell.css:584-603`). Colour is `--done`
  (`packages/shared/src/tokens.css:50`, light theme `:130`).
  Decide what "more visible" is: a filled badge, a coloured card edge or band, a larger
  word, or a short highlight when it first appears. Any of these must still pass the
  contrast check in `packages/web/src/lib/verify.ts:401-430` in both themes.
  *Decided (7 Oct): a filled badge, plus a coloured left edge on the Fleet card and agent lane.*

- [ ] **Make "working" easier to see.** Asked for (7 Oct). Same as above, for work in
  progress.
  Today it's `<Tag tone="live">N working</Tag>` (`fleet/card.tsx:617-619`,
  `fleet/project.tsx:121-122`), the agent lane's tag (`fleet/lane.tsx:76-78`) and a status
  dot (`Dot`, `shell/ui.tsx:44`). There's also an activity line, "working" or "no recent
  tool calls" (`fleet/card.tsx:673`). Colour is `--live` (`tokens.css:47`).
  Decide with the item above, so the two read as a pair: for example, a moving mark for
  working and a still one for finished. Keep motion off under `prefers-reduced-motion`.
  *Decided (7 Oct): the same filled badge and edge in `--live`, and a slow pulse on the working
  dot. The pulse is off under `prefers-reduced-motion`.*

- [ ] **Show which agents finished, not only which jobs.** Asked for (7 Oct). On a Project
  screen you can't tell which agent finished.
  Today **finished** is per job: `unseenFinished` and `markSeen` in
  `packages/web/src/lib/seen.ts:68-113` work on jobs, as decided for Amendment 87. An agent's
  lane says only `done`, in the same small tag as every other status (`fleet/lane.tsx:78`,
  `STATUS_WORD` at `shell/ui.tsx:33-41`). The agent's status is `done`, and it has
  `endedAt` (Amendment 85).
  Decide:
  - whether each agent gets its own unseen **finished** (seen when its lane or Agent screen
    is opened), or every done agent just shows **finished** plainly.
  - whether the navigator's agent rows (`Navigator.tsx:123-126`) and the agent tabs
    (Amendment 49) show it too.
  *Decided (7 Oct): every done agent plainly shows **finished**, in the new style, on its lane,
  its navigator row and its agent tab. Unseen stays per job (Amendment 87), so the badge can't
  double-count.*

- [ ] **Make "Project" and "Agent" easier to see.** Asked for (7 Oct).
  Decide which is meant:
  - the **Project** and **Agent** tabs in the top bar. They're plain text at `--fs-md` in
    `--ink3`, and the open one gets a 2px underline (`packages/web/src/shell/shell.css:221-262`,
    rendered at `shell/shell.tsx:316`; labels in `fleet/route.tsx:17` and
    `agent/route.tsx:11`).
  - or the name of the project and agent you're looking at, on those screens' headers, so
    you always know where you are.
  *Decided (7 Oct): the top-bar tabs.*
