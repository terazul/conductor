/**
 * A status's colour token and its word.  TRACK B.
 *
 * Here, not in ui.tsx, so a pure rule can use them under Node, where ui.tsx's stylesheet
 * doesn't load: the headline tags (fleet/rest.ts, Amendment 194) are checked there.
 * ui.tsx re-exports both, and every screen still imports them from it.
 */

import type { AgentStatus } from '@conductor/shared';

/** The token families a tag can be drawn in. */
export type Tone = 'live' | 'need' | 'fail' | 'done' | 'queue' | 'idle';

/** AgentStatus → token family. The single place the mapping is decided. */
export const STATUS_KEY: Record<AgentStatus, Tone> = {
  working: 'live',
  blocked: 'need',
  failed: 'fail',
  done: 'done',
  queued: 'queue',
  paused: 'idle',
  // --idle, not --fail. Terminating an agent is a decision, not a fault, and a red
  // card would read as "something went wrong here" every time you tidied up.
  stopped: 'idle',
};

/**
 * Short label for a status tag. `done` reads `finished` (Amendment 93) — plain,
 * not "unseen" or "new": that distinction stays per job, in `lib/seen.ts`.
 */
export const STATUS_WORD: Record<AgentStatus, string> = {
  working: 'working',
  blocked: 'needs you',
  failed: 'failed',
  done: 'finished',
  queued: 'queued',
  paused: 'paused',
  stopped: 'stopped',
};
