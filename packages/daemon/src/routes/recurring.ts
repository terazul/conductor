/**
 * Jobs and messages that repeat (Amendments 211, 216).
 *
 *   GET    /api/recurring          → { recurring: RecurringJob[] }
 *   POST   /api/recurring          ← { name, every, request }
 *                                  | { name, every, fromJobId, prompt? }
 *                                  | { name, every, agentId, text } → 201 { recurring }
 *   PATCH  /api/recurring/:id      ← { name?, every?, paused?, text?, prompt? } → { recurring }
 *   POST   /api/recurring/:id/run  → { recurring, skipped? }: run once now, the next time left where
 *                                    it is; `skipped: 'it is being run now'` when the clock or
 *                                    another run now already is, and nothing more ran
 *   DELETE /api/recurring/:id      → { removed }
 *
 * `request` is checked exactly as `POST /api/jobs` checks a launch (`parseCreateJob`), and
 * kept as it comes back from that check; `every` by `everyProblem`. `fromJobId` is that job's
 * kept setup (Amendment 216), its prompt replaced when one is given, then checked as `request`
 * is; a job from before setups were kept is refused. A message needs an agent that is there and
 * not a helper, which its orchestrator directs, and text as ⏲ later's does. PATCH re-checks a new `prompt` the same way. Each run launches a new
 * job, or sends the text, on the clock in session/schedule.ts; the rules are in
 * session/recurring.ts. Deleting one is cancelling it: the jobs it started stay.
 *
 * Every change is broadcast as a `recurring` frame. Errors are `{ error, detail? }`: 400 for a
 * bad name, rule, request or text, 404 for no such project, job, agent or schedule.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CreateJobRequest, Every, PatchRecurringRequest } from '@conductor/shared';
import { HELPER_NOT_SCHEDULED, NOT_REPEATABLE, everyProblem, normalEvery, recurringNameProblem as nameProblem } from '@conductor/shared';
import { openDb } from '../db/index.js';
import { getAgent, getJob, getProject, jobRequest } from '../session/store.js';
import { SCHEDULED_TEXT_MAX } from '../session/schedule.js';
import { supervisor } from '../session/supervisor.js';
import {
  broadcastRecurring,
  deleteRecurring,
  getRecurring,
  insertRecurring,
  listRecurring,
  patchRecurring,
  runRecurringNow,
} from '../session/recurring.js';
import { parseCreateJob } from './session.js';

type Refusal = { status: number; error: string; detail?: string };

/** A message's text, trimmed, or what is wrong with it: as ⏲ later's. */
function textOf(raw: unknown): string | Refusal {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { status: 400, error: 'text is required' };
  if (text.length > SCHEDULED_TEXT_MAX) return { status: 400, error: `text is longer than ${SCHEDULED_TEXT_MAX} characters` };
  return text;
}

/**
 * A setup checked as a repeating launch: as POST /api/jobs checks it, and then what Spawn's
 * repeat… refuses, refused here too. A run that waits for instructions, or has no prompt, would
 * start a job that sits waiting every time it comes due.
 */
async function launchOf(raw: unknown): Promise<CreateJobRequest | Refusal> {
  const parsed = await parseCreateJob(raw);
  if (!parsed.ok) return { status: parsed.status, error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}) };
  if (parsed.request.waitForInstructions === true) {
    return { status: 400, error: 'a repeating launch cannot wait for instructions', detail: 'give it a prompt to run each time' };
  }
  if (parsed.request.prompt.trim() === '') return { status: 400, error: 'a repeating launch needs a prompt' };
  return parsed.request;
}

/** A setup with a new prompt: no longer waiting for instructions, since it has some. */
function withPrompt(request: CreateJobRequest, prompt: unknown): unknown {
  if (prompt === undefined) return request;
  const { waitForInstructions: _waits, ...rest } = request;
  return { ...rest, prompt };
}

const refused = (x: unknown): x is Refusal => typeof x === 'object' && x !== null && 'status' in x && 'error' in x;

function fail(reply: FastifyReply, code: number, error: string, detail?: string): FastifyReply {
  return reply.code(code).send(detail ? { error, detail } : { error });
}

export default async function recurringRoutes(app: FastifyInstance): Promise<void> {
  const db = openDb();

  app.get('/api/recurring', async () => ({ recurring: listRecurring(db) }));

  app.post<{ Body: Record<string, unknown> }>('/api/recurring', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const badName = nameProblem(body['name']);
    if (badName) return fail(reply, 400, badName);
    const badEvery = everyProblem(body['every']);
    if (badEvery) return fail(reply, 400, badEvery);
    const name = (body['name'] as string).trim();
    const every = normalEvery(body['every'] as Every);

    // A message to an agent (Amendment 216).
    if (body['agentId'] !== undefined) {
      const agent = typeof body['agentId'] === 'string' ? getAgent(db, body['agentId']) : undefined;
      if (!agent) return fail(reply, 404, 'no such agent');
      // Its orchestrator directs it, and clears it (and so its schedules) once it has finished.
      if (agent.parentId) return fail(reply, 400, HELPER_NOT_SCHEDULED);
      const text = textOf(body['text']);
      if (refused(text)) return fail(reply, text.status, text.error);
      const recurring = insertRecurring(db, { name, every, agentId: agent.id, projectId: agent.projectId, text });
      broadcastRecurring(db);
      return reply.code(201).send({ recurring });
    }

    // A job like one you ran (Amendment 216): its kept setup, its prompt replaced if given.
    let raw: unknown = body['request'];
    if (body['fromJobId'] !== undefined) {
      const jobId = typeof body['fromJobId'] === 'string' ? body['fromJobId'] : '';
      if (!getJob(db, jobId)) return fail(reply, 404, 'no such job');
      const stored = jobRequest(db, jobId);
      if (!stored) return fail(reply, 400, NOT_REPEATABLE);
      raw = withPrompt(stored, body['prompt']);
    }
    const request = await launchOf(raw);
    if (refused(request)) return fail(reply, request.status, request.error, request.detail);
    if (!getProject(db, request.projectId)) return fail(reply, 404, 'no such project');
    const recurring = insertRecurring(db, { name, every, request });
    broadcastRecurring(db);
    return reply.code(201).send({ recurring });
  });

  app.patch<{ Params: { id: string }; Body: PatchRecurringRequest }>('/api/recurring/:id', async (req, reply) => {
    const was = getRecurring(db, req.params.id);
    if (!was) return fail(reply, 404, 'no such schedule');
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
    // A message's text, or a job's prompt: each only on its own kind.
    let text: string | undefined;
    if (body.text !== undefined) {
      if (was.kind !== 'message') return fail(reply, 400, 'only a repeating message has text', 'a job has a prompt');
      const t = textOf(body.text);
      if (refused(t)) return fail(reply, t.status, t.error);
      text = t;
    }
    let request: CreateJobRequest | undefined;
    if (body.prompt !== undefined) {
      if (was.kind !== 'job') return fail(reply, 400, 'only a repeating job has a prompt', 'a message has text');
      const r = await launchOf(withPrompt(was.request!, body.prompt));
      if (refused(r)) return fail(reply, r.status, r.error, r.detail);
      request = r;
    }
    const recurring = patchRecurring(db, req.params.id, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.every !== undefined ? { every: normalEvery(body.every) } : {}),
      ...(body.paused !== undefined ? { paused: body.paused } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(request !== undefined ? { request } : {}),
    });
    broadcastRecurring(db);
    return { recurring };
  });

  app.post<{ Params: { id: string } }>('/api/recurring/:id/run', async (req, reply) => {
    const ran = await runRecurringNow(db, supervisor(), req.params.id);
    if (!ran) return fail(reply, 404, 'no such schedule');
    if (!ran.skipped) broadcastRecurring(db);
    return ran;
  });

  app.delete<{ Params: { id: string } }>('/api/recurring/:id', async (req, reply) => {
    if (!deleteRecurring(db, req.params.id)) return fail(reply, 404, 'no such schedule');
    broadcastRecurring(db);
    return { removed: true };
  });
}
