/**
 * Which requests the daemon will answer at all.
 *
 * Binding 127.0.0.1 stops other machines. It does not stop other *web pages*:
 *
 *  • DNS rebinding. A page on attacker.example re-points its own hostname at
 *    127.0.0.1, and the browser then treats the daemon as same-origin with the
 *    attacker — it can read /api/snapshot and POST /api/jobs. The only thing that
 *    gives it away is the Host header, which still says attacker.example.
 *  • Cross-site requests. Any page can send a "simple" POST or open a WebSocket to
 *    localhost; CORS stops it reading the answer, not the daemon acting on it. The
 *    browser always attaches Origin to those, and never lets a page forge it.
 *
 * So: the Host must name this machine, and an Origin, when there is one, must be a
 * local page. No Origin is allowed — that is curl, `scripts/status.mjs` and the Vite
 * proxy's own upstream calls, none of which a web page can make.
 *
 * Ports are deliberately not checked. Rebinding changes the hostname, never the
 * port, so a port rule would add configuration without closing anything.
 *
 * Exported as the rule, not only as a hook (Amendment 9), so the smoke suite tests
 * this function and the hook cannot drift from it.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The hostname part of a Host header — `localhost:7777`, `[::1]:5173`, `127.0.0.1`. */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

export type Refusal = 'host' | 'origin';

/** `null` when the request may proceed; otherwise which header gave it away. */
export function refuseNonLocal(host: string | undefined, origin: string | undefined): Refusal | null {
  // HTTP/1.1 requires Host; a request without one did not come from a browser page
  // that could be rebinding, but it also did not come from anything we ship.
  if (!host || !LOCAL_HOSTNAMES.has(hostnameOf(host))) return 'host';

  if (origin === undefined) return null;
  // `null` is what a sandboxed iframe or a file:// page sends. Neither is ours.
  if (origin === 'null') return 'origin';
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return 'origin';
    return LOCAL_HOSTNAMES.has(hostname.toLowerCase()) ? null : 'origin';
  } catch {
    return 'origin';
  }
}
