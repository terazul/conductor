/**
 * Track D verification — proves the preview slice against a REAL dev server.
 *
 * TRACK D OWNS THIS FILE.
 *
 *   tsx --no-warnings=ExperimentalWarning src/preview/verify.ts
 *
 * Separate from W0's `smoke.ts`, which is frozen and which this must never
 * disturb. It exists because the two failure modes this track is built around
 * are both invisible to unit tests of my own helper functions:
 *
 *   • FRAME BLOCKING. Only a server that actually sends `X-Frame-Options` and a
 *     `frame-ancestors` CSP can prove the stripping works, and Vite sends
 *     neither. So we spin up a deliberately hostile upstream for that half.
 *   • ASSET PATHS. Rewriting HTML is easy to get right against a hand-written
 *     fixture and still fail against Vite, which serves a module graph whose
 *     specifiers are root-absolute in the TEXT IT GENERATES (`/@vite/client`
 *     imports `/@fs/…`). So we spin up a real Vite dev server for that half and
 *     assert on the bytes it produced, not on bytes we wrote.
 *
 * Everything is torn down on exit, including on failure.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createContext, runInContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../index.js';
import { eventLog } from '../eventlog.js';
import { serverRegistry } from './registry.js';
import { composeAgentMessage } from './console.js';
import { detectLaunch, extractPorts } from './detect.js';
import { isAllowedPort, originFor, probeHttp } from './probe.js';
import { buildShim, rewriteHtml, rewriteJs, rewriteCss } from './rewrite.js';
import { rewriteLocation, rewriteSetCookie, sanitizeCsp, upstreamOriginsFor } from './proxy.js';
import type { DevServer, DevServersResponse } from '@conductor/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SCRATCH = join(REPO_ROOT, 'fixtures/scratch-repo');
const VITE_BIN = join(REPO_ROOT, 'packages/web/node_modules/.bin/vite');

const DAEMON_PORT = 7801;
const VITE_PORT = 3141;
const HOSTILE_PORT = 3142;
/** Bound to ::1 ONLY — the case an IPv4-only probe silently misses. */
const IPV6_PORT = 3143;

const JOB = 'job_preview_verify';
/**
 * The hostile upstream gets its OWN job. `upstreamFor` picks a job's
 * lowest-numbered live port, so registering both servers under one job would
 * quietly proxy to Vite and make the header assertions pass for the wrong
 * reason — the most dangerous shape a security test can have.
 */
const HOSTILE_JOB = 'job_hostile_verify';
const IPV6_JOB = 'job_ipv6_verify';
const OTHER_JOB = 'job_never_registered';
const PROJECT = 'prj_preview_verify';
const AGENT = 'agt_preview_verify';

let failures = 0;
let checks = 0;

function check(label: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function base(): string {
  return `http://127.0.0.1:${DAEMON_PORT}`;
}

/**
 * Fetch through the daemon.
 *
 * `accept` defaults to `*&#47;*` because that is what a browser sends for a
 * subresource, and Vite's HTML-fallback middleware keys off `text/html` — asking
 * for HTML while fetching a script is not what the pane does and not what we
 * should assert against.
 */
async function get(
  path: string,
  init: RequestInit & { accept?: string } = {},
): Promise<{ status: number; headers: Headers; body: string }> {
  const { accept = '*/*', ...rest } = init;
  const res = await fetch(`${base()}${path}`, {
    ...rest,
    headers: { accept, ...(rest.headers ?? {}) },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** What a browser sends for the top-level document in the iframe. */
const DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture upstreams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A dev server that does everything possible to refuse being framed. This is
 * what the track exists to defeat; Vite is too polite to test it.
 */
function startHostileServer(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/landed' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; frame-ancestors 'none'; img-src 'self' data:",
      'set-cookie': 'sid=abc; Path=/; HttpOnly; Secure',
    });
    res.end(
      `<!doctype html><html><head><title>hostile</title></head>` +
        `<body><img src="/logo.png"><script type="module" src="/app.js"></script></body></html>`,
    );
  });
  return new Promise((ok) => server.listen(HOSTILE_PORT, '127.0.0.1', () => ok(server)));
}

/**
 * A server bound to `::1` and nothing else.
 *
 * This is not a contrived case. A dev server told to listen on `localhost` binds
 * ONE address, and on macOS `localhost` resolves to both `127.0.0.1` and `::1` —
 * Vite picked `[::1]` during this track's own development, and an IPv4-only probe
 * reported "no dev server" for a server that was serving perfectly. Every check
 * below passed before that bug was found, which is exactly why this fixture
 * exists.
 */
function startIpv6Server(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head></head><body><script src="/only-v6.js"></script></body></html>');
  });
  return new Promise((ok) => server.listen(IPV6_PORT, '::1', () => ok(server)));
}

function startVite(): Promise<ChildProcess> {
  const child = spawn(VITE_BIN, [SCRATCH, '--port', String(VITE_PORT), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('vite did not start in 30s')), 30_000);
    const watch = (buf: Buffer): void => {
      const text = buf.toString();
      if (text.includes('ready in')) {
        clearTimeout(timer);
        // Give it a beat to actually bind.
        setTimeout(() => ok(child), 300);
        return;
      }
      // With --strictPort a busy port makes vite exit, and waiting 30s for a
      // timeout to explain that is a waste of everyone's afternoon. Usually it
      // means a previous run of this script is still up.
      if (/is in use|EADDRINUSE/.test(text)) {
        clearTimeout(timer);
        fail(
          new Error(
            `port ${VITE_PORT} is already in use — a previous verify run may still be running ` +
              `(try: pkill -f "vite ${SCRATCH}")`,
          ),
        );
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.once('error', fail);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

function pureRewriteChecks(): void {
  console.log('\n1 · rewriting, in isolation');
  const P = '/preview/j1';

  const html = rewriteHtml(
    `<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head>` +
      `<body><img src="/x.png" srcset="/x.png 1x, /x2.png 2x">` +
      `<a href="https://example.com/keep">ext</a>` +
      `<a href="//cdn.example.com/keep">proto</a>` +
      `<img src="data:image/gif;base64,R0lGOD">` +
      `<form action="/submit"></form>` +
      `<style>.a{background:url(/bg.png)}</style>` +
      `<script type="module">import "/m.js";</script>` +
      `</body></html>`,
    { prefix: P },
  );

  check('root-absolute href prefixed', html.includes(`href="${P}/a.css"`));
  check('root-absolute src prefixed', html.includes(`src="${P}/x.png"`));
  check('srcset entries each prefixed', html.includes(`${P}/x.png 1x`) && html.includes(`${P}/x2.png 2x`));
  check('absolute URL left alone', html.includes('href="https://example.com/keep"'));
  check('protocol-relative left alone', html.includes('href="//cdn.example.com/keep"'));
  check('data: URI left alone', html.includes('src="data:image/gif;base64,R0lGOD"'));
  check('form action prefixed', html.includes(`action="${P}/submit"`));
  check('css url() inside <style> prefixed', html.includes(`url(${P}/bg.png)`));
  check('inline module specifier prefixed', html.includes(`import "${P}/m.js"`));

  check(
    'idempotent — a second pass changes nothing',
    rewriteHtml(html, { prefix: P }) === html,
  );

  const js = rewriteJs(
    `import a from "/a.js";\nexport { b } from '/b.js';\nimport("/c.js");\n` +
      `const u = new URL("/asset.png", import.meta.url);\n` +
      `import rel from "./keep.js";\nfetch("/api/keep");`,
    P,
  );
  check('import … from prefixed', js.includes(`from "${P}/a.js"`));
  check('export … from prefixed', js.includes(`from '${P}/b.js'`));
  check('dynamic import() prefixed', js.includes(`import("${P}/c.js")`));
  check('new URL() prefixed', js.includes(`new URL("${P}/asset.png"`));
  check('relative specifier untouched', js.includes(`from "./keep.js"`));
  check(
    'bare string left to the runtime shim',
    js.includes(`fetch("/api/keep")`),
    'static pass must not rewrite arbitrary strings',
  );

  const css = rewriteCss(`@import "/base.css";\na{background:url('/i.png')}\nb{background:url(//cdn/x.png)}`, P);
  check('@import prefixed', css.includes(`@import "${P}/base.css"`));
  check('url() prefixed', css.includes(`url('${P}/i.png')`));
  check('protocol-relative url() left alone', css.includes('url(//cdn/x.png)'));

  console.log('\n2 · header surgery, in isolation');
  const strict = sanitizeCsp("default-src 'self'; script-src 'self'; frame-ancestors 'none'", 'N1');
  check('frame-ancestors removed', !strict.policy.includes('frame-ancestors'));
  check('rest of the policy preserved', strict.policy.includes("default-src 'self'"));
  check('nonce added to a script-src that would block us', strict.policy.includes("'nonce-N1'"));

  const loose = sanitizeCsp("script-src 'self' 'unsafe-inline'; frame-ancestors *", 'N2');
  check(
    'no nonce when unsafe-inline is already allowed',
    !loose.policy.includes('nonce-') && !loose.nonceUsed,
    'a nonce would DISABLE unsafe-inline and break the app',
  );

  check(
    'Location rewritten into the pane',
    rewriteLocation('/landed', '/preview/j1', upstreamOriginsFor(3000)) === '/preview/j1/landed',
  );
  check(
    'absolute upstream Location folded into the pane',
    rewriteLocation('http://127.0.0.1:3000/landed', '/preview/j1', upstreamOriginsFor(3000)) ===
      '/preview/j1/landed',
  );
  check(
    'IPv6 upstream Location folded into the pane',
    rewriteLocation('http://[::1]:3000/landed', '/preview/j1', upstreamOriginsFor(3000)) ===
      '/preview/j1/landed',
    'a dev server bound to ::1 builds absolute redirects with brackets',
  );
  check(
    'localhost upstream Location folded into the pane',
    rewriteLocation('http://localhost:3000/landed', '/preview/j1', upstreamOriginsFor(3000)) ===
      '/preview/j1/landed',
  );
  check(
    'external Location untouched',
    rewriteLocation('https://example.com/x', '/preview/j1', upstreamOriginsFor(3000)) ===
      'https://example.com/x',
  );
  const cookie = rewriteSetCookie('sid=abc; Path=/; HttpOnly; Secure', '/preview/j1');
  check('cookie path scoped to the pane', cookie.includes('Path=/preview/j1/'));
  check('Secure dropped for a plain-http loopback origin', !/Secure/i.test(cookie));

  console.log('\n3 · command detection');
  const cases: Array<[string, string | null, number | undefined]> = [
    ['npm run dev', 'npm', undefined],
    ['pnpm dev', 'npm', undefined],
    ['yarn start', 'npm', undefined],
    ['npx vite --port 4000', 'vite', 4000],
    ['vite --port=4100', 'vite', 4100],
    ['next dev -p 3005', 'next', 3005],
    ['PORT=8123 npm start', 'npm', 8123],
    ['cd apps/web && pnpm dev', 'npm', undefined],
    ['nohup pnpm dev &', 'npm', undefined],
    ['python3 -m http.server 8010', 'python', 8010],
    ['php -S localhost:8011', 'php', 8011],
    ['ng serve --port 4300', 'angular', 4300],
    ['npm run build', null, undefined],
    ['npm test', null, undefined],
    ['vite build', null, undefined],
    ['lsof -ti tcp:3000', null, undefined],
    ['git status', null, undefined],
    ['cat package.json', null, undefined],
  ];
  for (const [command, kind, port] of cases) {
    const got = detectLaunch(command);
    const label = `"${command}" → ${kind ?? 'no launch'}`;
    if (kind === null) {
      check(label, got === null, got ? `matched ${got.kind}` : '');
    } else if (port === undefined) {
      check(label, got?.kind === kind, got ? `got ${got.kind}` : 'got null');
    } else {
      check(
        `${label} :${port}`,
        got?.kind === kind && got.candidatePorts[0] === port,
        got ? `${got.kind} ${got.candidatePorts.join(',')}` : 'got null',
      );
    }
  }
  check('extractPorts finds --port', extractPorts('vite --port 4000')[0] === 4000);
  check('extractPorts ignores a nonsense port', extractPorts('vite --port 7').length === 0);
}

async function securityChecks(): Promise<void> {
  console.log('\n4 · SSRF guard');
  const registry = serverRegistry();

  check('daemon refuses its own port', !isAllowedPort(DAEMON_PORT));
  check('port 0 refused', !isAllowedPort(0));
  check('port 99999 refused', !isAllowedPort(99_999));

  check(
    'unregistered job has no upstream',
    registry.upstreamFor(OTHER_JOB) === null,
  );
  check(
    'a port live but not registered for this job is refused',
    registry.upstreamFor(JOB, HOSTILE_PORT + 500) === null,
  );
  const upstream = registry.upstreamFor(JOB) ?? '';
  check(
    'upstream is always loopback, whichever family',
    upstream === originFor('127.0.0.1', VITE_PORT) || upstream === originFor('::1', VITE_PORT),
    upstream,
  );
  check(
    'upstream never names a resolvable hostname',
    !/^https?:\/\/(?!(?:127\.0\.0\.1|\[::1\]):)/.test(upstream),
    upstream,
  );

  const unregistered = await get(`/preview/${OTHER_JOB}/`, { accept: DOCUMENT_ACCEPT });
  check('proxy 404s for a job with no server', unregistered.status === 404, `got ${unregistered.status}`);
  check(
    '404 page explains itself rather than showing a blank frame',
    unregistered.body.includes('No dev server detected'),
  );

  check(
    'one job cannot reach another job’s port',
    registry.upstreamFor(OTHER_JOB, VITE_PORT) === null,
    'a live port registered elsewhere must still be refused',
  );

  const closed = await registry.register({ jobId: JOB, port: 3999 });
  check('registering a dead port is refused', closed === null);
}

async function frameHeaderChecks(): Promise<void> {
  console.log('\n5 · frame-blocking headers stripped');

  // Confirm the upstream really is hostile, so a pass below means something.
  const direct = await fetch(`http://127.0.0.1:${HOSTILE_PORT}/`);
  await direct.text();
  check(
    'upstream really does send X-Frame-Options: DENY',
    direct.headers.get('x-frame-options') === 'DENY',
  );
  check(
    'upstream really does send frame-ancestors',
    (direct.headers.get('content-security-policy') ?? '').includes('frame-ancestors'),
  );

  const registry = serverRegistry();
  await registry.register({ jobId: HOSTILE_JOB, port: HOSTILE_PORT, command: 'hostile fixture' });
  check(
    'hostile upstream is the only server for its job',
    registry.activePort(HOSTILE_JOB) === HOSTILE_PORT,
    `got ${registry.activePort(HOSTILE_JOB)}`,
  );

  const through = await get(`/preview/${HOSTILE_JOB}/`, { accept: DOCUMENT_ACCEPT });
  check('proxied through hostile upstream', through.status === 200, `got ${through.status}`);
  check('X-Frame-Options gone', through.headers.get('x-frame-options') === null);

  const csp = through.headers.get('content-security-policy') ?? '';
  check('CSP still present (not nuked wholesale)', csp.length > 0, 'expected a surviving policy');
  check('frame-ancestors gone from CSP', !csp.includes('frame-ancestors'), csp);
  check('the rest of the CSP survives', csp.includes("default-src 'self'"), csp);
  check('img-src survives', csp.includes('img-src'), csp);
  check('nonce issued for the shim', /'nonce-[0-9a-f]+'/.test(csp), csp);

  const nonce = /'nonce-([0-9a-f]+)'/.exec(csp)?.[1] ?? '';
  check(
    'the shim tag carries the matching nonce',
    nonce.length > 0 && through.body.includes(`nonce="${nonce}"`),
  );
  check(
    'hostile page’s own assets prefixed too',
    through.body.includes(`src="/preview/${HOSTILE_JOB}/app.js"`),
    through.body.slice(0, 200),
  );

  const cookie = through.headers.get('set-cookie') ?? '';
  check('cookie re-scoped to the pane', cookie.includes(`Path=/preview/${HOSTILE_JOB}`), cookie);

  const redirect = await fetch(`${base()}/preview/${HOSTILE_JOB}/redirect`, { redirect: 'manual' });
  await redirect.text().catch(() => undefined);
  check(
    'redirect stays inside the pane',
    redirect.headers.get('location') === `/preview/${HOSTILE_JOB}/landed`,
    String(redirect.headers.get('location')),
  );
}

async function ipv6Checks(): Promise<void> {
  console.log('\n6 · an IPv6-only dev server (the silent-failure case)');
  const registry = serverRegistry();

  check(
    'IPv4 cannot reach it, confirming the fixture is really v6-only',
    await fetch(`http://127.0.0.1:${IPV6_PORT}/`)
      .then(() => false)
      .catch(() => true),
  );

  const probe = await probeHttp(IPV6_PORT);
  check('probe still finds it', probe.ok, 'an IPv4-only probe reports "no dev server" here');
  check('probe reports which family answered', probe.host === '::1', String(probe.host));
  check('origin is bracketed for IPv6', originFor('::1', IPV6_PORT) === `http://[::1]:${IPV6_PORT}`);

  const server = await registry.register({ jobId: IPV6_JOB, port: IPV6_PORT, kind: 'v6-fixture' });
  check('registers normally', server !== null);
  check('registry remembers the family', server?.host === '::1');
  check(
    'upstream dials the family that answered',
    registry.upstreamFor(IPV6_JOB) === `http://[::1]:${IPV6_PORT}`,
    String(registry.upstreamFor(IPV6_JOB)),
  );

  const through = await get(`/preview/${IPV6_JOB}/`, { accept: DOCUMENT_ACCEPT });
  check('proxies end to end over IPv6', through.status === 200, `got ${through.status}`);
  check(
    'and still rewrites its asset paths',
    through.body.includes(`src="/preview/${IPV6_JOB}/only-v6.js"`),
    through.body.slice(0, 200),
  );
  check('and still injects the shim', through.body.includes('data-conductor-preview="shim"'));

  const wired = registry.wire(IPV6_JOB).find((s) => s.port === IPV6_PORT);
  check(
    'the wire reports ::1, not a guessed 127.0.0.1',
    wired?.host === '::1',
    `host=${String(wired?.host)}`,
  );

  check(
    'loopback is still the only reachable host',
    !isAllowedPort(DAEMON_PORT),
    'the self-port guard must survive the host change',
  );
}

async function viteChecks(): Promise<void> {
  console.log('\n7 · a real Vite dev server, embedded');
  const registry = serverRegistry();
  const prefix = `/preview/${JOB}`;

  const server = await registry.register({
    jobId: JOB,
    projectId: PROJECT,
    port: VITE_PORT,
    command: 'vite fixtures/scratch-repo',
    kind: 'vite',
  });
  check('vite registered after a live probe', server !== null);
  check('pid discovered from the listening socket', (server?.pid ?? 0) > 0, `pid=${server?.pid}`);
  check('proxyPath is a daemon path, never localhost:port', server?.proxyPath === prefix);

  // ── the document ─────────────────────────────────────────────────────────
  const doc = await get(`${prefix}/`, { accept: DOCUMENT_ACCEPT });
  check('document served through the proxy', doc.status === 200, `got ${doc.status}`);
  check('content-type preserved', (doc.headers.get('content-type') ?? '').includes('text/html'));
  check('shim injected', doc.body.includes('data-conductor-preview="shim"'));
  check(
    'shim is the first script in <head>',
    /<head[^>]*>\s*<script data-conductor-preview="shim"/.test(doc.body),
    'must run before the app so no early error is missed',
  );

  // These two are the whole asset-path problem: Vite injects both, both are
  // root-absolute, and both 404 through a naive proxy.
  check(
    "Vite's own client script prefixed",
    doc.body.includes(`src="${prefix}/@vite/client"`),
    doc.body.slice(0, 300),
  );
  check(
    'the app entry prefixed',
    doc.body.includes(`src="${prefix}/src/app.js"`),
    doc.body.slice(0, 300),
  );
  const strays = [...doc.body.matchAll(/\ssrc="(\/(?!preview\/)[^"]*)"/g)].map((m) => m[1]);
  check('no root-absolute src escaped the rewrite', strays.length === 0, strays.join(' '));

  // ── the rewritten URLs must actually resolve ─────────────────────────────
  const entry = await get(`${prefix}/src/app.js`);
  check('rewritten app entry resolves', entry.status === 200, `got ${entry.status}`);
  check(
    'entry served as JavaScript',
    (entry.headers.get('content-type') ?? '').includes('javascript'),
    String(entry.headers.get('content-type')),
  );
  check('entry is the real file', entry.body.includes('scratch app'));

  const client = await get(`${prefix}/@vite/client`);
  check('rewritten vite client resolves', client.status === 200, `got ${client.status}`);
  check(
    'vite client served as JavaScript, not an HTML fallback',
    (client.headers.get('content-type') ?? '').includes('javascript'),
    String(client.headers.get('content-type')),
  );

  /**
   * THE CHECK THIS WHOLE SECTION EXISTS FOR.
   *
   * Vite's client is not a file on disk we could have rewritten ahead of time —
   * Vite GENERATES it, and the module specifier it generates is root-absolute
   * (`/@fs/…/env.mjs`). An HTML-only rewrite passes every other assertion here
   * and still leaves the preview broken, because the browser resolves that
   * specifier against the daemon root and gets a 404 with an HTML content-type,
   * which a module script rejects. Nothing but rewriting the served JS catches
   * it.
   */
  check(
    'root-absolute specifier inside generated JS prefixed',
    client.body.includes(`from "${prefix}/`) || client.body.includes(`import "${prefix}/`),
    client.body.slice(0, 200),
  );
  const jsStrays = [...client.body.matchAll(/\bimport\s+"(\/(?!preview\/)[^"]*)"/g)].map((m) => m[1]);
  check('no root-absolute specifier escaped', jsStrays.length === 0, jsStrays.join(' '));

  // And it has to resolve too.
  const fsSpecifier = /(?:import|from)\s+"(\/preview\/[^"]+)"/.exec(client.body)?.[1];
  if (fsSpecifier) {
    const dep = await get(fsSpecifier);
    check(`the prefixed specifier resolves (${fsSpecifier.slice(0, 48)}…)`, dep.status === 200, `got ${dep.status}`);
    check(
      'dependency served as JavaScript',
      (dep.headers.get('content-type') ?? '').includes('javascript'),
    );
  } else {
    check('a prefixed specifier was found to follow', false, 'none matched');
  }

  // ── does the page actually have everything it needs? ─────────────────────
  /**
   * The closest programmatic stand-in for "the pane renders".
   *
   * A browser rendering this document will request every one of these URLs. If
   * any 404s, or comes back as HTML where a module was expected, the page is
   * broken — and broken in the specific way that looks identical to the
   * frame-blocking failure. So crawl them all rather than spot-checking two.
   */
  const refs = [
    ...doc.body.matchAll(/\s(?:src|href)="([^"]+)"/g),
  ]
    .map((m) => m[1]!)
    .filter((u) => u.startsWith('/preview/'));
  check('document references at least two subresources', refs.length >= 2, String(refs.length));

  const broken: string[] = [];
  for (const ref of refs) {
    const res = await get(ref);
    const type = res.headers.get('content-type') ?? '';
    const looksLikeScript = ref.endsWith('.js') || ref.includes('/@vite/');
    if (res.status !== 200 || (looksLikeScript && !type.includes('javascript'))) {
      broken.push(`${ref} → ${res.status} ${type}`);
    }
  }
  check('every subresource the page needs resolves', broken.length === 0, broken.join(' · '));

  // ── deep paths ───────────────────────────────────────────────────────────
  // The prefix maths is index-based (`/preview/:jobId` is two segments), so a
  // deep path is where an off-by-one would show up.
  const deep = await get(`${prefix}/settings/security`, { accept: DOCUMENT_ACCEPT });
  check('a deep in-app path is proxied, not mangled', deep.status === 200, `got ${deep.status}`);
  check(
    'and its assets are still prefixed exactly once',
    deep.body.includes(`src="${prefix}/src/app.js"`) &&
      !deep.body.includes(`${prefix}${prefix}`),
    deep.body.slice(0, 200),
  );

  // ── faithfulness ─────────────────────────────────────────────────────────
  // The proxy must mirror the upstream rather than invent its own behaviour.
  // Vite answers unknown paths with an index.html fallback, so the assertion is
  // "same status as the upstream", not a guessed 404.
  //
  // The direct comparison dials whichever loopback family Vite actually bound —
  // hard-coding 127.0.0.1 here is the same mistake the probe used to make.
  const upstreamOrigin = originFor(server?.host ?? '127.0.0.1', VITE_PORT);
  const directMissing = await fetch(`${upstreamOrigin}/definitely-not-here.png`, {
    headers: { accept: '*/*' },
  });
  await directMissing.text();
  const proxiedMissing = await get(`${prefix}/definitely-not-here.png`);
  check(
    'unknown asset mirrors the upstream status',
    proxiedMissing.status === directMissing.status,
    `proxy ${proxiedMissing.status} vs upstream ${directMissing.status}`,
  );
  check(
    'vite was reached on whichever loopback family it bound',
    server?.host === '127.0.0.1' || server?.host === '::1',
    `host=${server?.host}`,
  );
}

async function registryEventChecks(): Promise<void> {
  console.log('\n8 · learning the port from the agent, via tool_start');
  const registry = serverRegistry();
  registry.forget(JOB, VITE_PORT);
  check('registry cleared for the test', registry.upstreamFor(JOB) === null);

  const before = eventLog().head();

  // Exactly what Track A emits for every Bash call.
  eventLog().emit(
    { projectId: PROJECT, jobId: JOB, agentId: AGENT },
    {
      kind: 'tool_start',
      toolUseId: 'tu_verify_1',
      tool: 'Bash',
      input: { command: `vite fixtures/scratch-repo --port ${VITE_PORT}` },
      label: 'Bash · vite',
    },
  );

  // Detection probes asynchronously so the agent is never blocked on us.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && registry.upstreamFor(JOB) === null) {
    await new Promise((r) => setTimeout(r, 200));
  }

  check('port learned from the agent’s own command', registry.upstreamFor(JOB) !== null);
  const learned = registry.forJob(JOB).find((s) => s.port === VITE_PORT);
  check('attributed to the agent that ran it', learned?.startedByAgentId === AGENT);
  check('kind recorded for the UI', learned?.kind === 'vite');

  const up = eventLog()
    .since(before)
    .find((e) => e.payload.kind === 'dev_server' && e.payload.event === 'up');
  check('dev_server up emitted', up !== undefined);
  check(
    'dev_server is job-scoped (agentId null, per the frozen contract)',
    up?.agentId === null,
  );
  check(
    'up event carries the port and the pid',
    up?.payload.kind === 'dev_server' && up.payload.port === VITE_PORT && typeof up.payload.pid === 'number',
  );

  // Snapshot contribution — a fresh page load must not show "no dev server".
  const snapshot = (await (await fetch(`${base()}/api/snapshot`)).json()) as {
    servers: DevServer[];
  };
  check(
    'snapshot carries the server',
    snapshot.servers.some((s) => s.jobId === JOB && s.port === VITE_PORT),
  );
  check(
    'snapshot proxyPath is what the browser should iframe',
    snapshot.servers.find((s) => s.port === VITE_PORT)?.proxyPath === `/preview/${JOB}`,
  );

  const rest = (await (await fetch(`${base()}/api/jobs/${JOB}/servers`)).json()) as DevServersResponse;
  check('REST servers endpoint agrees', rest.servers.some((s) => s.port === VITE_PORT));

  /**
   * Amendment 6's field. The registry always knew which loopback family
   * answered; these checks are here so it cannot stop reaching the wire without
   * something going red. A UI that has to guess the family gets it wrong for
   * every `::1`-only server.
   */
  const wired = rest.servers.find((s) => s.port === VITE_PORT);
  check(
    'DevServer.host is on the wire',
    wired?.host === '127.0.0.1' || wired?.host === '::1',
    `host=${String(wired?.host)}`,
  );
  check(
    'and it matches the family the probe actually used',
    wired?.host === serverRegistry().forJob(JOB).find((s) => s.port === VITE_PORT)?.host,
  );
  check(
    'snapshot carries host too',
    snapshot.servers.find((s) => s.port === VITE_PORT)?.host === wired?.host,
  );
}

async function consoleChecks(): Promise<void> {
  console.log('\n9 · console capture and the handoff to the agent');
  const before = eventLog().head();

  const post = await fetch(`${base()}/api/jobs/${JOB}/console`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entries: [
        { level: 'error', text: 'GET /api/sessions 500 — token_family_id does not exist', at: new Date().toISOString() },
        { level: 'warn', text: 'prop `rotatedAt` is undefined in <SessionRow>', at: new Date().toISOString() },
        { level: 'log', text: '[vite] hmr update /src/app.js', at: new Date().toISOString() },
      ],
    }),
  });
  check('console POST accepted', post.status === 204, `got ${post.status}`);

  const events = eventLog().since(before).filter((e) => e.payload.kind === 'console');
  check('three console events emitted', events.length === 3, `got ${events.length}`);
  check(
    'levels preserved onto the log',
    events.some((e) => e.payload.kind === 'console' && e.payload.level === 'error') &&
      events.some((e) => e.payload.kind === 'console' && e.payload.level === 'warn'),
  );

  const listed = (await (await fetch(`${base()}/api/jobs/${JOB}/console`)).json()) as {
    entries: Array<{ level: string; text: string }>;
  };
  check('console history readable after a reload', listed.entries.length >= 3);
  check(
    'errors distinguishable for the badge count',
    listed.entries.filter((e) => e.level === 'error').length === 1,
  );

  // Malformed input must not 4xx: a console-capture endpoint that errors is
  // capable of provoking the very errors it collects.
  const junk = await fetch(`${base()}/api/jobs/${JOB}/console`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [{ nope: true }, 'garbage', null] }),
  });
  check('malformed console payload still answers 204', junk.status === 204, `got ${junk.status}`);

  // An endpoint called from inside the observed app must not answer 4xx: the app
  // would log the failure, which would be captured, which would be posted. These
  // checks exist so that property cannot be refactored away quietly.
  for (const [label, body] of [
    ['no entries key', '{}'],
    ['entries not an array', '{"entries":"nope"}'],
    ['empty batch', '{"entries":[]}'],
  ] as const) {
    const res = await fetch(`${base()}/api/jobs/${JOB}/console`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    check(`console POST answers 204 for ${label}`, res.status === 204, `got ${res.status}`);
  }

  const message = composeAgentMessage([
    { level: 'error', text: 'GET /api/sessions 500 — token_family_id does not exist', at: '' },
  ]);
  check('composed message names the error', message.includes('token_family_id'));
  check('composed message asks for a fix', /fix/i.test(message));

  // Track A owns the receiving endpoint. It must degrade, not throw.
  const send = await fetch(`${base()}/api/jobs/${JOB}/console/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT, entries: [] }),
  });
  const sendBody = (await send.json()) as { delivered: boolean; count: number; text: string };
  check('send-to-agent answers rather than throwing', send.status === 200, `got ${send.status}`);
  check(
    'reports undelivered while Track A is pending',
    sendBody.delivered === false,
    'expected graceful degradation, not a 5xx',
  );
  check('still reports what it would have sent', sendBody.count >= 1 && sendBody.text.length > 0);

  const noAgent = await fetch(`${base()}/api/jobs/${JOB}/console/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
  });
  check('send-to-agent requires an agent', noAgent.status === 400);

  const cleared = await fetch(`${base()}/api/jobs/${JOB}/console`, { method: 'DELETE' });
  check('console clearable', cleared.status === 204);
}

/**
 * Actually RUN the shim.
 *
 * Everything else in this file can be checked with an HTTP client. The shim
 * cannot: it only ever executes inside the previewed page, in a browser we have
 * no way to drive here. "It parses" is a weak claim — the shim redefines property
 * descriptors on DOM prototypes and wraps five console methods, and a single
 * throw during install leaves the previewed app with a half-patched global
 * environment, which is worse than no shim at all.
 *
 * So we build the smallest browser-shaped context the shim touches and run it in
 * a `vm`, then assert on observable behaviour: output captured, telemetry posted,
 * URLs prefixed, path reported. Not a browser — but it exercises the install path
 * and every patch it installs.
 */
async function shimExecutionChecks(): Promise<void> {
  console.log('\n11 · the shim, actually executed');

  const prefix = '/preview/J';
  const source = buildShim({
    prefix,
    jobId: 'J',
    consoleEndpoint: '/api/jobs/J/console',
    flushMs: 5,
  });

  const passthrough: Array<[string, unknown[]]> = [];
  const fetched: Array<{ url: string; body?: string }> = [];
  const posted: Array<{ url: string }> = [];
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const pushed: string[] = [];
  const messages: unknown[] = [];

  class FakeElement {
    attrs = new Map<string, string>();
    tagName = 'DIV';
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    }
  }
  class FakeXHR {
    opened: unknown[] = [];
    open(...args: unknown[]): void {
      this.opened = args;
    }
  }

  const sandbox: Record<string, unknown> = {
    console: {
      log: (...a: unknown[]) => passthrough.push(['log', a]),
      warn: (...a: unknown[]) => passthrough.push(['warn', a]),
      error: (...a: unknown[]) => passthrough.push(['error', a]),
      info: (...a: unknown[]) => passthrough.push(['info', a]),
      debug: (...a: unknown[]) => passthrough.push(['debug', a]),
    },
    document: { readyState: 'complete' },
    location: {
      protocol: 'http:',
      host: '127.0.0.1:7801',
      origin: 'http://127.0.0.1:7801',
      pathname: `${prefix}/settings/security`,
      search: '?tab=sessions',
      hash: '',
    },
    history: {
      pushState: (_s: unknown, _t: unknown, url?: string) => {
        if (url !== undefined) pushed.push(url);
      },
      replaceState: (_s: unknown, _t: unknown, url?: string) => {
        if (url !== undefined) pushed.push(url);
      },
    },
    navigator: { sendBeacon: (url: string) => posted.push({ url }) },
    parent: { postMessage: (data: unknown) => messages.push(data) },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: () => undefined,
    Element: FakeElement,
    XMLHttpRequest: FakeXHR,
    fetch: (input: unknown, init?: { body?: string }) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url);
      fetched.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
      return Promise.resolve({ ok: true });
    },
    Request: class {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    },
    setTimeout,
    clearTimeout,
  };
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  sandbox['globalThis'] = sandbox;

  const context = createContext(sandbox);

  let installed = true;
  let installError = '';
  try {
    runInContext(source, context, { timeout: 4_000 });
  } catch (err) {
    installed = false;
    installError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  check('installs without throwing', installed, installError);
  if (!installed) return;

  const win = sandbox as {
    console: {
      log: (...a: unknown[]) => void;
      warn: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };
    fetch: (u: unknown, i?: unknown) => unknown;
    XMLHttpRequest: typeof FakeXHR;
    history: { pushState: (s: unknown, t: unknown, u?: string) => void };
    __conductorPreview?: unknown;
  };

  check('marks itself installed so a second injection is a no-op', win.__conductorPreview !== undefined);

  // ── console capture ──────────────────────────────────────────────────────
  win.console.error('GET /api/sessions 500 — token_family_id does not exist');
  win.console.warn('prop `rotatedAt` is undefined');
  win.console.log('[vite] hmr update');

  check(
    'the app still sees its own console output',
    passthrough.length === 3 && passthrough[0]?.[0] === 'error',
    `${passthrough.length} passed through`,
  );

  // Let the batch timer fire.
  await new Promise((r) => setTimeout(r, 60));

  const telemetry = fetched.find((f) => f.url === '/api/jobs/J/console');
  check('batched output POSTed to the daemon', telemetry !== undefined, JSON.stringify(fetched));
  const payload = telemetry?.body === undefined ? null : (JSON.parse(telemetry.body) as {
    entries: Array<{ level: string; text: string; at: string }>;
  });
  check('payload matches PostConsoleRequest', Array.isArray(payload?.entries));
  check('all three levels captured', payload?.entries.length === 3, String(payload?.entries.length));
  check(
    'error text preserved verbatim',
    payload?.entries.some((e) => e.level === 'error' && e.text.includes('token_family_id')) === true,
  );
  check(
    'entries carry a timestamp',
    payload?.entries.every((e) => !Number.isNaN(Date.parse(e.at))) === true,
  );
  check(
    'telemetry POST is not itself prefixed',
    telemetry?.url.startsWith('/preview/') === false,
    'the shim must use the pre-patch fetch, or it prefixes its own endpoint',
  );

  // ── uncaught errors ──────────────────────────────────────────────────────
  const errorHandlers = listeners.get('error') ?? [];
  check('registers window error handlers', errorHandlers.length >= 2);
  for (const fn of errorHandlers) {
    fn({ message: 'boom', filename: 'x.js', lineno: 3, target: undefined });
  }
  const rejection = (listeners.get('unhandledrejection') ?? [])[0];
  check('registers an unhandledrejection handler', rejection !== undefined);
  rejection?.({ reason: 'nope' });

  await new Promise((r) => setTimeout(r, 60));
  const all = fetched
    .filter((f) => f.url === '/api/jobs/J/console' && f.body)
    .flatMap((f) => (JSON.parse(f.body!) as { entries: Array<{ text: string }> }).entries);
  check('uncaught error captured', all.some((e) => e.text.includes('boom')));
  check('unhandled rejection captured', all.some((e) => e.text.includes('nope')));

  // ── runtime URL prefixing ────────────────────────────────────────────────
  void win.fetch('/api/data');
  check(
    'root-absolute fetch prefixed',
    fetched.some((f) => f.url === `${prefix}/api/data`),
    JSON.stringify(fetched.map((f) => f.url)),
  );

  void win.fetch('http://127.0.0.1:7801/api/same-origin');
  check(
    'absolute same-origin fetch prefixed',
    fetched.some((f) => f.url === `http://127.0.0.1:7801${prefix}/api/same-origin`),
  );

  void win.fetch('https://api.example.com/keep');
  check(
    'cross-origin fetch left alone',
    fetched.some((f) => f.url === 'https://api.example.com/keep'),
  );

  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', '/api/xhr');
  check('XHR url prefixed', xhr.opened[1] === `${prefix}/api/xhr`, String(xhr.opened[1]));

  const el = new FakeElement();
  el.setAttribute('src', '/late.js');
  check('setAttribute src prefixed', el.attrs.get('src') === `${prefix}/late.js`);
  el.setAttribute('srcset', '/a.png 1x, /b.png 2x');
  check(
    'setAttribute srcset prefixed per entry',
    el.attrs.get('srcset') === `${prefix}/a.png 1x, ${prefix}/b.png 2x`,
    el.attrs.get('srcset'),
  );
  el.setAttribute('data-x', '/not-a-url');
  check('unrelated attributes untouched', el.attrs.get('data-x') === '/not-a-url');

  win.history.pushState(null, '', '/settings/tokens');
  check('pushState prefixed so a reload stays in the pane', pushed.includes(`${prefix}/settings/tokens`));

  // ── path reporting ───────────────────────────────────────────────────────
  const report = messages.find(
    (m): m is { source: string; jobId: string; path: string } =>
      typeof m === 'object' && m !== null && (m as { source?: string }).source === 'conductor-preview',
  );
  check('reports its path to the parent frame', report !== undefined);
  check(
    'reported path is the UPSTREAM path, prefix stripped',
    report?.path === '/settings/security?tab=sessions',
    String(report?.path),
  );
  check('report is attributed to the job', report?.jobId === 'J');
}

async function shimChecks(): Promise<void> {
  console.log('\n10 · the injected shim');
  const doc = await get(`/preview/${JOB}/`, { accept: DOCUMENT_ACCEPT });
  const shim = /<script data-conductor-preview="shim"[^>]*>([\s\S]*?)<\/script>/.exec(doc.body)?.[1] ?? '';

  check('shim present and non-trivial', shim.length > 1_000, `${shim.length} bytes`);
  check('knows its prefix', shim.includes(`/preview/${JOB}`));
  check('posts to the console endpoint', shim.includes(`/api/jobs/${JOB}/console`));
  check('wraps console.error', shim.includes('"error"') && shim.includes('console[name]'));
  check('catches uncaught errors', shim.includes('unhandledrejection'));
  check('reports failed subresources', shim.includes('Failed to load'));
  check('patches fetch', shim.includes('window.fetch = function'));
  check('patches XMLHttpRequest', shim.includes('XMLHttpRequest.prototype.open'));
  check('patches setAttribute', shim.includes('Element.prototype.setAttribute'));
  check('patches history for SPA navigation', shim.includes('pushState'));
  check('captures the original fetch before patching', shim.indexOf('rawFetch') < shim.indexOf('window.fetch ='));

  // It has to be syntactically valid JS or the whole page dies on load.
  let parsed = true;
  try {
    new Function(shim);
  } catch (err) {
    parsed = false;
    console.error('    shim parse error:', err instanceof Error ? err.message : err);
  }
  check('shim parses as JavaScript', parsed);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = `/tmp/conductor-preview-verify-${Date.now()}.db`;
  process.env['CONDUCTOR_PORT'] = String(DAEMON_PORT);
  process.env['LOG_LEVEL'] = 'silent';

  let vite: ChildProcess | null = null;
  let hostile: Server | null = null;
  let ipv6: Server | null = null;
  let app: Awaited<ReturnType<typeof build>> | null = null;

  try {
    pureRewriteChecks();

    console.log('\n   starting fixtures…');
    hostile = await startHostileServer();
    ipv6 = await startIpv6Server();
    vite = await startVite();

    app = await build();
    await app.listen({ host: '127.0.0.1', port: DAEMON_PORT });

    // Register once so the SSRF section has a live server to contrast against.
    await serverRegistry().register({ jobId: JOB, projectId: PROJECT, port: VITE_PORT, kind: 'vite' });

    await securityChecks();
    await frameHeaderChecks();
    await ipv6Checks();
    await viteChecks();
    await registryEventChecks();
    await consoleChecks();
    await shimChecks();
    await shimExecutionChecks();
  } finally {
    await app?.close();
    hostile?.close();
    ipv6?.close();
    vite?.kill('SIGTERM');
  }

  console.log(
    failures === 0
      ? `\nTrack D verify: PASS — ${checks} checks. A real Vite app renders through the proxy.\n`
      : `\nTrack D verify: FAIL — ${failures} of ${checks} checks failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  process.exit(1);
});
