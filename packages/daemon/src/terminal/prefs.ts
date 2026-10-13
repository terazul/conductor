/**
 * The terminal's settings, as the daemon keeps them (Amendment 141).
 *
 *   conductor.terminal.fontSize    9 to 24, default 13       the page draws with it
 *   conductor.terminal.scrollback  1,000 to 100,000, 5,000   the page, and the headless mirror
 *   conductor.terminal.shell       one of `shells()`         what a new terminal runs
 *
 * Each has a rule (`settingRule`, settings.ts:33), so a bad value is refused at the PATCH, as
 * `conductor.slots` is (slots.ts:26-29). The shell's rule asks this machine which shells it has
 * each time, so one installed while the daemon runs can be chosen at once.
 */

import { existsSync, readFileSync } from 'node:fs';
import { TERM_FONT_SIZE, TERM_SCROLLBACK, TERM_SHELL_KEY, termNumber, type TermShell } from '@conductor/shared';
import { readSettings, settingRule } from '../settings.js';
import { findShells, pickShell, type ShellChoice } from './shell.js';

function etcShells(): string {
  try {
    return readFileSync('/etc/shells', 'utf8');
  } catch {
    return '';
  }
}

/** The shells on this machine. */
export function shells(): TermShell[] {
  return findShells(process.env, existsSync, etcShells());
}

/** What a new terminal runs: the setting's shell if it is still here, else the default. */
export function chosenShell(): ShellChoice {
  return pickShell(process.env, existsSync, readSettings()[TERM_SHELL_KEY] ?? null, shells());
}

/** The shell used when the setting is empty. */
export function defaultShell(): string {
  return pickShell(process.env, existsSync).file;
}

/** How many lines the headless mirror keeps above the screen, the same number the page keeps. */
export function scrollbackLines(): number {
  return termNumber(readSettings()[TERM_SCROLLBACK.key], TERM_SCROLLBACK) ?? TERM_SCROLLBACK.fallback;
}

const range = (r: { min: number; max: number }) => (v: string) =>
  termNumber(v, r) === null ? `a whole number from ${r.min.toLocaleString('en-US')} to ${r.max.toLocaleString('en-US')}` : null;

settingRule(TERM_FONT_SIZE.key, range(TERM_FONT_SIZE));
settingRule(TERM_SCROLLBACK.key, range(TERM_SCROLLBACK));
settingRule(TERM_SHELL_KEY, (v) => {
  const found = shells();
  return found.some((s) => s.path === v) ? null : `not a shell on this machine; one of ${found.map((s) => s.path).join(', ') || '(none found)'}`;
});
