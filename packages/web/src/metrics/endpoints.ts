/**
 * The Metrics screen's one request (Amendment 122).
 *
 * The route is the daemon's (`routes/metrics.ts`); its path lives here and nowhere else,
 * the way `branches/endpoints.ts` keeps the Branches screen's. A range the daemon does not
 * know is a 400 with its own sentence, which `api()` raises as an `ApiError`; so is a project
 * id that is not one, and a project that is not there is a 404.
 */

import type { MetricsRange, MetricsResponse } from '@conductor/shared';
import { api } from '../lib/feed.js';

/**
 * Totals, one row per model, one per day, and (for `all`) what came before recording. With a
 * project (Amendment 136), that project's counts alone; a project that is gone is a 404.
 */
export function getMetrics(range: MetricsRange, projectId: string | null = null): Promise<MetricsResponse> {
  const project = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
  return api<MetricsResponse>(`/api/metrics?range=${encodeURIComponent(range)}${project}`);
}
