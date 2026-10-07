/**
 * Track C verification — the workspace slice, end to end, against a real repo.
 *
 * TRACK C owns this file. It does not touch W0's smoke test.
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/workspace/verify.ts
 *
 * Prerequisite: bash fixtures/make-scratch-repo.sh
 *
 * Proves the things the track is judged on, in the order a human would try them:
 * browse the tree, see the dirty file flagged and the untracked file marked
 * created, read docs/PLAN.md rendered, view its diff, edit it in place. Then the
 * parts a human can't see: worktree create/reuse/remove, the three isolations,
 * the watcher's real line counts, nested repos browsing all the way down
 * (Amendment 90), and every path-escape I could think of.
 *
 * Note on isolation and the fixture: the scratch repo's dirt lives in its MAIN
 * checkout. `git worktree add` produces a clean checkout at HEAD, so the "dirty
 * file flagged" assertions necessarily run against `in_place` isolation — that
 * is not a shortcut, it's what the isolation means.
 *
 * If you interrupt this script mid-run — piping it into `head`/`sed` and killing
 * the reader will do it — the Fastify listener is never closed and the next run
 * dies with EADDRINUSE on 7801:
 *
 *   lsof -ti :7801 | xargs kill -9
 *
 * Otherwise it is rerunnable: it prunes worktrees a previous run left behind and
 * restores every fixture file it edits.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import type {
  DiffResponse,
  Event,
  FileContentResponse,
  FileNode,
  FileTreeResponse,
  Snapshot,
} from '@conductor/shared';
import { build } from '../index.js';
import { eventLog } from '../eventlog.js';
import { openDb } from '../db/index.js';
import { registerSnapshotContributor } from '../hub.js';
import { workspace } from './service.js';
import { type CompleteResult } from './browse.js';
import { renderMarkdown, type RenderedMarkdown } from './markdown.js';
import { KeyedLock } from './lock.js';
import { buildTree } from './tree.js';
import { scanChanges } from './changes.js';
import type { WorkspaceRecord } from './store.js';

const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = resolve(HERE, '../../../../fixtures/scratch-repo');

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

function flatten(node: FileNode, out: FileNode[] = []): FileNode[] {
  out.push(node);
  for (const kid of node.children ?? []) flatten(kid, out);
  return out;
}

function find(tree: FileTreeResponse, path: string): FileNode | undefined {
  return flatten(tree.root).find((n) => n.path === path);
}

/** Events of one kind for a job, newest last. */
function eventsFor(jobId: string, kind: Event['payload']['kind']): Event[] {
  return eventLog()
    .forJob(jobId)
    .filter((e) => e.payload.kind === kind);
}

/**
 * Let the watcher notice, then force the batch out.
 *
 * The wait is not slack in the test: chokidar's `awaitWriteFinish` deliberately
 * holds an event back until the file has stopped changing, because an agent's
 * Edit tool truncates before it writes and a diff taken in between reports a
 * wrong line count. Flushing without the wait would test nothing.
 */
async function settleAndFlush(jobId: string, ms = 600): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await workspace().flush(jobId);
}

/**
 * Poll until every path has produced a file_edit, rather than sleeping a magic
 * number. Two recursive watchers over overlapping trees make delivery latency
 * genuinely variable, and a fixed sleep turns that into a flaky test.
 */
async function waitForEdits(
  jobId: string,
  paths: string[],
  opts: { afterSeq?: number; timeoutMs?: number } = {},
): Promise<Map<string, Event>> {
  const afterSeq = opts.afterSeq ?? 0;
  const deadline = Date.now() + (opts.timeoutMs ?? 6_000);
  for (;;) {
    await workspace().flush(jobId);
    const found = new Map<string, Event>();
    for (const e of eventsFor(jobId, 'file_edit')) {
      if (e.seq <= afterSeq) continue;
      if (e.payload.kind === 'file_edit' && paths.includes(e.payload.path)) {
        found.set(e.payload.path, e);
      }
    }
    if (found.size === paths.length || Date.now() > deadline) return found;
    await new Promise((r) => setTimeout(r, 75));
  }
}

async function main(): Promise<void> {
  if (!existsSync(SCRATCH)) {
    console.error(`\nscratch repo missing at ${SCRATCH}\n  run: bash fixtures/make-scratch-repo.sh\n`);
    process.exit(1);
  }

  process.env['CONDUCTOR_DB'] = join(tmpdir(), `conductor-workspace-verify-${Date.now()}.db`);
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  // Rerunnable: clear worktrees a previous run left behind.
  rmSync(join(SCRATCH, '.conductor'), { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: SCRATCH });

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · open a workspace (in_place — where the fixture is dirty)');
  const opened = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_inplace',
    projectId: 'prj_scratch',
    repoPath: SCRATCH,
    isolation: 'in_place',
  });
  check('POST /api/workspaces → 201', opened.status === 201, `got ${opened.status}`);
  check('isolation recorded', opened.body.workspace?.isolation === 'in_place');
  check('branch detected', opened.body.workspace?.branch === 'main', opened.body.workspace?.branch);
  check(
    'worktree event emitted',
    eventsFor('job_inplace', 'worktree').length === 1,
    `${eventsFor('job_inplace', 'worktree').length} events`,
  );

  const listed = await get<{ workspaces: WorkspaceRecord[] }>('/api/workspaces');
  check('GET /api/workspaces lists it', listed.body.workspaces.some((w) => w.jobId === 'job_inplace'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · browse the tree, with change badges');
  const tree = await get<FileTreeResponse>('/api/jobs/job_inplace/tree');
  check('GET tree → 200', tree.status === 200, JSON.stringify(tree.body).slice(0, 160));

  const plan = find(tree.body, 'docs/PLAN.md');
  const token = find(tree.body, 'src/token.js');
  const refresh = find(tree.body, 'src/refresh.js');

  check('docs/PLAN.md present, nested under docs/', plan !== undefined && plan.type === 'file');
  check('docs/ is a directory node', find(tree.body, 'docs')?.type === 'dir');
  check('clean file carries no badge', plan?.change === undefined);

  check(
    'dirty file flagged with real counts',
    token?.change?.added === 7 && token.change.removed === 2,
    JSON.stringify(token?.change),
  );
  check(
    'untracked file marked created',
    refresh?.change?.created === true && refresh.change.added === 2,
    JSON.stringify(refresh?.change),
  );
  check(
    'totals match git',
    tree.body.changedFiles === 2 && tree.body.added === 9 && tree.body.removed === 2,
    `${tree.body.changedFiles} files +${tree.body.added} −${tree.body.removed}`,
  );
  check(
    'directory rolls its children up',
    find(tree.body, 'src')?.change?.added === 9,
    JSON.stringify(find(tree.body, 'src')?.change),
  );
  check(
    '.git is never listed',
    !flatten(tree.body.root).some((n) => n.path.split('/').includes('.git')),
  );

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · read docs/PLAN.md rendered');
  const file = await get<FileContentResponse>(
    '/api/jobs/job_inplace/file?path=' + encodeURIComponent('docs/PLAN.md'),
  );
  check('GET file → 200', file.status === 200);
  check('raw text returned', file.body.raw.includes('# Auth refresh rotation'));
  const html = file.body.html ?? '';
  check('html rendered for markdown', html.length > 0);
  check('heading', html.includes('<h1>Auth refresh rotation</h1>'));
  check('blockquote (the decision log)', html.includes('<blockquote>'));
  check('inline code', html.includes('<code>decodeToken()</code>'));
  check(
    'checked task → li.done',
    (html.match(/<li class="task done">/g) ?? []).length === 2,
    `${(html.match(/<li class="task done">/g) ?? []).length} found`,
  );
  check('first open task → li.now', (html.match(/<li class="task now">/g) ?? []).length === 1);
  check(
    'remaining open tasks plain',
    (html.match(/<li class="task">/g) ?? []).length === 2,
    `${(html.match(/<li class="task">/g) ?? []).length} found`,
  );
  check('no raw checkbox inputs', !html.includes('<input'));

  console.log('\n3b · markdown safety + code blocks');
  const nasty = renderMarkdown(
    [
      '# T',
      '',
      '<script>alert(1)</script>',
      '',
      '[x](javascript:alert(1))',
      '',
      '<li class="need">borrowed status class</li>',
      '',
      '```ts',
      'const a = 1 < 2 && "x";',
      '```',
      '',
      '> quoted',
      '',
      '- [ ] one',
      '- [x] two',
    ].join('\n'),
  );
  check('script stripped', !nasty.html.includes('<script'));
  check('javascript: href stripped', !nasty.html.includes('javascript:'));
  check(
    'raw html cannot borrow a status class',
    !nasty.html.includes('class="need"'),
    nasty.html.slice(0, 120),
  );
  check(
    'fenced code block keeps its language',
    nasty.html.includes('<pre class="md-code"><code class="language-ts">'),
  );
  check('code contents escaped', nasty.html.includes('&lt; 2 &amp;&amp;'));
  check('blockquote survives', nasty.html.includes('<blockquote>'));
  check('task totals counted', nasty.tasks.done === 1 && nasty.tasks.total === 2);

  // A tight list item holds block tokens, not inline ones. Rendering them as inline threw
  // on the first nested list or fenced block in an item — a 500, so the file didn't open.
  console.log('\n3c · lists that hold blocks');
  const renders = (src: string): RenderedMarkdown | string => {
    try {
      return renderMarkdown(src);
    } catch (err) {
      return String(err);
    }
  };
  const nestedMd = renders(
    ['- outer', '  - inner *one*', '  - inner two', '- [x] done', '  - under a task', '- [ ] next'].join('\n'),
  );
  const nestedHtml = typeof nestedMd === 'string' ? '' : nestedMd.html;
  check('nested list renders', nestedHtml.includes('<ul>\n<li>inner <em>one</em></li>'), typeof nestedMd === 'string' ? nestedMd : nestedHtml);
  check('nested task item still counted', typeof nestedMd !== 'string' && nestedMd.tasks.done === 1 && nestedMd.tasks.total === 2);
  check('tight item stays unwrapped', nestedHtml.includes('<li>outer<ul>'), nestedHtml.slice(0, 80));
  const fenced = renders(['1. step', '   ```sh', '   make <x>', '   ```', '2. after'].join('\n'));
  const fencedHtml = typeof fenced === 'string' ? '' : fenced.html;
  check(
    'code block inside a list item renders, escaped',
    fencedHtml.includes('<pre class="md-code"><code class="language-sh">make &lt;x&gt;'),
    typeof fenced === 'string' ? fenced : fencedHtml,
  );
  // Mermaid (Amendment 60): marked for the page to draw, the source kept and escaped.
  const merm = renders(['```mermaid', 'graph TD; A-->B<script>x</script>', '```', '', '```Mermaid theme=dark', 'sequenceDiagram', '```'].join('\n'));
  const mermHtml = typeof merm === 'string' ? '' : merm.html;
  check('a mermaid block is marked for the page to draw', mermHtml.includes('<pre class="md-code md-mermaid"><code class="language-mermaid">graph TD; A--&gt;B&lt;script&gt;'), mermHtml);
  check('whatever the case of its name, with options after it', mermHtml.includes('<pre class="md-code md-mermaid"><code class="language-Mermaid">sequenceDiagram'), mermHtml);
  check('and its source cannot become markup', !mermHtml.includes('<script'));
  check('other code blocks are not marked', !fencedHtml.includes('md-mermaid'));
  const loose = renders(['- [ ] first', '', '  more of first', '', '- [x] second'].join('\n'));
  const looseHtml = typeof loose === 'string' ? '' : loose.html;
  check('loose task item keeps its paragraphs', looseHtml.includes('<li class="task now"><p>first</p>\n<p>more of first</p>'), looseHtml);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · diffs');
  const tokenFile = await get<FileContentResponse>(
    '/api/jobs/job_inplace/file?path=' + encodeURIComponent('src/token.js'),
  );
  check('dirty file carries a unified diff', (tokenFile.body.diff ?? '').includes('@@'));
  check('diff names the file', (tokenFile.body.diff ?? '').includes('src/token.js'));

  const newFile = await get<FileContentResponse>(
    '/api/jobs/job_inplace/file?path=' + encodeURIComponent('src/refresh.js'),
  );
  check(
    'untracked file gets a synthesised diff',
    (newFile.body.diff ?? '').includes('+export function exchange'),
    (newFile.body.diff ?? '').slice(0, 100),
  );

  const whole = await get<DiffResponse>('/api/jobs/job_inplace/diff');
  check('GET diff → 200', whole.status === 200);
  check(
    'whole-worktree totals',
    whole.body.files === 2 && whole.body.added === 9 && whole.body.removed === 2,
    `${whole.body.files} files +${whole.body.added} −${whole.body.removed}`,
  );
  check(
    'diff covers tracked AND untracked',
    whole.body.diff.includes('src/token.js') && whole.body.diff.includes('src/refresh.js'),
  );

  const scoped = await get<DiffResponse>(
    '/api/jobs/job_inplace/diff?path=' + encodeURIComponent('src/token.js'),
  );
  check('scoped diff returns one file', scoped.body.files === 1 && scoped.body.added === 7);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · edit docs/PLAN.md in place');
  const before = file.body.raw;
  const edited = `${before}- [ ] Verify rotation under clock skew\n`;
  const put = await send<FileContentResponse>('PUT', '/api/jobs/job_inplace/file', {
    path: 'docs/PLAN.md',
    content: edited,
  });
  check('PUT file → 200', put.status === 200, JSON.stringify(put.body).slice(0, 160));
  check('response re-renders', (put.body.html ?? '').includes('clock skew'));
  check('write landed on disk', put.body.raw === edited);

  const edits = eventsFor('job_inplace', 'file_edit').filter(
    (e) => e.payload.kind === 'file_edit' && e.payload.path === 'docs/PLAN.md',
  );
  check('a file_edit event was emitted for the write', edits.length >= 1, `${edits.length}`);
  const last = edits.at(-1);
  check(
    'with real counts, not a placeholder',
    last?.payload.kind === 'file_edit' && last.payload.added === 1 && last.payload.removed === 0,
    JSON.stringify(last?.payload),
  );
  check('human edit is attributed to no agent', last?.agentId === null);

  const afterEdit = await get<FileTreeResponse>('/api/jobs/job_inplace/tree');
  check(
    'tree now shows three changed files',
    afterEdit.body.changedFiles === 3,
    `${afterEdit.body.changedFiles}`,
  );
  check(
    'PLAN.md badge has a timestamp',
    typeof find(afterEdit.body, 'docs/PLAN.md')?.change?.at === 'string',
  );

  console.log('\n5b · the projection is derived, not authoritative');
  // Stand in for Track A's PostToolUse hook: the only source that knows WHICH
  // agent wrote a file. The watcher sees bytes; this sees the tool call.
  eventLog().emit(
    { projectId: 'prj_scratch', jobId: 'job_inplace', agentId: 'agt_builder' },
    { kind: 'file_edit', path: 'src/token.js', added: 7, removed: 2 },
  );
  const attributed = await get<FileContentResponse>(
    '/api/jobs/job_inplace/file?path=' + encodeURIComponent('src/token.js'),
  );
  check(
    'an agent-attributed edit surfaces as lastWriteBy',
    attributed.body.lastWriteBy === 'agt_builder',
    attributed.body.lastWriteBy ?? '(none)',
  );

  // Now a raw disk write with no agent behind it. Attribution must be recovered
  // from the log, not dropped — otherwise the badge loses its author on the next
  // save and the screen's central claim stops being true.
  const tokenPath = join(SCRATCH, 'src/token.js');
  const tokenBefore = readFileSync(tokenPath, 'utf8');
  const baseline = eventLog().head();
  writeFileSync(tokenPath, `${tokenBefore}\nexport const extra = 1;\n`);
  const recovered = await waitForEdits('job_inplace', ['src/token.js'], { afterSeq: baseline });
  check(
    'the watcher recovers the author from the log',
    recovered.get('src/token.js')?.agentId === 'agt_builder',
    String(recovered.get('src/token.js')?.agentId),
  );
  writeFileSync(tokenPath, tokenBefore);

  const rebuilt = workspace().store.rebuildFileChanges('job_inplace');
  check(
    'file_changes rebuilds from the event log alone',
    rebuilt === eventsFor('job_inplace', 'file_edit').length && rebuilt > 0,
    `${rebuilt} events replayed`,
  );

  // restore the fixture so a rerun sees the same numbers
  writeFileSync(join(SCRATCH, 'docs/PLAN.md'), before, 'utf8');

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · path containment');
  const escapes: Array<[string, string]> = [
    ['parent traversal', '../../../../../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['traversal with a real prefix', 'docs/../../../etc/passwd'],
    ['.git write vector', '.git/hooks/post-checkout'],
    ['.git read', '.git/config'],
    ['nested .git', 'docs/.git/config'],
    ['NUL byte', 'docs/PLAN.md\0.png'],
    ['dot-dot only', '..'],
  ];
  for (const [label, path] of escapes) {
    const res = await get<{ error: string }>(
      `/api/jobs/job_inplace/file?path=${encodeURIComponent(path)}`,
    );
    check(`rejected: ${label}`, res.status === 400, `got ${res.status}`);
  }

  // A symlink that passes every textual check and still leaves the worktree.
  const linkPath = join(SCRATCH, 'escape-link');
  rmSync(linkPath, { force: true });
  symlinkSync('/etc', linkPath);
  const viaLink = await get<{ error: string }>(
    '/api/jobs/job_inplace/file?path=' + encodeURIComponent('escape-link/hosts'),
  );
  check('rejected: symlink out of the worktree', viaLink.status === 400, `got ${viaLink.status}`);
  const writeViaLink = await send<{ error: string }>('PUT', '/api/jobs/job_inplace/file', {
    path: 'escape-link/conductor-should-never-write-here',
    content: 'x',
  });
  check('rejected: write through a symlink', writeViaLink.status === 400);
  check(
    'and nothing was written outside',
    !existsSync('/etc/conductor-should-never-write-here'),
  );
  rmSync(linkPath, { force: true });

  const writeEscape = await send<{ error: string }>('PUT', '/api/jobs/job_inplace/file', {
    path: '../../../../../../tmp/conductor-escape.txt',
    content: 'x',
  });
  check('rejected: write traversal', writeEscape.status === 400);
  check('no file created outside', !existsSync('/tmp/conductor-escape.txt'));

  const unknownJob = await get<{ error: string }>('/api/jobs/job_nope/tree');
  check('unknown job → 404', unknownJob.status === 404, `got ${unknownJob.status}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · worktree isolation: create · reuse · remove');
  const created = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_wt',
    projectId: 'prj_scratch',
    repoPath: SCRATCH,
    isolation: 'worktree',
  });
  check('created → 201', created.status === 201, JSON.stringify(created.body).slice(0, 200));
  const wtPath = created.body.workspace?.path ?? '';
  check(
    'lives under .conductor/wt/<jobId>',
    wtPath.includes(join('.conductor', 'wt', 'job_wt')),
    wtPath,
  );
  check('directory exists', existsSync(wtPath));
  check('on its own branch', created.body.workspace?.branch === 'conductor/job_wt');
  const wtEvents = eventsFor('job_wt', 'worktree');
  check(
    'emitted worktree/created',
    wtEvents.at(-1)?.payload.kind === 'worktree' &&
      (wtEvents.at(-1)!.payload as { event: string }).event === 'created',
    JSON.stringify(wtEvents.at(-1)?.payload),
  );
  check('job-scoped, so agentId is null', wtEvents.at(-1)?.agentId === null);

  const freshTree = await get<FileTreeResponse>('/api/jobs/job_wt/tree');
  check(
    'a new worktree is clean (the dirt stayed in the main checkout)',
    freshTree.body.changedFiles === 0,
    `${freshTree.body.changedFiles} changed`,
  );

  const reused = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_wt',
    projectId: 'prj_scratch',
    repoPath: SCRATCH,
    isolation: 'worktree',
  });
  check('second open reuses, does not fail', reused.status === 201);
  check('same path', reused.body.workspace?.path === wtPath);
  const reuseEvent = eventsFor('job_wt', 'worktree').at(-1);
  check(
    'emitted worktree/reused',
    reuseEvent?.payload.kind === 'worktree' &&
      (reuseEvent.payload as { event: string }).event === 'reused',
    JSON.stringify(reuseEvent?.payload),
  );

  console.log('\n7b · the watcher reports real line counts');
  const target = join(wtPath, 'src', 'token.js');
  writeFileSync(target, 'export function decodeToken(raw) {\n  return verify(raw, KEY);\n}\nexport const extra = 1;\n');
  writeFileSync(join(wtPath, 'src', 'brand-new.js'), 'export const a = 1;\nexport const b = 2;\n');

  const seen = await waitForEdits('job_wt', ['src/token.js', 'src/brand-new.js']);
  const tokenEdit = seen.get('src/token.js');
  const newEdit = seen.get('src/brand-new.js');
  check(
    'modified file: +1 −0, from git not a guess',
    tokenEdit?.payload.kind === 'file_edit' &&
      tokenEdit.payload.added === 1 &&
      tokenEdit.payload.removed === 0,
    JSON.stringify(tokenEdit?.payload),
  );
  check(
    'new file: created, +2',
    newEdit?.payload.kind === 'file_edit' &&
      newEdit.payload.created === true &&
      newEdit.payload.added === 2,
    JSON.stringify(newEdit?.payload),
  );
  check('the watcher cannot name an author, and does not invent one', tokenEdit?.agentId === null);

  /*
   * A file in a directory the repo has never seen. Its own case because plain
   * `git status` collapses a wholly-untracked directory to one record for the
   * directory — `?? api/` and nothing about the file inside it. Every check above
   * writes into `src/`, which is tracked, so all of them passed while the first
   * file of a new feature produced no event at all and counted for zero lines.
   */
  mkdirSync(join(wtPath, 'api', 'v2'), { recursive: true });
  writeFileSync(join(wtPath, 'api', 'v2', 'rotate.js'), 'export const rotate = () => {\n  return 1;\n};\n');
  const nested = (await waitForEdits('job_wt', ['api/v2/rotate.js'])).get('api/v2/rotate.js');
  check(
    'a file in a brand-new directory is seen, and counted: created, +3',
    nested?.payload.kind === 'file_edit' &&
      nested.payload.created === true &&
      nested.payload.added === 3,
    JSON.stringify(nested?.payload),
  );
  const nestedTree = await get<FileTreeResponse>('/api/jobs/job_wt/tree');
  check(
    'and the diffstat names the file, not the directory',
    nestedTree.body.changedFiles === 3 && nestedTree.body.added === 6,
    `${nestedTree.body.changedFiles} files +${nestedTree.body.added}`,
  );

  const beforeNoop = eventsFor('job_wt', 'file_edit').length;
  writeFileSync(target, 'export function decodeToken(raw) {\n  return verify(raw, KEY);\n}\nexport const extra = 1;\n');
  await settleAndFlush('job_wt');
  check(
    'rewriting identical bytes emits nothing',
    eventsFor('job_wt', 'file_edit').length === beforeNoop,
    `${eventsFor('job_wt', 'file_edit').length} vs ${beforeNoop}`,
  );

  // gitignore: the scratch repo has none, so give it one and confirm it is honoured.
  writeFileSync(join(wtPath, '.gitignore'), 'ignored-by-git/\n');
  mkdirSync(join(wtPath, 'ignored-by-git'), { recursive: true });
  await settleAndFlush('job_wt');
  const beforeIgnored = eventsFor('job_wt', 'file_edit').length;
  writeFileSync(join(wtPath, 'ignored-by-git', 'noise.log'), 'lots of noise\n');
  await settleAndFlush('job_wt');
  check(
    'gitignored writes never reach the log',
    eventsFor('job_wt', 'file_edit').length === beforeIgnored,
    `${eventsFor('job_wt', 'file_edit').length} vs ${beforeIgnored}`,
  );

  // node_modules has no .gitignore backing it here — the structural filter must hold.
  mkdirSync(join(wtPath, 'node_modules', 'left-pad'), { recursive: true });
  const beforeModules = eventsFor('job_wt', 'file_edit').length;
  writeFileSync(join(wtPath, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await settleAndFlush('job_wt');
  check(
    'node_modules ignored even with no .gitignore',
    eventsFor('job_wt', 'file_edit').length === beforeModules,
  );
  const wtTree = await get<FileTreeResponse>('/api/jobs/job_wt/tree');
  check(
    'node_modules absent from the tree',
    !flatten(wtTree.body.root).some((n) => n.path.startsWith('node_modules')),
  );

  console.log('\n7c · remove');
  const removed = await send<{ removed: boolean; reason?: string }>(
    'DELETE',
    '/api/workspaces/job_wt?force=true',
  );
  check('DELETE → removed', removed.body.removed === true, JSON.stringify(removed.body));
  check('directory gone', !existsSync(wtPath));
  const removeEvent = eventsFor('job_wt', 'worktree').at(-1);
  check(
    'emitted worktree/removed',
    removeEvent?.payload.kind === 'worktree' &&
      (removeEvent.payload as { event: string }).event === 'removed',
  );
  const afterRemove = await get<{ error: string }>('/api/jobs/job_wt/tree');
  check('reads on a removed workspace → 410', afterRemove.status === 410, `got ${afterRemove.status}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8 · branch isolation (on a throwaway repo, not the fixture)');
  const temp = join(tmpdir(), `conductor-branch-${Date.now()}`);
  mkdirSync(temp, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: temp });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: temp });
  execFileSync('git', ['config', 'user.email', 'c@example.invalid'], { cwd: temp });
  execFileSync('git', ['config', 'user.name', 'C'], { cwd: temp });
  writeFileSync(join(temp, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: temp });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: temp });

  const branched = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_branch',
    projectId: 'prj_temp',
    repoPath: temp,
    isolation: 'branch',
    branch: 'conductor/test-branch',
  });
  check('branch isolation → 201', branched.status === 201, JSON.stringify(branched.body).slice(0, 200));
  check(
    'works in the repo itself, no new directory',
    branched.body.workspace?.path === branched.body.workspace?.repoPath,
  );
  check(
    'switched the checkout to the branch',
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: temp, encoding: 'utf8' }).trim() ===
      'conductor/test-branch',
  );
  const branchRemoved = await send<{ removed: boolean; reason?: string }>(
    'DELETE',
    '/api/workspaces/job_branch',
  );
  check(
    "remove NEVER deletes a shared checkout",
    existsSync(join(temp, 'a.txt')),
    JSON.stringify(branchRemoved.body),
  );
  check('and says so', (branchRemoved.body.reason ?? '').includes("user's checkout"));
  rmSync(temp, { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8b · a file the tree lists and the disk does not have');
  const gone = join(tmpdir(), `conductor-gone-${Date.now()}`);
  mkdirSync(join(gone, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: gone });
  execFileSync('git', ['config', 'user.email', 'c@example.invalid'], { cwd: gone });
  execFileSync('git', ['config', 'user.name', 'C'], { cwd: gone });
  writeFileSync(join(gone, 'docs', 'GONE.md'), '# Gone\n\n- [x] was here\n');
  writeFileSync(join(gone, 'keep.txt'), 'kept\n');
  symlinkSync('missing.md', join(gone, 'docs', 'dangling.md'));
  execFileSync('git', ['add', '-A'], { cwd: gone });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: gone });
  rmSync(join(gone, 'docs', 'GONE.md'));
  // Staged and then deleted: no HEAD copy, only the index's.
  writeFileSync(join(gone, 'staged.md'), 'only in the index\n');
  execFileSync('git', ['add', 'staged.md'], { cwd: gone });
  rmSync(join(gone, 'staged.md'));

  const goneWs = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_gone',
    projectId: 'prj_gone',
    repoPath: gone,
    isolation: 'in_place',
  });
  check('in_place over a repo with a deletion → 201', goneWs.status === 201, `got ${goneWs.status}`);
  const goneTree = await get<FileTreeResponse>('/api/jobs/job_gone/tree');
  const goneNode = find(goneTree.body, 'docs/GONE.md');
  check('the tree still lists the deleted file', goneNode !== undefined);
  check('and marks it deleted (Amendment 29)', goneNode?.change?.deleted === true, JSON.stringify(goneNode?.change));
  check('a live file is not marked', find(goneTree.body, 'keep.txt')?.change?.deleted === undefined);

  const goneFile = await get<FileContentResponse>(
    '/api/jobs/job_gone/file?path=' + encodeURIComponent('docs/GONE.md'),
  );
  check('opening it is a 200, not a 404', goneFile.status === 200, `got ${goneFile.status} ${JSON.stringify(goneFile.body).slice(0, 120)}`);
  check('flagged deleted', goneFile.body.deleted === true);
  check('with its last committed text', goneFile.body.raw === '# Gone\n\n- [x] was here\n', JSON.stringify(goneFile.body.raw));
  check('rendered like any markdown', (goneFile.body.html ?? '').includes('<li class="task done">'));
  check('and the diff that removed it', (goneFile.body.diff ?? '').includes('-# Gone'), (goneFile.body.diff ?? '').slice(0, 120));

  const stagedGone = await get<FileContentResponse>(
    '/api/jobs/job_gone/file?path=' + encodeURIComponent('staged.md'),
  );
  check(
    'staged then deleted: the index copy',
    stagedGone.status === 200 && stagedGone.body.deleted === true && stagedGone.body.raw === 'only in the index\n',
    `got ${stagedGone.status} ${JSON.stringify(stagedGone.body).slice(0, 120)}`,
  );

  const dangling = await get<{ error: string }>(
    '/api/jobs/job_gone/file?path=' + encodeURIComponent('docs/dangling.md'),
  );
  check(
    'a link to nothing says where it points',
    dangling.status === 404 && dangling.body.error.includes('is a link to missing.md'),
    `got ${dangling.status} ${dangling.body.error}`,
  );
  const never = await get<{ error: string }>(
    '/api/jobs/job_gone/file?path=' + encodeURIComponent('never-was.md'),
  );
  check(
    'a path that never existed is still a plain 404',
    never.status === 404 && never.body.error.includes('does not exist'),
    `got ${never.status} ${never.body.error}`,
  );
  check('and none of it touched the repo', !existsSync(join(gone, 'docs', 'GONE.md')) && existsSync(join(gone, 'keep.txt')));
  await send('DELETE', '/api/workspaces/job_gone');
  rmSync(gone, { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · the per-worktree lock actually serialises');
  const lock = new KeyedLock();
  const order: string[] = [];
  const slow = lock.run('wt', async () => {
    order.push('a:start');
    await new Promise((r) => setTimeout(r, 40));
    order.push('a:end');
  });
  const fast = lock.run('wt', async () => {
    order.push('b:start');
    order.push('b:end');
  });
  const other = lock.run('different', async () => {
    order.push('c');
  });
  await Promise.all([slow, fast, other]);
  check(
    'same key never interleaves',
    order.indexOf('a:end') < order.indexOf('b:start'),
    order.join(' '),
  );
  check('a different key is not blocked', order.indexOf('c') < order.indexOf('a:end'), order.join(' '));
  check('lock map drains', lock.held === 0, `${lock.held} held`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n10 · resolving a job the session engine created, not this track');
  // Track A owns the `jobs` table and may create a job without going through
  // WorktreeMgr. Reading it is allowed; writing it is not, and the service never
  // does. Rows are inserted HERE, in the test, to stand in for that track.
  const db = openDb();
  db.prepare(
    `INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('prj_from_a', 'scratch', `${SCRATCH}#a`, 'main', new Date().toISOString());
  db.prepare(
    `INSERT INTO jobs (id, project_id, prompt, isolation, worktree_path, branch, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'job_from_a',
    'prj_from_a',
    'rotate refresh tokens',
    'in_place',
    SCRATCH,
    'main',
    'working',
    new Date().toISOString(),
  );

  const fromA = await get<FileTreeResponse>('/api/jobs/job_from_a/tree');
  check('tree resolves via jobs.worktree_path', fromA.status === 200, `got ${fromA.status}`);
  check(
    'and sees the same changes',
    fromA.body.changedFiles === 2,
    `${fromA.body.changedFiles} changed`,
  );
  const fromAFile = await get<FileContentResponse>(
    '/api/jobs/job_from_a/file?path=' + encodeURIComponent('docs/PLAN.md'),
  );
  check('and renders markdown for it', (fromAFile.body.html ?? '').includes('<h1>'));
  const escapeFromA = await get<{ error: string }>(
    '/api/jobs/job_from_a/file?path=' + encodeURIComponent('../../../../etc/passwd'),
  );
  check('containment applies to that path too', escapeFromA.status === 400);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · the snapshot slice (Amendment 2 — contributors compose)');
  const slice = workspace().snapshotSlice();
  const sliceJobIds = (slice.jobs ?? []).map((j) => j.id);
  check(
    'publishes the bootstrap workspace',
    sliceJobIds.includes('job_inplace'),
    sliceJobIds.join(','),
  );
  check(
    'does NOT publish a job the session engine owns',
    !sliceJobIds.includes('job_from_a'),
    'job_from_a must stay Track A\'s — no id collision by construction',
  );
  const inplaceJob = (slice.jobs ?? []).find((j) => j.id === 'job_inplace');
  check(
    'carries the real worktree path and branch',
    inplaceJob?.worktreePath === SCRATCH && inplaceJob.branch === 'main',
    JSON.stringify({ path: inplaceJob?.worktreePath, branch: inplaceJob?.branch }),
  );
  check(
    'invents no prompt, and reads as waiting rather than running',
    inplaceJob?.prompt === '' && inplaceJob.status === 'queued',
    JSON.stringify({ prompt: inplaceJob?.prompt, status: inplaceJob?.status }),
  );
  check(
    'publishes a project for it, named from the repo',
    (slice.projects ?? []).some((p) => p.id === 'prj_scratch' && p.name === 'scratch-repo'),
    JSON.stringify(slice.projects),
  );
  check(
    'does NOT publish a project the session engine owns',
    !(slice.projects ?? []).some((p) => p.id === 'prj_from_a'),
  );

  const snap = await get<Snapshot>('/api/snapshot');
  check(
    'and it reaches the real snapshot',
    snap.body.jobs.some((j) => j.id === 'job_inplace'),
    `${snap.body.jobs.length} jobs`,
  );
  check("seq is never a contributor's", snap.body.seq === eventLog().head());

  // The composition guarantee itself. Before Amendment 2 one of these two slices
  // vanished with no error; this stands in for Track A's contributor so the
  // guarantee is checked against a real slice rather than a hypothetical one.
  const unregister = registerSnapshotContributor(() => ({
    jobs: [
      {
        id: 'job_from_a',
        projectId: 'prj_from_a',
        prompt: 'rotate refresh tokens',
        isolation: 'in_place' as const,
        worktreePath: SCRATCH,
        branch: 'main',
        status: 'working' as const,
        createdAt: new Date().toISOString(),
        endedAt: null,
        budgetUsd: null,
      },
    ],
  }));
  const composed = await get<Snapshot>('/api/snapshot');
  check(
    'two contributors supplying jobs BOTH survive',
    composed.body.jobs.some((j) => j.id === 'job_inplace') &&
      composed.body.jobs.some((j) => j.id === 'job_from_a'),
    composed.body.jobs.map((j) => j.id).join(','),
  );
  check(
    "and the session engine's prompt is not overwritten by ours",
    composed.body.jobs.find((j) => j.id === 'job_from_a')?.prompt === 'rotate refresh tokens',
  );
  unregister();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n12 · a truncated tree says so out loud');
  // Driven through the cap argument rather than by writing 12,000 files: the
  // behaviour under test is the report, not the number.
  const ws = workspace().resolve('job_inplace');
  const changeSet = await scanChanges(ws.path, workspace().store.changes('job_inplace'));
  const capped = await buildTree(ws.path, 'scratch-repo', changeSet, 3);
  check(
    // 8, not 3: the pool a cap of 3 trims from now includes the nested repos'
    // own files too (Amendment 90), not just the outer repo's.
    'truncated reports how many entries were dropped',
    capped.truncated === 8,
    String(capped.truncated),
  );
  check(
    'and the tree it did return is intact, not corrupted by the cap',
    (capped.root.children ?? []).length > 0 &&
      (capped.root.children ?? []).every((n) => n.path.length > 0),
  );

  const uncapped = await buildTree(ws.path, 'scratch-repo', changeSet);
  check(
    'absent — not 0 — when nothing was dropped',
    uncapped.truncated === undefined,
    String(uncapped.truncated),
  );
  const live = await get<FileTreeResponse>('/api/jobs/job_inplace/tree');
  check('so the real endpoint never sets it for a small repo', live.body.truncated === undefined);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · a directory with no git in it — what in_place is for');
  // The manual has always said in_place works without a repo. It did not: the
  // repo check ran before the isolation was looked at, so the one mode that needs
  // no git was rejected along with the two that do.
  const NOGIT = join(tmpdir(), `conductor-nogit-${Date.now()}`);
  mkdirSync(join(NOGIT, 'src'), { recursive: true });
  mkdirSync(join(NOGIT, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(NOGIT, 'notes.md'), '# scratch\n\nnot a repo.\n');
  writeFileSync(join(NOGIT, 'src', 'app.js'), 'const a = 1;\n');
  writeFileSync(join(NOGIT, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

  const refusedWt = await send<{ detail?: string }>('POST', '/api/workspaces', {
    jobId: 'job_nogit_wt',
    projectId: 'prj_nogit',
    repoPath: NOGIT,
    isolation: 'worktree',
  });
  check('worktree isolation still refuses — it genuinely needs git', refusedWt.status >= 400);
  check(
    'and says which directory and why',
    (refusedWt.body.detail ?? '').includes('is not a git repository'),
    refusedWt.body.detail,
  );
  const afterRefusal = await get<{ workspaces: WorkspaceRecord[] }>('/api/workspaces');
  check(
    'nothing half-made: no workspace recorded for the refusal',
    !afterRefusal.body.workspaces.some((w) => w.jobId === 'job_nogit_wt'),
  );

  const nogit = await send<{ workspace: WorkspaceRecord }>('POST', '/api/workspaces', {
    jobId: 'job_nogit',
    projectId: 'prj_nogit',
    repoPath: NOGIT,
    isolation: 'in_place',
  });
  check('in_place opens in a non-repo → 201', nogit.status === 201, JSON.stringify(nogit.body));
  check(
    "branch reads '(no git)' rather than failing or lying",
    nogit.body.workspace?.branch === '(no git)',
    nogit.body.workspace?.branch,
  );
  check(
    'and no base commit is invented',
    nogit.body.workspace?.baseRef === null,
    String(nogit.body.workspace?.baseRef),
  );

  const nogitTree = await get<FileTreeResponse>('/api/jobs/job_nogit/tree');
  check('tree lists files git could not enumerate', nogitTree.status === 200);
  check(
    'both files present, walked from disk',
    find(nogitTree.body, 'src/app.js') !== undefined &&
      find(nogitTree.body, 'notes.md') !== undefined,
    flatten(nogitTree.body.root)
      .map((n) => n.path)
      .join(','),
  );
  check(
    'node_modules pruned during the walk, with no .gitignore to lean on',
    !flatten(nogitTree.body.root).some((n) => n.path.startsWith('node_modules')),
  );

  // The watcher's git-less path: real counts from reading the file, not a guess.
  writeFileSync(join(NOGIT, 'src', 'app.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  writeFileSync(join(NOGIT, 'src', 'added.js'), 'export const x = 1;\n');
  const nogitEdits = await waitForEdits('job_nogit', ['src/app.js', 'src/added.js']);
  const appEdit = nogitEdits.get('src/app.js');
  check(
    'an edit reports the file length, since there is no commit to diff against',
    appEdit?.payload.kind === 'file_edit' && appEdit.payload.added === 3,
    JSON.stringify(appEdit?.payload),
  );
  const addedEdit = nogitEdits.get('src/added.js');
  check(
    'a new file is created, +1',
    addedEdit?.payload.kind === 'file_edit' &&
      addedEdit.payload.created === true &&
      addedEdit.payload.added === 1,
    JSON.stringify(addedEdit?.payload),
  );

  const beforeNogitNoop = eventsFor('job_nogit', 'file_edit').length;
  writeFileSync(join(NOGIT, 'src', 'app.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  await settleAndFlush('job_nogit');
  check(
    'the no-op filter still holds without git',
    eventsFor('job_nogit', 'file_edit').length === beforeNogitNoop,
    `${eventsFor('job_nogit', 'file_edit').length} vs ${beforeNogitNoop}`,
  );

  rmSync(join(NOGIT, 'src', 'added.js'));
  const deletion = await waitForEdits('job_nogit', ['src/added.js'], {
    afterSeq: eventsFor('job_nogit', 'file_edit').at(-1)?.seq ?? 0,
  });
  const deleted = deletion.get('src/added.js');
  check(
    'a deletion reports the lines that went with it',
    deleted?.payload.kind === 'file_edit' &&
      deleted.payload.deleted === true &&
      deleted.payload.removed === 1,
    JSON.stringify(deleted?.payload),
  );

  const nogitChanged = await get<FileTreeResponse>('/api/jobs/job_nogit/tree');
  check(
    'the tree badges the change from the log, the only record there is',
    find(nogitChanged.body, 'src/app.js')?.change?.added === 3,
    JSON.stringify(find(nogitChanged.body, 'src/app.js')?.change),
  );

  const nogitFile = await get<FileContentResponse>(
    '/api/jobs/job_nogit/file?path=notes.md',
  );
  check('markdown still renders', (nogitFile.body.html ?? '').includes('<h1'));
  check(
    'and the diff pane shows the file as added, via --no-index',
    (nogitFile.body.diff ?? '').includes('+not a repo.'),
    (nogitFile.body.diff ?? '').slice(0, 80),
  );

  const nogitEdit = await send<FileContentResponse>('PUT', '/api/jobs/job_nogit/file', {
    path: 'notes.md',
    content: '# scratch\n\nedited in place.\n',
  });
  check('editing in place works with no git', nogitEdit.status === 200);
  check(
    'and the write landed',
    readFileSync(join(NOGIT, 'notes.md'), 'utf8').includes('edited in place'),
  );

  const closed = await send<{ removed: boolean; reason?: string }>(
    'DELETE',
    '/api/workspaces/job_nogit',
  );
  check('closing it deletes nothing on disk', existsSync(join(NOGIT, 'notes.md')));
  check(
    'and says so rather than claiming a removal',
    (closed.body.reason ?? '').includes("shares the user's checkout"),
    closed.body.reason,
  );
  rmSync(NOGIT, { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n14 · completing a path, so nobody has to type one from memory');

  /*
   * The only place this track looks outside a workspace, so the assertions that
   * matter are the ones about what it REFUSES to show. A completion endpoint that
   * listed files would be a remote directory-read of the user's whole disk; one
   * that showed dotfiles would put ~/.ssh and ~/.aws in a listing of $HOME that
   * nobody asked for.
   */
  const BROWSE = realpathSync(tmpdir()) + sep + `conductor-browse-${Date.now()}`;
  mkdirSync(join(BROWSE, 'repo-one', '.git'), { recursive: true });
  mkdirSync(join(BROWSE, 'repo-two'), { recursive: true });
  // A LINKED WORKTREE's .git is a file, not a directory — the case a naive
  // isDirectory() check gets wrong, and exactly what `.conductor/wt/<job>` is.
  writeFileSync(join(BROWSE, 'repo-two', '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  mkdirSync(join(BROWSE, 'plain-dir'), { recursive: true });
  mkdirSync(join(BROWSE, '.hidden-dir'), { recursive: true });
  writeFileSync(join(BROWSE, 'notes.txt'), 'a file, not a directory\n');
  symlinkSync(join(BROWSE, 'plain-dir'), join(BROWSE, 'linked'));
  // One more than the cap, so truncation is exercised rather than assumed.
  mkdirSync(join(BROWSE, 'bulk'), { recursive: true });
  for (let i = 0; i < 45; i += 1) {
    mkdirSync(join(BROWSE, 'bulk', `d${String(i).padStart(2, '0')}`), { recursive: true });
  }

  const complete = (path: string): Promise<{ status: number; body: CompleteResult }> =>
    get<CompleteResult>(`/api/fs/complete?path=${encodeURIComponent(path)}`);

  const browsed = await complete(`${BROWSE}${sep}`);
  const names = browsed.body.entries.map((e) => e.name);
  check('a trailing separator lists the directory', browsed.status === 200, `${browsed.status}`);
  check(
    'FILES ARE NOT LISTED — this cannot enumerate your documents',
    !names.includes('notes.txt'),
    names.join(' '),
  );
  check(
    'DOTFILES STAY HIDDEN until asked for — ~/.ssh is not browsable by accident',
    !names.includes('.hidden-dir'),
    names.join(' '),
  );
  check('ordinary directories are listed', names.includes('plain-dir'));
  check('a symlink to a directory is followed', names.includes('linked'));
  check(
    'git repositories are marked',
    browsed.body.entries.find((e) => e.name === 'repo-one')?.repo === true,
  );
  check(
    'including a linked worktree, whose .git is a file',
    browsed.body.entries.find((e) => e.name === 'repo-two')?.repo === true,
  );
  check(
    'and a plain directory is not',
    browsed.body.entries.find((e) => e.name === 'plain-dir')?.repo === false,
  );

  const dotted = await complete(`${BROWSE}${sep}.h`);
  check(
    'typing the dot yourself reveals them — the shell rule, not a wall',
    dotted.body.entries.some((e) => e.name === '.hidden-dir'),
    dotted.body.entries.map((e) => e.name).join(' '),
  );

  const prefixed = await complete(`${BROWSE}${sep}repo`);
  check(
    'a fragment matches inside the parent',
    prefixed.body.entries.length === 2 && prefixed.body.prefix === 'repo',
    `${prefixed.body.entries.length} · ${JSON.stringify(prefixed.body.prefix)}`,
  );
  const cased = await complete(`${BROWSE}${sep}REPO-O`);
  check(
    'matching ignores case, because nobody remembers it',
    cased.body.entries.length === 1 && cased.body.entries[0]?.name === 'repo-one',
    cased.body.entries.map((e) => e.name).join(' '),
  );

  const overCap = await complete(`${BROWSE}${sep}bulk${sep}`);
  check(
    'the cap holds and says how much it hid',
    overCap.body.entries.length === 40 && overCap.body.truncated === 5,
    `${overCap.body.entries.length} shown, ${overCap.body.truncated} hidden`,
  );

  const exact = await complete(join(BROWSE, 'repo-one'));
  check(
    'a fully typed repo is confirmed as one',
    exact.body.target?.repo === true && exact.body.target.path === join(BROWSE, 'repo-one'),
    JSON.stringify(exact.body.target),
  );

  // Every one of these is a normal keystroke in a path being typed, not an error.
  for (const [label, path] of [
    ['a path that does not exist yet', join(BROWSE, 'nope', 'deeper')],
    ['a file where a directory was expected', join(BROWSE, 'notes.txt')],
    ['a NUL byte', `${BROWSE}${sep}\0evil`],
  ] as const) {
    const mid = await complete(path);
    check(
      `${label} → 200 and an empty list, not an error`,
      mid.status === 200 && mid.body.entries.length === 0,
      `${mid.status} · ${mid.body.entries.length} entries`,
    );
  }
  const missing = await complete(join(BROWSE, 'nope'));
  check('and nothing is claimed about a path that is not there', missing.body.target === null);

  const home = await complete('');
  check(
    'an empty field starts at home rather than nowhere',
    home.body.dir === realpathSync(homedir()),
    home.body.dir,
  );
  const tilde = await complete('~');
  check('~ expands', tilde.body.dir === realpathSync(homedir()), tilde.body.dir);

  check(
    'paths come back canonical, so one folder is never two projects',
    browsed.body.dir === realpathSync(BROWSE),
    `${browsed.body.dir} vs ${realpathSync(BROWSE)}`,
  );

  rmSync(BROWSE, { recursive: true, force: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n15 · nested repos browse all the way down (Amendment 90)');

  /*
   * `uncapped` (section 12) is already a full tree of the fixture, which
   * `make-scratch-repo.sh` seeds with a nested clone (`inner/`, its own branch
   * and a `node_modules`) and an initialised submodule (`vendor-lib/`) — the
   * two shapes a `.git` boundary comes in. Reused rather than rebuilt: a
   * second `buildTree` call here would just be the same work twice.
   */
  const innerApp = find(uncapped, 'inner/app.js');
  const vendorLib = find(uncapped, 'vendor-lib/lib.js');
  check('a nested clone lists a file at its full path', innerApp?.type === 'file');
  check('so does a submodule', vendorLib?.type === 'file');

  const innerDir = find(uncapped, 'inner');
  const vendorDir = find(uncapped, 'vendor-lib');
  check(
    "the clone's folder is marked with its branch",
    innerDir?.repo?.branch === 'feature/nested',
    JSON.stringify(innerDir?.repo),
  );
  check(
    "the submodule's folder is marked with its branch too",
    vendorDir?.repo?.branch === 'main',
    JSON.stringify(vendorDir?.repo),
  );

  check(
    "node_modules inside the nested clone stays hidden, same as the outer repo's",
    !flatten(uncapped.root).some((n) => n.path.startsWith('inner/node_modules')),
  );

  const loopback = find(uncapped, 'inner/loopback');
  check(
    "a symlink back up the tree (inner/loopback -> ..) doesn't loop",
    loopback?.type === 'file',
    JSON.stringify(loopback),
  );

  // Budget (ADR 0003): the outer repo's own files are never pushed out by a
  // nested repo's. Computed from the uncapped tree rather than hardcoded, so
  // this keeps meaning the same thing if the fixture grows a file.
  const allPaths = flatten(uncapped.root)
    .filter((n) => n.type === 'file')
    .map((n) => n.path);
  const ownPaths = allPaths.filter((p) => !p.startsWith('inner/') && !p.startsWith('vendor-lib/'));
  const nestedPaths = allPaths.filter((p) => p.startsWith('inner/') || p.startsWith('vendor-lib/'));
  check(
    'the fixture actually has both an own file and a nested one to budget between',
    ownPaths.length > 0 && nestedPaths.length > 0,
    `own=${ownPaths.length} nested=${nestedPaths.length}`,
  );

  const nestedCapped = await buildTree(ws.path, 'scratch-repo', changeSet, ownPaths.length);
  check(
    'a cap sized to just the outer repo still drops only nested files',
    nestedCapped.truncated === nestedPaths.length,
    String(nestedCapped.truncated),
  );
  const cappedFlat = flatten(nestedCapped.root);
  const cappedPaths = new Set(cappedFlat.filter((n) => n.type === 'file').map((n) => n.path));
  check(
    "every one of the outer repo's own files survived the cap",
    ownPaths.every((p) => cappedPaths.has(p)),
  );
  check(
    "none of the nested files did — the outer repo's own files went first",
    nestedPaths.every((p) => !cappedPaths.has(p)),
  );
  check(
    "the nested repos' folders still show, branch and all, even with their files capped out",
    cappedFlat.find((n) => n.path === 'inner')?.repo?.branch === 'feature/nested' &&
      cappedFlat.find((n) => n.path === 'vendor-lib')?.repo?.branch === 'main',
  );

  // ───────────────────────────────────────────────────────────────────────────
  rmSync(join(SCRATCH, '.conductor'), { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: SCRATCH });
  await app.close();

  console.log(
    failures === 0
      ? '\nTrack C workspace: PASS — tree, markdown, diff, in-place edit, worktrees, nested repos, containment.\n'
      : `\nTrack C workspace: FAIL — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  process.exit(1);
});
