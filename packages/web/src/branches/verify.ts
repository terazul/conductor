/**
 * Validator checks for Amendment 109's web half (the Branches screen, ADR 0008 § Testing).
 *
 * No daemon and no DOM: `layout()` and the rules are pure and are run on fixture
 * responses; the registration, the status bar and nav.ts are read as source, because
 * importing route.tsx would pull in its CSS.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/branches/verify.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { BranchInfo, BranchesResponse } from '@conductor/shared';
import { G, badges, layout } from './graph.js';
import { onBranchesChanged, receiveBranches } from './live.js';
import {
  commitReason,
  defaultMessage,
  mergeAllState,
  mergeConfirm,
  mergeReason,
  pushConfirm,
  pushReason,
  showCommit,
  showPush,
  targetReason,
} from './rules.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
let n = 0;
const sha = (): string => (++n).toString(16).padStart(40, 'a');

function br(name: string, patch: Partial<BranchInfo> = {}): BranchInfo {
  const ahead = patch.ahead ?? 0;
  return {
    name,
    head: sha(),
    subject: `tip of ${name}`,
    at: T(n),
    isTarget: false,
    ahead,
    behind: 0,
    forkedAt: sha(),
    commits: Array.from({ length: Math.min(ahead, 20) }, (_, i) => ({ sha: sha(), subject: `${name} #${ahead - i}`, at: T(i) })),
    worktree: null,
    jobId: null,
    live: false,
    upstream: null,
    ...patch,
  };
}

const main = br('main', { isTarget: true, upstream: { ref: 'origin/main', ahead: 0, behind: 0 }, worktree: { path: '/r', uncommitted: 0 } });
const job = br('conductor/job_a', { ahead: 3, behind: 2, jobId: 'job_a', worktree: { path: '/r/.conductor/wt/job_a', uncommitted: 2 } });
const live = br('conductor/job_b', { ahead: 1, behind: 0, live: true, jobId: 'job_b', upstream: { ref: 'origin/conductor/job_b', ahead: 1, behind: 0 } });
const merged = br('feature/done', { ahead: 0, behind: 5, upstream: { ref: 'origin/feature/done', ahead: 0, behind: 0 } });
const long = br('feature/long', { ahead: 25, behind: 2 });
const orphan = br('gh-pages', { ahead: 4, behind: 9, forkedAt: null });

const resp: BranchesResponse = {
  projectId: 'p1',
  target: 'main',
  remote: 'origin',
  targetCheckout: { path: '/r', clean: true },
  branches: [main, job, live, merged, long, orphan],
};

console.log('\n1 · layout() is pure: rows, fork points and dots from a response');
{
  const g = layout(resp);
  check('the target is the rail, not a row', g.target?.name === 'main' && g.rows.every((r) => !r.branch.isTarget));
  check('one row per other branch, in the order given', g.rows.map((r) => r.branch.name).join() === 'conductor/job_a,conductor/job_b,feature/done,feature/long,gh-pages', g.rows.map((r) => r.branch.name).join());
  check('rows go down the screen evenly', g.rows.every((r, i) => r.y === G.firstRowY + i * G.rowH));
  check('rows sit below the rail', g.rows.every((r) => r.y > g.railY));
  const behinds = g.railDots.map((d) => d.behind).join();
  check('one rail dot per distinct fork distance, oldest left, the tip last (unrelated branches add none)', behinds === '5,2,0', behinds);
  check('the rail dots run left to right', g.railDots.every((d, i) => i === 0 || d.x > g.railDots[i - 1]!.x));
  check('the tip is the rightmost rail dot', g.headX === g.railDots[g.railDots.length - 1]!.x);
  check('the commits between fork points are counted, not drawn', g.railDots[0]!.skipped === 2 && g.railDots[1]!.skipped === 1 && g.railDots[2]!.skipped === 0, g.railDots.map((d) => d.skipped).join());
  const row = (name: string) => g.rows.find((r) => r.branch.name === name)!;
  const xAt = (behind: number) => g.railDots.find((d) => d.behind === behind)!.x;
  check('a branch 2 behind forks from the rail dot 2 back', row('conductor/job_a').forkX === xAt(2) && row('feature/long').forkX === xAt(2));
  check('a branch level with the tip forks from the tip', row('conductor/job_b').forkX === g.headX);
  check('its curve lands to the right of its fork', row('conductor/job_a').startX === xAt(2) + G.curve);
  check('a dot per commit ahead', row('conductor/job_a').dots.length === 3 && row('conductor/job_b').dots.length === 1);
  check('the dots run left to right, a gap apart', row('conductor/job_a').dots.every((d, i, a) => i === 0 || d.x - a[i - 1]!.x === G.gap));
  check('left to right is oldest to newest, each with its subject', row('conductor/job_a').dots.map((d) => d.title?.split(' ').slice(1).join(' ')).join('|') === 'conductor/job_a #1|conductor/job_a #2|conductor/job_a #3', row('conductor/job_a').dots.map((d) => d.title).join('|'));
  check('the tip is the last dot', row('conductor/job_a').tipX === row('conductor/job_a').dots[2]!.x);
  check('uncommitted work is a hollow dot after the tip, and the label after that', row('conductor/job_a').uncommittedX === row('conductor/job_a').tipX + G.gap && row('conductor/job_a').labelX > row('conductor/job_a').uncommittedX!);
  check('no uncommitted dot without uncommitted work', row('conductor/job_b').uncommittedX === null);
  check(`at most ${G.maxDots} dots; the rest are counted`, row('feature/long').dots.length === G.maxDots && row('feature/long').elided === 15);
  check('the counted commits sit before the dots', row('feature/long').elidedX < row('feature/long').dots[0]!.x);
  check('only a row with ahead 0 is dimmed', row('feature/done').dimmed && g.rows.filter((r) => r.dimmed).length === 1);
  check('a merged row has no dots and joins the rail where its tip is', row('feature/done').dots.length === 0 && row('feature/done').forkX === xAt(5) && row('feature/done').tipX === row('feature/done').startX);
  check('an unrelated branch has no fork point, and starts at the left on its own', row('gh-pages').forkX === null && row('gh-pages').startX === G.pad + 8 && row('gh-pages').dots.length === 4);
  check('the picture is wide enough for every label', g.rows.every((r) => r.labelX + r.branch.name.length * G.ch <= g.width), String(g.width));
  check('and tall enough for every row', g.height >= g.rows[g.rows.length - 1]!.y + G.rowH / 2);
  check('the same response lays out the same way twice', JSON.stringify(layout(resp)) === JSON.stringify(g));
  const only = layout({ ...resp, branches: [main] });
  check('with only the target: no rows, one rail dot', only.rows.length === 0 && only.railDots.length === 1 && only.height > only.railY);
  const none = layout({ ...resp, branches: [] });
  check('an empty response still lays out', none.rows.length === 0 && none.target === null && none.width > 0);
}

console.log('\n2 · the badges');
{
  const text = (b: BranchInfo) => badges(resp, b).map((x) => x.text).join(' | ');
  check('behind, uncommitted and not on origin', text(job) === '↓2 behind | ± 2 uncommitted | not on origin', text(job));
  check('live, and origin ↑a ↓b', text(live) === 'live | origin ↑1 ↓0', text(live));
  check('live is the only badge in the live tone', badges(resp, live).filter((b) => b.tone === 'live').length === 1 && [job, merged, long, orphan].every((b) => badges(resp, b).every((x) => x.tone !== 'live')));
  check('a merged branch says so', text(merged).startsWith('in main | ↓5 behind'), text(merged));
  check('no origin, no origin badge', badges({ ...resp, remote: null }, job).every((b) => b.tone !== 'none' && b.tone !== 'origin'));
  check('the target shows no "behind" or "in main"', badges(resp, main).map((b) => b.text).join() === 'origin ↑0 ↓0');
  const g = layout(resp);
  check('aria-labels say what the picture shows', /3 commits ahead of main/.test(g.rows[0]!.ariaLabel) && /live/.test(g.rows[1]!.ariaLabel) && /no history/.test(g.rows[4]!.ariaLabel), g.rows.map((r) => r.ariaLabel).join(' / '));
}

console.log('\n3 · what is disabled, and why');
{
  const all = mergeAllState(resp);
  check('merge all counts the branches ahead, not live, not the target, not unrelated', all.count === 2 && all.reason === null, JSON.stringify(all));
  const dirty = { ...resp, targetCheckout: { path: '/r', clean: false } };
  check('merge all: main has uncommitted changes', /uncommitted changes/.test(mergeAllState(dirty).reason ?? ''));
  check('merge all: main isn\'t checked out', /isn't checked out/.test(mergeAllState({ ...resp, targetCheckout: null }).reason ?? ''));
  check('merge all: nothing to merge', mergeAllState({ ...resp, branches: [main, merged, live] }).count === 0 && /nothing to merge/.test(mergeAllState({ ...resp, branches: [main, merged, live] }).reason ?? ''));
  check('a dirty main outranks "nothing to merge"', /uncommitted/.test(mergeAllState({ ...dirty, branches: [main] }).reason ?? ''));
  check('targetReason is null when main is checked out clean', targetReason(resp) === null);

  check('merge: fine for a branch ahead', mergeReason(resp, job) === null);
  check('merge: refused for a branch with no history in common', /no history/.test(mergeReason(resp, orphan) ?? ''));
  check('merge: refused while live', /working on it/.test(mergeReason(resp, live) ?? ''));
  check('merge: nothing to merge when ahead 0', /nothing to merge/.test(mergeReason(resp, merged) ?? ''));
  check('merge: not the target into itself', mergeReason(resp, main) !== null);
  check('merge: dirty main', /uncommitted changes/.test(mergeReason(dirty, job) ?? ''));
  const c = mergeConfirm(resp, job);
  check('the merge confirm names the branch and its commits', /conductor\/job_a/.test(c.ask) && /3 commits/.test(c.ask) && /main/.test(c.ask), c.ask);
  check("and warns that its uncommitted work won't be merged", /2 uncommitted files/.test(c.warn ?? '') && /won't be merged/.test(c.warn ?? ''), c.warn ?? '');
  check('no warning without uncommitted work', mergeConfirm(resp, long).warn === null);
  check('one commit is "1 commit"', /\(1 commit\)/.test(mergeConfirm(resp, live).ask));

  check('commit: offered only with uncommitted work', showCommit(job) && !showCommit(live) && !showCommit(merged));
  check('commit: fine with uncommitted work', commitReason(job) === null);
  check('commit: refused while live', /working on it/.test(commitReason({ ...job, live: true }) ?? ''));
  check('commit: nothing to commit', commitReason(main) === 'nothing to commit');
  check('commit: not checked out', /isn't checked out/.test(commitReason(long) ?? ''));
  check("the message starts as the first line of the job's prompt", defaultMessage(job, [{ id: 'job_a', prompt: '\n  Add a login page  \nwith tests' }]) === 'Add a login page');
  check('and empty for a branch with no job', defaultMessage(long, [{ id: 'job_a', prompt: 'x' }]) === '');

  check('push: offered with no upstream', showPush(resp, job) && showPush(resp, long));
  check('push: offered when ahead of its upstream', showPush(resp, live));
  check('push: hidden when origin has it all', !showPush(resp, merged) && !showPush(resp, main));
  check('push: hidden with no remote', !showPush({ ...resp, remote: null }, job));
  check('push: fine for a branch not on origin', pushReason(resp, job) === null);
  check('push: refused while live', /working on it/.test(pushReason(resp, live) ?? ''));
  check('push: nothing to push', /nothing to push/.test(pushReason(resp, merged) ?? ''));
  check('push: no origin', /no origin/.test(pushReason({ ...resp, remote: null }, job) ?? ''));
  check('the push confirm says it creates the branch on origin', /isn't there yet/.test(pushConfirm(resp, job)));
  check('and never forces', /Never forced/.test(pushConfirm(resp, live)));
}

console.log('\n4 · a branches frame reaches the screen');
{
  const heard: string[] = [];
  const off = onBranchesChanged((id) => heard.push(id));
  receiveBranches('p1');
  receiveBranches('p2');
  off();
  receiveBranches('p3');
  check('each frame is heard, and not after unsubscribing', heard.join() === 'p1,p2', heard.join());
  const store = src('../lib/store.ts');
  const at = store.indexOf("case 'branches':");
  check("store.ts hands the frame to branches/live.ts", at > 0 && /receiveBranches\(frame\.projectId\)/.test(store.slice(at, at + 300)) && /from '\.\.\/branches\/live\.js'/.test(store));
}

console.log('\n5 · screen 7 is Branches, and nothing else claims 7');
{
  const route = src('./route.tsx');
  const def = route.slice(route.indexOf('export const screen'));
  check("route.tsx registers id 'branches', hotkey '7', order 65", /id:\s*'branches'/.test(def) && /hotkey:\s*'7'/.test(def) && /order:\s*65/.test(def), def.slice(0, 200));
  check('its header uses the shared crumb', /className="ui-crumb"/.test(route) && /<b>branches<\/b>/.test(route));
  check('it re-reads on focus, on a branches frame, and from an action\'s answer', /addEventListener\('focus'/.test(route) && /onBranchesChanged/.test(route) && /accept\(res\.branches\)/.test(route));
  check('errors go through errorText', /errorText\(err\)/.test(route));
  check('a conflict says the merge was undone', /the merge was undone/.test(route));
  check("push and fetch show git's output in a <pre>", /<pre className="br-output">\{res\.output\}<\/pre>/.test(route));

  const root = new URL('../', import.meta.url);
  const claims: string[] = [];
  for (const dir of readdirSync(root)) {
    const url = new URL(`${dir}/route.tsx`, root);
    try {
      if (!statSync(new URL(`${dir}/`, root)).isDirectory()) continue;
      const text = readFileSync(url, 'utf8');
      if (/hotkey:\s*'7'/.test(text)) claims.push(dir);
    } catch {
      /* no route.tsx in that directory */
    }
  }
  check('no other ./*/route.tsx claims hotkey 7', claims.join() === 'branches', claims.join());
  check('lib/screens.ts reserves 7 for Branches', /65\s+'7'\s+Branches/.test(src('../lib/screens.ts')));
  check('lib/verify.ts no longer uses 7 as a made-up hotkey', !/hotkey: '7'/.test(src('../lib/verify.ts')));

  const css = src('./branches.css');
  check('branches.css has no colour literals, only tokens', !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  const liveUses = css.split('\n').filter((l) => /var\(--live\)/.test(l)).length;
  const liveRules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^}]*var\(--live\)[^}]*\}/g) ?? [];
  check('--live is used only for a live branch', liveUses > 0 && liveRules.every((r) => /live/.test(r.split('{')[0] ?? '')), liveRules.map((r) => r.split('{')[0]?.trim()).join(' / '));
  check('--need is not used on this screen', !/--need/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n6 · the status bar and nav.ts');
{
  check('shell.tsx says 1–7 screens', /<kbd>1<\/kbd>–<kbd>7<\/kbd> screens/.test(src('../shell/shell.tsx')));
  const nav = src('../shell/nav.ts');
  check("nav.ts has SCREEN.branches = 'branches'", /branches:\s*'branches'/.test(nav));
  check('nav.ts has openBranches(projectId), going to the screen with the project', /export function openBranches\(projectId: string\)/.test(nav) && /navigate\(SCREEN\.branches, \{ projectId \}\)/.test(nav));
}

console.log(
  failures === 0
    ? '\nAmendment 109 web verify: PASS — the graph lays out from a response alone, with fork points, dots, a dimmed merged row and an unrelated branch; every disabled action says why; a branches frame reaches the screen; 7 is Branches and nothing else; the status bar says 1–7; nav.ts opens it.'
    : `\nAmendment 109 web verify: FAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
