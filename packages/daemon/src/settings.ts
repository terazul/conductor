/**
 * Settings — one flat map of strings, kept in `~/.conductor/settings.json`.  W0.
 * (Amendment 46)
 *
 * "Everything is a setting": theme, panel sizes, folds and the Files tabs used to live in
 * each browser's localStorage, and now live here, so every browser sees the same ones.
 * The keys are the ones the web already used (`conductor.theme`, …); values are strings,
 * because that is what they already were, and what each reader already parses.
 *
 * With nowhere to save (memory mode, or a `CONDUCTOR_DB` override), they last as long
 * as the process. Written whole, through a temporary file and a rename, so a crash mid-
 * write leaves the old file rather than half a new one.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { storageNow } from './storage.js';

export type Settings = Record<string, string>;

/** A key the web might plausibly use. Keeps a bad client from filling the file. */
const KEY = /^[a-zA-Z0-9._:-]{1,120}$/;
const MAX_VALUE = 256 * 1024;

let cache: Settings | null = null;

/**
 * Settings the daemon itself reads have a rule, so a bad value is refused at the PATCH
 * instead of being found at the next launch. A rule returns why a value won't do, or null.
 */
const rules = new Map<string, (v: string) => string | null>();
const watchers = new Set<(changed: string[]) => void>();

export function settingRule(key: string, rule: (v: string) => string | null): void {
  rules.set(key, rule);
}

/** Told the names that changed, after every patch that changed any. */
export function onSettingsChanged(fn: (changed: string[]) => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function file(): string | null {
  return storageNow().settings;
}

export function readSettings(): Settings {
  if (cache) return cache;
  const f = file();
  cache = {};
  if (!f) return cache;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (KEY.test(k) && typeof v === 'string') cache[k] = v;
    }
  } catch {
    // No file yet is the ordinary first start; a broken one is ignored, not fatal.
  }
  return cache;
}

/**
 * Set or (with null) remove some keys. Throws on a key or value that isn't one, before
 * anything changes. Returns the whole map.
 */
export function patchSettings(patch: Record<string, unknown>): Settings {
  for (const [k, v] of Object.entries(patch)) {
    if (!KEY.test(k)) throw new Error(`not a setting name: ${JSON.stringify(k).slice(0, 60)}`);
    if (v !== null && typeof v !== 'string') throw new Error(`${k}: a setting is a string, or null to remove it`);
    if (typeof v === 'string' && v.length > MAX_VALUE) throw new Error(`${k}: longer than ${MAX_VALUE} characters`);
    const why = typeof v === 'string' ? rules.get(k)?.(v) : null;
    if (why) throw new Error(`${k}: ${why}`);
  }
  const before = readSettings();
  const next: Settings = { ...before };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v as string;
  }
  cache = next;
  const f = file();
  if (f) {
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, f);
  }
  const changed = Object.keys(patch).filter((k) => before[k] !== next[k]);
  if (changed.length > 0) for (const w of watchers) w(changed);
  return next;
}

/** For verify: forget the cache, as a fresh process would. */
export function forgetSettings(): void {
  cache = null;
}
