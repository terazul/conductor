/**
 * A drag handle on the edge between two panels.  TRACK B.  (F17)
 *
 * One component for every resizable edge, so the composer's height and the Files tree's
 * width drag, step and look the same. It turns a drag or an arrow key into a proposed
 * size and nothing else: the owner keeps the size, applies its own limits, and decides
 * whether to remember it. `min` and `max` are only here because ARIA wants them on a
 * separator that can take focus.
 */

import type React from 'react';
import './ui.css';

/** One arrow-key press, in px. */
const STEP = 24;

export function Splitter({
  orientation,
  size,
  min,
  max,
  grow,
  onSize,
  onReset,
  label,
}: {
  /** The line's orientation: a `vertical` line sits between two columns and drags sideways. */
  orientation: 'vertical' | 'horizontal';
  /** The panel's size now, in px. */
  size: number;
  min: number;
  max: number;
  /** `1` if moving the line right (or down) grows the panel, `-1` if it shrinks it. */
  grow: 1 | -1;
  /** A proposed size, unclamped. */
  onSize: (px: number) => void;
  /** Double-click: back to the default. */
  onReset?: () => void;
  label: string;
}) {
  const sideways = orientation === 'vertical';

  /*
   * Pointer capture rather than window listeners: the pointer keeps being delivered to
   * the handle even when the cursor outruns it, which is what a fast drag does.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const from = sideways ? e.clientX : e.clientY;
    const start = size;

    const onMove = (ev: PointerEvent): void =>
      onSize(start + grow * ((sideways ? ev.clientX : ev.clientY) - from));
    const onUp = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  // Keyboard parity: a pointer-only resize is unreachable without a mouse.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === (sideways ? 'ArrowRight' : 'ArrowDown')) onSize(size + grow * STEP);
    else if (e.key === (sideways ? 'ArrowLeft' : 'ArrowUp')) onSize(size - grow * STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`ui-split is-${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
