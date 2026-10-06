/**
 * What you're typing, kept outside the component that shows it (Amendment 64).
 *
 * The reply box and Spawn's prompt kept their text in component state, so anything that
 * remounted them threw it away — switching reply ↔ terminal, switching agent tab or
 * screen, or a page reload (Vite reloads the page when the code changes under a running
 * dev server). Three times, instructions half-typed to an agent were gone.
 *
 * Drafts live here and in this tab's sessionStorage: they survive remounts and reloads,
 * stay per tab (two tabs typing to one agent don't fight), and go when the tab closes.
 * Not settings: a draft isn't a preference, and syncing one to every browser would be odd.
 */

import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'conductor.drafts';

function load(): Record<string, string> {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let drafts: Record<string, string> = load();
const listeners = new Set<() => void>();

export function readDraft(key: string): string {
  return drafts[key] ?? '';
}

export function writeDraft(key: string, text: string): void {
  if ((drafts[key] ?? '') === text) return;
  drafts = { ...drafts };
  if (text) drafts[key] = text;
  else delete drafts[key];
  try {
    sessionStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // No sessionStorage (a policy, or Node): kept for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Like useState(''), but the text outlives the component. */
export function useDraft(key: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(subscribe, () => readDraft(key), () => '');
  const set = useCallback((t: string) => writeDraft(key, t), [key]);
  return [text, set];
}
