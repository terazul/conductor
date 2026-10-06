/**
 * The storage question, in words (Amendment 46). Pure, so lib/verify.ts checks them
 * under Node; settings/always.tsx does the asking.
 */

import type { StorageState } from '@conductor/shared';
import { api } from '../lib/feed.js';

/** `~` for the home directory, so a path reads the way people say it. */
export function homeish(path: string, home?: string): string {
  const h = home ?? inferHome(path);
  return h && (path === h || path.startsWith(`${h}/`)) ? `~${path.slice(h.length)}` : path;
}

function inferHome(path: string): string | undefined {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(path);
  return m?.[1];
}

/** The question, as the page asks it. */
export function questionLines(s: StorageState): { title: string; body: string[]; yes: string; no: string } {
  const dir = homeish(s.dir);
  const body = [
    `Conductor would like to create ${dir} and keep two things there: its database — your projects, jobs and every agent's transcript — and settings.json, with your settings: theme, panel sizes, folds, launch defaults.`,
    "Job worktrees are code, not settings, so they stay beside each repo, in <repo>/.conductor/wt.",
    'Nothing is written there until you allow it.',
  ];
  if (s.legacy) {
    body.push(`Your earlier database, ${homeish(s.legacy)}, is left exactly where it is, whichever you choose.`);
  }
  return {
    title: 'Where should Conductor keep its data?',
    body,
    yes: `Allow — create ${dir}`,
    no: 'Not now — run without saving',
  };
}

/**
 * The offer to bring the old database along (Amendment 53), or null when there's none.
 * Ticked by default: the history is what people expect to find after a restart.
 */
export function bringLine(s: StorageState): string | null {
  if (!s.legacy) return null;
  const h = s.legacyHolds;
  const what = h ? `${h.projects} project${h.projects === 1 ? '' : 's'} and ${h.agents} agent${h.agents === 1 ? '' : 's'}, with their chats` : 'your projects and chats';
  return `Bring my history: copy ${what} into ${homeish(s.dir)}.`;
}

/** What "not now" costs, said before it is clicked. */
export const DECLINE_NOTE =
  'Without it, Conductor runs in memory: everything you do is lost when it stops, and it asks again next start.';

/** The line every screen shows while nothing is being saved, or null when it is. */
export function bannerLine(s: StorageState | null): string | null {
  if (!s || s.mode !== 'memory') return null;
  if (s.savedAt) return `Saved to ${homeish(s.dir)}. Restart Conductor (make restart) to keep saving there — until then, this session still isn't.`;
  return 'Nothing is being saved. Conductor is running in memory, so everything here is gone when it stops.';
}

// ── asking the daemon ───────────────────────────────────────────────────────

export function getChoice(): Promise<StorageState> {
  return api<StorageState>('/api/storage/choice');
}

export function answer(allow: boolean, bring = false): Promise<StorageState> {
  return api<StorageState>('/api/storage/choice', { method: 'POST', body: { allow, bring } });
}

export function saveHome(): Promise<StorageState> {
  return api<StorageState>('/api/storage/save-home', { method: 'POST' });
}
