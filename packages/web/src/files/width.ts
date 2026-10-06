/**
 * How wide the Files tree may be.  TRACK C.  (F17)
 *
 * Apart from route.tsx because that imports CSS, which Node can't load, and
 * `lib/verify.ts` checks these rules under Node.
 */

export const TREE_DEFAULT = 268;
/** Below this the names are all ellipsis, which is the problem this fixes. */
export const TREE_MIN = 180;
/** Of the window, so the file pane always keeps the larger share. */
const TREE_MAX_SHARE = 0.6;

export function treeMax(viewport: number): number {
  return Math.max(TREE_MIN, Math.floor(viewport * TREE_MAX_SHARE));
}

/**
 * The width to draw, for the width you asked for and the window you have now.
 *
 * The screen keeps the width you asked for and runs it through this on every resize,
 * rather than storing the clamped result. A width saved on a big monitor then can't
 * squeeze the file pane on a laptop, and is back when you are.
 */
export function treeWidth(px: number, viewport: number): number {
  return Math.min(treeMax(viewport), Math.max(TREE_MIN, Math.round(px)));
}

/** A stored width, or the default when there isn't a usable one. */
export function storedTreeWidth(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : TREE_DEFAULT;
}
