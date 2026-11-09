/**
 * What the ⏸ pause / ▶ resume button says, for an agent's status.  TRACK B.
 * (Amendment 35)
 *
 * Pause is how an agent is put to sleep: its run stops, its slot goes to someone else,
 * and its conversation is kept, so ▶ resume carries on in the same session. Resume
 * waits for a free slot like any launch, so it can say "queued" before it says
 * "working".
 *
 * A blocked agent keeps its question. Pausing it only lets go of the slot it was
 * holding while it waited; the question stays in Needs You, and answering it is what
 * wakes the agent. So for a blocked agent the button says that, rather than promising
 * a pause that would throw the question away.
 *
 * Pure and imports no CSS, so agent/verify.ts checks it under Node (Amendment 9).
 */

import type { Agent, AgentStatus, Event } from '@conductor/shared';
import { fmtStamp, tomorrowMorning } from '../lib/when.js';

export interface SleepControl {
  label: string;
  /** What 'Pausing' or 'Resuming' the busy line says while the call is out. */
  doing: 'Pausing' | 'Resuming';
  action: 'pause' | 'resume';
  title: string;
}

/** Statuses with nothing to pause or resume: the agent has ended. */
const ENDED: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);

export function sleepControl(status: AgentStatus): SleepControl | null {
  if (ENDED.has(status)) return null;
  if (status === 'paused') {
    return {
      label: '▶ resume',
      doing: 'Resuming',
      action: 'resume',
      title: 'Wake it in the same conversation — it waits for a free slot if all are busy',
    };
  }
  return {
    label: '⏸ pause',
    doing: 'Pausing',
    action: 'pause',
    title:
      status === 'blocked'
        ? 'Frees its slot and keeps your question — answering it is what wakes the agent'
        : 'Put it to sleep: frees its slot and keeps the conversation. A tool call still running is stopped',
  };
}

// ── ⏸ pause until a time (Amendment 205) ───────────────────────────────────

/**
 * How long ⏸ pause puts it to sleep for. Until you resume it is the default, the pause there
 * always was; the rest wake it by themselves, the daemon's clock resuming it at the time
 * (session/schedule.ts). at… is a time you choose, in the picker beside it.
 */
export type PauseChoice = 'none' | '15m' | '1h' | '4h' | 'tomorrow' | 'at';

export const PAUSE_CHOICES: readonly { key: PauseChoice; label: string }[] = [
  { key: 'none', label: 'until I resume it' },
  { key: '15m', label: '15 min' },
  { key: '1h', label: '1 hour' },
  { key: '4h', label: '4 hours' },
  { key: 'tomorrow', label: 'tomorrow 09:00' },
  { key: 'at', label: 'at…' },
];

const MINUTES: Partial<Record<PauseChoice, number>> = { '15m': 15, '1h': 60, '4h': 240 };

/**
 * When a choice wakes it, as an ISO instant: null for until I resume it, and for at…, whose
 * time is the picker's. Tomorrow is the next calendar day, so just before midnight it is
 * nine hours away and just after it a day and nine.
 */
export function pauseUntil(key: PauseChoice, now: Date): string | null {
  if (key === 'tomorrow') return tomorrowMorning(now).toISOString();
  const min = MINUTES[key];
  return min === undefined ? null : new Date(now.getTime() + min * 60_000).toISOString();
}

/**
 * The filled chip a paused agent wears on its navigator row and its tab: `⏸ paused`, or
 * `⏸ until 14:05` when it has a time to wake at. Null for any other agent, and for one paused
 * waiting for the model (Amendment 192): that one carries on by itself, and keeps its own
 * display.
 */
export function pausedChip(a: Pick<Agent, 'status' | 'resumeAt'>, waitingForModel: boolean, now: Date = new Date()): string | null {
  if (a.status !== 'paused' || waitingForModel) return null;
  return a.resumeAt ? `⏸ until ${fmtStamp(a.resumeAt, now)}` : '⏸ paused';
}

/** `resumes 14:05`, beside ▶ resume and in the status pill; empty with no time. */
export function resumesAt(a: Pick<Agent, 'status' | 'resumeAt'>, now: Date = new Date()): string {
  return a.status === 'paused' && a.resumeAt ? `resumes ${fmtStamp(a.resumeAt, now)}` : '';
}

/** The agent screen's status pill: `paused · resumes 14:05`, or the plain word. */
export function pausedPill(a: Pick<Agent, 'status' | 'resumeAt'>, now: Date = new Date()): string {
  const when = resumesAt(a, now);
  return when ? `paused · ${when}` : 'paused';
}

/**
 * The ⏸ menu's lines, for `now`: each choice with the time it wakes at beside it (`14:20`,
 * `10 Nov 09:00`), so tomorrow 09:00 says which day it is. Empty for until I resume it and
 * for at…, whose picker says.
 */
export function pauseOptions(now: Date): { key: PauseChoice; label: string; until: string | null; when: string }[] {
  return PAUSE_CHOICES.map((c) => {
    const until = pauseUntil(c.key, now);
    return { ...c, until, when: until ? fmtStamp(until, now) : '' };
  });
}

const USER_PAUSE_NOTE = 'paused by the user';

/**
 * The note a pause of yours leaves on its status event, as the daemon writes it
 * (`userPauseNote`, session/schedule.ts): `paused by the user`, with ` until <ISO>` when it has
 * a time. Null when the note is not one of yours (a budget, Pause all, the model's wait),
 * otherwise the time, or null inside for none. No note at all is an older pause of yours.
 */
export function userPause(note: string | null | undefined): { until: string | null } | null {
  if (!note || note === USER_PAUSE_NOTE) return { until: null };
  const until = note.startsWith(`${USER_PAUSE_NOTE} until `) ? note.slice(USER_PAUSE_NOTE.length + 7) : '';
  return until && Number.isFinite(Date.parse(until)) ? { until } : null;
}

/**
 * Whether its latest status is a pause of yours: only that one takes a time to wake at, since
 * what else paused it resumes it (the daemon refuses the rest, 409).
 */
export function pausedByYou(events: readonly Event[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const p = events[i]?.payload;
    if (p?.kind !== 'status') continue;
    return p.status === 'paused' && userPause(p.error) !== null;
  }
  return false;
}
