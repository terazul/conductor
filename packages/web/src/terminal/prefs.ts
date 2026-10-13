/**
 * The terminal's settings, as the page reads and the Settings screen edits them (Amendment 141).
 *
 * The keys and ranges are shared (`TERM_FONT_SIZE`, `TERM_SCROLLBACK`, shared/src/wire.ts) and
 * the daemon has the rule that decides (daemon/src/terminal/prefs.ts); these only read a value
 * as a number, with the default for anything that is not one, and let a field say what is wrong
 * before the daemon refuses it, as settings/slots.ts does for the slot limit.
 *
 * Pure: no DOM, no store. agent/verify.ts runs it under node.
 */

import { TERM_FONT_SIZE, TERM_SCROLLBACK, termNumber } from '@conductor/shared';

export { TERM_FONT_SIZE, TERM_SCROLLBACK, TERM_SHELL_KEY } from '@conductor/shared';

/** The font size to draw at: the setting's, else 13. */
export function fontSizeOf(raw: string | null): number {
  return termNumber(raw, TERM_FONT_SIZE) ?? TERM_FONT_SIZE.fallback;
}

/** The lines kept above the screen: the setting's, else 5,000. */
export function scrollbackOf(raw: string | null): number {
  return termNumber(raw, TERM_SCROLLBACK) ?? TERM_SCROLLBACK.fallback;
}

/** What a field would say about a draft: null when the daemon would take it. */
export function termNumberProblem(draft: string, range: { min: number; max: number }): string | null {
  return termNumber(draft, range) === null
    ? `A whole number from ${range.min.toLocaleString('en-US')} to ${range.max.toLocaleString('en-US')}.`
    : null;
}

/** What to write for a draft: nothing (the default) when it is the default, so the file keeps only choices. */
export function termNumberValue(draft: string, range: { fallback: number }): string | null {
  const v = draft.trim();
  return v === String(range.fallback) ? null : v;
}

/** Whether the Terminal dock is up (Amendment 141): `open`, or absent for down. A setting, as the navigator's is. */
export const DOCK_OPEN_KEY = 'conductor.terminal.dock';

export function dockShown(raw: string | null): boolean {
  return raw === 'open';
}

/** The value that flips it: down is absent, so the file keeps only the choice. */
export function dockFlipped(raw: string | null): string | null {
  return dockShown(raw) ? null : 'open';
}
