/**
 * Project commands issued from screen 7.  TRACK A.
 *
 * `DELETE /api/projects/:projectId` is this track's own route
 * (`routes/session.ts`), so its client wrapper belongs here rather than being
 * borrowed from the Fleet screen's copy. Same arrangement as `agent/endpoints.ts`
 * and `fleet/endpoints.ts`: one endpoints module per screen family, so a path
 * rename has a fixed number of places to land and never reaches into a component.
 *
 * `useCommand` is NOT duplicated — it is imported from Track B's
 * `agent/endpoints.ts`, read-only, the way `fleet/card.tsx` does.
 * Re-implementing its error explainer would mean two translations of the same
 * 409 drifting apart, and 409 is the status that matters here: the daemon refuses
 * to forget a project while one of its agents is still running, and the reason it
 * gives names the agent.
 */

import { api } from '../lib/feed.js';

/**
 * What the daemon forgot, and what it left alone.
 *
 * Deliberately not in `shared/src/wire.ts` (Amendment 2): a response body for one
 * command is not a contract between tracks, and `Project` itself is unchanged.
 * `keptOnDisk` is the field that matters to a person — the worktree directories
 * the removal walked away from on purpose.
 */
export interface ProjectRemoval {
  projectId: string;
  name: string;
  path: string;
  jobs: number;
  agents: number;
  keptOnDisk: string[];
}

export function removeProject(projectId: string): Promise<{ removed: ProjectRemoval }> {
  return api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
}
