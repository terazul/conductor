/**
 * The database's size, and the button that clears what removal left behind.  W0.
 * (Amendment 36)
 *
 * Removing a project, job or agent keeps its events: removal is not a decision about
 * the record. Nothing can show them afterwards, though, and the log only grows. So
 * clearing them is its own decision, made here with a button — never a side effect
 * of removing something. What goes: events whose job or agent no longer exists. What
 * stays: everything you can still open, today's spend, and every file on disk.
 *
 * The words are pure and imports no CSS, so lib/verify.ts checks them under Node.
 */

import { api } from '../lib/feed.js';

export interface Storage {
  /** Every event in the log. */
  events: number;
  /** Events whose job or agent has been removed. */
  orphaned: number;
  /** The database file, in bytes. */
  bytes: number;
  path: string;
}

export function getStorage(): Promise<Storage> {
  return api('/api/storage');
}

export function cleanUp(): Promise<Storage & { removed: number }> {
  return api('/api/storage/cleanup', { method: 'POST', body: {} });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, one: string): string => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;

/** What the section says about the log, and whether there is anything to clear. */
export function storageLine(s: Storage): { text: string; canClean: boolean } {
  const size = `${plural(s.events, 'event')} · ${fmtBytes(s.bytes)}`;
  if (s.orphaned === 0) return { text: `${size}. Nothing left over from removed agents.`, canClean: false };
  return {
    text: `${size}. ${plural(s.orphaned, 'event')} from jobs or agents you removed, which no screen can show.`,
    canClean: true,
  };
}

/** The confirm, which says what goes and what doesn't. */
export function confirmLine(s: Storage): string {
  return `Delete ${plural(s.orphaned, 'event')} from removed jobs and agents? Nothing you can still open is touched, spend history stays, and no file on disk changes.`;
}

/** After a cleanup: what it did. */
export function doneLine(removed: number): string {
  return removed === 0 ? 'Nothing needed clearing.' : `Cleared ${plural(removed, 'event')}.`;
}
