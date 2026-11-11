/**
 * A rule for a job that repeats, as you set it (Amendment 211): every day at a time, these
 * weekdays at a time, or every N hours. One control for Spawn's repeat… form and the Project
 * screen's edit time, so the two can't offer different rules.
 *
 * The draft keeps every field, so switching from weekdays to every day and back keeps the days
 * you picked; `ruleOf` makes the `Every` the daemon is sent. `everyProblem` (shared) says what is
 * wrong with it, as the daemon will.
 */

import type { Every } from '@conductor/shared';
import { MAX_EVERY_HOURS } from '@conductor/shared';

export interface RuleDraft {
  kind: Every['kind'];
  at: string;
  days: number[];
  n: number;
}

/** What a new rule starts on: every day at 09:00, weekdays picked if you switch to them. */
export const DEFAULT_RULE: RuleDraft = { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5], n: 6 };

/** The rule the draft says. */
export function ruleOf(d: RuleDraft): Every {
  switch (d.kind) {
    case 'daily':
      return { kind: 'daily', at: d.at };
    case 'weekly':
      return { kind: 'weekly', days: d.days, at: d.at };
    case 'hours':
      return { kind: 'hours', n: d.n };
  }
}

/** A kept rule as a draft, the fields it doesn't have from the default. */
export function draftOf(e: Every): RuleDraft {
  switch (e.kind) {
    case 'daily':
      return { ...DEFAULT_RULE, kind: 'daily', at: e.at };
    case 'weekly':
      return { ...DEFAULT_RULE, kind: 'weekly', days: [...e.days], at: e.at };
    case 'hours':
      return { ...DEFAULT_RULE, kind: 'hours', n: e.n };
  }
}

/** The week as it reads, Monday first: the day's number (0 is Sunday) and its letters. */
const WEEK: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

/** The day picked or not: the draft's days, `day` added or taken away. */
export function toggleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}

export function RuleFields({ rule, onChange }: { rule: RuleDraft; onChange: (r: RuleDraft) => void }) {
  return (
    <span className="ui-rule">
      <select
        className="ui-select"
        value={rule.kind}
        onChange={(e) => onChange({ ...rule, kind: e.target.value as Every['kind'] })}
        aria-label="How often"
      >
        <option value="daily">every day at</option>
        <option value="weekly">these weekdays at</option>
        <option value="hours">every N hours</option>
      </select>
      {rule.kind === 'weekly' && (
        <span className="ui-rule-days" role="group" aria-label="Days of the week">
          {WEEK.map(([d, label]) => (
            <button
              key={d}
              type="button"
              className="ui-rule-day"
              aria-pressed={rule.days.includes(d)}
              onClick={() => onChange({ ...rule, days: toggleDay(rule.days, d) })}
            >
              {label}
            </button>
          ))}
        </span>
      )}
      {rule.kind === 'hours' ? (
        <>
          <input
            className="ui-select ui-rule-n"
            type="number"
            min={1}
            max={MAX_EVERY_HOURS}
            step={1}
            value={Number.isFinite(rule.n) ? rule.n : ''}
            onChange={(e) => onChange({ ...rule, n: e.target.value === '' ? NaN : Number(e.target.value) })}
            aria-label="Hours between runs"
          />
          <span className="ui-rule-unit">hours</span>
        </>
      ) : (
        <input
          className="ui-select"
          type="time"
          value={rule.at}
          onChange={(e) => onChange({ ...rule, at: e.target.value })}
          aria-label="At"
        />
      )}
    </span>
  );
}
