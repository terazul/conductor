/**
 * Directory completion for the Spawn screen's "where" field.
 *
 * TRACK C owns this file — it is filesystem access, and the limits that make it
 * safe are this track's to keep (see workspace/browse.ts). Auto-registered by
 * daemon/src/index.ts, which globs src/routes/*.ts, so adding it needed no edit
 * to a shared route table.
 *
 *   GET /api/fs/complete?path=<partial>   → CompleteResult
 *
 * Deliberately NOT in the frozen `shared/src/wire.ts`, per Amendment 2: this is
 * an affordance for one input field, not part of the contract between tracks, and
 * enshrining it would freeze a shape that should stay free to change.
 *
 * ONE ENDPOINT, read-only, directories only. There is no POST here and there must
 * not be: mkdir over HTTP is a different feature with a different threat model.
 */

import type { FastifyInstance } from 'fastify';
import { completePath, type CompleteResult } from '../workspace/browse.js';

interface CompleteQuery {
  path?: string;
}

export default async function fsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: CompleteQuery; Reply: CompleteResult | { error: string } }>(
    '/api/fs/complete',
    async (req, reply) => {
      // No try/catch around completePath by design — it is written to return an
      // empty list for every filesystem condition a half-typed path produces
      // (missing, not a directory, not readable). If it ever throws, that is a
      // bug and belongs in the log as a 500, not swallowed into "no matches".
      return reply.send(completePath(req.query.path ?? ''));
    },
  );
}
