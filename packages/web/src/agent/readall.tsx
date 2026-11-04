/**
 * "Mark all read": every reply on an agent ticked read at once, and folded (Amendment 200, of
 * 193's Read it box). Beside "fold all" on the Agent screen, only while there is one to tick.
 *
 * One click is one settings write (`markReplies`), not one per reply, and each reply it ticks
 * goes back to the fold a read reply starts in, as one tick does (`closeRead`).
 *
 * Its own file, apart from agent.tsx, so agent/verify.ts can render it under Node.
 */

import { isRead, markReplies, type ReplyAcks } from '../lib/replies.js';
import { closeRead, updateFoldState } from './folds.js';
import { splitTurn, type Turn } from './transcript.js';

/** What "mark all read" ticks: the seqs to mark, and the turns they fold. */
export interface ToTick {
  seqs: number[];
  keys: string[];
}

/**
 * The replies you haven't ticked, by the seq Read it marks (`splitTurn`'s `replySeq`), and the
 * turns that hold them. `streaming` is whether the last turn is still going, as `replyStates` has it.
 *
 * The transcript holds only the events this tab kept (`MAX_EVENTS_PER_AGENT`, lib/store.ts), so
 * the agent's latest reply, `replySeq` from the daemon, is ticked as well when it is unread: its
 * row and tab say to read by it alone, and must clear even if its events have dropped out here.
 */
export function toTick(
  turns: readonly Turn[],
  streaming: boolean,
  agentId: string,
  acks: ReplyAcks,
  replySeq: number | undefined,
): ToTick {
  const seqs: number[] = [];
  const keys: string[] = [];
  if (acks.sinceSeq === null) return { seqs, keys };
  turns.forEach((t, i) => {
    if (t.who !== 'agent') return;
    const seq = splitTurn(t, streaming && i === turns.length - 1).replySeq;
    if (seq === null || isRead(acks, agentId, seq)) return;
    seqs.push(seq);
    keys.push(t.key);
  });
  if (replySeq !== undefined && !isRead(acks, agentId, replySeq) && !seqs.includes(replySeq)) seqs.push(replySeq);
  return { seqs, keys };
}

/** Tick them all in one write, and fold every one of them. */
export function readAll(agentId: string, tick: ToTick): void {
  markReplies(agentId, tick.seqs);
  updateFoldState((s) => closeRead(s, agentId, tick.keys));
}

/** The button, in "fold all"'s style. Nothing while there is nothing to tick. */
export function ReadAllButton({ agentId, tick }: { agentId: string; tick: ToTick }) {
  const n = tick.seqs.length;
  if (n === 0) return null;
  return (
    <button
      type="button"
      className="fl-btn is-ghost"
      aria-label={`Mark all ${n} unread repl${n === 1 ? 'y' : 'ies'} read`}
      title="Tick every reply on this agent read, and fold them"
      onClick={() => readAll(agentId, tick)}
    >
      ✓ mark all read ({n})
    </button>
  );
}
