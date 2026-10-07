/**
 * Track B verification — the transcript's markdown renderer, and the agent screen's
 * pure decisions: budget parsing, file links (F16) and where it lands (F15).
 *
 * TRACK B owns this file. It does not touch W0's web verify (src/lib/verify.ts).
 *
 *   pnpm --filter @conductor/web exec tsx src/agent/verify.ts
 *
 * No daemon, no browser: `renderMarkdown` is pure, and `renderToStaticMarkup` from
 * react-dom (already a dependency) turns its output into a string this script can
 * assert on.
 *
 * WHY THIS SCRIPT EXISTS. The renderer's whole safety argument is "it returns React
 * elements, so React escapes the text and no sanitizer is needed" (see markdown.tsx).
 * That argument is true of the code as written and would be silently false the moment
 * anyone reached for `dangerouslySetInnerHTML` to fix a rendering bug. The escaping
 * assertions below are what make it a property of the build rather than of a comment.
 *
 * The content this renders is written by a model with shell access. It is untrusted
 * input in the ordinary sense.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { Agent, Event, FileNode } from '@conductor/shared';
import { hrefFor } from '../lib/nav.js';
import { BUDGET_RAISES, budgetOf, parseBudget } from '../shell/autonomy.js';
import { fileLinks, filesIn, linkablePath } from './links.js';
import {
  MAX_FOLD_AGENTS,
  MAX_FOLDS,
  foldAll,
  foldLine,
  isFolded,
  parseFolds,
  setFold,
  unfoldAll,
  type Folds,
} from './folds.js';
import { lineCount, renderMarkdown, tableCells } from './markdown.js';
import { FOLLOW_PX, scrollIntent } from './scroll.js';
import { buildTranscript, replyKeys } from './transcript.js';
import { isMermaid, mermaidReason } from '../lib/mermaid.js';
import { agentTabs } from './tabs.js';
import { appendOutput, endLine, mergeRun, stripAnsi, type RunView } from '../lib/terminal.js';
import { readFileSync } from 'node:fs';
import { sleepControl } from './sleep.js';
import { ALL_ON, NONE, capabilitiesOf, controlsFor, offersMode, parseTokens, providerModelProblem, tokenWords } from '../lib/providers.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Render markdown the way the transcript does, then flatten to HTML for assertions. */
const html = (md: string): string =>
  renderToStaticMarkup(createElement('div', null, ...renderMarkdown(md)));

console.log('\n1 · agent output cannot become markup');

/*
 * First, because everything else rests on it. The agent's text is model output from a
 * process with a shell; if any of these produce a live tag, the renderer has become an
 * XSS vector and the absence of a sanitizer is a bug rather than a design.
 *
 * Note the forbidden pattern is an *opening tag*, not a bare word. `onclick` appears in
 * the correct output as escaped text the user can read — that is the renderer working,
 * so the assertion has to be able to tell a rendered attribute from a printed one.
 */
for (const [label, payload, forbidden] of [
  ['a script tag', '<script>alert(1)</script>', /<script/],
  ['an img onerror', '<img src=x onerror="alert(1)">', /<img/],
  ['an iframe', 'see <iframe src="//evil"></iframe> here', /<iframe/],
  ['an event handler', '<div onclick="steal()">click</div>', /<[a-z]+[^>]*\son[a-z]+=/],
  ['a closing tag that would break out', 'done</p><script>x()</script>', /<script/],
] as const) {
  const rendered = html(payload);
  check(
    `${label} is escaped, not emitted`,
    !forbidden.test(rendered),
    rendered.slice(0, 120),
  );
}
check(
  'and the text is still readable — escaped, not stripped',
  html('<script>alert(1)</script>').includes('&lt;script&gt;'),
  html('<script>alert(1)</script>'),
);

const jsLink = html('[click me](javascript:alert(1))');
check(
  'a javascript: link is not clickable',
  !jsLink.includes('href'),
  jsLink,
);
check('but its text survives so you can see what it was', jsLink.includes('click me'), jsLink);

const dataLink = html('[x](data:text/html;base64,PHNjcmlwdD4=)');
check('a data: url is not clickable either', !dataLink.includes('href'), dataLink);

const okLink = html('[the docs](https://example.com/a)');
check(
  'an https link is clickable, and carries rel',
  okLink.includes('href="https://example.com/a"') && okLink.includes('noopener'),
  okLink,
);

console.log('\n2 · the constructs agents actually write');

// Lifted from the audit report that prompted this work.
const REPORT = [
  '## A. Durability: the ack happens before the data is safe',
  '',
  '`PulsarListener.java:78-89` acknowledges a message immediately:',
  '',
  '```java',
  'processor.process(event);',
  'consumer.acknowledge(msg);',
  '```',
  '',
  'So for up to **1000** events, an event is:',
  '',
  '- already acknowledged to Pulsar',
  '- living only in this JVM\'s heap',
  '  - and lost on OOM',
  '',
  '> no circuit breaker',
  '',
  '---',
  '',
  'See *STATUS.md* for the team\'s own note.',
].join('\n');

const report = html(REPORT);
check('a heading becomes a heading', report.includes('<h2>'), report.slice(0, 80));
check('a fenced block becomes pre/code', report.includes('<pre class="lang-java"><code>'));
check(
  'and the code keeps its newline',
  report.includes('processor.process(event);\nconsumer.acknowledge(msg);'),
);
check('bullets become a list', report.includes('<ul>') && report.includes('<li>'));
check('a nested bullet nests', report.includes('<ul><li>and lost on OOM</li></ul>'), report);
check('a blockquote becomes one, holding its paragraph (Amendment 62)', report.includes('<blockquote><p>no circuit breaker'), report);
check('a rule becomes an hr', report.includes('<hr'));
check('inline code becomes code', report.includes('<code>PulsarListener.java:78-89</code>'));
check('bold becomes strong', report.includes('<strong>1000</strong>'));
check('italic becomes em', report.includes('<em>STATUS.md</em>'));

const ordered = html('1. first\n2. second');
check('a numbered list is an ol', ordered.includes('<ol>') && ordered.includes('second'), ordered);

check(
  'underscores in identifiers are left alone',
  html('the audit_event_id field').includes('audit_event_id'),
  html('the audit_event_id field'),
);
check(
  'backticks win over asterisks inside them',
  html('`a ** b`').includes('<code>a ** b</code>'),
  html('`a ** b`'),
);

console.log('\n3 · nothing is ever silently dropped');

/*
 * The renderer is deliberately partial. What matters is that the unsupported case
 * degrades to text: a swallowed construct in an audit report is a deleted finding.
 */
for (const [label, md, mustContain] of [
  ['a table', '| a | b |\n|---|---|\n| 1 | 2 |', '1'],
  ['a footnote', 'text[^1]\n\n[^1]: the note', 'the note'],
  ['an unterminated fence', '```java\nnever closed', 'never closed'],
  ['a lone backtick', 'use ` to quote', 'to quote'],
  ['html-ish angle text', 'a < b and c > d', 'and c'],
  ['an empty document', '', ''],
] as const) {
  const rendered = html(md);
  check(`${label} still reaches the screen`, rendered.includes(mustContain), rendered.slice(0, 100));
}
check(
  'an unterminated fence keeps its fence marker as text, rather than eating the rest',
  html('```java\nnever closed').includes('java'),
  html('```java\nnever closed'),
);

console.log('\n4 · folding (Amendment 33)');

// Every reply folds; none starts folded. The store is what you folded, nothing else.
check('nothing is folded until you fold it', !isFolded({}, 'agt_a', 'a1'));
const one = setFold({}, 'agt_a', 'a1', true);
check('a fold is kept for that reply', isFolded(one, 'agt_a', 'a1'));
check('and only for that agent', !isFolded(one, 'agt_b', 'a1'));
check('unfolding it forgets it', !isFolded(setFold(one, 'agt_a', 'a1', false), 'agt_a', 'a1'));
check('and an agent with no folds takes no room', !('agt_a' in setFold(one, 'agt_a', 'a1', false)));
check('folding twice is one fold', setFold(one, 'agt_a', 'a1', true).agt_a?.length === 1);

const all = foldAll(one, 'agt_a', ['a1', 'a5', 'a9']);
check('fold all folds every reply there is', ['a1', 'a5', 'a9'].every((k) => isFolded(all, 'agt_a', k)));
check("a reply that arrives after fold all arrives open — you haven't read it", !isFolded(all, 'agt_a', 'a12'));
check('unfold all clears that agent', (unfoldAll(all, 'agt_a').agt_a ?? []).length === 0);
check('and leaves other agents alone', isFolded(unfoldAll(setFold(all, 'agt_b', 'a2', true), 'agt_a'), 'agt_b', 'a2'));

const round = parseFolds(JSON.stringify(all));
check('folds survive a reload', ['a1', 'a5', 'a9'].every((k) => isFolded(round, 'agt_a', k)));
check(
  'anything malformed in storage is no folds, not a crash',
  [null, '', '{', '[]', '"x"', '{"agt_a":"a1"}', '{"agt_a":[1,null]}'].every(
    (r) => Object.keys(parseFolds(r)).length === 0,
  ),
);
let many: Folds = {};
for (let i = 0; i < MAX_FOLD_AGENTS + 5; i++) many = setFold(many, `agt_${i}`, 'a1', true);
check('agents are bounded', Object.keys(many).length === MAX_FOLD_AGENTS, `${Object.keys(many).length}`);
check('the agent looked at least recently goes first', !('agt_0' in many) && `agt_${MAX_FOLD_AGENTS + 4}` in many);
check(
  'folds per agent are bounded, oldest first',
  (foldAll({}, 'agt_a', Array.from({ length: MAX_FOLDS + 3 }, (_, i) => `a${i}`)).agt_a ?? [])[0] === 'a3',
);

check('a folded reply reads its first line', foldLine('\n\nFirst finding.\nMore.') === 'First finding.');
check('without the markdown that only means something rendered', foldLine('## **Not** safe `yet`') === 'Not safe yet');
check('a list item or a link reads as its words', foldLine('- [x] see [the plan](PLAN.md)') === 'see the plan');
check('a rule is not a line', foldLine('---\nAfter.') === 'After.');

const said = (seq: number, kind: 'user_text' | 'text', text: string): Event =>
  ({ seq, ts: '2026-09-26T00:00:00Z', projectId: 'p', jobId: 'j', agentId: 'a', payload: { kind, text } }) as Event;
const convo = buildTranscript([
  said(1, 'user_text', 'go'),
  said(2, 'text', 'one'),
  said(3, 'text', 'two'),
  said(4, 'user_text', 'more'),
  said(5, 'text', 'three'),
]);
check('fold all folds replies, not your turns', replyKeys(convo).join(' ') === 'a2 a5', replyKeys(convo).join(' '));
check('line counting is 1-based on a single line', lineCount('abc') === 1);
check('and counts the lines, not the breaks', lineCount('a\nb\nc') === 3);

console.log('\n5 · the budget field');

/*
 * The field is where a lifetime cap is raised once an agent is running. What it sends
 * matters more than how it looks: the daemon stores anything not above zero as NO cap,
 * so a "0" sent through would uncap the agent it was meant to stop.
 */
const cap = (text: string) => {
  const r = parseBudget(text);
  return 'cap' in r ? r.cap : `why: ${r.why}`;
};
check('an amount is a cap', cap('35') === 35, String(cap('35')));
check('with a dollar sign, as people type it', cap(' $35.5 ') === 35.5, String(cap(' $35.5 ')));
check('to the cent', cap('12.3456') === 12.35, String(cap('12.3456')));
check('empty is no cap', cap('') === null && cap('  $ ') === null, `${cap('')} ${cap('  $ ')}`);
check('zero is refused, not sent as "uncapped"', String(cap('0')).startsWith('why:'), String(cap('0')));
check('so is a negative', String(cap('-5')).startsWith('why:'), String(cap('-5')));
check('and a word', String(cap('lots')).startsWith('why:'), String(cap('lots')));
check('the one-click raises are +$10 and +$25', BUDGET_RAISES.join() === '10,25', BUDGET_RAISES.join());

const agentAt = (costUsd: number, budgetUsd: number | null): Agent => ({
  id: 'a',
  jobId: 'j',
  projectId: 'p',
  role: 'builder',
  model: 'opus',
  sdkSessionId: null,
  status: 'paused',
  blockMode: null,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  dependsOn: [],
  autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd },
  startedAt: null,
  endedAt: null,
});
check('at the cap is over it — the daemon refuses at ≥', budgetOf(agentAt(25, 25))?.over === true);
check('below it is not', budgetOf(agentAt(24.99, 25))?.over === false);
check(
  "an uncapped agent has no bar — no job figure ever pauses it, so none is measured",
  budgetOf(agentAt(6, null)) === null,
);

console.log('\n6 · file names link to Files, and only inside the worktree');

/*
 * The daemon refuses an absolute path, or one resolving outside the worktree
 * (`workspace/paths.ts`). A link it would refuse is a dead link, and a resolver more
 * lenient than the daemon is one that's wrong about the boundary, so these mirror its
 * escapes.
 */
const WT = '/wt/job';
for (const [label, raw, want] of [
  ['an absolute path inside the worktree becomes relative', '/wt/job/src/a.ts', 'src/a.ts'],
  ['an absolute path outside it is not a link', '/etc/passwd', null],
  ['a sibling that shares the prefix is outside', '/wt/job-evil/x.ts', null],
  ['the worktree itself is not a file', '/wt/job', null],
  ['../ climbing out is not a link', '../other-repo/README.md', null],
  ['.. that stays inside resolves', 'src/../docs/PLAN.md', 'docs/PLAN.md'],
  ['absolute, then climbing out through ..', '/wt/job/../job-evil/x.ts', null],
  ['a line number is dropped', 'src/a.ts:42', 'src/a.ts'],
  ['and a line:col', 'src/a.ts:42:7', 'src/a.ts'],
  ['and a range', 'PulsarListener.java:78-89', 'PulsarListener.java'],
  ['a relative path is the worktree’s, since agents run there', './src/a.ts', 'src/a.ts'],
  ['a home path is the daemon’s, not the worktree’s', '~/.claude/projects/x/memory/a.md', null],
  ['a Windows path is not one', 'C:\\repo\\a.ts', null],
  ['a URL is not a path', 'https://example.com/a.ts', null],
] as const) {
  const got = linkablePath(raw, WT);
  check(label, got === want, `${raw} → ${String(got)}`);
}
check('a trailing slash on the worktree changes nothing', linkablePath('/wt/job/a.ts', '/wt/job/') === 'a.ts');
check('no worktree path means nothing absolute is inside it', linkablePath('/a.ts', '') === null);

check(
  'the href is the one navigate() would go to',
  hrefFor('files', { jobId: 'j', path: 'src/a.ts' }) === '#files?jobId=j&path=src%2Fa.ts',
  hrefFor('files', { jobId: 'j', path: 'src/a.ts' }),
);

const TREE: FileNode = {
  path: '',
  name: 'job',
  type: 'dir',
  children: [
    { path: 'src', name: 'src', type: 'dir', children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }] },
    { path: 'docs', name: 'docs', type: 'dir', children: [{ path: 'docs/a&b".md', name: 'a&b".md', type: 'file' }] },
  ],
};
const inTree = filesIn(TREE);
check('the tree lists files, not directories', inTree.has('src/a.ts') && !inTree.has('src'), [...inTree].join());
const links = fileLinks({ id: 'j', worktreePath: WT }, inTree);
check('a touched path links without the tree', fileLinks({ id: 'j', worktreePath: WT }, null).touched('/wt/job/new.ts') !== null);
check('a named one waits for the tree', fileLinks({ id: 'j', worktreePath: WT }, null).named('src/a.ts') === null);

/*
 * These are next to section 1 in spirit: the href is built from model output, which is
 * exactly what the escaping checks exist for.
 */
const linked = (md: string): string =>
  renderToStaticMarkup(createElement('div', null, ...renderMarkdown(md, links.named)));

const named = linked('see `src/a.ts:12` for the fix');
check(
  'a code span naming a file in the tree renders a link to it',
  named.includes('<a href="#files?jobId=j&amp;path=src%2Fa.ts" class="ag-file"><code>src/a.ts:12</code></a>'),
  named,
);
const notInTree = linked('the `${name}.png.part` file, and `…-stage-gates.md`');
check('one that only looks like a file stays code', !notInTree.includes('<a') && notInTree.includes('<code>'), notInTree);
check(
  'an absolute path inside the worktree links too',
  linked('`/wt/job/src/a.ts`').includes('path=src%2Fa.ts'),
  linked('`/wt/job/src/a.ts`'),
);
const relLink = linked('[the fix](src/a.ts)');
check(
  'a relative markdown link to a file in the tree links, in the same tab',
  relLink.includes('href="#files?jobId=j&amp;path=src%2Fa.ts"') && !relLink.includes('_blank'),
  relLink,
);
check(
  'one to a file not in the tree stays as written',
  linked('[x](src/b.ts)').includes('[x](src/b.ts)') && !linked('[x](src/b.ts)').includes('<a'),
  linked('[x](src/b.ts)'),
);
const odd = linked('`docs/a&b".md`');
check(
  'a name with & and " is encoded into the href, not breaking out of it',
  odd.includes('path=docs%2Fa%26b%22.md"'),
  odd,
);
const hostile = renderToStaticMarkup(
  createElement('div', null, ...renderMarkdown('`x`', () => 'javascript:alert(1)')),
);
check(
  'whatever the callback returns, only an in-app # href gets through',
  !hostile.includes('href') && hostile.includes('<code>x</code>'),
  hostile,
);
check('without a callback nothing links, as before', !html('`src/a.ts`').includes('<a'));

/*
 * A tool's input path is absolute; a file_edit's is worktree-relative. Matched as
 * strings they never meet, and an edit row silently loses its +N −M — which it did,
 * on every real run, until F16 put the resolver in between.
 */
const ev = (seq: number, payload: Event['payload']): Event => ({
  seq,
  ts: '2026-09-26T00:00:00Z',
  projectId: 'p',
  jobId: 'j',
  agentId: 'a',
  payload,
});
const editRun = [
  ev(1, { kind: 'tool_start', toolUseId: 'u1', tool: 'Edit', label: 'Edit src/a.ts', input: { file_path: '/wt/job/src/a.ts', old_string: 'x', new_string: 'y\nz' } }),
  ev(2, { kind: 'file_edit', path: 'src/a.ts', added: 2, removed: 1, source: 'tool' }),
];
const editBlock = buildTranscript(editRun, WT)[0]?.blocks[0];
check(
  "an edit row gets its +N −M from a file_edit, though one path is absolute and the other isn't",
  editBlock?.kind === 'tool' && editBlock.added === 2 && editBlock.removed === 1,
  JSON.stringify(editBlock),
);

// F20: a failure the SDK explained. A bare code sent you here to find out why.
const failNote = (payload: Event['payload']) => {
  const b = buildTranscript([ev(1, payload)])[0]?.blocks[0];
  return b?.kind === 'note' ? b.text : JSON.stringify(b);
};
const GONE = 'No conversation found with session ID: s1';
check(
  "a failure the SDK explained says it, in place of a bare 'error'",
  failNote({ kind: 'status', status: 'failed', error: 'error', detail: GONE }) === `failed — ${GONE}`,
  failNote({ kind: 'status', status: 'failed', error: 'error', detail: GONE }),
);
check(
  'and after the code, when there is one',
  failNote({ kind: 'status', status: 'failed', error: 'launch_failed', detail: 'spawn claude ENOENT' }) ===
    'failed — launch_failed: spawn claude ENOENT',
);
check('one it did not explain reads as before', failNote({ kind: 'status', status: 'failed', error: 'max_turns' }) === 'failed — max_turns');

console.log('\n7 · arriving at an agent lands on its latest reply');

const at = (landedOn: string | null, agentId: string | null, eventCount: number, fromBottom: number) =>
  scrollIntent({ landedOn, agentId, eventCount, fromBottom });
check('opening an agent jumps to the bottom', at(null, 'a', 40, 9_000) === 'jump');
check('switching to another agent jumps too', at('a', 'b', 40, 0) === 'jump');
check('an agent whose history is still loading waits', at(null, 'a', 0, 0) === 'stay');
check('and jumps once it lands', at(null, 'a', 120, 9_000) === 'jump');
check(`a new event while within ${FOLLOW_PX}px is followed`, at('a', 'a', 41, FOLLOW_PX - 1) === 'follow');
check('one further up is not — history is not yanked away', at('a', 'a', 41, FOLLOW_PX) === 'stay');
check('no agent, nothing to do', at(null, null, 0, 0) === 'stay');

console.log('\n8 · pause puts an agent to sleep, resume wakes it (Amendment 35)');

check('a working agent can be put to sleep', sleepControl('working')?.action === 'pause');
check('a queued one too', sleepControl('queued')?.action === 'pause');
check('a paused one is woken, not paused again', sleepControl('paused')?.action === 'resume');
check('and waking says it may wait for a slot', /slot/.test(sleepControl('paused')?.title ?? ''));
check(
  'a blocked agent keeps its question — the button says so',
  /keeps your question/.test(sleepControl('blocked')?.title ?? ''),
  sleepControl('blocked')?.title,
);
check('an agent that has ended has nothing to pause', ['done', 'failed', 'stopped'].every((s) => sleepControl(s as Agent['status']) === null));

console.log('\nTabs · one per agent in the project (Amendment 49)');
{
  const A = (id: string, jobId: string, role: string, status: Agent['status'] = 'done', projectId = 'p') => ({ id, jobId, role, status, projectId });
  const agents = [
    A('a1', 'old', 'builder'),
    A('a2', 'old', 'reviewer'),
    A('b1', 'new', 'builder', 'working'),
    A('b2', 'new', 'validator', 'queued'),
    A('x1', 'other', 'builder', 'working', 'q'),
  ];
  const tabs = agentTabs(agents, 'p', ['new', 'old'], [{ agentId: 'a2' }], [{ agentIds: ['b2'] }, { agentIds: [] }]);
  check("only this project's agents", tabs.length === 4 && !tabs.some((t) => t.id === 'x1'), tabs.map((t) => t.id).join());
  check('newest job first, each job in its own order', tabs.map((t) => t.id).join() === 'b1,b2,a1,a2', tabs.map((t) => t.id).join());
  check('a role that appears twice is numbered, in order', tabs.find((t) => t.id === 'b1')?.label === 'builder 1' && tabs.find((t) => t.id === 'a1')?.label === 'builder 2' && tabs.find((t) => t.id === 'a2')?.label === 'reviewer');
  check('a request waiting on an agent marks its tab', tabs.find((t) => t.id === 'a2')?.needs === 1 && tabs.find((t) => t.id === 'a2')?.status === 'blocked');
  check('so does an alert about it', tabs.find((t) => t.id === 'b2')?.needs === 1 && tabs.find((t) => t.id === 'b2')?.status === 'blocked');
  check('the rest keep their own status', tabs.find((t) => t.id === 'b1')?.status === 'working' && tabs.find((t) => t.id === 'a1')?.needs === 0);
  check('the first agent of a later job starts a new group', tabs.map((t) => t.newJob).join() === 'false,false,true,false');
  const src = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the Agent screen shows them only with more than one', /tabs\.length > 1 &&/.test(src) && /openAgent\(target\)/.test(src));
  check(
    "a finished agent's own tab says so, filled (Amendment 94); working already pulses via the Dot",
    /t\.status === 'done' && <span className="ag-tab-tag">finished<\/span>/.test(src),
  );
}

console.log('\nTerminal · a command runner in the agent\'s folder (Amendment 58)');
{
  const run = { id: 'r1', agentId: 'a', command: 'ls', cwd: '/w', startedAt: 'x', endedAt: null, exitCode: null, signal: null };
  let list: RunView[] = mergeRun([], run);
  list = appendOutput(list, 'r1', { stream: 'out', text: 'a\n' });
  list = appendOutput(list, 'r1', { stream: 'out', text: 'b\n' });
  list = appendOutput(list, 'r1', { stream: 'err', text: 'oops\n' });
  check('output from one stream joins up; the other stays apart', list[0]!.output.length === 2 && list[0]!.output[0]!.text === 'a\nb\n' && list[0]!.output[1]!.stream === 'err');
  list = mergeRun(list, { ...run, endedAt: 'y', exitCode: 0 });
  check('its end keeps the output it already had', list.length === 1 && list[0]!.output.length === 2 && list[0]!.exitCode === 0);
  check('ANSI colours and moves are stripped, the text kept', stripAnsi('\x1b[31mred\x1b[0m and \x1b[2Kline') === 'red and line');
  check('the last line says how it ended', endLine({ endedAt: null, exitCode: null, signal: null }) === 'running…' && endLine({ endedAt: 'y', exitCode: 3, signal: null }) === 'exit 3' && endLine({ endedAt: 'y', exitCode: null, signal: 'SIGINT' }) === 'stopped (SIGINT)' && /cut at 256 KB/.test(endLine({ endedAt: 'y', exitCode: 0, signal: null, cut: true })));
  const term = readFileSync(new URL('./Terminal.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  check(
    'the input always has room: the prompt is the folder name, and the input never shrinks to nothing (Amendment 61)',
    /cwd\.split\('\/'\)\.filter\(Boolean\)\.pop\(\)/.test(term) && /\.ag-term-in input \{\n  flex: 1 1 12em;\n  min-width: 8em;/.test(css),
  );
  check('and a click in the output goes back to it', /input\.current\?\.focus\(\)/.test(term));
  const src = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the Agent screen offers it beside reply', /bottomTab === 'terminal' \? <TerminalPanel agent=\{agent\} \/>/.test(src));
}

console.log('\nMermaid · a diagram in a reply is drawn, its source kept (Amendment 60)');
{
  const md = renderToStaticMarkup(createElement('div', null, renderMarkdown('Here:\n```mermaid\ngraph TD; A-->B<img src=x onerror=alert(1)>\n```\nand code:\n```ts\nconst a = 1;\n```')));
  check('until it is drawn, a mermaid block shows its source as code', md.includes('<pre class="lang-mermaid"><code>graph TD; A--&gt;B&lt;img src=x onerror=alert(1)&gt;</code></pre>'), md);
  check('in its own block, which is what the browser draws into', md.includes('class="md-mermaid-block"') && md.includes('class="md-diagram" hidden=""'), md);
  check('other code blocks are untouched', md.includes('<pre class="lang-ts"><code>const a = 1;</code></pre>'));
  check('the source cannot become markup', !md.includes('<img'));
  const src = readFileSync(new URL('./markdown.tsx', import.meta.url), 'utf8');
  check('markdown.tsx still never inserts HTML', !/dangerouslySetInnerHTML|innerHTML/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  const lib = readFileSync(new URL('../lib/mermaid.ts', import.meta.url), 'utf8');
  check("diagrams are drawn strict, and mermaid is loaded only when one is", /securityLevel: 'strict'/.test(lib) && /import\('mermaid'\)/.test(lib) && !/^import .*from 'mermaid'/m.test(lib));
  check('with labels as SVG text, and the SVG scrubbed before it goes in', /htmlLabels: false/.test(lib) && /return scrubSvg\(svg\)/.test(lib));
}

check('a mermaid fence is known by its name, whatever the case', isMermaid('mermaid') && isMermaid('Mermaid') && isMermaid(' mermaid theme=dark') && !isMermaid('ts') && !isMermaid(''));
check("an error says mermaid's first line", mermaidReason(new Error('\nParse error on line 2:\nA-->\n---^')) === 'Parse error on line 2:');

console.log('\nFormatting · what models write, rendered as they meant it (Amendment 62)');
{
  const md = (t: string) => renderToStaticMarkup(createElement('div', null, renderMarkdown(t)));
  const table = md('| Option | Cost | Note |\n|:---|---:|:-:|\n| A | $1 | `x` and **y** |\n| B | $2 | a \\| b |');
  check('a table is a table, with its header', table.includes('<table><thead><tr><th style="text-align:left">Option</th>'), table);
  check('aligned as its separator says', table.includes('<td style="text-align:right">$1</td>') && table.includes('<td style="text-align:center">'), table);
  check('cells can hold formatting, and an escaped pipe', table.includes('<code>x</code> and <strong>y</strong>') && table.includes('>a | b</td>'), table);
  check('a table with a missing cell keeps its shape', md('| a | b |\n|---|---|\n| 1 |').includes('<td>1</td><td></td>'));
  check('a pipe in prose is not a table', !md('a | b\nnot a separator').includes('<table'));
  check('nor is a pipe line over a rule: the columns must match', !md('a | b | c\n---').includes('<table') && md('a | b | c\n---').includes('<hr/>'));
  check('cells split right', tableCells('| a | b \\| c |').join('/') === 'a/b | c');

  const nested = md('1. First\n   - one\n     - deeper\n2. Second\n\n   more of second\n3. Third');
  check('a numbered list keeps its numbering across nested bullets', (nested.match(/<ol>/g) ?? []).length === 1 && nested.includes('<li>Second<p>more of second</p></li>'), nested);
  check('nesting goes as deep as it is written', nested.includes('<ul><li>one<ul><li>deeper</li></ul></li></ul>'), nested);
  check('two-space nesting under a number works too', md('1. a\n  - b\n2. c').includes('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'));
  check('a list that starts at 3 says 3', md('3. three\n4. four').includes('<ol start="3">'));
  check('a blank line between items is still one list', (md('- a\n\n- b\n\n- c').match(/<ul>/g) ?? []).length === 1);
  check('bullets after numbers are a new list', md('1. a\n- b').includes('</ol><ul>'));
  check('a line that carries on an item stays in it', md('- first line\n  carries on\n- next').includes('<li>first line\ncarries on</li>'));
  check('an item can hold a code block', md('- run:\n  ```sh\n  make test\n  ```\n- done').includes('<li>run:<pre class="lang-sh"><code>make test</code></pre></li>'));

  const tasks = md('- [ ] todo\n- [x] done');
  check('task boxes are boxes, ticked or not', tasks.includes('<li class="md-task"><input type="checkbox" disabled="" readOnly="" aria-label="not done"/>todo</li>') && /md-task is-done.*checked=""/.test(tasks), tasks);
  check('bold italic is both', md('***both***').includes('<strong><em>both</em></strong>'));
  check('bold can hold code', md('**see `x.ts`**').includes('<strong>see <code>x.ts</code></strong>'));
  check('a quote can hold a list', md('> note:\n> - one\n> - two').includes('<blockquote><p>note:</p><ul><li>one</li><li>two</li></ul></blockquote>'));
  check('a fence with an info string, or tildes, is still code', md('```ts title="x"\nconst a = 1;\n```').includes('<pre class="lang-ts"><code>const a = 1;</code></pre>') && md('~~~\nplain\n~~~').includes('<pre><code>plain</code></pre>'));
  check('a heading loses its closing hashes', md('## Title ##').includes('<h2>Title</h2>'));
  check('underscores in names are still not italics', md('audit_event_id and _x_').includes('audit_event_id and _x_'));
  check('a model cannot write HTML into the page this way either', !md('| <img src=x onerror=1> |\n|---|\n| <script>x</script> |').includes('<img') && !md('- [x] <b>x</b>').includes('<b>'));
}

console.log('\nEngines · a non-Claude agent shows only the controls its engine has (Amendment 80)');
{
  const tokenAgent = (used: number, cap: number | null): Agent => ({
    ...agentAt(0, null),
    provider: 'openrouter',
    inputTokens: used - 1_000,
    outputTokens: 1_000,
    autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, ...(cap !== null ? { budgetTokens: cap } : {}) },
  });
  const b = budgetOf(tokenAgent(184_000, 500_000));
  check('a token cap is a bar, in tokens, against input plus output', b?.unit === 'tokens' && b.spent === 184_000 && b.cap === 500_000 && Math.abs(b.fraction - 0.368) < 1e-9, JSON.stringify(b));
  check('at the cap is over it, as the daemon counts', budgetOf(tokenAgent(500_000, 500_000))?.over === true && budgetOf(tokenAgent(499_999, 500_000))?.over === false);
  check('no token cap is no bar', budgetOf(tokenAgent(9_000, null)) === null);
  check("a Claude agent's dollar bar is what it was, and says dollars", JSON.stringify(budgetOf(agentAt(5, 25))) === JSON.stringify({ spent: 5, cap: 25, fraction: 0.2, over: false, unit: 'usd' }));

  const copilot = { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true };
  check('Claude has every control', JSON.stringify(controlsFor(capabilitiesOf(agentAt(0, 25), null))) === JSON.stringify({ effort: true, helpers: true, budget: 'usd' }));
  check('an engine without dollars budgets in tokens; one without effort has none', JSON.stringify(controlsFor(copilot)) === JSON.stringify({ effort: true, helpers: true, budget: 'tokens' }) && JSON.stringify(controlsFor(NONE)) === JSON.stringify({ effort: false, helpers: false, budget: 'tokens' }));
  check('plan mode is offered only where it exists — unless the agent is already in it', offersMode('plan', ALL_ON) && !offersMode('plan', copilot) && offersMode('plan', copilot, 'plan') && offersMode('default', NONE));

  const tok = (t: string) => {
    const r = parseTokens(t);
    return 'cap' in r ? r.cap : 'why';
  };
  check('a token budget is typed as people say it', tok('500k') === 500_000 && tok('1.5M') === 1_500_000 && tok('2,000,000') === 2_000_000 && tok(' 750 ') === 750 && tok('') === null);
  check('zero, negatives and words are refused, not sent', tok('0') === 'why' && tok('-5') === 'why' && tok('lots') === 'why' && tok('5$') === 'why');
  check('and said back the way the daemon says it, rounded down', tokenWords(184_000) === '184k' && tokenWords(512_999) === '512k' && tokenWords(1_250_000) === '1.2M' && tokenWords(950) === '950');
  const list = { provider: 'openrouter', models: [{ id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' }], fetchedAt: '' };
  check("a model its engine doesn't list is flagged; an empty list proves nothing", providerModelProblem(list, 'x/y') !== null && providerModelProblem(list, 'anthropic/claude-sonnet-4.5') === null && providerModelProblem({ ...list, models: [] }, 'x/y') === null);

  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  check('the composer asks the engine before it shows a control', /const caps = capabilitiesOf\(agent, useProviders\(\)\);/.test(comp) && /MODES\.filter\(\(m\) => offersMode\(m\.id, caps, autonomy\.mode\)\)/.test(comp) && /\{has\.effort && \(\s*<div className="ag-modes">\s*<span className="ui-lab">effort/.test(comp));
  check('its budget is tokens where the engine has no dollars, and the patch is { budgetTokens }', /has\.budget === 'tokens' \?/.test(comp) && /setAutonomy\(agent\.id, \{ autonomy: \{ budgetTokens: cap \} \}\)/.test(comp) && /setAutonomy\(agent\.id, \{ autonomy: \{ budgetUsd: cap \} \}\)/.test(comp));
  check("its model comes from the engine's list, and Claude keeps the catalog picker", /\{claude \? \(\s*<ModelSelect\s*catalog=\{models\.catalog\}/.test(comp) && /useProviderModels\(claude \? null : providerOf\(agent\)\)/.test(comp) && /providerModelProblem\(theirs\.list, model\)/.test(comp));
  const insp = readFileSync(new URL('./inspector.tsx', import.meta.url), 'utf8');
  check('the details panel shows no dollars an engine never reported, and a token bar in tokens', /dollars \? \(\s*<span>\{fmtMoney\(agent\.costUsd\)\}<\/span>\s*\) : \(/.test(insp) && /not reported/.test(insp) && /budget\.unit === 'tokens'/.test(insp));
  const ui = readFileSync(new URL('../shell/ui.tsx', import.meta.url), 'utf8');
  const head = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');
  check('the engine badge is nothing for Claude, and sits by the model and on the card', /if \(!provider \|\| provider === CLAUDE\) return null;/.test(ui) && /<ProviderBadge provider=\{agent\.provider\} \/>/.test(head) && /<ProviderBadge provider=\{agent\.provider\} \/>/.test(card));
}

console.log(
  failures === 0
    ? '\nTrack B agent: PASS — agent markdown renders as a document and cannot become markup; the budget field sends what it shows; file links stay inside the worktree; an agent opens at its latest reply; pause and resume say what sleeping keeps; a non-Claude agent shows only the controls its engine has, with its budget in tokens.\n'
    : `\nTrack B agent: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
