/**
 * Notes on a project, in words (Amendment 55). Pure, so lib/verify.ts checks them.
 */

/** "3 notes", "1 note", or the invitation to write the first. */
export function noteCount(n: number): string {
  return n === 0 ? '+ note' : `✎ ${n} note${n === 1 ? '' : 's'}`;
}

/** How long ago, in the words a person uses for where they left off. */
export function noteAge(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Whether a note was changed after it was written — said beside its age. */
export function wasEdited(n: { createdAt: string; updatedAt: string }): boolean {
  return Date.parse(n.updatedAt) - Date.parse(n.createdAt) > 1000;
}

// ── due dates (Amendment 63) ────────────────────────────────────────────────

/** Today as a local date, `YYYY-MM-DD`: the day the daemon counts too. */
export function localDate(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type DueState = 'late' | 'today' | 'later' | null;

/** Where a note stands: late, due today, due later, or no date (or done). */
export function dueState(n: { due?: string; doneAt?: string }, today: string): DueState {
  if (!n.due || n.doneAt) return null;
  return n.due < today ? 'late' : n.due === today ? 'today' : 'later';
}

/** "due today", "2 days late", "due tomorrow", "due Mon 5 Oct". */
export function dueLabel(due: string, today: string): string {
  const days = Math.round((Date.parse(`${due}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / 86_400_000);
  if (days === 0) return 'due today';
  if (days === -1) return '1 day late';
  if (days < 0) return `${-days} days late`;
  if (days === 1) return 'due tomorrow';
  const d = new Date(`${due}T12:00:00`);
  return `due ${d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/**
 * The note a Fleet card shows: the most urgent open due one — late before today, the
 * oldest date first — else the newest. `notes` is newest first, as the daemon sends them.
 */
export function cardNote<N extends { due?: string; doneAt?: string }>(notes: readonly N[], today: string): N | undefined {
  const rank = (n: N): number => (dueState(n, today) === 'late' ? 0 : dueState(n, today) === 'today' ? 1 : 2);
  const urgent = notes.filter((n) => rank(n) < 2).sort((a, b) => rank(a) - rank(b) || a.due!.localeCompare(b.due!));
  return urgent[0] ?? notes[0];
}
