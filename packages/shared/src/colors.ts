/**
 * A project's colour bar, decided (Amendment 210): in the order the projects were created, each
 * without a key takes the key fewest of the ones before it have, the palette's order breaking a tie.
 * A key a project has counts for the ones after it. The daemon pins what this gives (`pinProjectColors`,
 * session/store.ts), so a project's colour never moves when another is added or removed; the web uses
 * it too, for a daemon from before that pinned nothing.
 */

import { PROJECT_COLORS, type ProjectColor } from './wire.js';

export function assignProjectColors(
  projects: readonly { id: string; createdAt: string; color?: string | null }[],
): Map<string, ProjectColor> {
  const byAge = [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Map<ProjectColor, number>(PROJECT_COLORS.map((k) => [k, 0]));
  const out = new Map<string, ProjectColor>();
  for (const p of byAge) {
    // A key the palette doesn't have now (one a later palette dropped) is auto, not a missing token.
    const kept = p.color && (PROJECT_COLORS as readonly string[]).includes(p.color) ? (p.color as ProjectColor) : null;
    const key = kept ?? PROJECT_COLORS.reduce((best, k) => (used.get(k)! < used.get(best)! ? k : best));
    used.set(key, used.get(key)! + 1);
    out.set(p.id, key);
  }
  return out;
}
