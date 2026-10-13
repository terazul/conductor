# Wave 10, Lane B: Needs You's label matches the Agent screen (Amendment 135)

## CONTRACT

### Amendment 135 — post-merge, applied. **Needs You's `project / role` label uses the Agent screen's backdrop.**

Web only (`attention/route.tsx`, `lib/verify-crumb.ts`, `shell/ui.css` (a comment)), and
`docs/MANUAL.md`. No behaviour, wire or daemon change, no migration, no new token. Asked: a TODO.md
loose end (12 Oct, "Label backdrops (127)"), taken into the wave 10 plan as Lane B: "Needs You's
`project / role` header stays on `--here`, so it no longer matches the Agent screen it came from."
It finishes Amendment 127, whose own **Not done** said the same.
- **The label for the request in focus** (`project / role`, `route.tsx`) is now
  `ui-crumb is-agent`, so it sits on `--here-agent`'s wine rose, the Agent screen's backdrop, in
  both themes. It names an agent, the one whose request you are answering, so it reads as that
  agent's screen at a glance. The text is unchanged, and so is the layout: `is-agent` sets
  `--crumb` and nothing else (Amendment 127).
- **The other two Needs You headers stay on `--here`**: `needs you / N alerts` (alerts only) and
  `needs you / nothing` (queue clear). They name the screen, not an agent or a project, so they
  keep Fleet's slate blue, like Preview, Files and Branches. Neither is a project-only label, so
  nothing on Needs You uses `is-project`.
- **Checked**: `lib/verify-crumb.ts` section F no longer counts Needs You among the screens that
  stay on `--here`. It finds the span that starts with `{focused.projectName}` and fails unless its
  class is exactly `ui-crumb is-agent`, and fails unless `route.tsx` has three crumbs, that one and
  two plain `ui-crumb`. Fleet, Preview, Files and Branches are still checked to carry neither class.
- **Not done**: not looked at in a browser, in either theme. Amendment 127's question stands: the
  three backdrops differ only a little in lightness, so say if Needs You's label and Fleet's are
  too alike once seen.

**Verified:** `lib/verify-crumb.ts` (PASS, section F's two new checks among them),
`attention/verify.ts` (PASS), `attention/verify-needs-panel.ts` (PASS), `lib/verify.ts` (PASS),
`pnpm --filter @conductor/web typecheck` (clean).

## MANUAL

`docs/MANUAL.md`, the screens table, row **`4`** (**Needs you**). Existing sentence:

> The attention queue. §3. Its header label, like Preview's, Files' and Branches', sits on the same slate-blue backdrop as Fleet's; only the Project and Agent screens have a backdrop of their own.

Replacement:

> The attention queue. §3. When a request is in focus its header label (`project / role`) sits on the Agent screen's wine-rose backdrop, so it matches the agent it came from; with nothing to answer, its `needs you` label, like Preview's, Files' and Branches', sits on the same slate-blue backdrop as Fleet's.

The **`3`** (**Agent**) row's "(wine rose, where the Project screen's is petrol blue and Fleet's slate
blue, ...)" stays true and needs no change.
