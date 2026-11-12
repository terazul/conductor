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

// ── every note, on the Notes screen (Amendment 214) ─────────────────────────

/** Which notes the Notes screen shows: open (the default), done, or all of them. */
export type NoteShow = 'open' | 'done' | 'all';

export interface NoteFilter {
  /** One project's, or null for every project's. */
  projectId: string | null;
  /** The ones typed on one agent's screen, or null for any (and none). */
  agentId: string | null;
  show: NoteShow;
  /** Words the text holds, any case; blank for any. */
  q: string;
}

export const NO_NOTE_FILTER: NoteFilter = { projectId: null, agentId: null, show: 'open', q: '' };

type NoteLike = { id: string; projectId: string; text: string; createdAt: string; due?: string; doneAt?: string; agentId?: string; agentLabel?: string };

/** Whether a note passes the filter. */
export function noteMatches(n: NoteLike, f: NoteFilter): boolean {
  if (f.projectId !== null && n.projectId !== f.projectId) return false;
  if (f.agentId !== null && n.agentId !== f.agentId) return false;
  if (f.show === 'open' && n.doneAt) return false;
  if (f.show === 'done' && !n.doneAt) return false;
  // Each word, in any order and any case: "ship release" finds "Ship the Release".
  const text = n.text.toLowerCase();
  return f.q.toLowerCase().split(/\s+/).every((w) => w === '' || text.includes(w));
}

/**
 * The Notes screen's order: late first, the longest late first among them, then due today, then the
 * rest newest first, as each project's own list is.
 */
export function noteOrder(today: string): (a: NoteLike, b: NoteLike) => number {
  const rank = (n: NoteLike): number => (dueState(n, today) === 'late' ? 0 : dueState(n, today) === 'today' ? 1 : 2);
  return (a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 0 ? a.due!.localeCompare(b.due!) : 0) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id);
}

/**
 * Every project's notes that pass the filter, grouped by project, each group in `noteOrder`. A
 * project with none to show has no group. The groups go in the order of their first notes, so the
 * project with the latest note is at the top; a tie keeps the projects' own order.
 */
export function noteGroups<P extends { id: string; notes?: readonly NoteLike[] }>(
  projects: readonly P[],
  f: NoteFilter,
  today: string,
): { project: P; notes: NonNullable<P['notes']>[number][] }[] {
  const order = noteOrder(today);
  const groups = projects
    .map((project, i) => ({ project, i, notes: (project.notes ?? []).filter((n) => noteMatches(n, f)).sort(order) }))
    .filter((g) => g.notes.length > 0);
  groups.sort((a, b) => order(a.notes[0]!, b.notes[0]!) || a.i - b.i);
  return groups.map(({ project, notes }) => ({ project, notes }));
}

/**
 * The agents the agent picker offers: those with notes, in the filter's project if it has one, each
 * once, by the label its notes keep, and named with their project when there are several projects.
 * Two of one project's agents with the same role are told apart by their job (`jobOf`: its name, or
 * its prompt's first words), `developer · Nightly tests`, or *removed* once the agent is gone; two
 * in one job by the end of their ids too (`agentLabels`).
 */
export function noteAgents(
  projects: readonly { id: string; name: string; notes?: readonly NoteLike[] }[],
  projectId: string | null,
  jobOf: (agentId: string) => string | undefined = () => undefined,
): { agentId: string; label: string }[] {
  const out: { agentId: string; label: string }[] = [];
  const many = projectId === null && projects.filter((p) => (p.notes ?? []).some((n) => n.agentId)).length > 1;
  for (const p of projects) {
    if (projectId !== null && p.id !== projectId) continue;
    const roles = new Map<string, string>();
    for (const n of p.notes ?? []) if (n.agentId && !roles.has(n.agentId)) roles.set(n.agentId, n.agentLabel ?? 'agent');
    const items = [...roles].map(([agentId, role]) => ({ agentId, role, job: jobOf(agentId) ?? 'removed' }));
    agentLabels(items).forEach((label, i) => out.push({ agentId: items[i]!.agentId, label: many ? `${p.name} / ${label}` : label }));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * One list's agents, each told apart from the rest (Amendments 214, 216): its role; with its job when
 * another has the same role (or `always`), `developer · Nightly tests`; and, when another has the same
 * role in the same job, with the last four of its id, `developer · Nightly tests · a3f2`. In the
 * order given. The Notes and Repeating screens' agent pickers both name agents this way.
 */
export function agentLabels(items: readonly { agentId: string; role: string; job?: string }[], always = false): string[] {
  const times = (x: string, of: readonly string[]): number => of.filter((y) => y === x).length;
  const roles = items.map((i) => i.role);
  const named = items.map((i) => ((always || times(i.role, roles) > 1) && i.job !== undefined ? `${i.role} · ${i.job}` : i.role));
  return named.map((l, i) => (times(l, named) > 1 ? `${l} · ${items[i]!.agentId.slice(-4)}` : l));
}

/** A job as the agent picker names it: its name, else its prompt's first five words. */
export function jobWords(job: { name?: string; prompt: string }): string {
  if (job.name?.trim()) return job.name.trim();
  const words = job.prompt.trim().split(/\s+/).filter(Boolean);
  return words.length === 0 ? 'waiting for instructions' : words.slice(0, 5).join(' ') + (words.length > 5 ? '…' : '');
}

/**
 * A note's agent tag: its role as the note keeps it, and whether that agent is still here to open.
 * Null for a note typed nowhere in particular.
 */
export function agentTag(n: { agentId?: string; agentLabel?: string }, here: boolean): { label: string; removed: boolean } | null {
  if (!n.agentId) return null;
  return { label: n.agentLabel ?? 'agent', removed: !here };
}

/** What the Notes screen says above its groups: "4 open notes in 2 projects". */
export function notesSummary(groups: readonly { notes: readonly unknown[] }[], show: NoteShow): string {
  const n = groups.reduce((sum, g) => sum + g.notes.length, 0);
  const kind = show === 'all' ? '' : `${show} `;
  if (n === 0) return `no ${kind}notes`;
  return `${n} ${kind}note${n === 1 ? '' : 's'} in ${groups.length} project${groups.length === 1 ? '' : 's'}`;
}
