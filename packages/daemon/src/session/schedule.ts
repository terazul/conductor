/**
 * Things that happen at a time you chose (Amendment 111). TRACK A.
 *
 *   - **Pause everything until a time.** The `conductor.pauseUntil` setting, an ISO
 *     instant. While it is in the future the supervisor is held: nothing starts by itself
 *     and every working agent is paused, keeping its conversation. When it passes, or you
 *     clear it, the agents the pause paused carry on and whatever was queued starts. The
 *     setting is removed once it has passed, so the next start doesn't read an old one.
 *   - **Send a message at a time.** A row in `scheduled_messages`; at its time it goes to
 *     the agent exactly as if you had pressed send then (`Supervisor.sendMessage`): into a
 *     live run, or resuming a finished one. Sent, the row is deleted: the transcript has it.
 *     While everything is paused, a message that comes due waits for the pause to end.
 *   - **Send a message when the agent is done** (Amendment 157). The same row, with
 *     `trigger = 'done'` and no time of its own (`at` is when it was made). The clock never
 *     reads it: `Supervisor.#settle` sends the oldest one when the agent's turn ends as `done`
 *     (`nextWhenDone`), so several go one per turn, in order. A question it stops on, a
 *     failure or a pause aren't `done`, so it keeps waiting through them; while everything is
 *     paused it waits for the pause to end. It survives a restart, and goes at the next `done`.
 *   - **Wait for a slot** (Amendment 168). Not one you make: a message sent while every slot is
 *     taken — from the composer, a time, a `done` — becomes a `trigger = 'slot'` row, and its
 *     agent `queued`. `Supervisor.pump` sends the oldest one when it gives the agent a slot
 *     (`nextForSlot`), so it survives a restart too. Cancelling it puts the agent back.
 *
 * TIME. Instants are ISO, compared as numbers. The browser turns the local date and time
 * you picked into one; nothing here reads or sets a time zone.
 *
 * THE CLOCK is a short interval rather than one timer to the next time: a machine that
 * sleeps fires a long timer late and a clock moved by hand fires it never, which is why the
 * day watch looks every 30 s (daily.ts). This looks every 5 s, so a message goes out at
 * most that late, and once on start, so anything that came due while the daemon was down
 * goes out then.
 */

import type { ScheduledMessage, ScheduleTrigger } from '@conductor/shared';
import { PAUSE_UNTIL_KEY } from '@conductor/shared';
import { rows, type Db } from '../db/index.js';
import { hub, registerSnapshotContributor } from '../hub.js';
import { onSettingsChanged, patchSettings, readSettings, settingRule } from '../settings.js';
import { newId } from './store.js';
import { BudgetReachedError, type Supervisor } from './supervisor.js';

/** How often the clock is looked at. */
export const SCHEDULE_TICK_MS = 5_000;

/** The longest message, as the composer allows. */
export const SCHEDULED_TEXT_MAX = 100_000;

/** How far ahead a time may be: a year, so a typo in the year is refused. */
export const SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/** How far in the past a time may be when it is chosen: a minute, for a slow click. */
export const SCHEDULE_GRACE_MS = 60_000;

/** The sentence for a time that isn't one, or is out of range; null when it is fine. */
export function timeProblem(raw: unknown, now = Date.now()): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return 'a time is required';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return 'not a time: use an ISO date and time, such as 2026-10-09T18:00:00Z';
  if (t < now - SCHEDULE_GRACE_MS) return 'that time has passed';
  if (t > now + SCHEDULE_HORIZON_MS) return 'more than a year ahead';
  return null;
}

settingRule(PAUSE_UNTIL_KEY, (v) => {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return 'an ISO date and time, such as 2026-10-09T18:00:00Z';
  return t > Date.now() + SCHEDULE_HORIZON_MS ? 'more than a year ahead' : null;
});

/** When everything is paused until, or null when it isn't (absent, unreadable, or past). */
export function pausedUntil(now = Date.now()): Date | null {
  const raw = readSettings()[PAUSE_UNTIL_KEY];
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now ? new Date(t) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rows
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  agent_id: string;
  at: string;
  trigger: ScheduleTrigger;
  text: string;
  created_at: string;
  error: string | null;
  /** 1 for a message of Conductor's, shown as `auto` when it goes (255, Amendment 168). */
  synthetic: number;
}

const toMessage = (r: Row): ScheduledMessage => ({
  id: r.id,
  agentId: r.agent_id,
  at: r.at,
  trigger: r.trigger,
  text: r.text,
  createdAt: r.created_at,
  error: r.error,
});

/** Every scheduled message, soonest first. */
export function listScheduled(db: Db): ScheduledMessage[] {
  return rows<Row>(db.prepare('SELECT * FROM scheduled_messages ORDER BY at, created_at').all()).map(toMessage);
}

/** `at` is read only for an `at` row; any other has its creation time there (Amendment 157). */
export function insertScheduled(
  db: Db,
  agentId: string,
  at: string | null,
  text: string,
  trigger: ScheduleTrigger = 'at',
  synthetic = false,
): ScheduledMessage {
  const created = new Date().toISOString();
  const r: Row = {
    id: newId('sch'),
    agent_id: agentId,
    at: trigger === 'at' && at !== null ? new Date(Date.parse(at)).toISOString() : created,
    trigger,
    text,
    created_at: created,
    error: null,
    synthetic: synthetic ? 1 : 0,
  };
  db.prepare(
    'INSERT INTO scheduled_messages (id, agent_id, at, trigger, text, created_at, error, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(r.id, r.agent_id, r.at, r.trigger, r.text, r.created_at, r.error, r.synthetic);
  return toMessage(r);
}

/** True when there was such a row. */
export function deleteScheduled(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id).changes) > 0;
}

export function failScheduled(db: Db, id: string, error: string): void {
  db.prepare('UPDATE scheduled_messages SET error = ? WHERE id = ?').run(error.slice(0, 400), id);
}

/** Waiting and due: an `at` row with no error yet, and `at` no later than now. Soonest first. */
function due(db: Db, now: number): ScheduledMessage[] {
  return listScheduled(db).filter((m) => m.trigger === 'at' && m.error === null && Date.parse(m.at) <= now);
}

/** The oldest message waiting for this agent's turn to end as `done`, or null (Amendment 157). */
export function nextWhenDone(db: Db, agentId: string): ScheduledMessage | null {
  const r = db
    .prepare(
      "SELECT * FROM scheduled_messages WHERE agent_id = ? AND trigger = 'done' AND error IS NULL ORDER BY created_at, id LIMIT 1",
    )
    .get(agentId) as Row | undefined;
  return r ? toMessage(r) : null;
}

/** One row, or null. */
export function getScheduled(db: Db, id: string): ScheduledMessage | null {
  const r = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as Row | undefined;
  return r ? toMessage(r) : null;
}

/**
 * The oldest message waiting for a slot for this agent, or null (Amendment 168): sent by
 * `Supervisor.pump` when it gives the agent one. `synthetic` is whether it is Conductor's. In the
 * order sent: two in one millisecond go by `rowid`, as the id is random.
 */
export function nextForSlot(db: Db, agentId: string): (ScheduledMessage & { synthetic: boolean }) | null {
  const r = db
    .prepare(
      "SELECT * FROM scheduled_messages WHERE agent_id = ? AND trigger = 'slot' AND error IS NULL ORDER BY created_at, rowid LIMIT 1",
    )
    .get(agentId) as Row | undefined;
  return r ? { ...toMessage(r), synthetic: r.synthetic === 1 } : null;
}

/** Every open page is told the whole list: from the clock, a route, or the supervisor (Amendment 157). */
export function broadcastScheduled(db: Db): void {
  try {
    hub().broadcast({ type: 'scheduled', scheduled: listScheduled(db) });
  } catch {
    // No hub outside the daemon. Not fatal.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The clock
// ─────────────────────────────────────────────────────────────────────────────

/** The one thing a message is sent through: `Supervisor.sendMessage`, or a stand-in in verify. */
type Sup = Pick<Supervisor, 'sendMessage' | 'hold' | 'release' | 'held'>;

export class Scheduler {
  readonly #db: Db;
  readonly #sup: Sup;
  #timer: NodeJS.Timeout | null = null;
  #off: (() => void)[] = [];
  /** A tick in flight: one at a time, so a slow `hold` isn't run twice. */
  #busy: Promise<void> | null = null;
  #again = false;

  constructor(db: Db, sup: Sup) {
    this.#db = db;
    this.#sup = sup;
  }

  /**
   * Hold at once if the pause is on, before anything is pumped (the caller pumps after),
   * then look every SCHEDULE_TICK_MS and whenever the pause setting changes.
   */
  async start(everyMs = SCHEDULE_TICK_MS): Promise<void> {
    this.#off.push(
      onSettingsChanged((changed) => {
        if (changed.includes(PAUSE_UNTIL_KEY)) void this.tick();
      }),
      registerSnapshotContributor(() => ({ scheduled: listScheduled(this.#db) })),
    );
    if (pausedUntil()) {
      this.#holding = true;
      await this.#sup.hold();
    }
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const off of this.#off.splice(0)) off();
  }

  /** Look once: start or end the pause, and send what is due. Calls made while one runs join it. */
  tick(now?: number): Promise<void> {
    if (this.#busy) {
      this.#again = true;
      return this.#busy;
    }
    this.#busy = (async () => {
      try {
        do {
          this.#again = false;
          await this.#once(now ?? Date.now());
        } while (this.#again);
      } finally {
        this.#busy = null;
      }
    })();
    return this.#busy;
  }

  async #once(now: number): Promise<void> {
    const until = pausedUntil(now);
    if (until && !this.#sup.held) {
      this.#holding = true;
      await this.#sup.hold();
    } else if (!until) {
      // Ended, or never on: wake what a pause paused (after a restart past its time too).
      // Only a hold this made: one someone else put on (a check freezing the queue) is theirs.
      if (this.#holding || this.#first) this.#sup.release();
      this.#holding = false;
      // Passed: removed, so it reads as off everywhere. Removing it calls back here; a no-op.
      if (readSettings()[PAUSE_UNTIL_KEY] !== undefined) patchSettings({ [PAUSE_UNTIL_KEY]: null });
    }
    this.#first = false;
    if (until) return; // Messages that come due while paused wait for it to end.

    let changed = false;
    for (const m of due(this.#db, now)) {
      try {
        this.#sup.sendMessage(m.agentId, m.text);
        deleteScheduled(this.#db, m.id);
        changed = true;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        // Not started yet, so it has no session to take a message: it is tried again.
        if (!(err instanceof BudgetReachedError) && /cannot receive messages yet/.test(text)) continue;
        failScheduled(this.#db, m.id, text);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  #first = true;
  /** Whether the supervisor's hold is this scheduler's, from the pause setting. */
  #holding = false;

  /** Every open page is told the whole list. */
  broadcast(): void {
    broadcastScheduled(this.#db);
  }
}

let instance: Scheduler | null = null;

export function initScheduler(db: Db, sup: Sup): Scheduler {
  instance?.stop();
  instance = new Scheduler(db, sup);
  return instance;
}

export function scheduler(): Scheduler {
  if (!instance) throw new Error('Scheduler not initialised — call initScheduler(db, sup) first');
  return instance;
}
