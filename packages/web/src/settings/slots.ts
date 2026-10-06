/**
 * The slot limit, as the Settings tab edits it (Amendment 47). Mirrors the daemon's
 * rule in `packages/daemon/src/slots.ts`, which is the one that decides — this only lets
 * the field say what is wrong before the daemon refuses it.
 */

export const SLOTS_KEY = 'conductor.slots';
export const SLOTS_MAX = 32;
export const SLOTS_DEFAULT = 7;

export function slotsProblem(v: string): string | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= SLOTS_MAX
    ? null
    : `A whole number from 1 to ${SLOTS_MAX}.`;
}
