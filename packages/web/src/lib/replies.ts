/**
 * Which of an agent's replies you have read (Amendment 193).
 *
 * A REPLY is what an agent wrote after its last tool call or ask, once that turn is over
 * (`splitTurn`, agent/transcript.tsx). Until you tick it, it stays open in the transcript with
 * its **Read it** box, and the agent's row in the navigator and its tab on the Agent screen say
 * **to read**. Only the box marks it: sending the agent a message doesn't, since you may have
 * answered only half of what it said.
 *
 * Kept in Settings (`conductor.replyAcks`), so it is the same in every browser, as
 * `{ sinceSeq, agents: { <agentId>: [seq…] } }`. A reply is named by the seq of its last prose
 * event, the transcript's `p${seq}` key, which is also the daemon's `replySeq`:
 *
 *  - `sinceSeq` is the hub's seq when this browser first kept it. Every reply at or below it
 *    counts as read, so the replies there were before this change don't all need ticking.
 *    Before the key exists nothing is unread; `startAcks` writes it once the settings and the
 *    snapshot have arrived, as `startSeenOnce` does for jobs.
 *  - Each agent keeps the seqs you ticked, above `sinceSeq`. Agents that no longer exist drop
 *    out whenever it is written, and each keeps its newest `MAX_ACKS`, so it doesn't grow.
 *
 * The navigator and the tabs know only each agent's LATEST reply (`replySeq`), since the web
 * holds events only for the agents you opened. An earlier reply you haven't ticked shows open in
 * its transcript, but doesn't light the row.
 *
 * The rules are pure, for agent/verify.ts; the hooks at the bottom read the store.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { Agent } from '@conductor/shared';
import { onSettings, readSetting, settingsLoaded, writeSetting } from './settings.js';
import { store, useAgents } from './store.js';

export const REPLY_ACKS_KEY = 'conductor.replyAcks';
/** The ticked replies kept per agent, newest kept. */
export const MAX_ACKS = 200;

export interface ReplyAcks {
  /** The hub's seq when it was first kept; null before then, when nothing is unread. */
  sinceSeq: number | null;
  /** Each agent's ticked replies, by seq, oldest first. */
  agents: Record<string, number[]>;
}

/** The stored value. Missing or broken is "not kept yet": nothing is unread. */
export function parseAcks(raw: string | null): ReplyAcks {
  const none: ReplyAcks = { sinceSeq: null, agents: {} };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return none;
    const o = v as { sinceSeq?: unknown; agents?: unknown };
    if (typeof o.sinceSeq !== 'number' || !Number.isFinite(o.sinceSeq)) return none;
    const agents: Record<string, number[]> = {};
    if (o.agents && typeof o.agents === 'object' && !Array.isArray(o.agents)) {
      for (const [id, seqs] of Object.entries(o.agents)) {
        if (!Array.isArray(seqs)) continue;
        const ok = seqs.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-MAX_ACKS);
        if (ok.length > 0) agents[id] = ok;
      }
    }
    return { sinceSeq: o.sinceSeq, agents };
  } catch {
    return none;
  }
}

export function serializeAcks(a: ReplyAcks): string {
  return JSON.stringify({ sinceSeq: a.sinceSeq, agents: a.agents });
}

/** Kept from `seq`: every reply there is now counts as read. */
export function startAcks(seq: number): ReplyAcks {
  return { sinceSeq: seq, agents: {} };
}

/** Read: from before it was kept, or ticked. Before it is kept at all, everything is. */
export function isRead(a: ReplyAcks, agentId: string, seq: number): boolean {
  if (a.sinceSeq === null || seq <= a.sinceSeq) return true;
  return a.agents[agentId]?.includes(seq) ?? false;
}

/** A reply from before `sinceSeq` is read whatever you do; only a later one can be unticked. */
export function canUntick(a: ReplyAcks, seq: number): boolean {
  return a.sinceSeq !== null && seq > a.sinceSeq;
}

/**
 * `seq` ticked (`read`) or unticked, and every agent not in `known` dropped, when it is given.
 * Null when nothing would change, so a caller writes only a real change.
 */
export function setAck(
  a: ReplyAcks,
  agentId: string,
  seq: number,
  read: boolean,
  known?: ReadonlySet<string>,
): ReplyAcks | null {
  if (a.sinceSeq === null || seq <= a.sinceSeq) return null;
  const agents: Record<string, number[]> = {};
  for (const [id, seqs] of Object.entries(a.agents)) if (!known || known.has(id) || id === agentId) agents[id] = seqs;
  const now = (agents[agentId] ?? []).filter((n) => n !== seq);
  const next = (read ? [...now, seq].sort((x, y) => x - y) : now).slice(-MAX_ACKS);
  if (next.length > 0) agents[agentId] = next;
  else delete agents[agentId];
  const out = { sinceSeq: a.sinceSeq, agents };
  return serializeAcks(out) === serializeAcks(a) ? null : out;
}

/**
 * Every one of `seqs` ticked at once ("mark all read", Amendment 200), under `setAck`'s rules: a
 * seq at or below `sinceSeq` is read already and left out, the newest `MAX_ACKS` are kept, and
 * every agent not in `known` drops out. Null when nothing would change.
 */
export function setAcksAll(
  a: ReplyAcks,
  agentId: string,
  seqs: readonly number[],
  known?: ReadonlySet<string>,
): ReplyAcks | null {
  const since = a.sinceSeq;
  if (since === null) return null;
  const agents: Record<string, number[]> = {};
  for (const [id, kept] of Object.entries(a.agents)) if (!known || known.has(id) || id === agentId) agents[id] = kept;
  const now = agents[agentId] ?? [];
  const add = seqs.filter((n, i) => n > since && !now.includes(n) && seqs.indexOf(n) === i);
  const next = [...now, ...add].sort((x, y) => x - y).slice(-MAX_ACKS);
  if (next.length > 0) agents[agentId] = next;
  const out = { sinceSeq: since, agents };
  return serializeAcks(out) === serializeAcks(a) ? null : out;
}

/** The agents whose latest reply (`replySeq`, from the daemon) you haven't ticked. */
export function toRead(agents: readonly Pick<Agent, 'id' | 'replySeq'>[], a: ReplyAcks): Set<string> {
  return new Set(agents.filter((g) => g.replySeq !== undefined && !isRead(a, g.id, g.replySeq)).map((g) => g.id));
}

// ── the live state ──────────────────────────────────────────────────────────

/**
 * Write `sinceSeq` if no browser has yet. Only once the daemon's settings are in, or another
 * browser's key would be written over; `seq` is the hub's, from the snapshot that brought them.
 */
export function startAcksOnce(seq: number): void {
  if (!settingsLoaded() || readSetting(REPLY_ACKS_KEY) !== null) return;
  writeSetting(REPLY_ACKS_KEY, serializeAcks(startAcks(seq)));
}

/**
 * Tick or untick one reply, read from the settings now so two quick ticks both land. The agents
 * the hub no longer has drop out as it is written; none do before the snapshot has any.
 */
export function markReply(agentId: string, seq: number, read: boolean): void {
  const ids = store.select('agents:*', (s) => s.agents).map((a) => a.id);
  const next = setAck(parseAcks(readSetting(REPLY_ACKS_KEY)), agentId, seq, read, ids.length > 0 ? new Set(ids) : undefined);
  if (next) writeSetting(REPLY_ACKS_KEY, serializeAcks(next));
}

/** Tick all of `seqs` on this agent read, in one write: `markReply` for many (Amendment 200). */
export function markReplies(agentId: string, seqs: readonly number[]): void {
  const ids = store.select('agents:*', (s) => s.agents).map((a) => a.id);
  const next = setAcksAll(parseAcks(readSetting(REPLY_ACKS_KEY)), agentId, seqs, ids.length > 0 ? new Set(ids) : undefined);
  if (next) writeSetting(REPLY_ACKS_KEY, serializeAcks(next));
}

const readAcks = (): string | null => readSetting(REPLY_ACKS_KEY);

// `readAcks` is the server snapshot too, as folds.ts's is, so agent/verify.ts can render a transcript under Node.
export function useReplyAcks(): ReplyAcks {
  const raw = useSyncExternalStore(onSettings, readAcks, readAcks);
  return useMemo(() => parseAcks(raw), [raw]);
}

/** The ids of every agent whose latest reply you haven't ticked: **to read**. */
export function useToRead(): ReadonlySet<string> {
  const agents = useAgents();
  const acks = useReplyAcks();
  return useMemo(() => toRead(agents, acks), [agents, acks]);
}
