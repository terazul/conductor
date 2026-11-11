/**
 * A project's colour bar (Amendment 210): the 4px bar down its left edge in the navigator, on its
 * Fleet card, and at the top of its Project, Agent and Files screens, so you can tell which project
 * in the menu a page is.
 *
 * A project keeps a key of `PROJECT_COLORS`, picked on the Fleet card's edit form, or none for auto.
 * Auto is decided here, so every page agrees without the daemon: in the order the projects were
 * created, each without a key takes the key fewest of the ones before it have, the palette's order
 * breaking a tie. A project you add never changes the ones before it, and the first eight differ.
 * A key you pick wins, and counts for the ones after it.
 *
 * The pure part has no DOM; lib/verify.ts checks it under Node.
 */

import { PROJECT_COLORS, type Project, type ProjectColor } from '@conductor/shared';
import { useMemo } from 'react';
import { useProjects } from './store.js';

/** Every project's key, kept or auto. */
export function projectColors(projects: readonly Pick<Project, 'id' | 'createdAt' | 'color'>[]): Map<string, ProjectColor> {
  const byAge = [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Map<ProjectColor, number>(PROJECT_COLORS.map((k) => [k, 0]));
  const out = new Map<string, ProjectColor>();
  for (const p of byAge) {
    // A key the daemon doesn't send now (one a later palette dropped) is auto, not a missing token.
    const kept = p.color && (PROJECT_COLORS as readonly string[]).includes(p.color) ? p.color : null;
    const key = kept ?? PROJECT_COLORS.reduce((best, k) => (used.get(k)! < used.get(best)! ? k : best));
    used.set(key, used.get(key)! + 1);
    out.set(p.id, key);
  }
  return out;
}

/** The class that sets `--proj` to its key's token (shell/ui.css). */
export const projClass = (key: ProjectColor | undefined): string => (key ? `pc-${key}` : '');

/** This project's key, from every project the page has; undefined while there is no such project. */
export function useProjectColor(projectId: string | undefined): ProjectColor | undefined {
  const projects = useProjects();
  const colors = useMemo(() => projectColors(projects), [projects]);
  return projectId ? colors.get(projectId) : undefined;
}
