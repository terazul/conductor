/**
 * git — a thin promise wrapper around the CLI.
 *
 * TRACK C owns this file.
 *
 * Deliberately the CLI and not a library: worktrees, `check-ignore` and
 * `--numstat` are all first-class there, and it's one less dependency for five
 * agents to install. Every call is explicit about its cwd — there is no ambient
 * "current repo", because the daemon is always working in someone else's.
 *
 * All output parsing uses `-z` (NUL-delimited) where git offers it. Paths with
 * spaces are routine and paths with quotes are not impossible; the quoted
 * `core.quotepath` format is a parser waiting to be wrong.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Big enough for a whole-worktree diff; past this the UI wouldn't cope anyway. */
const MAX_BUFFER = 48 * 1024 * 1024;

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly stderr: string;
  /** Kept because some git commands exit non-zero *and* mean it — see diffUntracked. */
  readonly stdout: string;
  readonly code: number | null;
  /** Killed for running past `timeoutMs` (Amendment 109): the remote never answered. */
  readonly timedOut: boolean;

  constructor(
    cwd: string,
    args: string[],
    stderr: string,
    stdout: string,
    code: number | null,
    timedOut = false,
  ) {
    super(
      `git ${args.join(' ')} failed in ${cwd}: ${timedOut ? 'timed out' : stderr.trim() || `exit ${code}`}`,
    );
    this.name = 'GitError';
    this.cwd = cwd;
    this.args = args;
    this.stderr = stderr;
    this.stdout = stdout;
    this.code = code;
    this.timedOut = timedOut;
  }
}

interface ExecFailure {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
}

/** What a call may add: extra environment (merged last) and a time limit. */
export interface GitOptions {
  env?: Record<string, string>;
  /** Kill git after this long; 0 or absent means no limit, as before. */
  timeoutMs?: number;
}

/** Run git, return stdout. Throws GitError on non-zero exit. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return (await gitBoth(cwd, args, opts)).stdout;
}

/**
 * `git`, keeping stderr too: push and fetch say what they did there, not on stdout
 * (Amendment 109).
 */
export async function gitBoth(
  cwd: string,
  args: string[],
  opts: GitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = opts.timeoutMs ?? 0;
  try {
    const { stdout, stderr } = await exec('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout,
      env: {
        ...process.env,
        // Never let a git operation sit waiting for credentials or an editor.
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        // Read-only commands shouldn't fight the agent's own git for the index lock.
        GIT_OPTIONAL_LOCKS: '0',
        ...opts.env,
      },
    });
    return { stdout, stderr };
  } catch (err) {
    const f = err as ExecFailure;
    const stderr = typeof f.stderr === 'string' ? f.stderr : (f.stderr?.toString('utf8') ?? '');
    const stdout = typeof f.stdout === 'string' ? f.stdout : (f.stdout?.toString('utf8') ?? '');
    const timedOut = timeout > 0 && f.killed === true;
    throw new GitError(cwd, args, stderr, stdout, (f.code as number | undefined) ?? null, timedOut);
  }
}

/** Run git, swallow failure. For "is this true?" questions. */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo facts
// ─────────────────────────────────────────────────────────────────────────────

export async function isRepo(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['rev-parse', '--git-dir']);
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** False for a repo with no commits yet — `diff HEAD` would explode. */
export async function hasHead(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
}

export async function currentBranch(cwd: string): Promise<string> {
  const out = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return out === 'HEAD' ? '(detached)' : out;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/**
 * The branch label for a nested repo's folder mark (Amendment 90). Null for a
 * detached HEAD or a repo with no commits yet — "on branch X" would be a guess
 * in both cases, since an unborn HEAD names a branch nothing has been
 * committed to and a detached one names no branch at all. Any other failure
 * (a corrupt or half-cloned nested repo) collapses to null the same way: the
 * folder still has to browse even when git can't say what it's on.
 */
export async function nestedBranch(cwd: string): Promise<string | null> {
  try {
    if (!(await hasHead(cwd))) return null;
    const branch = await currentBranch(cwd);
    return branch === '(detached)' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Tracked + untracked files, with .gitignore already applied by git itself.
 * This is why the tree endpoint doesn't need its own ignore engine.
 */
export async function listFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '-co', '--exclude-standard', '-z']);
  // ls-files can list the same path twice (cached AND other) after some races.
  return [...new Set(splitZ(out))];
}

export interface StatusEntry {
  path: string;
  /** Two-letter porcelain code, e.g. ' M', '??', 'A ', 'D '. */
  code: string;
  untracked: boolean;
  deleted: boolean;
}

/**
 * Dirty paths. Empty for a directory that is not a repo at all — `in_place`
 * isolation is allowed to run there, and every caller of this wants "nothing is
 * dirty" rather than a thrown GitError. Same shape of guard as `numstat` and
 * `diff` use for a repo with no commits yet.
 *
 * `-uall` is load-bearing, not tidiness. By default `git status` collapses a
 * wholly-untracked directory to one entry for the directory — an agent that
 * creates `src/api/client.ts` in a repo with no `src/` yet produces the single
 * record `?? src/`. Every caller here is asking about files: the watcher looks
 * the written path up in this list and, not finding it, reads the write as
 * "clean again" and emits nothing, so the edit never reaches the log; and
 * `scanChanges` takes `src/` for a new file and counts the lines in a directory.
 * Listing untracked files individually is the only reading that matches what
 * these callers mean.
 */
export async function status(cwd: string): Promise<StatusEntry[]> {
  if (!(await isRepo(cwd))) return [];
  // Porcelain paths are from the repository root, whatever the cwd. Everything else
  // here is cwd-relative, so a workspace that is a subdirectory of its repository
  // (an in-place project, or a project's other directory — Amendment 39) keeps only
  // what is under it, with the prefix taken off. At the root the prefix is "".
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).trim();
  const out = await git(cwd, ['status', '--porcelain=v1', '-uall', '-z', '--', '.']);
  const entries: StatusEntry[] = [];
  const records = out.split('\0');

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    const code = rec.slice(0, 2);
    let path = rec.slice(3);
    // Renames/copies emit the source path as the NEXT NUL-delimited record.
    if (code[0] === 'R' || code[0] === 'C') i += 1;
    if (path.length === 0) continue;
    path = toPosix(path);
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    entries.push({
      path,
      code,
      untracked: code === '??',
      deleted: code.includes('D'),
    });
  }
  return entries;
}

export interface NumStat {
  path: string;
  added: number;
  removed: number;
  /** Binary files report '-' for both counts. */
  binary: boolean;
}

/**
 * Line counts against HEAD for tracked files. `-z` because the non-z form
 * quotes unusual paths and the quoting rules are not worth reimplementing.
 *
 * Record shape: `<added>\t<removed>\t<path>\0`, and for a rename the path
 * field is empty with `<from>\0<to>\0` following.
 */
export async function numstat(cwd: string, paths: string[] = []): Promise<NumStat[]> {
  if (!(await hasHead(cwd))) return [];
  // --relative: cwd-relative paths, and only under the cwd — see `status`.
  const args = ['diff', '--numstat', '--relative', '-z', 'HEAD'];
  if (paths.length > 0) args.push('--', ...paths);
  const out = await git(cwd, args);

  const parts = out.split('\0');
  const stats: NumStat[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    const fields = rec.split('\t');
    if (fields.length < 3) continue;
    const [addedRaw, removedRaw, inlinePath] = fields as [string, string, string];
    let path = inlinePath;
    if (path.length === 0) {
      // rename: `from` then `to` follow as their own records. `to` is the path.
      const to = parts[i + 2];
      i += 2;
      if (!to) continue;
      path = to;
    }
    stats.push({
      path: toPosix(path),
      added: addedRaw === '-' ? 0 : Number(addedRaw) || 0,
      removed: removedRaw === '-' ? 0 : Number(removedRaw) || 0,
      binary: addedRaw === '-' && removedRaw === '-',
    });
  }
  return stats;
}

/** Unified diff against HEAD. Empty string when nothing is dirty. */
export async function diff(cwd: string, paths: string[] = []): Promise<string> {
  if (!(await hasHead(cwd))) return '';
  const args = ['diff', '--no-color', '--no-ext-diff', '--relative', 'HEAD'];
  if (paths.length > 0) args.push('--', ...paths);
  return git(cwd, args);
}

/**
 * A diff for a file git has never seen. `--no-index` exits 1 when the files
 * differ, which for us is the success case, so the patch arrives on the error.
 */
export async function diffUntracked(cwd: string, relPath: string): Promise<string> {
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-index',
    '--',
    '/dev/null',
    relPath,
  ];
  try {
    return await git(cwd, args);
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return err.stdout;
    throw err;
  }
}

/**
 * Where git still has a copy of a path that is gone from the worktree: the index,
 * else HEAD. The index comes first because it is the later of the two — a file
 * staged and then deleted has no HEAD copy at all. `./` makes the path relative to
 * `cwd`, which matters for a workspace that is a subdirectory of its repository.
 */
export async function storedCopy(
  cwd: string,
  relPath: string,
): Promise<{ spec: string; size: number } | null> {
  for (const spec of [`:./${relPath}`, `HEAD:./${relPath}`]) {
    try {
      const size = Number((await git(cwd, ['cat-file', '-s', spec])).trim());
      if (Number.isFinite(size)) return { spec, size };
    } catch {
      // Not in this one.
    }
  }
  return null;
}

/** A blob's bytes as text. `cat-file`, not `show`, so no textconv filter rewrites it. */
export async function readBlob(cwd: string, spec: string): Promise<string> {
  return git(cwd, ['cat-file', 'blob', spec]);
}

/** Which of these paths does .gitignore exclude? Batched — one process, not N. */
export async function checkIgnore(cwd: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  return new Promise<Set<string>>((resolvePromise) => {
    const child = execFile(
      'git',
      ['check-ignore', '--stdin', '-z'],
      { cwd, maxBuffer: MAX_BUFFER },
      // exit 1 simply means "none of them were ignored".
      (_err, stdout) => {
        const text = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        resolvePromise(new Set(splitZ(text).map(toPosix)));
      },
    );
    child.stdin?.end(paths.join('\0'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktrees
// ─────────────────────────────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice(9), branch: null, head: null, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** POSIX separators everywhere on the wire, whatever the host filesystem uses. */
export function toPosix(p: string): string {
  return p.split('\\').join('/');
}
