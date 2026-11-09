/**
 * The fleet's month, set to the AI gateway's figure (Amendment 206).
 *
 *   POST /api/spend/month-correction  { gatewayUsd: number | null } → MonthCorrectionResponse
 *
 * "Sometimes there is a gap on spend to month and the actual calculated by the AI gateway." With a
 * number, the month as Conductor counted it is read now and the difference is kept, for this local
 * month, as the setting `conductor.monthCorrection`; `costMonth` adds it, and the spend counted
 * after it adds on top. With null the correction is cleared. Nothing in `cost_daily` is rewritten,
 * and the engines', routes' and projects' months are as counted.
 *
 * Whenever the setting changes, here or by PATCH /api/settings, every page is told the month again
 * and the budgets are looked at, so the status bar and the fleet's monthly alert follow.
 *
 * Errors are `{ error }`: 400 for a body that is not a figure in dollars or null.
 */

import type { FastifyInstance } from 'fastify';
import { MONTH_CORRECTION_KEY, MONTH_CORRECTION_MAX, type MonthCorrection, type MonthCorrectionResponse } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { broadcastSpend, costChanged } from '../daily.js';
import { hub } from '../hub.js';
import { costMonth, costMonthRaw, localMonth, monthCorrection } from '../session/store.js';
import { onSettingsChanged, patchSettings } from '../settings.js';

export default async function spendRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  const off = onSettingsChanged((changed) => {
    if (!changed.includes(MONTH_CORRECTION_KEY)) return;
    broadcastSpend(db);
    costChanged();
  });
  app.addHook('onClose', async () => {
    off();
  });

  app.post('/api/spend/month-correction', async (req, reply) => {
    const body = (req.body ?? {}) as { gatewayUsd?: unknown };
    const g = body.gatewayUsd;
    if (g !== null && (typeof g !== 'number' || !Number.isFinite(g) || g < 0 || g > MONTH_CORRECTION_MAX)) {
      return reply.code(400).send({ error: `send { gatewayUsd }: the gateway's figure for this month, in dollars from 0 up to ${MONTH_CORRECTION_MAX.toLocaleString('en')}, or null to clear it` });
    }
    let next: MonthCorrection | null = null;
    if (g !== null) next = { month: localMonth(), usd: g - costMonthRaw(db), gatewayUsd: g, at: new Date().toISOString() };
    const settings = patchSettings({ [MONTH_CORRECTION_KEY]: next === null ? null : JSON.stringify(next) });
    hub().broadcast({ type: 'settings', settings });
    const answer: MonthCorrectionResponse = { costMonth: costMonth(db), counted: costMonthRaw(db), monthCorrection: monthCorrection() };
    return answer;
  });
}
