# TODO

Things we want but haven't built. Bugs and cleanup that are already planned live in
[docs/CLEANUP.md](docs/CLEANUP.md); this is for new work. Each item says where it would
start, so picking one up doesn't begin with a search.

Finished items are taken off this list. Their record is the CONTRACT.md amendment each
one names, and this file's git history (everything up to Amendment 87 was cleared on
7 Oct).

## How to work this list

- One item at a time in one checkout, each committed with its own CONTRACT amendment and a
  green `make test` (decided 30 Sep). The next amendment is 94.
- Open items are `- [ ]`. A question that needs the user's answer before building is under
  **Decide:**, and the answer goes beside it in italics, as *Decided (date): …*.
- Later, not planned: a real terminal (xterm.js). The terminal is a command runner on the
  Agent screen today (Amendment 58).

## Seeing what's happening

- [ ] **Make "Project" and "Agent" easier to see.** Asked for (7 Oct).
  Decide which is meant:
  - the **Project** and **Agent** tabs in the top bar. They're plain text at `--fs-md` in
    `--ink3`, and the open one gets a 2px underline (`packages/web/src/shell/shell.css:221-262`,
    rendered at `shell/shell.tsx:316`; labels in `fleet/route.tsx:17` and
    `agent/route.tsx:11`).
  - or the name of the project and agent you're looking at, on those screens' headers, so
    you always know where you are.
  *Decided (7 Oct): the top-bar tabs.*
