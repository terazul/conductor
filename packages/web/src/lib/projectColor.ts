/**
 * A project's colour bar (Amendment 210): the 4px bar down its left edge in the navigator, on its
 * Fleet card, and at the top of its Project, Agent and Files screens, so you can tell which project
 * in the menu a page is.
 *
 * A project keeps a key of `PROJECT_COLORS`, picked on the Fleet card's edit form, or none for auto.
 * Auto is `assignProjectColors` (shared/colors.ts): in creation order, each without a key takes the
 * key fewest before it have, so the first eight differ. The daemon pins what it gives, at a project's
 * creation, at start for any without one, and when you choose auto, so removing a project never moves
 * another's colour. A key you pick wins.
 *
 * The pure part has no DOM; lib/verify.ts checks it under Node.
 */

import { assignProjectColors, type Project, type ProjectColor } from '@conductor/shared';
import { useMemo } from 'react';
import { useProjects } from './store.js';

/** Every project's key: the one the daemon pinned, or, from a daemon that pins none, the same rule's. */
export function projectColors(projects: readonly Pick<Project, 'id' | 'createdAt' | 'color'>[]): Map<string, ProjectColor> {
  return assignProjectColors(projects);
}

/** The class that sets `--proj` to its key's token (shell/ui.css). */
export const projClass = (key: ProjectColor | undefined): string => (key ? `pc-${key}` : '');

/** This project's key, from every project the page has; undefined while there is no such project. */
export function useProjectColor(projectId: string | undefined): ProjectColor | undefined {
  const projects = useProjects();
  const colors = useMemo(() => projectColors(projects), [projects]);
  return projectId ? colors.get(projectId) : undefined;
}
