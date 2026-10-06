/**
 * Where the transcript should scroll when something changes.  TRACK B.  (F15)
 *
 * Pure, so `agent/verify.ts` can test the decision without a browser. `agent.tsx`
 * measures and applies it.
 */

/** Within this many px of the bottom counts as "reading the latest", and is followed. */
export const FOLLOW_PX = 220;

export type ScrollIntent = 'jump' | 'follow' | 'stay';

/**
 * `jump` — you just arrived. A freshly mounted scroller sits at the top, and one reused
 *          from another agent sits wherever that one was left, so the follow rule would
 *          never fire: you'd land on the oldest events. Arriving means the bottom.
 * `follow` — you were reading the latest, so the new event joins you there.
 * `stay` — you scrolled up to read history; it isn't pulled away from you.
 *
 * `landedOn` is the agent the view last jumped to. An agent whose events are still empty
 * hasn't been landed on — its history is on the way (Amendment 27), and the landing is
 * when that arrives.
 *
 * `fromBottom` is where the reader was BEFORE this change, not after it. Measured after,
 * one tall event (a long report, an open diff) would push a reader who was at the bottom
 * past the threshold, and the stream would stop following them for no reason they did.
 */
export function scrollIntent(s: {
  landedOn: string | null;
  agentId: string | null;
  eventCount: number;
  fromBottom: number;
}): ScrollIntent {
  if (s.agentId === null || s.eventCount === 0) return 'stay';
  if (s.landedOn !== s.agentId) return 'jump';
  return s.fromBottom < FOLLOW_PX ? 'follow' : 'stay';
}
