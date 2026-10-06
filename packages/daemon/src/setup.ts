/**
 * The first start: a server that answers one question.  W0. (Amendment 46)
 *
 * Until the user says whether Conductor may keep its data in `~/.conductor/`, nothing
 * else can run — every part of the daemon opens the database at start, and which
 * database that is is the question. So this listens on the daemon's own port, answers
 * `/api/health` (so `make start` sees it up) and the question, refuses everything else
 * with 503, and closes as soon as it has an answer. The real daemon starts next, on
 * the same port; the page's feed reconnects to it on its own.
 */

import Fastify from 'fastify';
import { refuseNonLocal } from './guard.js';
import { allowHome, declineHome, storageNow } from './storage.js';

export async function askFirst(host: string, port: number): Promise<void> {
  const app = Fastify({ logger: false });
  let answered: () => void = () => {};
  const done = new Promise<void>((r) => (answered = r));

  app.addHook('onRequest', async (req, reply) => {
    const refused = refuseNonLocal(req.headers.host, req.headers.origin);
    if (refused) await reply.code(403).send({ error: `refused: ${refused} is not local` });
  });

  app.get('/api/health', async () => ({ ok: true, setup: true, storage: storageNow() }));
  app.get('/api/storage/choice', async () => storageNow());
  app.post('/api/storage/choice', async (req, reply) => {
    const body = (req.body ?? {}) as { allow?: unknown; bring?: unknown };
    if (typeof body.allow !== 'boolean') {
      return reply.code(400).send({ error: 'say allow: true or allow: false' });
    }
    let state;
    try {
      state = body.allow ? allowHome(body.bring === true) : declineHome();
    } catch (err) {
      return reply.code(500).send({ error: 'could not keep your data there', detail: err instanceof Error ? err.message : String(err) });
    }
    // Answer first, then make way for the real daemon.
    reply.raw.on('finish', () => setImmediate(answered));
    return state;
  });
  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(503).send({
      error: 'Conductor is waiting to be told where to keep its data',
      detail: 'open the web page and answer the question there',
    }),
  );

  await app.listen({ host, port });
  console.log(`[storage] waiting for an answer: may Conductor keep its data in ${storageNow().dir}? Open the page to say.`);
  await done;
  await app.close();
}
