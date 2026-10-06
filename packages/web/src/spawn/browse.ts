/**
 * Path completion for the "where" field.  TRACK A.
 *
 * THE ROUTE IS TRACK C'S — `routes/fs.ts`, backed by `workspace/browse.ts`, which
 * is where the limits that make it safe are documented and tested. This file is
 * only the browser's half: debounce, discard stale answers, and compute what Tab
 * should fill in.
 *
 * Why this exists at all: a browser cannot be given a real filesystem path. The
 * native directory picker hands back file names and a bare folder name, never an
 * absolute path, so "browse to my repo" is impossible in the page and ordinary in
 * the daemon. Asking the daemon is the only honest way to do it.
 *
 * If the daemon has no such route — an older build — every request 404s, the hook
 * returns null and the field stays exactly what it was before: a place to type a
 * path. A completion that cannot complete must not be a completion that cannot be
 * typed into, so failures here are deliberately silent.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/feed.js';

/** Long enough that holding a key down is one request, short enough to feel live. */
const DEBOUNCE_MS = 90;

export interface DirEntry {
  name: string;
  path: string;
  /** A git repository — the thing you are almost always looking for. */
  repo: boolean;
}

export interface CompleteResult {
  dir: string;
  prefix: string;
  entries: DirEntry[];
  /** Matches beyond the cap. The UI must say so rather than imply completeness. */
  truncated: number;
  /** Set when what you have typed is itself a directory. */
  target: DirEntry | null;
}

export function completePath(path: string): Promise<CompleteResult> {
  return api<CompleteResult>(`/api/fs/complete?path=${encodeURIComponent(path)}`);
}

/**
 * Completions for what is currently typed.
 *
 * `api()` takes no AbortSignal and lives in W0's read-only `lib/`, so in-flight
 * requests can't be cancelled. A sequence number does the job that matters:
 * answers to superseded requests are dropped rather than rendered, so a fast
 * typist never sees the list flash back to a previous prefix.
 */
export function usePathComplete(input: string, enabled: boolean): CompleteResult | null {
  const [result, setResult] = useState<CompleteResult | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const mine = seq.current + 1;
    seq.current = mine;

    const timer = setTimeout(() => {
      void completePath(input).then(
        (r) => {
          if (seq.current === mine) setResult(r);
        },
        () => {
          if (seq.current === mine) setResult(null);
        },
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [input, enabled]);

  return result;
}

/**
 * Whether a directory is a git repository.
 *
 * `null` means "not known" — still loading, or the daemon could not say. Callers
 * must treat that as permission rather than refusal: greying out options because an
 * answer has not arrived yet is worse than letting the daemon give its own, accurate
 * error.
 *
 * Reuses the completion endpoint instead of adding a second one. `target` is the
 * resolved directory and `target.repo` is precisely this question, so a dedicated
 * route would be a second door onto the same `existsSync(join(dir, '.git'))`.
 */
export function useIsRepo(path: string | null): boolean | null {
  const [repo, setRepo] = useState<boolean | null>(null);

  useEffect(() => {
    if (path === null) {
      setRepo(null);
      return;
    }
    setRepo(null);
    let live = true;
    void completePath(path).then(
      (r) => {
        if (live) setRepo(r.target?.repo ?? null);
      },
      () => {
        if (live) setRepo(null);
      },
    );
    return () => {
      live = false;
    };
  }, [path]);

  return repo;
}

/**
 * What Tab should fill in when no row is highlighted: the longest prefix every
 * match shares, the way a shell does it. Case-insensitive comparison, but the
 * first entry's own casing is what gets inserted — so `desk⇥` yields `Desktop`
 * rather than correcting you to a directory that does not exist.
 */
export function commonPrefix(entries: DirEntry[]): string {
  if (entries.length === 0) return '';
  let out = entries[0]!.name;
  for (const e of entries.slice(1)) {
    let i = 0;
    while (i < out.length && i < e.name.length && out[i]!.toLowerCase() === e.name[i]!.toLowerCase()) {
      i += 1;
    }
    out = out.slice(0, i);
    if (out.length === 0) return '';
  }
  return out;
}
