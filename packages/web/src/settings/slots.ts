/**
 * The slot limit, as the Settings tab edits it (Amendment 47). Mirrors the daemon's
 * rule in `packages/daemon/src/slots.ts`, which is the one that decides — this only lets
 * the field say what is wrong before the daemon refuses it.
 */

import { DEFAULT_STACKS, STACKS_MAX } from '@conductor/shared';

export const SLOTS_KEY = 'conductor.slots';
export const SLOTS_MAX = 32;
export const SLOTS_DEFAULT = 7;

export function slotsProblem(v: string): string | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= SLOTS_MAX
    ? null
    : `A whole number from 1 to ${SLOTS_MAX}.`;
}

/**
 * How many stacks one Spawn launch may start (Amendment 178), as `stacksLimit()` in the same
 * daemon file reads `conductor.launch.stacks`. The count and its bounds are shared's.
 */
export { STACKS_KEY } from '../spawn/launch.js';
export const STACKS_DEFAULT = DEFAULT_STACKS;
export { STACKS_MAX };

export function stacksProblem(v: string): string | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= STACKS_MAX
    ? null
    : `A whole number from 1 to ${STACKS_MAX}.`;
}
