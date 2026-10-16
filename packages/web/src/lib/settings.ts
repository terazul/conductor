/**
 * Settings, kept by the daemon in `~/.conductor/settings.json` (Amendment 46).
 *
 * Theme, panel sizes, folds, the Files tabs, notification choices: each used to sit in
 * this browser's localStorage, so a second browser started from nothing. Now they come
 * with the snapshot, change by PATCH, and arrive in every other tab as a `settings`
 * frame. Keys and values are exactly what localStorage held, so each reader parses what
 * it always parsed.
 *
 * WRITES ARE LOCAL FIRST. `writeSetting` changes the value here at once and sends it a
 * moment later, batched: dragging a splitter asks for a new size on every frame, and
 * the daemon needs the last one, not sixty. Until the daemon has taken a write, a frame
 * from it cannot undo the write (`mergeIncoming`).
 *
 * WHAT WAS IN localStorage MOVES ONCE. The first time the daemon's settings arrive, any
 * `conductor.*` key it doesn't have is sent up from this browser and removed here, so
 * the file is the one place from then on (`importable`).
 *
 * UNTIL THEY ARRIVE, localStorage still answers, and still takes writes. That covers a
 * fixture replay, which has no daemon, and a daemon started before this change, whose
 * snapshot has no settings in it: both behave exactly as before, and the move happens
 * whenever a daemon that keeps settings first answers.
 */

import { useSyncExternalStore } from 'react';
import { api } from './feed.js';
import { ApiError } from './errors.js';

export type SettingsMap = Record<string, string>;

const FLUSH_MS = 300;
const PREFIX = 'conductor.';

// ── pure rules ──────────────────────────────────────────────────────────────

/** What the daemon sent, with this page's unsent writes on top. `null` is a removal. */
export function mergeIncoming(incoming: SettingsMap, pending: Record<string, string | null>): SettingsMap {
  const out: SettingsMap = { ...incoming };
  for (const [k, v] of Object.entries(pending)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** The localStorage entries to send up: ours, and not already kept by the daemon. */
export function importable(local: [string, string][], kept: SettingsMap): [string, string][] {
  return local.filter(([k]) => k.startsWith(PREFIX) && !(k in kept));
}

// ── the live map ────────────────────────────────────────────────────────────

let values: SettingsMap = {};
let loaded = false;
let pending: Record<string, string | null> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const onceLoaded: (() => void)[] = [];

const offline = (): boolean => {
  try {
    return Boolean(import.meta.env?.['VITE_FIXTURE']) || typeof fetch !== 'function';
  } catch {
    return true;
  }
};

function changed(): void {
  for (const l of listeners) l();
}

function flush(): void {
  timer = null;
  // Before the daemon has sent its settings there is nothing to send them to.
  if (!loaded || offline() || Object.keys(pending).length === 0) return;
  const sending = pending;
  pending = {};
  api<{ settings: SettingsMap }>('/api/settings', { method: 'PATCH', body: { settings: sending } }).catch((err: unknown) => {
    // Refused (a value the daemon has a rule for): trying again would be refused again.
    // Its next `settings` frame puts the kept value back.
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      console.warn('[settings] refused', err.message);
      return;
    }
    // Unreachable: keep them for the next try; a newer write to the same key wins.
    pending = { ...sending, ...pending };
    if (!timer) timer = setTimeout(flush, FLUSH_MS * 10);
  });
}

function schedule(): void {
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/** The daemon's settings, from a snapshot or a `settings` frame. Called by the store. */
export function receiveSettings(incoming: SettingsMap): void {
  const first = !loaded;
  loaded = true;
  values = mergeIncoming(incoming, pending);
  if (first) {
    try {
      const local: [string, string][] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = k === null ? null : localStorage.getItem(k);
        if (k !== null && v !== null) local.push([k, v]);
      }
      for (const [k, v] of importable(local, incoming)) {
        values[k] = v;
        pending[k] = v;
      }
      for (const [k] of local) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
      if (Object.keys(pending).length > 0) schedule();
    } catch {
      // No localStorage (a policy, or Node): nothing to move.
    }
    for (const fn of onceLoaded.splice(0)) fn();
  }
  changed();
}

function localRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readSetting(key: string): string | null {
  return values[key] ?? (loaded ? null : localRead(key));
}

/** Change a setting here now, and in the daemon a moment later. `null` removes it. */
export function writeSetting(key: string, value: string | null): void {
  if (readSetting(key) === value) return;
  if (!loaded) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Not remembered past this page.
    }
  }
  if (value === null) delete values[key];
  else values[key] = value;
  values = { ...values };
  pending[key] = value;
  schedule();
  changed();
}

/** Whether the daemon's settings have arrived. Before then, every read is a default. */
export function settingsLoaded(): boolean {
  return loaded;
}

/** Run `fn` once the daemon's settings have arrived — at once, if they have. */
export function whenSettingsLoaded(fn: () => void): void {
  if (loaded) fn();
  else onceLoaded.push(fn);
}

export function onSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One setting, re-rendering when it changes. */
export function useSetting(key: string): string | null {
  return useSyncExternalStore(onSettings, () => readSetting(key));
}
