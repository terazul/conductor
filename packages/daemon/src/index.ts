/**
 * conductord — the daemon.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks A–E.
 *
 * ROUTE AUTO-REGISTRATION. Every .ts file in src/routes/ is imported and
 * registered as a Fastify plugin. Adding an endpoint means adding a FILE, never
 * editing a shared route table — that's what keeps five parallel agents from
 * colliding here. One route file per track:
 *
 *   routes/health.ts     W0
 *   routes/session.ts    Track A
 *   routes/preview.ts    Track D
 *   routes/workspace.ts  Track C
 *
 * Each must `export default async function (app: FastifyInstance) { ... }`.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { WS_PATH, DEFAULT_PORT } from '@conductor/shared';
import { openDb } from './db/index.js';
import { initEventLog } from './eventlog.js';
import { initHub, hub } from './hub.js';
import { refuseNonLocal } from './guard.js';
import { decideAtBoot, storageNow } from './storage.js';
import { askFirst } from './setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Localhost only. This is the primary security boundary — see PLAN.md §10. */
const HOST = process.env.CONDUCTOR_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CONDUCTOR_PORT ?? DEFAULT_PORT);

/**
 * Bearer token. Scaffolded now, enforced when CONDUCTOR_TOKEN is set.
 * Left opt-in for local development so tracks aren't blocked plumbing auth;
 * turning it on is an I5 hardening item, not a v1 feature.
 */
const TOKEN = process.env.CONDUCTOR_TOKEN ?? null;

async function registerRoutes(app: FastifyInstance): Promise<void> {
  const dir = join(HERE, 'routes');
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'),
    );
  } catch {
    app.log.warn('no routes/ directory found');
    return;
  }

  for (const file of files.sort()) {
    const url = pathToFileURL(join(dir, file)).href;
    const mod = (await import(url)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      app.log.warn(`routes/${file} has no default-exported plugin — skipped`);
      continue;
    }
    await app.register(mod.default as Parameters<FastifyInstance['register']>[0]);
    app.log.info(`registered routes/${file}`);
  }
}

export async function build(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  const db = openDb();
  initEventLog(db);
  initHub();

  // Before the token check, and unconditional: a token is opt-in, this is not.
  app.addHook('onRequest', async (req, reply) => {
    const refused = refuseNonLocal(req.headers.host, req.headers.origin);
    if (!refused) return;
    if (req.headers.upgrade) {
      // A WebSocket upgrade arrives on a socket the HTTP server has already let go
      // of. A normal reply is written to it and nobody ever closes it, so the next
      // app.close() waits on that socket forever. Answer on the raw socket and end it.
      reply.hijack();
      req.raw.socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    await reply.code(403).send({ error: `refused: ${refused} is not local` });
  });

  if (TOKEN) {
    app.addHook('onRequest', async (req, reply) => {
      // The proxy path is loaded by an iframe, which cannot set headers.
      if (req.url.startsWith('/preview/')) return;
      const header = req.headers.authorization;
      if (header !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  await app.register(websocket, {
    options: {
      // A snapshot with many agents can be large; a replay batch larger.
      maxPayload: 16 * 1024 * 1024,
      verifyClient: TOKEN
        ? (info, done) => {
            const url = new URL(info.req.url ?? '/', 'http://localhost');
            done(url.searchParams.get('token') === TOKEN);
          }
        : undefined,
    },
  });

  app.get(WS_PATH, { websocket: true }, (socket) => {
    hub().add(socket);
  });

  await registerRoutes(app);

  return app;
}

async function main(): Promise<void> {
  // Nothing is written under home until the user says so (Amendment 46).
  if (decideAtBoot() === 'undecided') await askFirst(HOST, PORT);
  const where = storageNow();
  console.log(where.saved ? `[storage] keeping data in ${where.dir}` : `[storage] ${where.mode}: nothing is saved`);
  const app = await build();
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`conductord on http://${HOST}:${PORT}  (ws ${WS_PATH})`);
    if (!TOKEN) {
      app.log.warn('CONDUCTOR_TOKEN unset — auth disabled. Localhost bind is the only guard.');
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info(`${sig} — shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }
}

// Only run when executed directly, so the spike and tests can import build().
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
