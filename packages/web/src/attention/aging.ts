/**
 * Aging — how long a human has kept an agent waiting, and how bad that is.
 *
 * Track E owns this file.
 *
 * Pure functions, no React. The queue, the bars and the notification ladder all
 * derive from these so "12 minutes" looks identical everywhere it appears.
 *
 * Scale note: the mockup draws a 12m40s wait at 84% of the bar, which puts full
 * scale at 15 minutes. Kept deliberately, so the design reference and the build
 * agree on what "nearly out of patience" looks like.
 */

/** A request at or beyond this has filled its aging bar. */
export const AGE_FULL_MS = 15 * 60_000;

/** The notification ladder's third rung: a sound once a wait passes this. */
export const SOUND_AFTER_MS = 60_000;

/**
 * Severity of a wait. Drives colour and wording, never layout.
 *  - fresh    : under a minute. Nobody has been kept waiting yet.
 *  - waiting  : a minute in. Worth looking at.
 *  - aging    : minutes in. This is costing throughput.
 *  - critical : the agent has been parked long enough that it hurts.
 */
export type AgeTier = 'fresh' | 'waiting' | 'aging' | 'critical';

const TIER_AT_MS: ReadonlyArray<readonly [AgeTier, number]> = [
  ['critical', 12 * 60_000],
  ['aging', 5 * 60_000],
  ['waiting', 60_000],
];

export function waitingMs(createdAt: string, now: number): number {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, now - started);
}

export function ageTier(ms: number): AgeTier {
  for (const [tier, floor] of TIER_AT_MS) {
    if (ms >= floor) return tier;
  }
  return 'fresh';
}

/**
 * 0..1 fill of the aging bar. Floored slightly so a brand-new request still
 * shows a sliver — an empty bar reads as "no data", not "just arrived".
 */
export function ageRatio(ms: number): number {
  return Math.min(1, Math.max(0.02, ms / AGE_FULL_MS));
}

/**
 * The token that should colour a wait's *text*. The bar itself is always the
 * amber→red gradient; the label is what escalates.
 *
 * `--need` on anything here is load-bearing: it means a human is required.
 */
export function ageToken(tier: AgeTier): string {
  switch (tier) {
    case 'critical':
      return 'var(--fail)';
    case 'aging':
    case 'waiting':
      return 'var(--need)';
    case 'fresh':
      return 'var(--ink3)';
  }
}

/**
 * Sizes the fill's gradient to the whole track, so the visible right-hand edge
 * of a *fuller* bar is a redder part of the same amber→red ramp. A 40-second
 * wait shows amber; a 12-minute wait has crept into red. Without this the
 * gradient would be squeezed into whatever width the fill happens to be and
 * every bar would look the same.
 */
export function ageGradientSize(ratio: number): string {
  return `${(100 / Math.max(ratio, 0.01)).toFixed(2)}% 100%`;
}

/** `41s` · `12m 40s` · `1h 04m`. Stable width-ish, no seconds past an hour. */
export function formatWait(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Wording for the queue row under the bar. */
export function ageLabel(ms: number): string {
  const tier = ageTier(ms);
  const t = formatWait(ms);
  return tier === 'aging' || tier === 'critical' ? `${t} — aging` : t;
}
