/**
 * How long an agent waits before each try when the model can't be reached (Amendments 123, 140).
 *
 * The delays were fixed at 5 s, 15 s, 30 s, 60 s and 5 min (daemon/src/session/retry.ts:26).
 * They are a setting now, `conductor.retryDelays`: one to five whole numbers of seconds,
 * separated by commas, each from 1 s to 30 min. How many there are is how many tries an agent
 * gets. The rule is here so the daemon, which refuses a bad value at the PATCH, and the
 * Settings field, which says what is wrong before it is sent, read it the same way.
 */

export const RETRY_DELAYS_KEY = 'conductor.retryDelays';
/** The schedule with no setting, in seconds. */
export const RETRY_DELAYS_DEFAULT_S: readonly number[] = [5, 15, 30, 60, 300];
export const RETRY_TRIES_MAX = 5;
export const RETRY_DELAY_MIN_S = 1;
export const RETRY_DELAY_MAX_S = 1800;

/** The setting's value as seconds, in order, or null when it is not one. `5, 15,30` is [5, 15, 30]. */
export function parseRetryDelays(v: string | null | undefined): number[] | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const parts = v.split(',').map((p) => p.trim());
  if (parts.length > RETRY_TRIES_MAX) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < RETRY_DELAY_MIN_S || n > RETRY_DELAY_MAX_S) return null;
    out.push(n);
  }
  return out;
}

/** Why a value won't do for the delays, or null. */
export function retryDelaysProblem(v: string): string | null {
  return parseRetryDelays(v) === null
    ? `one to ${RETRY_TRIES_MAX} whole numbers of seconds, separated by commas, each from ${RETRY_DELAY_MIN_S} to ${RETRY_DELAY_MAX_S}`
    : null;
}

/** The delays as the setting writes them: `5, 15, 30, 60, 300`. */
export function retryDelaysText(seconds: readonly number[]): string {
  return seconds.join(', ');
}

/**
 * From which retry the card is in Needs You, the agent's line and banner amber (Amendment
 * 140, Q3 of wave 10): the first. It was the second (Amendment 123), the first being a 5 s
 * blip; with the delays a setting the first can be long, and a stopped agent is worth a look.
 * The daemon's alert (daemon/src/session/retry.ts) and the page's line read this one figure.
 */
export const RETRY_CARD_FROM = 1;
