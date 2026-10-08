/**
 * The agent's settings under the message box, folded or open (Amendment 96).
 *
 * Folded hides the guardrails pills and the interaction, effort, model and budget rows,
 * so the transcript gets the room. What they're set to stays in sight as one line, and a
 * budget that's reached or an unsafe mode still says so. Send and the message box don't
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

/** The budget part, in dollars: spent, and the cap when there is one. */
export function dollarsLine(spent: string, cap: string | null): string {
  return cap === null ? `${spent} spent` : `${spent} of ${cap}`;
}

/** The budget part, in tokens, for an engine that reports no dollars. */
export function tokensLine(used: string, cap: string | null): string {
  return cap === null ? `${used} tokens used` : `${used} of ${cap} tokens`;
}
