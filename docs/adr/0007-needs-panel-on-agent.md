# ADR 0007 — Answer an agent's requests in a side panel on its own Agent screen

- **Status:** accepted (9 Oct 2026). To be built as Amendment 108. The plan is
  [docs/plans/wave-8-needs-panel-branches.md](../plans/wave-8-needs-panel-branches.md), lane A.
- **Asked for (9 Oct):** "for the Needs You, have it come up as a side panel when I click on
  it in the Agent page — that way I don't have to leave the page to approve it or interact
  with it."
- **Decided by the user (9 Oct):** the panel shows everything waiting for that agent, and
  only that agent: its permission requests, its questions, and the alerts that name it.
- **Decided by the architect, as reversible defaults:**
  - the panel takes the right panel's place while it's open, and the details inspector
    comes back when it closes;
  - it opens when you click, never by itself;
  - it adds no keyboard shortcuts;
  - it has its own width setting.

## Context

All references are under `packages/web/src/`.

- **Today, every "needs you" on the Agent screen sends you away.**
  - The blocked banner, `<button className="ag-blocked" onClick={openAttention}>`
    (`agent/agent.tsx:694-706`), calls `openAttention()`
    (`shell/nav.ts:114-116`). That navigates to Needs You with no `requestId`, so the
    screen focuses the oldest request overall, which may belong to another agent.
  - The tab's amber count (`agent.tsx:590`, `:603`) only switches agent (`openAgent`, `:592-595`).
  - The transcript's ask block is read-only (`agent/transcript.tsx:380-399`).
- **The cards are already presentational, and their props show what they need:**
  - `PermissionCard` (`attention/PermissionCard.tsx:65-73`) takes
    `request, waitMs, state, composer, onComposerChange, onDecide, onRetry`.
  - `QuestionCard` (`attention/QuestionCard.tsx:38-48`) adds `draft, cursor` and their
    setters.
  - `AlertCard` (`attention/AlertCard.tsx:48-53`) takes `alert, agents, projects, focused`.
    It owns its commands and the hand-off editor. One of its actions is
    `navigate('agent', …)` (`:90`), which is pointless when you're already on that agent.
  - Decisions go through `useDecisions(pending).submit` → `POST /api/requests/:id/decide`
    (`attention/decisions.ts:40`, `:67-95`). A card leaves when the daemon's `resolved`
    event drops it from `pending`, never optimistically.
- **The Needs You screen's own state is a full-screen thing.**
  - It keeps one focused request with its composer, draft and cursor
    (`attention/route.tsx:81-103`).
  - Its keys are captured on `window`: Enter, Tab, Escape, space, ↑↓, j, k, a, e and o
    (`:53-65`, `:175-289`). On the Agent screen those would fight the composer and the `i` key
    (`agent.tsx:413-424`).
- **The Agent screen has one right panel.**
  - The Inspector (`agent/inspector.tsx:26`) is toggled by `DETAILS_KEY`
    (`agent.tsx:365`, `:401-409`).
  - It's sized by `usePanel(AGENT_INSPECTOR)` with a `Splitter grow={-1}`
    (`inspector.tsx:49-56`; `shell/panels.ts:32-38`).
  - Tests pin `rightPanelFor('agent') === DETAILS_KEY` (`shell/verify.ts:219-223`) and the
    panel table (`lib/verify.ts:505-557`).

## Options

| Option | What you get | Cost | Risk | Later |
|---|---|---|---|---|
| A. Navigate to Needs You, focused on this agent's request | Still leaves the page | Tiny: pass `requestId` | None | Doesn't do what was asked |
| B. Mount the whole Needs You screen in a panel | Everything, including the queue and ladder | Low code, high coupling | Its window keys collide with the Agent screen; two focus models | Every Needs You change risks the Agent screen |
| **C. A new `NeedsPanel`: the same cards, scoped to one agent, each with its own local state, and no global keys** | This agent's requests and alerts, answered in place | One new component, one panel constant, about 30 lines in `agent.tsx` | Low: the cards and the decide call are reused as they are | Can be offered elsewhere (the Project screen) later |
| D. Inline answer buttons in the transcript's ask block | Answer where it was asked | Medium: the transcript isn't built for controls | Long asks and hand-off editors in a scrolling log | Could come after C, reusing its cards |

## Decision

**C.**

```ts
// attention/NeedsPanel.tsx (new)
export function NeedsPanel(props: {
  agent: Agent;                 // the open agent
  onClose: () => void;
}): JSX.Element;
// Inside: pending = usePending().filter(r => r.agentId === agent.id)
//         alerts  = useAlerts().filter(a => a.agentIds.includes(agent.id))
//         decisions = useDecisions(pending); now = useNow(pending.length > 0)
// Renders, oldest first: each request as PermissionCard / QuestionCard with its own
// { composer, draft, cursor } in a Map keyed by requestId (dropped when it leaves),
// then each alert as <AlertCard … onAgentScreen />.
// Empty: "Nothing is waiting on <role>." and a close button.

// shell/panels.ts
export const AGENT_NEEDS: Panel = {
  key: 'conductor.agentNeedsW', axis: 'width', fallback: 340, min: 280, share: 0.5,
};

// attention/AlertCard.tsx: one optional prop
onAgentScreen?: boolean;        // hides the "open agent" action; nothing else changes
```

- **Opening.** In `agent.tsx`, `const [needsOpen, setNeedsOpen] = useState(false)`.
  - The blocked banner's `onClick` becomes `() => setNeedsOpen(true)`, and its
    "answer →" stays.
  - A header button **needs you · N** (amber, `Tag tone="need"` look) shows when N > 0 for
    this agent, from the counts `agentTabs` already gives (`agent/tabs.ts:47`). It toggles
    the panel.
  - Clicking another tab's amber count opens that agent with the panel open:
    `openAgent(target)` then `setNeedsOpen(true)`. The state survives the agent change
    because `AgentScreen` stays mounted.
  - Clicking the tab elsewhere only switches agent, as now.
- **Placement.** While `needsOpen`, the right side renders `<NeedsPanel>` in place of
  `<Inspector>`. `DETAILS_KEY` and `rightPanelFor` are unchanged, so closing the panel shows
  the details again if they were shown. The `i` key and the details button close the
  panel and show the details.
- **Closing.** The panel's ✕, the `i` key, or switching to an agent with nothing waiting.
  When the last item is answered, the panel stays open with its empty line, so you see the
  answer took.
- **Keys.** No `window` listener. The cards' buttons, textareas and Tab order are all
  there is. Enter inside a card's own textarea works as it does today, since those are
  the cards' own handlers.
- **Unchanged:**
  - the Needs You screen, its queue, its keys and the notification ladder;
  - the navigator's Needs you rows and the rail button, which still go to the full screen;
  - `openAttention`.

## Consequences

- You can answer a permission, a question, or an alert's hand-off without leaving the agent.
  The transcript shows the answer as the `resolved` event arrives, as it does now.
- Two places can decide the same request, but never at the same time: they are on
  different screens. The daemon is already idempotent per request, and a second
  `decide` gets an error that `submit` shows.
- A request from another agent doesn't show here, by the user's choice. The rail and the
  navigator still count it.
- Reversible: the panel is additive. Deleting it restores the old behaviour, except for the
  banner, which would go back to `openAttention`.

## Testing

- `attention/verify-needs-panel.ts` (new, added to `make test`):
  - the scoping: a pure `needsFor(agentId, pending, alerts)` returns only that agent's, oldest
    first;
  - the per-request state map drops entries that left `pending`;
  - source checks:
    - `NeedsPanel.tsx` has no `addEventListener('keydown'`;
    - it uses `useDecisions(`;
    - `agent.tsx` renders `<NeedsPanel` in the Inspector's place and the banner no longer
      calls `openAttention`;
    - `AlertCard` hides "open" under `onAgentScreen`.
- `lib/verify.ts` §10b (`:505-557`): add `AGENT_NEEDS` to the panel table (with its CSS class
  and width), and add it to the unique-keys list. `settings/route.tsx:61-65` lists it for reset.
- `attention/verify.ts:444` still holds: `AlertCard` keeps `<HandOffPanel agent={first} editing={handingOff}`.
- By hand:
  - a permission request on agent X: the banner opens the panel, Allow once works, and the
    banner and card go;
  - a question: choose, answer;
  - a held hand-off alert: edit and hand off from the panel;
  - an amber count on another tab opens that agent with its panel;
  - `i` brings back the details.
