/**
 * Track D init — wires the registry, the console store, the proxy and the
 * snapshot contribution together.
 *
 * TRACK D OWNS THIS FILE.
 *
 * Called once from `routes/preview.ts`, which is the file the daemon's route
 * auto-registration discovers. That indirection is deliberate: the track needs a
 * boot hook, and the route glob is the only one W0 gives us — so there is nothing
 * for Track D to add to `index.ts`, and therefore nothing to collide on.
 */

import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { registerSnapshotContributor } from '../hub.js';
import { ConsoleStore } from './console.js';
import { registerPreviewProxy } from './proxy.js';
import { initServerRegistry, type ServerRegistry } from './registry.js';

export interface Preview {
  registry: ServerRegistry;
  console: ConsoleStore;
}

let instance: Preview | null = null;

export async function initPreview(app: FastifyInstance): Promise<Preview> {
  if (instance) return instance;

  const db = openDb();
  const registry = initServerRegistry(db);
  const consoleStore = new ConsoleStore(db);

  /**
   * A fresh page load needs the live servers before the feed takes over —
   * otherwise screen 6 shows "no dev server" for a second on every reload even
   * though one is running. Registered from our own module so no two tracks ever
   * edit `buildSnapshot` (CONTRACT.md §3).
   */
  registerSnapshotContributor(() => ({ servers: registry.wire() }));

  await registerPreviewProxy(app, { registry });

  app.addHook('onClose', async () => {
    registry.shutdown();
    instance = null;
  });

  instance = { registry, console: consoleStore };
  return instance;
}

export function preview(): Preview {
  if (!instance) throw new Error('preview not initialised — call initPreview(app) first');
  return instance;
}

export { ConsoleStore } from './console.js';
export { composeAgentMessage } from './console.js';
export { ServerRegistry, proxyPathFor } from './registry.js';
export { detectLaunch, extractPorts } from './detect.js';
export { isAllowedPort, probeHttp, pidForPort } from './probe.js';
export { rewriteHtml, rewriteJs, rewriteCss, buildShim } from './rewrite.js';
