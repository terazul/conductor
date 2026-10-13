/**
 * Track C verification — the Files screen's tabs, as a pure model.  (Amendment 29)
 *
 *   pnpm --filter @conductor/web exec tsx src/files/verify.ts
 *
 * No daemon, no browser. `tabs.ts` decides what is open, which tab is in front, what a
 * deep link does and what survives a reload; the screen only draws it. Those are the
 * answers that were wrong before — a link opening against the wrong job, a screen
 * switch forgetting everything — and a wrong answer here still draws a tab.
 */

import {
  EMPTY,
  MAX_TABS,
  activate,
  activeTab,
  applyLink,
  arrive,
  closeTab,
  closeUnder,
  dirRoot,
  inColumn,
  isUnder,
  keyOf,
  linkOf,
  openTab,
  parseDirRoot,
  parseState,
  pickDone,
  renameTabs,
  renamedPath,
  rootEndpoint,
  selectJob,
  selectProject,
  serialize,
  setScroll,
  setView,
  tabKey,
  tabLabels,
  tabsUnder,
  toggleFolder,
  type FilesState,
} from './tabs.js';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileNode } from '@conductor/shared';
import { headingSlugs, resolveDocLink, type DocLink } from './links.js';
import { DEFAULT_NAME, checkName, prefill } from './naming.js';
import { pdfTitle } from './print.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const keys = (s: FilesState): string => s.tabs.map((t) => `${t.jobId}:${t.path ?? '∅'}`).join(' ');

console.log('\nopening and focusing');
{
  let s = openTab(EMPTY, 'j1', 'docs/PLAN.md', 1);
  check('opening a file adds a tab and puts it in front', s.tabs.length === 1 && s.active === tabKey('j1', 'docs/PLAN.md'));
  check("the tree follows the tab's job", s.job === 'j1');
  check('a new file tab starts rendered, at the top', s.tabs[0]!.view === 'rendered' && Object.keys(s.tabs[0]!.scroll).length === 0);

  s = openTab(s, 'j1', 'src/a.ts', 2);
  s = setView(s, tabKey('j1', 'docs/PLAN.md'), 'raw');
  s = setScroll(s, tabKey('j1', 'docs/PLAN.md'), 'raw', 840.4);
  s = openTab(s, 'j1', 'docs/PLAN.md', 3);
  check('opening a file that is already open focuses it, not a second copy', s.tabs.length === 2, keys(s));
  const plan = activeTab(s)!;
  check('and it comes back at its own view and scroll', plan.view === 'raw' && plan.scroll.raw === 840, JSON.stringify(plan));
  check('focusing marks it seen', plan.seen === 3);

  s = openTab(s, 'j2', 'docs/PLAN.md', 4);
  check('the same path in another job is another tab', s.tabs.length === 3 && s.job === 'j2', keys(s));

  const diff = openTab(s, 'j1', null, 5);
  check('the whole-worktree diff is a tab of its own, in diff view', activeTab(diff)!.path === null && activeTab(diff)!.view === 'diff');
  check('and the tree switches back to its job', diff.job === 'j1');

  check('activate() focuses by key', activate(s, tabKey('j1', 'src/a.ts'), 9).active === tabKey('j1', 'src/a.ts'));
  check('activate() on a key that is gone changes nothing', activate(s, 'nope', 9) === s);
}

console.log('\nthe cap');
{
  let s = EMPTY;
  for (let i = 0; i < MAX_TABS; i += 1) s = openTab(s, 'j', `f${i}`, i);
  s = openTab(s, 'j', 'f0', 100); // f0 is now recent; f1 is the oldest.
  s = openTab(s, 'j', 'new', 101);
  check(`past ${MAX_TABS} tabs, the one looked at longest ago goes`, s.tabs.length === MAX_TABS && !s.tabs.some((t) => t.path === 'f1'), keys(s));
  check('a tab you came back to is not the one evicted', s.tabs.some((t) => t.path === 'f0'));

  const unsaved = tabKey('j', 'f2');
  s = openTab(s, 'j', 'newer', 102, (k) => k === unsaved);
  check('a tab with an unsaved edit is spared', s.tabs.some((t) => t.path === 'f2') && !s.tabs.some((t) => t.path === 'f3'), keys(s));

  let all = EMPTY;
  for (let i = 0; i < MAX_TABS; i += 1) all = openTab(all, 'j', `e${i}`, i);
  all = openTab(all, 'j', 'one-more', 50, () => true);
  check('when every tab is unsaved, the cap gives way rather than an edit', all.tabs.length === MAX_TABS + 1);
}

console.log('\nclosing');
{
  let s = openTab(EMPTY, 'j1', 'a', 1);
  s = openTab(s, 'j2', 'b', 2);
  s = openTab(s, 'j1', 'c', 3);
  s = activate(s, tabKey('j2', 'b'), 4); // seen: a=1 c=3 b=4
  const closed = closeTab(s, tabKey('j2', 'b'));
  check('closing the front tab goes back to the one seen before it', closed.active === tabKey('j1', 'c'), String(closed.active));
  check("and the tree follows that tab's job", closed.job === 'j1');

  const behind = closeTab(s, tabKey('j1', 'a'));
  check('closing a tab behind leaves the front tab alone', behind.active === s.active && behind.tabs.length === 2);
  check('closing a key that is not open changes nothing', closeTab(s, 'nope') === s);

  let last = openTab(EMPTY, 'j1', 'a', 1);
  last = closeTab(last, tabKey('j1', 'a'));
  check('closing the last tab leaves nothing active, on the same job', last.active === null && last.job === 'j1');
  check('and does not queue a default pick you did not ask for', last.pick === null);
}

console.log('\nswitching jobs');
{
  let s = openTab(EMPTY, 'j1', 'a', 1);
  s = openTab(s, 'j1', 'b', 2);
  s = openTab(s, 'j2', 'x', 3);
  const back = selectJob(s, 'j1');
  check("choosing a job shows the tab you last had open in it", back.active === tabKey('j1', 'b') && back.job === 'j1');
  check('its tabs are all still there', back.tabs.length === 3);

  const fresh = selectJob(s, 'j3');
  check('a job with no tabs shows its tree and waits for the default pick', fresh.job === 'j3' && fresh.active === null && fresh.pick === 'j3');
  check('opening something clears the wait', openTab(fresh, 'j3', 'README.md', 9).pick === null);
  check('an empty tree clears it too', pickDone(fresh).pick === null);
  check('choosing the job already shown changes nothing', selectJob(back, 'j1') === back);
}

console.log('\ndeep links');
{
  let s = openTab(EMPTY, 'j1', 'a', 1);
  s = setScroll(s, tabKey('j1', 'a'), 'rendered', 300);

  check('`5` (no params) leaves everything where it was', applyLink(s, {}, 5) === s);
  check('a link with a path but no job is not a link', applyLink(s, { path: 'x' }, 5) === s && linkOf({ path: 'x' }) === null);

  const toFile = applyLink(s, { jobId: 'j2', path: 'docs/PLAN.md' }, 5);
  check('a link to a file opens it, against the job it names', toFile.active === tabKey('j2', 'docs/PLAN.md') && toFile.job === 'j2');
  check('the tab you had open is still there to go back to', toFile.tabs.some((t) => keyOf(t) === tabKey('j1', 'a') && t.scroll.rendered === 300));
  check('the link is remembered', toFile.link === tabKey('j2', 'docs/PLAN.md'));

  const again = applyLink(toFile, { jobId: 'j1', path: 'a' }, 6);
  check('a link to a file already open focuses it', again.tabs.length === 2 && again.active === tabKey('j1', 'a'));

  const toJob = applyLink(s, { jobId: 'j1' }, 7);
  check('a link naming only a job shows that job at its last tab', toJob.active === tabKey('j1', 'a') && toJob.link === tabKey('j1', null));
  check('an empty path is no path', linkOf({ jobId: 'j1', path: '' }) === tabKey('j1', null));
}

console.log('\nfolders');
{
  let s = toggleFolder(EMPTY, 'j', 'src', true);
  check('closing an open folder remembers it closed', s.folders['j']!.collapsed.includes('src'));
  s = toggleFolder(s, 'j', 'docs/adr', false);
  check('opening a closed folder remembers it opened', s.folders['j']!.opened.includes('docs/adr'));
  s = toggleFolder(s, 'j', 'src', false);
  check('opening it again forgets it was closed', !s.folders['j']!.collapsed.includes('src') && s.folders['j']!.opened.includes('src'));

  let hidden = toggleFolder(EMPTY, 'j', 'src', true);
  hidden = toggleFolder(hidden, 'j', 'src/api', true);
  hidden = toggleFolder(hidden, 'j', 'docs', true);
  const shown = openTab(hidden, 'j', 'src/api/client.ts', 1);
  check("opening a file opens the folders it's in", !shown.folders['j']!.collapsed.includes('src') && !shown.folders['j']!.collapsed.includes('src/api'));
  check('and leaves other folders as you left them', shown.folders['j']!.collapsed.includes('docs'));
  check('folders are per job', openTab(hidden, 'k', 'src/api/client.ts', 1).folders['j']!.collapsed.includes('src'));
}

console.log('\nview and scroll');
{
  const s = openTab(EMPTY, 'j', 'a.md', 1);
  const k = tabKey('j', 'a.md');
  check('setting the view it already has is the same state', setView(s, k, 'rendered') === s);
  const once = setScroll(s, k, 'raw', 12);
  check('a new scroll position is a new state', once !== s && once.tabs[0]!.scroll.raw === 12);
  check('…so scrolling in place costs no render', setScroll(once, k, 'raw', 12.2) === once);
  check('scroll is per view', setScroll(once, k, 'rendered', 90).tabs[0]!.scroll.raw === 12);
  check('scroll never goes negative', setScroll(s, k, 'raw', -40).tabs[0]!.scroll.raw === 0);
}

console.log('\nsurviving a reload');
{
  let s = openTab(EMPTY, 'j1', 'docs/PLAN.md', 1);
  s = openTab(s, 'j2', null, 2);
  s = setScroll(s, tabKey('j1', 'docs/PLAN.md'), 'rendered', 1200);
  s = toggleFolder(s, 'j1', 'src', true);
  s = applyLink(s, { jobId: 'j1', path: 'docs/PLAN.md' }, 3);
  const round = parseState(serialize(s));
  check('tabs, the front tab, folders and scroll come back as they were', JSON.stringify(round) === JSON.stringify(s), serialize(round));

  for (const junk of [null, '', 'not json', '42', '[]', '{"tabs":"x"}']) {
    check(`junk in storage (${JSON.stringify(junk)}) is an empty screen, not a broken one`, JSON.stringify(parseState(junk)) === JSON.stringify(EMPTY));
  }

  const repaired = parseState(
    JSON.stringify({
      tabs: [
        { jobId: 'j1', path: 'a', view: 'nonsense', scroll: { raw: 'x', rendered: 40, diff: -3 }, seen: 1 },
        { jobId: 'j1', path: 'a', view: 'raw', seen: 5 },
        { jobId: '', path: 'b' },
        { jobId: 'j1', path: 7 },
        { jobId: 'j1' },
        { jobId: 'j2', path: null, view: 'diff', seen: 2 },
      ],
      active: 'j9\u0000gone',
      job: 'j2',
      folders: { j1: { collapsed: ['src', 3], opened: 'x' }, gone: { collapsed: ['a'], opened: [] } },
      pick: 'j1',
    }),
  );
  check('bad tabs are dropped and duplicates kept once', keys(repaired) === 'j1:a j2:∅', keys(repaired));
  check('the later of two duplicates wins', repaired.tabs[0]!.view === 'raw');
  check('a front tab that is not open is none', repaired.active === null && repaired.job === 'j2');
  check("folders of jobs with no tabs are pruned, and bad entries in a job's lists", repaired.folders['gone'] === undefined && JSON.stringify(repaired.folders['j1']) === '{"collapsed":["src"],"opened":[]}');
  check('a pending pick for a job not shown is dropped', repaired.pick === null);

  const view = parseState(JSON.stringify({ tabs: [{ jobId: 'j', path: 'a', view: 'nonsense', scroll: { rendered: 40, raw: 'x', diff: -3 } }] }));
  check('an unknown view falls back to rendered, and only sane scroll positions survive', view.tabs[0]!.view === 'rendered' && JSON.stringify(view.tabs[0]!.scroll) === '{"rendered":40}');

  const front = parseState(JSON.stringify({ tabs: [{ jobId: 'j1', path: 'a' }], active: tabKey('j1', 'a'), job: 'j2' }));
  check("the tree's job follows the front tab, whatever was stored", front.job === 'j1');

  const many = parseState(JSON.stringify({ tabs: Array.from({ length: MAX_TABS + 6 }, (_, i) => ({ jobId: 'j', path: `f${i}`, seen: i })) }));
  check('more tabs than the cap keeps the most recently seen', many.tabs.length === MAX_TABS && many.tabs[0]!.path === 'f6', keys(many));
}

console.log("\na project's directories (Amendment 39)");
{
  const a = dirRoot('prj_a', '/Users/me/code/api');
  const odd = dirRoot('prj_a', '/tmp/x:y/z');
  check('a directory root names its project and path', JSON.stringify(parseDirRoot(a)) === '{"projectId":"prj_a","dir":"/Users/me/code/api"}');
  check('a colon in the path survives the round trip', parseDirRoot(odd)?.dir === '/tmp/x:y/z', JSON.stringify(parseDirRoot(odd)));
  check("a job's id is not a directory root", parseDirRoot('j1') === null && parseDirRoot('dir:') === null && parseDirRoot('dir:prj_a:') === null);

  check(
    "a directory's reads go to the project, with the directory in the query",
    rootEndpoint(odd, 'file', 'docs/a b.md') === '/api/projects/prj_a/dir/file?dir=%2Ftmp%2Fx%3Ay%2Fz&path=docs%2Fa+b.md',
    rootEndpoint(odd, 'file', 'docs/a b.md'),
  );
  check("a job's reads stay on the job", rootEndpoint('j1', 'tree') === '/api/jobs/j1/tree' && rootEndpoint('j1', 'diff', 'a') === '/api/jobs/j1/diff?path=a');

  const b = dirRoot('prj_a', '/Users/me/code/web');
  const other = dirRoot('prj_b', '/Users/me/code/api');
  let s = selectProject(EMPTY, 'prj_a', a);
  check('choosing a project waits to open something in its first directory', s.project === 'prj_a' && s.job === null && s.pick === a && s.active === null);
  check('the column holds that project\'s directories and no other\'s', inColumn(s, a) && inColumn(s, b) && !inColumn(s, other) && !inColumn(s, 'j1'));

  s = openTab(s, b, 'README.md', 1);
  check('opening a file in a directory clears the wait', s.pick === null && s.project === 'prj_a');
  s = selectJob(s, 'j1');
  check('a job can sit beside the directories', s.project === 'prj_a' && s.job === 'j1' && inColumn(s, a) && inColumn(s, 'j1'));
  s = openTab(s, a, 'x.ts', 2);
  check("opening in the same project's directory keeps the job beside it", s.job === 'j1' && s.project === 'prj_a');
  const away = openTab(s, other, 'y.ts', 3);
  check("opening in another project's directory shows that project alone", away.project === 'prj_b' && away.job === null);

  const none = selectJob(s, null);
  check('no job keeps the directory tab in front', none.job === null && none.active === tabKey(a, 'x.ts'));
  const back = selectProject(away, 'prj_a', a);
  check('coming back to a project finds the last tab you had in it', back.active === tabKey(a, 'x.ts') && back.pick === null && back.job === null);

  const link = applyLink(EMPTY, { jobId: b }, 4);
  check("a link to a directory shows its project", link.project === 'prj_a' && link.pick === b);
  const file = applyLink(EMPTY, { jobId: b, path: 'README.md' }, 5);
  check('a link to a file in a directory opens it there', file.project === 'prj_a' && activeTab(file)?.jobId === b);

  // Arriving (Amendment 91's one rule, which widens Amendment 44's): a link naming a job or
  // a file wins outright (tested above, via `applyLink`); otherwise the route's own project,
  // else the one last remembered anywhere, else — only on a blank screen — the first.
  const B = { id: 'prj_b', first: other };
  const A = { id: 'prj_a', first: a };
  const onRoute = arrive(back, { route: B, remembered: A, first: A }, false);
  check(
    "the route's own project wins, even over what was remembered",
    onRoute.project === 'prj_b' && onRoute.job === null && onRoute.active === tabKey(other, 'y.ts'),
    JSON.stringify({ p: onRoute.project, active: onRoute.active }),
  );
  const onRemembered = arrive(back, { route: null, remembered: B, first: A }, false);
  check('with no route project, the remembered one wins instead', onRemembered.project === 'prj_b' && onRemembered.job === null, JSON.stringify({ p: onRemembered.project }));
  check('one never opened there waits to open its first directory', arrive(EMPTY, { route: B, remembered: null, first: A }, false).pick === other);
  check('arriving on the project Files already shows changes nothing — your tab stays in front', arrive(back, { route: A, remembered: B, first: B }, false) === back);
  check("a link decides for itself: the route and remembered projects stay out of it", arrive(back, { route: B, remembered: B, first: B }, true) === back);
  check(
    "another project's job already open gives way to the route's project",
    arrive(s, { route: B, remembered: A, first: A }, false).job === null && arrive(s, { route: B, remembered: A, first: A }, false).project === 'prj_b',
  );
  check(
    "another project's job already open gives way to the remembered project too",
    arrive(s, { route: null, remembered: B, first: A }, false).job === null && arrive(s, { route: null, remembered: B, first: A }, false).project === 'prj_b',
  );
  check('with nothing named at all, Files keeps what it had', arrive(back, { route: null, remembered: null, first: B }, false) === back);
  check('and with nothing shown and nothing named, it opens the first project', arrive(EMPTY, { route: null, remembered: null, first: A }, false).project === 'prj_a');
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  const projectSrc = readFileSync(new URL('../fleet/project.tsx', import.meta.url), 'utf8');
  const agentSrc = readFileSync(new URL('../agent/agent.tsx', import.meta.url), 'utf8');
  check('the Project screen says which project it has selected, fallback included', /if \(project\) highlight\(project\.id\)/.test(projectSrc));
  check('the Agent screen says which project it has loaded, once the agent is known (Amendment 91)', /if \(agent\) highlight\(agent\.projectId\)/.test(agentSrc));
  check("Files reads the route's own project, not only a job link", /params\['projectId'\]/.test(src));
  check('Files asks for the remembered project, and says which one it shows', /recall\(\)\.projectId/.test(src) && /highlight\(projectId\)/.test(src));

  const round = parseState(serialize(toggleFolder(back, b, 'src', true)));
  check('the project and its folders survive a reload', round.project === 'prj_a' && round.folders[b]?.collapsed.includes('src') === true, serialize(round));
  const stale = parseState(JSON.stringify({ project: 'prj_a', pick: other, folders: { [other]: { collapsed: ['x'], opened: [] } } }));
  check("another project's pick and folders are dropped on reload", stale.pick === null && stale.folders[other] === undefined);
}

console.log('\nlabels');
{
  const one = (s: FilesState) => tabLabels(s.tabs, (id) => `job ${id}`);
  let s = openTab(EMPTY, 'j1', 'docs/PLAN.md', 1);
  s = openTab(s, 'j1', 'src/index.ts', 2);
  check('a tab is labelled by file name', one(s)[0]!.name === 'PLAN.md' && one(s)[0]!.dir === null && one(s)[0]!.job === null);

  s = openTab(s, 'j1', 'packages/web/src/index.ts', 3);
  const clash = one(s);
  check('two tabs with the same name show their folders', clash[1]!.dir === 'src' && clash[2]!.dir === 'packages/web/src', JSON.stringify(clash));
  check('a name that is not shared shows no folder', clash[0]!.dir === null);

  s = openTab(s, 'j2', null, 4);
  const jobs = one(s);
  check('once tabs span jobs, each says which', jobs.every((l, i) => l.job === `job ${s.tabs[i]!.jobId}`));
  check('the whole diff is labelled as such', jobs[3]!.name === 'full diff' && jobs[3]!.dir === null);

  const top = one(openTab(openTab(EMPTY, 'j', 'index.ts', 1), 'j', 'src/index.ts', 2));
  check('a clash at the top level says so', top[0]!.dir === '/');
}

console.log('\nlinks inside a rendered file');
{
  const from = 'API-Gateway/internal-api-gateway-vs-istio-ingress.md';
  const tree = new Set([
    from,
    'API-Gateway/notes.md',
    'Service-Mesh/learnings-service-mesh.md',
    'README.md',
    'docs/my notes.md',
    'docs/img/flow.png',
  ]);
  const has = (p: string): boolean => tree.has(p);
  const to = (l: DocLink): string => (l.kind === 'file' ? l.path : l.kind);

  check(
    "`../` from a file climbs out of the file's folder, not the app's",
    to(resolveDocLink('../Service-Mesh/learnings-service-mesh.md', from, has)) ===
      'Service-Mesh/learnings-service-mesh.md',
  );
  check(
    'a bare name is next to the file',
    to(resolveDocLink('notes.md', from, has)) === 'API-Gateway/notes.md' &&
      to(resolveDocLink('./notes.md', from, has)) === 'API-Gateway/notes.md',
  );
  check(
    "a folder-first link the file's folder doesn't have, but the repo root does, is the root's",
    to(resolveDocLink('Service-Mesh/learnings-service-mesh.md', from, has)) ===
      'Service-Mesh/learnings-service-mesh.md',
  );
  check(
    "the file's folder still wins when it has the file",
    to(resolveDocLink('notes.md', 'API-Gateway/sub/x.md', (p) => p === 'API-Gateway/sub/notes.md' || p === 'notes.md')) ===
      'API-Gateway/sub/notes.md',
  );
  check(
    "without a tree, or when neither has it, the markdown rule stands: the file's folder",
    to(resolveDocLink('Service-Mesh/learnings-service-mesh.md', from)) ===
      'API-Gateway/Service-Mesh/learnings-service-mesh.md' &&
      to(resolveDocLink('gone.md', from, has)) === 'API-Gateway/gone.md',
  );
  check('a leading slash is the repo root', to(resolveDocLink('/README.md', from, has)) === 'README.md');
  check(
    'a query or fragment on a file link is dropped, the file kept',
    to(resolveDocLink('../README.md#setup', from, has)) === 'README.md' &&
      to(resolveDocLink('notes.md?plain=1', from, has)) === 'API-Gateway/notes.md',
  );
  check(
    'an escaped name is the name on disk',
    to(resolveDocLink('../docs/my%20notes.md', from, has)) === 'docs/my notes.md',
  );
  check(
    'an escaped separator is not a way into another folder',
    to(resolveDocLink('..%2F..%2Fetc%2Fpasswd', from, has)) === 'none' &&
      to(resolveDocLink('%2e%2e/%2e%2e/secret', from, has)) === 'none',
  );
  check(
    'a link that climbs out of the worktree goes nowhere',
    to(resolveDocLink('../../outside.md', from, has)) === 'none' &&
      to(resolveDocLink('/../x.md', from, has)) === 'none',
  );
  check(
    'the web is left to the browser',
    ['https://istio.io/latest/docs/', 'http://x.test', 'mailto:a@b.test'].every(
      (h) => resolveDocLink(h, from, has).kind === 'external',
    ),
  );
  check(
    'another host, a backslash, or nothing at all is not a link',
    ['//evil.test/x.md', 'a\\b.md', '', '   '].every((h) => resolveDocLink(h, from, has).kind === 'none'),
  );
  const anchor = resolveDocLink('#Traffic%20Flow', from, has);
  check(
    '`#section` is a heading in this file',
    anchor.kind === 'anchor' && anchor.slug === 'Traffic Flow',
    JSON.stringify(anchor),
  );
  check(
    'an image beside the file resolves the same way',
    to(resolveDocLink('../docs/img/flow.png', from, has)) === 'docs/img/flow.png',
  );
  check(
    "headings answer to GitHub's slugs, repeats numbered",
    headingSlugs(['Traffic Flow', 'mTLS & Istio: 2024?', 'Traffic Flow', 'Überblick']).join(' ') ===
      'traffic-flow mtls--istio-2024 traffic-flow-1 überblick',
    headingSlugs(['Traffic Flow', 'mTLS & Istio: 2024?', 'Traffic Flow', 'Überblick']).join(' '),
  );
}

console.log('\nprinting a rendered file (Amendment 32)');
{
  check('the PDF is named for the file', pdfTitle('docs/Traffic Flow.md') === 'Traffic Flow', pdfTitle('docs/Traffic Flow.md'));
  check('any markdown extension is dropped', ['a.markdown', 'a.MD', 'a.mdx'].every((p) => pdfTitle(p) === 'a'));
  check('a name that is only an extension keeps it', pdfTitle('x/.md') === '.md', pdfTitle('x/.md'));

  const css = readFileSync(new URL('./files.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('@media print'));
  check('print hides everything but the sheet', /body > :not\(\.c5-print\)\s*\{\s*display: none !important;/.test(print));
  check('and the sheet never shows on screen', /\.c5-print \{\s*display: none;/.test(css.slice(0, css.indexOf('@media print'))));
  const tokens = readFileSync(new URL('../../../shared/src/tokens.css', import.meta.url), 'utf8');
  check(
    'the light tokens apply to the sheet, not only to <html>',
    tokens.includes(":root[data-theme='light'], [data-theme='light'] {"),
  );
}

{
  const pane = readFileSync(new URL('./FilePane.tsx', import.meta.url), 'utf8');
  check('a rendered file draws its mermaid blocks, and again when the theme changes (Amendment 60)', /querySelectorAll<HTMLElement>\('pre\.md-mermaid'\)/.test(pane) && /\[file\.html, shown, theme\]/.test(pane));
  check("and one it can't draw keeps its source, with the reason", /Couldn't draw this diagram/.test(pane) && /pre\.hidden = true;/.test(pane));
}

console.log('\na nested repo\'s branch, beside its folder (Amendment 94)');
{
  const tree = readFileSync(new URL('./FileTree.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./files.css', import.meta.url), 'utf8');
  check(
    'a directory with repo set shows its branch, or "detached" when there is none',
    /kid\.repo && <span className="c5-repo">⑂ \{kid\.repo\.branch \?\? 'detached'\}<\/span>/.test(tree),
  );
  check('a plain directory with no repo field shows nothing extra', /\{kid\.repo && /.test(tree));
  check('the mark is quiet — ink3, no status colour', /\.c5-repo\s*\{[^}]*color:\s*var\(--ink3\)/.test(css));
}

console.log('\na new file from the tree (Amendment 121)');
{
  const named = (raw: string): string => {
    const c = checkName(raw);
    return c.ok ? c.path : `refused: ${c.reason}`;
  };

  // The box starts with the folder in it, and the file name selected.
  const root = prefill('');
  check('at the root the box offers a default name', root.value === DEFAULT_NAME && DEFAULT_NAME === 'untitled.md', root.value);
  const deep = prefill('docs/notes');
  check('in a folder the name starts with the folder shown', deep.value === 'docs/notes/untitled.md', deep.value);
  check('and only the file name is selected, not its extension or the folder', deep.value.slice(deep.from, deep.to) === 'untitled', deep.value.slice(deep.from, deep.to));
  check('a stray slash on the folder does not double up', prefill('/docs/').value === 'docs/untitled.md');

  // What is typed becomes the path to send.
  check('a plain name is the path', named('notes.txt') === 'notes.txt');
  check('a name with folders in it is allowed: the daemon makes them', named('docs/notes/x.md') === 'docs/notes/x.md');
  check('spaces around it are not part of it', named('  docs/x.md \n') === 'docs/x.md');
  check('empty segments and . are dropped, so the tab opens under the path that was written', named('docs//./x.md') === 'docs/x.md' && named('./x.md') === 'x.md');
  check('a name with no extension is a name', named('Makefile') === 'Makefile' && named('docs/.env.example') === 'docs/.env.example');
  check('nothing typed is refused', named('') .startsWith('refused') && named('   ').startsWith('refused') && named('/./').startsWith('refused'));
  check('.. is refused, at the start and in the middle', named('../x.md').startsWith('refused') && named('docs/../../x.md').startsWith('refused'));
  check('an absolute path is refused', named('/etc/x').startsWith('refused') && named('C:/x').startsWith('refused'));
  check('.git is refused at any depth and in any case', ['.git/hooks/x', 'a/.git/config', '.GIT/x', 'a/.Git'].every((n) => named(n).startsWith('refused')));
  check('a name that merely starts with .git is fine', named('.gitignore') === '.gitignore' && named('.github/ci.yml') === '.github/ci.yml');
  check('a trailing slash names a folder, which is not a file', named('docs/').startsWith('refused'));
  check('a backslash and a control character are refused', named('a\\b.md').startsWith('refused') && named('a\u0000b').startsWith('refused') && named('a\nb').startsWith('refused'));
  check('one name too long for the filesystem is refused', named(`${'a'.repeat(256)}.md`).startsWith('refused') && !named(`${'a'.repeat(200)}.md`).startsWith('refused'));
  check('every refusal is a sentence a person can act on', ['', '../x', '/x', '.git/x', 'a/', 'a\\b', 'a\u0000'].every((n) => /^refused: [A-Z][^\n]*\.$/.test(named(n))), named('../x'));

  // The control, drawn: a + on each folder row, beside its button and not inside it.
  const { FileTree } = await import('./FileTree.js');
  const node = (path: string, type: 'file' | 'dir', children?: FileNode[]): FileNode => ({
    path,
    name: path.split('/').pop() ?? path,
    type,
    ...(children ? { children } : {}),
  });
  const top = node('', 'dir', [
    node('docs', 'dir', [node('docs/notes', 'dir', [node('docs/notes/a.md', 'file')]), node('docs/b.md', 'file')]),
    node('src', 'dir', []),
    node('README.md', 'file'),
  ]);
  const props = {
    root: top,
    selected: null,
    onSelect: () => {},
    folders: undefined,
    onToggle: () => {},
    touches: new Map(),
    roles: new Map(),
    now: 0,
  };
  const draw = (extra: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(FileTree, { ...props, ...extra }));
  const noop = async (): Promise<void> => {};
  const wired = { adding: null, onAdd: () => {}, onCreate: noop, onCancelAdd: () => {} };

  const plain = draw({});
  check('without the new-file props the tree is as it was: no +, no box', !plain.includes('c5-add') && !plain.includes('c5-newfile'));

  const withPlus = draw(wired);
  const adds = [...withPlus.matchAll(/<button[^>]*class="c5-iconbtn c5-add"[^>]*aria-label="New file in ([^"]*)"/g)].map((m) => m[1]);
  check('every folder row has a +, the open ones and the empty ones too', adds.join(',') === 'docs,docs/notes,src', adds.join(','));
  check('and a file row has none', !/c5-row[^>]*>(?:(?!<\/button>).)*README\.md(?:(?!<\/button>).)*<\/button><button[^>]*c5-add/.test(withPlus) && adds.length === 3);
  check('the + is not inside the row button (a button in a button is invalid)', /<div class="c5-dirrow"><button[^>]*class="c5-row dir"[^>]*>(?:(?!<\/button>).)*<\/button><button[^>]*c5-add/.test(withPlus));
  check('arrow-key movement still walks the rows alone', !/class="c5-row[^"]*"[^>]*c5-add/.test(withPlus) && /button\.c5-row/.test(readFileSync(new URL('./FileTree.tsx', import.meta.url), 'utf8')));
  check('no box is open until one is asked for', !withPlus.includes('c5-newfile'));

  const rootBox = draw({ ...wired, adding: '' });
  check('the root\'s box is the first row, with the default name in it', rootBox.indexOf('c5-newfile') > -1 && rootBox.indexOf('c5-newfile') < rootBox.indexOf('c5-dirrow') && rootBox.includes(`value="${DEFAULT_NAME}"`), rootBox.slice(0, 200));
  const folderBox = draw({ ...wired, adding: 'docs/notes', folders: { collapsed: [], opened: ['docs/notes'] } });
  check('a folder\'s box is under its row with the folder already filled in', folderBox.includes('value="docs/notes/untitled.md"') && folderBox.indexOf('c5-newfile') > folderBox.indexOf('>notes/<') && folderBox.indexOf('c5-newfile') < folderBox.indexOf('a.md'), folderBox.slice(0, 200));
  check('only that one box is open', (folderBox.match(/c5-newfile/g) ?? []).length === 1);
  check('it says which folder it is for', folderBox.includes('aria-label="name of the new file in docs/notes"') && rootBox.includes('aria-label="name of the new file in the top"'));
  const foldedBox = draw({ ...wired, adding: 'src' });
  check('an empty folder gets its box too, and the tree does not say "no files"', foldedBox.includes('value="src/untitled.md"') && !foldedBox.includes('no files'));
  check('the box has a way for the mouse to create and to cancel', /aria-label="create the file"/.test(rootBox) && /aria-label="cancel"/.test(rootBox));

  const form = readFileSync(new URL('./NewFileForm.tsx', import.meta.url), 'utf8');
  check('Escape puts the box away, Enter makes the file', /e\.key === 'Escape'[\s\S]*?onCancel\(\)/.test(form) && /e\.key === 'Enter'[\s\S]*?submit\(\)/.test(form));
  check('arrow keys in the box are not taken by the tree', /onKeyDown=\{\(e\) => \{\s*e\.stopPropagation\(\)/.test(form));
  check('a refusal shows under the box, as an alert, in the daemon\'s words', /setError\(errorText\(err\)\)/.test(form) && /role="alert"/.test(form) && /const named = k\.check\(value\)/.test(form) && /file: \{ start: prefill, check: \(v\) => checkName\(v\)/.test(form));
  check('a refusal leaves what was typed to be fixed, and clears when it is edited', /setBusy\(false\)/.test(form) && /onChange=\{\(e\) => \{\s*setValue\(e\.target\.value\);\s*setError\(null\)/.test(form));

  // Making it: the request, the refresh, the tab.
  const { createFile, writeFile, askedOf } = await import('./useWorkspace.js');
  const { errorText } = await import('../lib/errors.js');
  const { openNew, takeFocus, editOf, getFiles } = await import('./useTabs.js');
  const real = globalThis.fetch;
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { path: 'docs/x.md', raw: '', html: '' } };
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {} });
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    };
  }) as unknown as typeof fetch;
  try {
    const before = askedOf('j-new');
    const made = await createFile('j-new', 'docs/x.md');
    check('a new file is a PUT of nothing, to be made only if new', sent[0]?.method === 'PUT' && sent[0].url === '/api/jobs/j-new/file' && JSON.stringify(sent[0].body) === '{"path":"docs/x.md","content":"","createOnly":true}', JSON.stringify(sent[0]));
    check('the answer is the empty file', made.raw === '' && made.path === 'docs/x.md');
    check("the root's tree is told to read again after the write", askedOf('j-new') === before + 1);

    const dir = dirRoot('prj_n', '/Users/me/my code');
    const dirBefore = askedOf(dir);
    await createFile(dir, 'docs/x.md');
    check("a project folder's write goes to the project, and its never-watched tree is read again", sent[1]?.url === '/api/projects/prj_n/dir/file?dir=%2FUsers%2Fme%2Fmy%20code' && sent[1].body['createOnly'] === true && askedOf(dir) === dirBefore + 1, sent[1]?.url);
    check("and only that root's", askedOf('j-new') === before + 1);

    await writeFile('j-new', 'docs/x.md', 'edited');
    check('saving an edit still replaces: no createOnly in it', sent[2]?.method === 'PUT' && !('createOnly' in (sent[2]?.body ?? {})) && sent[2]?.body['content'] === 'edited', JSON.stringify(sent[2]?.body));
    check('and does not ask for a re-read, which the pane does itself', askedOf('j-new') === before + 1);

    reply = { status: 409, body: { error: 'docs/x.md already exists' } };
    const askedNow = askedOf('j-new');
    let refusal: unknown = null;
    await createFile('j-new', 'docs/x.md').catch((err: unknown) => {
      refusal = err;
    });
    check('a name that is taken rejects with the daemon\'s sentence', errorText(refusal) === 'docs/x.md already exists', errorText(refusal));
    check('and a refused write does not refresh anything', askedOf('j-new') === askedNow);
    reply = { status: 400, body: { error: 'invalid path', detail: 'refusing path "../x": resolves outside the worktree' } };
    let escape: unknown = null;
    await createFile('j-new', '../x').catch((err: unknown) => {
      escape = err;
    });
    check('a path the daemon refuses shows why', errorText(escape).includes('resolves outside the worktree'), errorText(escape));
  } finally {
    globalThis.fetch = real;
  }

  // Then it is open, and the editor is on it.
  const k = tabKey('j-new', 'docs/x.md');
  openNew('j-new', 'docs/x.md', '', true);
  check('the new file is open in front', getFiles().active === k && getFiles().tabs.some((t) => keyOf(t) === k));
  const started = editOf(k);
  check('with the editor started on an empty draft, nothing unsaved yet', started !== null && started.draft === '' && started.base === '');
  check('and the cursor asked for, once', takeFocus(k) === true && takeFocus(k) === false);

  const img = tabKey('j-new', 'pic.png');
  openNew('j-new', 'pic.png', '', false);
  check('a file the pane cannot edit, such as an image, opens without an editor', getFiles().active === img && editOf(img) === null && takeFocus(img) === false);

  // The caller: make, open, close the box; the box stays up if the make fails.
  const route = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check(
    'the tree makes the file, opens what the daemon named, and closes the box only after',
    /const made = await createFile\(r\.root, path\);\s*openNew\(r\.root, made\.path, made\.raw, !isImagePath\(made\.path\)\);\s*setAdding\(null\);/.test(route),
  );
  check('the root has a + beside its name, once its tree has loaded', /\{tree\.data && \(\s*<button[^>]*onClick=\{\(\) => setAdding\(adding === '' \? null : ''\)\}/.test(route));
  check('the tree is handed the box: which folder, how to open it, make, cancel', /adding=\{adding\}\s*onAdd=\{setAdding\}\s*onCreate=\{create\}\s*onCancelAdd=\{\(\) => setAdding\(null\)\}/.test(route));

  const pane = readFileSync(new URL('./FilePane.tsx', import.meta.url), 'utf8');
  check('the editor takes the cursor when a tab opens already editing', /started\.current \|\| takeFocus\(tabKey\)/.test(pane));
  check('an empty file draws a line saying so, rather than a blank pane', /file\.raw\.length === 0 \? \(\s*(?:\/\/[^\n]*\n\s*)*<div className="c5-note c5-emptyfile">/.test(pane) && /This file is empty\./.test(pane));
  check('and an empty draft still edits: the buffer is read with ?? and not ||', /const draft = edit\?\.draft \?\? file\.raw;/.test(pane));

  const css = readFileSync(new URL('./files.css', import.meta.url), 'utf8');
  check('the + shows on hover and focus, and always where there is no hover', /\.c5-dirrow:hover \.c5-add,[^{]*\.c5-dirrow:focus-within \.c5-add[^{]*\{\s*opacity: 1;/.test(css) && /@media \(hover: none\)\s*\{\s*\.c5-add\s*\{\s*opacity: 1;/.test(css));
  const mine = css.slice(css.indexOf('a new file from the tree (Amendment 121)'));
  check('it is drawn in existing tokens only, so both themes get it', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(mine) && /var\(--fail\)/.test(mine) && /var\(--live\)/.test(mine));
}

console.log('\nnew folder, rename and delete (Amendment 138)');
{
  // ── tabs follow a rename, as pure functions ──
  const base = [
    ['j', 'docs/a.md'],
    ['j', 'docs/sub/b.md'],
    ['j', 'docs2/c.md'],
    ['j', 'other.md'],
    ['k', 'docs/a.md'],
  ].reduce<FilesState>((st, [root, p], i) => openTab(st, root!, p!, 100 + i), EMPTY);
  const front = activate(base, tabKey('j', 'docs/sub/b.md'), 200);
  const withFolders = toggleFolder(toggleFolder(front, 'j', 'docs/sub', true), 'j', 'docs2', false);
  check('a path is under a folder only by whole segments', isUnder('docs/a.md', 'docs') && isUnder('docs', 'docs') && !isUnder('docs2/c.md', 'docs'));
  check('renamedPath moves what is in the folder and nothing beside it', renamedPath('docs/sub/b.md', 'docs', 'notes') === 'notes/sub/b.md' && renamedPath('docs2/c.md', 'docs', 'notes') === null && renamedPath('docs', 'docs', 'notes') === 'notes');

  const moved = renameTabs(withFolders, 'j', 'docs', 'notes');
  check('a folder renamed: its tabs follow, in the same places in the strip', keys(moved) === 'j:notes/a.md j:notes/sub/b.md j:docs2/c.md j:other.md k:docs/a.md', keys(moved));
  check('the front tab stays in front under its new path', moved.active === tabKey('j', 'notes/sub/b.md'), moved.active ?? 'null');
  check('a tab in another root with the same path is not touched', moved.tabs.some((t) => t.jobId === 'k' && t.path === 'docs/a.md'));
  check('folders you opened and closed under it keep that state', moved.folders['j']!.collapsed.includes('notes/sub') && !moved.folders['j']!.collapsed.includes('docs/sub') && moved.folders['j']!.opened.includes('docs2'));
  const kept = moved.tabs.find((t) => t.path === 'notes/sub/b.md')!;
  const was = withFolders.tabs.find((t) => t.path === 'docs/sub/b.md')!;
  check('and each keeps its view, scroll and when it was seen', kept.view === was.view && kept.seen === was.seen && kept.scroll === was.scroll);
  const fileMoved = renameTabs(withFolders, 'j', 'other.md', 'x/other.md');
  check('a file renamed into a new folder: its tab follows', keys(fileMoved).includes('j:x/other.md') && !keys(fileMoved).includes('j:other.md'));
  check('a rename that touches no tab and no folders is a no-op', renameTabs(base, 'k', 'nope', 'nope2') === base && renameTabs(base, 'j', 'a', 'a') === base);
  const clash = openTab(withFolders, 'j', 'notes/a.md', 300);
  const onto = renameTabs(clash, 'j', 'docs', 'notes');
  check('a tab already on the new path gives way to the one that moved there', onto.tabs.filter((t) => t.jobId === 'j' && t.path === 'notes/a.md').length === 1 && onto.active === tabKey('j', 'notes/a.md'), keys(onto));

  // ── and close on a delete ──
  check('tabsUnder finds the tabs at and under a path, in one root', tabsUnder(front, 'j', 'docs').join('|') === [tabKey('j', 'docs/a.md'), tabKey('j', 'docs/sub/b.md')].join('|'));
  const closed = closeUnder(front, 'j', 'docs');
  check('a folder deleted: its tabs close, the rest stay', keys(closed) === 'j:docs2/c.md j:other.md k:docs/a.md', keys(closed));
  check('and the front goes to the tab you were on before', closed.active === tabKey('k', 'docs/a.md'), closed.active ?? 'null');
  check('a file deleted closes only its tab', keys(closeUnder(front, 'j', 'other.md')) === 'j:docs/a.md j:docs/sub/b.md j:docs2/c.md k:docs/a.md');

  // ── the live store: edits move with a rename, go with a delete ──
  const { followRename, closeDeleted, unsavedUnder, putEdit, editOf, keep, getFiles, update } = await import('./useTabs.js');
  update((st) => openTab(openTab(st, 'jr', 'src/x.ts', 1), 'jr', 'src/y.ts', 2));
  putEdit(tabKey('jr', 'src/x.ts'), { draft: 'typed', base: 'saved' });
  check('an unsaved edit is found under its folder', unsavedUnder('jr', 'src').join() === tabKey('jr', 'src/x.ts') && unsavedUnder('jr', 'src/y.ts').length === 0);
  followRename('jr', 'src', 'lib');
  const after = editOf(tabKey('jr', 'lib/x.ts'));
  check('after a rename the edit is under the new path, still unsaved', after?.draft === 'typed' && keep(tabKey('jr', 'lib/x.ts')) && editOf(tabKey('jr', 'src/x.ts')) === null);
  check('and the tabs are on the new paths', getFiles().tabs.some((t) => t.jobId === 'jr' && t.path === 'lib/y.ts') && !getFiles().tabs.some((t) => t.jobId === 'jr' && t.path?.startsWith('src/')));
  closeDeleted('jr', 'lib');
  check('a delete closes them, and their edits go with them', !getFiles().tabs.some((t) => t.jobId === 'jr') && editOf(tabKey('jr', 'lib/x.ts')) === null && !keep(tabKey('jr', 'lib/x.ts')));

  // ── the double confirm, as a pure function ──
  const { countTreeFiles, deleteSteps, onYes, shownName } = await import('./deleting.js');
  const t = (o: Partial<Parameters<typeof deleteSteps>[0]>): Parameters<typeof deleteSteps>[0] => ({
    path: 'docs/notes',
    type: 'dir',
    files: 12,
    treeFiles: 10,
    tracked: 4,
    unsaved: [],
    ...o,
  });
  const file = deleteSteps(t({ path: 'docs/a.md', type: 'file', files: 1, tracked: 1 }));
  check('a file is one confirm, naming it', file.length === 1 && file[0]!.ask === 'Delete a.md?' && file[0]!.last && !file[0]!.recursive);
  check('saying whether git has it', /Git has this file/.test(file[0]!.notes.join(' ')) && /Git does not have this file/.test(deleteSteps(t({ type: 'file', files: 1, tracked: 0 }))[0]!.notes.join(' ')) && /no git here/.test(deleteSteps(t({ type: 'file', files: 1, tracked: null }))[0]!.notes.join(' ')));
  check('and a file can be deleted before the daemon has counted it', deleteSteps(t({ type: 'file', files: null, tracked: null }))[0]!.ready && deleteSteps(t({ type: 'file', files: null, tracked: null }))[0]!.notes.length === 0);
  const empty = deleteSteps(t({ files: 0, treeFiles: 0, tracked: 0 }));
  check('an empty folder is one confirm, not recursive', empty.length === 1 && /empty folder notes\//.test(empty[0]!.ask) && empty[0]!.last && !empty[0]!.recursive);
  const full = deleteSteps(t({}));
  check('a folder with files is two steps', full.length === 2 && !full[0]!.last && full[1]!.last);
  check('the first names the folder and how many files it holds', full[0]!.ask === 'Delete notes/ and the 12 files in it?', full[0]!.ask);
  check('the second asks "Are you sure?" and repeats the count', /^Are you sure\? 12 files go with notes\//.test(full[1]!.ask) && /12 files/.test(full[1]!.yes), full[1]!.ask);
  check('git is said of the files: some of them, all of them, none', /Git has 4 files of them; the other 8 files cannot be brought back/.test(full[0]!.notes.join(' ')) && /Git has all of them/.test(deleteSteps(t({ tracked: 12 }))[0]!.notes.join(' ')) && /Git has none/.test(deleteSteps(t({ tracked: 0 }))[0]!.notes.join(' ')));
  check('a yes on the first shows the second; only the second sends, and with recursive', JSON.stringify(onYes(full, 0)) === '{"next":1}' && JSON.stringify(onYes(full, 1)) === '{"send":{"recursive":true}}');
  check('a file and an empty folder send at once, without recursive', JSON.stringify(onYes(file, 0)) === '{"send":{"recursive":false}}' && JSON.stringify(onYes(empty, 0)) === '{"send":{"recursive":false}}');
  const counting = deleteSteps(t({ files: null, tracked: null }));
  check("until the daemon has counted, a folder shows the tree's count and the button waits", /the 10 files/.test(counting[0]!.ask) && !counting[0]!.ready && onYes(counting, 0) === null && counting[0]!.yes === 'counting…');
  check('one file is said as one', /^Are you sure\? 1 file goes with/.test(deleteSteps(t({ files: 1, tracked: 0 }))[1]!.ask));
  const capped = deleteSteps(t({ files: 50_000, capped: true }));
  check('a capped count says "at least", in both steps', /the at least 50,000 files/.test(capped[0]!.ask) && /^Are you sure\? At least 50,000 files go/.test(capped[1]!.ask), capped.map((s) => s.ask).join(' | '));
  check('unsaved edits that close with it are named', /Your unsaved edits to docs\/notes\/a\.md, docs\/notes\/b\.md go with it\./.test(deleteSteps(t({ unsaved: ['docs/notes/a.md', 'docs/notes/b.md'] }))[0]!.notes.join(' ')));
  check('a folder is named with its /', shownName('a/b', 'dir') === 'b/' && shownName('a/b.md', 'file') === 'b.md');
  const counted: FileNode = { path: 'd', name: 'd', type: 'dir', children: [
    { path: 'd/a', name: 'a', type: 'file' },
    { path: 'd/gone', name: 'gone', type: 'file', change: { added: 0, removed: 1, created: false, at: '', deleted: true } },
    { path: 'd/e', name: 'e', type: 'dir', children: [{ path: 'd/e/b', name: 'b', type: 'file' }] },
  ] };
  check("the tree's count leaves out files already deleted", countTreeFiles(counted) === 2);

  // ── naming a folder, and a rename ──
  const { DEFAULT_FOLDER, checkFolderName, prefillFolder, prefillRename } = await import('./naming.js');
  const pf = prefillFolder('docs');
  check('a new folder starts at new-folder in the folder that asked, its name selected', pf.value === `docs/${DEFAULT_FOLDER}` && pf.value.slice(pf.from, pf.to) === DEFAULT_FOLDER && prefillFolder('').value === DEFAULT_FOLDER);
  const pr = prefillRename('docs/notes/plan.md', 'file');
  check("a rename starts at the whole path, the file's name selected without its extension", pr.value === 'docs/notes/plan.md' && pr.value.slice(pr.from, pr.to) === 'plan');
  const prd = prefillRename('docs/v1.2', 'dir');
  check("a folder's whole name is selected, dots and all", prd.value.slice(prd.from, prd.to) === 'v1.2');
  const fold = (raw: string): string => {
    const c = checkFolderName(raw);
    return c.ok ? c.path : `refused: ${c.reason}`;
  };
  check('a folder name may end in /', fold('docs/new/') === 'docs/new' && fold('a') === 'a');
  check('and is refused for what a file name is', fold('../x').startsWith('refused') && fold('.git/x').startsWith('refused') && fold('/x').startsWith('refused') && fold('/').startsWith('refused'));
  check('in words about a folder', fold('') === 'refused: Type a name for the folder.' && checkName('').ok === false);

  // ── the tree, drawn with the verbs ──
  const { FileTree } = await import('./FileTree.js');
  const leaf = (path: string, extra: Partial<FileNode> = {}): FileNode => ({ path, name: path.split('/').pop()!, type: 'file', ...extra });
  const top: FileNode = { path: '', name: '', type: 'dir', children: [
    { path: 'docs', name: 'docs', type: 'dir', children: [leaf('docs/a.md')] },
    leaf('old.md', { change: { added: 0, removed: 2, created: false, at: '', deleted: true } }),
    leaf('README.md'),
  ] };
  const noop = async (): Promise<void> => {};
  const verbs = (o: Record<string, unknown> = {}) => ({
    folderIn: null,
    onFolder: () => {},
    onMakeFolder: noop,
    renaming: null,
    onRename: () => {},
    onRenamed: noop,
    onDelete: () => {},
    deleting: null,
    confirm: null,
    onCancel: () => {},
    ...o,
  });
  const draw = (v: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(createElement(FileTree, {
      root: top, selected: null, onSelect: () => {}, folders: undefined, onToggle: () => {},
      touches: new Map(), roles: new Map(), now: 0,
      adding: null, onAdd: () => {}, onCreate: noop, onCancelAdd: () => {},
      ...(v ? { verbs: v as never } : {}), ...extra,
    }));
  const bare = draw(undefined);
  check('without verbs the tree is as Amendment 121 left it: no rename, no delete', !bare.includes('c5-act') && !bare.includes('c5-filerow'));
  const drawn = draw(verbs());
  const labels = [...drawn.matchAll(/aria-label="((?:New folder in|Rename|Delete) [^"]*)"/g)].map((m) => m[1]);
  check('a folder row has new folder, rename and delete', ['New folder in docs', 'Rename docs', 'Delete docs'].every((l) => labels.includes(l)), labels.join(', '));
  check('a file row has rename and delete, and no new folder', labels.includes('Rename README.md') && labels.includes('Delete README.md') && !labels.some((l) => l === 'New folder in README.md'));
  check('a deleted file (not on disk) has neither', !labels.some((l) => l?.endsWith('old.md')));
  check('the + stays first after the folder\'s button, the new ones after it', /<div class="c5-dirrow"><button[^>]*class="c5-row dir"[^>]*>(?:(?!<\/button>).)*<\/button><button[^>]*c5-add[^>]*>\+<\/button><button[^>]*c5-act[^>]*aria-label="New folder in docs"/.test(drawn));
  check('each is a sibling of the row button, never inside it', /<div class="c5-filerow"><button[^>]*class="c5-row"[^>]*>(?:(?!<\/button>).)*README\.md(?:(?!<\/button>).)*<\/button><button[^>]*c5-act/.test(drawn));
  const renaming = draw(verbs({ renaming: 'README.md' }));
  check('rename puts the name box in the row\'s place, the name selected for typing', renaming.includes('value="README.md"') && renaming.includes('aria-label="new name for the file README.md"') && !/class="c5-row"[^>]*data-path="README\.md"/.test(renaming));
  const renamingDir = draw(verbs({ renaming: 'docs' }));
  check('a folder renames in place too', renamingDir.includes('aria-label="new name for the folder docs"') && !renamingDir.includes('class="c5-dirrow"'));
  const folderBox = draw(verbs({ folderIn: 'docs' }));
  check("new folder opens its box under the folder's row", folderBox.includes('value="docs/new-folder"') && folderBox.indexOf('value="docs/new-folder"') > folderBox.indexOf('>docs/<') && folderBox.includes('aria-label="name of the new folder in docs"'));
  const rootFolder = draw(verbs({ folderIn: '' }));
  check("the root's new-folder box is first", rootFolder.indexOf('value="new-folder"') > -1 && rootFolder.indexOf('value="new-folder"') < rootFolder.indexOf('c5-dirrow'));
  const confirming = draw(verbs({ deleting: 'docs', confirm: createElement('span', { className: 'probe' }, 'ASK') }));
  check('the confirm sits under the row it is about', confirming.indexOf('c5-delrow') > confirming.indexOf('>docs/<') && confirming.indexOf('c5-delrow') < confirming.indexOf('a.md') && (confirming.match(/c5-delrow/g) ?? []).length === 1);
  const treeSrc = readFileSync(new URL('./FileTree.tsx', import.meta.url), 'utf8');
  check('F2 renames, and Delete or ⌘⌫ deletes, the focused row', /const del = e\.key === 'Delete' \|\| \(e\.key === 'Backspace' && e\.metaKey\);\s*if \(verbs && \(e\.key === 'F2' \|\| del\)\)/.test(treeSrc) && /verbs\.onRename\(node\.path\)/.test(treeSrc) && /verbs\.onDelete\(node\)/.test(treeSrc));

  // ── the client calls ──
  const { createFolder, renameEntry, deleteEntry, entryInfo, askedOf } = await import('./useWorkspace.js');
  const real = globalThis.fetch;
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {} });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }) as unknown as typeof fetch;
  try {
    const dir = dirRoot('prj_v', '/Users/me/code');
    const q = '?dir=%2FUsers%2Fme%2Fcode';
    const asked0 = askedOf('jv');
    reply = { status: 201, body: { path: 'notes' } };
    await createFolder('jv', 'notes');
    await createFolder(dir, 'notes');
    check('new folder is a POST of { path } to …/folders, for a job and a project folder', sent[0]?.method === 'POST' && sent[0].url === '/api/jobs/jv/folders' && JSON.stringify(sent[0].body) === '{"path":"notes"}' && sent[1]?.url === `/api/projects/prj_v/dir/folders${q}`, `${sent[0]?.url} ${sent[1]?.url}`);
    reply = { status: 200, body: { from: 'a.md', to: 'b.md', type: 'file' } };
    await renameEntry('jv', 'a.md', 'b.md');
    check('rename is a POST of { from, to } to …/rename', sent[2]?.method === 'POST' && sent[2].url === '/api/jobs/jv/rename' && JSON.stringify(sent[2].body) === '{"from":"a.md","to":"b.md"}');
    reply = { status: 200, body: { path: 'a', type: 'dir', files: 3, folders: 0, tracked: 1 } };
    await entryInfo(dir, 'a b');
    check('what a delete would take is a GET of …/entry?path=', sent[3]?.method === 'GET' && sent[3].url === `/api/projects/prj_v/dir/entry${q}&path=a+b`, sent[3]?.url);
    reply = { status: 200, body: { path: 'a', type: 'dir', files: 3 } };
    await deleteEntry('jv', 'a', false);
    await deleteEntry('jv', 'a', true);
    await deleteEntry(dir, 'a', true);
    check('delete is a DELETE of …/entry?path=, with recursive=1 only when asked', sent[4]?.method === 'DELETE' && sent[4].url === '/api/jobs/jv/entry?path=a' && sent[5]?.url === '/api/jobs/jv/entry?path=a&recursive=1' && sent[6]?.url === `/api/projects/prj_v/dir/entry${q}&path=a&recursive=1`, `${sent[4]?.url} ${sent[5]?.url} ${sent[6]?.url}`);
    check('each change re-reads its tree; asking what a delete would take does not', askedOf('jv') === asked0 + 4);
    reply = { status: 409, body: { error: 'a is not empty: it holds 3 files' } };
    let refused: unknown = null;
    await deleteEntry('jv', 'a', false).catch((e: unknown) => {
      refused = e;
    });
    const { errorText } = await import('../lib/errors.js');
    check("a refusal rejects with the daemon's sentence and re-reads nothing", errorText(refused) === 'a is not empty: it holds 3 files' && askedOf('jv') === asked0 + 4);
  } finally {
    globalThis.fetch = real;
  }

  // ── the screen's wiring, read from source ──
  const route = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('a rename moves the open tabs to where the daemon put it', /const done = await renameEntry\(r\.root, from, to\);\s*followRename\(r\.root, done\.from, done\.to\);/.test(route));
  check('the root heading has new folder beside its +', /onClick=\{\(\) => verbs\.onFolder\(''\)\}[\s\S]{0,200}aria-label=\{`New folder in \$\{r\.name\}`\}/.test(route));
  check('the tree is handed the verbs', /onCancelAdd=\{\(\) => setAdding\(null\)\}\s*verbs=\{verbs\}/.test(route));
  const confirm = readFileSync(new URL('./DeleteConfirm.tsx', import.meta.url), 'utf8');
  check('the confirm closes the tabs it took only once the delete has landed', /await deleteEntry\(root, node\.path, what\.send\.recursive\);\s*closeDeleted\(root, node\.path\);/.test(confirm));
  check('it asks the daemon what is on disk, and starts on the safe choice', /entryInfo\(root, node\.path\)/.test(confirm) && /keep\.current\?\.focus\(\)/.test(confirm) && /e\.key === 'Escape'/.test(confirm));
  const css = readFileSync(new URL('./files.css', import.meta.url), 'utf8');
  const ours = css.slice(css.indexOf('new folder, rename and delete (Amendment 138)'));
  check('the actions show on hover and focus, and always where there is no hover', /\.c5-filerow:focus-within \.c5-act/.test(ours) && /@media \(hover: none\)\s*\{\s*\.c5-act\s*\{\s*opacity: 1;/.test(ours));
  check('drawn in existing tokens only', ours.length > 0 && !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(ours) && /var\(--fail\)/.test(ours));

  // ── the navigator's folders get a + ──
  const nav = readFileSync(new URL('../shell/Navigator.tsx', import.meta.url), 'utf8');
  check("the navigator's folder rows have a +, beside the row's button", /<div className="sh-nav-dirrow">\s*<button[\s\S]*?<\/button>\s*<AddButton dir=\{kid\.path\}/.test(nav));
  check('and so does each folder node', /<\/button>\s*<AddButton dir="" label=\{folder\.name\} add=\{add\} \/>/.test(nav));
  check('it is labelled, and opens the same NewFileForm in place', /aria-label=\{`New file in \$\{label\}`\}/.test(nav) && /<NewFileForm key=\{`n:\$\{dir\}`\} dir=\{dir\}/.test(nav));
  check('the new file opens in Files, ready to type', /const made = await createFile\(folder\.root, path\);\s*openNew\(folder\.root, made\.path, made\.raw, !isImagePath\(made\.path\)\);[\s\S]{0,60}navigate\(SCREEN\.files, navFileLink\(folder\.root, made\.path\)\)/.test(nav));
  const shellCss = readFileSync(new URL('../shell/shell.css', import.meta.url), 'utf8');
  check('its + shows on hover and focus, and always where there is no hover', /\.sh-nav-dirrow:hover \.sh-nav-add,\s*\.sh-nav-dirrow:focus-within \.sh-nav-add/.test(shellCss) && /@media \(hover: none\)\s*\{\s*\.sh-nav-add\s*\{\s*opacity: 1;/.test(shellCss));
}

console.log(
  failures === 0
    ? '\nTrack C files verify: PASS — tabs open, close, follow links and survive a reload as they should; links in a rendered file go where the file meant, and it prints on its own; it opens on the project you came from, the route\'s own project winning over the remembered one (Amendment 91); a nested repo\'s branch shows beside its folder in the tree (Amendment 94); new folder, rename and delete, with tabs that follow a rename and close on a delete, a double confirm for a folder with files in it, and a + on the navigator\'s folders (Amendment 138).\n'
    : `\nTrack C files verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
