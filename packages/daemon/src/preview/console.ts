/**
 * Captured browser console output from the preview pane.
 *
 * TRACK D OWNS THIS FILE.
 *
 * The injected shim (`rewrite.ts#buildShim`) forwards the previewed app's
 * console output and uncaught errors here. Two consumers:
 *
 *   • the console pane on screen 6, which reads `console` events off the feed
 *     like every other screen reads every other fact — the log stays the single
 *     projection source (CONTRACT.md §5.2);
 *   • "send errors to agent", which needs the errors to still exist after the
 *     human has reloaded the page and thought about it for a minute. Hence the
 *     table rather than a module-level array.
 *
 * Volume is the thing to be careful about: a render loop logging in an effect
 * will emit thousands of entries a second. The shim batches and rate-limits on
 * its side; this side caps what it keeps per job and coalesces exact repeats so
 * one runaway warning can't bury the two errors that matter.
 */

import type { ConsoleEntry } from '@conductor/shared';
import { eventLog } from '../eventlog.js';
import { row, rows, type Db } from '../db/index.js';

/** Per-job retention. Older entries are trimmed on write. */
const KEEP_PER_JOB = 500;

/** Identical consecutive text inside this window is counted, not re-stored. */
const DEDUPE_WINDOW_MS = 1_000;

interface ConsoleRow {
  id: number;
  job_id: string;
  level: string;
  text: string;
  at: string;
}

function toEntry(r: ConsoleRow): ConsoleEntry {
  return {
    level: r.level === 'error' || r.level === 'warn' ? r.level : 'log',
    text: r.text,
    at: r.at,
  };
}

export interface ConsoleScope {
  projectId: string;
  jobId: string;
  /** Which agent owns the job, so the event is attributable. Null is fine. */
  agentId: string | null;
}

export class ConsoleStore {
  #db: Db;
  /** jobId → last entry, for the dedupe window. */
  #last = new Map<string, { level: string; text: string; ts: number }>();

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Record entries and emit one `console` event each.
   *
   * Returns the number actually stored — callers that care can tell when the
   * dedupe swallowed a burst.
   */
  record(scope: ConsoleScope, entries: readonly ConsoleEntry[]): number {
    const insert = this.#db.prepare(
      `INSERT INTO console_entries (job_id, level, text, at) VALUES (?, ?, ?, ?)`,
    );

    let stored = 0;
    for (const entry of entries) {
      const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'log';
      const text = String(entry.text ?? '').slice(0, 8_000);
      if (text.length === 0) continue;

      const now = Date.now();
      const previous = this.#last.get(scope.jobId);
      if (
        previous &&
        previous.level === level &&
        previous.text === text &&
        now - previous.ts < DEDUPE_WINDOW_MS
      ) {
        continue;
      }
      this.#last.set(scope.jobId, { level, text, ts: now });

      const at = isoOr(entry.at, now);
      insert.run(scope.jobId, level, text, at);
      stored += 1;

      eventLog().emit(
        { projectId: scope.projectId, jobId: scope.jobId, agentId: scope.agentId },
        { kind: 'console', level, text },
      );
    }

    if (stored > 0) this.#trim(scope.jobId);
    return stored;
  }

  /** Most recent entries, oldest first — the order the pane renders them in. */
  recent(jobId: string, limit = KEEP_PER_JOB): ConsoleEntry[] {
    const found = rows<ConsoleRow>(
      this.#db
        .prepare(`SELECT * FROM console_entries WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
        .all(jobId, limit),
    );
    return found.reverse().map(toEntry);
  }

  /** Just the errors — what "send to agent" sends when given no explicit list. */
  errors(jobId: string, limit = 40): ConsoleEntry[] {
    const found = rows<ConsoleRow>(
      this.#db
        .prepare(
          `SELECT * FROM console_entries
            WHERE job_id = ? AND level = 'error'
            ORDER BY id DESC LIMIT ?`,
        )
        .all(jobId, limit),
    );
    return found.reverse().map(toEntry);
  }

  count(jobId: string, level?: ConsoleEntry['level']): number {
    const found = level
      ? row<{ n: number }>(
          this.#db
            .prepare(`SELECT COUNT(*) AS n FROM console_entries WHERE job_id = ? AND level = ?`)
            .get(jobId, level),
        )
      : row<{ n: number }>(
          this.#db
            .prepare(`SELECT COUNT(*) AS n FROM console_entries WHERE job_id = ?`)
            .get(jobId),
        );
    return found?.n ?? 0;
  }

  clear(jobId: string): void {
    this.#db.prepare(`DELETE FROM console_entries WHERE job_id = ?`).run(jobId);
    this.#last.delete(jobId);
  }

  #trim(jobId: string): void {
    this.#db
      .prepare(
        `DELETE FROM console_entries
          WHERE job_id = ?
            AND id NOT IN (
              SELECT id FROM console_entries WHERE job_id = ? ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(jobId, jobId, KEEP_PER_JOB);
  }
}

function isoOr(value: unknown, fallbackMs: number): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

/**
 * Turn captured errors into the text of a synthetic user turn.
 *
 * This is the payload behind "one click instead of copy-paste": the agent should
 * receive something it can act on without asking what it is looking at, so the
 * message says where the output came from and what is being asked of it.
 */
export function composeAgentMessage(entries: readonly ConsoleEntry[]): string {
  const errors = entries.filter((e) => e.level === 'error');
  const warnings = entries.filter((e) => e.level === 'warn');
  const body = (errors.length > 0 ? errors : entries).slice(0, 25);

  const lines: string[] = [];
  lines.push(
    `The browser preview is reporting ${describe(errors.length, 'error')}` +
      (warnings.length > 0 ? ` and ${describe(warnings.length, 'warning')}` : '') +
      ` from the running dev server:`,
  );
  lines.push('');
  for (const entry of body) {
    const marker = entry.level === 'error' ? '✗' : entry.level === 'warn' ? '!' : '·';
    lines.push(`${marker} ${entry.text.split('\n')[0] ?? ''}`);
    const rest = entry.text.split('\n').slice(1, 6);
    for (const line of rest) lines.push(`    ${line}`);
  }
  if ((errors.length > 0 ? errors : entries).length > body.length) {
    lines.push(`… and ${(errors.length > 0 ? errors : entries).length - body.length} more`);
  }
  lines.push('');
  lines.push('Please diagnose and fix the cause, then confirm the preview is clean.');
  return lines.join('\n');
}

function describe(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
