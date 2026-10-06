/**
 * The file watcher — turns filesystem noise into `file_edit` events.
 *
 * TRACK C owns this file.
 *
 * The whole difficulty is volume. An agent running a build, a test run or an
 * `npm install` inside the worktree can produce tens of thousands of fs events
 * in a second. The event log is append-only and the browser renders from it, so
 * anything that reaches `emit()` is permanent and visible. Four filters, in
 * increasing cost order, so the expensive one runs on the fewest paths:
 *
 *   1. structural   `.git`, `node_modules`, `.conductor`, build dirs — sync,
 *                   inside chokidar's own matcher so they are never even queued.
 *   2. debounce     per-path quiet period, then one batch. A file saved six
 *                   times while a test watcher reruns is one event, not six.
 *   3. gitignored   one batched `git check-ignore` per flush, not per file.
 *   4. no-op        a path whose +/− against HEAD is unchanged since the last
 *                   emit produces nothing. Formatters that rewrite a file to
 *                   the same bytes are the common case here.
 *
 * Counts are real: `git diff --numstat` against HEAD for tracked files, a line
 * count for untracked ones. A watcher that emitted `added: 1` per event would
 * make the fleet diffstat a lie.
 *
 * A workspace with no git at all (`in_place` in a scratch folder) takes the
 * untracked path for everything — see `#gitlessEdit`.
 */

import { watch, type FSWatcher } from 'chokidar';
import { basename, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import type { FileEditPayload } from '@conductor/shared';
import { eventLog } from '../eventlog.js';
import { isRepo, numstat, status, toPosix } from './git.js';
import { countNewFile, withoutIgnored } from './changes.js';
import type { KeyedLock } from './lock.js';
import type { WorkspaceRecord, WorkspaceStore } from './store.js';
import { relativePosix } from './paths.js';

/** Quiet period before a batch is flushed. Long enough to swallow a save storm. */
const DEBOUNCE_MS = 300;
/** Hard ceiling on a single flush, so a `git checkout` can't write 5k events. */
const MAX_BATCH = 200;

/**
 * Never watched, at any depth. Not merely gitignored — these must be excluded
 * structurally, because the scratch repo (and plenty of real ones) have no
 * .gitignore at all and `node_modules` would drown the log on first install.
 */
const NEVER_WATCH = new Set([
  '.git',
  '.conductor',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  '.gradle',
  '.idea',
  '.DS_Store',
]);

function isStructurallyIgnored(root: string, abs: string): boolean {
  if (abs === root) return false;
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  for (const segment of rel.split(sep)) {
    if (segment.length > 0 && NEVER_WATCH.has(segment)) return true;
  }
  // Editor swap/lock files: written and deleted constantly, never interesting.
  const name = basename(abs);
  if (name.endsWith('~') || name.endsWith('.swp') || name.startsWith('.#')) return true;
  return false;
}

interface Pending {
  path: string;
  deleted: boolean;
}

export class Watcher {
  #ws: WorkspaceRecord;
  #store: WorkspaceStore;
  #lock: KeyedLock;
  #fsw: FSWatcher | null = null;
  #pending = new Map<string, Pending>();
  #timer: NodeJS.Timeout | null = null;
  #ready = false;
  /** Last emitted counts per path — filter 4. */
  #lastEmitted = new Map<string, string>();
  #flushing: Promise<void> = Promise.resolve();

  constructor(ws: WorkspaceRecord, store: WorkspaceStore, lock: KeyedLock) {
    this.#ws = ws;
    this.#store = store;
    this.#lock = lock;
    // Seed filter 4 from the projection so a restart doesn't re-announce every
    // change that was already in the log.
    for (const [path, rec] of store.changes(ws.jobId)) {
      this.#lastEmitted.set(path, `${rec.added}/${rec.removed}/${rec.deleted ? 1 : 0}`);
    }
  }

  get workspace(): WorkspaceRecord {
    return this.#ws;
  }

  get watching(): boolean {
    return this.#fsw !== null;
  }

  start(): void {
    if (this.#fsw) return;
    const root = this.#ws.path;
    if (!existsSync(root)) return;

    this.#fsw = watch(root, {
      ignoreInitial: true,
      // The initial scan is what makes a 40k-file repo expensive to attach to;
      // the tree endpoint reads the current state from git anyway.
      ignored: (p: string) => isStructurallyIgnored(root, p),
      // Wait for writes to settle: an agent's Edit tool truncates then writes,
      // and reading in between yields an empty file and a wrong line count.
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      followSymlinks: false,
      // depth is generous but finite — a runaway symlink loop shouldn't hang us.
      depth: 12,
    });

    const queue = (abs: string, deleted: boolean) => {
      if (!this.#ready) return;
      const rel = relativePosix(root, abs);
      if (rel.length === 0) return;
      this.#pending.set(rel, { path: rel, deleted });
      this.#schedule();
    };

    this.#fsw.on('add', (p) => queue(p, false));
    this.#fsw.on('change', (p) => queue(p, false));
    this.#fsw.on('unlink', (p) => queue(p, true));
    this.#fsw.on('ready', () => {
      this.#ready = true;
    });
    this.#fsw.on('error', (err) => {
      console.error(`[workspace] watcher error in ${root}`, err);
    });
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending.clear();
    const fsw = this.#fsw;
    this.#fsw = null;
    await fsw?.close();
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // Chain flushes so two batches can never interleave their git calls.
      this.#flushing = this.#flushing
        .then(async () => {
          await this.flush();
        })
        .catch((err) => {
          console.error('[workspace] flush failed', err);
        });
    }, DEBOUNCE_MS);
  }

  /** Exposed so tests and the verify script don't have to sleep and hope. */
  async flush(): Promise<FileEditPayload[]> {
    if (this.#pending.size === 0) return [];
    const batch = [...this.#pending.values()].slice(0, MAX_BATCH);
    for (const item of batch) this.#pending.delete(item.path);

    return this.#lock.run(`job:${this.#ws.jobId}`, () => this.#emitBatch(batch));
  }

  /**
   * "This path just changed, look now." Used by `PUT /file` so a human edit
   * appears immediately instead of after the debounce — and, more importantly,
   * so emission stays in ONE place. If the route emitted its own `file_edit`,
   * the watcher's no-op filter wouldn't know about it and would emit a duplicate.
   */
  async touch(relPath: string, deleted = false): Promise<FileEditPayload[]> {
    this.#pending.set(relPath, { path: relPath, deleted });
    return this.flush();
  }

  async #emitBatch(batch: Pending[]): Promise<FileEditPayload[]> {
    const root = this.#ws.path;
    // Filter 3 — one process for the whole batch. Deleted paths can't be
    // check-ignore'd usefully, so they skip it.
    const live = batch.filter((b) => !b.deleted).map((b) => b.path);
    const allowed = new Set(await withoutIgnored(root, live));
    const candidates = batch.filter((b) => b.deleted || allowed.has(b.path));
    if (candidates.length === 0) return [];

    const paths = candidates.map((c) => c.path);
    // One probe per flush, not per path, and the flush is already debounced.
    const gitless = !(await isRepo(root));
    const [stats, entries] = await Promise.all([numstat(root, paths), status(root)]);
    const statByPath = new Map(stats.map((s) => [s.path, s]));
    const entryByPath = new Map(entries.map((e) => [e.path, e]));

    const emitted: FileEditPayload[] = [];

    for (const item of candidates) {
      const path = toPosix(item.path);
      const entry = entryByPath.get(path);

      // With no git, `status` has nothing to say about any path, so the branch
      // below would read every write as "clean again" and the log would stay
      // empty. Nothing here is tracked by definition: a file that exists was
      // created, a file that doesn't was deleted.
      if (gitless) {
        const payload = this.#gitlessEdit(root, item, path);
        if (payload) emitted.push(payload);
        continue;
      }

      // Clean again: an agent wrote the file back to its committed contents.
      // Worth one event (so the badge clears) and only one.
      if (!entry && !statByPath.has(path)) {
        if (this.#lastEmitted.has(path)) {
          this.#lastEmitted.delete(path);
          emitted.push(this.#emit({ kind: 'file_edit', path, added: 0, removed: 0 }));
        }
        continue;
      }

      let added = 0;
      let removed = 0;
      let created = false;
      const deleted = item.deleted || (entry?.deleted ?? false);

      if (deleted) {
        removed = statByPath.get(path)?.removed ?? 0;
      } else if (entry?.untracked) {
        added = countNewFile(join(root, ...item.path.split('/'))).lines;
        created = true;
      } else {
        const stat = statByPath.get(path);
        added = stat?.added ?? 0;
        removed = stat?.removed ?? 0;
        created = entry?.code.startsWith('A') ?? false;
      }

      // Filter 4 — identical counts mean nothing the UI would render differently.
      const fingerprint = `${added}/${removed}/${deleted ? 1 : 0}`;
      if (this.#lastEmitted.get(path) === fingerprint) continue;
      this.#lastEmitted.set(path, fingerprint);

      const payload: FileEditPayload = { kind: 'file_edit', path, added, removed };
      if (created) payload.created = true;
      if (deleted) payload.deleted = true;
      emitted.push(this.#emit(payload));
    }

    return emitted;
  }

  /**
   * One path's `file_edit` in a workspace with no git.
   *
   * The counts are as real as the tracked case — `countNewFile` reads the bytes,
   * the same call the tracked path uses for untracked files. What's missing is a
   * baseline: every write reports the file's current length as `added`, because
   * without a commit there is nothing it could be a delta from. A deletion
   * reports the last length the log knew, which is the same thing
   * `git diff --numstat` would have said.
   *
   * Filter 4 still applies, so a formatter rewriting a file to the same length
   * stays out of the log.
   */
  #gitlessEdit(root: string, item: Pending, path: string): FileEditPayload | null {
    const abs = join(root, ...item.path.split('/'));
    const gone = item.deleted || !existsSync(abs);

    let added = 0;
    let removed = 0;
    if (gone) {
      removed = this.#store.change(this.#ws.jobId, path)?.added ?? 0;
    } else {
      added = countNewFile(abs).lines;
    }

    const fingerprint = `${added}/${removed}/${gone ? 1 : 0}`;
    if (this.#lastEmitted.get(path) === fingerprint) return null;
    this.#lastEmitted.set(path, fingerprint);

    const payload: FileEditPayload = { kind: 'file_edit', path, added, removed };
    if (gone) payload.deleted = true;
    else payload.created = true;
    return this.#emit(payload);
  }

  /**
   * The watcher cannot know which agent wrote the file — it only sees bytes
   * landing. So agentId is recovered from the log (a PostToolUse `file_edit`
   * from Track A for the same path, if there is one) and is null otherwise.
   * Projection into `file_changes` is done by the subscriber in service.ts, so
   * Track A's own file_edit events are projected on exactly the same path.
   */
  #emit(payload: FileEditPayload): FileEditPayload {
    const attributed = this.#store.lastAgentFor(this.#ws.jobId, payload.path);
    eventLog().emit(
      { projectId: this.#ws.projectId, jobId: this.#ws.jobId, agentId: attributed },
      payload,
    );
    return payload;
  }
}
