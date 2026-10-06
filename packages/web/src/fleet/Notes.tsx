/**
 * A project's notes (Amendments 55, 56, 63): on its Fleet card, in the Project column and
 * in the Agent inspector. The card shows the most urgent due note, or the newest, and a
 * count; the panel adds, changes, ticks done and deletes them, and sets when one is due.
 *
 * Due today is amber, late is red, and a done note is greyed and stops nagging. "Today"
 * is the local date, re-read every minute, so it turns over at midnight without a reload.
 *
 * Everything in here stops its clicks and keys at the panel: the card around it is a
 * button that opens the project, and typing a space in a note must not.
 *
 * Each note can be copied, as its text alone (Amendment 83): from its row wherever the
 * panel shows, and from the note the Fleet card shows.
 */

import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectNote } from '@conductor/shared';
import { NOTE_MAX } from '@conductor/shared';
import { useCommand } from '../agent/endpoints.js';
import { copyText } from '../lib/clipboard.js';
import { useNow } from '../shell/clock.js';
import { addNote, editNote, removeNote } from './endpoints.js';
import { cardNote, dueLabel, dueState, localDate, noteAge, noteCount, wasEdited } from './notewords.js';
import './fleet.css';

const stop = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

function useToday(): { today: string; now: number } {
  const now = useNow(60_000);
  return { today: localDate(now), now };
}

/** The due badge: amber today, red late, quiet later. */
function DueBadge({ note, today }: { note: ProjectNote; today: string }) {
  if (!note.due) return null;
  const state = dueState(note, today);
  return <span className={`fl-note-due${state ? ` is-${state}` : ' is-done'}`}>{dueLabel(note.due, today)}</span>;
}

/** When it's due: today, a picked day, or none. */
function DuePicker({ value, onChange, today }: { value: string | null; onChange: (v: string | null) => void; today: string }) {
  return (
    <span className="fl-due-pick">
      <button type="button" className={`fl-btn is-ghost${value === today ? ' is-on' : ''}`} onClick={() => onChange(value === today ? null : today)}>
        due today
      </button>
      <input
        type="date"
        value={value ?? ''}
        aria-label="Due date"
        onChange={(e) => onChange(e.target.value || null)}
      />
      {value && (
        <button type="button" className="fl-btn is-ghost" aria-label="No due date" onClick={() => onChange(null)}>
          ✕
        </button>
      )}
    </span>
  );
}

/**
 * Copies a note's text. It says "copied" for a moment, or that it couldn't. It stops its
 * click and keys, so on a card it copies without opening the project.
 */
function CopyButton({ text, compact = false }: { text: string; compact?: boolean }) {
  const [said, setSaid] = useState<{ ok: boolean; why?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const say = (next: { ok: boolean; why?: string }): void => {
    setSaid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), next.ok ? 1500 : 4000);
  };
  const copy = (): void => {
    void copyText(text).then(
      () => say({ ok: true }),
      (err: unknown) => say({ ok: false, why: err instanceof Error ? err.message : String(err) }),
    );
  };
  return (
    <button
      type="button"
      className={`fl-btn is-ghost fl-note-copy${compact ? ' is-compact' : ''}${said && !said.ok ? ' is-failed' : ''}`}
      aria-label="Copy this note"
      title={said && !said.ok ? `Couldn't copy: ${said.why}` : 'Copy this note'}
      onClick={(e) => {
        e.stopPropagation();
        copy();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {said ? (said.ok ? '✓ copied' : "couldn't copy") : compact ? '⧉' : '⧉ copy'}
    </button>
  );
}

/** The note a card shows, under the path: the most urgent due one, else the newest. */
export function LatestNote({ project }: { project: Project }) {
  const { today, now } = useToday();
  const shown = cardNote(project.notes ?? [], today);
  if (!shown) return null;
  const state = dueState(shown, today);
  return (
    <div className="fl-note-latest-row">
      <p className={`fl-note-latest${state === 'late' || state === 'today' ? ` is-${state}` : ''}`} title={shown.text}>
        <span className="fl-note-mark">✎</span>
        {shown.text}
        {shown.due && !shown.doneAt ? (
          <span className="fl-note-age"> · {dueLabel(shown.due, today)}</span>
        ) : (
          <span className="fl-note-age"> · {noteAge(shown.createdAt, now)}</span>
        )}
      </p>
      <CopyButton text={shown.text} compact />
    </div>
  );
}

/** The count in the card's footer, which opens the panel — amber or red when one is due. */
export function NotesButton({ project, open, onToggle }: { project: Project; open: boolean; onToggle: () => void }) {
  const { today } = useToday();
  const notes = project.notes ?? [];
  const states = notes.map((n) => dueState(n, today));
  const tone = states.includes('late') ? ' is-late' : states.includes('today') ? ' is-today' : '';
  return (
    <button
      type="button"
      className={`fl-btn is-ghost fl-note-count${open ? ' is-on' : ''}${tone}`}
      aria-expanded={open}
      title={notes.length === 0 ? 'Write a note on this project' : 'See, change or add notes'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {noteCount(notes.length)}
    </button>
  );
}

function NoteRow({ project, note }: { project: Project; note: ProjectNote }) {
  const { today, now } = useToday();
  const cmd = useCommand();
  const [draft, setDraft] = useState<{ text: string; due: string | null } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const state = dueState(note, today);
  const save = (): void => {
    if (!draft || !draft.text.trim()) return;
    void cmd.run('Saving the note', async () => {
      await editNote(project.id, note.id, { text: draft.text, due: draft.due });
      setDraft(null);
    });
  };

  if (draft !== null) {
    return (
      <li className="fl-note is-editing">
        <textarea
          className="fl-note-input"
          value={draft.text}
          autoFocus
          rows={3}
          maxLength={NOTE_MAX}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setDraft(null);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        />
        <DuePicker value={draft.due} today={today} onChange={(due) => setDraft({ ...draft, due })} />
        <div className="fl-menu-row">
          <button type="button" className="fl-btn" disabled={cmd.busy || !draft.text.trim()} onClick={save}>
            save
          </button>
          <button type="button" className="fl-btn is-ghost" onClick={() => setDraft(null)}>
            cancel
          </button>
        </div>
        {cmd.notice && <div className={`fl-menu-note t-${cmd.notice.tone}`}>{cmd.notice.text}</div>}
      </li>
    );
  }
  return (
    <li className={`fl-note${note.doneAt ? ' is-done' : ''}${state === 'late' || state === 'today' ? ` is-${state}` : ''}`}>
      <div className="fl-note-line">
        <input
          type="checkbox"
          checked={Boolean(note.doneAt)}
          disabled={cmd.busy}
          aria-label={note.doneAt ? 'Not done after all' : 'Mark done'}
          title={note.doneAt ? 'Not done after all' : 'Mark done'}
          onChange={(e) => void cmd.run('Ticking the note', () => editNote(project.id, note.id, { done: e.target.checked }))}
        />
        <p className="fl-note-text">{note.text}</p>
      </div>
      <div className="fl-note-meta">
        <span>
          <DueBadge note={note} today={today} />
          {note.due ? ' · ' : ''}
          {noteAge(note.createdAt, now)}
          {wasEdited(note) ? ` · changed ${noteAge(note.updatedAt, now)}` : ''}
        </span>
        {confirm ? (
          <span className="fl-dirs-confirm">
            <button
              type="button"
              className="fl-btn is-danger"
              disabled={cmd.busy}
              onClick={() => void cmd.run('Deleting the note', () => removeNote(project.id, note.id))}
            >
              delete it
            </button>
            <button type="button" className="fl-btn is-ghost" onClick={() => setConfirm(false)}>
              keep
            </button>
          </span>
        ) : (
          <span className="fl-note-acts">
            <CopyButton text={note.text} />
            <button type="button" className="fl-btn is-ghost" onClick={() => setDraft({ text: note.text, due: note.due ?? null })}>
              ✎ edit
            </button>
            <button type="button" className="fl-btn is-ghost" aria-label="Delete this note" onClick={() => setConfirm(true)}>
              ✕ delete
            </button>
          </span>
        )}
      </div>
      {cmd.notice && <div className={`fl-menu-note t-${cmd.notice.tone}`}>{cmd.notice.text}</div>}
    </li>
  );
}

/** Every note, newest first, and a box for the next one. */
export function NotesPanel({ project }: { project: Project }) {
  const { today } = useToday();
  const [text, setText] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const cmd = useCommand();
  const add = (): void => {
    if (!text.trim()) return;
    void cmd.run('Adding the note', async () => {
      await addNote(project.id, text, due);
      setText('');
      setDue(null);
    });
  };
  return (
    <div className="fl-notes" {...stop}>
      <textarea
        className="fl-note-input"
        value={text}
        rows={2}
        maxLength={NOTE_MAX}
        placeholder="Where you are, what's next — ⌘⏎ to add"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
        }}
      />
      <div className="fl-menu-row fl-note-addrow">
        <DuePicker value={due} today={today} onChange={setDue} />
        <button type="button" className="fl-btn" disabled={cmd.busy || !text.trim()} onClick={add}>
          {cmd.busy ? 'adding…' : 'add note'}
        </button>
      </div>
      {cmd.notice && <div className={`fl-menu-note t-${cmd.notice.tone}`}>{cmd.notice.text}</div>}
      {(project.notes?.length ?? 0) > 0 && (
        <ul className="fl-note-list">
          {project.notes!.map((n) => (
            <NoteRow key={n.id} project={project} note={n} />
          ))}
        </ul>
      )}
    </div>
  );
}
