/**
 * Jobs that repeat (Amendment 211).
 *
 *   GET    /api/recurring        → { recurring: RecurringJob[] }
 *   POST   /api/recurring        ← { name, every, request } → 201 { recurring }
 *   PATCH  /api/recurring/:id    ← { name?, every?, paused? } → { recurring }
 *   DELETE /api/recurring/:id    → { removed }
 *
 * `request` is checked exactly as `POST /api/jobs` checks a launch (`parseCreateJob`), and
 * kept as it comes back from that check; `every` by `everyProblem`. Each run launches it as a
 * new job, on the clock in session/schedule.ts; the rules are in session/recurring.ts. Deleting
 * one is cancelling it: the jobs it started stay.
 *
 * Every change is broadcast as a `recurring` frame. Errors are `{ error, detail? }`: 400 for a bad name, rule or request, 404
 * for no such project or schedule.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CreateRecurringRequest, Every, PatchRecurringRequest } from '@conductor/shared';
import { everyProblem, normalEvery, recurringNameProblem as nameProblem } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { getProject } from '../session/store.js';
import {
  broadcastRecurring,
  deleteRecurring,
  getRecurring,
  insertRecurring,
  listRecurring,
  patchRecurring,
} from '../session/recurring.js';
import { parseCreateJob } from './session.js';

function fail(reply: FastifyReply, code: number, error: string, detail?: string): FastifyReply {
  return reply.code(code).send(detail ? { error, detail } : { error });
}

export default async function recurringRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  app.get('/api/recurring', async () => ({ recurring: listRecurring(db) }));

  app.post<{ Body: CreateRecurringRequest }>('/api/recurring', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateRecurringRequest>;
    const badName = nameProblem(body.name);
    if (badName) return fail(reply, 400, badName);
    const badEvery = everyProblem(body.every);
    if (badEvery) return fail(reply, 400, badEvery);
    const parsed = await parseCreateJob(body.request);
    if (!parsed.ok) return fail(reply, parsed.status, parsed.error, parsed.detail);
    if (!getProject(db, parsed.request.projectId)) return fail(reply, 404, 'no such project');
    // What Spawn's repeat… refuses, refused here too: a run that waits for instructions, or has no
    // prompt, would start a job that sits waiting every time it comes due.
    if (parsed.request.waitForInstructions === true) {
      return fail(reply, 400, 'a repeating launch cannot wait for instructions', 'give it a prompt to run each time');
    }
    if (parsed.request.prompt.trim() === '') return fail(reply, 400, 'a repeating launch needs a prompt');
    const recurring = insertRecurring(db, {
      name: (body.name as string).trim(),
      every: normalEvery(body.every as Every),
      request: parsed.request,
    });
    broadcastRecurring(db);
    return reply.code(201).send({ recurring });
  });

  app.patch<{ Params: { id: string }; Body: PatchRecurringRequest }>('/api/recurring/:id', async (req, reply) => {
    if (!getRecurring(db, req.params.id)) return fail(reply, 404, 'no such schedule');
    const body = (req.body ?? {}) as Partial<PatchRecurringRequest>;
    if (body.name !== undefined) {
      const badName = nameProblem(body.name);
      if (badName) return fail(reply, 400, badName);
    }
    if (body.every !== undefined) {
      const badEvery = everyProblem(body.every);
      if (badEvery) return fail(reply, 400, badEvery);
    }
    if (body.paused !== undefined && typeof body.paused !== 'boolean') return fail(reply, 400, 'paused is true or false');
    const recurring = patchRecurring(db, req.params.id, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.every !== undefined ? { every: normalEvery(body.every) } : {}),
      ...(body.paused !== undefined ? { paused: body.paused } : {}),
    });
    broadcastRecurring(db);
    return { recurring };
  });

  app.delete<{ Params: { id: string } }>('/api/recurring/:id', async (req, reply) => {
    if (!deleteRecurring(db, req.params.id)) return fail(reply, 404, 'no such schedule');
    broadcastRecurring(db);
    return { removed: true };
  });
}
