/**
 * How big the resizable side and bottom panels may be, and where each is kept.  TRACK B.
 * (Amendment 34)
 *
 * The Files tree and the composer could already be dragged (F17). These are the other
 * panels whose fixed size got in the way: the Agent inspector, the Needs You queue, the
 * Project column and dock, and the Preview dock. Each is drawn at the size you dragged
 * to, fitted to the window you have now — the same rule as files/width.ts: what's kept
 * is the size you asked for, so one saved on a big monitor can't crowd the main pane on
 * a laptop, and is back when you are.
 *
 * The rules are pure and exported apart from the storage (Amendment 9), and this file
 * imports no CSS, so lib/verify.ts checks them under Node.
 */

import { useSyncExternalStore } from 'react';
import { useSetting, writeSetting } from '../lib/settings.js';

export interface Panel {
  /** Settings key (Amendment 46; it was a localStorage key, and the name stayed). */
  key: string;
  /** Which way it drags: a side panel's width, or a dock's height. */
  axis: 'width' | 'height';
  /** The size it had when it was fixed, in px — and what a double-click goes back to. */
  fallback: number;
  /** Below this its contents stop being usable. */
  min: number;
  /** Of the window along `axis`, so the main pane always keeps the larger share. */
  share: number;
}

export const AGENT_INSPECTOR: Panel = {
  key: 'conductor.agentInspectorW',
  axis: 'width',
  fallback: 246,
  min: 200,
  share: 0.4,
};

export const QUEUE_PANEL: Panel = {
  key: 'conductor.queuePanelW',
  axis: 'width',
  fallback: 252,
  min: 200,
  share: 0.4,
};

/** The Agent screen's Needs you panel (Amendment 108): wider than the details, for the cards. */
export const AGENT_NEEDS: Panel = {
  key: 'conductor.agentNeedsW',
  axis: 'width',
  fallback: 340,
  min: 280,
  share: 0.5,
};

/** Its fallback is tokens.css's `--projcol`, which stays the width when nothing is kept. */
export const PROJECT_COLUMN: Panel = {
  key: 'conductor.projectColW',
  axis: 'width',
  fallback: 288,
  min: 200,
  share: 0.4,
};

/**
 * The project navigator down the left of every screen (Amendment 66). Narrower than the
 * Project column, and a smaller share of the window, because it sits beside every
 * screen's own panels rather than being one of them.
 */
export const NAV_PANEL: Panel = {
  key: 'conductor.navW',
  axis: 'width',
  fallback: 236,
  min: 180,
  share: 0.3,
};

export const PROJECT_DOCK: Panel = {
  key: 'conductor.projectDockH',
  axis: 'height',
  fallback: 236,
  min: 120,
  share: 0.7,
};

export const PREVIEW_DOCK: Panel = {
  key: 'conductor.previewDockH',
  axis: 'height',
  fallback: 178,
  min: 100,
  share: 0.7,
};

export function panelMax(p: Panel, viewport: number): number {
  return Math.max(p.min, Math.floor(viewport * p.share));
}

/** The size to draw, for the size you asked for and the window you have now. */
export function panelSize(p: Panel, px: number, viewport: number): number {
  return Math.min(panelMax(p, viewport), Math.max(p.min, Math.round(px)));
}

/** A stored size, or the fallback when there isn't a usable one. */
export function storedPanel(p: Panel, raw: string | null): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : p.fallback;
}

// ── the browser side ────────────────────────────────────────────────────────

const onResize = (cb: () => void): (() => void) => {
  addEventListener('resize', cb);
  return () => removeEventListener('resize', cb);
};

/**
 * A panel's size, and what its Splitter needs: spread `handle` onto it. Kept in the
 * settings file (Amendment 46), because every screen remounts on navigation and a size
 * you dragged would otherwise reset each time you came back — and so every browser
 * gets the same one.
 */
export function usePanel(p: Panel): {
  size: number;
  handle: { size: number; min: number; max: number; onSize: (px: number) => void; onReset: () => void };
} {
  const viewport = useSyncExternalStore(onResize, () =>
    p.axis === 'width' ? innerWidth : innerHeight,
  );
  const asked = storedPanel(p, useSetting(p.key));
  const setAsked = (px: number): void => writeSetting(p.key, String(px));

  const size = panelSize(p, asked, viewport);
  return {
    size,
    handle: {
      size,
      min: p.min,
      max: panelMax(p, viewport),
      // Fitted before it's kept, so a drag past the limit doesn't save a size you never saw.
      onSize: (px) => setAsked(panelSize(p, px, viewport)),
      onReset: () => setAsked(p.fallback),
    },
  };
}
