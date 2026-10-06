/**
 * The notification ladder.
 *
 * Track E owns this file.
 *
 * Escalating, in this order, because interrupting someone is a cost you should
 * pay only as the wait justifies it:
 *
 *   1. tab title + favicon badge   — free, always on, visible on a glance back
 *   2. Web Notification            — opt-in, asked for on a click, never on load
 *   3. a sound                     — only once a request has waited 60s
 *
 * Alerts (Amendment 28: a failed agent, a budget stop, a lost model API, a dead dev
 * server) climb the same ladder, with one difference: they don't wait for the sound or
 * age into the red badge. A request may yet be answered by someone glancing over; a
 * failure needs you from the moment it happens.
 *
 * Slack (5m) and phone push (15m) are later phases. They are declared in
 * `CHANNELS` so the inspector can show the whole ladder honestly, and they carry
 * `available: false` so nothing pretends to work.
 *
 * WHERE THIS RUNS (Amendment 1). The effects live in `./always.tsx`, mounted
 * once for the life of the tab, so the badge keeps counting while the user is on
 * Fleet — which is exactly when they need it. Screen 4 only *reads* the
 * preferences and toggles them, so there is exactly one owner of the tab title
 * and favicon. That split is why the preferences are a module-level store rather
 * than component state: two React trees, one source of truth.
 */

import { onSettings, readSetting, writeSetting } from '../lib/settings.js';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PendingRequest } from '@conductor/shared';
import { SOUND_AFTER_MS, formatWait, waitingMs } from './aging.js';
import { requestTitle } from './describe.js';

// ─────────────────────────────────────────────────────────────────────────────
// The ladder, declared
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelDef {
  id: 'tab' | 'desktop' | 'sound' | 'slack' | 'push';
  label: string;
  /** Rung on the ladder; also the display order. */
  rung: number;
  /** How long a request waits before this rung fires. 0 = immediately. */
  afterMs: number;
  /** false → a later phase. Rendered, inert, and labelled as such. */
  available: boolean;
  /** true → the user can switch it off. The tab badge is not negotiable. */
  toggleable: boolean;
}

export const CHANNELS: readonly ChannelDef[] = [
  { id: 'tab', label: 'browser tab badge', rung: 1, afterMs: 0, available: true, toggleable: false },
  { id: 'desktop', label: 'desktop notification', rung: 2, afterMs: 0, available: true, toggleable: true },
  { id: 'sound', label: 'sound after 60s', rung: 3, afterMs: SOUND_AFTER_MS, available: true, toggleable: true },
  { id: 'slack', label: 'Slack DM after 5m', rung: 4, afterMs: 5 * 60_000, available: false, toggleable: false },
  { id: 'push', label: 'phone push after 15m', rung: 5, afterMs: 15 * 60_000, available: false, toggleable: false },
];

/** Inspector caption for a rung: what it will do, or when it would. */
export function channelHint(c: ChannelDef, oldestMs: number): string {
  if (!c.available) return 'later phase';
  if (c.afterMs === 0) return 'immediately';
  return oldestMs >= c.afterMs ? 'fired' : `at ${formatWait(c.afterMs)}`;
}

export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

function notificationPermission(): PermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  const p = Notification.permission;
  return p === 'granted' || p === 'denied' ? p : 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences — one store, shared by the always-on mount and screen 4
// ─────────────────────────────────────────────────────────────────────────────

const LS_PREFIX = 'conductor.attention.';

// Kept in the settings file (Amendment 46). Whether the OS lets this browser notify is
// the browser's own, and stays per browser.
function readFlag(key: string): boolean {
  return readSetting(LS_PREFIX + key) === 'on';
}

function writeFlag(key: string, on: boolean): void {
  writeSetting(LS_PREFIX + key, on ? 'on' : 'off');
}

export interface LadderPrefs {
  desktopEnabled: boolean;
  soundEnabled: boolean;
  desktopPermission: PermissionState;
}

let prefs: LadderPrefs = {
  desktopEnabled: readFlag('desktop'),
  soundEnabled: readFlag('sound'),
  desktopPermission: notificationPermission(),
};

const listeners = new Set<() => void>();

// Another tab turned one on, or the daemon's settings just arrived.
onSettings(() => patch({ desktopEnabled: readFlag('desktop'), soundEnabled: readFlag('sound') }));

/** Replaces the snapshot only on a real change, so the hook stays stable. */
function patch(next: Partial<LadderPrefs>): void {
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (prefs[k as keyof LadderPrefs] !== v) changed = true;
  }
  if (!changed) return;
  prefs = { ...prefs, ...next };
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): LadderPrefs {
  return prefs;
}

/** Read the ladder's preferences from either React tree. */
export function useLadderPrefs(): LadderPrefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Requests already announced / sounded. Module-level so they survive the
// always-on component's own lifecycle and can't double-fire.
const notified = new Set<string>();
const sounded = new Set<string>();

/** An alert as the ladder says it. ./always.tsx builds these, because it has the names. */
export interface LadderAlert {
  id: string;
  title: string;
  body: string;
}

/** Alerts share those sets with requests, under a prefix so an id can't collide. */
const alertKey = (id: string): string => `alert:${id}`;

/**
 * A job that finished and you haven't seen (Amendment 87). The key carries its end time,
 * so a job continued and finished again is announced again.
 */
export interface LadderFinished {
  key: string;
  title: string;
  body: string;
  projectId: string;
}

/** The finished jobs on screen now, so turning notifications on doesn't announce them. */
let liveFinished: readonly LadderFinished[] = [];

/** Where a clicked notification should land. */
export type LadderTarget = { requestId: string } | { alertId: string } | { projectId: string };

/** A request this old turns the badge red. */
const URGENT_AFTER_MS = 12 * 60_000;

/**
 * The tab badge: everything that needs you, and every finished job you haven't seen
 * (Amendment 87). Red only for a request left waiting — an alert doesn't age into
 * urgency, it needed you from the start, and a finished job is only news.
 */
export function badgeState(
  pending: readonly PendingRequest[],
  alertCount: number,
  now: number,
  finishedCount = 0,
): { count: number; urgent: boolean } {
  const oldestMs = pending.reduce((worst, r) => Math.max(worst, waitingMs(r.createdAt, now)), 0);
  return { count: pending.length + alertCount + finishedCount, urgent: oldestMs >= URGENT_AFTER_MS };
}

/** What should chime now and hasn't: a request once it has waited 60s, an alert at once. */
export function dueForChime(
  pending: readonly PendingRequest[],
  alerts: readonly { id: string }[],
  now: number,
  already: ReadonlySet<string>,
): string[] {
  const due: string[] = [];
  for (const r of pending) {
    if (!already.has(r.requestId) && waitingMs(r.createdAt, now) >= SOUND_AFTER_MS) due.push(r.requestId);
  }
  for (const a of alerts) if (!already.has(alertKey(a.id))) due.push(alertKey(a.id));
  return due;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rung 3 — the sound
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesised rather than shipped as an asset: no binary in the repo. The
 * context is created inside the click that enables the toggle — that gesture is
 * what satisfies the browser's autoplay rule — and lives at module scope because
 * the click happens in screen 4 while the playback happens in the always-on
 * mount.
 */
let audioCtx: AudioContext | null = null;

function armAudio(): void {
  if (audioCtx) return;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    audioCtx = new Ctor();
  } catch {
    /* no audio available */
  }
}

function playChime(): void {
  const ctx = audioCtx;
  if (!ctx) return;
  void ctx.resume().catch(() => undefined);
  // Two short notes — distinct from a system alert, not alarming.
  for (const [i, hz] of [880, 1174.7].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const t = ctx.currentTime + i * 0.17;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.13, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.36);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions — stable identities, callable from either tree
// ─────────────────────────────────────────────────────────────────────────────

export const ladderActions = Object.freeze({
  /** Asks the browser, on a click. Never called on mount. */
  async enableDesktop(
    pending: readonly PendingRequest[],
    alerts: readonly { id: string }[] = [],
  ): Promise<void> {
    if (typeof Notification === 'undefined') {
      patch({ desktopPermission: 'unsupported' });
      return;
    }
    let state = notificationPermission();
    if (state === 'default') {
      try {
        const res = await Notification.requestPermission();
        state = res === 'granted' ? 'granted' : res === 'denied' ? 'denied' : 'default';
      } catch {
        state = 'denied';
      }
    }
    const on = state === 'granted';
    // Don't re-announce everything already on screen.
    if (on) {
      for (const r of pending) notified.add(r.requestId);
      for (const a of alerts) notified.add(alertKey(a.id));
      for (const f of liveFinished) notified.add(f.key);
    }
    writeFlag('desktop', on);
    patch({ desktopPermission: state, desktopEnabled: on });
  },

  disableDesktop(): void {
    writeFlag('desktop', false);
    patch({ desktopEnabled: false });
  },

  toggleSound(pending: readonly PendingRequest[], alerts: readonly { id: string }[] = []): void {
    const next = !prefs.soundEnabled;
    if (next) {
      armAudio();
      // Anything already due shouldn't fire a backlog of beeps.
      for (const key of dueForChime(pending, alerts, Date.now(), sounded)) sounded.add(key);
    }
    writeFlag('sound', next);
    patch({ soundEnabled: next });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Rung 1 — tab title and favicon badge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a token rather than hardcoding a colour. Returns null when the token
 * isn't resolvable, and the caller then skips painting rather than inventing a
 * literal — a wrong amber is worse than no badge.
 */
function token(name: string): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : null;
}

const FAVICON_ID = 'atn-favicon';

function paintFavicon(count: number, urgent: boolean): void {
  const ink3 = token('--ink3');
  const bg = token('--bg');
  const hot = urgent ? token('--fail') : token('--need');
  if (ink3 === null || bg === null || hot === null) return;

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // The baton, so the idle icon still reads as Conductor.
  ctx.fillStyle = ink3;
  ctx.fillRect(14, 5, 4, 22);

  if (count > 0) {
    ctx.beginPath();
    ctx.arc(22, 22, 10, 0, Math.PI * 2);
    ctx.fillStyle = hot;
    ctx.fill();
    ctx.fillStyle = bg;
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 9 ? '9+' : String(count), 22, 23);
  }

  let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = FAVICON_ID;
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL('image/png');
}

let originalTitle: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// The effects — run by ./always.tsx only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drives all three rungs. Call from exactly one place: the always-on mount.
 * Mounting it twice would give the tab title two owners.
 *
 * `onActivate` fires when a desktop notification is clicked, with the request or
 * alert it was about, or the project of a finished job. Navigation is deliberately not done here — this file is about
 * raising notifications, not about where the app goes next; ./always.tsx owns
 * that wiring.
 */
export function useLadderEffects(
  pending: readonly PendingRequest[],
  alerts: readonly LadderAlert[],
  now: number,
  onActivate: (target: LadderTarget) => void,
  finished: readonly LadderFinished[] = [],
): void {
  const { desktopEnabled, desktopPermission, soundEnabled } = useLadderPrefs();

  // Latest callback without making the notification effect depend on its identity.
  const activate = useRef(onActivate);
  activate.current = onActivate;

  const { count, urgent } = badgeState(pending, alerts.length, now, finished.length);
  liveFinished = finished;

  // A permission granted or revoked in browser settings since last load.
  useEffect(() => {
    const actual = notificationPermission();
    if (actual !== prefs.desktopPermission) {
      patch({
        desktopPermission: actual,
        desktopEnabled: prefs.desktopEnabled && actual === 'granted',
      });
    }
  }, []);

  // Rung 1.
  useEffect(() => {
    originalTitle ??= document.title;
    document.title = count > 0 ? `(${count}) needs you · ${originalTitle}` : originalTitle;
    paintFavicon(count, urgent);
  }, [count, urgent]);

  useEffect(
    () => () => {
      if (originalTitle !== null) document.title = originalTitle;
      document.getElementById(FAVICON_ID)?.remove();
    },
    [],
  );

  // Rung 2 — one notification per request, alert or finished job, when it first appears.
  useEffect(() => {
    if (!desktopEnabled || desktopPermission !== 'granted') return;
    const show = (key: string, title: string, body: string, target: LadderTarget) => {
      if (notified.has(key)) return;
      notified.add(key);
      try {
        const n = new Notification(title, {
          body,
          tag: key,
          // Amber in a system notification is the OS's business, not ours.
          silent: true,
        });
        n.onclick = () => {
          window.focus();
          activate.current(target);
          n.close();
        };
      } catch {
        /* the browser declined to show it; the tab badge still stands */
      }
    };
    for (const r of pending) {
      show(r.requestId, `${r.projectName} · ${r.agentRole} needs you`, requestTitle(r), {
        requestId: r.requestId,
      });
    }
    for (const a of alerts) show(alertKey(a.id), a.title, a.body, { alertId: a.id });
    for (const f of finished) show(f.key, f.title, f.body, { projectId: f.projectId });
  }, [pending, alerts, finished, desktopEnabled, desktopPermission]);

  // Rung 3 — a chime once per request after 60s, and once per alert straight away. A
  // finished job doesn't chime: nothing is waiting on you.
  useEffect(() => {
    if (!soundEnabled) return;
    const due = dueForChime(pending, alerts, now, sounded);
    for (const key of due) sounded.add(key);
    // One chime for a burst: a dropped VPN fails every running agent at once.
    if (due.length > 0) playChime();
  }, [pending, alerts, now, soundEnabled]);

  // Anything the daemon resolved or cleared becomes eligible again if it ever returns.
  const liveIds = [
    ...pending.map((p) => p.requestId),
    ...alerts.map((a) => alertKey(a.id)),
    ...finished.map((f) => f.key),
  ].join('\u0000');
  useEffect(() => {
    const live = new Set(liveIds.split('\u0000').filter((s) => s.length > 0));
    for (const set of [notified, sounded]) {
      for (const id of set) if (!live.has(id)) set.delete(id);
    }
  }, [liveIds]);
}
