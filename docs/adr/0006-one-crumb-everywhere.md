# ADR 0006 — One "where you are" label, the same on every screen

- **Status:** built as Amendment 107 (9 Oct 2026). The plan is
  [docs/plans/one-crumb-everywhere.md](../plans/one-crumb-everywhere.md).
- **Reported (9 Oct):** "the highlighting of project/agent is not consistent across tabs; for
  example, it is not highlighted when we get to the Needs You tab."
- **Decided by the user (9 Oct):** every screen's header gets it: Needs You, Preview and
  Files, as well as Fleet, Project and Agent.
- **Decided by the architect, as reversible defaults:** one shared class in `shell/ui.css`
  rather than a component; each screen keeps its own class for layout only.

## Context

- **Amendment 97 put the backdrop on one class, not on every label.** `.fl-crumb`
  (`packages/web/src/fleet/fleet.css:58-81`) has `background: var(--here)`, a mixed border,
  5px corners, `3px 10px` padding and `--fs-md`. It's used on Fleet (`fleet/fleet.tsx:86`),
  Project (`fleet/project.tsx:422`) and Agent (`agent/agent.tsx:611`, as `fl-crumb ag-crumb`,
  a button; `agent.tsx:50` imports `fleet.css` for it).
- **The other screens each drew their own copy before that, and still have it without the
  backdrop:**
  - Needs You: `.atn-crumb` (`attention/attention.css:57-70`), in three headers
    (`attention/route.tsx:318`, `:340`, `:369`). The last one is `project / role` for the
    focused request: the case reported.
  - Preview: `.pv-crumb` (`preview/preview.css:38-50`), in `preview/route.tsx:257`
    (`project / preview`) and `:393`.
  - Files: `.c5-crumb` (`files/files.css:321-339`), in `files/route.tsx:334`, `:647`, `:706`
    and `files/FilePane.tsx:260`. It holds a path and has `overflow: hidden;
    text-overflow: ellipsis` because paths can be long.
  All four use the same mono font and the same `b`/`i` inks. Only `.fl-crumb` gained the
  backdrop, so the inconsistency is four copies of one rule, and one copy was updated.
- **`shell/ui.css` reaches every screen.** `shell/ui.tsx:16` imports it, and the shell and
  every screen import `ui.tsx` (`Dot`, `Tag`). Its `.ui-tag`/`.ui-dot` are already the shared
  marks.
- **Tests:** `lib/verify.ts:439-440` checks `--ink`/`--ink2`/`--ink3` are ≥ 4.5:1 on
  `--here` in both themes. Nothing checks which screens use the backdrop.

## Options

| Option | Cost | Risk | Later |
|---|---|---|---|
| A. Copy the backdrop into `.atn-crumb`, `.pv-crumb` and `.c5-crumb` | Smallest diff | The same drift happens again: five copies to keep in step | Each new screen copies again |
| **B. One `.ui-crumb` in `shell/ui.css`; every label uses it; the per-screen copies go, keeping only layout** | Small: CSS moves, class names change in 10 places | Low; the look moves once, in one place | A new screen gets it by using the class; a test can require it |
| C. A `<Crumb>` component in `shell/ui.tsx` | Most churn: the Agent crumb is a button, the Files one maps segments | Same as B | Lets the markup be checked, which B gets from a source test anyway |

## Decision

**B.**

- `shell/ui.css` gains `.ui-crumb`, `.ui-crumb b` and `.ui-crumb i`. They take
  `.fl-crumb`'s rules unchanged (`fleet.css:58-81`), with the Amendment 97 comment.
- `.fl-crumb` is removed from `fleet.css`. Fleet, Project and Agent use `ui-crumb`, and
  Agent keeps `ag-crumb` for its button behaviour (`agent.css:910-924`), so its
  `.fl-crumb` comment becomes `.ui-crumb`. `agent.tsx:50` keeps importing `fleet.css`: it
  still needs it for `fl-pane`/`fl-panehead`.
- Needs You and Preview use `ui-crumb` in place of `atn-crumb`/`pv-crumb`. Those rules go.
- Files uses `ui-crumb c5-crumb`. `.c5-crumb` keeps only what a path needs
  (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0`) and its
  tighter `i` margin, 5px.
- Every header row stays its current height (`min-height: 42px` on `.atn-head` and
  `.c5-panehead`). The crumb's 3px vertical padding fits inside them as it already does on
  `.fl-panehead`.

## Consequences

- Every screen's header label sits on `--here`. On Needs You, the request's `project / role`
  matches the Agent screen it came from.
- The label is one size everywhere: `--fs-md`, up from `--fs-base` on Needs You, Preview and
  Files.
- Files' paths keep their ellipsis. A long path is cut inside the backdrop, not outside it.
- Contrast is already checked: the inks on `--here` are tested (`lib/verify.ts:439-440`).
- Reversible: one rule in one file.

## Testing

- `lib/verify.ts`: a new section. `ui.css` has `.ui-crumb` with `background: var(--here)`.
  No CSS file under `src/` still defines `.fl-crumb`, `.atn-crumb` or `.pv-crumb`, and
  `.c5-crumb` has no `background` (the backdrop comes from one place). Every
  `className="…crumb…"` in `fleet/fleet.tsx`, `fleet/project.tsx`, `agent/agent.tsx`,
  `attention/route.tsx`, `preview/route.tsx`, `files/route.tsx` and `files/FilePane.tsx`
  includes `ui-crumb`.
- Update any existing source regex that names `fl-crumb` (`grep -rn crumb packages/web/src/*/verify.ts`
  finds none today).
- By hand, in both themes: Fleet, Project, Agent, Needs You (with a request, with only alerts,
  and empty), Preview (running and empty) and Files (a file, the diff, an unavailable file).
  The label has the same backdrop in each, and a long Files path ends in "…" inside it.
