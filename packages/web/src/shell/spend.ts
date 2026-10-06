/**
 * Today's spend against the daily budget, in words and colours (Amendment 59). Pure, so
 * lib/verify.ts checks them.
 *
 * Green while there's room, yellow from 75%, red from 95% — the user's thresholds. Past
 * 100% the bar stays full and red: nothing stops, by the user's choice, so the number
 * keeps going and says so.
 */

export const DAILY_KEY = 'conductor.dailyBudget';
export const WARN_AT = 0.75;
export const OVER_AT = 0.95;

export type SpendTone = 'ok' | 'warn' | 'over';

export function parseBudget(raw: string | null): number | null {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : null;
}

export function dailyMeter(spent: number, budget: number): { fraction: number; tone: SpendTone; label: string; title: string } {
  const fraction = budget > 0 ? spent / budget : 0;
  const tone: SpendTone = fraction >= OVER_AT ? 'over' : fraction >= WARN_AT ? 'warn' : 'ok';
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const pct = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, Math.max(0, fraction)),
    tone,
    label: `${money(spent)} of ${money(budget)} today`,
    title:
      fraction >= 1
        ? `${pct}% of today's budget — ${money(spent - budget)} over. Agents keep going; it only warns.`
        : `${pct}% of today's budget, ${money(budget - spent)} left. Resets at midnight.`,
  };
}

/** A budget as the Settings field says it: empty is none. Why not, or null. */
export function budgetProblem(v: string): string | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? null : 'Dollars, more than 0.';
}
