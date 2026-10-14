/**
 * Shell verification — the project navigator, as a pure model.  (Amendment 66)
 *
 *   pnpm --filter @conductor/web exec tsx src/shell/verify.ts
 *
 * No daemon, no browser. `navtree.ts` decides what each project's submenus hold, in what
 * order, where a click goes and which nodes are open; Navigator.tsx only draws it. A
 * wrong answer here still draws a tidy panel — another project's agent under this one,
 * an amber heading over nothing, a folder that opens the wrong root, one submenu closing
 * another — so these are checked here rather than by eye.
 *
 * §7 (Amendment 69): the panel lists projects in the Fleet's order, for every Sort by,
 * from the same facts; and a drag in it writes your order and the `mine` sort.
 *
 * §8 (Amendment 86): a project's agents are grouped by job, newest first, headed by the
 * prompt on one line, with the worst dot and the sum of what waits; groups start open.
 *
 * §9 (Amendment 92): a project's folders open into their directories as a tree, sharing
 * the Files screen's own `useFileTree`; `navDirId` names each directory's node, and
 * `navFileLink` is the link a file row hands `navigate('files', …)`.
 */

import type { Agent, Alert, PendingRequest } from '@conductor/shared';
import { agentTabs } from '../agent/tabs.js';
import { readFileSync } from 'node:fs';
import { ORDER_KEY, SORTS, SORT_KEY, SORT_RANK, fleetSort, moveBefore, parseOrder, sortFacts, sortProjects } from '../fleet/order.js';
import { dirRoot, parseDirRoot } from '../files/tabs.js';
import { projectNeeds } from './describe.js';
import { budgetOf, sumBudgets } from './autonomy.js';
import { readBudgetCeilingFrom } from '@conductor/shared';
import {
  DETAILS_KEY,
  NAV_OPEN_KEY,
  NAV_TREE_KEY,
  currentProject,
  detailsShown,
  folderName,
  groupByJob,
  isOpen,
  jobLine,
  jobShown,
  meterTitle,
  navDirId,
  navDrop,
  navFileLink,
  navId,
  navJobId,
  navProjects,
  navShown,
  navTree,
  parseOpen,
  projectFolders,
  rightPanelFor,
  serializeOpen,
  toggleOpen,
} from './navtree.js';
import { AGENT_INSPECTOR, NAV_PANEL, PREVIEW_DOCK, PROJECT_COLUMN, PROJECT_DOCK, QUEUE_PANEL, panelMax, panelSize, storedPanel } from './panels.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

// ── fixtures ────────────────────────────────────────────────────────────────

const agent = (id: string, projectId: string, jobId: string, role: Agent['role'], status: Agent['status'] = 'working'): Agent => ({
  id,
  jobId,
  projectId,
  role,
  model: 'claude-opus-5',
  sdkSessionId: null,
  status,
  blockMode: null,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  dependsOn: [],
  autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: null },
  startedAt: null,
  endedAt: null,
});

const request = (requestId: string, projectId: string, agentId: string, command: string): PendingRequest => ({
  requestId,
  projectId,
  jobId: 'j',
  agentId,
  agentRole: 'builder',
  projectName: projectId,
  kind: 'permission',
  blockMode: 'parked',
  createdAt: '2026-10-02T10:00:00Z',
  toolName: 'Bash',
  input: { command },
});

const alert = (id: string, projectId: string | null, agentIds: string[]): Alert => ({
  id,
  kind: 'failed',
  cause: 'max_turns',
  projectId,
  jobId: null,
  agentIds,
  since: '2026-10-02T10:00:00Z',
});

const projects = [
  { id: 'web', name: 'web-app', path: '/src/web-app', extraDirs: ['/src/lib', '/src/docs/'] },
  { id: 'api', name: 'api', path: '/src/api' },
];
const agents = [
  agent('a1', 'web', 'jOld', 'builder', 'done'),
  agent('a2', 'web', 'jNew', 'reviewer', 'working'),
  agent('a3', 'web', 'jNew', 'builder', 'queued'),
  agent('b1', 'api', 'jApi', 'builder', 'working'),
];
const jobs = [
  { id: 'jOld', createdAt: '2026-10-01T09:00:00Z', prompt: 'Add dark mode' },
  { id: 'jNew', createdAt: '2026-10-02T09:00:00Z', prompt: '  Fix the login\n\n  page   on Safari\n' },
  { id: 'jApi', createdAt: '2026-10-02T08:00:00Z', prompt: 'Speed up /search' },
];
const pending = [request('r1', 'web', 'a3', 'npm test'), request('r2', 'api', 'b1', 'rm -rf dist')];
const alerts = [alert('al1', 'web', ['a2']), alert('al2', null, ['a1', 'b1'])];

const tree = navTree(projects, agents, pending, alerts, jobs);
const web = tree.find((p) => p.id === 'web')!;
const api = tree.find((p) => p.id === 'api')!;

console.log('\n1 · each project lists its own agents, in the Agent tabs\' order');
{
  check('one node per project, in the order they came', tree.map((p) => p.id).join() === 'web,api');
  check("a project's agents are its own and nobody else's", web.agents.every((a) => ['a1', 'a2', 'a3'].includes(a.id)) && api.agents.map((a) => a.id).join() === 'b1');
  check(
    'newest job first, then the order they were made — as the Agent screen\'s tabs',
    web.agents.map((a) => a.id).join() === 'a2,a3,a1',
    web.agents.map((a) => a.id).join(),
  );
  check('a role that appears twice is numbered', web.agents.map((a) => a.label).join() === 'reviewer,builder 1,builder 2', web.agents.map((a) => a.label).join());
  const a3 = web.agents.find((a) => a.id === 'a3')!;
  check('an agent a request waits on shows blocked, with its count', a3.status === 'blocked' && a3.needs === 1, JSON.stringify(a3));
  const a1 = web.agents.find((a) => a.id === 'a1')!;
  check('an alert counts against the agents it names', a1.needs === 1 && a1.status === 'blocked', JSON.stringify(a1));
  check('an alert across projects counts against each agent it names', api.agents[0]!.needs === 2 && web.agents.find((a) => a.id === 'a1')!.needs === 1);
  check('each row carries its job, so a click can open it', web.agents.every((a) => a.jobId === agents.find((x) => x.id === a.id)!.jobId));
  const noJobs = navTree(projects, agents, [], []);
  check('without jobs the agents keep the order they were given', noJobs[0]!.agents.map((a) => a.id).join() === 'a1,a2,a3');
  check('with nothing waiting each agent keeps its own status', noJobs[0]!.agents.map((a) => a.status).join() === 'done,working,queued' && noJobs[0]!.agents.every((a) => a.needs === 0));
}

console.log('\n2 · Needs you lists only this project\'s, and lights only when something waits');
{
  check('the count is projectNeeds, the rule the projects list used', web.needs === projectNeeds('web', pending, alerts) && web.needs === 2, String(web.needs));
  check('one row per request and alert, requests first', web.needsRows.map((n) => n.key).join() === 'r:r1,a:al1', web.needsRows.map((n) => n.key).join());
  check('the count is the rows', tree.every((p) => p.needs === p.needsRows.length));
  check("another project's request is not here", !web.needsRows.some((n) => n.key === 'r:r2') && api.needsRows.map((n) => n.key).join() === 'r:r2');
  check('an alert with no project is under none of them (the rail still has it)', !tree.some((p) => p.needsRows.some((n) => n.key === 'a:al2')));
  check('a request opens Needs you on itself', JSON.stringify(web.needsRows[0]!.params) === JSON.stringify({ requestId: 'r1' }));
  check('an alert opens Needs you on itself', JSON.stringify(web.needsRows[1]!.params) === JSON.stringify({ alertId: 'al1' }));
  check('a request reads who, as its tab names it, then what it wants', web.needsRows[0]!.label === 'builder 1 · Bash · npm test', web.needsRows[0]!.label);
  check('an alert reads as its sentence', web.needsRows[1]!.label === 'reviewer ran out of turns', web.needsRows[1]!.label);
  const quiet = navTree(projects, agents, [], [])[0]!;
  check('nothing waiting: no count, no rows', quiet.needs === 0 && quiet.needsRows.length === 0);

  const nav = src('./Navigator.tsx');
  check('the heading is amber exactly when the count is above zero', /lit=\{needs > 0\}/.test(nav) && /is-need/.test(nav));
  check('and shows a count only then', /count=\{needs > 0 \? needs : null\}/.test(nav));
  check('a row opens Needs you with its own params', /navigate\(SCREEN\.attention, n\.params\)/.test(nav));
}

console.log('\n3 · Files lists the main folder first, then the referenced ones');
{
  check('main first, then in the order added', web.folders.map((f) => f.dir).join() === '/src/web-app,/src/lib,/src/docs/', web.folders.map((f) => f.dir).join());
  check('only the main one is marked main', web.folders.map((f) => f.main).join() === 'true,false,false');
  check('each is named by its last segment, trailing slash or not', web.folders.map((f) => f.name).join() === 'web-app,lib,docs', web.folders.map((f) => f.name).join());
  check('a project from an older daemon, with no extraDirs, has its main folder', api.folders.length === 1 && api.folders[0]!.main);
  check('each opens Files on its own root', web.folders.every((f) => f.root === dirRoot('web', f.dir) && parseDirRoot(f.root)?.dir === f.dir));
  const twice = projectFolders({ id: 'x', path: '/a', extraDirs: ['/b', '/a', '/b'] });
  check('a folder listed twice is shown once', twice.map((f) => f.dir).join() === '/a,/b', twice.map((f) => f.dir).join());
  check('a root path keeps a name', folderName('/') === '/' && folderName('C:\\src\\app') === 'app');
  const nav = src('./Navigator.tsx');
  check('a folder opens and closes, as FolderNode, rather than jumping straight to Files', /function FolderNode/.test(nav) && !/navigate\(SCREEN\.files, \{ jobId: f\.root \}\)/.test(nav));
  check('open, it fetches its tree with the Files screen\'s own hook', /useFileTree\(root\)/.test(nav));
}

console.log('\n4 · every node opens and closes on its own');
{
  const ids = ['p:web', 'p:web:agents', 'p:web:needs', 'p:web:files'];
  check('node ids are p:<id> and p:<id>:<part>', [navId('web'), navId('web', 'agents'), navId('web', 'needs'), navId('web', 'files')].join() === ids.join());

  let open = parseOpen(null);
  open = toggleOpen(open, navId('web'));
  open = toggleOpen(open, navId('web', 'agents'));
  open = toggleOpen(open, navId('api'));
  open = toggleOpen(open, navId('api', 'needs'));
  check('opening several keeps them all open', ['p:web', 'p:web:agents', 'p:api', 'p:api:needs'].every((id) => isOpen(open, id)));
  const after = toggleOpen(open, navId('web', 'files'));
  check("opening one doesn't close another, in its project or any other", ['p:web', 'p:web:agents', 'p:api', 'p:api:needs', 'p:web:files'].every((id) => isOpen(after, id)));
  const closed = toggleOpen(after, navId('web'));
  check('closing a project leaves its submenus as they were, for when it opens again', !isOpen(closed, 'p:web') && isOpen(closed, 'p:web:agents') && isOpen(closed, 'p:web:files'));
  check('toggling never changes the set it was given', isOpen(open, 'p:web') && !isOpen(open, 'p:web:files'));
  check('toggling twice is where it started', [...toggleOpen(toggleOpen(open, 'p:web:needs'), 'p:web:needs')].sort().join() === [...open].sort().join());

  check('the set survives a round trip through the setting', [...parseOpen(serializeOpen(after))].sort().join() === [...after].sort().join());
  check('nothing open removes the setting', serializeOpen(new Set()) === null);
  const broken: (string | null)[] = [null, '', '{', 'null', '"p:web"', '{"p:web":true}', '42'];
  check('a missing or broken setting is nothing open, never a throw', broken.every((raw) => parseOpen(raw).size === 0));
  check('stray non-strings in the array are dropped, the rest kept', [...parseOpen('[1, "p:web", null, "p:api:files"]')].join() === 'p:web,p:api:files');
  check('the keys are the ones the plan names', NAV_TREE_KEY === 'conductor.navTree' && NAV_OPEN_KEY === 'conductor.navOpen');
}

console.log('\n5 · the top bar\'s icons, and which project is highlighted');
{
  check('the navigator is up unless it was put away', navShown(null) && navShown('') && navShown('shown') && !navShown('hidden'));
  check('the right-panel icon is there on the Agent screen', rightPanelFor('agent') === 'conductor.agentDetails');
  check('and nowhere else, since nowhere else has a right panel', ['fleet', 'project', 'attention', 'files', 'preview', 'spawn', 'settings', 'diagnostics', ''].every((id) => rightPanelFor(id) === null));
  const agentSrc = src('../agent/agent.tsx');
  check("it toggles the setting the Agent screen's own button and `i` use", agentSrc.includes(`const DETAILS_KEY = '${DETAILS_KEY}';`));
  check('read the same way: shown unless hidden', detailsShown(null) && detailsShown('shown') && !detailsShown('hidden') && /useSetting\(DETAILS_KEY\) !== 'hidden'/.test(agentSrc));

  const r = (id: string, params: Record<string, string> = {}) => ({ id, params });
  check('the project the hash names is highlighted', currentProject(r('project', { projectId: 'api' }), agents, 'web') === 'api');
  check("on the Agent screen it's the open agent's project", currentProject(r('agent', { agentId: 'b1' }), agents, 'web') === 'api');
  check('with nothing named, the last one opened', currentProject(r('fleet'), agents, 'web') === 'web' && currentProject(r('agent', { agentId: 'gone' }), agents, 'web') === 'web');
  check('and none at all before anything was', currentProject(r(''), agents, undefined) === undefined);

  const shell = src('./shell.tsx');
  const body = shell.slice(shell.indexOf('<div className="sh-body">'));
  check('the shell draws the navigator before the screen, on every screen', /\{navUp && <Navigator \/>\}\s*<div className="sh-screen">/.test(body));
  check('both icons sit in the top bar', /<NavToggle \/>/.test(shell) && /<RightToggle screen=\{screen\} \/>/.test(shell));
  check('the right one follows the current screen through lib/nav', /useRoute\(\)\.id/.test(shell) && /onNavigate\(/.test(src('./Navigator.tsx')) && /currentRoute/.test(src('./Navigator.tsx')));
  check('the panel stays up when an agent is opened from it: nothing in it hides itself', !/writeSetting\(NAV_OPEN_KEY/.test(src('./Navigator.tsx')));
  check('the old project rail stays gone', !/<ProjectRail|function ProjectRail|sh-rail/.test(shell + src('./Navigator.tsx') + src('./shell.css')));
}

console.log('\n6 · the navigator is resizable like the other side panels (Amendment 34)');
{
  const room = 1280;
  check('it starts at the size it had', panelSize(NAV_PANEL, NAV_PANEL.fallback, room) === NAV_PANEL.fallback);
  check('it stops at its minimum', panelSize(NAV_PANEL, 10, room) === NAV_PANEL.min);
  check('it leaves the screen the larger share', panelMax(NAV_PANEL, room) <= room * 0.5);
  check('junk stored is the fallback', [null, '', 'wide', '0', '-5'].every((raw) => storedPanel(NAV_PANEL, raw) === NAV_PANEL.fallback));
  const keys = [NAV_PANEL, AGENT_INSPECTOR, QUEUE_PANEL, PROJECT_COLUMN, PROJECT_DOCK, PREVIEW_DOCK].map((p) => p.key);
  check('it is kept under its own key', new Set(keys).size === keys.length);

  const css = src('./shell.css');
  const at = css.indexOf('.sh-nav {');
  const rule = at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  check('the CSS width before a drag is the fallback', new RegExp(`\\n\\s*width:\\s*${NAV_PANEL.fallback}px;`).test(rule), rule);
  check("the Splitter draws its edge, so the panel doesn't draw another", rule !== '' && !/border-(left|right)/.test(rule));
  const nav = src('./Navigator.tsx');
  const split = nav.indexOf('<Splitter');
  check('it is sized by its own panel, and drags the right way', nav.includes('usePanel(NAV_PANEL)') && split >= 0 && nav.slice(split, nav.indexOf('/>', split)).includes('grow={1}'));
  check('colours are tokens, never hex', !/#[0-9a-fA-F]{3,8}\b/.test(css));
  check('kept in settings, never localStorage', !/localStorage\./.test(nav + src('./navtree.ts') + src('./shell.tsx')));
  check('its toggles say whether they are open', (nav.match(/aria-expanded=/g) ?? []).length >= 2);
}

console.log("\n7 · the projects come in the Fleet's order, and a drag sets yours (Amendment 69)");
{
  const at = (createdAt: string) => ({ createdAt });
  const ps = [
    { id: 'p1', name: 'delta', ...at('2026-09-01T00:00:00Z') },
    { id: 'p2', name: 'alpha', ...at('2026-09-03T00:00:00Z') },
    { id: 'p3', name: 'charlie', ...at('2026-09-02T00:00:00Z') },
    { id: 'p4', name: 'bravo', ...at('2026-09-04T00:00:00Z') },
  ];
  const as: Agent[] = [
    { ...agent('x1', 'p1', 'j1', 'builder', 'failed'), costUsd: 1.5, startedAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T09:00:00Z' },
    { ...agent('x2', 'p1', 'j1', 'reviewer', 'done'), costUsd: 0.25, startedAt: '2026-10-01T07:00:00Z', endedAt: null },
    { ...agent('x3', 'p2', 'j2', 'builder', 'working'), costUsd: 0.5, startedAt: '2026-10-02T09:00:00Z', endedAt: null },
    { ...agent('x4', 'p2', 'j2', 'tester', 'working'), costUsd: 0.5, startedAt: null, endedAt: null },
    { ...agent('x5', 'p3', 'j3', 'builder', 'paused'), costUsd: 4, startedAt: '2026-09-30T00:00:00Z', endedAt: null },
  ];
  const wait = [request('q1', 'p3', 'x5', 'make')];

  // sortFacts is what fleet.tsx's useMemo computed, moved verbatim.
  const facts = sortFacts(ps, as, wait);
  const f = (id: string) => JSON.stringify(facts.get(id));
  check('one entry per project, agents or none', facts.size === ps.length);
  check("rank is the project's worst agent", facts.get('p1')!.rank === SORT_RANK.failed && facts.get('p2')!.rank === SORT_RANK.working, f('p1'));
  check('a live request outranks everything: -1', facts.get('p3')!.rank === -1, f('p3'));
  check('no agents is done, nothing working, never active, nothing spent', f('p4') === JSON.stringify({ rank: SORT_RANK.done, working: 0, lastActive: 0, spend: 0 }), f('p4'));
  check('working counts the working agents', facts.get('p2')!.working === 2 && facts.get('p1')!.working === 0);
  check('last active is the latest start or end of any of its agents', facts.get('p1')!.lastActive === Date.parse('2026-10-01T09:00:00Z') && facts.get('p2')!.lastActive === Date.parse('2026-10-02T09:00:00Z'), f('p1'));
  check('spend is the sum of its agents', facts.get('p1')!.spend === 1.75 && facts.get('p2')!.spend === 1 && facts.get('p3')!.spend === 4, f('p1'));
  check('worst first: blocked, failed, working, queued, paused, stopped, done', ['blocked', 'failed', 'working', 'queued', 'paused', 'stopped', 'done'].every((st, i) => SORT_RANK[st as Agent['status']] === i));

  // The Fleet's own path: fleetSort over the raw setting, then sortProjects over sortFacts.
  const fleet = (rawSort: string | null, rawOrder: string | null) => {
    const order = parseOrder(rawOrder);
    return sortProjects(ps, fleetSort(rawSort, order), order, sortFacts(ps, as, wait)).map((p) => p.id).join();
  };
  const mine = JSON.stringify(['p4', 'p2']);
  for (const s of SORTS) {
    for (const rawOrder of [null, mine]) {
      const nav = navProjects(ps, s.id, rawOrder, as, wait).map((p) => p.id).join();
      check(`"${s.label}"${rawOrder ? ' with an order' : ''}: the panel's order is the Fleet's`, nav === fleet(s.id, rawOrder), `${nav} vs ${fleet(s.id, rawOrder)}`);
    }
  }
  const ids = (rawSort: string | null, rawOrder: string | null = null) => navProjects(ps, rawSort, rawOrder, as, wait).map((p) => p.id).join();
  check('needs you first: the waiting one, then the failure, then working, then the rest', ids('attention') === 'p3,p1,p2,p4', ids('attention'));
  check('name: A to Z', ids('name') === 'p2,p4,p3,p1', ids('name'));
  check('my order: yours first, the rest after in the order they came', ids('mine', mine) === 'p4,p2,p1,p3', ids('mine', mine));
  check('newest: the project added last first', ids('added') === 'p4,p2,p3,p1', ids('added'));
  check('no sort picked: needs you first, or mine once there is an order', ids(null) === ids('attention') && ids(null, mine) === ids('mine', mine) && ids('junk', mine) === ids('mine', mine));
  check('a different Sort by is a different panel', ids('name') !== ids('attention'));
  const t = navTree(navProjects(ps.map((p) => ({ ...p, path: `/src/${p.id}` })), 'name', null, as, wait), as, wait, []);
  check('navTree keeps the order it is given', t.map((p) => p.id).join() === ids('name'), t.map((p) => p.id).join());

  // A drag, as a Fleet drag: moveBefore over what is shown, then the sort that shows it.
  const shownNow = navProjects(ps, 'attention', null, as, wait);
  const drop = navDrop(shownNow, 'p4', 'p1');
  check("dropping one on another is moveBefore over what's shown", JSON.stringify(drop?.order) === JSON.stringify(moveBefore(shownNow, 'p4', 'p1')) && drop!.order.join() === 'p3,p4,p1,p2', drop?.order.join());
  check("and switches the sort to 'mine'", drop?.sort === 'mine');
  check('so the panel then shows exactly that order', ids(drop!.sort, JSON.stringify(drop!.order)) === drop!.order.join());
  check('dropping below the last one puts it at the end', navDrop(shownNow, 'p3', null)?.order.join() === 'p1,p2,p4,p3');
  check('dropping one on itself, or one not shown, writes nothing', navDrop(shownNow, 'p1', 'p1') === null && navDrop(shownNow, 'gone', 'p1') === null);

  const nav = src('./Navigator.tsx');
  const fl = src('../fleet/fleet.tsx');
  check('the panel reads the Fleet\'s two settings', /useSetting\(SORT_KEY\)/.test(nav) && /useSetting\(ORDER_KEY\)/.test(nav) && SORT_KEY === 'conductor.fleetSort' && ORDER_KEY === 'conductor.fleetOrder');
  check('and orders its tree by navProjects', /navProjects\(projects, rawSort, rawOrder, agents, pending, spent\)/.test(nav) && /navTree\(ordered,/.test(nav));
  check("a drop writes your order and the sort, as the Fleet's place() does", /writeSetting\(ORDER_KEY, JSON\.stringify\(w\.order\)\)/.test(nav) && /writeSetting\(SORT_KEY, w\.sort\)/.test(nav) && /navDrop\(ordered,/.test(nav));
  check('a project row drags with HTML5 drag, as a Fleet card does', /draggable/.test(nav) && /onDragStart=/.test(nav) && /onDragOver=/.test(nav) && /onDrop=/.test(nav));
  check('fleet.tsx builds its facts with sortFacts, not its own loop', /useMemo\(\(\) => sortFacts\(projects, agents, pending, spent\)/.test(fl) && !/SORT_RANK/.test(fl));
  check('and sorts as the panel does', /fleetSort\(useSetting\(SORT_KEY\), order\)/.test(fl) && /sortProjects\(projects, sort, order, facts\)/.test(fl));
  const css = src('./shell.css');
  check('the drag cue is drawn, never in amber', /\.sh-nav-proj\.is-drop\s*\{/.test(css) && /\.sh-nav-proj\.is-dragging\s*\{/.test(css) && !/is-drop[^}]*--need/.test(css));
}

console.log('\n8 · a project\'s agents are grouped by job (Amendment 86)');
{
  check('one group per job, newest first', web.jobs.map((j) => j.id).join() === 'jNew,jOld' && api.jobs.map((j) => j.id).join() === 'jApi', web.jobs.map((j) => j.id).join());
  check(
    'each group holds its own agents, in the order the flat list has them',
    web.jobs.flatMap((j) => j.agents.map((a) => a.id)).join() === web.agents.map((a) => a.id).join() && web.jobs[0]!.agents.map((a) => a.id).join() === 'a2,a3',
  );
  check('a group is headed by its prompt, on one line', web.jobs[0]!.label === 'Fix the login page on Safari' && web.jobs[1]!.label === 'Add dark mode', JSON.stringify(web.jobs[0]!.label));
  check('jobLine folds every run of whitespace, newlines too, and trims', jobLine(' a\n\tb  c \n') === 'a b c' && jobLine('') === '');
  check('a group counts what waits on you across its agents', web.jobs[0]!.needs === 2 && web.jobs[1]!.needs === 1 && api.jobs[0]!.needs === 2);
  const calm = navTree(projects, agents, [], [], jobs)[0]!;
  check("a group's dot is its unhappiest agent's", calm.jobs[0]!.status === 'working' && calm.jobs[1]!.status === 'done', calm.jobs.map((j) => j.status).join());
  const failed = groupByJob([{ id: 'x', jobId: 'j', label: 'x', status: 'done', needs: 0, finished: false, orchestrator: false, budget: null }, { id: 'y', jobId: 'j', label: 'y', status: 'failed', needs: 0, finished: false, orchestrator: false, budget: null }, { id: 'z', jobId: 'j', label: 'z', status: 'working', needs: 0, finished: false, orchestrator: false, budget: null }], []);
  check('a failure outranks working, by the Fleet\'s SORT_RANK', failed.length === 1 && failed[0]!.status === 'failed' && SORT_RANK.failed < SORT_RANK.working);
  check('a project with one job still gets its group', api.jobs.length === 1 && api.jobs[0]!.agents.length === 1);
  const unknown = navTree(projects, agents, [], [])[0]!;
  check("a job it wasn't told about is headed by its id", unknown.jobs.map((j) => j.label).join() === 'jOld,jNew', unknown.jobs.map((j) => j.label).join());
  check('a project with no agents has no groups', navTree([{ id: 'e', name: 'e', path: '/e' }], agents, [], [], jobs)[0]!.jobs.length === 0);
  const marked = navTree(projects, agents, [], [], jobs, new Set(['jOld']))[0]!;
  check('a job that finished and you have not seen says so on its group (Amendment 87)', marked.jobs.find((j) => j.id === 'jOld')!.finished && !marked.jobs.find((j) => j.id === 'jNew')!.finished);
  check('and none does when it is not told of any', calm.jobs.every((j) => !j.finished));
  // Amendment 105: an agent's own finished is "done and you haven't opened it since".
  const seenRows = navTree(projects, agents, [], [], jobs, new Set(), new Set(['a1', 'a2']))[0]!;
  check('a done agent you have not opened since says finished on its row (Amendment 105)', seenRows.agents.find((a) => a.id === 'a1')!.finished);
  check('an unseen id on an agent that is not done marks nothing', !seenRows.agents.find((a) => a.id === 'a2')!.finished);
  check('without unseen agents no row says finished, done or not', calm.agents.every((a) => !a.finished) && calm.agents.some((a) => a.status === 'done'));
  check('the navigator reads the unseen agents', /const unseenAgents = useUnseenAgents\(\)/.test(src('./Navigator.tsx')));
  const navSrc = src('./Navigator.tsx');
  check('the navigator marks it from the unseen jobs, never in amber', /navTree\(ordered, agents, pending, alerts, jobs, finished, unseenAgents\)/.test(navSrc) && /sh-nav-tag is-\$\{job\.status === 'failed' \? 'fail' : 'done'\}/.test(navSrc));

  const id = navJobId('web', 'jNew');
  check('a group is p:<id>:job:<jobId>', id === 'p:web:job:jNew');
  check('a group starts open: nothing stored shows it', jobShown(parseOpen(null), id));
  const closed = toggleOpen(parseOpen(null), id);
  check('one toggle closes it, a second opens it again', !jobShown(closed, id) && jobShown(toggleOpen(closed, id), id));
  check('closing a group touches no other node', jobShown(closed, navJobId('web', 'jOld')) && !isOpen(closed, navId('web', 'agents')) && closed.size === 1);
  check('a closed group survives the setting', !jobShown(parseOpen(serializeOpen(closed)), id));

  const nav = src('./Navigator.tsx');
  check('the Agents submenu draws the groups, not a flat list', /project\.jobs\.map\(/.test(nav) && !/project\.agents\.map\(/.test(nav));
  check('a group opens by jobShown on navJobId, through the same toggle', /jobShown\(open, id\)/.test(nav) && /navJobId\(project\.id, job\.id\)/.test(nav) && /onClick=\{\(\) => toggle\(id\)\}/.test(nav));
  check("a group's head has the dot, the prompt, the count and what waits", /<Dot status=\{job\.status\} \/>/.test(nav) && /\{job\.label\}/.test(nav) && /\{job\.agents\.length\}/.test(nav) && /job\.needs > 0 && <span className="sh-nav-need">/.test(nav));
  const css = src('./shell.css');
  check('the group head is drawn, and not in amber', /\.sh-nav-jhead\s*\{/.test(css) && !/\.sh-nav-jhead[^}]*--need/.test(css));
}

{
  const nav = readFileSync(new URL('./Navigator.tsx', import.meta.url), 'utf8');
  check("the navigator's + adds a project, on Fleet's form, not new work (Amendment 71)", /navigate\(SCREEN\.fleet, \{ add: '1' \}\)/.test(nav) && !/openSpawn\(\)/.test(nav));
}

console.log('\n9 · Files opens into a folder\'s directories as a tree (Amendment 92)');
{
  check('a folder\'s own node is navDirId with no path', navDirId('web', 'root', '') === 'p:web:files:root:');
  check('format: p:<projectId>:files:<root>:<path>', navDirId('p1', 'r1', 'src/app') === 'p:p1:files:r1:src/app');

  check(
    'a different project never shares an id with another, root and path held equal',
    navDirId('p1', 'r', 'a/b') !== navDirId('p2', 'r', 'a/b'),
  );
  check(
    'a different root never shares an id with another, project and path held equal',
    navDirId('p1', 'r1', 'a/b') !== navDirId('p1', 'r2', 'a/b'),
  );
  check(
    'a different path never shares an id with another, project and root held equal',
    navDirId('p1', 'r', 'a') !== navDirId('p1', 'r', 'a/b') && navDirId('p1', 'r', 'a') !== navDirId('p1', 'r', 'b'),
  );
  check("a folder's own node and one of its directories never collide", navDirId('p1', 'r', '') !== navDirId('p1', 'r', 'a'));

  check('a file row\'s link is the root as jobId, and the file\'s own path', JSON.stringify(navFileLink('root', 'src/app.ts')) === JSON.stringify({ jobId: 'root', path: 'src/app.ts' }));
  check(
    "that link is exactly what a #files deep link, and applyLink, read for a file (files/tabs.ts)",
    Object.keys(navFileLink('r', 'p')).sort().join() === 'jobId,path',
  );

  const nav = src('./Navigator.tsx');
  const tabs = src('../files/tabs.ts');
  check("FolderNode and the top of its tree share one node id, path ''", /navDirId\(project\.id, folder\.root, ''\)/.test(nav));
  check('a directory under it is named by its own root-relative path', /navDirId\(projectId, root, kid\.path\)/.test(nav));
  check('a file row navigates with navFileLink, through SCREEN.files', /navigate\(SCREEN\.files, navFileLink\(root, kid\.path\)\)/.test(nav));
  check('folders and files alike open and close by the same toggle every other nav node uses', /onClick=\{\(\) => toggle\(id\)\}/.test(nav));
  check('every toggle says whether it is open', /aria-expanded=\{shown\}/.test(nav));
  check('the tree is fetched with the Files screen\'s own hook, not a second one', /import \{[^}]*\buseFileTree\b[^}]*\} from '\.\.\/files\/useWorkspace\.js'/.test(nav) && /useFileTree\(root\)/.test(nav));
  check('no change marks: nothing here reads a node\'s change', !/kid\.change|node\.change/.test(nav));
  check('applyLink reads the same shape a file row sends', /path\s*\?\s*openTab\(s, jobId, path, now, keep\)/.test(tabs));
}

console.log('\n10 · the carry-through: filled marks and a nested repo\'s branch (Amendment 94)');
{
  const nav = src('./Navigator.tsx');
  const css = src('./shell.css');

  const rule = (c: string, selector: string): string => {
    const i = c.indexOf(`${selector} {`);
    return i === -1 ? '' : c.slice(i, c.indexOf('}', i));
  };

  check(
    "an agent row's own tag is filled live while working, filled done once finished and not yet opened (Amendment 105)",
    /a\.status === 'working' && <span className="sh-nav-tag is-live">working<\/span>/.test(nav) &&
      /a\.finished && <span className="sh-nav-tag is-done">finished<\/span>/.test(nav) &&
      !/a\.status === 'done' && <span className="sh-nav-tag is-done">/.test(nav),
  );
  check(
    "a job's group gets the same filled working tag when nothing has finished yet",
    /job\.status === 'working' && <span className="sh-nav-tag is-live">working<\/span>/.test(nav),
  );
  check(
    '.sh-nav-tag.is-live and .is-done are filled the same way .ui-tag.t-live/.t-done are (Amendment 93) — reused tokens, nothing invented',
    /background:\s*var\(--live\)/.test(rule(css, '.sh-nav-tag.is-live')) &&
      /font-weight:\s*700/.test(rule(css, '.sh-nav-tag.is-live')) &&
      /background:\s*var\(--done\)/.test(rule(css, '.sh-nav-tag.is-done')) &&
      /font-weight:\s*700/.test(rule(css, '.sh-nav-tag.is-done')),
  );
  check(
    'a nested repo\'s branch shows beside its folder in FileRows, "detached" when there is none',
    /kid\.repo && <span className="sh-nav-repo">⑂ \{kid\.repo\.branch \?\? 'detached'\}<\/span>/.test(nav),
  );
}

console.log('\n11 · an orchestrator wears the Agent tab\'s mark in the navigator too (Amendment 142)');
{
  // An orchestrated stack: the orchestrator with two roles listed, one helper started, and a plain agent beside it.
  const orch: Agent = { ...agent('o1', 'web', 'jP', 'orchestrator'), pipelineRoles: ['developer', 'reviewer'] };
  const helper: Agent = { ...agent('h1', 'web', 'jP', 'developer'), parentId: 'o1' };
  // An orchestrator whose stack is one agent: nothing to mark (Amendment 128, `showsOrchestrator`).
  const alone: Agent = { ...agent('o2', 'api', 'jQ', 'orchestrator'), pipelineRoles: [] };
  const all = [...agents, orch, helper, alone];
  const t = navTree(projects, all, [], [], [...jobs, { id: 'jP', createdAt: '2026-10-03T09:00:00Z', prompt: 'Run it' }]);
  const row = (id: string) => t.flatMap((p) => p.agents).find((a) => a.id === id)!;
  check('the orchestrator\'s row is marked', row('o1').orchestrator === true);
  check('its helper is not, nor a plain agent, nor an orchestrator with nothing listed', !row('h1').orchestrator && !row('a1').orchestrator && !row('o2').orchestrator && !row('b1').orchestrator);
  check('it is the Agent tab\'s own answer, for every agent', t.every((p) => p.agents.every((a) => a.orchestrator === agentTabs(all, p.id, ['jP', 'jNew', 'jApi', 'jOld'], [], []).find((x) => x.id === a.id)!.orchestrator)));
  check('a job\'s group carries the same rows, mark and all', t[0]!.jobs.find((j) => j.id === 'jP')!.agents.find((a) => a.id === 'o1')!.orchestrator);

  const nav = src('./Navigator.tsx');
  const tab = src('../agent/agent.tsx');
  check('the row draws the mark the Agent tab draws, OrchestratorMark short', /\{a\.orchestrator && <OrchestratorMark short \/>\}/.test(nav) && /\{t\.orchestrator && <OrchestratorMark short \/>\}/.test(tab));
  check('and its title says what the tab\'s says', /a\.orchestrator \? ' · orchestrator: starts the others' : ''/.test(nav) && /t\.orchestrator \? ' · orchestrator: starts the others' : ''/.test(tab));
  check('the mark comes from shell/ui.tsx, so its own title is the one every screen shows', /import \{[^}]*OrchestratorMark[^}]*\} from '\.\/ui\.js';/.test(nav));
}

console.log('\n12 · each agent row has its budget meter, and a job row the sum (Amendment 140)');
{
  const DAY = '2032-03-04';
  const spent = (a: Agent, usd: number, budgetUsd: number | null, tokens?: { spent: number; budget: number }): Agent => ({
    ...a,
    spentToday: { day: DAY, usd, tokens: tokens?.spent ?? 0 },
    autonomy: { ...a.autonomy, budgetUsd, ...(tokens ? { budgetTokens: tokens.budget } : {}) },
  });
  const ps = [{ id: 'm', name: 'meters', path: '/src/m' }];
  const as = [
    spent(agent('m1', 'm', 'jm', 'builder'), 5, 25), // 20%: ok
    spent(agent('m2', 'm', 'jm', 'reviewer'), 20, 25), // 80%: warn
    spent(agent('m3', 'm', 'jm', 'tester'), 0, null), // no budget
    spent(agent('n1', 'm', 'jn', 'builder'), 0, null), // a job with no budgets at all
    spent(agent('t1', 'm', 'jt', 'builder'), 0, null, { spent: 480_000, budget: 500_000 }), // 96% of a token budget: over
  ];
  const js = [
    { id: 'jm', createdAt: '2032-03-04T10:00:00Z', prompt: 'meters' },
    { id: 'jn', createdAt: '2032-03-04T09:00:00Z', prompt: 'none' },
    { id: 'jt', createdAt: '2032-03-04T08:00:00Z', prompt: 'tokens' },
  ];
  const [m] = navTree(ps, as, [], [], js, new Set(), new Set(), DAY);
  const row = (id: string) => m!.agents.find((a) => a.id === id)!;
  const group = (id: string) => m!.jobs.find((j) => j.id === id)!;

  check("an agent row's meter is the Fleet lane's own figure: budgetOf, the same day", JSON.stringify(row('m1').budget) === JSON.stringify(budgetOf(as[0]!, DAY)) && row('m1').budget?.tone === 'ok');
  check('the same tones: green under 75%, yellow from it, red from 95%', row('m1').budget?.tone === 'ok' && row('m2').budget?.tone === 'warn' && row('t1').budget?.tone === 'over', [row('m1'), row('m2'), row('t1')].map((r) => r.budget?.tone).join());
  check('an agent with no budget has no meter', row('m3').budget === null && row('n1').budget === null);
  check("a job's meter is its agents' summed: $25 of $50, 50%, and the one without a budget adds nothing", group('jm').budget?.spent === 25 && group('jm').budget?.cap === 50 && group('jm').budget?.pct === 50 && group('jm').budget?.tone === 'ok', JSON.stringify(group('jm').budget));
  check('a job none of whose agents has a budget has none', group('jn').budget === null);
  check('a job of token budgets sums in tokens, and reads red as its agent does', group('jt').budget?.unit === 'tokens' && group('jt').budget?.tone === 'over' && group('jt').budget?.cap === 500_000);
  check('dollars and tokens are never added: with any dollar budget, the sum is of those', sumBudgets([budgetOf(as[0]!, DAY), budgetOf(as[4]!, DAY)])?.unit === 'usd' && sumBudgets([budgetOf(as[0]!, DAY), budgetOf(as[4]!, DAY)])?.cap === 25);
  check('and a sum of nothing is nothing', sumBudgets([]) === null && sumBudgets([null, null]) === null);
  check('a stale day stamp reads nothing spent, as the lane does', navTree(ps, as, [], [], js, new Set(), new Set(), '2032-03-05')[0]!.agents.find((a) => a.id === 'm2')!.budget?.spent === 0);
  check(
    'the hover says the figure, its unit, and what over means',
    meterTitle(row('m2').budget!, "builder's daily budget") === "builder's daily budget: $20.00 of $25.00 today, 80%" &&
      meterTitle(row('t1').budget!, 'x') === 'x: 480k tokens of 500k tokens today, 96%' &&
      /over it; a warning, it stops at \$50\.00/.test(meterTitle(budgetOf(spent(agent('o', 'm', 'jm', 'builder'), 30, 25), DAY)!, 'x')),
    meterTitle(row('t1').budget!, 'x'),
  );
  readBudgetCeilingFrom(() => 1.5);
  check("the ceiling it names is the setting's: at 1.5, $25 stops at $37.50", budgetOf(spent(agent('o', 'm', 'jm', 'builder'), 30, 25), DAY)?.ceiling === 37.5 && budgetOf(spent(agent('o', 'm', 'jm', 'builder'), 37.5, 25), DAY)?.state === 'ceiling');
  readBudgetCeilingFrom(() => 2);

  const nav = src('./Navigator.tsx');
  const css = src('./shell.css');
  check(
    "the rows draw the Fleet's pj-meter with its data-tone, on the agent row and the job's heading",
    /className="pj-meter sh-nav-meter" data-tone=\{budget\.tone\}/.test(nav) &&
      /<NavMeter budget=\{a\.budget\}/.test(nav) &&
      /<NavMeter budget=\{job\.budget\}/.test(nav) &&
      /if \(!budget\) return null;/.test(nav),
  );
  check('the Fleet\'s stylesheet is loaded with the panel, so its tones are there on every screen', /import '\.\.\/fleet\/fleet\.css';/.test(nav));
  const i = css.indexOf('.pj-meter.sh-nav-meter {');
  const rule = i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  check('the panel only sizes it: no colour of its own, so the tones are the Fleet\'s tokens', rule !== '' && !/#|rgb|hsl|background|color/.test(rule), rule);
}

console.log(
  failures === 0
    ? '\nShell verify: PASS — each project lists only its own agents, needs and folders, in order; Needs you lights only when something waits; every node opens on its own and a broken setting opens nothing; the right-panel icon shows only on the Agent screen; the projects follow the Fleet\'s Sort by, and a drag sets your order; the agents are grouped by job, open to start with; a folder opens into its directories as a tree, and a file row\'s link matches what applyLink reads; working and finished are filled in the navigator too, and a nested repo\'s branch shows beside its folder; an orchestrator wears the Agent tab\'s mark; each agent row has its budget meter in the Fleet\'s tones, and a job row the sum.\n'
    : `\nShell verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
