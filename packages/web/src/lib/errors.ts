/**
 * What went wrong, in a form a screen can show.
 *
 * `api()` used to throw a plain `Error("METHOD /path → STATUS {json}")`, and every
 * screen parsed that string back apart — three different regexes in three places, and
 * the screens without one showed the raw string. That is how "isn't wired up yet" and
 * a bare `DELETE /api/projects/… → 404 {"error":"no such project …"}` reached people.
 *
 * `ApiError` keeps the status and the daemon's own sentence as fields, so nothing has
 * to be parsed. Its `message` keeps the old format, so a log line still says which
 * request failed.
 */

export class ApiError extends Error {
  /** The daemon's `detail` or `error` string, when it sent one. */
  readonly daemonSays: string | null;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    this.name = 'ApiError';
    this.daemonSays = sentenceIn(body);
  }
}

/**
 * Fastify's own replies — a missing route, a body that failed its schema — look like
 * `{statusCode, error: 'Not Found', message: 'Route DELETE:/x not found'}`, where
 * `error` is only the reason phrase. Ours look like `{error: 'no such project …'}`,
 * sometimes with a `detail`. Reading `error` off Fastify's shape is how a missing
 * route used to be reported as "failed — Not Found".
 */
function isFastifyReply(body: object): body is { statusCode: number; message: string } {
  const b = body as { statusCode?: unknown; message?: unknown };
  return typeof b.statusCode === 'number' && typeof b.message === 'string';
}

/** Fastify's route-not-found, the one 404 that means the endpoint itself is missing. */
export function isMissingRoute(err: ApiError): boolean {
  const b = err.body;
  return (
    err.status === 404 &&
    typeof b === 'object' &&
    b !== null &&
    isFastifyReply(b) &&
    b.message.startsWith('Route ')
  );
}

function sentenceIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  if (isFastifyReply(body)) return body.message.length > 0 ? body.message : null;
  const { detail, error } = body as { detail?: unknown; error?: unknown };
  const text = typeof detail === 'string' ? detail : error;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

export interface Notice {
  tone: 'ok' | 'warn' | 'fail';
  text: string;
}

/**
 * A short sentence for places that have one line to show, and no label of their own
 * to put in front of it. Prefers the daemon's words over ours.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.daemonSays ?? `the daemon answered ${err.status}`;
  if (err instanceof TypeError) return `can't reach the daemon — is it running?`;
  return err instanceof Error ? err.message : String(err);
}

/** Turn a thrown error into something a person can act on. */
export function explain(label: string, err: unknown): Notice {
  if (!(err instanceof ApiError)) {
    // fetch() rejects with a TypeError when nothing answered at all.
    if (err instanceof TypeError) {
      return { tone: 'fail', text: `Can't reach the daemon — is it running?` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { tone: 'fail', text: `${label} failed: ${msg}` };
  }

  const said = err.daemonSays;

  // 409 is the one status where the daemon knows something we don't: the request
  // was fine and some state is in the way. Which state is the whole content of
  // the message ("builder is still running"), so it is passed through rather
  // than translated into a sentence this function would have to guess at.
  if (err.status === 409) return { tone: 'warn', text: said ?? `${label} was refused.` };

  /*
   * 404 means two different things. Before the routes existed, every command 404'd
   * because the route was missing, and "isn't wired up yet" was true. Now a 404
   * usually means the THING is gone — a job already removed, an agent cleared in
   * another tab — and the daemon says which. Fastify's own route-not-found reply is
   * the only case where the old sentence is still true.
   */
  if (err.status === 404) {
    if (said && !isMissingRoute(err)) return { tone: 'warn', text: `${label} failed — ${said}.` };
    return {
      tone: 'warn',
      text: `${label} isn't wired up yet — the daemon has no route for it (404).`,
    };
  }

  // 403 has two sources now: the token check, and the local-pages guard, which names
  // the header it refused. Its sentence beats a guess about the token.
  if (err.status === 403 && said) return { tone: 'fail', text: `${label} was refused — ${said}.` };
  if (err.status === 401 || err.status === 403) {
    return { tone: 'fail', text: `${label} was refused — check CONDUCTOR_TOKEN.` };
  }
  if (err.status >= 500) {
    return {
      tone: 'fail',
      text: said ? `${label} failed inside the daemon — ${said}.` : `${label} failed inside the daemon. See its log.`,
    };
  }
  return { tone: 'fail', text: said ? `${label} failed — ${said}.` : `${label} failed (${err.status}).` };
}
