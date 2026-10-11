/**
 * The Metrics screen's one request (Amendment 122).
 *
 * The route is the daemon's (`routes/metrics.ts`); its path lives here and nowhere else,
 * the way `branches/endpoints.ts` keeps the Branches screen's. A range the daemon does not
 * know is a 400 with its own sentence, which `api()` raises as an `ApiError`.
 */

import type { MetricsRange, MetricsResponse } from '@conductor/shared';
import { api } from '../lib/feed.js';

/** Totals, one row per model, one per day, and (for `all`) what came before recording. */
export function getMetrics(range: MetricsRange): Promise<MetricsResponse> {
  return api<MetricsResponse>(`/api/metrics?range=${encodeURIComponent(range)}`);
}
