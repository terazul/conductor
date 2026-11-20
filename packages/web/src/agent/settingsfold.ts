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

/**
 * What ⏎ does in the message box (Amendment 203). Absent is send, as it always was; ticking
 * **⏎ new line** makes ⏎ a new line, for a long message, and then only **send** sends. Kept in
 * Settings, so it's the same in every browser. This key was one setting for every agent; since
 * Amendment 220 it is only what an agent with no choice of its own does (`ENTER_AGENTS_KEY`).
 */
export const ENTER_KEY = 'conductor.enterNewline';

/** Whether ⏎ sends. Anything but `newline` is send. */
export function enterSends(raw: string | null): boolean {
  return raw !== 'newline';
}

/**
 * Each agent's own ⏎ new line (Amendment 220), kept in Settings as `{agentId: 'newline' | 'send'}`.
 * Ticking or unticking on one agent writes only that agent's choice; an agent with none does what
 * `ENTER_KEY` says, so a box ticked before reads as it did.
 */
export const ENTER_AGENTS_KEY = 'conductor.agentEnterNewline';
/** The agents kept, the newest choice last, as the folds are bounded (Amendment 33). */
export const MAX_ENTER_AGENTS = 200;

export type EnterChoices = Readonly<Record<string, 'newline' | 'send'>>;

/** Anything stored that isn't a set of choices is none, not an error. */
export function parseEnterChoices(raw: string | null): EnterChoices {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, 'newline' | 'send'> = {};
    for (const [id, c] of Object.entries(v)) if (c === 'newline' || c === 'send') out[id] = c;
    return out;
  } catch {
    return {};
  }
}

/** Whether ⏎ sends on this agent: its own choice, else the one setting from before (`global`). */
export function agentEnterSends(choices: EnterChoices, agentId: string, global: string | null): boolean {
  const own = choices[agentId];
  return own === undefined ? enterSends(global) : own === 'send';
}

/**
 * This agent's box ticked (`newline`) or unticked, made the newest choice, and every agent not in
 * `known` dropped, when it is given, as the reply ticks are (`setAck`).
 */
export function setEnterChoice(
  choices: EnterChoices,
  agentId: string,
  newline: boolean,
  known?: ReadonlySet<string>,
): EnterChoices {
  const out: Record<string, 'newline' | 'send'> = {};
  for (const [id, c] of Object.entries(choices)) if (id !== agentId && (!known || known.has(id))) out[id] = c;
  out[agentId] = newline ? 'newline' : 'send';
  const ids = Object.keys(out);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTER_AGENTS))) delete out[id];
  return out;
}

/**
 * What a key press in the message box does: send it, or leave the key to the box (a new line).
 * ⇧⏎ and ⌥⏎ are always a new line; plain ⏎ sends only while ⏎ sends. A ⏎ that picks a word
 * while typing Japanese or Chinese (`composing`) is the input method's, never a send, as the
 * navigator's new-file box already has it.
 */
export function enterAction(
  e: { key: string; shiftKey: boolean; altKey: boolean; composing?: boolean },
  sends: boolean,
): 'send' | 'type' {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.composing && sends ? 'send' : 'type';
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
  /** The when-done steps that are on, in order, as their pills name them (Amendment 219). */
  whenDone?: string[];
}

/**
 * The folded line: `ask me · high · sonnet-5-5 · when done: commit, test, merge · $4.10 of $25 today`.
 * With no when-done step on, that part is left out rather than saying none.
 */
export function settingsSummary(s: SettingsLine): string {
  const steps = s.whenDone && s.whenDone.length > 0 ? `when done: ${s.whenDone.join(', ')}` : null;
  return [s.mode, s.effort, s.model, steps, s.budget].filter((x): x is string => Boolean(x)).join(' · ');
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
