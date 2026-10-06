/**
 * Workspace persistence — the `workspaces` row and the file-change projection.
 *
 * TRACK C owns this file. Schema in db/migrations/030_workspace.sql.
 *
 * Two things live here and they are different in kind:
 *
 *  • `workspaces` is bookkeeping the daemon owns: where a job's worktree is,
 *    what branch it's on, what commit it was cut from. Needed to survive a
 *    restart so watchers can be re-attached without re-running `worktree add`.
 *
 *  • `file_changes` is a PROJECTION of `file_edit` events. Never the source of
 *    truth for line counts — those come from git at read time, so the UI can't
 *    show a stale +18/−4 after a revert. It answers only "when, and by whom",
 *    which git has no opinion about. `rebuildFileChanges()` proves the point:
 *    the whole table regenerates from the log.
 */

import type { Event, Isolation } from '@conductor/shared';
import { row, rows, tx, type Db } from '../db/index.js';

export interface WorkspaceRecord {
  jobId: string;
  projectId: string;
  repoPath: string;
  path: string;
  branch: string;
  isolation: Isolation;
  baseRef: string | null;
  createdAt: string;
  removedAt: string | null;
}

export interface FileChangeRecord {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  at: string;
  byAgentId: string | null;
  seq: number;
}

interface WorkspaceRow {
  job_id: string;
  project_id: string;
  repo_path: string;
  path: string;
  branch: string;
  isolation: string;
  base_ref: string | null;
  created_at: string;
  removed_at: string | null;
}

interface FileChangeRow {
  path: string;
  added: number;
  removed: number;
  created: number;
  deleted: number;
  at: string;
  by_agent_id: string | null;
  seq: number;
}

function toWorkspace(r: WorkspaceRow): WorkspaceRecord {
  return {
    jobId: r.job_id,
    projectId: r.project_id,
    repoPath: r.repo_path,
    path: r.path,
    branch: r.branch,
    isolation: r.isolation as Isolation,
    baseRef: r.base_ref,
    createdAt: r.created_at,
    removedAt: r.removed_at,
  };
}

function toFileChange(r: FileChangeRow): FileChangeRecord {
  return {
    path: r.path,
    added: r.added,
    removed: r.removed,
    created: r.created === 1,
    deleted: r.deleted === 1,
    at: r.at,
    byAgentId: r.by_agent_id,
    seq: r.seq,
  };
}

export class WorkspaceStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ── workspaces ───────────────────────────────────────────────────────────

  upsert(w: WorkspaceRecord): void {
    this.#db
      .prepare(
        `INSERT INTO workspaces
           (job_id, project_id, repo_path, path, branch, isolation, base_ref, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(job_id) DO UPDATE SET
           project_id = excluded.project_id,
           repo_path  = excluded.repo_path,
           path       = excluded.path,
           branch     = excluded.branch,
           isolation  = excluded.isolation,
           base_ref   = excluded.base_ref,
           removed_at = NULL`,
      )
      .run(
        w.jobId,
        w.projectId,
        w.repoPath,
        w.path,
        w.branch,
        w.isolation,
        w.baseRef,
        w.createdAt,
      );
  }

  markRemoved(jobId: string, at: string): void {
    this.#db.prepare(`UPDATE workspaces SET removed_at = ? WHERE job_id = ?`).run(at, jobId);
  }

  /**
   * Delete a job's bookkeeping outright — the rows, not a `removed_at` stamp.
   *
   * `markRemoved` is for a worktree that was deleted from disk: the row stays
   * because the event log still points at it. This is the opposite case. The
   * human asked Conductor to forget a project and the directory is untouched, so
   * a row reading `removed_at` would assert something false about the
   * filesystem, and the event log it was protecting is going unreferenced
   * anyway. Nothing left behind is more honest than a wrong flag.
   */
  forget(jobId: string): void {
    tx(this.#db, () => {
      this.#db.prepare(`DELETE FROM file_changes WHERE job_id = ?`).run(jobId);
      this.#db.prepare(`DELETE FROM workspaces WHERE job_id = ?`).run(jobId);
    });
  }

  /**
   * Every workspace a project ever had, removed ones included.
   *
   * `listLive()` is right for everything that means "what is open", and wrong for
   * cleaning up: a workspace closed through `DELETE /api/workspaces/:jobId` keeps its
   * row with `removed_at` set, and a project removal that swept only live rows left
   * that row — and its `file_changes` — pointing at a project that no longer exists.
   */
  forProject(projectId: string): WorkspaceRecord[] {
    return rows<WorkspaceRow>(
      this.#db.prepare(`SELECT * FROM workspaces WHERE project_id = ?`).all(projectId),
    ).map(toWorkspace);
  }

  /**
   * Drop removed workspaces whose job no longer exists. Returns how many.
   *
   * Nothing can reach these: they are not live, so `unclaimed()` never publishes
   * them, and no job or project row leads to them. Live job-less rows are NOT
   * touched — those are the bootstrap workspaces the snapshot publishes on purpose.
   */
  sweepOrphans(): number {
    return tx(this.#db, () => {
      const orphan = `SELECT job_id FROM workspaces w
                        WHERE w.removed_at IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = w.job_id)`;
      this.#db.prepare(`DELETE FROM file_changes WHERE job_id IN (${orphan})`).run();
      return Number(this.#db.prepare(`DELETE FROM workspaces WHERE job_id IN (${orphan})`).run().changes);
    });
  }

  get(jobId: string): WorkspaceRecord | undefined {
    const r = row<WorkspaceRow>(
      this.#db.prepare(`SELECT * FROM workspaces WHERE job_id = ?`).get(jobId),
    );
    return r ? toWorkspace(r) : undefined;
  }

  /** Live workspaces, newest first. The dev bootstrap and the UI's picker read this. */
  listLive(): WorkspaceRecord[] {
    return rows<WorkspaceRow>(
      this.#db
        .prepare(`SELECT * FROM workspaces WHERE removed_at IS NULL ORDER BY created_at DESC`)
        .all(),
    ).map(toWorkspace);
  }

  /**
   * Live workspaces that no `jobs` row describes — i.e. the bootstrap ones.
   *
   * This is what the snapshot contributor publishes. Excluding workspaces that
   * Track A already owns means the two contributors cannot collide on an id at
   * all, rather than relying on registration order to decide a winner. Amendment
   * 2 made later contributors win on a genuine collision, which is the right
   * default — but "no collision by construction" is better than a right default.
   */
  unclaimed(): WorkspaceRecord[] {
    return rows<WorkspaceRow>(
      this.#db
        .prepare(
          `SELECT w.* FROM workspaces w
            WHERE w.removed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = w.job_id)
            ORDER BY w.created_at DESC`,
        )
        .all(),
    ).map(toWorkspace);
  }

  /** Does Track A already have a project row for this id? Read-only, as ever. */
  hasProject(projectId: string): boolean {
    return (
      row<{ n: number }>(
        this.#db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`).get(projectId),
      )?.n ?? 0
    ) > 0;
  }

  /**
   * Last-resort resolution for a job whose workspace row is missing: Track A
   * wrote the jobs row itself. Reading another track's table is fine; writing
   * it is not, and this never does.
   */
  jobWorktree(jobId: string): { path: string; branch: string; projectId: string } | undefined {
    const r = row<{ worktree_path: string; branch: string; project_id: string }>(
      this.#db
        .prepare(`SELECT worktree_path, branch, project_id FROM jobs WHERE id = ?`)
        .get(jobId),
    );
    return r
      ? { path: r.worktree_path, branch: r.branch, projectId: r.project_id }
      : undefined;
  }

  // ── file_changes ─────────────────────────────────────────────────────────

  /**
   * Project one file_edit event.
   *
   * Amendment 9. This used to be a plain last-writer-wins upsert, which was only
   * correct by accident of timing: Track A emits from `PostToolUse` immediately,
   * Track C's watcher fires after a debounce and `awaitWriteFinish`, so the
   * authoritative count *usually* landed second and won. A slow watcher, a fast
   * re-edit, or a watcher past its cap would have left an estimate on screen with
   * nothing to contradict it.
   *
   * Now the precedence is explicit rather than incidental: a `'tool'`-sourced
   * event may CREATE a row (so `in_place` jobs and past-the-cap worktrees still
   * get numbers) but never overwrites counts on an existing one. Watcher events
   * always overwrite. Attribution and timestamps update from either source, since
   * only the tool channel knows who wrote.
   */
  recordEdit(e: Event): void {
    if (e.payload.kind !== 'file_edit') return;
    const p = e.payload;
    const isEstimate = p.source === 'tool' ? 1 : 0;
    this.#db
      .prepare(
        `INSERT INTO file_changes
           (job_id, path, added, removed, created, deleted, at, by_agent_id, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, path) DO UPDATE SET
           -- An estimate never overwrites counts already on the row; the
           -- authoritative watcher event always does.
           added   = CASE WHEN ? = 1 THEN file_changes.added   ELSE excluded.added   END,
           removed = CASE WHEN ? = 1 THEN file_changes.removed ELSE excluded.removed END,
           -- "created" is sticky: a file created this session stays created even
           -- once later edits stop mentioning it.
           created = MAX(file_changes.created, excluded.created),
           deleted = CASE WHEN ? = 1 THEN file_changes.deleted ELSE excluded.deleted END,
           at      = excluded.at,
           -- Don't let an anonymous watcher edit erase a known author.
           by_agent_id = COALESCE(excluded.by_agent_id, file_changes.by_agent_id),
           seq     = excluded.seq`,
      )
      .run(
        e.jobId,
        p.path,
        p.added,
        p.removed,
        p.created ? 1 : 0,
        p.deleted ? 1 : 0,
        e.ts,
        e.agentId,
        e.seq,
        isEstimate,
        isEstimate,
        isEstimate,
      );
  }

  changes(jobId: string): Map<string, FileChangeRecord> {
    const list = rows<FileChangeRow>(
      this.#db.prepare(`SELECT * FROM file_changes WHERE job_id = ?`).all(jobId),
    ).map(toFileChange);
    return new Map(list.map((c) => [c.path, c]));
  }

  change(jobId: string, path: string): FileChangeRecord | undefined {
    const r = row<FileChangeRow>(
      this.#db.prepare(`SELECT * FROM file_changes WHERE job_id = ? AND path = ?`).get(jobId, path),
    );
    return r ? toFileChange(r) : undefined;
  }

  /**
   * Regenerate the whole projection from the event log. Cheap, idempotent, and
   * the standing proof that this table is derived and not authoritative.
   */
  rebuildFileChanges(jobId: string): number {
    const evts = rows<{ seq: number; ts: string; agent_id: string | null; payload: string }>(
      this.#db
        .prepare(
          `SELECT seq, ts, agent_id, payload FROM events
            WHERE job_id = ? AND kind = 'file_edit' ORDER BY seq ASC`,
        )
        .all(jobId),
    );
    this.#db.prepare(`DELETE FROM file_changes WHERE job_id = ?`).run(jobId);
    for (const r of evts) {
      this.recordEdit({
        seq: r.seq,
        ts: r.ts,
        projectId: '',
        jobId,
        agentId: r.agent_id,
        payload: JSON.parse(r.payload) as Event['payload'],
      });
    }
    return evts.length;
  }

  /**
   * Who most plausibly wrote this path, when the watcher couldn't say.
   * Derived from the log: the newest agent-attributed file_edit for the path.
   */
  lastAgentFor(jobId: string, path: string): string | null {
    const r = row<{ agent_id: string | null }>(
      this.#db
        .prepare(
          `SELECT agent_id FROM events
            WHERE job_id = ? AND kind = 'file_edit' AND agent_id IS NOT NULL
              AND json_extract(payload, '$.path') = ?
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(jobId, path),
    );
    return r?.agent_id ?? null;
  }
}
