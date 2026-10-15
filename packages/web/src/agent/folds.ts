/**
 * Which of an agent's replies you folded, kept per agent in this browser.  TRACK B.
 * (Amendment 33)
 *
 * Every reply can fold to one line, the way a tool call does. Replies still start
 * OPEN (Amendment 18): a fold is something you did to a reply you'd read, so what's
 * kept is the set you folded, never a default. "Fold all" folds the replies there are
 * now; one that arrives afterwards is output you haven't read, and arrives open.
 *
 * One kind of turn starts folded: a turn Conductor sent an orchestrator ("auto"), such as
 * its helpers' report (Amendment 160). It is long, it is its helpers' words, and the
 * orchestrator's reply to it is what you read. For those the default is the fold, so what's
 * kept is the other set: the ones you opened (`Unfolds`), and one you open stays open.
 *
 * Turn keys (`a${seq}`, `u${seq}`) come from the event log, so they are the same after a reload
 * and on another screen. Bounded, like the Files tabs: a long run can't grow
 * localStorage without limit, and the agent looked at least recently goes first.
 *
 * The rules are pure and exported apart from the storage (Amendment 9), so
 * agent/verify.ts checks them under Node.
 */

import { useSyncExternalStore } from 'react';
import { onSettings, readSetting, writeSetting } from '../lib/settings.js';

/** Folded turn keys, per agent. Insertion order is recency: the last agent is the newest. */
export type Folds = Readonly<Record<string, readonly string[]>>;

export const MAX_FOLD_AGENTS = 40;
export const MAX_FOLDS = 500;

/** Anything stored that isn't a set of folds is no folds, not an error. */
export function parseFolds(raw: string | null): Folds {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const [agent, keys] of Object.entries(v)) {
      if (!Array.isArray(keys)) continue;
      const ok = keys.filter((k): k is string => typeof k === 'string').slice(-MAX_FOLDS);
      if (ok.length > 0) out[agent] = ok;
    }
    return out;
  } catch {
    return {};
  }
}

export function isFolded(f: Folds, agentId: string, key: string): boolean {
  return f[agentId]?.includes(key) ?? false;
}

/** `keys` as this agent's folds, made the most recent agent, and everything within bounds. */
function put(f: Folds, agentId: string, keys: readonly string[]): Folds {
  const out: Record<string, readonly string[]> = {};
  for (const [a, k] of Object.entries(f)) if (a !== agentId) out[a] = k;
  if (keys.length > 0) out[agentId] = keys.slice(-MAX_FOLDS);
  const agents = Object.keys(out);
  for (const a of agents.slice(0, Math.max(0, agents.length - MAX_FOLD_AGENTS))) delete out[a];
  return out;
}

export function setFold(f: Folds, agentId: string, key: string, folded: boolean): Folds {
  const now = (f[agentId] ?? []).filter((k) => k !== key);
  return put(f, agentId, folded ? [...now, key] : now);
}

/** Folds every turn in `keys` — the ones there are now. */
export function foldAll(f: Folds, agentId: string, keys: readonly string[]): Folds {
  const now = f[agentId] ?? [];
  return put(f, agentId, [...now, ...keys.filter((k) => !now.includes(k))]);
}

export function unfoldAll(f: Folds, agentId: string): Folds {
  return put(f, agentId, []);
}

/**
 * The turns that start folded which you opened, per agent (Amendment 160). The same shape
 * and bounds as `Folds`, kept beside it, so a stored set of folds from before reads as it did.
 */
export type Unfolds = Folds;

/** What's kept for one agent's transcript: what you folded, and what you opened of the rest. */
export interface FoldState {
  folds: Folds;
  unfolds: Unfolds;
}

/**
 * Whether a turn shows folded. One that starts open (`byDefault` false, every reply) is
 * folded once you fold it; one that starts folded is open once you open it.
 */
export function shownFolded(s: FoldState, agentId: string, key: string, byDefault: boolean): boolean {
  return byDefault ? !isFolded(s.unfolds, agentId, key) : isFolded(s.folds, agentId, key);
}

/** You folded or opened one turn. It's kept in the set that holds what isn't the default. */
export function toggleFold(s: FoldState, agentId: string, key: string, byDefault: boolean): FoldState {
  const folded = shownFolded(s, agentId, key, byDefault);
  return byDefault
    ? { ...s, unfolds: setFold(s.unfolds, agentId, key, folded) }
    : { ...s, folds: setFold(s.folds, agentId, key, !folded) };
}

/** "Fold all": every turn in `keys` folded, the ones in `byDefault` back to their fold. */
export function foldEvery(
  s: FoldState,
  agentId: string,
  keys: readonly string[],
  byDefault: readonly string[],
): FoldState {
  return {
    folds: foldAll(s.folds, agentId, keys.filter((k) => !byDefault.includes(k))),
    unfolds: put(s.unfolds, agentId, (s.unfolds[agentId] ?? []).filter((k) => !byDefault.includes(k))),
  };
}

/** "Unfold all": nothing folded, and every turn in `byDefault` (those there are now) opened. */
export function unfoldEvery(s: FoldState, agentId: string, byDefault: readonly string[]): FoldState {
  return { folds: unfoldAll(s.folds, agentId), unfolds: foldAll(s.unfolds, agentId, byDefault) };
}

/**
 * The one line a folded reply shows: its first line of prose, without the markdown
 * that only means something rendered. Nothing is dropped that would change what the
 * line says — `**not** safe` reads `not safe`, not `safe`.
 */
export function foldLine(prose: string): string {
  for (const raw of prose.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|```\S*)/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .trim();
    if (line.length > 0 && !/^[-*_]{3,}$/.test(line)) return line;
  }
  return '';
}

// ── the storage side ────────────────────────────────────────────────────────

/** One set of turn keys per agent, kept in the settings file under `key`. */
function kept(key: string) {
  const listeners = new Set<() => void>();
  let cache: Folds | null = null;
  /** The stored text `cache` was parsed from, so another tab's change is noticed. */
  let parsedFrom: string | null | undefined;

  // Kept in the settings file (Amendment 46), so every browser has the same folds.
  function read(): Folds {
    const raw = readSetting(key);
    if (cache && raw === parsedFrom) return cache;
    parsedFrom = raw;
    cache = parseFolds(raw);
    return cache;
  }

  onSettings(() => {
    if (readSetting(key) !== parsedFrom) for (const l of listeners) l();
  });

  function write(f: Folds): void {
    cache = f;
    parsedFrom = JSON.stringify(cache);
    writeSetting(key, parsedFrom);
    for (const l of listeners) l();
  }

  function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  }

  // `read` is the server snapshot too, so agent/verify.ts can render a transcript under Node.
  const use = (): Folds => useSyncExternalStore(subscribe, read, read);
  return { read, write, use };
}

const folded = kept('conductor.agentFolds');
/** The turns that start folded which you opened (Amendment 160). */
const unfolded = kept('conductor.agentUnfolds');

/** You folded, opened, folded all or unfolded all: both sets, as `fn` leaves them. */
export function updateFoldState(fn: (s: FoldState) => FoldState): void {
  const was = { folds: folded.read(), unfolds: unfolded.read() };
  const now = fn(was);
  if (now.folds !== was.folds) folded.write(now.folds);
  if (now.unfolds !== was.unfolds) unfolded.write(now.unfolds);
}

export function useFolds(): Folds {
  return folded.use();
}

export function useUnfolds(): Unfolds {
  return unfolded.use();
}
