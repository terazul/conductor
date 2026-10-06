/**
 * Keys Conductor holds for other engines — today, OpenRouter's.  TRACK A. (Amendment 76)
 *
 * NOT A SETTING. Every setting is broadcast to every tab (routes/settings.ts), so a key
 * kept there would be in every browser. It lives in `~/.conductor/secrets.json`, beside
 * settings.json, mode 0600, written whole through a temporary file and a rename. With
 * nowhere to save (memory mode, or a `CONDUCTOR_DB` override) it lasts as long as the
 * process, like a setting would.
 *
 * `OPENROUTER_API_KEY` in the environment wins over the file, so a key you exported is
 * the one used whatever Settings says.
 *
 * The key leaves this file in one direction only: to the Copilot SDK, when a session
 * starts (backends/copilot.ts). It is never logged, never put in an event, a row or a
 * response. What the routes can see is `KeyStatus`: whether one is set, and where from.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { conductorHome, storageMode } from '../storage.js';

const FILE = 'secrets.json';
const OPENROUTER = 'openrouter';
const MAX_KEY = 512;

export interface KeyStatus {
  set: boolean;
  source: 'env' | 'settings' | null;
}

/** The kept keys, by name. Undefined until first read. */
let cache: Record<string, string> | undefined;

function file(): string | null {
  return storageMode() === 'home' ? join(conductorHome(), FILE) : null;
}

function kept(): Record<string, string> {
  if (cache) return cache;
  cache = {};
  const f = file();
  if (!f) return cache;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v) cache[k] = v;
    }
  } catch {
    // No file is the ordinary case; a broken one is ignored rather than fatal.
  }
  return cache;
}

function envKey(): string | null {
  const v = process.env['OPENROUTER_API_KEY']?.trim();
  return v ? v : null;
}

/** The key to hand the SDK, or null. Internal: nothing that answers a request calls this. */
export function openRouterKey(): string | null {
  return envKey() ?? kept()[OPENROUTER] ?? null;
}

export function openRouterKeyStatus(): KeyStatus {
  if (envKey()) return { set: true, source: 'env' };
  return kept()[OPENROUTER] ? { set: true, source: 'settings' } : { set: false, source: null };
}

/**
 * Keep a key, or forget it with null (or an empty string). Throws a sentence for one
 * that can't be a key — the key itself is never in it.
 */
export function setOpenRouterKey(key: string | null): KeyStatus {
  const k = key?.trim() ?? '';
  if (k.length > MAX_KEY) throw new Error(`a key is at most ${MAX_KEY} characters`);
  if (/\s/.test(k)) throw new Error('a key has no spaces or line breaks in it');
  const next = { ...kept() };
  if (k) next[OPENROUTER] = k;
  else delete next[OPENROUTER];
  const f = file();
  if (f) {
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, f);
  }
  cache = next;
  return openRouterKeyStatus();
}

/** For verify: forget what was read, as a fresh process would. */
export function forgetSecrets(): void {
  cache = undefined;
}
