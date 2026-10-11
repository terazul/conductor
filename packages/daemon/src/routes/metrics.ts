/**
 * The Metrics tab's endpoint (Amendment 122).
 *
 *   GET /api/metrics?range=today|7d|all  → MetricsResponse
 *
 * Auto-registered by index.ts like every file here. Totals, one row per engine and model,
 * one row per day, and for `all` the agents from before recording. Sums only: the screen
 * divides them into rates, since only it knows which two figures it has.
 *
 * This file also starts the recording of what the backends do not hand over themselves: a
 * retried model call (`api_retry`) and a failed run (the `failed` status). The rest is
 * written by the backends as results arrive (session/metrics.ts), and by the supervisor
 * at the end of a run.
 *
 * Errors are `{ error }`: 400 for a range that is not one of the three.
 */

import type { FastifyInstance } from 'fastify';
import type { MetricsRange } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { backendFor } from '../session/backends/index.js';
import { isProvider } from '../session/backend.js';
import { metricsReport, startMetrics } from '../session/metrics.js';

const RANGES: readonly MetricsRange[] = ['today', '7d', 'all'];

/** Whether an engine reports what a run cost in dollars. An engine nobody knows is taken not to. */
const reportsDollars = (provider: string): boolean =>
  isProvider(provider) && backendFor(provider)?.capabilities.costUsd === true;

export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  const stop = startMetrics(db);
  app.addHook('onClose', async () => stop());

  app.get<{ Querystring: { range?: string } }>('/api/metrics', async (req, reply) => {
    const range = (req.query.range ?? 'today') as MetricsRange;
    if (!RANGES.includes(range)) {
      return reply.code(400).send({ error: `range is one of ${RANGES.join(', ')}` });
    }
    return metricsReport(db, range, reportsDollars);
  });
}
