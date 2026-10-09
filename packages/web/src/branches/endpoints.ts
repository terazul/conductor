/**
 * The Branches screen's two requests (Amendment 109, ADR 0008).
 *
 * The routes are the daemon's (`routes/branches.ts`); their paths live here and nowhere
 * else, the way `fleet/endpoints.ts` keeps Project's. Both go through `api()`, so a
 * refusal arrives as an `ApiError` with the daemon's own sentence: 400 for a bad name or
 * an empty message, 404 for no such project, 409 for a live branch, a dirty or missing
 * main checkout, nothing to commit or a rejected push, 504 for a fetch or push that
 * timed out, and 500 for git failing.
 */

import type { BranchAction, BranchActionResult, BranchesResponse } from '@conductor/shared';
import { api } from '../lib/feed.js';

const path = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/branches`;

/** A project's local branches, each against its default branch. */
export function getBranches(projectId: string): Promise<BranchesResponse> {
  return api<BranchesResponse>(path(projectId));
}

/** Merge, merge all, commit, push or fetch. The answer carries the branches as they are after. */
export function branchAction(projectId: string, action: BranchAction): Promise<BranchActionResult> {
  return api<BranchActionResult>(path(projectId), { method: 'POST', body: action });
}
