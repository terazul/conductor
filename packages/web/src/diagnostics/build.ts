/**
 * What is running — the daemon's commit and dates, in words.  W0.
 * (Amendment 38)
 *
 * Conductor runs from source, so "the build" is the checkout the daemon started from
 * (daemon/src/build.ts). The web side needs no record of its own: Vite serves what is
 * on disk and reloads itself, while the daemon keeps the code it booted with. So the
 * one thing worth warning about is the daemon being behind HEAD.
 *
 * The words are pure and import no CSS, so lib/verify.ts checks them under Node.
 */

import { api } from '../lib/feed.js';

export interface Build {
  version: string;
  commit: string | null;
  branch: string | null;
  committedAt: string | null;
  dirty: boolean;
  startedAt: string;
  node: string;
  /** HEAD now. */
  head: string | null;
  /** HEAD has moved since the daemon started. */
  behind: boolean;
}

export function getBuild(): Promise<Build> {
  return api('/api/build');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "29 Sep 2026 11:30", in the viewer's time zone. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "cleanup@34e4579*" — `*` for uncommitted changes, as git prompts write it. */
export function buildTag(b: Build): string {
  if (!b.commit) return `v${b.version}`;
  return `${b.branch ? `${b.branch}@` : ''}${b.commit}${b.dirty ? '*' : ''}`;
}

/** The status bar's hover: everything, one fact per line. */
export function buildTitle(b: Build): string {
  return [
    `Conductor ${b.version}`,
    b.commit ? `commit ${b.commit}${b.dirty ? ' with uncommitted changes' : ''}, made ${fmtWhen(b.committedAt)}` : 'not a git checkout',
    `daemon started ${fmtWhen(b.startedAt)} · node ${b.node}`,
    ...(b.behind ? [behindLine(b)] : []),
  ].join('\n');
}

/** Said only when the daemon is running older code than the checkout. */
export function behindLine(b: Build): string {
  return `The checkout is at ${b.head ?? '?'}, but the daemon is still running ${b.commit ?? '?'}. make restart to run it.`;
}
