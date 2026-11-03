/**
 * The capabilities an HTML page is served under (Amendment 198).
 *
 * TRACK C owns this file.
 *
 * A page's scripts run, and a classic `<script src>`, `<img>` or `<iframe>` it writes is a GET
 * with no Origin, which the guard lets through. So a page served from a URL that named its job
 * could name any other job's, or any project folder's, and run that file as its own script. The
 * page is served under a token instead: only the app can mint one (`POST /api/pages`, which a
 * page can't make — its fetch is `connect-src 'none'`, and its `Origin: null` is the guard's),
 * and a token reaches the one root it was minted for. The page can still load what is beside
 * it, in its own root, because that is what a report's relative `style.css` is, and the policy
 * it is served with (`pageCsp`) lets it load nothing else from this origin.
 *
 * In memory only: a restart forgets every token, and the pane mints a new one.
 */

import { randomBytes } from 'node:crypto';

/** What a token is bound to: a job's worktree, or one of a project's folders. */
export type PageRoot = { kind: 'job'; jobId: string } | { kind: 'dir'; projectId: string; dir: string };

/** At most this many live tokens; minting one more drops the least recently used. */
export const MAX_PAGE_TOKENS = 256;

/** A token nobody has used for this long is gone. */
export const PAGE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** 32 random bytes, base64url: 43 characters of `A-Z a-z 0-9 - _`. */
const TOKEN_BYTES = 32;

export class PageTokens {
  /** Insertion order is use order: the first entry is the least recently used. */
  #tokens = new Map<string, { root: PageRoot; usedAt: number }>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.#max = opts.max ?? MAX_PAGE_TOKENS;
    this.#ttlMs = opts.ttlMs ?? PAGE_TOKEN_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  mint(root: PageRoot): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.#tokens.set(token, { root, usedAt: this.#now() });
    while (this.#tokens.size > this.#max) {
      this.#tokens.delete(this.#tokens.keys().next().value!);
    }
    return token;
  }

  /** The root a live token was minted for, and the token's clock restarts; else null. */
  lookup(token: string): PageRoot | null {
    const held = this.#tokens.get(token);
    if (!held) return null;
    const now = this.#now();
    this.#tokens.delete(token);
    if (now - held.usedAt > this.#ttlMs) return null;
    this.#tokens.set(token, { root: held.root, usedAt: now });
    return held.root;
  }

  get size(): number {
    return this.#tokens.size;
  }
}
