/**
 * The other engines' settings: OpenRouter's key and the Copilot login.  TRACK A.
 * (Amendment 76)
 *
 *   GET /api/providers/openrouter/key   { set, source }
 *   PUT /api/providers/openrouter/key   { key: string | null } → { set, source }
 *   GET /api/providers/copilot/login    { authenticated, login, note? }
 *   GET /api/providers/codex/usage      { windows }
 *
 * THE KEY GOES IN, NEVER OUT. No response carries it, nothing logs it, and it is kept
 * in secrets.json rather than settings.json, which every tab is sent (session/secrets.ts).
 * `source: 'env'` means OPENROUTER_API_KEY is set, and wins over a key kept here.
 *
 * The login is asked of the Copilot runtime, which this starts if nothing has yet, and
 * fails soft: a runtime that can't say answers `authenticated: false` with a note.
 * Asking also refreshes what spawn checks, so signing in and opening Settings is enough.
 *
 * Also where the Copilot clients are stopped when the daemon closes. Fastify closes
 * plugins in the reverse of the order they were registered, and routes/ registers in
 * file order, so this runs after routes/session.ts has stopped every agent.
 */

import type { FastifyInstance } from 'fastify';
import { codexUsage } from '../session/backends/codex.js';
import { stopCodex } from '../session/backends/codex-client.js';
import { copilotLogin, copilotQuota, openRouterKeyUsage, stopCopilotClients } from '../session/backends/copilot.js';
import { claudeSource } from '../session/models.js';
import { openRouterKeyStatus, setOpenRouterKey } from '../session/secrets.js';

export default async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onClose', async () => {
    stopCodex();
    await stopCopilotClients();
  });

  app.get('/api/providers/openrouter/key', async () => openRouterKeyStatus());

  app.put('/api/providers/openrouter/key', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown };
    if (!('key' in body) || (body.key !== null && typeof body.key !== 'string')) {
      return reply.code(400).send({ error: 'send { key: string } to keep a key, or { key: null } to forget it' });
    }
    try {
      return setOpenRouterKey(body.key as string | null);
    } catch (err) {
      return reply.code(400).send({ error: 'not a key', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/providers/claude/source', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return claudeSource();
  });

  app.get('/api/providers/copilot/login', async () => copilotLogin());

  app.get('/api/providers/copilot/quota', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { quotas: await copilotQuota() };
    } catch {
      return reply.code(503).send({ error: 'Copilot account allowance is unavailable.' });
    }
  });

  app.get('/api/providers/openrouter/usage', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { usage: await openRouterKeyUsage() };
    } catch {
      return reply.code(503).send({ error: 'OpenRouter key usage is unavailable.' });
    }
  });

  app.get('/api/providers/codex/usage', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await codexUsage();
    } catch {
      return reply.code(503).send({ error: 'ChatGPT subscription usage is unavailable.' });
    }
  });
}
