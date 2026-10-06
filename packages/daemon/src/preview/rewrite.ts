/**
 * Response rewriting — making a proxied app's own asset paths resolve.
 *
 * TRACK D OWNS THIS FILE.
 *
 * THE PROBLEM THIS FILE EXISTS FOR
 * ────────────────────────────────
 * Stripping `X-Frame-Options` gets the iframe to render. It does not get the app
 * to *work*. A dev server serves HTML full of ROOT-ABSOLUTE references:
 *
 *     <script type="module" src="/src/app.js">
 *     import "/@vite/client"
 *     import { jsx } from "/node_modules/.vite/deps/react_jsx-runtime.js"
 *
 * Through a proxy mounted at `/preview/<jobId>/` those resolve against the
 * daemon's root — `/src/app.js`, not `/preview/<jobId>/src/app.js` — so every
 * one of them 404s and the pane shows a blank page with a console full of MIME
 * errors. That failure looks exactly like the header problem, which is why it is
 * easy to think the proxy is broken when it is the paths.
 *
 * WHY NOT `<base href>`
 * ─────────────────────
 * The obvious fix is wrong. `<base>` only affects RELATIVE URLs, and relative
 * URLs already work here: the proxy preserves the upstream path structure under
 * the prefix, so a relative `./foo.js` on `/preview/j/settings/` resolves to
 * `/preview/j/settings/foo.js` → upstream `/settings/foo.js`, which is exactly
 * what the app meant. Injecting `<base href="/preview/j/">` would *break* that,
 * flattening it to `/settings`-less `/foo.js`. Root-absolute URLs — the ones
 * that are actually broken — ignore `<base>` entirely. So: no `<base>`, and
 * rewrite the root-absolute URLs instead.
 *
 * THE THREE LAYERS
 * ────────────────
 *  1. STATIC HTML — attribute URLs, `srcset` lists, inline `<style>`, inline
 *     `<script>`, meta-refresh targets.
 *  2. STATIC JS/CSS — ES module specifiers (`from "/x"`, `import("/x")`),
 *     `new URL("/x", import.meta.url)`, and CSS `url(/x)` / `@import "/x"`.
 *     This is the layer that makes a real Vite dev server work: Vite rewrites
 *     bare imports to root-absolute `/node_modules/.vite/deps/…` paths in the
 *     module text it serves, so nothing but text rewriting can catch them.
 *  3. RUNTIME SHIM — everything computed at runtime and therefore invisible to
 *     a text pass: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
 *     `sendBeacon`, `Worker`, `history.pushState`, and `src`/`href` assigned to
 *     elements created by script. See `buildShim`.
 *
 * Layers 1 and 2 are regex passes over text. That is not a parser and it is not
 * pretending to be: the rewrite is scoped to the syntactic positions where a URL
 * can legally appear, and a miss degrades to one 404 rather than a corrupted
 * file. A real JS parser here would cost more than it buys for a preview pane.
 */

/** Scheme-ish or otherwise absolute references we must leave alone. */
const LEAVE_ALONE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:)/i;

/**
 * Prefix one root-absolute URL. Returns the input unchanged for anything that
 * isn't root-absolute, or that is already prefixed (responses can be rewritten
 * twice when a dev server proxies to itself).
 */
export function prefixUrl(url: string, prefix: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return url;
  if (!trimmed.startsWith('/')) return url;
  if (LEAVE_ALONE.test(trimmed)) return url; // catches `//host` and `data:`
  if (trimmed === prefix || trimmed.startsWith(`${prefix}/`)) return url;
  return prefix + trimmed;
}

/** `srcset` / `imagesrcset` are comma-separated `url descriptor` pairs. */
function prefixSrcset(value: string, prefix: string): string {
  return value
    .split(',')
    .map((part) => {
      const match = /^(\s*)(\S+)(\s.*)?$/.exec(part);
      if (!match) return part;
      const [, lead = '', url = '', tail = ''] = match;
      return `${lead}${prefixUrl(url, prefix)}${tail}`;
    })
    .join(',');
}

/** Attributes whose value is a single URL. */
const URL_ATTRS = [
  'src',
  'href',
  'action',
  'formaction',
  'poster',
  'data-src',
  'data-href',
  'ping',
  'background',
];

const SRCSET_ATTRS = ['srcset', 'imagesrcset'];

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────

export function rewriteCss(css: string, prefix: string): string {
  return (
    css
      // url(/x) · url('/x') · url("/x")
      .replace(/url\(\s*(['"]?)(\/[^'")\s]*)\1\s*\)/g, (whole, quote: string, url: string) => {
        const next = prefixUrl(url, prefix);
        return next === url ? whole : `url(${quote}${next}${quote})`;
      })
      // @import "/x" · @import url("/x") is already handled above
      .replace(/@import\s+(['"])(\/[^'"]*)\1/g, (whole, quote: string, url: string) => {
        const next = prefixUrl(url, prefix);
        return next === url ? whole : `@import ${quote}${next}${quote}`;
      })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JavaScript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite the root-absolute URLs that appear in ES module syntax.
 *
 * Only these positions are touched:
 *   import … from "/x"      export … from "/x"      import "/x"
 *   import("/x")            new URL("/x", …)
 *
 * `new URL` is in the list because `new URL('/x', import.meta.url)` discards the
 * base's path and yields origin + `/x` — so Vite's asset helpers would escape the
 * prefix without it. A bare string `'/x'` anywhere else is left alone: it is far
 * more likely to be an API route the runtime shim will handle than an asset.
 */
export function rewriteJs(js: string, prefix: string): string {
  return (
    js
      // import … from '/x' | export … from '/x' | import '/x' | import('/x')
      .replace(
        /\b(from|import)\s*(\(\s*)?(['"])(\/(?!\/)[^'"\n]*)\3/g,
        (whole, kw: string, paren: string | undefined, quote: string, url: string) => {
          const next = prefixUrl(url, prefix);
          if (next === url) return whole;
          return `${kw}${paren ?? ' '}${quote}${next}${quote}`;
        },
      )
      // new URL('/x', …)
      .replace(
        /\bnew\s+URL\(\s*(['"])(\/(?!\/)[^'"\n]*)\1/g,
        (whole, quote: string, url: string) => {
          const next = prefixUrl(url, prefix);
          return next === url ? whole : `new URL(${quote}${next}${quote}`;
        },
      )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const INLINE_STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

/** A `<script>` with a `src` has no body to rewrite; one with `type=json` isn't code. */
function isExecutableScript(attrs: string): boolean {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const type = /\btype\s*=\s*(['"]?)([^'"\s>]*)\1/i.exec(attrs)?.[2]?.toLowerCase();
  if (!type) return true; // classic script
  return type === 'module' || type === 'text/javascript' || type === 'application/javascript';
}

export interface RewriteHtmlOptions {
  prefix: string;
  /** Inline script injected as the first thing in <head>. */
  shim?: string;
}

/**
 * Rewrite one HTML document for serving under the prefix.
 *
 * DO NOT "SIMPLIFY" THIS INTO `<base href="/preview/<jobId>/">`.
 * ─────────────────────────────────────────────────────────────
 * That is the obvious fix, it is one line, and it is wrong. `<base>` affects
 * only RELATIVE URLs — and relative URLs already work here, because the proxy
 * preserves the upstream path structure under the prefix. On
 * `/preview/j/settings/` a relative `./foo.js` already resolves to
 * `/preview/j/settings/foo.js` → upstream `/settings/foo.js`, which is exactly
 * what the app meant. Injecting a base would FLATTEN that to `/preview/j/foo.js`
 * → upstream `/foo.js`, breaking every deep relative path.
 *
 * Meanwhile the URLs that are genuinely broken — root-absolute ones like
 * `/src/app.js` and `/@vite/client` — ignore `<base>` entirely.
 *
 * So: no `<base>`. Rewrite the root-absolute URLs instead, which is what the
 * rest of this function does. (This reasoning is also at the top of the file; it
 * is repeated here because this is where someone would change it.)
 */
export function rewriteHtml(html: string, opts: RewriteHtmlOptions): string {
  const { prefix } = opts;

  // Inline <script> and <style> bodies are extracted first and put back at the
  // end, so the attribute pass cannot corrupt code that happens to contain
  // something attribute-shaped (`href=` inside a JS string, say).
  const stash: string[] = [];
  const park = (text: string): string => {
    stash.push(text);
    return `\u0000CDR${stash.length - 1}\u0000`;
  };

  let out = html
    .replace(INLINE_SCRIPT, (whole, attrs: string, body: string) => {
      if (!isExecutableScript(attrs)) return whole;
      return park(`<script${attrs}>${rewriteJs(body, prefix)}</script>`);
    })
    .replace(INLINE_STYLE, (_whole, attrs: string, body: string) =>
      park(`<style${attrs}>${rewriteCss(body, prefix)}</style>`),
    );

  // Single-URL attributes.
  for (const attr of URL_ATTRS) {
    const re = new RegExp(`(\\b${attr}\\s*=\\s*)(["'])(\\/[^"']*)\\2`, 'gi');
    out = out.replace(re, (whole, lead: string, quote: string, url: string) => {
      const next = prefixUrl(url, prefix);
      return next === url ? whole : `${lead}${quote}${next}${quote}`;
    });
  }

  // Comma-separated candidate lists.
  for (const attr of SRCSET_ATTRS) {
    const re = new RegExp(`(\\b${attr}\\s*=\\s*)(["'])([^"']*)\\2`, 'gi');
    out = out.replace(
      re,
      (_whole, lead: string, quote: string, value: string) =>
        `${lead}${quote}${prefixSrcset(value, prefix)}${quote}`,
    );
  }

  // Inline style="…url(/x)…".
  out = out.replace(
    /(\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (whole, lead: string, quote: string, value: string) => {
      if (!value.includes('url(')) return whole;
      return `${lead}${quote}${rewriteCss(value, prefix)}${quote}`;
    },
  );

  // <meta http-equiv="refresh" content="0; url=/x">
  out = out.replace(
    /(<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*\bcontent\s*=\s*["'])([^"']*)(["'])/gi,
    (whole, lead: string, content: string, close: string) => {
      const next = content.replace(/(url\s*=\s*)(\/[^;"'\s]*)/i, (_m, k: string, u: string) =>
        `${k}${prefixUrl(u, prefix)}`,
      );
      return next === content ? whole : `${lead}${next}${close}`;
    },
  );

  // Put the parked code back.
  out = out.replace(/\u0000CDR(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? '');

  if (opts.shim) out = injectShim(out, opts.shim);
  return out;
}

/**
 * Insert the shim so it runs before any of the app's own code. Order is the
 * whole point: a console wrapper installed after the app's first error has
 * already missed it, and a `fetch` patch installed late misses the first call.
 */
function injectShim(html: string, shim: string): string {
  const tag = `<script data-conductor-preview="shim">${shim}</script>`;

  // Best position: immediately inside <head>.
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  // No <head> — before <body>, or failing that, prepended. A fragment served
  // without either still gets the shim, just without a guaranteed parse order.
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) {
    const at = body.index + body[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const html5 = /<html\b[^>]*>/i.exec(html);
  if (html5) {
    const at = html5.index + html5[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-type routing
// ─────────────────────────────────────────────────────────────────────────────

export type Rewritable = 'html' | 'js' | 'css' | null;

/**
 * Which rewrite pass, if any, a response needs. Anything not listed streams
 * through untouched — images and fonts must never be buffered into a string.
 */
export function rewritableKind(contentType: string | undefined): Rewritable {
  if (!contentType) return null;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (
    type === 'text/javascript' ||
    type === 'application/javascript' ||
    type === 'application/x-javascript' ||
    type === 'text/jsx' ||
    type === 'application/ecmascript' ||
    type === 'text/ecmascript'
  ) {
    return 'js';
  }
  if (type === 'text/css') return 'css';
  return null;
}

export function rewriteBody(kind: Exclude<Rewritable, null>, body: string, opts: RewriteHtmlOptions): string {
  switch (kind) {
    case 'html':
      return rewriteHtml(body, opts);
    case 'js':
      return rewriteJs(body, opts.prefix);
    case 'css':
      return rewriteCss(body, opts.prefix);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The runtime shim
// ─────────────────────────────────────────────────────────────────────────────

export interface ShimConfig {
  /** `/preview/<jobId>` — no trailing slash. */
  prefix: string;
  jobId: string;
  /** Where captured console output is POSTed. */
  consoleEndpoint: string;
  /** Flush interval for batched console entries, ms. */
  flushMs?: number;
  /** Max entries held between flushes; excess is dropped with a notice. */
  maxBatch?: number;
}

/**
 * The script injected into every proxied HTML document.
 *
 * Written as a plain string rather than a bundled asset on purpose: it has to be
 * inline to guarantee it executes before the app's first script, and inlining a
 * built file would mean a build step in a daemon that deliberately has none.
 *
 * It does two jobs that have nothing to do with each other beyond both needing
 * to run first:
 *   • forwards `console` output and uncaught errors back to the daemon, so the
 *     Preview screen's console pane and "send errors to agent" have a source;
 *   • prefixes the root-absolute URLs that only exist at runtime.
 */
export function buildShim(config: ShimConfig): string {
  const cfg = JSON.stringify({
    prefix: config.prefix,
    jobId: config.jobId,
    endpoint: config.consoleEndpoint,
    flushMs: config.flushMs ?? 400,
    maxBatch: config.maxBatch ?? 100,
  });

  return `(function(){
"use strict";
var CFG = ${cfg};
if (window.__conductorPreview) return;
window.__conductorPreview = CFG;

var PREFIX = CFG.prefix;

// Captured before anything is patched, so our own telemetry never re-enters the
// patched fetch and never gets prefixed.
var rawFetch = window.fetch ? window.fetch.bind(window) : null;
var raw = {
  log: console.log, warn: console.warn, error: console.error,
  info: console.info, debug: console.debug
};

// ── URL prefixing ─────────────────────────────────────────────────────────
function needsPrefix(u) {
  if (typeof u !== "string") return false;
  if (u.length === 0 || u.charAt(0) !== "/") return false;
  if (u.charAt(1) === "/") return false;               // //host
  if (u === PREFIX || u.indexOf(PREFIX + "/") === 0) return false;
  return true;
}
function fix(u) { return needsPrefix(u) ? PREFIX + u : u; }

// Absolute same-origin URLs are just as broken as root-relative ones: an app
// that builds location.origin + "/api/x" lands outside the prefix.
function fixAny(u) {
  if (typeof u !== "string") return u;
  if (needsPrefix(u)) return PREFIX + u;
  var origin = location.origin;
  if (u.indexOf(origin + "/") === 0) {
    var rest = u.slice(origin.length);
    if (needsPrefix(rest)) return origin + PREFIX + rest;
  }
  return u;
}

// ── console capture ───────────────────────────────────────────────────────
var queue = [];
var dropped = 0;
var timer = null;
var sending = false;

function render(value, depth) {
  if (depth > 2) return "…";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  var t = typeof value;
  if (t === "string") return value;
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "function") return "[Function " + (value.name || "anonymous") + "]";
  if (t === "symbol") return value.toString();
  if (value instanceof Error) {
    return (value.name || "Error") + ": " + value.message + (value.stack ? "\\n" + value.stack : "");
  }
  if (value instanceof Element) {
    return "<" + value.tagName.toLowerCase() + (value.id ? "#" + value.id : "") + ">";
  }
  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length && i < 12; i++) parts.push(render(value[i], depth + 1));
    if (value.length > 12) parts.push("…" + (value.length - 12) + " more");
    return "[" + parts.join(", ") + "]";
  }
  try {
    var seen = [];
    return JSON.stringify(value, function (k, v) {
      if (typeof v === "object" && v !== null) {
        if (seen.indexOf(v) !== -1) return "[Circular]";
        seen.push(v);
      }
      return v;
    }) || String(value);
  } catch (e) { return String(value); }
}

function push(level, args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) parts.push(render(args[i], 0));
  var text = parts.join(" ");
  if (text.length > 4000) text = text.slice(0, 4000) + "… (truncated)";
  if (queue.length >= CFG.maxBatch) { dropped++; return; }
  queue.push({ level: level, text: text, at: new Date().toISOString() });
  schedule();
}

function schedule() {
  if (timer !== null || sending) return;
  timer = setTimeout(flush, CFG.flushMs);
}

function flush() {
  timer = null;
  if (queue.length === 0 || !rawFetch) return;
  var entries = queue;
  queue = [];
  if (dropped > 0) {
    entries.push({
      level: "warn",
      text: "[conductor] " + dropped + " console entries dropped (rate limit)",
      at: new Date().toISOString()
    });
    dropped = 0;
  }
  sending = true;
  rawFetch(CFG.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: entries }),
    keepalive: true
  }).catch(function () {
    // The daemon being briefly unreachable must never break the previewed app.
  }).then(function () {
    sending = false;
    if (queue.length > 0) schedule();
  });
}

["log", "warn", "error", "info", "debug"].forEach(function (name) {
  console[name] = function () {
    // 'log' | 'warn' | 'error' are the only levels the wire contract carries.
    var level = name === "warn" ? "warn" : (name === "error" ? "error" : "log");
    try { push(level, arguments); } catch (e) { /* never break the app */ }
    return raw[name] ? raw[name].apply(console, arguments) : undefined;
  };
});

window.addEventListener("error", function (e) {
  if (e.error) push("error", [e.error]);
  else push("error", [String(e.message) + " (" + (e.filename || "?") + ":" + (e.lineno || 0) + ")"]);
}, true);

window.addEventListener("unhandledrejection", function (e) {
  push("error", ["Unhandled rejection: " + render(e.reason, 0)]);
});

// A failed subresource fires an error event on the element, not on window with
// an Error — these are precisely the 404s a path-rewriting bug would produce,
// so they are worth surfacing loudly.
window.addEventListener("error", function (e) {
  var t = e.target;
  if (!t || t === window) return;
  var url = t.src || t.href;
  if (url) push("error", ["Failed to load " + t.tagName.toLowerCase() + ": " + url]);
}, true);

addEventListener("pagehide", flush);
addEventListener("beforeunload", flush);

// ── runtime URL patches ───────────────────────────────────────────────────
if (rawFetch) {
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") return rawFetch(fixAny(input), init);
      if (input && typeof input.url === "string") {
        var fixed = fixAny(input.url);
        if (fixed !== input.url) return rawFetch(new Request(fixed, input), init);
      }
    } catch (e) { /* fall through with the original input */ }
    return rawFetch(input, init);
  };
}

var rawOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  var args = Array.prototype.slice.call(arguments);
  try { args[1] = fixAny(url); } catch (e) { /* keep original */ }
  return rawOpen.apply(this, args);
};

if (window.navigator && navigator.sendBeacon) {
  var rawBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) { return rawBeacon(fixAny(url), data); };
}

if (window.EventSource) {
  var RawES = window.EventSource;
  window.EventSource = function (url, cfg) { return new RawES(fixAny(url), cfg); };
  window.EventSource.prototype = RawES.prototype;
}

if (window.Worker) {
  var RawWorker = window.Worker;
  window.Worker = function (url, cfg) { return new RawWorker(fixAny(url), cfg); };
  window.Worker.prototype = RawWorker.prototype;
}

// WebSocket: only root-relative paths are rewritten. An absolute ws:// URL is
// left alone — Vite's HMR client dials the dev server's own port directly, and
// a WebSocket is not subject to X-Frame-Options, so that connection is fine.
if (window.WebSocket) {
  var RawWS = window.WebSocket;
  var PatchedWS = function (url, protocols) {
    var next = url;
    try {
      if (typeof url === "string" && needsPrefix(url)) {
        next = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + PREFIX + url;
      }
    } catch (e) { /* keep original */ }
    return protocols === undefined ? new RawWS(next) : new RawWS(next, protocols);
  };
  PatchedWS.prototype = RawWS.prototype;
  PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1; PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
  window.WebSocket = PatchedWS;
}

// Elements created and wired up by script bypass the HTML rewrite entirely.
// Vite injects <link rel=stylesheet> and <script> this way on every HMR update.
var rawSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  try {
    var n = String(name).toLowerCase();
    if (n === "srcset" || n === "imagesrcset") {
      value = String(value).split(",").map(function (p) {
        var m = /^(\\s*)(\\S+)(\\s[\\s\\S]*)?$/.exec(p);
        return m ? (m[1] || "") + fix(m[2] || "") + (m[3] || "") : p;
      }).join(",");
    } else if (n === "src" || n === "href" || n === "action" || n === "poster" || n === "formaction") {
      value = fixAny(value);
    }
  } catch (e) { /* keep original */ }
  return rawSetAttribute.call(this, name, value);
};

[
  [window.HTMLScriptElement, "src"], [window.HTMLLinkElement, "href"],
  [window.HTMLImageElement, "src"], [window.HTMLIFrameElement, "src"],
  [window.HTMLSourceElement, "src"], [window.HTMLMediaElement, "src"],
  [window.HTMLEmbedElement, "src"], [window.HTMLObjectElement, "data"],
  [window.HTMLFormElement, "action"], [window.HTMLTrackElement, "src"]
].forEach(function (pair) {
  var ctor = pair[0], prop = pair[1];
  if (!ctor || !ctor.prototype) return;
  var desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
  if (!desc || !desc.set || !desc.configurable) return;
  Object.defineProperty(ctor.prototype, prop, {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set: function (value) { desc.set.call(this, fixAny(value)); }
  });
});

// SPA navigation. Keeping the prefix on the URL is what makes a reload inside
// the pane land back on the proxy instead of 404ing on the daemon root.
["pushState", "replaceState"].forEach(function (name) {
  var rawMethod = history[name];
  if (typeof rawMethod !== "function") return;
  history[name] = function (state, title, url) {
    if (arguments.length < 3 || url === undefined || url === null) {
      return rawMethod.call(history, state, title);
    }
    return rawMethod.call(history, state, title, fixAny(String(url)));
  };
});

// Tell the Preview screen which upstream path is showing, so its URL bar tracks
// in-app navigation instead of freezing on the path we first loaded.
function reportPath() {
  try {
    var p = location.pathname;
    var upstream = p.indexOf(PREFIX) === 0 ? (p.slice(PREFIX.length) || "/") : p;
    parent.postMessage({
      source: "conductor-preview",
      jobId: CFG.jobId,
      path: upstream + location.search + location.hash
    }, "*");
  } catch (e) { /* cross-origin parent, or no parent */ }
}
addEventListener("popstate", reportPath);
addEventListener("hashchange", reportPath);
if (document.readyState === "loading") {
  addEventListener("DOMContentLoaded", reportPath);
} else {
  reportPath();
}
})();`;
}
