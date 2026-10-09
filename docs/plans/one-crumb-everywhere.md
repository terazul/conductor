# Plan: one "where you are" label on every screen (Amendment 107)

Design and reasons: [ADR 0006](../adr/0006-one-crumb-everywhere.md). CSS and class names
only: no behaviour, wire or daemon change. Build it after Amendments 105 and 106, which are
in this worktree but not yet committed. One commit, with its CONTRACT amendment and a green
`make test`.

## Steps

1. **`packages/web/src/shell/ui.css`**: add `.ui-crumb`, `.ui-crumb b` and `.ui-crumb i`,
   moved from `fleet/fleet.css:58-81` unchanged, with the comment "Where you are (Amendment
   97), the same on every screen (Amendment 107)".
2. **`packages/web/src/fleet/fleet.css`**: delete `.fl-crumb`, `.fl-crumb b` and
   `.fl-crumb i`.
3. **Fleet, Project, Agent**: `fleet/fleet.tsx:86` and `fleet/project.tsx:422` become
   `className="ui-crumb"`, and `agent/agent.tsx:611` becomes `"ui-crumb ag-crumb"`. In
   `agent/agent.css:910-924`, change the comment's `.fl-crumb` to `.ui-crumb`.
4. **Needs You**: `attention/route.tsx:318`, `:340` and `:369` become `className="ui-crumb"`.
   Delete `.atn-crumb`, `.atn-crumb b` and `.atn-crumb i` (`attention/attention.css:57-70`).
   Check nothing else uses `atn-crumb` (`grep -rn atn-crumb packages/web/src`).
5. **Preview**: `preview/route.tsx:257` and `:393` become `className="ui-crumb"`. Delete
   `.pv-crumb` and its `b`/`i` rules (`preview/preview.css:38-~55`).
6. **Files**: `files/route.tsx:334`, `:647`, `:706` and `files/FilePane.tsx:260` become
   `className="ui-crumb c5-crumb"`. In `files/files.css:321-339`, `.c5-crumb` keeps only
   `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;`. Drop
   `.c5-crumb b`. Keep `.c5-crumb i { margin: 0 5px; }`.
7. **Tests**: in `packages/web/src/lib/verify.ts`, a new numbered section after the last one,
   with the checks in ADR 0006 § Testing. Add a short clause to the PASS line.
8. **Docs**:
   - `CONTRACT.md`: Amendment 107 above 106, "post-merge, applied", in the house format.
     Say that it carries Amendment 97 to every screen.
   - `docs/MANUAL.md`: where the Needs You, Preview and Files screens are described (the
     screen table near `:719`), say their header label is on the same backdrop as the
     Agent screen's.
   - `TODO.md:13`: the next amendment is 108.
9. `make test`, then the hand check in ADR 0006 § Testing, in both themes.

## Not in scope

- A different colour per screen (still open in TODO.md, per Amendment 97).
- The top bar's tabs (Amendment 95).
