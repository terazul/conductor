/**
 * The confirm under a row being deleted.  TRACK C.  (Amendment 138)
 *
 * What it asks, and in how many steps, is `deleteSteps` (deleting.ts); this only draws
 * the step it is on, asks the daemon what is on disk (`entryInfo`), and sends the delete
 * on the last yes. The safe choice has the focus, as the tab strip's own "close with an
 * unsaved edit?" does (TabStrip.tsx), and Escape is it.
 *
 * Open tabs at or under the path close when the delete lands (`closeDeleted`); their
 * unsaved edits are named in the first step, which is the asking a dirty tab's close
 * does, said once for all of them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryResponse, FileNode } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { countTreeFiles, deleteSteps, onYes } from './deleting.js';
import { closeDeleted, unsavedUnder } from './useTabs.js';
import { deleteEntry, entryInfo } from './useWorkspace.js';

interface Props {
  root: string;
  node: FileNode;
  /** The delete went through: put the confirm away. */
  onDone: () => void;
  onCancel: () => void;
}

export function DeleteConfirm({ root, node, onDone, onCancel }: Props) {
  const [info, setInfo] = useState<EntryResponse | null>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);

  // Read once, as the confirm opens: what is unsaved is what it was when you asked. By
  // path, since a folder's tabs can share a file name.
  const unsaved = useMemo(
    () => unsavedUnder(root, node.path).map((k) => k.split('\u0000')[1] ?? k),
    [root, node.path],
  );
  const treeFiles = useMemo(() => countTreeFiles(node), [node]);

  useEffect(() => {
    let live = true;
    entryInfo(root, node.path).then(
      (i) => live && setInfo(i),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [root, node.path]);

  const steps = deleteSteps({
    path: node.path,
    type: info?.type ?? node.type,
    files: info?.files ?? null,
    treeFiles,
    capped: info?.capped === true,
    tracked: info?.tracked ?? null,
    unsaved,
  });
  // A count that landed after the first step can shorten the list; never past its end.
  const step = steps[Math.min(at, steps.length - 1)]!;

  // Each step starts on the safe choice.
  useEffect(() => {
    keep.current?.focus();
  }, [at]);

  const yes = async (): Promise<void> => {
    if (busy) return;
    const what = onYes(steps, Math.min(at, steps.length - 1));
    if (!what) return;
    if ('next' in what) {
      setAt(what.next);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteEntry(root, node.path, what.send.recursive);
      closeDeleted(root, node.path);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="c5-delconfirm"
      role="alertdialog"
      aria-label={`Delete ${node.path}`}
      onKeyDown={(e) => {
        // The tree's keys (arrows, F2, Delete) stay out of the confirm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="c5-delask">{step.ask}</span>
      {step.notes.map((n) => (
        <span key={n} className="c5-delnote">
          {n}
        </span>
      ))}
      {error && (
        <span className="c5-newerr" role="alert">
          {error}
        </span>
      )}
      <div className="c5-actions">
        <button
          type="button"
          className="c5-btn danger"
          disabled={busy || !step.ready}
          onClick={() => void yes()}
        >
          {busy ? 'deleting…' : step.yes}
        </button>
        <button ref={keep} type="button" className="c5-btn wide" onClick={onCancel}>
          keep it
        </button>
      </div>
    </div>
  );
}
