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
  /** e.g. `$4.10 of $25 today`, `$4.10 spent today`, `184k of 500k tokens today`. */
  budget: string;
}

/** The folded line: `ask me · high · sonnet-5-5 · $4.10 of $25 today`. */
export function settingsSummary(s: SettingsLine): string {
  return [s.mode, s.effort, s.model, s.budget].filter((x): x is string => Boolean(x)).join(' · ');
}

/**
 * The budget part, in dollars: spent TODAY, and the daily budget when there is one. Past it
 * (`over`), says so (Amendment 129: the budget is per day, and back to zero at midnight). It is
 * a warning, so there is no "stops at" (Amendment 180).
 */
export function dollarsLine(spent: string, cap: string | null, over = false): string {
  if (cap === null) return `${spent} spent today`;
  return over ? `over today's budget: ${spent} of ${cap}` : `${spent} of ${cap} today`;
}

/** The budget part, in tokens, for an engine that reports no dollars. */
export function tokensLine(used: string, cap: string | null, over = false): string {
  if (cap === null) return `${used} tokens used today`;
  return over ? `over today's budget: ${used} of ${cap} tokens` : `${used} of ${cap} tokens today`;
}

/**
 * What the composer says under the budget while the agent is over it (Amendments 124, 129):
 * that it is today's budget, and only a warning, since nothing stops it (Amendment 180).
 * Figures as the line says them; `tokens` adds the unit.
 */
export function overSays(spent: string, budget: string, tokens = false): string {
  const unit = tokens ? ' tokens' : '';
  return `over today's budget: ${spent} of ${budget}${unit} — a warning only; it keeps working`;
}

/**
 * What the composer says when a working agent's tools, mode or effort change (Amendment 178).
 * Its run takes the mode and effort where its engine can, and the daemon answers whether it
 * did; the tool lists are options of a run's start, so they are always its next run's. Nothing
 * for an agent that isn't working: every run is built from what is set.
 */
export function appliesSays(what: 'tools' | 'mode' | 'effort', working: boolean, appliesTo: 'now' | 'next run'): string {
  if (!working) return '';
  if (what === 'tools') return 'From the next run — this one keeps the tools it started with.';
  return appliesTo === 'now' ? 'Now — this run goes on with it.' : "From the next run — this one couldn't take it.";
}

/** Under the mode row while an agent works: what its run takes from a change (Amendment 178). */
export const WORKING_SAYS = 'mode and effort now · tools and budget from the next run';
