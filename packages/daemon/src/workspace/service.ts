/**
 * The workspace service — one object the route file talks to.
 *
 * TRACK C owns this file.
 *
 * Wiring order matters and is all here: the store, the per-worktree lock,
 * WorktreeMgr, the watchers, and the one subscriber that projects every
 * `file_edit` event into `file_changes` — including the ones Track A's
 * PostToolUse hook emits, which is how a change gets attributed to an agent.
 *
 * Everything that reads or writes a path goes through paths.ts first. There is
 * no second door: the route file has no `fs` import at all.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type {
  DiffResponse,
  FileContentResponse,
  FileTreeResponse,
  Isolation,
  Job,
  Project,
  Snapshot,
} from '@conductor/shared';
import { registerSnapshotContributor } from '../hub.js';
import { getProject } from '../session/store.js';
import { eventLog } from '../eventlog.js';
import { openDb, type Db } from '../db/index.js';
import { KeyedLock } from './lock.js';
import { WorkspaceStore, type WorkspaceRecord } from './store.js';
import { NO_GIT_BRANCH, WorktreeMgr, type EnsureRequest } from './worktree.js';
import { Watcher } from './watcher.js';
import { canonicalRoot, relativePosix, resolveForRead, resolveForWrite } from './paths.js';
import { MAX_TEXT_BYTES, looksBinary, scanChanges } from './changes.js';
import { buildTree } from './tree.js';
import { isMarkdown, renderMarkdown } from './markdown.js';
import { diff as gitDiff, diffUntracked, isRepo, readBlob, status, storedCopy } from './git.js';

/** Open watchers cost file descriptors. Past this, new jobs read without watching. */
const MAX_WATCHERS = 24;

/**
 * The image types the Files pane can show, and the only extensions
 * `/api/jobs/:jobId/image` will serve.
 *
 * An allowlist rather than a lookup over every known MIME type: this map IS the
 * feature's boundary, so adding a row is a deliberate act. SVG is included because
 * agents write diagrams, and the route neutralizes it with `nosniff` and a null CSP
 * rather than leaving script-in-XML to chance.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

/** Images get a larger ceiling than text: a screenshot is legitimately big. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Carries the HTTP status so the route layer stays a thin translation. */
export class WorkspaceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

/**
 * A project directory's stand-in record (Amendment 39). The ops below were written
 * against a job's workspace; a directory is read the same way, only never watched and
 * never recorded — `jobId` is a key no `file_changes` row carries, so every lookup by
 * it is simply empty. That is what makes it safe to share the code rather than copy it.
 */
const DIR_KEY = 'dir:';

export class WorkspaceService {
  #db: Db;
  #store: WorkspaceStore;
  #lock = new KeyedLock();
  #mgr: WorktreeMgr;
  #watchers = new Map<string, Watcher>();
  #unsubscribe: (() => void) | null = null;

  constructor(db: Db) {
    this.#db = db;
    this.#store = new WorkspaceStore(db);
    this.#mgr = new WorktreeMgr(this.#store, this.#lock);
  }

  get worktrees(): WorktreeMgr {
    return this.#mgr;
  }

  get store(): WorkspaceStore {
    return this.#store;
  }

  /**
   * Called once at boot from routes/workspace.ts (the auto-registration seam —
   * daemon/src/index.ts is W0's and is not edited).
   */
  start(): void {
    // Project EVERY file_edit event, whoever emitted it. Track A's PostToolUse
    // hook is the only source that knows which agent wrote a file; this is where
    // that attribution enters the workspace view.
    this.#unsubscribe = eventLog().subscribe((e) => {
      if (e.payload.kind !== 'file_edit') return;
      try {
        this.#store.recordEdit(e);
      } catch (err) {
        console.error('[workspace] projecting file_edit failed', err);
      }
    });

    const swept = this.#store.sweepOrphans();
    if (swept > 0) console.log(`[workspace] dropped ${swept} removed workspace(s) left by a deleted job`);

    // Re-attach watchers after a restart. The worktrees are still on disk and
    // agents may still be writing to them.
    for (const ws of this.#store.listLive()) {
      try {
        this.#watcherFor(ws);
      } catch (err) {
        console.error(`[workspace] could not watch ${ws.path}`, err);
      }
    }

    // Amendment 2: contributors compose, so this publishes the workspaces this
    // track actually knows about instead of the defensive no-op it used to.
    registerSnapshotContributor(() => this.snapshotSlice());
  }

  /**
   * The workspace slice of a fresh page load.
   *
   * Publishes only workspaces that no `jobs` row describes — the ones this
   * track's bootstrap endpoint created. Anything Track A owns is left to Track A,
   * so the two slices cannot collide on an id even if registration order changes.
   *
   * Nothing is invented to fill the gaps: a bootstrap workspace had no human
   * instruction, so `prompt` is empty rather than a fabricated sentence, and its
   * status is 'queued' because a prepared worktree with no agents in it is
   * precisely a job waiting to start.
   */
  snapshotSlice(): Partial<Snapshot> {
    const unclaimed = this.#store.unclaimed();
    if (unclaimed.length === 0) return {};

    const jobs: Job[] = unclaimed.map((ws) => ({
      id: ws.jobId,
      projectId: ws.projectId,
      prompt: '',
      isolation: ws.isolation,
      worktreePath: ws.path,
      branch: ws.branch,
      status: 'queued',
      createdAt: ws.createdAt,
      endedAt: null,
      budgetUsd: null,
    }));

    // A job referencing a project nobody published would leave the Fleet screen
    // with a card it can't name, so publish the project too — from real data.
    const projects: Project[] = [];
    const seen = new Set<string>();
    for (const ws of unclaimed) {
      if (seen.has(ws.projectId) || this.#store.hasProject(ws.projectId)) continue;
      seen.add(ws.projectId);
      projects.push({
        id: ws.projectId,
        name: basename(ws.repoPath) || ws.projectId,
        path: ws.repoPath,
        // A project's default branch is a git fact; `(no git)` is a workspace
        // label and doesn't belong in that field. 'main' is the same placeholder
        // Track A's createProject uses for a non-repo path.
        defaultBranch: ws.branch === NO_GIT_BRANCH ? 'main' : ws.branch,
        createdAt: ws.createdAt,
      });
    }

    return projects.length > 0 ? { jobs, projects } : { jobs };
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await Promise.all([...this.#watchers.values()].map((w) => w.stop()));
    this.#watchers.clear();
  }

  // ── workspaces ───────────────────────────────────────────────────────────

  /** Prepare (or reuse) a job's checkout and start watching it. */
  async open(req: EnsureRequest): Promise<WorkspaceRecord> {
    const { workspace } = await this.#mgr.ensure(req);
    this.#watcherFor(workspace);
    return workspace;
  }

  async close(jobId: string, force = false): Promise<{ removed: boolean; reason?: string }> {
    const watcher = this.#watchers.get(jobId);
    if (watcher) {
      await watcher.stop();
      this.#watchers.delete(jobId);
    }
    return this.#mgr.remove(jobId, { force });
  }

  /**
   * Stop tracking a job and TOUCH NOTHING ON DISK.
   *
   * Deliberately not `close()`. That calls `WorktreeMgr.remove`, which for
   * `worktree` isolation runs `git worktree remove` and deletes the directory —
   * correct when a job's checkout is being disposed of, catastrophic when the
   * human only asked Conductor to stop listing a project. So this drops the
   * watcher and the two bookkeeping tables and nothing else: the worktree, its
   * branch and every file stay exactly where they are.
   *
   * Returns the path we walked away from, so the caller can tell the human what
   * is still there rather than leaving them to guess.
   */
  async forget(jobId: string): Promise<{ path: string | null; isolation: Isolation | null }> {
    const known = this.#store.get(jobId);
    const watcher = this.#watchers.get(jobId);
    if (watcher) {
      await watcher.stop();
      this.#watchers.delete(jobId);
    }
    this.#store.forget(jobId);
    return { path: known?.path ?? null, isolation: known?.isolation ?? null };
  }

  /** Forget every workspace a project had, removed ones included. Touches nothing on disk. */
  async forgetProject(projectId: string): Promise<WorkspaceRecord[]> {
    const all = this.#store.forProject(projectId);
    for (const ws of all) await this.forget(ws.jobId);
    return all;
  }

  list(): WorkspaceRecord[] {
    return this.#store.listLive().map((ws) => ({ ...ws }));
  }

  /** Resolve or 404. Every endpoint starts here. */
  resolve(jobId: string): WorkspaceRecord {
    const ws = this.#mgr.resolve(jobId);
    if (!ws) {
      throw new WorkspaceError(
        404,
        `no workspace for job ${jobId} — open one first, or let the session engine create the job`,
      );
    }
    if (ws.removedAt) {
      throw new WorkspaceError(410, `the workspace for job ${jobId} has been removed`);
    }
    return ws;
  }

  #watcherFor(ws: WorkspaceRecord): Watcher | null {
    if (ws.jobId.startsWith(DIR_KEY)) return null;
    const existing = this.#watchers.get(ws.jobId);
    if (existing) return existing;
    if (this.#watchers.size >= MAX_WATCHERS) {
      console.warn(`[workspace] ${MAX_WATCHERS} watchers already open — not watching ${ws.path}`);
      return null;
    }
    const watcher = new Watcher(ws, this.#store, this.#lock);
    this.#watchers.set(ws.jobId, watcher);
    watcher.start();
    return watcher;
  }

  /**
   * A project's directory as something the reads can take (Amendment 39): its path,
   * or one of its other directories, named by absolute path. Never a
   * job's worktree — that is `resolve(jobId)` — so what this shows is the directory
   * as it is on disk.
   */
  dirRoot(projectId: string, dir: string): WorkspaceRecord {
    const project = getProject(this.#db, projectId);
    if (!project) throw new WorkspaceError(404, `no such project ${projectId}`);
    // By path, not by position: a directory removed from the list must not shift a
    // tab that was open in the next one onto a folder it never showed.
    if (![project.path, ...(project.extraDirs ?? [])].includes(dir)) {
      throw new WorkspaceError(404, `${dir} is not one of ${project.name}'s directories`);
    }
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // Falls through to the 410.
    }
    if (!isDir) throw new WorkspaceError(410, `${dir} is not there any more`);
    return {
      jobId: `${DIR_KEY}${projectId}:${dir}`,
      projectId,
      repoPath: dir,
      path: dir,
      branch: '',
      isolation: 'in_place',
      baseRef: null,
      createdAt: project.createdAt,
      removedAt: null,
    };
  }

  /** For the verify script: force a flush instead of waiting out the debounce. */
  async flush(jobId: string): Promise<void> {
    await this.#watchers.get(jobId)?.flush();
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async tree(jobId: string): Promise<FileTreeResponse> {
    return this.treeOf(this.resolve(jobId));
  }

  /** `tree` for any root — a job's worktree, or a project directory from `dirRoot`. */
  async treeOf(ws: WorkspaceRecord): Promise<FileTreeResponse> {
    this.#watcherFor(ws);
    const changes = await scanChanges(ws.path, this.#store.changes(ws.jobId));
    return buildTree(ws.path, basename(ws.path) || ws.branch, changes);
  }

  /**
   * An image's bytes and its MIME type.
   *
   * Containment is `resolveForRead`, exactly as for text — this route reaches the
   * filesystem, so it gets the same gate and no second implementation of it.
   *
   * The extension decides the type, and an unknown extension is a 415 rather than
   * `application/octet-stream`. Sniffing content to decide would mean this route
   * could serve anything with the right leading bytes, which is how a "view images"
   * feature quietly becomes "download any file".
   */
  async image(jobId: string, relPath: string): Promise<{ buf: Buffer; mime: string }> {
    return this.imageOf(this.resolve(jobId), relPath);
  }

  async imageOf(ws: WorkspaceRecord, relPath: string): Promise<{ buf: Buffer; mime: string }> {
    const abs = resolveForRead(ws.path, relPath);
    const mime = IMAGE_TYPES[extname(abs).toLowerCase()];
    if (!mime) {
      throw new WorkspaceError(415, `${relPath} is not an image this pane can show`);
    }

    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new WorkspaceError(404, `${relPath} does not exist in this worktree`);
    }
    if (st.isDirectory()) throw new WorkspaceError(400, `${relPath} is a directory`);
    if (st.size > MAX_IMAGE_BYTES) {
      throw new WorkspaceError(
        413,
        `${relPath} is ${(st.size / 1024 / 1024).toFixed(1)} MB — too large to show in the pane`,
      );
    }

    return { buf: readFileSync(abs), mime };
  }

  async file(jobId: string, relPath: string): Promise<FileContentResponse> {
    return this.fileOf(this.resolve(jobId), relPath);
  }

  async fileOf(ws: WorkspaceRecord, relPath: string): Promise<FileContentResponse> {
    this.#watcherFor(ws);
    const abs = resolveForRead(ws.path, relPath);
    const path = relativePosix(ws.path, abs);

    let st;
    try {
      st = statSync(abs);
    } catch {
      return this.#goneFile(ws, relPath, path, abs);
    }
    if (st.isDirectory()) throw new WorkspaceError(400, `${relPath} is a directory`);
    if (st.size > MAX_TEXT_BYTES) {
      throw new WorkspaceError(
        413,
        `${relPath} is ${(st.size / 1024 / 1024).toFixed(1)} MB — too large to open in the pane`,
      );
    }

    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      throw new WorkspaceError(415, `${relPath} looks binary — nothing useful to render`);
    }
    return this.#fileResponse(ws, path, buf.toString('utf8'));
  }

  /**
   * A path the tree lists and the disk doesn't have. Neither way that happens is
   * "not found" to the person who just clicked it in the tree:
   *
   *  • An agent deleted it. The tree keeps it because a deletion is a change to
   *    review (tree.ts), so it opens as git's last copy, marked `deleted` so the
   *    pane says so rather than passing it off as the file on disk (Amendment 29).
   *  • It is a symlink to nothing. `ls-files` lists the link and `stat` follows it
   *    into nothing, so where it points is the useful part.
   */
  async #goneFile(
    ws: WorkspaceRecord,
    relPath: string,
    path: string,
    abs: string,
  ): Promise<FileContentResponse> {
    const target = danglingTarget(abs);
    if (target !== null) {
      throw new WorkspaceError(404, `${relPath} is a link to ${target}, which isn't there`);
    }

    const entry = (await status(ws.path)).find((e) => e.path === path);
    const copy = entry?.deleted ? await storedCopy(ws.path, path) : null;
    if (!copy) {
      if (entry?.deleted || this.#store.change(ws.jobId, path)?.deleted) {
        throw new WorkspaceError(404, `${relPath} was deleted, and git has no copy of it to show`);
      }
      throw new WorkspaceError(404, `${relPath} does not exist in this worktree`);
    }
    if (copy.size > MAX_TEXT_BYTES) {
      throw new WorkspaceError(
        413,
        `${relPath} was deleted, and its last copy is ${(copy.size / 1024 / 1024).toFixed(1)} MB — too large to open in the pane`,
      );
    }
    const raw = await readBlob(ws.path, copy.spec);
    if (looksBinary(Buffer.from(raw, 'utf8'))) {
      throw new WorkspaceError(415, `${relPath} was deleted, and it was binary — nothing useful to render`);
    }
    return this.#fileResponse(ws, path, raw, true);
  }

  async #fileResponse(
    ws: WorkspaceRecord,
    path: string,
    raw: string,
    deleted = false,
  ): Promise<FileContentResponse> {
    const res: FileContentResponse = { path, raw };
    if (deleted) res.deleted = true;

    if (isMarkdown(path)) res.html = renderMarkdown(raw).html;

    const fileDiff = await this.#diffForPath(ws, path);
    if (fileDiff.length > 0) res.diff = fileDiff;

    const change = this.#store.change(ws.jobId, path);
    if (change) {
      res.lastWriteAt = change.at;
      const by = change.byAgentId ?? this.#store.lastAgentFor(ws.jobId, path);
      if (by) res.lastWriteBy = by;
    }
    return res;
  }

  async diff(jobId: string, relPath?: string): Promise<DiffResponse> {
    return this.diffOf(this.resolve(jobId), relPath);
  }

  async diffOf(ws: WorkspaceRecord, relPath?: string): Promise<DiffResponse> {
    const changes = await scanChanges(ws.path, this.#store.changes(ws.jobId));

    if (relPath) {
      // Validate even though only git reads it: an unchecked path here is
      // `git diff ../../../etc/passwd` and an information leak.
      const abs = resolveForRead(ws.path, relPath);
      const path = relativePosix(ws.path, abs);
      const change = changes.byPath.get(path);
      return {
        diff: await this.#diffForPath(ws, path),
        added: change?.added ?? 0,
        removed: change?.removed ?? 0,
        files: change ? 1 : 0,
      };
    }

    const tracked = await gitDiff(ws.path);
    const untracked: string[] = [];
    for (const change of changes.byPath.values()) {
      if (!change.created || change.binary) continue;
      // Only genuinely untracked files need synthesising; staged-new files are
      // already in `git diff HEAD`.
      if (change.deleted) continue;
      const patch = await this.#untrackedPatch(ws, change.path);
      if (patch) untracked.push(patch);
    }

    return {
      diff: [tracked, ...untracked].filter((s) => s.length > 0).join(''),
      added: changes.added,
      removed: changes.removed,
      files: changes.files,
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Write a file back into the worktree. Under the worktree lock, and atomic —
   * a partial file is worse than a failed write, and an agent may be reading
   * this path in the same instant.
   */
  async write(jobId: string, relPath: string, content: string): Promise<FileContentResponse> {
    return this.writeOf(this.resolve(jobId), relPath, content);
  }

  /**
   * `write` for any root. A project directory is locked on its path rather than a
   * job, and nothing watches it, so no file_edit is emitted: there is no job for one
   * to belong to, and the pane re-reads what it saved.
   */
  async writeOf(ws: WorkspaceRecord, relPath: string, content: string): Promise<FileContentResponse> {
    const { abs } = resolveForWrite(ws.path, relPath);
    const path = relativePosix(ws.path, abs);
    const lockKey = ws.jobId.startsWith(DIR_KEY) ? `dir:${ws.path}` : `job:${ws.jobId}`;

    await this.#lock.run(lockKey, async () => {
      mkdirSync(dirname(abs), { recursive: true });
      // Temp file in the SAME directory, so the rename is atomic (a cross-device
      // rename is a copy, and a copy is not atomic).
      const tmp = join(dirname(abs), `.conductor-write-${process.pid}-${Date.now()}.tmp`);
      try {
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, abs);
      } catch (err) {
        throw new WorkspaceError(
          500,
          `could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // Emission stays with the watcher — see Watcher.touch. A human edit is a
    // file_edit like any other; the only difference is that no agent claims it.
    const watcher = this.#watcherFor(ws);
    if (watcher) await watcher.touch(path);

    return this.fileOf(ws, path);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  async #diffForPath(ws: WorkspaceRecord, path: string): Promise<string> {
    const entries = await status(ws.path);
    const entry = entries.find((e) => e.path === path);
    if (!entry) {
      // `status` is empty for every path when there is no repo, which is not the
      // same as "this file is clean". `--no-index` works outside a repo, so the
      // pane can still show the file as added rather than showing nothing.
      if (!(await isRepo(ws.path))) return (await this.#untrackedPatch(ws, path)) ?? '';
      return '';
    }
    if (entry.untracked) return (await this.#untrackedPatch(ws, path)) ?? '';
    return gitDiff(ws.path, [path]);
  }

  async #untrackedPatch(ws: WorkspaceRecord, path: string): Promise<string | null> {
    try {
      const patch = await diffUntracked(ws.path, path);
      // `--no-index` labels the old side /dev/null, which reads oddly in a UI.
      // Left exactly as git wrote it: a hand-edited patch is one that no longer
      // applies, and "review full diff" has to produce something real.
      return patch.length > 0 ? patch : null;
    } catch {
      return null;
    }
  }
}

/** Where a symlink points when nothing is there. Null for anything that isn't a link. */
function danglingTarget(abs: string): string | null {
  try {
    return lstatSync(abs).isSymbolicLink() ? readlinkSync(abs) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton — same shape as eventLog()/hub() so it reads the same at call sites
// ─────────────────────────────────────────────────────────────────────────────

let instance: WorkspaceService | null = null;

export function initWorkspace(db: Db = openDb()): WorkspaceService {
  if (instance) return instance;
  instance = new WorkspaceService(db);
  instance.start();
  return instance;
}

export function workspace(): WorkspaceService {
  if (!instance) throw new Error('WorkspaceService not initialised — call initWorkspace(db) first');
  return instance;
}

/** Tests only. */
export async function resetWorkspace(): Promise<void> {
  await instance?.stop();
  instance = null;
}

export { canonicalRoot };
export type { Isolation, WorkspaceRecord };
