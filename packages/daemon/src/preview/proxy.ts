/**
 * PreviewProxy — serving the agent's dev server from the daemon's own origin.
 *
 * TRACK D OWNS THIS FILE.
 *
 * WHY A REVERSE PROXY AND NOT AN IFRAME
 * ─────────────────────────────────────
 * `<iframe src="http://localhost:3000">` from the Conductor UI does not work, and
 * it fails in a way that looks like a bug in our code rather than a policy
 * decision by the dev server. Two independent mechanisms block it:
 *
 *   • `X-Frame-Options: SAMEORIGIN` (or `DENY`) — shipped by default by a great
 *     many dev servers and frameworks.
 *   • `Content-Security-Policy: frame-ancestors …` — the modern equivalent, and
 *     the one that wins when both are present.
 *
 * Either way the browser renders an empty box and logs a refusal. There is no
 * client-side workaround: that is the entire point of the headers.
 *
 * So the daemon proxies instead. `/preview/:jobId/*` is served from the daemon's
 * own origin, and on the way back through we:
 *
 *   1. delete `X-Frame-Options` outright;
 *   2. surgically remove `frame-ancestors` from any CSP, leaving the rest of the
 *      policy intact — a preview that silently disables the app's own CSP would
 *      hide real bugs;
 *   3. rewrite the response body so the app's root-absolute asset paths resolve
 *      under the prefix (see `rewrite.ts`, which is where the difficulty is);
 *   4. inject the console-capture shim.
 *
 * Vite forwards `/preview` to the daemon (`packages/web/vite.config.ts`), so the
 * single-origin property holds in development too.
 *
 * SECURITY — READ BEFORE CHANGING `#resolveUpstream`
 * ─────────────────────────────────────────────────
 * This is a browser-reachable component that makes outbound connections. Two
 * invariants keep it from being an SSRF hole on the user's own machine:
 *
 *   • the target host is hard-coded to loopback and is never derived from the
 *     request, a query parameter, a header, or a command;
 *   • the target port must already be in the registry FOR THIS JOB and confirmed
 *     alive. A request for `/preview/<job>/…` cannot reach a port that job never
 *     opened, and cannot reach the daemon's own port.
 *
 * Anything that fails those checks gets a 404, not a redirect and not an error
 * that leaks whether the port was open.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { serverRegistry, type ServerRegistry } from './registry.js';
import { buildShim, rewritableKind, rewriteBody } from './rewrite.js';

/** Bodies larger than this stream through unrewritten. */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

export const PREVIEW_PREFIX = '/preview';

interface PreviewParams {
  jobId?: string;
  '*'?: string;
}

/** `/preview/<jobId>` — the value `DevServer.proxyPath` carries. */
function prefixFor(jobId: string): string {
  return `${PREVIEW_PREFIX}/${encodeURIComponent(jobId)}`;
}

/**
 * Read the `:jobId` route param.
 *
 * Typed structurally rather than as `FastifyRequest` on purpose: the reply-from
 * hooks declare their request with different generic arguments than the default
 * `FastifyRequest`, and under `strictFunctionTypes` an annotation would fight
 * the library instead of documenting anything.
 */
function jobIdOf(request: { params: unknown }): string | null {
  const params = request.params as PreviewParams | undefined;
  const raw = params?.jobId;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header surgery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove `frame-ancestors` from a CSP and, when necessary, allow our injected
 * inline shim to execute.
 *
 * The nonce is the careful part. Adding a nonce to a `script-src` that already
 * contains `'unsafe-inline'` would DISABLE unsafe-inline (the spec says a nonce
 * or hash source makes it ignored), breaking every other inline script in the
 * app. So the nonce is only added when the policy would actually have blocked
 * us, and otherwise the policy is left exactly as the app wrote it.
 */
export function sanitizeCsp(
  policy: string,
  nonce: string,
): { policy: string; nonceUsed: boolean } {
  const directives = policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  let nonceUsed = false;
  const out: string[] = [];

  for (const directive of directives) {
    const space = directive.search(/\s/);
    const name = (space === -1 ? directive : directive.slice(0, space)).toLowerCase();
    const value = space === -1 ? '' : directive.slice(space + 1).trim();

    // The whole reason the proxy exists.
    if (name === 'frame-ancestors') continue;

    if (name === 'script-src' || name === 'script-src-elem' || name === 'default-src') {
      if (!/'unsafe-inline'/.test(value) && !/'nonce-/.test(value)) {
        out.push(`${name} ${value} 'nonce-${nonce}'`.trim());
        nonceUsed = true;
        continue;
      }
    }

    // The shim POSTs captured console output back to the daemon, which is the
    // same origin as the document. A policy that forgot 'self' would silence it.
    if (name === 'connect-src' && !/'self'|\*/.test(value)) {
      out.push(`${name} ${value} 'self'`.trim());
      continue;
    }

    out.push(directive);
  }

  return { policy: out.join('; '), nonceUsed };
}

/**
 * Repoint a `Location` back inside the prefix so redirects stay in the pane.
 *
 * `upstreamOrigins` must list every spelling of the upstream the dev server
 * might emit — both loopback families and `localhost` — because a framework
 * building an absolute redirect uses whatever it thinks its own origin is, which
 * is often not the one we dialled.
 */
export function rewriteLocation(
  location: string,
  prefix: string,
  upstreamOrigins: readonly string[],
): string {
  // Absolute, pointing at the upstream itself.
  for (const origin of upstreamOrigins) {
    if (location.startsWith(origin)) {
      const rest = location.slice(origin.length) || '/';
      return prefix + (rest.startsWith('/') ? rest : `/${rest}`);
    }
  }
  // Absolute, pointing somewhere else entirely — leave it alone.
  if (/^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith('//')) return location;
  // Root-absolute.
  if (location.startsWith('/')) {
    if (location === prefix || location.startsWith(`${prefix}/`)) return location;
    return prefix + location;
  }
  // Relative — resolves against the request path, which is already prefixed.
  return location;
}

/** Every spelling of a loopback upstream a dev server might put in a header. */
export function upstreamOriginsFor(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    `http://localhost:${port}`,
    `http://0.0.0.0:${port}`,
  ];
}

/** Keep cookies scoped to the pane, and drop a Domain the daemon can't satisfy. */
export function rewriteSetCookie(cookie: string, prefix: string): string {
  let out = cookie.replace(/;\s*Domain=[^;]*/gi, '');
  if (/;\s*Path=/i.test(out)) {
    out = out.replace(/;\s*Path=([^;]*)/gi, (_m, path: string) => {
      const trimmed = path.trim();
      if (trimmed.startsWith(prefix)) return `; Path=${trimmed}`;
      return `; Path=${prefix}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
    });
  } else {
    out = `${out}; Path=${prefix}/`;
  }
  // `Secure` on a plain-http loopback origin makes the browser drop the cookie.
  return out.replace(/;\s*Secure/gi, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// The plugin
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewProxyOptions {
  registry?: ServerRegistry;
  /**
   * Proxy WebSocket upgrades under the prefix too.
   *
   * OFF by default, deliberately. `@fastify/http-proxy` installs its own
   * `server.on('upgrade')` listener, and W0's `@fastify/websocket` already owns
   * upgrades for the `/ws` event feed — the feed is the spine of the whole app
   * and a second upgrade listener is not worth the risk. It costs nothing in
   * practice: every dev server worth previewing (Vite included) computes an
   * ABSOLUTE `ws://host:port` URL for its HMR socket and connects to the dev
   * server directly, and a WebSocket is not subject to X-Frame-Options, so that
   * connection succeeds without us. HMR works.
   */
  websocket?: boolean;
}

export async function registerPreviewProxy(
  app: FastifyInstance,
  options: PreviewProxyOptions = {},
): Promise<void> {
  const registry = options.registry ?? serverRegistry();

  /**
   * THE SECURITY GATE. Called for every proxied request. Returns the upstream
   * origin, or null when this job has no confirmed live server.
   */
  const resolveUpstream = (request: { params: unknown }): string | null => {
    const jobId = jobIdOf(request);
    if (jobId === null) return null;
    return registry.upstreamFor(jobId);
  };

  /**
   * `@fastify/http-proxy` is declared as a callback-style plugin, which does not
   * structurally match the async plugin overload `register` picks first. The cast
   * is confined to the plugin reference: `proxyOptions` below keeps the library's
   * real option type, so every field and hook signature is still checked.
   */
  type ProxyOptions = Parameters<typeof httpProxy>[1];
  const proxyPlugin = httpProxy as unknown as FastifyPluginCallback<ProxyOptions>;

  const proxyOptions: ProxyOptions = {
    // Empty upstream + getUpstream is how @fastify/http-proxy supports a target
    // that isn't known until request time. Our port varies per job.
    upstream: '',
    prefix: '/preview/:jobId',
    rewritePrefix: '/',
    ...(options.websocket ? { websocket: true as const } : {}),

    // http-proxy's own Location rewriting does a literal string replace of the
    // rewritePrefix with the raw prefix — which would splice the uninterpolated
    // text `:jobId` into the header. We do it properly in rewriteHeaders.
    internalRewriteLocationHeader: false,

    /**
     * Reject before any connection is attempted. A job with no live server gets
     * a legible page rather than a blank iframe, because "blank box" is exactly
     * what the X-Frame-Options failure looks like and confusing the two costs
     * an hour.
     */
    preHandler: (request, reply, done) => {
      const jobId = jobIdOf(request);
      if (jobId === null) {
        void reply.code(400).send({ error: 'bad_job_id' });
        return;
      }
      if (registry.upstreamFor(jobId) === null) {
        const accepts = String(request.headers.accept ?? '');
        if (accepts.includes('text/html')) {
          void reply
            .code(404)
            .type('text/html; charset=utf-8')
            .send(noServerPage(jobId));
        } else {
          void reply.code(404).send({ error: 'no_dev_server', detail: `job ${jobId}` });
        }
        return;
      }
      done();
    },

    replyOptions: {
      getUpstream: (request): string => {
        // preHandler has already refused the null case; this is belt-and-braces
        // so a future refactor cannot turn a missing server into an open proxy.
        const upstream = resolveUpstream(request);
        if (upstream === null) throw new Error('preview: no upstream for this job');
        return upstream;
      },

      rewriteRequestHeaders: (request, headers) => {
        const jobId = jobIdOf(request);
        const prefix = jobId === null ? null : prefixFor(jobId);
        const target = jobId === null ? null : registry.activeTarget(jobId);

        const next = { ...headers } as IncomingHttpHeaders;

        // Rewriting a compressed body as text would corrupt it, and negotiating
        // identity is cheaper than inflating it just to re-deflate.
        next['accept-encoding'] = 'identity';

        // Vite's DNS-rebinding protection inspects Host. Present ourselves as
        // the upstream — using the loopback family it is actually bound to, so
        // an IPv6-only dev server doesn't see an IPv4 Host it will reject.
        if (target !== null) {
          next.host = target.host.includes(':')
            ? `[${target.host}]:${target.port}`
            : `${target.host}:${target.port}`;
        }

        // Let the upstream see the path it actually serves.
        if (typeof next.referer === 'string' && prefix !== null) {
          next.referer = next.referer.replace(prefix, '');
        }
        delete next.origin;

        // Our own connection management, not the browser's.
        delete next.connection;
        delete next['keep-alive'];
        delete next['proxy-connection'];
        delete next['transfer-encoding'];

        return next;
      },

      rewriteHeaders: (headers, request) => {
        const next = { ...headers } as IncomingHttpHeaders;
        const jobId = request ? jobIdOf(request) : null;
        const prefix = jobId === null ? null : prefixFor(jobId);
        const port = jobId === null ? null : registry.activePort(jobId);

        // ── 1. the frame blockers ───────────────────────────────────────────
        delete next['x-frame-options'];

        const nonce = randomUUID().replace(/-/g, '');
        for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
          const value = next[key];
          if (typeof value !== 'string') continue;
          const { policy, nonceUsed } = sanitizeCsp(value, nonce);
          if (policy.length === 0) delete next[key];
          else next[key] = policy;
          if (nonceUsed && request) {
            (request as { previewNonce?: string }).previewNonce = nonce;
          }
        }

        // ── 2. keep redirects and cookies inside the pane ───────────────────
        if (prefix !== null && port !== null && typeof next.location === 'string') {
          next.location = rewriteLocation(next.location, prefix, upstreamOriginsFor(port));
        }
        if (prefix !== null && next['set-cookie']) {
          const cookies = next['set-cookie'];
          const list = Array.isArray(cookies) ? cookies : [String(cookies)];
          next['set-cookie'] = list.map((c) => rewriteSetCookie(c, prefix));
        }

        // ── 3. we are about to change the body length ───────────────────────
        if (rewritableKind(asString(next['content-type'])) !== null && !isEncoded(next)) {
          delete next['content-length'];
          delete next['transfer-encoding'];
          // A rewritten body invalidates upstream's strong validator.
          delete next.etag;
        }
        delete next.connection;
        delete next['keep-alive'];

        return next;
      },

      /**
       * Buffer and rewrite text responses; stream everything else.
       *
       * Images, fonts and source maps must not be read into a string — that is
       * both a correctness problem (binary corruption) and a memory one.
       */
      onResponse: (request, reply, res): void => {
        /**
         * `@fastify/reply-from` hands `{ statusCode, headers, stream }` on the
         * undici path — NOT the stream itself. Reading the body off `res`
         * directly throws, and the default (no `onResponse`) path sends
         * `res.stream`, which is the tell.
         */
        const upstream = res as unknown as {
          statusCode?: number;
          headers?: IncomingHttpHeaders;
          stream: NodeJS.ReadableStream;
        };
        const headers = upstream.headers ?? {};

        const jobId = jobIdOf(request);
        const kind = rewritableKind(asString(headers['content-type']));
        const status = upstream.statusCode ?? 200;
        const bodyless = status === 204 || status === 304 || request.method === 'HEAD';

        if (jobId === null || kind === null || bodyless || isEncoded(headers)) {
          void reply.send(upstream.stream);
          return;
        }

        const prefix = prefixFor(jobId);
        const chunks: Buffer[] = [];
        let size = 0;
        let bailed = false;

        const stream = upstream.stream;

        stream.on('data', (chunk: Buffer | string) => {
          if (bailed) return;
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += buf.length;
          if (size > MAX_REWRITE_BYTES) {
            // Too big to hold. Give up on rewriting rather than on the request.
            bailed = true;
            chunks.length = 0;
            request.log.warn(
              { url: request.url, size },
              'preview: response too large to rewrite, passing through',
            );
            void reply.send(stream);
            return;
          }
          chunks.push(buf);
        });

        stream.on('error', (err: Error) => {
          request.log.warn({ err, url: request.url }, 'preview: upstream stream error');
          if (!reply.sent) void reply.code(502).send({ error: 'upstream_error' });
        });

        stream.on('end', () => {
          if (bailed) return;
          const text = Buffer.concat(chunks).toString('utf8');
          const nonce = (request as { previewNonce?: string }).previewNonce;
          let out: string;
          try {
            out = rewriteBody(kind, text, {
              prefix,
              ...(kind === 'html'
                ? {
                    shim: buildShim({
                      prefix,
                      jobId,
                      consoleEndpoint: `/api/jobs/${encodeURIComponent(jobId)}/console`,
                    }),
                  }
                : {}),
            });
            // A CSP nonce has to appear on the tag as well as in the header.
            if (kind === 'html' && nonce) {
              out = out.replace(
                '<script data-conductor-preview="shim">',
                `<script data-conductor-preview="shim" nonce="${nonce}">`,
              );
            }
          } catch (err) {
            request.log.error({ err, url: request.url }, 'preview: rewrite failed');
            out = text; // an unrewritten page beats a 500
          }
          void reply.send(out);
        });
      },
    },
  };

  await app.register(proxyPlugin, proxyOptions);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A compressed body cannot be string-rewritten; detect and leave it alone. */
function isEncoded(headers: IncomingHttpHeaders): boolean {
  const encoding = asString(headers['content-encoding'])?.toLowerCase().trim();
  return encoding !== undefined && encoding.length > 0 && encoding !== 'identity';
}

/**
 * Shown inside the iframe when a job has no live dev server.
 *
 * Deliberately explicit about *why* the pane is empty. An unexplained blank
 * frame is indistinguishable from the X-Frame-Options failure this whole track
 * exists to avoid, and mistaking one for the other wastes real time.
 */
function noServerPage(jobId: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>no dev server</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:grid; place-items:center;
         background:#100f0e; color:#a39c92;
         font:13px/1.6 ui-monospace, monospace; }
  div { max-width:34em; padding:0 2em }
  b { color:#ece7de; font-weight:600 }
  code { color:#ffb03a }
</style></head>
<body><div>
  <p><b>No dev server detected for this job.</b></p>
  <p>Conductor watches the agent's own <code>Bash</code> calls for a dev-server
     launch and confirms the port by probing it. Nothing is listening yet.</p>
  <p>Start one in the job's worktree — <code>npm run dev</code>, <code>vite</code>,
     <code>next dev</code> — and this pane will pick it up within a few seconds.</p>
  <p style="opacity:.6">job ${escapeHtml(jobId)}</p>
</div></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
