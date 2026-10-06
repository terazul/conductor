/**
 * A folder field with shell-style completion.  TRACK A.
 */

import { useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { commonPrefix, usePathComplete, type DirEntry } from './browse.js';
import './spawn.css';

/**
 * The "where" field, with completion.
 *
 * Typed, not clicked through, because that is how people who know where their code
 * lives actually navigate — `~/src/pro⇥` beats four clicks every time. The list is
 * there for when you don't know, and the keys are the ones a shell trained you on:
 * **Tab** completes, **↑↓** pick, **⏎** accepts the highlighted row or submits,
 * **Esc** closes the list and then cancels.
 *
 * It lived in Spawn's "where" step until adding a project moved to Fleet (Amendment 45);
 * Fleet's form uses it for the main folder and for each referenced one.
 *
 * Accepting a folder appends a separator rather than finishing, so one ⏎ per level
 * walks down a tree. It also means ⏎ never both descends AND submits, which is the
 * one mistake in this interaction that would cost the user a wrong project.
 */
export function PathField({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel = 'add',
  placeholder = '~/src/your-repo — or start typing, ⇥ completes',
  autoFocus = true,
  judge = 'isolation',
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  /** The submit button's word; null for no button, when ⏎ is enough. */
  submitLabel?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  /** What the note under the field judges: which isolations will run, or just git. */
  judge?: 'isolation' | 'git';
}) {
  /*
   * Open only while the field has focus. It used to start open whatever the focus, which
   * was right while Spawn had one of these; Fleet's form has two, and both lists opened
   * at once on top of each other (Amendment 52).
   */
  const [open, setOpen] = useState(autoFocus);
  const [sel, setSel] = useState(-1);
  const completions = usePathComplete(value, open);
  const entries = completions?.entries ?? [];

  // The list moved under the cursor — a keystroke changed which directory is being
  // matched — so nothing is highlighted until the user says so again. Keeping the
  // index would leave ⏎ pointing at whatever now happens to sit at that row.
  useEffect(() => {
    setSel(-1);
  }, [completions?.dir, completions?.prefix]);

  const accept = (entry: DirEntry): void => {
    onChange(`${entry.path}/`);
    setSel(-1);
    setOpen(true);
  };

  const completeCommon = (): void => {
    if (!completions || entries.length === 0) return;
    if (entries.length === 1) {
      accept(entries[0]!);
      return;
    }
    const shared = commonPrefix(entries);
    if (shared.length <= completions.prefix.length) return;
    const dir = completions.dir;
    onChange(`${dir.endsWith('/') ? dir : `${dir}/`}${shared}`);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setSel((s) => Math.min(s + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (s <= 0 ? -1 : s - 1));
    } else if (e.key === 'Tab') {
      // Stealing Tab is justified only because the alternative is worse: the next
      // focusable thing is the `add` button, and tabbing to it mid-path is never
      // what someone completing a path meant.
      e.preventDefault();
      if (sel >= 0 && entries[sel]) accept(entries[sel]!);
      else completeCommon();
    } else if (e.key === 'Enter') {
      if (sel >= 0 && entries[sel]) {
        e.preventDefault();
        accept(entries[sel]!);
      } else {
        onSubmit();
      }
    } else if (e.key === 'Escape') {
      if (open && entries.length > 0) setOpen(false);
      else onCancel();
    }
  };

  return (
    <div className="sp-addrow">
      <div className="sp-pathwrap">
        <input
          className="sp-input"
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          // Choosing a row is a mousedown that keeps the focus, so this never eats a pick.
          onBlur={() => setOpen(false)}
        />

        {open && entries.length > 0 && (
          <div className="sp-paths">
            {entries.map((entry, i) => (
              <button
                key={entry.path}
                type="button"
                className={`sp-path${i === sel ? ' is-sel' : ''}`}
                // mousedown, not click: click fires after blur, and by then the
                // input has lost the caret position the completion belongs to.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(entry);
                }}
              >
                <span className="sp-path-nm">{entry.name}</span>
                {entry.repo && <span className="sp-path-repo">⑂ git</span>}
              </button>
            ))}
            {completions !== null && completions.truncated > 0 && (
              <div className="sp-path-more">
                {completions.truncated} more — type another character to narrow it
              </div>
            )}
          </div>
        )}

        {/*
         * What you have typed, judged. The isolation choice above depends on it: a
         * folder with no repo can only run `in place`, and finding that out at
         * launch instead of here is the sort of surprise this field exists to
         * prevent.
         */}
        {completions?.target && (
          <div className={`sp-pathnote${completions.target.repo ? ' is-repo' : ''}`}>
            {judge === 'git'
              ? completions.target.repo
                ? '⑂ a git repository'
                : 'a folder, not a git repository'
              : completions.target.repo
                ? '⑂ a git repository — any isolation works'
                : 'a folder, but not a git repository — only “this folder, as-is” will run here'}
          </div>
        )}
      </div>

      {submitLabel !== null && (
        <button type="button" className="sp-ghost" onClick={onSubmit} disabled={busy}>
          {submitLabel}
        </button>
      )}
    </div>
  );
}

