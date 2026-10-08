/**
 * Moving a row up or down a stack (Amendment 99): the buttons, the grip you drag, and the
 * row you drop it on. Spawn's preset rows and its Custom setup both use it.
 *
 * Two ways to the same move, so neither is the only one: ↑ and ↓ buttons, which work from
 * the keyboard, and native drag and drop (as Fleet's cards use, Amendment 54), which does
 * not. Dragging starts from the grip rather than the whole row, so the text fields in a
 * Custom row stay selectable.
 *
 * After a button moves a row, focus goes to that row's button at its new place; left alone
 * it would stay at the same index, on a different row, and the next press would move that.
 */

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';

type Way = 'up' | 'down';

export function useReorder(onMove: (from: number, to: number) => void, count: number) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ row: number; way: Way } | null>(null);

  // After the render that moved a row: its button, else the other one if that can't move.
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    const row = root.current?.querySelector<HTMLElement>(`[data-reorder-row="${want.row}"]`);
    const buttons = row?.querySelectorAll<HTMLButtonElement>('button[data-move]:not(:disabled)');
    const same = [...(buttons ?? [])].find((b) => b.dataset['move'] === want.way);
    (same ?? buttons?.[0])?.focus();
  });

  const end = (): void => {
    setDragging(null);
    setOver(null);
  };

  return {
    /** On the element that holds every row. */
    rootRef: root,
    /** On the element around row `i`: where a dragged row can be dropped. */
    rowProps: (i: number) => ({
      'data-reorder-row': i,
      onDragOver: (e: DragEvent<HTMLElement>): void => {
        if (dragging === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (over !== i) setOver(i);
      },
      onDrop: (e: DragEvent<HTMLElement>): void => {
        e.preventDefault();
        const from = dragging;
        end();
        if (from !== null && from !== i) onMove(from, i);
      },
    }),
    /** Held by the element that holds every row, so leaving the list clears the mark. */
    rootProps: {
      onDragLeave: (e: DragEvent<HTMLElement>): void => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOver(null);
      },
    },
    /** The class that marks row `i` while a row is dragged: itself, or the place it would land. */
    markOf: (i: number): string => {
      if (dragging === null) return '';
      if (dragging === i) return ' is-dragging';
      if (over === i) return dragging < i ? ' is-drop-after' : ' is-drop-before';
      return '';
    },
    /** The grip and the two buttons for row `i`; `name` is the role, for the screen reader. */
    handle: (i: number, name: string): ReactNode => {
      const move = (way: Way): void => {
        refocus.current = { row: i + (way === 'up' ? -1 : 1), way };
        onMove(i, i + (way === 'up' ? -1 : 1));
      };
      return (
        <span className="sp-mv">
          <span
            className="sp-grip"
            draggable
            title={`Drag ${name} to a new place in the stack. The arrow buttons beside it do the same from the keyboard.`}
            aria-hidden="true"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              // Firefox starts no drag without data.
              e.dataTransfer.setData('text/plain', name);
              // The whole row follows the pointer, not just the grip.
              const row = (e.currentTarget as HTMLElement).closest('[data-reorder-row]');
              if (row) e.dataTransfer.setDragImage(row, 14, 14);
              // After the browser has taken the image, so the faded row isn't what follows the pointer.
              setTimeout(() => setDragging(i), 0);
            }}
            onDragEnd={end}
          >
            ⋮⋮
          </span>
          <button
            type="button"
            className="sp-mvb"
            data-move="up"
            disabled={i === 0}
            aria-label={`Move ${name} up`}
            title={`Move ${name} up one place`}
            onClick={() => move('up')}
          >
            ↑
          </button>
          <button
            type="button"
            className="sp-mvb"
            data-move="down"
            disabled={i >= count - 1}
            aria-label={`Move ${name} down`}
            title={`Move ${name} down one place`}
            onClick={() => move('down')}
          >
            ↓
          </button>
        </span>
      );
    },
  };
}
