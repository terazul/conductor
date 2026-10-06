/**
 * W0's route file. Also the working example of the auto-registration contract:
 * default-export a Fastify plugin, drop the file in src/routes/, done.
 * No shared route table to edit — see src/index.ts.
 */

import type { FastifyInstance } from 'fastify';
import { buildSnapshot, hub } from '../hub.js';
import { eventLog } from '../eventlog.js';
import { dbPath, openDb } from '../db/index.js';
import { saveMemoryHome, storageNow } from '../storage.js';
import { buildNow } from '../build.js';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    seq: eventLog().head(),
    clients: hub().clientCount,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
  }));

  /** What is running and since when (Amendment 38). `behind`: HEAD moved since boot. */
  app.get('/api/build', async () => buildNow());

  /** Fresh page load fetches this, then subscribes with `since` = snapshot.seq. */
  app.get('/api/snapshot', async () => buildSnapshot());

  /**
   * The database, and how much of it is events left over from what you removed —
   * Diagnostics' cleanup button (Amendment 36). A POST, not a DELETE on a resource:
   * it clears whatever is orphaned when it runs, and running it twice is harmless.
   */
  app.get('/api/storage', async () => ({ ...eventLog().storage(), path: dbPath() }));
  /**
   * Where Conductor keeps its data (Amendment 46). The setup server answers the same GET
   * before this daemon runs; here the question is already answered, so the POST says so.
   */
  app.get('/api/storage/choice', async () => storageNow());
  app.post('/api/storage/choice', async (_req, reply) =>
    reply.code(409).send({ error: 'already decided', detail: `Conductor is running with ${storageNow().mode} storage` }),
  );
  /** An in-memory session changed its mind: copy it home, for the next start to open. */
  app.post('/api/storage/save-home', async (_req, reply) => {
    try {
      return saveMemoryHome(openDb());
    } catch (err) {
      return reply.code(409).send({ error: 'could not save it home', detail: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/storage/cleanup', async () => {
    const removed = eventLog().pruneOrphans();
    return { removed, ...eventLog().storage(), path: dbPath() };
  });
}
