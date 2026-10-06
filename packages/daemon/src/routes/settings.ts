/**
 * Settings over HTTP and the socket (Amendment 46). W0's.
 *
 * GET for a page that wants them before the snapshot, PATCH to change some, and every
 * change is broadcast as a `settings` frame so the other tabs follow. The snapshot
 * carries them too, so a fresh tab starts with them.
 */

import type { FastifyInstance } from 'fastify';
import { hub, registerSnapshotContributor } from '../hub.js';
import { patchSettings, readSettings } from '../settings.js';
import { storageNow } from '../storage.js';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  registerSnapshotContributor(() => ({ settings: readSettings() }));

  app.get('/api/settings', async () => ({ settings: readSettings(), saved: storageNow().saved }));

  app.patch('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as { settings?: unknown };
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return reply.code(400).send({ error: 'send { settings: { name: value | null } }' });
    }
    try {
      const settings = patchSettings(body.settings as Record<string, unknown>);
      hub().broadcast({ type: 'settings', settings });
      return { settings, saved: storageNow().saved };
    } catch (err) {
      return reply.code(400).send({ error: 'could not change settings', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
