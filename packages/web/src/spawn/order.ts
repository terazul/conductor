/**
 * Who each agent waits for follows where it sits in the stack (Amendment 99). Pure, so
 * spawn/verify.ts checks the rules under Node.
 *
 * An agent can only wait for one listed before it, which the daemon enforces since
 * Amendment 98. So the order of the rows is what decides what a row may tick, and moving a
 * row is how you change who waits for whom.
 *
 * Each row waits for the one directly above it by default. The ticks stay for waiting on
 * several rows above, like the full pipeline's reviewer, which waits on three. A move
 * keeps every tick that still points above the row and drops the rest. A row that was on
 * the default — it waited for exactly the row above it — stays on it, so a chain stays a
 * chain whichever row you move.
 *
 * It works on `PresetRole` (a preset's rows, whose waits may be absent) and `CustomRole`
 * (a Custom setup's) alike, and returns new rows: neither the preset nor the setup the
 * rows came from is changed.
 */

import type { AgentRole } from '@conductor/shared';

export interface Waiting {
  role: AgentRole;
  dependsOnRoles?: AgentRole[];
}

const waitsOf = (r: Waiting): AgentRole[] => r.dependsOnRoles ?? [];

/** The row with its waits replaced. */
function withWaits<T extends Waiting>(r: T, waits: AgentRole[]): T {
  return { ...r, dependsOnRoles: waits };
}

/** The roles above row `i`, which is all it may wait for. */
export function rolesAbove(rows: readonly Waiting[], i: number): AgentRole[] {
  return rows.slice(0, i).map((r) => r.role);
}

/**
 * Whether row `i` is on the default: the first row waiting for no one, any other waiting
 * for exactly the row directly above it.
 */
export function onDefault(rows: readonly Waiting[], i: number): boolean {
  const row = rows[i];
  if (!row) return false;
  const waits = waitsOf(row);
  if (i === 0) return waits.length === 0;
  return waits.length === 1 && waits[0] === rows[i - 1]!.role;
}

/** Every row after the first waiting for the one directly above it. */
export function chain<T extends Waiting>(rows: readonly T[]): T[] {
  return rows.map((r, i) => withWaits(r, i === 0 ? [] : [rows[i - 1]!.role]));
}

/**
 * The rows after ticking, or unticking, `on` for row `i`. Only a row above may be ticked;
 * the ticks are kept in the stack's order, whichever was clicked first.
 */
export function toggleWait<T extends Waiting>(rows: readonly T[], i: number, on: AgentRole): T[] {
  const row = rows[i];
  const above = rolesAbove(rows, i);
  if (!row || !above.includes(on)) return [...rows];
  const now = new Set(waitsOf(row));
  if (now.has(on)) now.delete(on);
  else now.add(on);
  const next = [...new Set(above.filter((a) => now.has(a)))];
  return rows.map((r, j) => (j === i ? withWaits(r, next) : r));
}

/**
 * The rows with every tick that points at the row itself, at a row below it, or at no row
 * dropped. A row left waiting for no one that had waited for someone waits for the row
 * above it instead (the first row, with no row above it, waits for no one).
 */
export function recheckWaits<T extends Waiting>(rows: readonly T[]): T[] {
  return rows.map((r, i) => {
    const had = waitsOf(r);
    const above = new Set(rolesAbove(rows, i));
    const kept = had.filter((d) => above.has(d));
    if (kept.length === had.length) return r;
    return withWaits(r, kept.length === 0 && i > 0 ? [rows[i - 1]!.role] : kept);
  });
}

/**
 * The rows after moving the one at `from` to `to`, the others shifting to make room.
 * Out of range, or to where it is, gives the rows back as they were.
 *
 * Then each row's waits follow the new order:
 * - a row that was on the default (waiting for just the row above it) waits for whichever
 *   row is above it now, so a chain stays a chain;
 * - any other row keeps the ticks that still point above it and loses the rest; one left
 *   with none waits for the row above it (`recheckWaits`).
 */
export function moveRow<T extends Waiting>(rows: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [...rows];
  const wasDefault = rows.map((_, i) => onDefault(rows, i));
  const order = rows.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const placed = order.map((i) => rows[i]!);
  return recheckWaits(
    placed.map((r, k) => {
      if (!wasDefault[order[k]!]) return r;
      return withWaits(r, k === 0 ? [] : [placed[k - 1]!.role]);
    }),
  );
}

/** Whether `rows` are `base`: the same roles in the same order, waiting for the same ones. */
export function sameStack(rows: readonly Waiting[], base: readonly Waiting[]): boolean {
  return (
    rows.length === base.length &&
    rows.every((r, i) => r.role === base[i]!.role && waitsOf(r).join() === waitsOf(base[i]!).join())
  );
}
