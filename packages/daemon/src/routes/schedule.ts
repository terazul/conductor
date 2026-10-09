/**
 * Messages sent to an agent at a time you choose (Amendment 111).
 *
 *   GET    /api/scheduled                    → { scheduled: ScheduledMessage[] }
 *   POST   /api/agents/:agentId/scheduled    ← { at, text } → 201 { message }
 *   DELETE /api/scheduled/:id                → { removed }
 *
 * Pausing everything until a time is the `conductor.pauseUntil` setting, through
 * PATCH /api/settings like any other; session/schedule.ts watches it.
 *
 * Auto-registered by index.ts like every file here, which is before session.ts has made
 * the scheduler: so it is only looked up inside a handler. Every change is broadcast as a
 * `scheduled` frame. Errors are `{ error, detail? }`: 400 for a bad time or text, 404 for
 * no such agent or message.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ScheduleMessageRequest } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { getAgent } from '../session/store.js';
import {
  SCHEDULED_TEXT_MAX,
  deleteScheduled,
  insertScheduled,
  listScheduled,
  scheduler,
  timeProblem,
} from '../session/schedule.js';

function fail(reply: FastifyReply, code: number, error: string, detail?: string): FastifyReply {
  return reply.code(code).send(detail ? { error, detail } : { error });
}

export default async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  app.get('/api/scheduled', async () => ({ scheduled: listScheduled(db) }));

  app.post<{ Params: { agentId: string }; Body: ScheduleMessageRequest }>(
    '/api/agents/:agentId/scheduled',
    async (req, reply) => {
      if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
      const body = (req.body ?? {}) as Partial<ScheduleMessageRequest>;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return fail(reply, 400, 'text is required');
      if (text.length > SCHEDULED_TEXT_MAX) return fail(reply, 400, `text is longer than ${SCHEDULED_TEXT_MAX} characters`);
      const why = timeProblem(body.at);
      if (why) return fail(reply, 400, why);
      const message = insertScheduled(db, req.params.agentId, body.at as string, text);
      scheduler().broadcast();
      // A time a moment ago goes out now rather than on the next look.
      void scheduler().tick();
      return reply.code(201).send({ message });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/scheduled/:id', async (req, reply) => {
    if (!deleteScheduled(db, req.params.id)) return fail(reply, 404, 'no such scheduled message');
    scheduler().broadcast();
    return reply.send({ removed: req.params.id });
  });
}
