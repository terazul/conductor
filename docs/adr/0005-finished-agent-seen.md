# ADR 0005 — An agent's "finished" tag clears once you've opened it

- **Status:** accepted (9 Oct 2026); built as Amendment 105. The plan is
  [docs/plans/finished-agent-seen.md](../plans/finished-agent-seen.md).
- **Reported (9 Oct):** "the finished tag is never cleared from the menu bar, even after I
  visit the particular agent."
- **Decided by the user (9 Oct):**
  - clear it on visit, per agent. An agent that finishes again (re-run, continued) says
    **finished** again.
  - both places: the navigator's agent rows and the Agent screen's tabs.
  - the architect plans; a builder writes it.
- **Decided by the architect, as reversible defaults:** a separate setting key rather than a
  field inside `conductor.seenJobs` (see option A2); only opening the agent itself clears its
  tag (not opening its project); the status words elsewhere stay as they are.
- **Supersedes, in part:** ADR 0003's "every done agent plainly shows **finished**", for the
  navigator rows and the agent tabs only.

## Context

- **Not a bug in the code, a rule that no longer fits.** The navigator's agent row renders
  `{a.status === 'done' && <span className="sh-nav-tag is-done">finished</span>}`
  (`packages/web/src/shell/Navigator.tsx:138`). The Agent screen's tab renders
  `{t.status === 'done' && <span className="ag-tab-tag">finished</span>}`
  (`packages/web/src/agent/agent.tsx:599`). Both depend only on status, so a done agent says
  it for as long as it exists. Amendment 94 (`CONTRACT.md:590-616`, ADR 0003 lines 9-10,
  113-115) did this on purpose. Tests pin it: `packages/web/src/shell/verify.ts:429-431` and
  `packages/web/src/agent/verify.ts:477-478`.
- **Seen is per job today.** `lib/seen.ts` keeps `conductor.seenJobs` as
  `{ since, jobs: { <jobId>: <endedAt seen> } }` (`seen.ts:10-22`, `34-39`).
  `unseenFinished` (`seen.ts:75-87`) and `markSeen` (`seen.ts:93-107`) are pure. The live
  hooks are `markJobsSeen` (`seen.ts:135-139`) and `useUnseenJobs` (`seen.ts:142-147`). The
  Agent screen's visit is marked in the always-mounted `Notifier`, while the tab is in front
  (`packages/web/src/attention/always.tsx:78-83`). A job group's **finished** in the
  navigator uses that (`Navigator.tsx:172-173`, `navtree.ts:204`). That tag is a job tag: it
  waits for the whole job to roll up, so in a stack where some agents are still queued or
  working it never shows, and a done agent's own tag is all you see.
- **An agent's end time moves each time it finishes.** `setAgentStatus` sets
  `ended_at = now` on every `done`/`failed`/`stopped` (`packages/daemon/src/session/store.ts:592-608`),
  and `Agent.endedAt` is on the wire (`packages/shared/src/wire.ts:111`). So "the end time
  you saw" works per agent exactly as it does per job. No daemon or wire change is needed.
- **Settings are written whole.** `parseSeen` rebuilds only `{ since, jobs }`
  (`seen.ts:42-56`), and `serializeSeen` writes only those (`seen.ts:58-60`). A browser tab
  still running the old bundle would therefore drop any field we added the next time it
  marked a job seen.

## Options

### Where the tag's state comes from

| Option | What you see | Cost | Risk | Later |
|---|---|---|---|---|
| **A. Seen per agent, keyed by its end time** (chosen by the user) | A done agent says **finished** until you open it, then not; again after it finishes again | One pure rule, one hook and one effect, in the pattern `seen.ts` already has | Low; web only | Per-agent seen can feed a badge or a notification later |
| B. Tie it to the job's seen | Says **finished** only while its job is an unseen finished job | Smallest | A done agent in a job that's still going shows no tag at all | Loses "which agents finished" (TODO item 6 of 7 Oct) |
| C. Drop the agent tag | The Dot alone says done | Smallest | Reverses ADR 0003's decision for everyone | — |

### Where per-agent seen is kept (for A)

| Option | Cost | Risk | Reversible |
|---|---|---|---|
| A1. A new `agents` map inside `conductor.seenJobs` | Shares `since` | An old tab's write drops the map (`seen.ts:42-60`), so tags come back. Upgrading lights every done agent since `since`, which may be weeks | Hard to separate later |
| **A2. A new key, `conductor.seenAgents`, `{ since, agents: { <agentId>: <endedAt seen> } }`** | A second `since`, written once by the same `startSeenOnce` | An old tab never touches it. Agents that ended before the key exists count as seen, so the upgrade doesn't light old ones | Yes: delete the key |

The user's choice was described as an added map inside `conductor.seenJobs`. A2 keeps that
behaviour and avoids both A1 problems, so the plan uses A2. The difference is storage only.

## Decision

**A with A2.**

- `lib/seen.ts` gains the agent half, next to the job half and in its style:

  ```ts
  export const SEEN_AGENTS_KEY = 'conductor.seenAgents';
  export interface SeenAgents { since: string | null; agents: Record<string, string> }
  export function parseSeenAgents(raw: string | null): SeenAgents;     // missing/broken → since null
  export function serializeSeenAgents(s: SeenAgents): string;
  /** Done (not failed or stopped), with an end time after `since` and after the one you saw. */
  export function unseenDoneAgents<A extends Pick<Agent, 'id' | 'status' | 'endedAt'>>(
    agents: readonly A[], seen: SeenAgents): A[];
  /** `ids` kept at the end time each has now; agents not in `agents` dropped. Null if nothing changes. */
  export function markAgentsSeen(seen: SeenAgents, ids: readonly string[],
    agents: readonly Pick<Agent, 'id' | 'endedAt'>[]): SeenAgents | null;
  export function markAgentSeen(id: string | undefined, agents: readonly Pick<Agent, 'id' | 'endedAt'>[]): void; // live, reads the setting now
  export function useUnseenAgents(): ReadonlySet<string>;               // ids
  ```

  `startSeenOnce` also writes `SEEN_AGENTS_KEY` once, if it's missing.
- **Seeing an agent** is having its Agent screen open while the tab is in front. The same
  `Notifier` effect that marks the job (`always.tsx:78-83`) marks the agent, so an agent that
  finishes while you watch it is seen at once, and one that finishes behind another window
  waits for you. Opening its project does not clear an agent's tag: the project marks jobs,
  not agents.
- **The navigator:** `NavAgent` gains `finished: boolean` ("done and not yet seen").
  `navTree` takes the unseen agent ids as a new last parameter, defaulting to an empty set,
  as `finished` does for jobs. `AgentRow` shows the tag on `a.finished`, not on status.
- **The agent tabs:** the tag shows on `t.status === 'done' && unseenAgents.has(t.id)`. The
  open agent's own tab therefore never shows it: you're looking at it.
- **Unchanged:** the job group's **finished** (`Navigator.tsx:172-173`) and its seen; the
  Fleet card, the Project screen's groups, the agent lane's `Tag` (`fleet/lane.tsx:83`) and
  the Agent screen header's status `Tag` (`agent.tsx:617`). Those are status, not news, and
  `STATUS_WORD.done` stays `'finished'`. The tab badge and desktop notifications still count
  jobs only.

## Consequences

- A done agent's **finished** in the navigator and the tabs means "finished since you last
  opened it". The green Dot still says it's done afterwards.
- Seen agents are the same in every browser (Settings), like seen jobs. Entries for agents
  that no longer exist drop out whenever it's written, so it doesn't grow.
- An old tab still on the previous bundle keeps showing the status-based tag until it
  reloads. It can't corrupt the new key, because it never writes it.
- Two quick visits can't lose a mark: `markAgentSeen` reads the setting when it writes, like
  `markJobsSeen` (`seen.ts:134-139`).
- Harder later: nothing. Deleting `conductor.seenAgents` brings back "nothing unseen".
- **Found in review, accepted:** a corrupted `conductor.seenAgents` is not repaired, because
  `startSeenOnce` writes only when the key is missing (`seenJobs` is the same), so no agent
  would say **finished** again until the key is deleted. The fix is to also write when
  `parseSeenAgents(...).since === null`; not done. The tab of the agent you have open never
  says **finished**, as it is seen the moment it ends.
- **Related, separate:** Amendment 106 (the `--you` colour for typed turns) was built in the
  same session on the user's follow-up request. It has no bearing on this decision and has no
  ADR; the CONTRACT amendment is its record.

## Testing

- *(As built: section 34 of `lib/verify.ts`, since 32 and 33 existed. The `Notifier` source
  check is in that section too, not in `attention/`. The validator added
  `lib/verify-seen-agents.ts`, run by `make test`, which drives the real settings store; see
  the plan's "As built".)*
- `packages/web/src/lib/verify.ts`, a new section beside section 31 (`verify.ts:1169-1205`):
  before the key exists nothing is unseen; done after `since` is unseen, failed/stopped/
  working/queued are not, and neither is one that ended before `since`; marking keeps the
  end time; a later end time is unseen again; unknown agents drop out; `markAgentsSeen`
  returns null when nothing changes; the key is `conductor.seenAgents`.
- `packages/web/src/shell/verify.ts`: `navTree` with an unseen set marks only those rows
  `finished`, and none without one; the source check at `:429-431` changes from
  `a.status === 'done' &&` to `a.finished &&`.
- `packages/web/src/agent/verify.ts:477-478`: the source check becomes the unseen form, and
  the source shows the agent screen reading `useUnseenAgents`.
- `packages/web/src/attention/` (or lib/verify.ts): a source check that the `Notifier`
  effect calls `markAgentSeen` under `if (!visible) return`.
- By hand: run a two-agent stack; when the first is done its row and tab say **finished**;
  open it and both clear; re-run it and both say it again once it ends.
