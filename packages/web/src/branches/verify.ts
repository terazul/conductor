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
import type { BranchInfo, BranchMergePreview, BranchesResponse } from '@conductor/shared';
import { G, badges, layout } from './graph.js';
import { onBranchesChanged, receiveBranches } from './live.js';
import {
  FORGET_LABEL,
  checkoutConfirm,
  checkoutReason,
  cleanConfirm,
  cleanLine,
  cleanState,
  commitReason,
  deleteConfirm,
  deleteReason,
  ownedReason,
  ownersOf,
  removedText,
  defaultInto,
  defaultMessage,
  intoChoices,
  intoReason,
  makeDefaultReason,
  mergeAllState,
  mergeConfirm,
  mergeReason,
  previewLine,
  pushConfirm,
  rootLine,
  targetFromWords,
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

console.log('\n7 · merge into any branch (Amendment 110)');
{
  const pv = (p: Partial<BranchMergePreview> = {}): BranchMergePreview => ({
    branch: 'feature/long', into: 'conductor/job_a', ahead: 7, behind: 1, commits: [], conflicts: [], reason: null, ...p,
  });
  check('every other branch is a choice, the target first', intoChoices(resp, job).map((b) => b.name).join() === 'main,conductor/job_b,feature/done,feature/long,gh-pages');
  check('a branch is never offered itself', intoChoices(resp, main).every((b) => b.name !== 'main'));
  check('a branch starts pointed at the target, the target at nothing', defaultInto(resp, job) === 'main' && defaultInto(resp, main) === '');
  check('into the target it is mergeReason, as before', intoReason(resp, job, main, null) === mergeReason(resp, job) && intoReason(resp, live, main, null) === mergeReason(resp, live));
  check('nothing chosen says to choose', /choose a branch/.test(intoReason(resp, main, null, null) ?? ''));
  check('the target can go into a job branch, to bring it up to date', intoReason(resp, main, job, pv({ branch: 'main', ahead: 2 })) === null);
  check('refused into a live branch', /working on conductor\/job_b/.test(intoReason(resp, long, live, null) ?? ''));
  check("refused into a branch checked out nowhere", /isn't checked out/.test(intoReason(resp, job, long, null) ?? ''));
  check('fine into a checked-out branch while the preview is on its way', intoReason(resp, long, job, null) === null);
  check("the preview's own reason is the word", intoReason(resp, long, job, pv({ reason: "conductor/job_a's checkout has changes" })) === "conductor/job_a's checkout has changes");
  check('a preview of another pair is ignored', intoReason(resp, long, job, pv({ into: 'main', reason: 'x' })) === null);
  check('known conflicts refuse it, and say how many files', /conflict with conductor\/job_a in 2 files/.test(intoReason(resp, long, job, pv({ conflicts: ['a', 'b'] })) ?? ''));
  check('a conflict into the target refuses too', /conflict with main/.test(intoReason(resp, job, main, pv({ branch: job.name, into: 'main', conflicts: ['x'] })) ?? ''));
  check('the preview line: commits, behind, no conflicts', previewLine(pv()) === "7 commits from feature/long · conductor/job_a has 1 commit feature/long doesn't · no conflicts", previewLine(pv()));
  check('names the conflicted files', /conflicts in a\.txt, b\.txt$/.test(previewLine(pv({ conflicts: ['a.txt', 'b.txt'] }))));
  check("says when this git can't tell", /conflicts unknown until it runs/.test(previewLine(pv({ conflicts: null }))));
  check('nothing to merge says so', /^nothing to merge/.test(previewLine(pv({ ahead: 0 }))));
  check('the confirm names where it goes and the count it was given', /into conductor\/job_a/.test(mergeConfirm(resp, long, 'conductor/job_a', 7).ask) && /\(7 commits\)/.test(mergeConfirm(resp, long, 'conductor/job_a', 7).ask));

  const route = src('./route.tsx');
  check('the bar has a "merge into" picker and asks for a preview', /<select\s+id="br-into"/.test(route) && /previewMerge\(projectId, branch, into\)/.test(route));
  check('into the target sends no into, so it is the merge it always was', /intoBranch\?\.isTarget \? \{ action: 'merge', branch: b\.name \} : \{ action: 'merge', branch: b\.name, into \}/.test(route));
  check('the outcome says where it went', /const target = res\.into \?\? fallback;/.test(route));
  check('the graph marks the branch it would go into', /into=\{branch && into \? into : null\}/.test(route) && /merges here/.test(src('./graph.tsx')));
}

console.log('\n8 · what everything is drawn against (Amendment 113)');
{
  check('each source says where it came from', targetFromWords('origin') === "origin's default branch" && /when the project was added/.test(targetFromWords('project')) && targetFromWords('chosen') === 'chosen by you');
  const route = src('./route.tsx');
  check('the head has a "compared with" picker, automatic first', /<CompareWith projectId=\{project\.id\} resp=\{resp\} \/>/.test(route) && /<option value="">automatic — \{resp\.target\}<\/option>/.test(route));
  check('choosing writes the per-project setting, automatic removes it', /writeSetting\(key, e\.target\.value \|\| null\)/.test(route) && /const key = branchTargetKey\(projectId\);/.test(route));
}

console.log("\n9 · a project's default branch, and checking it out on it (Amendment 117)");
{
  check('already the default: refused, and nothing else is asked', makeDefaultReason('main', main) === 'already the default');
  check('any other branch: fine to make the default', makeDefaultReason('main', job) === null);

  const clean = { ...resp, rootBranch: 'main', rootClean: true, rootLive: false };
  check('checkout: fine when the folder is clean, idle, and this isn\'t already the default', checkoutReason(clean, 'main', job) === null);
  check('checkout: refused for the branch that already is the default', checkoutReason(clean, 'main', main) === 'already the default');
  const dirtyRoot = { ...resp, rootBranch: 'main', rootClean: false, rootLive: false };
  check('checkout: refused with uncommitted changes in the project folder', /uncommitted changes/.test(checkoutReason(dirtyRoot, 'main', job) ?? ''));
  const liveRoot = { ...resp, rootBranch: 'main', rootClean: true, rootLive: true };
  check('checkout: refused while an agent works in the project folder', /working in the project folder/.test(checkoutReason(liveRoot, 'main', job) ?? ''));
  check('a dirty folder outranks "already live": the first reason wins either way', checkoutReason({ ...dirtyRoot, rootLive: true }, 'main', job) === checkoutReason(dirtyRoot, 'main', job));
  check('being the default outranks either folder problem', checkoutReason(dirtyRoot, 'main', main) === 'already the default');

  check('the header, with the folder undetermined (no rootBranch key)', rootLine('main', undefined).text === 'default: main' && rootLine('main', undefined).warn === false);
  check('the header, folder on the default: no warning', rootLine('main', 'main').text === 'default: main · folder on main' && rootLine('main', 'main').warn === false);
  check('the header, folder on something else: warns', rootLine('main', 'conductor/job_a').text === 'default: main · folder on conductor/job_a' && rootLine('main', 'conductor/job_a').warn === true);
  check('the header, folder detached: says so, and warns', rootLine('main', null).text === 'default: main · folder on nothing — detached' && rootLine('main', null).warn === true);

  check('the checkout confirm names the folder and the branch, and warns what runs there', /\/r/.test(checkoutConfirm('/r', 'main')) && /main/.test(checkoutConfirm('/r', 'main')) && /Conductor itself/.test(checkoutConfirm('/r', 'main')));

  const route = src('./route.tsx');
  check('the bar offers "Make default" and "Make default and check out"', /Make default/.test(route) && /Make default and check out/.test(route));
  check('the header shows the default/folder line next to "compared with"', /<RootLine defaultBranch=\{project\.defaultBranch\} rootBranch=\{resp\.rootBranch\} \/>/.test(route));
  check("checking out asks to confirm first", /setConfirming\('checkout'\)/.test(route) && /checkoutConfirm\(path, b\.name\)/.test(route));
  check("the action sent is set_default, checkout true only once confirmed", /\{ action: 'set_default', branch: b\.name, checkout: false \}/.test(route) && /\{ action: 'set_default', branch: b\.name, checkout: true \}/.test(route));
}

console.log('\n10 · deleting merged branches, and cleaning them all up (Amendment 143)');
{
  const done = br('conductor/job_d', { ahead: 0, behind: 3, jobId: 'job_d', worktree: { path: '/r/.conductor/wt/job_d', uncommitted: 0 } });
  const dirty = br('feature/dirty', { ahead: 0, behind: 1, worktree: { path: '/r/.conductor/wt/dirty', uncommitted: 1 } });
  const unpushed = br('feature/unpushed', { ahead: 0, behind: 1, upstream: { ref: 'origin/feature/unpushed', ahead: 2, behind: 0 } });
  const busy = br('conductor/job_busy', { ahead: 0, behind: 1, live: true, jobId: 'job_busy' });
  const onRoot = br('on/root', { ahead: 0, behind: 1 });
  const r: BranchesResponse = { ...resp, rootBranch: 'on/root', branches: [main, job, merged, orphan, done, dirty, unpushed, busy, onRoot] };
  const jobs = [
    { id: 'job_d', branch: 'conductor/job_d', projectId: 'p1' },
    { id: 'job_d2', branch: 'conductor/job_d', projectId: 'p1' },
    { id: 'job_other', branch: 'feature/done', projectId: 'p2' },
  ];
  const own = (b: BranchInfo) => ownersOf(b, jobs, 'p1');

  check("the owners are the listing's job and every job of the project on it", own(done).join() === 'job_d,job_d2' && own(merged).length === 0, own(done).join());
  check('the target: refused, named', deleteReason(r, main, [], false) === 'this is main, the branch everything is compared with');
  check("the project folder's own branch: refused", deleteReason(r, onRoot, [], false) === "it is checked out in the project's own folder — switch that folder to another branch first");
  check('not merged: refused, saying -d would refuse it', deleteReason(r, job, [], false) === "3 commits on it aren't in main — it isn't merged, and git branch -d would refuse it");
  check('unrelated history: refused', deleteReason(r, orphan, [], false) === "it shares no history with main, so it isn't merged into it");
  check('a commit its upstream lacks: refused', deleteReason(r, unpushed, [], false) === "2 commits on it aren't on origin/feature/unpushed, and git branch -d checks against it — push it first");
  check('uncommitted (untracked counts): refused', deleteReason(r, dirty, [], false) === 'its folder has 1 uncommitted file (untracked ones count) — commit or discard it first');
  check('a live agent: refused even with forget', deleteReason(r, busy, own(busy), true) === 'an agent is working on it — wait for it to finish');
  check(
    "a job's branch, not forgetting: the daemon's sentence",
    deleteReason(r, done, own(done), false) === ownedReason('job_d') &&
      ownedReason('job_d') === "job job_d's agents can still be messaged, and they need this folder; remove the job, or choose 'forget the job too'",
  );
  check("a job's branch, forgetting: allowed", deleteReason(r, done, own(done), true) === null);
  check('a merged branch with no job and no folder: allowed', deleteReason(r, merged, [], false) === null);
  check('the checkbox says the transcripts stay', FORGET_LABEL === 'forget its job too (its transcripts stay)');

  const plainAsk = deleteConfirm(merged, [], false);
  check(
    'the confirm names the branch, says it has no folder, and that origin keeps its copy',
    plainAsk === 'Delete feature/done? It is merged; it has no folder, and the branch goes with git branch -d. Origin keeps its copy, if it has one.',
    plainAsk,
  );
  const jobAsk = deleteConfirm(done, own(done), true);
  check(
    "forgetting, the confirm names the folder and the jobs, and says the agents can't be messaged after",
    jobAsk.includes('/r/.conductor/wt/job_d is removed (git worktree remove, never forced)') &&
      jobAsk.includes("Jobs job_d, job_d2 are removed first: their agents can't be messaged afterwards, and their transcripts stay."),
    jobAsk,
  );
  check('not forgetting, it says nothing of jobs', !deleteConfirm(done, own(done), false).includes('Job'));

  const kept = cleanState(r, own, false);
  check('clean up: only what passes goes', kept.go.map((b) => b.name).join() === 'feature/done', kept.go.map((b) => b.name).join());
  check('  and each one that stays has its sentence', kept.stay.length === 5 && kept.stay.every((k) => k.why.length > 0) && kept.stay.some((k) => k.branch === 'conductor/job_d' && k.why === ownedReason('job_d')), JSON.stringify(kept.stay));
  check('  never the target or an unmerged branch', ![...kept.go.map((b) => b.name), ...kept.stay.map((k) => k.branch)].some((x) => x === 'main' || x === 'conductor/job_a' || x === 'gh-pages'));
  const forgetting = cleanState(r, own, true);
  check('  with forget, the job-owned one goes too, oldest tip first', forgetting.go.map((b) => b.name).join() === 'feature/done,conductor/job_d', forgetting.go.map((b) => b.name).join());
  check('  nothing merged: says so', cleanState({ ...resp, branches: [main, job] }, own, false).reason === 'nothing to clean up — no branch is merged into main');
  check('the confirm line names branch, folder and job', cleanLine(done, own(done)) === 'conductor/job_d · /r/.conductor/wt/job_d · job job_d, job_d2' && cleanLine(merged, []) === 'feature/done · no folder · no job');
  check(
    "the clean-up ask says never forced, origin untouched, and with jobs that their agents can't be messaged",
    /never forced; origin is not touched\.$/.test(cleanConfirm(1, false, 0)) &&
      /2 jobs are removed with them: their agents can't be messaged afterwards, and the transcripts stay\./.test(cleanConfirm(2, true, 2)),
  );
  check(
    'the result names what went and the jobs forgotten',
    removedText(['a', 'b'], ['job_x']) === 'Removed a, b, with their folders. Forgot job job_x; the transcripts stay.' && removedText([], []) === 'Nothing was removed.',
  );

  const route = src('./route.tsx');
  check('the bar has Delete, with its reason from rules.ts', /label=\{busy === 'delete' \? 'Deleting…' : 'Delete'\} reason=\{del\}/.test(route) && /deleteReason\(resp, b, owners, forget\)/.test(route));
  check('the checkbox shows only when a job owns it', /owners\.length > 0 && !b\.isTarget && \(/.test(route) && /\{FORGET_LABEL\}/.test(route));
  check(
    'Delete confirms first, and sends forgetJob only when ticked',
    /setConfirming\('delete'\)/.test(route) && /deleteConfirm\(b, owners, forget\)/.test(route) && /\{ action: 'delete', branch: b\.name, forgetJob: true \}/.test(route),
  );
  check(
    'the head has ⌫ Clean up merged (n), confirmed with each branch, folder and job',
    /⌫ Clean up merged \(\$\{clean\.go\.length\}\)/.test(route) && /setConfirming\('clean'\)/.test(route) && /cleanLine\(b, owners\(b\)\)/.test(route),
  );
  check('clean up sends forgetJobs only when ticked', /forgetAll \? \{ action: 'clean_merged', forgetJobs: true \} : \{ action: 'clean_merged' \}/.test(route));
  check('the result lists what stayed, with why', /res\.kept\.map/.test(route) && /stayed — \{k\.why\}/.test(route));
}

console.log('\n6 · the status bar and nav.ts');
{
  // 1–7 when Branches was the last screen; Metrics (8, Amendment 122) made it 1–8.
  check('shell.tsx says 1–8 screens', /<kbd>1<\/kbd>–<kbd>8<\/kbd> screens/.test(src('../shell/shell.tsx')));
  const nav = src('../shell/nav.ts');
  check("nav.ts has SCREEN.branches = 'branches'", /branches:\s*'branches'/.test(nav));
  check('nav.ts has openBranches(projectId), going to the screen with the project', /export function openBranches\(projectId: string\)/.test(nav) && /navigate\(SCREEN\.branches, \{ projectId \}\)/.test(nav));
}

console.log(
  failures === 0
    ? '\nAmendment 109 web verify: PASS — the graph lays out from a response alone, with fork points, dots, a dimmed merged row and an unrelated branch; every disabled action says why; a branches frame reaches the screen; 7 is Branches and nothing else; the status bar says 1–8; nav.ts opens it; merging into any branch works (110); what everything is drawn against is explained (113); a project\'s default branch can be set and checked out, with its own reasons and header line (117); merged branches are deleted only with their reasons met, and a job\'s only when you forget it too (143).'
    : `\nAmendment 109 web verify: FAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
