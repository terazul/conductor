/**
 * What a job does by itself when it is done (Amendment 219): commit, test, merge, push, clean up.
 *
 * Pure, and here for the reason `stack.ts` gives: the daemon reads an agent's setting and the
 * browser shows it, from one copy, so a setting stored before this (Amendment 144's
 * `mergeWhenDone`) reads the same on both sides.
 *
 * One object of five flags rather than five fields on `Autonomy`: it is one thing to normalise
 * and one thing a pill sends (the POST merges `autonomy` a field at a time, so the object goes
 * whole), and an agent with none on has no field at all.
 */

import type { Autonomy } from './wire.js';

/** The steps, in the order they run. */
export const WHEN_DONE_STEPS = ['commit', 'test', 'merge', 'push', 'cleanup'] as const;

export type WhenDoneStep = (typeof WHEN_DONE_STEPS)[number];

/** Which steps an agent asked for. Only `true` is stored; absent is off. */
export type WhenDone = { [S in WhenDoneStep]?: true };

/** Each step as the pills and the transcript name it. */
export const WHEN_DONE_LABELS: Record<WhenDoneStep, string> = {
  commit: 'commit',
  test: 'test',
  merge: 'merge',
  push: 'push',
  cleanup: 'clean up',
};

/** Only the five flags, only `true`; null when none is on. */
export function whenDoneFrom(raw: unknown): WhenDone | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: WhenDone = {};
  for (const s of WHEN_DONE_STEPS) if (r[s] === true) out[s] = true;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The steps an agent's autonomy asks for. `whenDone` when it is there; else Amendment 144's
 * `mergeWhenDone: true`, which was "merge into main and clean up", reads as merge and clean up.
 * Nothing is rewritten in the database: an old row reads like this every time.
 */
export function whenDoneOf(a: Pick<Autonomy, 'whenDone'> & { mergeWhenDone?: unknown }): WhenDone {
  if (a.whenDone !== undefined) return whenDoneFrom(a.whenDone) ?? {};
  return a.mergeWhenDone === true ? { merge: true, cleanup: true } : {};
}

/**
 * An autonomy as both sides read it: `mergeWhenDone` gone, `whenDone` holding what it meant, and
 * absent when nothing is on. The one normaliser: the daemon's agent reads and the web's both use it.
 */
export function normaliseAutonomy<T extends Autonomy>(a: T): T {
  const { mergeWhenDone: _old, whenDone: _new, ...rest } = a as T & { mergeWhenDone?: unknown };
  const steps = whenDoneOf(a);
  return (Object.keys(steps).length > 0 ? { ...rest, whenDone: steps } : rest) as T;
}

/** The steps that are on, in order. */
export function stepsOn(w: WhenDone): WhenDoneStep[] {
  return WHEN_DONE_STEPS.filter((s) => w[s] === true);
}

/** Every step any of `agents` asks for: a step runs when any agent of the job has it on. */
export function jobWhenDone(agents: ReadonlyArray<{ autonomy: Autonomy }>): WhenDone {
  const out: WhenDone = {};
  for (const a of agents) for (const s of stepsOn(whenDoneOf(a.autonomy))) out[s] = true;
  return out;
}

/** What one step came to, as a finish records it and the cards show it. */
export interface WhenDoneResult {
  step: WhenDoneStep;
  /** `skipped`: nothing to do (nothing uncommitted, nothing to merge), which stops nothing. */
  outcome: 'done' | 'skipped' | 'failed' | 'interrupted';
  /** The phrase: "committed a1b2c3d", "tests passed (make test, 2m 10s)". */
  said: string;
}

/** A duration as the transcript says it: "45s", "2m 10s", "1h 3m". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The longest a when-done commit message is. */
export const COMMIT_MESSAGE_MAX = 72;

/**
 * The commit's message: the job's name, or its prompt's first line, then the first line of the
 * last thing an agent said, cut to `COMMIT_MESSAGE_MAX` characters.
 */
export function whenDoneCommitMessage(title: string, lastReply: string | null): string {
  const first = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const head = first(title) || 'Conductor job';
  const reply = lastReply ? first(lastReply) : '';
  const whole = reply ? `${head} — ${reply}` : head;
  return whole.length <= COMMIT_MESSAGE_MAX ? whole : `${whole.slice(0, COMMIT_MESSAGE_MAX - 1).trimEnd()}…`;
}
