/**
 * The agent's settings under the message box, folded or open (Amendment 96).
 *
 * Folded hides the guardrails pills and the interaction, effort, model and budget rows,
 * so the transcript gets the room. What they're set to stays in sight as one line, and a
 * budget that's passed (Amendment 124) or an unsafe mode still says so. Send and the message box don't
 * fold. One setting for every agent, kept in Settings like the details panel
 * (`conductor.agentDetails`), so it's the same in every browser.
 */

export const SETTINGS_KEY = 'conductor.agentSettings';

/** Absent is open, so a first visit shows everything, as before. */
export function settingsShown(raw: string | null): boolean {
  return raw !== 'hidden';
}

/** What the setting becomes when the button is pressed. */
export function settingsToggled(raw: string | null): 'hidden' | 'shown' {
  return settingsShown(raw) ? 'hidden' : 'shown';
}

export interface SettingsLine {
  /** The interaction mode's label, e.g. `ask me`. */
  mode: string;
  /** Null where the engine has no effort. */
  effort: string | null;
  /** Short, e.g. `sonnet-5-5`. */
  model: string;
  /** e.g. `$4.10 of $25`, `$4.10 spent`, `184k of 500k tokens`. */
  budget: string;
}

/** The folded line: `ask me · high · sonnet-5-5 · $4.10 of $25`. */
export function settingsSummary(s: SettingsLine): string {
  return [s.mode, s.effort, s.model, s.budget].filter((x): x is string => Boolean(x)).join(' · ');
}

/** Where an agent past its budget stands, for the folded line (Amendment 124). */
export interface OverLine {
  /** `over` is a warning, `ceiling` has stopped it. */
  state: 'over' | 'ceiling';
  /** What stops it, as the line says it: `$50`, `1M`. */
  ceiling: string;
}

/** The budget part, in dollars: spent, and the budget when there is one. Past it, says so. */
export function dollarsLine(spent: string, cap: string | null, over?: OverLine): string {
  if (cap === null) return `${spent} spent`;
  if (over?.state === 'ceiling') return `budget reached: ${spent} of ${cap}`;
  return over ? `over budget: ${spent} of ${cap}, stops at ${over.ceiling}` : `${spent} of ${cap}`;
}

/** The budget part, in tokens, for an engine that reports no dollars. */
export function tokensLine(used: string, cap: string | null, over?: OverLine): string {
  if (cap === null) return `${used} tokens used`;
  if (over?.state === 'ceiling') return `budget reached: ${used} of ${cap} tokens`;
  return over ? `over budget: ${used} of ${cap} tokens, stops at ${over.ceiling}` : `${used} of ${cap} tokens`;
}

/**
 * What the composer says under the budget while the agent is over it and not yet stopped
 * (Amendment 124): that it is only a warning, and where it stops. Figures as the line says
 * them; `tokens` adds the unit after each.
 */
export function overSays(spent: string, budget: string, ceiling: string, tokens = false): string {
  const unit = tokens ? ' tokens' : '';
  return `over budget: ${spent} of ${budget}${unit} — a warning only; stops at ${ceiling}${unit}`;
}
