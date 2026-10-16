/**
 * The slot limit, in one place (Amendment 47). W0's: the supervisor schedules by it, and
 * the hub's empty snapshot reports it.
 */

import { DEFAULT_STACKS, STACKS_MAX } from '@conductor/shared';
import { readSettings, settingRule } from './settings.js';

/**
 * How many agents may run at once (Amendment 47). The Settings tab's `conductor.slots`,
 * else `CONDUCTOR_SLOTS`, else 7 — read on every check, so a change applies at once.
 * Lowering it stops nothing: running agents finish, and nothing new starts until fewer
 * than the limit are running.
 */
export const SLOTS_KEY = 'conductor.slots';
export const SLOTS_MAX = 32;
export const DEFAULT_SLOTS = 7;

export function slotLimit(): number {
  const parse = (v: string | undefined): number | null => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= SLOTS_MAX ? n : null;
  };
  return parse(readSettings()[SLOTS_KEY]) ?? parse(process.env['CONDUCTOR_SLOTS']) ?? DEFAULT_SLOTS;
}

settingRule(SLOTS_KEY, (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= SLOTS_MAX ? null : `a whole number from 1 to ${SLOTS_MAX}`;
});


/**
 * How many stacks one Spawn launch may start (Amendment 181): `conductor.launch.stacks`, from 1
 * to STACKS_MAX, else DEFAULT_STACKS. Read on every batch, as the slot limit is. Each stack is a
 * job, and the slots still decide how many of them run at once.
 */
export const STACKS_KEY = 'conductor.launch.stacks';

export function stacksLimit(): number {
  const v = readSettings()[STACKS_KEY];
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= STACKS_MAX ? n : DEFAULT_STACKS;
}

settingRule(STACKS_KEY, (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= STACKS_MAX ? null : `a whole number from 1 to ${STACKS_MAX}`;
});
