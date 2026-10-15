/**
 * Amendment 138 verify — new folder, rename and delete, for a job's worktree and a project
 * folder, end to end over HTTP against throwaway folders.
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/workspace/verify-files-verbs.ts
 *
 * Needs no fixture. Everything it writes is under one folder in tmpdir(): a git repo opened
 * as an in_place job, and a plain folder that is a project's directory. All of it is
 * removed at the end.
 *
 * If you interrupt it, the listener on 7838 stays up and the next run dies with
 * EADDRINUSE:  lsof -ti :7838 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CreateFolderResponse,
  DeleteEntryResponse,
  EntryResponse,
  FileNode,
  FileTreeResponse,
  RenameResponse,
} from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { insertProject } from '../session/store.js';
import { workspace } from './service.js';

const PORT = 7838;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(label: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Reply<T> {
  status: number;
  body: T;
}
type Err = { error: string; detail?: string };

async function send<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const show = (r: Reply<unknown>): string => `${r.status} ${JSON.stringify(r.body)}`;

// ── scratch folders, all inside ROOT ─────────────────────────────────────────

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-files-verbs-verify-')));
const REPO = join(ROOT, 'repo');
const PLAIN = join(ROOT, 'plain');
const OUTSIDE = join(ROOT, 'outside.txt');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Verify',
  GIT_AUTHOR_EMAIL: 'verify@example.invalid',
  GIT_COMMITTER_NAME: 'Verify',
  GIT_COMMITTER_EMAIL: 'verify@example.invalid',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function makeFolders(): void {
  mkdirSync(PLAIN);
  writeFileSync(OUTSIDE, 'not yours\n');
  sh(ROOT, 'init', '-q', '-b', 'main', REPO);
  put(REPO, 'README.md', '# repo\n');
  put(REPO, 'src/a.ts', 'export const a = 1;\n');
  put(REPO, 'src/b.ts', 'export const b = 2;\n');
  sh(REPO, 'add', '-A');
  sh(REPO, 'commit', '-q', '-m', 'start');
}

/** Is this filesystem blind to case? Asked of the disk, not assumed from the platform. */
function caseBlind(dir: string): boolean {
  const probe = join(dir, '.case-probe');
  writeFileSync(probe, '');
  const blind = existsSync(join(dir, '.CASE-PROBE'));
  rmSync(probe);
  return blind;
}

function flatten(node: FileNode, out: FileNode[] = []): FileNode[] {
  out.push(node);
  for (const kid of node.children ?? []) flatten(kid, out);
  return out;
}

interface Root {
  name: string;
  dir: string;
  /** `verb` is folders, rename, entry or tree; `q` more query, already encoded. */
  url: (verb: string, q?: string) => string;
}

async function verbsOn(r: Root, opts: { git: boolean }): Promise<void> {
  const enc = encodeURIComponent;
  const folder = (path: string) => send<CreateFolderResponse & Err>('POST', r.url('folders'), { path });
  const rename = (from: string, to: string) => send<RenameResponse & Err>('POST', r.url('rename'), { from, to });
  const entry = (path: string) => send<EntryResponse & Err>('GET', r.url('entry', `path=${enc(path)}`));
  const del = (path: string, recursive?: string) =>
    send<DeleteEntryResponse & Err>(
      'DELETE',
      r.url('entry', `path=${enc(path)}${recursive === undefined ? '' : `&recursive=${recursive}`}`),
    );
  const at = (rel: string) => join(r.dir, rel);
  const isDir = (rel: string) => existsSync(at(rel)) && lstatSync(at(rel)).isDirectory();

  console.log(`\n${r.name} · new folder`);
  const made = await folder('notes/2026/oct');
  check('POST folder makes it, and the folders above it → 201', made.status === 201 && made.body.path === 'notes/2026/oct' && isDir('notes/2026/oct'), show(made));
  const tree = await send<FileTreeResponse>('GET', r.url('tree'));
  const node = flatten(tree.body.root).find((n) => n.path === 'notes/2026/oct');
  check('the empty folder is in the tree, as a folder', node?.type === 'dir', JSON.stringify(node));
  if (opts.git) {
    // git lists files, so an empty folder reaches the tree from `ls-files -o --directory`.
    put(r.dir, 'scratch/f.txt', 'f\n');
    mkdirSync(at('scratch/has/empty'), { recursive: true });
    mkdirSync(at('src/empty'));
    mkdirSync(at('node_modules/pkg'), { recursive: true });
    const listed = flatten((await send<FileTreeResponse>('GET', r.url('tree'))).body.root);
    const dirs = new Set(listed.filter((n) => n.type === 'dir').map((n) => n.path));
    check('an empty folder inside an untracked one, and one inside a tracked one, are listed', dirs.has('scratch/has/empty') && dirs.has('src/empty') && listed.some((n) => n.path === 'scratch/f.txt'), [...dirs].join(','));
    check('and the deny-list still keeps node_modules out', ![...dirs].some((d) => d.startsWith('node_modules')));
    rmSync(at('scratch'), { recursive: true });
    rmSync(at('src/empty'), { recursive: true });
    rmSync(at('node_modules'), { recursive: true });

    // Amendment 153: inside an untracked folder, an empty folder .gitignore excludes is not listed.
    put(r.dir, 'scratch/.gitignore', 'ign/\n*.tmp\n');
    for (const d of ['plain', 'ign/kid', 'x.tmp', 'deep/ign', 'deep/ok', 'nested/e']) mkdirSync(at(`scratch/${d}`), { recursive: true });
    sh(at('scratch/nested'), 'init', '-q');
    const reply = await send<FileTreeResponse>('GET', r.url('tree'));
    const shown = flatten(reply.body.root).filter((n) => n.type === 'dir').map((n) => n.path);
    // What git itself calls ignored here, the listing `git status --ignored` is built on.
    const gitIgnored = sh(r.dir, 'ls-files', '-o', '-i', '--directory', '--exclude-standard').split('\n').filter(Boolean);
    const underIgnored = shown.filter((d) => gitIgnored.some((g) => `${d}/`.startsWith(g)));
    check('git calls these ignored', ['scratch/ign/', 'scratch/x.tmp/', 'scratch/deep/ign/'].every((g) => gitIgnored.includes(g)), gitIgnored.join(','));
    check('an ignored empty folder under an untracked one is hidden, by name and by glob', !shown.includes('scratch/ign') && !shown.includes('scratch/x.tmp') && !shown.includes('scratch/deep/ign'), shown.join(','));
    check("and so are an ignored folder's own empty folders", !shown.includes('scratch/ign/kid'), shown.join(','));
    check('a plain empty folder under an untracked one is shown, at any depth', shown.includes('scratch/plain') && shown.includes('scratch/deep/ok'), shown.join(','));
    check('Files lists nothing git calls ignored', underIgnored.length === 0, underIgnored.join(','));
    check('a nested repo in the untracked folder still reads: 200, and its folder is there', reply.status === 200 && shown.includes('scratch/nested'), `${reply.status} ${shown.join(',')}`);
    rmSync(at('scratch'), { recursive: true });
  } else {
    // No git, so no .gitignore applies: every empty folder is listed (Amendment 153).
    put(r.dir, 'scratch/.gitignore', 'ign/\n');
    mkdirSync(at('scratch/ign/kid'), { recursive: true });
    mkdirSync(at('scratch/plain'));
    const shown = flatten((await send<FileTreeResponse>('GET', r.url('tree'))).body.root).map((n) => n.path);
    check('a folder with no git lists every empty folder, .gitignore or not', shown.includes('scratch/ign/kid') && shown.includes('scratch/plain'), shown.join(','));
    rmSync(at('scratch'), { recursive: true });
  }
  const again = await folder('notes/2026/oct');
  check('again → 409 "already exists"', again.status === 409 && /already exists$/.test(again.body.error), show(again));
  put(r.dir, 'plain.txt', 'x\n');
  const onFile = await folder('plain.txt');
  check('where a file is → 409, and the file is kept', onFile.status === 409 && readFileSync(at('plain.txt'), 'utf8') === 'x\n', show(onFile));
  const under = await folder('plain.txt/sub');
  check('under a file → 409 with its own sentence', under.status === 409 && /a folder in that name is a file/.test(under.body.error), show(under));
  const race = await Promise.all([folder('race'), folder('race'), folder('race')]);
  const codes = race.map((x) => x.status).sort().join(',');
  check('three at once under the lock: one 201, two 409', codes === '201,409,409', codes);
  const noBody = await send<Err>('POST', r.url('folders'), { path: '' });
  check('no path → 400', noBody.status === 400, show(noBody));

  console.log(`\n${r.name} · rename`);
  put(r.dir, 'r/one.md', 'one\n');
  const ren = await rename('r/one.md', 'r/two.md');
  check('a file → 200, old name gone, new one holds it', ren.status === 200 && ren.body.type === 'file' && ren.body.to === 'r/two.md' && !existsSync(at('r/one.md')) && readFileSync(at('r/two.md'), 'utf8') === 'one\n', show(ren));
  const missing = await rename('r/nope.md', 'r/x.md');
  check('from missing → 404', missing.status === 404 && /does not exist/.test(missing.body.error), show(missing));
  put(r.dir, 'r/three.md', 'three\n');
  const clash = await rename('r/two.md', 'r/three.md');
  check('to taken → 409, and both are as they were', clash.status === 409 && /r\/three\.md already exists/.test(clash.body.error) && readFileSync(at('r/two.md'), 'utf8') === 'one\n' && readFileSync(at('r/three.md'), 'utf8') === 'three\n', show(clash));
  const ontoDir = await rename('r/two.md', 'notes');
  check('to a folder that exists → 409', ontoDir.status === 409, show(ontoDir));
  const moved = await rename('r', 'q/r2');
  check('a folder → 200, moved with what is in it, folders above made', moved.status === 200 && moved.body.type === 'dir' && !existsSync(at('r')) && readFileSync(at('q/r2/three.md'), 'utf8') === 'three\n', show(moved));
  const into = await rename('q', 'q/r2/inner');
  check('a folder into itself → 400, nothing moved', into.status === 400 && /into itself/.test(into.body.error) && isDir('q/r2'), show(into));
  // A move is a rename into another folder: what the Files tree's drag and its Move to… send.
  put(r.dir, 'mv/a.md', 'a\n');
  put(r.dir, 'mv/sub/keep.md', 'keep\n');
  const down = await rename('mv/a.md', 'mv/sub/a.md');
  check('a move into a subfolder → 200, the file under it, what was there kept', down.status === 200 && down.body.to === 'mv/sub/a.md' && !existsSync(at('mv/a.md')) && readFileSync(at('mv/sub/a.md'), 'utf8') === 'a\n' && readFileSync(at('mv/sub/keep.md'), 'utf8') === 'keep\n', show(down));
  put(r.dir, 'mv/f/b.md', 'b\n');
  const dirDown = await rename('mv/f', 'mv/sub/f');
  check('a folder into a folder beside it → 200, with what is in it', dirDown.status === 200 && dirDown.body.type === 'dir' && !existsSync(at('mv/f')) && readFileSync(at('mv/sub/f/b.md'), 'utf8') === 'b\n', show(dirDown));
  put(r.dir, 'mv/sub/keep2.md', 'there\n');
  put(r.dir, 'mv/keep2.md', 'here\n');
  const taken = await rename('mv/keep2.md', 'mv/sub/keep2.md');
  check('a move onto a name taken in the subfolder → 409, both as they were', taken.status === 409 && /mv\/sub\/keep2\.md already exists/.test(taken.body.error) && readFileSync(at('mv/keep2.md'), 'utf8') === 'here\n' && readFileSync(at('mv/sub/keep2.md'), 'utf8') === 'there\n', show(taken));
  const same = await rename('q', 'q');
  check('to the same name → 400', same.status === 400, show(same));
  const noTo = await send<Err>('POST', r.url('rename'), { from: 'q' });
  check('no to → 400', noTo.status === 400, show(noTo));

  put(r.dir, 'target.txt', 'pointed at\n');
  symlinkSync('target.txt', at('lnk'));
  const link = await rename('lnk', 'lnk2');
  check('a link is moved as a link, its target untouched', link.status === 200 && lstatSync(at('lnk2')).isSymbolicLink() && readFileSync(at('target.txt'), 'utf8') === 'pointed at\n', show(link));

  put(r.dir, 'Case.md', 'case\n');
  const blind = caseBlind(r.dir);
  const caseOnly = await rename('Case.md', 'CASE.md');
  check(
    `a rename in case alone → 200 and the disk says CASE.md (${blind ? 'case-insensitive' : 'case-sensitive'} filesystem)`,
    caseOnly.status === 200 && readdirSync(r.dir).includes('CASE.md') && !readdirSync(r.dir).includes('Case.md'),
    show(caseOnly),
  );
  put(r.dir, 'other.md', 'other\n');
  const caseClash = await rename('other.md', 'case.md');
  check(
    blind
      ? 'another file onto a name that differs only in case → 409 (it is taken here)'
      : 'another file onto a name that differs only in case is a new name here → 200',
    blind ? caseClash.status === 409 && readFileSync(at('CASE.md'), 'utf8') === 'case\n' : caseClash.status === 200,
    show(caseClash),
  );

  console.log(`\n${r.name} · what a delete would take`);
  put(r.dir, 'q/r2/deep/x.log', 'x\n');
  const info = await entry('q');
  check('GET entry counts the files and folders on disk', info.status === 200 && info.body.type === 'dir' && info.body.files === 3 && info.body.folders === 2, show(info));
  check(opts.git ? 'and says how many git tracks (none of these)' : 'and says null for git, with no repo', opts.git ? info.body.tracked === 0 : info.body.tracked === null, show(info));
  if (opts.git) {
    const src = await entry('src');
    check('a tracked folder: git has both its files', src.body.tracked === 2 && src.body.files === 2, show(src));
  }
  const fileInfo = await entry('target.txt');
  check('a file is one file', fileInfo.body.type === 'file' && fileInfo.body.files === 1, show(fileInfo));
  const noEntry = await entry('nope');
  check('missing → 404', noEntry.status === 404, show(noEntry));

  console.log(`\n${r.name} · delete`);
  const file = await del('target.txt');
  check('a file → 200, gone', file.status === 200 && file.body.type === 'file' && !existsSync(at('target.txt')), show(file));
  const dangling = await del('lnk2');
  check('a link → the link goes', dangling.status === 200 && !existsSync(at('lnk2')) && !readdirSync(r.dir).includes('lnk2'), show(dangling));
  put(r.dir, 'keep.txt', 'keep\n');
  symlinkSync('keep.txt', at('lnk3'));
  await del('lnk3');
  check('and never what it points at', readFileSync(at('keep.txt'), 'utf8') === 'keep\n');
  const gone = await del('target.txt');
  check('missing → 404', gone.status === 404, show(gone));
  const full = await del('q');
  check('a folder with files in it, without recursive → 409, nothing goes', full.status === 409 && /not empty/.test(full.body.error) && /3 files/.test(full.body.error) && existsSync(at('q/r2/three.md')), show(full));
  const fullZero = await del('q', '0');
  check('recursive=0 is the same 409', fullZero.status === 409, show(fullZero));
  const badFlag = await del('q', 'yes');
  check('recursive=yes → 400, not a guess', badFlag.status === 400 && existsSync(at('q')), show(badFlag));
  const all = await del('q', '1');
  check('with recursive=1 → 200, the folder and its 3 files gone', all.status === 200 && all.body.type === 'dir' && all.body.files === 3 && !existsSync(at('q')), show(all));
  const empty = await del('notes/2026/oct');
  check('an empty folder, without recursive → 200, gone', empty.status === 200 && !existsSync(at('notes/2026/oct')) && isDir('notes/2026'), show(empty));
  mkdirSync(at('vendor/lib/.git'), { recursive: true });
  put(r.dir, 'vendor/lib/x.c', 'int x;\n');
  const repoInside = await del('vendor', '1');
  check('a folder with a git repository inside → 409 even with recursive, nothing goes', repoInside.status === 409 && /holds a git repository \(vendor\/lib\/\.git\)/.test(repoInside.body.error) && existsSync(at('vendor/lib/x.c')), show(repoInside));

  console.log(`\n${r.name} · the gate`);
  const bad = ['..', '../outside.txt', OUTSIDE, '/etc', '.git', '.git/hooks/pre-commit', '.GIT/config', 'src/../.git/x', '.', 'src/..', ''];
  for (const p of bad.filter((x) => x.length > 0)) {
    const f = await folder(p);
    const d = await del(p, '1');
    const e = await entry(p);
    const from = await rename(p, 'moved-here');
    const to = await rename('keep.txt', p);
    const ok = [f, d, e, from, to].every((x) => x.status === 400);
    check(`${JSON.stringify(p)} is refused by every verb → 400`, ok, [f, d, e, from, to].map((x) => x.status).join(','));
  }
  check('nothing outside was touched', readFileSync(OUTSIDE, 'utf8') === 'not yours\n' && readFileSync(at('keep.txt'), 'utf8') === 'keep\n');
  check('the root is still there', existsSync(r.dir) && isDir('src') === opts.git);
  if (opts.git) {
    symlinkSync('.git', at('gl'));
    const viaLink = await del('gl/config');
    const viaLinkDir = await folder('gl/hooks/evil');
    check('.git reached through a link is refused too', viaLink.status === 400 && viaLinkDir.status === 400 && existsSync(join(r.dir, '.git', 'config')), `${show(viaLink)} ${show(viaLinkDir)}`);
    rmSync(at('gl'));
  }
  symlinkSync(ROOT, at('up'));
  const outLink = await folder('up/escaped');
  check('a link out of the root is refused', outLink.status === 400 && !existsSync(join(ROOT, 'escaped')), show(outLink));
  rmSync(at('up'));
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  makeFolders();
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  // The bootstrap route opens a workspace only in a project's own folder (Amendment 152).
  const repoProject = insertProject(db, { path: REPO, name: 'verbs-repo', defaultBranch: 'main' });

  const opened = await send<Err>('POST', '/api/workspaces', {
    jobId: 'job_verbs',
    projectId: repoProject.id,
    repoPath: REPO,
    isolation: 'in_place',
  });
  check('a job opened on the repo, in place', opened.status === 201, show(opened));
  const project = insertProject(db, { path: PLAIN, name: 'verbs-plain', defaultBranch: 'main' });

  const job: Root = {
    name: 'job',
    dir: REPO,
    url: (verb, q) => `/api/jobs/job_verbs/${verb}${q ? `?${q}` : ''}`,
  };
  const folderRoot: Root = {
    name: 'project folder',
    dir: PLAIN,
    url: (verb, q) =>
      `/api/projects/${project.id}/dir/${verb}?dir=${encodeURIComponent(PLAIN)}${q ? `&${q}` : ''}`,
  };

  await verbsOn(job, { git: true });
  await verbsOn(folderRoot, { git: false });

  console.log('\nthe log hears of it, as it does of a write');
  const edits = () =>
    eventLog()
      .forJob('job_verbs')
      .flatMap((e) => (e.payload.kind === 'file_edit' ? [e.payload] : []));
  const before = edits().length;
  const ren = await send<RenameResponse>('POST', job.url('rename'), { from: 'src/a.ts', to: 'lib/a.ts' });
  await workspace().flush('job_verbs');
  const after = edits().slice(before);
  check('renaming a tracked file emits its deletion and the new file', ren.status === 200 && after.some((p) => p.path === 'src/a.ts' && p.deleted === true) && after.some((p) => p.path === 'lib/a.ts' && p.created === true), JSON.stringify(after));
  const mid = edits().length;
  const gone = await send<DeleteEntryResponse>('DELETE', job.url('entry', 'path=src&recursive=1'));
  await workspace().flush('job_verbs');
  const later = edits().slice(mid);
  check('deleting a folder emits each tracked file in it as deleted', gone.status === 200 && later.some((p) => p.path === 'src/b.ts' && p.deleted === true), JSON.stringify(later));
  const tree = await send<FileTreeResponse>('GET', job.url('tree'));
  const listed = flatten(tree.body.root);
  check('and the tree keeps the deleted file as a change to review', listed.some((n) => n.path === 'src/b.ts' && n.change?.deleted === true));

  const otherJob = await send<Err>('POST', '/api/jobs/job_nope/folders', { path: 'x' });
  check('a job with no workspace → 404', otherJob.status === 404, show(otherJob));
  const otherDir = await send<Err>('POST', `/api/projects/${project.id}/dir/folders?dir=${encodeURIComponent(ROOT)}`, { path: 'x' });
  check("a folder that is not one of the project's → 404", otherDir.status === 404 && !existsSync(join(ROOT, 'x')), show(otherDir));
  const noDir = await send<Err>('POST', `/api/projects/${project.id}/dir/folders`, { path: 'x' });
  check('no dir → 400', noDir.status === 400, show(noDir));

  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\nAmendment 138 files: PASS — ${checks} checks: new folder, rename and delete for a job and a project folder; 409s, 404s, the gate, the case-only rename, a move into a subfolder (Amendment 165), recursive delete, and the log; an empty folder .gitignore excludes is not listed (Amendment 153).\n`
      : `\nAmendment 138 files: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
