/**
 * The event log — append-only, globally sequenced.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks A–E.
 * Tracks A, C and D all emit events; they all go through `append()`. Do not
 * write to the `events` table directly, or the hub won't see it.
 *
 * Durability vs. delivery are deliberately separated:
 *   • append()  — synchronous, durable, every single event. Never dropped.
 *   • the hub   — coalesces to ~10 Hz for the browser. Lossy in *timing* only;
 *                 the seq cursor guarantees nothing is lost in content.
 */

import type { Event, EventPayload, NewEvent } from '@conductor/shared';
import { row, rows, type Db } from './db/index.js';

type Listener = (e: Event) => void;

const listeners = new Set<Listener>();

interface EventRow {
  seq: number;
  ts: string;
  project_id: string;
  job_id: string;
  agent_id: string | null;
  payload: string;
}

function toEvent(r: EventRow): Event {
  return {
    seq: r.seq,
    ts: r.ts,
    projectId: r.project_id,
    jobId: r.job_id,
    agentId: r.agent_id,
    payload: JSON.parse(r.payload) as EventPayload,
  };
}

/**
 * An event nothing can show: its job or its agent has been removed. Removing a project
 * removes its jobs (ON DELETE CASCADE), so that is covered too. `project_id` isn't
 * tested, because a dev server's event can carry an empty one while its job is live.
 */
const ORPHANED = `job_id NOT IN (SELECT id FROM jobs)
  OR (agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents))`;

export class EventLog {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Append one event. Returns it with `seq` and `ts` populated.
   * Synchronous by design — callers (including the async PreToolUse hook) must
   * never be able to race ahead of the log.
   */
  append(e: NewEvent): Event {
    const ts = e.ts ?? new Date().toISOString();
    const info = this.#db
      .prepare(
        `INSERT INTO events (ts, project_id, job_id, agent_id, kind, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ts, e.projectId, e.jobId, e.agentId, e.payload.kind, JSON.stringify(e.payload));

    const full: Event = {
      seq: Number(info.lastInsertRowid),
      ts,
      projectId: e.projectId,
      jobId: e.jobId,
      agentId: e.agentId,
      payload: e.payload,
    };

    for (const l of listeners) {
      try {
        l(full);
      } catch (err) {
        // A broken subscriber must never break the writer.
        console.error('[eventlog] listener threw', err);
      }
    }
    return full;
  }

  /** Convenience for the common case. */
  emit(
    scope: { projectId: string; jobId: string; agentId: string | null },
    payload: EventPayload,
  ): Event {
    return this.append({ ...scope, payload });
  }

  /** Replay for a reconnecting client. `limit` guards against huge gaps. */
  since(seq: number, limit = 5_000): Event[] {
    const found = rows<EventRow>(
      this.#db
        .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(seq, limit),
    );
    return found.map(toEvent);
  }

  /** True when `since(seq)` would have been truncated — client must resync. */
  hasGapAfter(seq: number, limit = 5_000): boolean {
    const found = row<{ n: number }>(
      this.#db.prepare(`SELECT COUNT(*) AS n FROM events WHERE seq > ?`).get(seq),
    );
    return (found?.n ?? 0) > limit;
  }

  forAgent(agentId: string, limit = 2_000): Event[] {
    const found = rows<EventRow>(
      this.#db
        .prepare(`SELECT * FROM events WHERE agent_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(agentId, limit),
    );
    return found.reverse().map(toEvent);
  }

  /**
   * What an agent was told, said and did, to pass on as text (Amendment 101): the user's
   * messages, its replies, its tool calls and how each ended. Not its edits, spend, status
   * or requests, which `forAgent` carries too. The newest `limit`, oldest first.
   */
  conversation(agentId: string, limit = 20_000): Event[] {
    const found = rows<EventRow>(
      this.#db
        .prepare(
          `SELECT * FROM events WHERE agent_id = ? AND kind IN ('user_text', 'text', 'tool_start', 'tool_end')
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(agentId, limit),
    );
    return found.reverse().map(toEvent);
  }

  forJob(jobId: string, limit = 5_000): Event[] {
    const found = rows<EventRow>(
      this.#db
        .prepare(`SELECT * FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(jobId, limit),
    );
    return found.reverse().map(toEvent);
  }

  /** An agent's last prose — what it reported when it finished (Amendment 37). */
  lastText(agentId: string): string | null {
    const found = row<{ payload: string }>(
      this.#db
        .prepare(`SELECT payload FROM events WHERE agent_id = ? AND kind = 'text' ORDER BY seq DESC LIMIT 1`)
        .get(agentId),
    );
    if (!found) return null;
    const p = JSON.parse(found.payload) as EventPayload;
    return p.kind === 'text' ? p.text : null;
  }

  /** Recent events of one kind — the sparkline and diffstat sources. */
  recentByKind(kind: EventPayload['kind'], sinceTs: string): Event[] {
    const found = rows<EventRow>(
      this.#db
        .prepare(`SELECT * FROM events WHERE kind = ? AND ts >= ? ORDER BY seq ASC`)
        .all(kind, sinceTs),
    );
    return found.map(toEvent);
  }

  head(): number {
    const found = row<{ seq: number }>(
      this.#db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`).get(),
    );
    return found?.seq ?? 0;
  }

  /**
   * How much of the log is left over from what you removed (Amendment 36).
   *
   * Removing a project, job or agent keeps its events on purpose: removal is not a
   * decision about the record (store.ts `deleteProject`). But nothing can show them
   * any more, and the table only grows, so clearing them is offered as its own
   * decision, made with a button rather than as a side effect of removal.
   */
  storage(): { events: number; orphaned: number; bytes: number } {
    const n = (sql: string): number =>
      row<{ n: number }>(this.#db.prepare(sql).get())?.n ?? 0;
    return {
      events: n('SELECT COUNT(*) AS n FROM events'),
      orphaned: n(`SELECT COUNT(*) AS n FROM events WHERE ${ORPHANED}`),
      bytes: n('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()'),
    };
  }

  /**
   * Delete the events whose job or agent is gone, and give the space back.
   * Returns how many went.
   *
   * The one exception to append-only, and it can only remove what no screen can
   * reach. Cursors stay valid: `seq` is AUTOINCREMENT, so a deleted seq is never
   * handed out again and every later event still sorts after any cursor a client
   * holds. `cost_daily` is untouched — the money was still spent.
   */
  pruneOrphans(): number {
    const removed = Number(this.#db.prepare(`DELETE FROM events WHERE ${ORPHANED}`).run().changes);
    if (removed > 0) this.#db.exec('VACUUM');
    return removed;
  }

  /** Subscribe to every appended event. Returns an unsubscribe function. */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  }
}

let instance: EventLog | null = null;

export function initEventLog(db: Db): EventLog {
  instance = new EventLog(db);
  return instance;
}

export function eventLog(): EventLog {
  if (!instance) throw new Error('EventLog not initialised — call initEventLog(db) first');
  return instance;
}
