/**
 * The box that asks for a new file's name.  TRACK C.  (Amendment 121)
 *
 * It opens under the folder row (or the root's heading) that asked, with the folder
 * already in the name and the file name selected, so typing replaces `untitled` and keeps
 * the folder. Enter makes the file, Escape puts the box away, and a refusal, either from
 * `checkName` here or the daemon's own sentence (a name that is taken, a path it will
 * not write), shows under the box and leaves what was typed to be fixed.
 *
 * Presentational: making the file, and what happens after, is the caller's. `onCreate`
 * rejects with the reason, which is shown as it came.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorText } from '../lib/errors.js';
import { checkName, prefill } from './naming.js';

interface Props {
  /** The folder the name starts in, as a tree path. '' is the root. */
  dir: string;
  /** Left padding in px, so the box sits where the folder's children do. */
  indent: number;
  /** Make the file at this path. Rejects with the reason it could not. */
  onCreate: (path: string) => Promise<void>;
  onCancel: () => void;
}

export function NewFileForm({ dir, indent, onCreate, onCancel }: Props) {
  const start = useMemo(() => prefill(dir), [dir]);
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
    const named = checkName(value);
    if (!named.ok) {
      setError(named.reason);
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
          aria-label={`name of the new file in ${where}`}
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
          title="Create the file (Enter)"
          aria-label="create the file"
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
