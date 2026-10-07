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
  dirRoot,
  inColumn,
  keyOf,
  linkOf,
  openTab,
  parseDirRoot,
  parseState,
  pickDone,
  rootEndpoint,
  selectJob,
  selectProject,
  serialize,
  setScroll,
  setView,
  tabKey,
  tabLabels,
  toggleFolder,
  type FilesState,
} from './tabs.js';
import { readFileSync } from 'node:fs';
import { headingSlugs, resolveDocLink, type DocLink } from './links.js';
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

console.log(
  failures === 0
    ? '\nTrack C files verify: PASS — tabs open, close, follow links and survive a reload as they should; links in a rendered file go where the file meant, and it prints on its own; it opens on the project you came from, the route\'s own project winning over the remembered one (Amendment 91).\n'
    : `\nTrack C files verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
