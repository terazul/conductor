/**
 * The live copy of the Files screen's tabs.  TRACK C.  (Amendment 29)
 *
 * Module-level on purpose: main.tsx unmounts a screen you leave, so anything held in
 * React state goes with it. This outlives the screen, and localStorage outlives the
 * page. The rules — what opens, what closes, what a link does — are all in tabs.ts;
 * this file only holds the result and writes it down.
 *
 * Two things are kept here and not in localStorage:
 *
 *  • Unsaved edits. A draft survives leaving the screen, but not a reload — a draft
 *    restored hours later against a file an agent has since rewritten is a worse
 *    surprise than a prompt. So a reload with anything unsaved asks first.
 *
 *  • Scroll position is written without a re-render. It changes on every frame of a
 *    scroll, and nothing on screen depends on it except the restore.
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { currentRoute, onNavigate, type NavParams } from '../lib/nav.js';
import { readSetting, whenSettingsLoaded, writeSetting } from '../lib/settings.js';
import {
  EMPTY,
  applyLink,
  keyOf,
  linkOf,
  parseState,
  serialize,
  setScroll,
  type FilesState,
  type View,
} from './tabs.js';

const KEY = 'conductor.filesTabs';
const WRITE_MS = 400;

/*
 * Kept in the settings file (Amendment 46), so another browser opens the same tabs.
 * Read at start and once more when the daemon's settings arrive — not on every change
 * another tab makes, or two open browsers would fight over which file is in front.
 */
function load(): FilesState {
  return parseState(readSetting(KEY));
}

let state: FilesState = load();
/** Whether this page has changed the tabs since it read them. */
let touched = false;
whenSettingsLoaded(() => {
  if (touched) return;
  state = load();
  for (const l of listeners) l();
});
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function write(): void {
  timer = null;
  writeSetting(KEY, serialize(state));
}

function schedule(): void {
  touched = true;
  if (timer === null) timer = setTimeout(write, WRITE_MS);
}

function flush(): void {
  if (timer === null) return;
  clearTimeout(timer);
  write();
}

export function getFiles(): FilesState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFiles(): FilesState {
  return useSyncExternalStore(subscribe, getFiles);
}

/** Apply a change. `fn` returning its argument is a no-op: nothing renders, nothing is written. */
export function update(fn: (s: FilesState) => FilesState): void {
  const next = fn(state);
  if (next === state) return;
  const closed = next.tabs !== state.tabs;
  state = next;
  schedule();
  if (closed) dropEditsOfClosedTabs();
  for (const l of listeners) l();
}

/** Tabs holding unsaved work: eviction passes over these (see `openTab`). */
export const keep = (key: string): boolean => dirty.has(key);

/** Remember where a tab is scrolled. No render — see the header. */
export function rememberScroll(key: string, view: View, top: number): void {
  const next = setScroll(state, key, view, top);
  if (next === state) return;
  state = next;
  schedule();
}

// ── deep links ──────────────────────────────────────────────────────────────

/**
 * Was the page loaded at a link this screen already followed? A reload keeps the URL,
 * and `#files?jobId=…&path=…` from an hour ago must not drag that tab back in front
 * of the one you moved on to. Any navigation after load means a link is new again.
 *
 * A flag rather than consume-once, so StrictMode running the mount effect twice sees
 * the same answer both times.
 */
let bootLink = ((): boolean => {
  try {
    const { id, params } = currentRoute();
    const link = linkOf(params);
    return id === 'files' && link !== null && link === state.link;
  } catch {
    return false;
  }
})();

onNavigate(() => {
  bootLink = false;
});

/** Follow the route's params. `mounting` is the screen's first look, rather than a hashchange. */
export function followLink(params: NavParams, mounting: boolean): void {
  if (mounting && bootLink) return;
  update((s) => applyLink(s, params, Date.now(), keep));
}

// ── unsaved edits ───────────────────────────────────────────────────────────

export interface Edit {
  draft: string;
  /** The file's text when editing began. The file moving on from it is a conflict. */
  base: string;
}

const edits = new Map<string, Edit>();
const editListeners = new Set<() => void>();
/** Replaced only when membership changes, so `useDirty` re-renders only then. */
let dirty: ReadonlySet<string> = new Set();

function editsChanged(): void {
  const next = new Set([...edits].filter(([, e]) => e.draft !== e.base).map(([k]) => k));
  if (next.size !== dirty.size || [...next].some((k) => !dirty.has(k))) dirty = next;
  for (const l of editListeners) l();
}

function dropEditsOfClosedTabs(): void {
  const open = new Set(state.tabs.map(keyOf));
  let changed = false;
  for (const k of edits.keys()) {
    if (!open.has(k)) {
      edits.delete(k);
      changed = true;
    }
  }
  if (changed) editsChanged();
}

function subscribeEdits(fn: () => void): () => void {
  editListeners.add(fn);
  return () => editListeners.delete(fn);
}

/** Start, change or (with null) end editing a tab. */
export function putEdit(key: string, edit: Edit | null): void {
  if (edit === null ? !edits.has(key) : edits.get(key) === edit) return;
  if (edit === null) edits.delete(key);
  else edits.set(key, edit);
  editsChanged();
}

export function useEdit(key: string): Edit | null {
  return useSyncExternalStore(subscribeEdits, () => edits.get(key) ?? null);
}

export function useDirty(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeEdits, () => dirty);
}

// ── page lifecycle ──────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  // The debounced write must not be lost to a reload that lands inside it.
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', (e) => {
    flush();
    if (dirty.size === 0) return;
    // The browser's own "leave site?" prompt; the text is its choice, not ours.
    e.preventDefault();
    e.returnValue = '';
  });
}

// ── scroll memory ───────────────────────────────────────────────────────────

/**
 * Put `ref`'s scroller back where this tab's `view` was left, and keep track as it
 * moves. Nothing is recorded until the restore has run: the scroll event a short
 * placeholder causes would otherwise overwrite the position with 0 before the
 * content arrived. A null `view` records nothing — the editor scrolls itself, and
 * the pane jumping to the top under it must not cost you your place in the file.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, key: string, view: View | null): void {
  const restored = useRef<string | null>(null);
  const at = `${key}\u0001${view}`;

  useLayoutEffect(() => {
    const el = ref.current;
    restored.current = null;
    if (!el || view === null) return;
    const tab = state.tabs.find((t) => keyOf(t) === key);
    el.scrollTop = tab?.scroll[view] ?? 0;
    restored.current = at;
  }, [ref, key, view, at]);

  useEffect(() => {
    const el = ref.current;
    if (!el || view === null) return;
    const onScroll = (): void => {
      if (restored.current === at) rememberScroll(key, view, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, key, view, at]);
}
