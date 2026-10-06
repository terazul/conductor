/**
 * Light or dark.  TRACK B.
 *
 * Follows the system setting until you pick one, and remembers the pick in the
 * settings file (Amendment 46), so every browser follows it. The theme is only a
 * `data-theme` attribute on <html>; tokens.css does the rest, which is why no screen
 * knows which theme it is in.
 *
 * The rules are exported apart from the DOM work (Amendment 9), so lib/verify.ts
 * can check them under Node.
 */

import { useSyncExternalStore } from 'react';
import { onSettings, readSetting, writeSetting } from '../lib/settings.js';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'conductor.theme';
const ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** Anything stored that isn't a choice we know — including nothing — is "system". */
export function parseChoice(stored: string | null): ThemeChoice {
  return ORDER.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

/** The toggle cycles, so one control reaches all three. */
export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? 'system';
}

// ── the DOM side ────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;

function readChoice(): ThemeChoice {
  return parseChoice(readSetting(KEY));
}

function apply(): void {
  document.documentElement.dataset['theme'] = resolveTheme(readChoice(), media?.matches ?? true);
  for (const l of listeners) l();
}

/**
 * Called once, at import time of the shell, so the attribute is set before React's
 * first render and the app never paints in the wrong theme.
 */
export function installTheme(): void {
  if (media) return;
  media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', apply);
  // Another tab picked, or the daemon's settings just arrived. Only when it's the theme.
  let last = readChoice();
  onSettings(() => {
    const now = readChoice();
    if (now !== last) {
      last = now;
      apply();
    }
  });
  apply();
}

export function chooseTheme(choice: ThemeChoice): void {
  writeSetting(KEY, choice === 'system' ? null : choice);
  apply();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** `choice|theme`, a string so useSyncExternalStore can compare snapshots by value. */
function snapshot(): string {
  return `${readChoice()}|${document.documentElement.dataset['theme'] ?? 'dark'}`;
}

export function useTheme(): { choice: ThemeChoice; theme: Theme } {
  // A server render (the Node checks) has no document: dark, which is the app's default.
  const [choice, theme] = useSyncExternalStore(subscribe, snapshot, () => 'system|dark').split('|');
  return { choice: parseChoice(choice ?? null), theme: theme === 'light' ? 'light' : 'dark' };
}
