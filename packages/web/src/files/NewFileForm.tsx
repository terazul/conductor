/**
 * The box that asks for a new file's name.  TRACK C.  (Amendment 121)
 *
 * It opens under the folder row (or the root's heading) that asked, with the folder
 * already in the name and the file name selected, so typing replaces `untitled` and keeps
 * the folder. Enter makes the file, Escape puts the box away, and a refusal, either from
 * `checkName` here or the daemon's own sentence (a name that is taken, a path it will
 * not write), shows under the box and leaves what was typed to be fixed.
 *
 * The same box names a new folder and a rename (Amendment 138), by `kind`: a folder
 * starts at `new-folder` and may end in `/`; a rename starts at the entry's own path with
 * its last name selected, and Enter on the name it already has just puts the box away.
 * Move to… asks for a folder: it starts at the one the entry is in, and
 * Enter on that one puts the box away too.
 *
 * Presentational: making the file, and what happens after, is the caller's. `onCreate`
 * rejects with the reason, which is shown as it came.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorText } from '../lib/errors.js';
import {
  checkFolderName,
  checkMoveFolder,
  checkName,
  prefill,
  prefillFolder,
  prefillMove,
  prefillRename,
  type NameCheck,
} from './naming.js';
import { parentOf } from './moving.js';

/** What the box names. `file` is Amendment 121's, and the default. */
export type NameKind = 'file' | 'folder' | 'rename-file' | 'rename-dir' | 'move';

interface Kind {
  start: (dir: string) => { value: string; from: number; to: number };
  check: (raw: string) => NameCheck;
  /** For "name of the … in X". */
  what: string;
  /** The ↵ button's label. */
  make: string;
}

const KINDS: Record<NameKind, Kind> = {
  file: { start: prefill, check: (v) => checkName(v), what: 'new file', make: 'create the file' },
  folder: { start: prefillFolder, check: checkFolderName, what: 'new folder', make: 'create the folder' },
  'rename-file': { start: (p) => prefillRename(p, 'file'), check: (v) => checkName(v), what: 'file', make: 'rename it' },
  'rename-dir': { start: (p) => prefillRename(p, 'dir'), check: checkFolderName, what: 'folder', make: 'rename it' },
  move: { start: prefillMove, check: checkMoveFolder, what: 'folder', make: 'move it' },
};

interface Props {
  /**
   * The folder the name starts in, as a tree path ('' is the root); for a rename, the
   * path of what is being renamed or moved.
   */
  dir: string;
  /** Left padding in px, so the box sits where the folder's children do. */
  indent: number;
  /** Make the file at this path (for a move, the folder). Rejects with the reason it could not. */
  onCreate: (path: string) => Promise<void>;
  onCancel: () => void;
  kind?: NameKind;
}

export function NewFileForm({ dir, indent, onCreate, onCancel, kind = 'file' }: Props) {
  const k = KINDS[kind];
  const renaming = kind === 'rename-file' || kind === 'rename-dir';
  const moving = kind === 'move';
  const start = useMemo(() => k.start(dir), [k, dir]);
  const [value, setValue] = useState(start.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement | null>(null);
  const errId = useId();

  // Focused with the file name selected, once, when it opens.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start.from, start.to);
  }, [start]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const named = k.check(value);
    if (!named.ok) {
      setError(named.reason);
      return;
    }
    // A rename to the name it already has is no rename: put the box away, send nothing.
    if (renaming && named.path === dir) {
      onCancel();
      return;
    }
    // Nor is a move to the folder it is already in.
    if (moving && named.path === parentOf(dir)) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(named.path);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      // The input is disabled while it waits, which drops focus; put it back.
      requestAnimationFrame(() => box.current?.focus());
    }
  };

  const where = dir.length > 0 ? dir : 'the top';
  const label = moving
    ? `folder to move ${dir} into (empty for the top)`
    : renaming
      ? `new name for the ${k.what} ${dir}`
      : `name of the ${k.what} in ${where}`;

  return (
    <div
      className="c5-newfile"
      style={{ paddingLeft: indent }}
      // Arrow keys belong to the box here, not to the tree's row-to-row movement.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="c5-newrow">
        <input
          ref={box}
          className="c5-newinput"
          value={value}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          placeholder={moving ? 'the top' : undefined}
          aria-label={label}
          aria-invalid={error !== null}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <button
          type="button"
          className="c5-iconbtn"
          onClick={() => void submit()}
          disabled={busy}
          title={`${k.make[0]!.toUpperCase()}${k.make.slice(1)} (Enter)`}
          aria-label={k.make}
        >
          {busy ? '…' : '↵'}
        </button>
        <button
          type="button"
          className="c5-iconbtn"
          onClick={onCancel}
          title="Cancel (Esc)"
          aria-label="cancel"
        >
          ✕
        </button>
      </div>
      {error && (
        <div id={errId} className="c5-newerr" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
