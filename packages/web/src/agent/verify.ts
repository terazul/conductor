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
import { localDayOf, type Agent, type Event, type FileNode } from '@conductor/shared';
import { hrefFor } from '../lib/nav.js';
import { BUDGET_RAISES, budgetOf, parseBudget } from '../shell/autonomy.js';
import { fileLinks, filesIn, linkablePath } from './links.js';
import {
  MAX_FOLD_AGENTS,
  MAX_FOLDS,
  foldAll,
  foldEvery,
  foldLine,
  isFolded,
  parseFolds,
  setFold,
  shownFolded,
  toggleFold,
  unfoldAll,
  unfoldEvery,
  updateFoldState,
  type FoldState,
  type Folds,
} from './folds.js';
import { lineCount, renderMarkdown, tableCells } from './markdown.js';
import { FOLLOW_PX, scrollIntent } from './scroll.js';
import { Transcript, buildTranscript, helpersRemovedNote, replyKeys, startFoldedKeys } from './transcript.js';
import { isMermaid, mermaidReason } from '../lib/mermaid.js';
import { agentTabs } from './tabs.js';
import { appendOutput, endLine, mergeRun, stripAnsi, type RunView } from '../lib/terminal.js';
import { readFileSync } from 'node:fs';
import { SETTINGS_KEY, WORKING_SAYS, appliesSays, dollarsLine, overSays, settingsShown, settingsSummary, settingsToggled, tokensLine } from './settingsfold.js';
import { sleepControl } from './sleep.js';
import {
  TERM_TOKENS,
  binaryFrame,
  endedLine,
  fallbackBanner,
  inputFrame,
  mix,
  nextSelected,
  reconnectDelay,
  resizeFrame,
  socketEnd,
  tabLabel,
  tabTitle,
  termSocketUrl,
  wantsCopy,
  xtermTheme,
  type Tokens,
} from './term.js';
import { reconnectBar } from './reconnecting.js';
import { dockKey, findHint, isMac, termKey } from '../terminal/keys.js';
import { findPathLinks, termFileTarget } from '../terminal/paths.js';
import { DOCK_OPEN_KEY, TERM_FONT_SIZE, TERM_SCROLLBACK, TERM_SHELL_KEY, dockFlipped, dockShown, fontSizeOf, scrollbackOf, termNumberProblem, termNumberValue } from '../terminal/prefs.js';
import { onTerminals, receiveTerminals } from '../terminal/live.js';
import { rawAround } from '../files/links.js';
import { rerunControl, rerunDone, rerunSentence, roleList } from './rerun.js';
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
  // Amendment 129: a budget reads what was spent today, so this agent spent `costUsd` today.
  spentToday: { day: localDayOf(), usd: costUsd, tokens: 0 },
  dependsOn: [],
  autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd },
  startedAt: null,
  endedAt: null,
});
// Amendment 124: `over` is the warning (from the budget); Amendment 180: nothing past it stops the agent.
check('at the budget is over it — a warning, from ≥', budgetOf(agentAt(25, 25))?.over === true && budgetOf(agentAt(25, 25))?.state === 'over');
check('below it is not', budgetOf(agentAt(24.99, 25))?.over === false && budgetOf(agentAt(24.99, 25))?.state === 'ok');
check('and twice it, or ten times it, is still only over: there is no ceiling', budgetOf(agentAt(50, 25))?.state === 'over' && budgetOf(agentAt(250, 25))?.state === 'over');
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
  // Amendment 184: one you named reads as its name, and the others of its role are numbered without it.
  const named = agentTabs(
    [{ ...A('n1', 'j', 'builder'), name: 'parser fix' }, A('n2', 'j', 'builder'), A('n3', 'j', 'builder')],
    'p', ['j'], [], [],
  );
  check('a named agent reads as its name (Amendment 184)', named[0]?.label === 'parser fix', named.map((t) => t.label).join());
  check('and is not counted in its role', named[1]?.label === 'builder 1' && named[2]?.label === 'builder 2', named.map((t) => t.label).join());
  const solo = agentTabs([{ ...A('s1', 'j', 'builder'), name: 'parser fix' }, A('s2', 'j', 'builder')], 'p', ['j'], [], []);
  check('so the one left of its role has no number', solo[1]?.label === 'builder', solo.map((t) => t.label).join());
  const src = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the Agent screen shows them only with more than one', /tabs\.length > 1 &&/.test(src) && /openAgent\(target\)/.test(src));
  check(
    "a finished agent's own tab says so, filled (Amendment 94), until you open it (Amendment 105); working already pulses via the Dot",
    /t\.status === 'done' && unseenAgents\.has\(t\.id\) && <span className="ag-tab-tag">finished<\/span>/.test(src) &&
      /const unseenAgents = useUnseenAgents\(\)/.test(src) &&
      /import \{ useUnseenAgents \} from '\.\.\/lib\/seen\.js'/.test(src),
  );
}

console.log('\nYour turns · what you typed reads in its own colour (Amendment 106)');
{
  const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  const tsx = readFileSync(new URL('./transcript.tsx', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../../../shared/src/tokens.css', import.meta.url), 'utf8');
  const rule = (sel: string): string => {
    const i = css.indexOf(`${sel} {`);
    return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  };
  check('--you is a token in both themes', (tokens.match(/--you: #[0-9a-f]{6};/g) ?? []).length === 2);
  check('your label is --you', /color: var\(--you\)/.test(rule('.ag-msg.is-you:not(.is-auto) .ag-who')));
  // Amendment 116: what you last asked, pinned at the top, reads in the same colour.
  check('"You asked" is --you: its edge, its tint, its label and its words',
    /border-left: 3px solid var\(--you\)/.test(rule('.ag-lastask')) &&
      /color-mix\(in srgb, var\(--you\) 10%, var\(--bg2\)\)/.test(rule('.ag-lastask')) &&
      /color: var\(--you\)/.test(rule('.ag-lastask .ui-lab')) &&
      /color: var\(--you\)/.test(rule('.ag-lastask-t')));
  const body = rule('.ag-msg.is-you:not(.is-auto) .ag-body');
  check('so are your words and their bar, on a --you tint', /color: var\(--you\)/.test(body) && /border-left-color: var\(--you\)/.test(body) && /color-mix\(in srgb, var\(--you\) 10%, transparent\)/.test(body));
  // Amendment 164: a turn Conductor sent is its own component now, so it can fold; your own turns are not marked auto.
  check('a turn Conductor sent for you is marked auto and keeps the plain look', /className=\{`ag-msg is-you is-auto\$\{folded \? ' is-folded' : ''\}`\}/.test(tsx) && /className="ag-msg is-you" id=/.test(tsx));
  check('no status colour on your turn', !/var\(--(need|live|done|fail|queue|idle)\)/.test(body + rule('.ag-msg.is-you:not(.is-auto) .ag-who')));
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
  check('the Agent screen offers it beside reply, through the panel that falls back to it (Amendment 112)', /bottomTab === 'terminal' \? <TermPanel agent=\{agent\} \/>/.test(src));
}

console.log('\nCode blocks · on white, with a copy for all of it (Amendment 185)');
{
  const md = renderToStaticMarkup(createElement('div', null, renderMarkdown('Paste this:\n```sh\ngh auth login\nmake start\n```\nand `inline` stays as it was.')));
  check('a fenced block is boxed in the light theme, so it is white in both', md.includes('<div class="ag-code" data-theme="light">'), md);
  check('with a labelled ⧉ copy before the block', /<div class="ag-code" data-theme="light"><button type="button" class="ag-code-copy" aria-label="Copy this block" title="Copy all of it">⧉ copy<\/button><pre class="lang-sh"><code>gh auth login\nmake start<\/code><\/pre><\/div>/.test(md), md);
  check('inline code gets no box and no copy', (md.match(/ag-code-copy/g) ?? []).length === 1 && md.includes('<code>inline</code>'));
  const block = readFileSync(new URL('./CodeBlock.tsx', import.meta.url), 'utf8');
  check('the copy is the whole block, through lib/clipboard', /void copyText\(body\)/.test(block) && /import \{ copyText \} from '\.\.\/lib\/clipboard\.js';/.test(block));
  check('and says copied, or why it could not', /'✓ copied'/.test(block) && /Couldn't copy: \$\{said\.why\}/.test(block));
  const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  check('its block is painted --paper, in existing tokens only', /\.ag-md \.ag-code pre \{\s*background: var\(--paper\);/.test(css));
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
  check('an item can hold a code block', md('- run:\n  ```sh\n  make test\n  ```\n- done').includes('<li>run:<div class="ag-code" data-theme="light">') && md('- run:\n  ```sh\n  make test\n  ```\n- done').includes('<pre class="lang-sh"><code>make test</code></pre></div></li>'));

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
    spentToday: { day: localDayOf(), usd: 0, tokens: used },
    autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, ...(cap !== null ? { budgetTokens: cap } : {}) },
  });
  const b = budgetOf(tokenAgent(184_000, 500_000));
  check('a token cap is a bar, in tokens, against input plus output', b?.unit === 'tokens' && b.spent === 184_000 && b.cap === 500_000 && Math.abs(b.fraction - 0.368) < 1e-9, JSON.stringify(b));
  check('at the budget is over it, as the daemon counts; twice it is still only over', budgetOf(tokenAgent(500_000, 500_000))?.over === true && budgetOf(tokenAgent(499_999, 500_000))?.over === false && budgetOf(tokenAgent(999_999, 500_000))?.state === 'over' && budgetOf(tokenAgent(1_000_000, 500_000))?.state === 'over');
  check('no token cap is no bar', budgetOf(tokenAgent(9_000, null)) === null);
  check("a Claude agent's dollar bar is what it was, and says dollars", JSON.stringify(budgetOf(agentAt(5, 25))) === JSON.stringify({ spent: 5, cap: 25, fraction: 0.2, pct: 20, state: 'ok', tone: 'ok', over: false, unit: 'usd' }));

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
  check("its model comes from the engine's visible list, and Claude keeps the catalog picker", /\{claude \? \(\s*<ModelSelect\s*catalog=\{models\.catalog\}/.test(comp) && /useProviderModels\(claude \? null : providerOf\(agent\)\)/.test(comp) && /<ProviderModelSelect/.test(comp) && /providerModelProblem\(theirs\.list, model\)/.test(comp));
  const insp = readFileSync(new URL('./inspector.tsx', import.meta.url), 'utf8');
  // Since Amendment 146 the panel's spend is today and the lifetime side by side, in tokens where
  // the engine reports no dollars (`agentPairWords(agent, dollars)`), not "not reported".
  check('the details panel shows no dollars an engine never reported, and a token bar in tokens', /agentPairWords\(agent, dollars\)/.test(insp) && /reports tokens, not dollars/.test(insp) && /budget\.unit === 'tokens'/.test(insp));
  const ui = readFileSync(new URL('../shell/ui.tsx', import.meta.url), 'utf8');
  const head = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');
  check('the engine badge is nothing for Claude, and sits by the model and on the card', /if \(!provider \|\| provider === CLAUDE\) return null;/.test(ui) && /<ProviderBadge provider=\{agent\.provider\} \/>/.test(head) && /<ProviderBadge provider=\{agent\.provider\} \/>/.test(card));
}

console.log('\n9 · the settings under the message box fold away (Amendment 96)');
{
  check('open unless hidden, so a first visit shows everything', settingsShown(null) && settingsShown('shown') && !settingsShown('hidden'));
  check('the button flips it', settingsToggled(null) === 'hidden' && settingsToggled('hidden') === 'shown' && settingsToggled('shown') === 'hidden');
  check('the folded line says what is set, in order', settingsSummary({ mode: 'ask me', effort: 'high', model: 'sonnet-5-5', budget: dollarsLine('$4.10', '$25') }) === 'ask me · high · sonnet-5-5 · $4.10 of $25 today');
  check('an engine with no effort leaves it out, not a blank', settingsSummary({ mode: 'ask me', effort: null, model: 'gpt-x', budget: tokensLine('184k', '500k') }) === 'ask me · gpt-x · 184k of 500k tokens today');
  check('no cap says what was spent, not "of nothing"', dollarsLine('$4.10', null) === '$4.10 spent today' && tokensLine('950', null) === '950 tokens used today');

  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  check('one setting for every agent, read the same way', /const open = settingsShown\(useSetting\(SETTINGS_KEY\)\);/.test(comp) && SETTINGS_KEY === 'conductor.agentSettings');
  check('folded hides the guardrails pills and shows the line instead', /\{open && \(\s*<>\s*<span className="ui-lab">guardrails<\/span>/.test(comp) && /\{!open && \(\s*<span className=\{`ag-summary\$\{summaryAlarm \? ' is-alarm' : ''\}`\}/.test(comp));
  check('folded hides interaction, effort, model and budget', /\{open && \(\s*<>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="ag-modes">\s*<span className="ui-lab">interaction/.test(comp));
  check('send stays, and the fold says whether it is open', /aria-expanded=\{open\}/.test(comp) && /\{send\.busy \? 'sending…' : 'send'\}/.test(comp));
  // Amendment 110: a header with the shared chevron, like every other fold, not a "settings" button.
  check('the fold is a header with the shared chevron, first in the row', /<div className="ag-crow">[\s\S]{0,600}?<button[^>]*?className=\{`ag-fold\$\{open \? ' is-open' : ''\}`\}[\s\S]{0,400}?<Chevron open=\{open\} \/>\s*<span className="ag-fold-lab">agent<\/span>/.test(comp));
  check('and the folded line is inside it, so the summary is what you click', /<span className="ag-fold-lab">agent<\/span>\s*\{!open && spend && <BudgetMeter spend=\{spend\} \/>\}\s*\{!open && \(\s*<span className=\{`ag-summary/.test(comp));
  check('no "settings ▸" button is left', !/settings \{open \?/.test(comp) && !/'▸'/.test(comp));
  const navSrc = readFileSync(new URL('../shell/Navigator.tsx', import.meta.url), 'utf8');
  const uiSrc = readFileSync(new URL('../shell/ui.tsx', import.meta.url), 'utf8');
  check('one Chevron, in ui.tsx, used by the navigator too', /export function Chevron\(/.test(uiSrc) && !/function Chevron\(/.test(navSrc) && /import \{ Chevron,/.test(navSrc));
  // Amendment 125: the mode is the alarm; the budget in the line keeps its own colour (data-tone), yellow then red.
  check('a passed budget or an unsafe mode stays in sight while folded', /const summaryAlarm = current\?\.danger === true;/.test(comp) && /data-tone=\{spend\?\.tone\} title=\{summary\}/.test(comp) && /\{current && \(open \|\| current\.danger\) && \(/.test(comp) && /\{modelWarning && <div/.test(comp));
}

console.log('\n10 · re-run the agents after this one (Amendment 102)');
{
  const ag = (id: string, role: string, o: Partial<Agent> = {}): Agent => ({ ...agentAt(0, null), id, role, status: 'done', sdkSessionId: `s_${id}`, ...o });
  const stack = (o: Record<string, Partial<Agent>> = {}): Agent[] => [
    ag('arch', 'architect', o['arch']),
    ag('dev', 'developer', { dependsOn: ['arch'], ...o['dev'] }),
    ag('val', 'validator', { dependsOn: ['dev'], ...o['val'] }),
  ];

  check('the last agent in a stack has nothing after it, so no button', rerunControl(stack(), 'val', true) === null);
  check('a lone agent has none either', rerunControl([ag('solo', 'builder')], 'solo', true) === null);
  check('and an agent that is not there has none', rerunControl(stack(), 'nobody', true) === null);
  check('a helper is not part of the stack', rerunControl([...stack(), ag('h', 'developer-helper-1', { parentId: 'dev' })], 'h', true) === null);

  const c = rerunControl(stack(), 'arch', true);
  check('an agent with agents after it gets one, ready to press', c !== null && c.blocked === null && c.label === '↻ re-run after this', JSON.stringify(c?.blocked));
  check('"after" is everything downstream, in order: the developer, then the validator behind it', JSON.stringify(c?.going) === '["developer","validator"]', JSON.stringify(c?.going));
  check('even when the job lists them the other way round', JSON.stringify(rerunControl([stack()[2]!, stack()[1]!, stack()[0]!], 'arch', true)?.going) === '["developer","validator"]');
  check('the middle agent re-runs only what is after it', JSON.stringify(rerunControl(stack(), 'dev', true)?.going) === '["validator"]');
  check('an agent that waits on another branch is not after this one', JSON.stringify(rerunControl([...stack(), ag('doc', 'scribe')], 'arch', true)?.going) === '["developer","validator"]');

  const says = c?.explain ?? '';
  check('before it acts it says who goes again, in their own conversations, and why', says.includes('developer and validator will go again') && says.includes('own conversation') && says.includes('architect changed what it said'), says);
  check('that the one behind starts only once the one before is done again', says.includes('validator starts once developer is done again'), says);
  check('that nothing in the folder is reset', says.includes('Nothing in the folder is reset'), says);
  check('and nothing is said about stopping when nobody is running', !/stopped first/.test(says), says);
  check('the question and the commit button name the count', c?.question === 'Re-run 2 agents after architect?' && c?.confirm === '↻ re-run 2 agents', `${c?.question} / ${c?.confirm}`);
  check('one agent is named, not counted', rerunControl(stack(), 'dev', true)?.question === 'Re-run validator after developer?');

  const live = rerunControl(stack({ dev: { status: 'working' } }), 'arch', true);
  check('a running one is said to be stopped first, because its input is out of date', (live?.explain ?? '').includes('developer is working now, so it is stopped first') && live?.blocked === null, live?.explain);
  check('two running ones are both named', (rerunControl(stack({ dev: { status: 'working' }, val: { status: 'blocked' } }), 'arch', true)?.explain ?? '').includes('developer and validator are working now, so they are stopped first'));
  check('a helper still working is stopped with it', (rerunControl([...stack({ dev: { status: 'working' } }), ag('h', 'developer-helper-1', { parentId: 'dev', status: 'working' })], 'arch', true)?.explain ?? '').includes('Helpers still working (developer-helper-1) are stopped too'));

  const fresh = rerunControl([ag('arch', 'architect'), ag('dev', 'developer', { dependsOn: ['arch'] }), ag('val', 'validator', { dependsOn: ['dev'], status: 'queued', sdkSessionId: null })], 'arch', true);
  check('one that has not started is left alone, and will read the new reply when it does', (fresh?.explain ?? '').includes("validator hasn't started, so it is left alone and will read the new reply when it does") && JSON.stringify(fresh?.going) === '["developer"]', fresh?.explain);
  const allFresh = rerunControl([ag('arch', 'architect'), ag('dev', 'developer', { dependsOn: ['arch'], status: 'queued', sdkSessionId: null })], 'arch', true);
  check('if none of them has started there is nothing to re-run, and it says so', allFresh !== null && /None of the agents after architect has started/.test(allFresh.blocked ?? ''), allFresh?.blocked ?? 'no reason');

  // In the way: still there, and says why.
  const why = (o: Record<string, Partial<Agent>>, hasReply = true) => rerunControl(stack(o), 'arch', hasReply)?.blocked ?? null;
  check('still working: the button is there but cannot be pressed, and says to wait', /architect is still working\. Re-run once it has finished/.test(why({ arch: { status: 'working' } }) ?? ''), why({ arch: { status: 'working' } }) ?? 'null');
  check('waiting for you is not finished either', /waiting for you/.test(why({ arch: { status: 'blocked' } }) ?? ''));
  check('paused says to resume it', /paused\. Resume it/.test(why({ arch: { status: 'paused' } }) ?? ''));
  check('failed says its reply may be unfinished', /failed, so its last reply may be unfinished/.test(why({ arch: { status: 'failed' } }) ?? ''));
  check('no reply yet says so', /has not written a reply/.test(why({}, false) ?? ''));
  check('an agent after it that was stopped says to remove it first, since the ones behind would wait for good', /developer was stopped.*Remove it from the stack first/.test(why({ dev: { status: 'stopped' } }) ?? ''));
  check('one just starting says to try again', /developer is only just starting/.test(why({ dev: { status: 'working', sdkSessionId: null } }) ?? ''));
  check('and when blocked the explanation IS the reason', rerunControl(stack({ arch: { status: 'working' } }), 'arch', true)?.explain === why({ arch: { status: 'working' } }));

  check('lists read as people say them', roleList([]) === '' && roleList(['a']) === 'a' && roleList(['a', 'b']) === 'a and b' && roleList(['a', 'b', 'c']) === 'a, b and c');
  const plan = rerunControl(stack({ dev: { status: 'working' } }), 'arch', true)!.plan;
  check('the sentence is a function of the plan', rerunSentence(plan) === live?.explain);
  check('what it did is said afterwards, with who was stopped', rerunDone({ from: 'architect', agents: [{ agentId: 'dev', role: 'developer', action: 'resume', stopped: true }, { agentId: 'val', role: 'validator', action: 'resume', stopped: false }] }) === 'Re-running after architect: developer and validator go again, developer stopped first.');

  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  const block = screen.slice(screen.indexOf('function RerunControl'), screen.indexOf('/** Composer height limits'));
  check('the screen asks the control, so the button is there only when agents follow', /const control = rerunControl\(siblings, agent\.id, hasReply\);/.test(block) && /if \(control === null \|\| \(hidden && !open\)\) return null;/.test(block));
  check('the first press arms and says what it will do; the second commits', /setArmed\(true\)/.test(block) && /onAsk\(explain\)/.test(block) && /cmd\s*\.run\('Re-running', \(\) => rerunAfter\(agent\.id\), rerunDone\)/.test(block));
  check('a refusal from the daemon is shown as it said it: 409s pass through useCommand', /status === 409\) return \{ tone: 'warn', text: said/.test(readFileSync(new URL('../lib/errors.ts', import.meta.url), 'utf8')));
  check('a button that cannot be pressed keeps its reason as its hover text', /title=\{control\.blocked \?\? control\.title\}/.test(block) && /disabled=\{cmd\.busy \|\| control\.blocked !== null\}/.test(block));
  check('it takes the header while armed: the other controls give way, and the banner shows the explanation', /\{ask === null && rerunAsk === null &&/.test(screen) && /\{rerunAsk === null && <StopControls/.test(screen) && /\(ask \?\? rerunAsk\) && <div className="ag-notice is-banner t-warn"/.test(screen));
  check('both themes read: the control uses the buttons and tokens every other header control uses, and no colour of its own', !/#[0-9a-fA-F]{3,8}\b|style=|rgb\(/.test(block) && /fl-btn is-ghost/.test(block) && /fl-btn is-primary/.test(block) && /ag-confirm-q/.test(block));
  const ep = readFileSync(new URL('./endpoints.ts', import.meta.url), 'utf8');
  check('the call is POST /api/agents/:id/rerun', /export function rerunAfter\(agentId: string\): Promise<RerunResponse> \{\s*return api\(agentPath\(agentId, 'rerun'\), \{ method: 'POST', body: \{\} \}\);/.test(ep));
}

console.log('\n· a scheduled message opens to its whole text (Amendment 118)');
{
  const sched = readFileSync(new URL('./scheduled.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  check('each scheduled line is a button that says whether it is open', /className="ag-sched-open"/.test(sched) && /aria-expanded=\{open\.has\(m\.id\)\}/.test(sched) && /onClick=\{\(\) => toggle\(m\.id\)\}/.test(sched));
  check('open, it shows the whole message, when it goes and when it was scheduled', /\{open\.has\(m\.id\) && \(/.test(sched) && /<div className="ag-sched-body">\{m\.text\}<\/div>/.test(sched) && /m\.createdAt/.test(sched));
  check('the whole text keeps its line breaks and scrolls when long', /\.ag-sched-body \{[^}]*white-space: pre-wrap;[^}]*overflow-y: auto;/.test(css));
  check('cancel stays its own button beside it', /className="ag-sched-x"/.test(sched));
}

console.log('\n· a full terminal on macOS and Ubuntu (Amendment 112)');
{
  const id = 'term_ab12';
  check('the socket is on the page\'s host, ws or wss by its protocol', termSocketUrl(id, { protocol: 'http:', host: 'localhost:5173' }) === 'ws://localhost:5173/ws/term/term_ab12' && termSocketUrl(id, { protocol: 'https:', host: 'c.example' }) === 'wss://c.example/ws/term/term_ab12');
  check('and carries ?token= when the build has one, encoded', termSocketUrl(id, { protocol: 'http:', host: 'h' }, 'a b&c') === 'ws://h/ws/term/term_ab12?token=a%20b%26c');
  check('keys and the size go down as the two JSON frames the daemon reads', inputFrame('ls\r') === '{"t":"in","d":"ls\\r"}' && resizeFrame(120, 33) === '{"t":"resize","cols":120,"rows":33}');
  check('a dropped socket retries at 0.5, 1, 2, 4, 8 s, then every 10', [0, 1, 2, 3, 4, 5, 9].map(reconnectDelay).join(',') === '500,1000,2000,4000,8000,10000,10000');
  check('1000 is the shell ending, 4404 a terminal that is gone, anything else a dropped line', socketEnd(1000) === 'ended' && socketEnd(4404) === 'gone' && socketEnd(1006) === 'dropped' && socketEnd(1001) === 'dropped');

  const t = (n: string, o: Partial<{ exited: boolean; exitCode: number | null }> = {}) => ({ id: n, scope: { kind: 'agent' as const, agentId: 'a' }, cwd: '/w', shell: '/bin/zsh', startedAt: '2026-10-10T10:00:00Z', exited: false, exitCode: null, ...o });
  const three = [t('a'), t('b', { exited: true, exitCode: 3 }), t('c')];
  check('tabs read "terminal 1", "terminal 2 (exited)"', tabLabel(three[0]!, 0) === 'terminal 1' && tabLabel(three[1]!, 1) === 'terminal 2 (exited)');
  check('a tab says its folder and when it started, and how it ended', tabTitle(three[0]!) === '/w · started 2026-10-10T10:00:00Z' && /exited with 3/.test(tabTitle(three[1]!)));
  check('the tab chosen stays chosen; if it is gone, the newest; with none, none', nextSelected(three, 'b') === 'b' && nextSelected(three, 'zzz') === 'c' && nextSelected(three, null) === 'c' && nextSelected([], 'a') === null);
  check('an ended shell says so, and its code when it was not 0', endedLine({ exitCode: 0 }) === 'The shell ended.' && endedLine({ exitCode: null }) === 'The shell ended.' && endedLine({ exitCode: 3 }) === 'The shell ended with exit code 3.');
  const banner = fallbackBanner('The terminal library (@lydell/node-pty) did not load on linux-x64: boom.');
  check('the banner gives the reason, then what is shown instead', banner === 'The terminal library (@lydell/node-pty) did not load on linux-x64: boom. This is the command runner instead: one command at a time, with no input.', banner);
  check('and has words even when the daemon gave none', /^It is not available on this machine\. This is the command runner/.test(fallbackBanner(undefined)));

  const key = (o: Partial<{ type: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }>) => ({ type: 'keydown', key: 'C', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...o });
  check('Ctrl-Shift-C copies on Linux; Ctrl-C alone is the shell\'s interrupt, and ⌘C is the browser\'s', wantsCopy(key({}), false) && !wantsCopy(key({ shiftKey: false, key: 'c' }), false) && !wantsCopy(key({ ctrlKey: false, metaKey: true }), true) && !wantsCopy(key({}), true) && !wantsCopy(key({ type: 'keyup' }), false));

  // ── colour, from the tokens, in both themes ──
  check('mix moves one colour toward another', mix('#000000', '#ffffff', 0.5) === '#808080' && mix('#102030', '#102030', 0.7) === '#102030' && mix('#ff0000', '#0000ff', 0) === '#ff0000');
  const css = readFileSync(new URL('../../../shared/src/tokens.css', import.meta.url), 'utf8');
  const block = (selector: string): Map<string, string> => {
    const at = css.indexOf(`${selector} {`);
    const body = at === -1 ? '' : css.slice(at, css.indexOf('}', at));
    return new Map([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
  };
  const darkTokens = block(':root');
  const lightTokens = new Map([...darkTokens, ...block(":root[data-theme='light'], [data-theme='light']")]);
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const [name, tokens] of [['dark', darkTokens], ['light', lightTokens]] as const) {
    const have = Object.fromEntries(TERM_TOKENS.map((n) => [n, tokens.get(n)])) as Record<string, string | undefined>;
    check(`${name}: every token the palette is made from is in tokens.css`, TERM_TOKENS.every((n) => have[n] !== undefined), TERM_TOKENS.filter((n) => have[n] === undefined).join(', '));
    const theme = xtermTheme(have as Tokens, name) as Record<string, string>;
    const bg = theme['background']!;
    check(`${name}: the background is the well, the text colour is --ink`, bg === tokens.get('well') && theme['foreground'] === tokens.get('ink'));
    // Black in a dark theme and white in a light one sit near the background on purpose.
    const nearBg = name === 'dark' ? 'black' : 'white';
    const colours = ['foreground', 'cursor', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite', name === 'dark' ? 'white' : 'black'];
    const low = colours.filter((c) => ratio(theme[c]!, bg) < 4.5).map((c) => `${c} ${ratio(theme[c]!, bg).toFixed(2)}`);
    check(`${name}: every colour a program prints in reads at 4.5:1 or better on the background`, low.length === 0, low.join('; '));
    check(`${name}: ${nearBg} stays near the background, the way ANSI ${nearBg} is meant to`, ratio(theme[nearBg]!, bg) < 2, ratio(theme[nearBg]!, bg).toFixed(2));
    const sixteen = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((c) => theme[c]!);
    check(`${name}: sixteen colours, each different, all #rrggbb`, new Set(sixteen).size === 16 && sixteen.every((c) => /^#[0-9a-f]{6}$/.test(c)), sixteen.join(' '));
    check(`${name}: the selection is visible against the text and the background`, ratio(theme['selectionBackground']!, bg) > 1.2 && ratio(theme['foreground']!, theme['selectionBackground']!) >= 4.5, `${ratio(theme['selectionBackground']!, bg).toFixed(2)} / ${ratio(theme['foreground']!, theme['selectionBackground']!).toFixed(2)}`);
  }

  // ── the tab, from the source ──
  const panel = readFileSync(new URL('./TermPanel.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('./Xterm.tsx', import.meta.url), 'utf8');
  const agentCss = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('when the daemon says available, the tab mounts Xterm on the terminal chosen', /<XtermView key=\{shown\.id\} termId=\{shown\.id\}/.test(panel) && /const shown = list\.terminals\.find\(\(t\) => t\.id === selected\)/.test(panel));
  check('when it says not, the tab shows the old command runner under a banner with the reason', /if \(!list\.available\) \{[\s\S]*?fallbackBanner\(list\.reason\)[\s\S]*?\{fallback\}/.test(panel) && /fallback=\{<TerminalPanel agent=\{agent\} \/>\}/.test(panel));
  check('the runner is not shown beside a working terminal', (panel.match(/<TerminalPanel /g) ?? []).length === 1);
  check('the Agent screen mounts the panel on its terminal tab, not the runner', /bottomTab === 'terminal' \? <TermPanel agent=\{agent\} \/>/.test(screen) && !/<TerminalPanel/.test(screen));
  check('tabs: one per terminal, a + to open another, a × to close one, and the first visit opens one', /list\.terminals\.map\(\(t, i\) =>/.test(panel) && /className="ag-termx-new"/.test(panel) && /className="ag-termx-x"/.test(panel) && /!autoOpened\.has\(key\)/.test(panel));
  check('a terminal closed on purpose stays closed: the first-visit open is once per scope, and not at all where one was already open', /autoOpened\.add\(key\)/.test(panel) && /if \(r\.terminals\.length > 0\) autoOpened\.add\(asked\)/.test(panel));
  check('the exited one says how, and offers a new terminal', /shown\?\.exited &&/.test(panel) && /↻ new terminal/.test(panel));
  check('Xterm draws with xterm.js and fits the panel', /import \{ Terminal, type ILink \} from '@xterm\/xterm'/.test(view) && /import \{ FitAddon \} from '@xterm\/addon-fit'/.test(view) && /new ResizeObserver/.test(view) && /import '@xterm\/xterm\/css\/xterm\.css'/.test(view));
  check('output is binary into the terminal; keys and size go down as frames', /t\.write\(new Uint8Array\(e\.data\)\)/.test(view) && /binaryType = 'arraybuffer'/.test(view) && /t\.onData\(\(d\) => send\(inputFrame\(d\)\)\)/.test(view) && /t\.onResize\(/.test(view) && /send\(resizeFrame\(t\.cols, t\.rows\)\)/.test(view));
  check('each attach starts from a clean screen, since the daemon replays the whole buffer', /s\.onopen = \(\) => \{[\s\S]*?t\.reset\(\)/.test(view));
  check('a dropped line retries; a close the daemon meant does not', /socketEnd\(e\.code\)/.test(view) && /reconnectDelay\(attempt\)/.test(view) && /if \(why !== 'dropped'\)/.test(view));
  check('leaving the tab lets go of the socket but does not end the shell: Xterm never closes one', !/closeTerminal/.test(view) && /socket\?\.close\(\)/.test(view) && /t\.dispose\(\)/.test(view));
  check('the theme follows the app: tokens read from CSS, and re-applied when it changes', /getPropertyValue\(`--\$\{n\}`\)/.test(view) && /\}, \[theme\]\)/.test(view) && /term\.current\.options\.theme = xtermTheme\(readTokens\(\), theme\)/.test(view));
  const termCss = agentCss.slice(agentCss.indexOf('the full terminal (Amendment 112)'));
  check('both themes read: the new styles use tokens only, no colour of their own', termCss.length > 200 && !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(termCss) && !/#[0-9a-fA-F]{3,8}\b|style=\{/.test(panel));
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  check('the app\'s single-key hotkeys stay out of the terminal: xterm types into a textarea, which they skip', /\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(target\.tagName\)\) return;/.test(main) && /\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(target\.tagName\)/.test(screen));
  const vite = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  check('and in development /ws/term goes through the proxy that /ws does, upgraded', /'\/ws': \{ target: DAEMON, ws: true/.test(vite));
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  check('the two packages are declared, pinned', pkg.dependencies['@xterm/xterm'] === '6.0.0' && pkg.dependencies['@xterm/addon-fit'] === '0.11.0');
}

console.log('\n11 · the re-run button knows a held agent (Amendment 120)');
{
  const ag = (id: string, role: string, o: Partial<Agent> = {}): Agent => ({ ...agentAt(0, null), id, role, status: 'done', sdkSessionId: `s_${id}`, ...o });
  const stack = (o: Record<string, Partial<Agent>> = {}): Agent[] => [
    ag('arch', 'architect', o['arch']),
    ag('dev', 'developer', { status: 'queued', sdkSessionId: null, dependsOn: ['arch'], ...o['dev'] }),
  ];
  const free = rerunControl(stack(), 'arch', true);
  check('an architect that handed off, with the developer still to start, has nothing to re-run: the developer reads the reply when it does', free !== null && /None of the agents after architect has started/.test(free.blocked ?? ''));
  const held = rerunControl(stack({ arch: { handoffHeld: true } }), 'arch', true);
  check('held for not handing off, the button is there and cannot be pressed (Amendment 120)', held !== null && held.blocked !== null);
  check(
    'and its hover text is the daemon’s sentence, so it is read where the button is and not learned from a 409',
    held?.blocked === "architect stopped without handing off, so the agents after it haven't started. Hand it off in Needs You first.",
    held?.blocked ?? 'null',
  );
  check('the banner has no plan to show: the explanation IS the reason', held?.explain === held?.blocked);
  check('and who is after it is still known, so the button is not taken away', held?.plan.steps.map((s) => s.role).join() === 'developer');
  check('the hold is read from the agent the daemon sent, only while it is done', rerunControl(stack({ arch: { handoffHeld: true, status: 'working' } }), 'arch', true)?.blocked?.includes('still working') === true);
  check('once it hands off the field is gone and the button is as it was', rerunControl(stack({ arch: { handoffHeld: undefined } }), 'arch', true)?.blocked === free?.blocked);

  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  const block = screen.slice(screen.indexOf('function RerunControl'), screen.indexOf('/** Composer height limits'));
  check('the screen has no second copy of the rule: it asks the control, whose plan comes from shared', /rerunControl\(siblings, agent\.id, hasReply\)/.test(block) && !/handoffHeld/.test(block));
  check('and the button is disabled with that reason as before', /disabled=\{cmd\.busy \|\| control\.blocked !== null\}/.test(block) && /title=\{control\.blocked \?\? control\.title\}/.test(block));
  const shared = readFileSync(new URL('../../../shared/src/rerun.ts', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../../../daemon/src/session/supervisor.ts', import.meta.url), 'utf8');
  check('the daemon uses the same rule: rerunFrom asks rerunPlan, and has no sentence of its own for a hold', /heldRefusal\(root\) \?\?/.test(shared) && !/stopped without handing off, so the agents after it/.test(daemon));
}

console.log('\n· an agent waiting to be tried again says so, with retry now and stop retrying (Amendment 123)');
{
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const agent = (status: Agent['status'] = 'queued') => ({ status });
  const status = (st: Agent['status'], ms: number, retry?: { cause: 'unreachable' | 'auth' | 'throttled' | 'server'; attempt: number; of: number; delayMs: number }): Event => ({
    seq: ms,
    ts: new Date(ms).toISOString(),
    projectId: 'p',
    jobId: 'j',
    agentId: 'a',
    payload: { kind: 'status', status: st, ...(retry ? { retry } : {}) },
  });
  const w = (attempt: number, delayMs: number, cause: 'unreachable' | 'auth' | 'throttled' | 'server' = 'unreachable') => status('queued', T0, { cause, attempt, of: 5, delayMs });

  const bar = reconnectBar(agent(), [w(3, 30_000)], T0 + 2_000);
  check('the banner reads "Reconnecting in 30 s (3 of 5)", counted down, with what is wrong', bar?.text === 'Reconnecting in 28 s (3 of 5)' && bar.why === "can't reach the model API", JSON.stringify(bar));
  check('amber from the first retry, as Needs You has the card (Amendment 140; it was from the second)', bar?.needs === true && reconnectBar(agent(), [w(1, 5_000)], T0)?.needs === true);
  check('each cause is told as it is', reconnectBar(agent(), [w(2, 15_000, 'throttled')], T0)?.why === 'the model API is busy' && reconnectBar(agent(), [w(2, 15_000, 'server')], T0)?.why === 'the model API is failing');
  check('at its time it says now, until the daemon starts it', reconnectBar(agent(), [w(5, 300_000)], T0 + 301_000)?.text === 'Reconnecting now (5 of 5)');
  check('the longest wait reads in minutes', reconnectBar(agent(), [w(5, 300_000)], T0)?.text === 'Reconnecting in 5 min (5 of 5)');
  check('not once it is working again, failed or paused', ['working', 'failed', 'paused'].every((st) => reconnectBar(agent(st as Agent['status']), [w(3, 30_000), status(st as Agent['status'], T0 + 1)], T0) === null));
  check('nor while the status says it is anything but queued, whatever the log holds', reconnectBar(agent('working'), [w(3, 30_000)], T0) === null);
  check('a queued agent with no retry is not waiting for the model', reconnectBar(agent(), [status('queued', T0)], T0) === null && reconnectBar(agent(), [], T0) === null);

  const comp = readFileSync(new URL('./Reconnect.tsx', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
  check('the screen shows it above the transcript, beside the blocked banner', /<Reconnect agent=\{agent\} events=\{events\} cmd=\{control\} \/>/.test(screen) && screen.indexOf('<Reconnect ') < screen.indexOf('className="ag-blocked"'));
  check('the clock only ticks while it is waiting', /if \(reconnectBar\(agent, events, Date\.now\(\)\) === null\) return null;\s*return <Ticking/.test(comp) && /useNow\(1000\)/.test(comp));
  check('retry now is the primary button and stop retrying the quiet one', /fl-btn is-primary[^>]*[\s\S]*retry now/.test(comp) && /fl-btn is-ghost[\s\S]*stop retrying/.test(comp));
  check('they call the two routes through useCommand, and nothing removes the banner but the daemon starting the try', /retryNowAgent\(agent\.id\)/.test(comp) && /stopRetryingAgent\(agent\.id\)/.test(comp) && /disabled=\{cmd\.busy\}/.test(comp));
  const rules = css.slice(css.indexOf('.ag-reconnect {'), css.indexOf('/* ── crumb as a button'));
  check('both themes read: its CSS is tokens only', rules.length > 200 && !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(rules) && /var\(--need\)/.test(rules) && !/#[0-9a-fA-F]{3,8}\b|style=|rgb\(/.test(comp));
}

console.log("\n· over its budget it warns, and nothing stops it (Amendments 124, 180)");
{
  const cap = (spent: number) => budgetOf(agentAt(spent, 25))!;
  check('over, the bar reads past 100% while the fill stays full', cap(27).pct === 108 && cap(27).fraction === 1 && !('ceiling' in cap(27)));
  check('nothing past it is a stop: twice and ten times the budget are over, as $27 is', cap(27).state === 'over' && cap(50).state === 'over' && cap(250).state === 'over');

  check('the folded line says over, and no "stops at"', dollarsLine('$27.00', '$25.00', true) === "over today's budget: $27.00 of $25.00" && dollarsLine('$50.00', '$25.00', true) === "over today's budget: $50.00 of $25.00");
  check('in tokens the same', tokensLine('612k', '500k', true) === "over today's budget: 612k of 500k tokens" && tokensLine('1.2M', '500k', true) === "over today's budget: 1.2M of 500k tokens");
  check('under the budget the line is what it was', dollarsLine('$4.10', '$25') === '$4.10 of $25 today' && tokensLine('184k', '500k') === '184k of 500k tokens today');
  check('the open composer says it is only a warning, and that it keeps working', overSays('$27', '$25') === "over today's budget: $27 of $25 — a warning only; it keeps working" && overSays('612k', '500k', true) === "over today's budget: 612k of 500k tokens — a warning only; it keeps working");

  // A warning does not make the tab look blocked: the agent is working. An agent the old ceiling paused still does.
  const tab = (kind: string) =>
    agentTabs([{ id: 'a', projectId: 'p', jobId: 'j', role: 'builder', status: 'working' }], 'p', ['j'], [], [{ agentIds: ['a'], kind }])[0]!;
  check("an over-budget warning counts for its tab but doesn't turn it blocked", tab('budget_over').needs === 1 && tab('budget_over').status === 'working');
  check('a stop still does', tab('budget').needs === 1 && tab('budget').status === 'blocked');

  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  const head = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the composer never asks to raise before going on: no placeholder for a budget reached', !/atCap/.test(comp) && !/reached its budget for today/.test(comp) && !/stops at/.test(comp));
  check('the sentence shows when the settings are open and the agent is over', /\{open && budgetSays && \(/.test(comp) && /spend\?\.state === 'over'/.test(comp));
  check('the header says over budget, and never budget reached or where it stops', !/budgetNow\?\.state === 'ceiling'/.test(head) && /budgetNow\?\.state === 'over'/.test(head) && />over today's budget</.test(head) && !/budget reached today/.test(head) && !/it stops at/.test(head));
}

console.log("\n· its tab shows how full its budget is, in the daily meter's colours (Amendment 125)");
{
  // Amendment 129: a tab reads what the agent spent TODAY, stamped with the day it is for.
  const withSpend = (id: string, usd: number, budgetUsd: number | null) => ({
    id,
    projectId: 'p',
    jobId: 'j',
    role: id,
    status: 'working' as const,
    spentToday: { day: localDayOf(), usd, tokens: 0 },
    autonomy: { mode: 'default' as const, allowedTools: [], disallowedTools: [], budgetUsd },
  });
  const tabs = agentTabs([withSpend('a', 5, 25), withSpend('b', 20, 25), withSpend('c', 30, 25), withSpend('d', 9, null)], 'p', ['j'], [], []);
  const by = (id: string) => tabs.find((t) => t.id === id)!;
  check('green with room', by('a').budget?.tone === 'ok' && by('a').budget?.pct === 20);
  check('yellow from 75%', by('b').budget?.tone === 'warn' && by('b').budget?.pct === 80);
  check('red when over, with the bar full and the percentage past 100', by('c').budget?.tone === 'over' && by('c').budget?.fraction === 1 && by('c').budget?.pct === 120 && by('c').budget?.state === 'over');
  check('no budget, no bar', by('d').budget === null);
  const bare = agentTabs([{ id: 'x', projectId: 'p', jobId: 'j', role: 'x', status: 'working' }], 'p', ['j'], [], []);
  check("a caller that doesn't give the spend gets no bar, not a wrong one", bare[0]?.budget === null);
  const tokenTab = agentTabs([{ ...withSpend('t', 0, null), spentToday: { day: localDayOf(), usd: 0, tokens: 490_000 }, autonomy: { mode: 'default' as const, allowedTools: [], disallowedTools: [], budgetUsd: null, budgetTokens: 500_000 } }], 'p', ['j'], [], []);
  check('a token budget colours its tab the same way', tokenTab[0]?.budget?.tone === 'over' && tokenTab[0]?.budget?.pct === 98);
}

console.log('\n· the orchestrator of an orchestrated stack wears its mark, and only a stack of two or more has one (Amendment 128)');
{
  const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'p', jobId: 'j', role: id, status: 'working' as const, ...extra });
  const marked = (agents: ReturnType<typeof node>[]) => agentTabs(agents, 'p', ['j', 'k'], [], []).filter((t) => t.orchestrator).map((t) => t.id).join();

  const stack = [node('orchestrator', { pipelineRoles: ['developer', 'reviewer'] }), node('developer', { parentId: 'orchestrator' }), node('reviewer', { parentId: 'orchestrator' })];
  check('the orchestrator\'s tab is marked, and no helper\'s', marked(stack) === 'orchestrator');
  check('it is marked as soon as it is launched, before it has started a helper: its roles make the stack two or more', marked([node('orchestrator', { pipelineRoles: ['developer'] })]) === 'orchestrator');
  check('a stack of one has no orchestrator: nothing is marked', marked([node('architect')]) === '' && marked([node('orchestrator', { pipelineRoles: [] })]) === '');
  check('an orchestrator whose helpers have no role is not one (Amendment 51), however many it starts', marked([node('builder', { helperCap: 3 }), node('builder-api', { parentId: 'builder' }), node('builder-ui', { parentId: 'builder' })]) === '');
  check('a fixed stack has none', marked([node('architect'), node('developer'), node('validator')]) === '');
  check('a helper never is, even if it somehow carries roles', marked([node('o', { pipelineRoles: ['developer'] }), node('h', { parentId: 'o', pipelineRoles: ['developer'] })]) === 'o');
  check("another job's helpers do not make a stack of this job's lone agent", marked([node('o', { pipelineRoles: undefined }), node('h', { jobId: 'k', parentId: 'o' })]) === '');
  const tab = agentTabs(stack, 'p', ['j'], [], []);
  check('the mark is on the tab and changes nothing else on it: label, status, needs and budget as they were', tab.map((t) => `${t.id}:${t.label}:${t.status}:${t.needs}`).join() === 'orchestrator:orchestrator:working:0,developer:developer:working:0,reviewer:reviewer:working:0' && tab.every((t) => t.budget === null));
  check('a blocked orchestrator keeps its mark: it is a mark of what the agent is, not of its state', agentTabs(stack, 'p', ['j'], [{ agentId: 'orchestrator' }], []).find((t) => t.id === 'orchestrator')?.orchestrator === true);
  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the screen draws it: the mark in the tab, and the edge on it', /t\.orchestrator && <OrchestratorMark short \/>/.test(screen) && /t\.orchestrator \? ' is-orch' : ''/.test(screen));
}

console.log("\n· the tab, the bar and the line read today's spend, and a new day starts them at zero (Amendment 129)");
{
  const today = localDayOf();
  const yesterday = localDayOf(new Date(Date.now() - 86_400_000));
  const lived = (stamp: string, usd: number) => ({
    id: 'x',
    projectId: 'p',
    jobId: 'j',
    role: 'builder',
    status: 'working' as const,
    costUsd: 80,
    spentToday: { day: stamp, usd, tokens: 0 },
    autonomy: { mode: 'default' as const, allowedTools: [], disallowedTools: [], budgetUsd: 25 },
  });
  check("a tab shows today's spend against the budget, not the $80 of its life", agentTabs([lived(today, 10)], 'p', ['j'], [], [])[0]?.budget?.pct === 40);
  check('with a stamp from yesterday the same agent\'s tab is empty: an open page at midnight', agentTabs([lived(yesterday, 60)], 'p', ['j'], [], [])[0]?.budget?.pct === 0 && agentTabs([lived(yesterday, 60)], 'p', ['j'], [], [])[0]?.budget?.state === 'ok');
  const full = budgetOf({ ...agentAt(0, 25), spentToday: { day: yesterday, usd: 60, tokens: 0 } });
  check('and the bar, the line and the colour with it: zero, ok, green', full?.spent === 0 && full.pct === 0 && full.state === 'ok' && full.tone === 'ok' && full.over === false);
  check('the lifetime figure is shown beside it, and not read by it: $80 spent in all, nothing over', agentAt(80, 25).costUsd === 80 && budgetOf({ ...agentAt(80, 25), spentToday: { day: today, usd: 0, tokens: 0 } })?.state === 'ok');
  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  const head = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the composer names the day in the line that warns, and in the notice for a lowered budget', /over today's budget/.test(readFileSync(new URL('./settingsfold.ts', import.meta.url), 'utf8')) && /already spent today/.test(comp) && !/it will not run again until raised, or tomorrow/.test(comp));
  check('the header and tab say daily', />over today's budget</.test(head) && /of its daily budget/.test(head));
}


console.log('\n· the terminal, the rest of the plan (Amendment 141)');
{
  // ── keys, per OS ──
  type K = { type: string; key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
  const k = (key: string, mods: Partial<K> = {}): K => ({ type: 'keydown', key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  const cmd = { metaKey: true };
  const cs = { ctrlKey: true, shiftKey: true };
  check('macOS: ⌘F finds, ⌘C copies, ⌘V pastes, ⌘K clears', termKey(k('f', cmd), true) === 'find' && termKey(k('c', cmd), true) === 'copy' && termKey(k('v', cmd), true) === 'paste' && termKey(k('k', cmd), true) === 'clear');
  check('Ubuntu: Ctrl-Shift-F, -C, -V, -K, and Shift-Insert pastes (the key is a capital with Shift held)', termKey(k('F', cs), false) === 'find' && termKey(k('C', cs), false) === 'copy' && termKey(k('V', cs), false) === 'paste' && termKey(k('K', cs), false) === 'clear' && termKey(k('Insert', { shiftKey: true }), false) === 'paste');
  check("the other OS's keys are the shell's: Ctrl-Shift-F on a Mac, ⌘F on Ubuntu", termKey(k('F', cs), true) === null && termKey(k('f', cmd), false) === null);
  check("Ctrl-C, Ctrl-F, Ctrl-V and Ctrl-K alone are always the shell's (SIGINT, readline, literal-next, kill-line)", ['c', 'f', 'v', 'k'].every((x) => termKey(k(x, { ctrlKey: true }), false) === null && termKey(k(x, { ctrlKey: true }), true) === null));
  check('⌘⇧F, ⌥⌘F and a keyup are not taken', termKey(k('f', { metaKey: true, shiftKey: true }), true) === null && termKey(k('f', { metaKey: true, altKey: true }), true) === null && termKey(k('f', { metaKey: true, type: 'keyup' }), true) === null);
  check('Ctrl-` is the dock, on both, by key or by code; ⌘` (the Mac window switcher) is not', dockKey(k('`', { ctrlKey: true })) && dockKey(k('Dead', { ctrlKey: true, code: 'Backquote' })) && !dockKey(k('`', cmd)) && !dockKey(k('`')) && !dockKey(k('`', { ctrlKey: true, type: 'keyup' })));
  check('a Mac is a Mac by its platform string, and the hint says its key', isMac('MacIntel') && isMac('iPad') && !isMac('Linux x86_64') && !isMac('Win32') && findHint(true) === '⌘F' && findHint(false) === 'Ctrl-Shift-F');

  // ── paths that open in Files ──
  const hits = (line: string) => findPathLinks(line).map((h) => ({ text: line.slice(h.start, h.end), path: h.path, line: h.line, col: h.col }));
  const one = hits('error in src/app.ts:12:3 here')[0];
  check('`src/app.ts:12:3` is a link, to line 12 column 3, and the link covers the whole of it', one?.text === 'src/app.ts:12:3' && one.path === 'src/app.ts' && one.line === 12 && one.col === 3, JSON.stringify(hits('error in src/app.ts:12:3 here')));
  const tsc = hits('packages/web/src/x.tsx(40,7): error TS2345')[0];
  check("tsc's `x.tsx(40,7)` is too", tsc?.path === 'packages/web/src/x.tsx' && tsc.line === 40 && tsc.col === 7 && tsc.text === 'packages/web/src/x.tsx(40,7)', JSON.stringify(tsc));
  check('`README.md:3` (a line, no folder) and `./docs/a.md` (a folder, no line) are links', hits('see README.md:3')[0]?.line === 3 && hits('wrote ./docs/a.md')[0]?.path === './docs/a.md');
  check('a full stop after a path is not part of it', hits('Updated docs/guide.md.')[0]?.path === 'docs/guide.md');
  check('ordinary words are not: `node.js`, a version, a time, a bare folder name', hits('built with node.js v1.2.3 at 12:30 in src').length === 0, JSON.stringify(hits('built with node.js v1.2.3 at 12:30 in src')));
  check('nor the path inside a URL, which web-links opens instead', hits('see https://example.com/a/b.ts:4 now').length === 0, JSON.stringify(hits('see https://example.com/a/b.ts:4 now')));
  check('two on one line are two links', hits('a/x.ts:1 and b/y.ts:2').map((h) => h.path).join() === 'a/x.ts,b/y.ts');
  check('relative to the folder the terminal started in, inside its worktree', termFileTarget('src/a.ts', '/w/job', '/w/job') === 'src/a.ts' && termFileTarget('./x/../y.ts', '/w/job', '/w/job') === 'y.ts' && termFileTarget('a.ts', '/w/job/pkg', '/w/job') === 'pkg/a.ts' && termFileTarget('../b.ts', '/w/job/pkg', '/w/job') === 'b.ts');
  check('an absolute path inside it is a link; one in a folder with a longer name is not (`/w/job-evil`)', termFileTarget('/w/job/src/a.ts', '/w/job', '/w/job') === 'src/a.ts' && termFileTarget('/w/job-evil/a.ts', '/w/job', '/w/job') === null);
  check('outside it is plain text: `..` past the root, `~`, another folder, a terminal started elsewhere', termFileTarget('../a.ts', '/w/job', '/w/job') === null && termFileTarget('~/a.ts', '/w/job', '/w/job') === null && termFileTarget('/etc/passwd', '/w/job', '/w/job') === null && termFileTarget('a.ts', '/tmp', '/w/job') === null);
  check('Files marks the line asked for: the text split around it, the last line for one past the end', JSON.stringify(rawAround('a\nb\nc', 2)) === '{"before":"a\\n","line":"b","after":"\\nc"}' && rawAround('a\nb\nc', 1).before === '' && rawAround('a\nb\nc', 99).line === 'c' && rawAround('a\nb\nc', 99).after === '');

  // ── settings, as the page reads them ──
  check("the keys are the plan's", TERM_FONT_SIZE.key === 'conductor.terminal.fontSize' && TERM_SCROLLBACK.key === 'conductor.terminal.scrollback' && TERM_SHELL_KEY === 'conductor.terminal.shell');
  check('font size: 9 to 24, 13 when unset or not one', fontSizeOf(null) === 13 && fontSizeOf('9') === 9 && fontSizeOf('24') === 24 && fontSizeOf('25') === 13 && fontSizeOf('8') === 13 && fontSizeOf('14.5') === 13 && fontSizeOf('big') === 13);
  check('scrollback: 1,000 to 100,000, 5,000 when unset or not one', scrollbackOf(null) === 5000 && scrollbackOf('1000') === 1000 && scrollbackOf('100000') === 100000 && scrollbackOf('999') === 5000 && scrollbackOf('5e3') === 5000);
  check('a field says what is wrong before the daemon refuses it', termNumberProblem('30', TERM_FONT_SIZE) === 'A whole number from 9 to 24.' && termNumberProblem('500', TERM_SCROLLBACK) === 'A whole number from 1,000 to 100,000.' && termNumberProblem('12', TERM_FONT_SIZE) === null);
  check('the default is written as nothing, so the file keeps only what you chose', termNumberValue('13', TERM_FONT_SIZE) === null && termNumberValue(' 15 ', TERM_FONT_SIZE) === '15' && termNumberValue('5000', TERM_SCROLLBACK) === null);
  check('the dock is down until opened, and flips', DOCK_OPEN_KEY === 'conductor.terminal.dock' && !dockShown(null) && dockShown('open') && dockFlipped(null) === 'open' && dockFlipped('open') === null);

  // ── the socket: mouse reports as bytes ──
  const bin = JSON.parse(binaryFrame('\x1b[M \xfc!')) as { t: string; d: string };
  check('onBinary goes down as `bin`, base64 of the bytes themselves (0xfc stays one byte)', bin.t === 'bin' && [...Buffer.from(bin.d, 'base64')].join() === '27,91,77,32,252,33', JSON.stringify(bin));

  // ── the hub frame reaches the panels showing that scope ──
  const got: string[] = [];
  const stop = onTerminals({ kind: 'project', projectId: 'p1' }, (l) => got.push(l.map((t) => t.id).join() || 'none'));
  const info = (id: string) => ({ id, scope: { kind: 'project' as const, projectId: 'p1' }, cwd: '/p', shell: '/bin/zsh', startedAt: '2026-10-13T00:00:00Z', exited: false, exitCode: null });
  receiveTerminals({ type: 'terminals', scope: { kind: 'project', projectId: 'p1' }, terminals: [info('t1')] });
  receiveTerminals({ type: 'terminals', scope: { kind: 'project', projectId: 'p2' }, terminals: [info('t9')] });
  receiveTerminals({ type: 'terminals', scope: { kind: 'agent', agentId: 'p1' }, terminals: [info('t8')] });
  receiveTerminals({ type: 'terminals', scope: { kind: 'project', projectId: 'p1' }, terminals: [] });
  stop();
  receiveTerminals({ type: 'terminals', scope: { kind: 'project', projectId: 'p1' }, terminals: [info('t2')] });
  check('a `terminals` frame reaches the panel for its scope only, and not after it lets go', got.join('|') === 't1|none', got.join('|'));

  // ── wiring, from the source ──
  const view = readFileSync(new URL('./Xterm.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('./TermPanel.tsx', import.meta.url), 'utf8');
  const dock = readFileSync(new URL('../terminal/dock.tsx', import.meta.url), 'utf8');
  const shellSrc = readFileSync(new URL('../shell/shell.tsx', import.meta.url), 'utf8');
  const fleetDock = readFileSync(new URL('../fleet/dock.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const storeSrc = readFileSync(new URL('../lib/store.ts', import.meta.url), 'utf8');
  const pane = readFileSync(new URL('../files/FilePane.tsx', import.meta.url), 'utf8');
  check('Xterm reads the font size and scrollback, and applies a change to an open terminal (a new font size re-fits)', /useSetting\(TERM_FONT_SIZE\.key\)/.test(view) && /useSetting\(TERM_SCROLLBACK\.key\)/.test(view) && /t\.options\.fontSize = fontSize;\s*refitRef\.current\(\);/.test(view) && /term\.current\.options\.scrollback = scrollback/.test(view) && !/fontSize: 13/.test(view) && !/scrollback: 5000/.test(view));
  check('the add-ons: search, web links (a new tab), clipboard (write only), WebGL, Unicode 11', ['SearchAddon', 'WebLinksAddon', 'ClipboardAddon', 'WebglAddon', 'Unicode11Addon'].every((a) => new RegExp(`new ${a}\\(`).test(view)) && /window\.open\(uri, '_blank'/.test(view) && /readText: \(\) => ''/.test(view) && /t\.unicode\.activeVersion = '11'/.test(view));
  check('WebGL falls back to the DOM renderer when the context is lost or WebGL is not there', /gl\.onContextLoss\(\(\) => \{\s*gl\.dispose\(\);/.test(view) && /try \{\s*const gl = new WebglAddon\(\);[\s\S]*?\} catch \{\s*setRenderer\('dom'\);/.test(view));
  check('onBinary is sent, as bytes', /t\.onBinary\(\(d\) => send\(binaryFrame\(d\)\)\)/.test(view));
  check('the key handler takes find, copy, paste and clear by the OS map, and lets Ctrl-` through to the dock', /termKey\(k, mac\)/.test(view) && /if \(dockKey\(k\)\) return false;/.test(view) && /setFinding\(true\)/.test(view));
  check('the find bar: Enter next, Shift-Enter previous, Esc closes and gives the terminal its focus back', /find\(e\.shiftKey\)/.test(view) && /e\.key === 'Escape'[\s\S]*?closeFind\(\)/.test(view) && /const closeFind = \(\): void => \{[\s\S]*?term\.current\?\.focus\(\)/.test(view));
  check('paths are links through a link provider, opening Files at the line', /registerLinkProvider\(/.test(view) && /findPathLinks\(text\)/.test(view) && /termFileTarget\(hit\.path, at\.cwd, at\.root\)/.test(view) && /navigate\(SCREEN\.files, \{ jobId: at\.filesRoot, path, \.\.\.\(hit\.line \? \{ line: String\(hit\.line\) \} : \{\}\) \}\)/.test(view));
  check('and Files shows that line: raw, marked, scrolled to', /useWantedLine\(tabKey\)/.test(pane) && /className="c5-lit"/.test(pane) && /scrollIntoView\(\{ block: 'center' \}\)/.test(pane));
  check('the tabs are one component for either scope, kept current by the hub frame', /export function TermTabs\(/.test(panel) && /return onTerminals\(scope,/.test(panel) && /case 'terminals':\s*\/\/[^\n]*\n\s*receiveTerminals\(frame\);/.test(storeSrc));
  check("the dock: the project's terminals, its height dragged and kept, under every screen above the status bar", /<TermTabs[\s\S]*?scope=\{\{ kind: 'project', projectId: project\.id \}\}/.test(dock) && /usePanel\(TERMINAL_DOCK\)/.test(dock) && /<TerminalDock \/>\s*\n\s*<StatusBar \/>/.test(shellSrc));
  check('opened with Ctrl-` anywhere, and from a status-bar button', /useDockKey\(\);/.test(shellSrc) && /<DockButton \/>/.test(shellSrc) && /if \(!dockKey\(e\) \|\| e\.repeat\) return;/.test(dock));
  check("the Project screen's placeholder terminal tab is gone: it opens the dock", /\{ id: 'terminal', label: '▸ terminal', jump: 'terminal' \}/.test(fleetDock) && /if \(jump === 'terminal'\) return openDock\(\);/.test(fleetDock) && !/not yet assigned/.test(fleetDock));
  check("Settings (9) has a Terminal section: the two numbers as the slot limit is edited, and the shell from the daemon's list", /<Section title="Terminal">\s*<TerminalSection \/>/.test(settings) && /range=\{TERM_FONT_SIZE\}/.test(settings) && /range=\{TERM_SCROLLBACK\}/.test(settings) && /listShells\(\)/.test(settings) && /onBlur=\{commit\}[\s\S]*?e\.key === 'Escape'\) setDraft\(null\)/.test(settings));
}

console.log('\n· "merge into main and clean up when done" in the agent\'s settings (Amendment 144)');
{
  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  check('the composer has the pill, worded as Spawn words it', /label: MERGE_WHEN_DONE_LABEL,\s*hint: MERGE_WHEN_DONE_HINT,/.test(comp) && /from '\.\.\/spawn\/autonomy\.js'/.test(comp));
  check('it reads mergeWhenDone and sends only that field', /on: \(a\) => a\.mergeWhenDone === true,/.test(comp) && /flip: \(_a, on\) => \(\{ mergeWhenDone: on \}\),/.test(comp));
  check('it sits with the guardrails, so it folds with them', comp.indexOf("id: 'merge_when_done'") > comp.indexOf('const PILLS: PillDef[] = [') && comp.indexOf("id: 'merge_when_done'") < comp.indexOf('interface ModeDef'));
}

console.log("\n· an orchestrator's auto turns start folded, and one you open stays open (Amendment 164)");
{
  const at = (seq: number, payload: unknown): Event =>
    ({ seq, ts: '2026-10-15T00:00:00Z', projectId: 'p', jobId: 'j', agentId: 'o', payload }) as Event;
  const REPORT = 'Your helper has finished. What each was told and said, in order:\n\n[developer]\nHELPER_BODY: built the lane';
  const run = buildTranscript([
    at(1, { kind: 'user_text', text: 'run track 6' }),
    at(2, {
      kind: 'tool_start',
      toolUseId: 'tu1',
      tool: 'mcp__conductor__start_helper',
      label: 'start_helper',
      input: { role: 'developer', task: 'Build lane O3: fold the auto turns', name: 'o3' },
    }),
    at(3, { kind: 'user_text', text: REPORT, synthetic: true }),
    at(4, { kind: 'text', text: 'ORCH_REPLY: the developer built it; next the reviewer.' }),
  ]);
  const draw = (agentId: string, orchestrator: boolean): string =>
    renderToStaticMarkup(
      createElement(Transcript, {
        turns: run,
        agentId,
        role: 'orchestrator',
        streaming: false,
        links: null,
        startFolded: startFoldedKeys(run, orchestrator),
      }),
    );
  // The auto turn's own element, from its id to the next turn.
  const autoOf = (html: string): string => html.slice(html.indexOf('id="t-u3"') - 80, html.indexOf('id="t-a4"'));

  const orch = draw('agt_orch', true);
  check('the helpers\' report is an auto turn, keyed u3, that starts folded in an orchestrator\'s transcript', startFoldedKeys(run, true).join(' ') === 'u3', startFoldedKeys(run, true).join(' '));
  check('an orchestrator\'s auto turn renders folded: its first line and a count, not the report', /class="ag-msg is-you is-auto is-folded"/.test(orch) && autoOf(orch).includes('aria-expanded="false"') && autoOf(orch).includes('Your helper has finished.') && /4 lines/.test(autoOf(orch)) && !orch.includes('HELPER_BODY'), autoOf(orch));
  check('and the orchestrator\'s own reply is open: the page opens to it', orch.includes('ORCH_REPLY') && !/id="t-a4"[^>]*is-folded|is-folded[^>]*id="t-a4"/.test(orch));

  const plain = draw('agt_plain', false);
  check('a non-orchestrator\'s auto turn renders open (Amendment 18)', startFoldedKeys(run, false).length === 0 && plain.includes('HELPER_BODY') && /class="ag-msg is-you is-auto"/.test(plain) && autoOf(plain).includes('aria-expanded="true"'));
  check('and still folds, from its label', autoOf(plain).includes('class="ag-who ag-who-fold"') && autoOf(plain).includes('title="Fold this turn to one line"'));

  // Opening a default fold is kept in the unfolded set, and nothing is written to the folds.
  const none: FoldState = { folds: {}, unfolds: {} };
  const opened = toggleFold(none, 'agt_orch', 'u3', true);
  check('a default fold you open is kept as opened', !shownFolded(opened, 'agt_orch', 'u3', true) && isFolded(opened.unfolds, 'agt_orch', 'u3') && Object.keys(opened.folds).length === 0);
  check('and survives a reload', !shownFolded({ folds: {}, unfolds: parseFolds(JSON.stringify(opened.unfolds)) }, 'agt_orch', 'u3', true));
  check('folding it again forgets it, back to the default', shownFolded(toggleFold(opened, 'agt_orch', 'u3', true), 'agt_orch', 'u3', true) && !('agt_orch' in toggleFold(opened, 'agt_orch', 'u3', true).unfolds));
  check('a reply still starts open, and only your fold folds it (Amendment 18)', !shownFolded(none, 'agt_orch', 'a4', false) && shownFolded(toggleFold(none, 'agt_orch', 'a4', false), 'agt_orch', 'a4', false) && Object.keys(toggleFold(none, 'agt_orch', 'a4', false).unfolds).length === 0);
  check('a stored set of folds from before reads as it did', shownFolded({ folds: parseFolds('{"agt_x":["a2"]}'), unfolds: {} }, 'agt_x', 'a2', false));
  updateFoldState((s) => toggleFold(s, 'agt_orch', 'u3', true));
  const reopened = draw('agt_orch', true);
  check('a default fold you open stays open, rendered', reopened.includes('HELPER_BODY') && autoOf(reopened).includes('aria-expanded="true"') && !/is-auto is-folded/.test(reopened));
  check('on another agent it is still folded', !draw('agt_orch2', true).includes('HELPER_BODY'));

  // Fold all: the replies and the auto turns.
  check('fold all covers the auto turns', replyKeys(run).join(' ') === 'a2 u3 a4', replyKeys(run).join(' '));
  const keys = replyKeys(run);
  const byDefault = startFoldedKeys(run, true);
  const all = foldEvery(opened, 'agt_orch', keys, byDefault);
  check('fold all folds every turn, the one you opened included', keys.every((k) => shownFolded(all, 'agt_orch', k, byDefault.includes(k))) && !isFolded(all.folds, 'agt_orch', 'u3'));
  const loose = unfoldEvery(all, 'agt_orch', byDefault);
  check('unfold all opens every turn, the auto turn included', keys.every((k) => !shownFolded(loose, 'agt_orch', k, byDefault.includes(k))));
  const plainAll = foldEvery(none, 'agt_plain', keys, []);
  check('and on a non-orchestrator, fold all folds its auto turns too', keys.every((k) => shownFolded(plainAll, 'agt_plain', k, false)));
  updateFoldState((s) => foldEvery(s, 'agt_orch', keys, byDefault));
  const folded = draw('agt_orch', true);
  check('rendered after fold all, nothing is open', (folded.match(/aria-expanded="false"/g) ?? []).length === 3 && !folded.includes('HELPER_BODY') && !folded.includes('class="ag-md"'), folded);

  // The start_helper row says what it was asked to do, not its JSON.
  check('a start_helper line shows its task', /<span class="ag-tool-subj">Build lane O3: fold the auto turns<\/span>/.test(plain) && !plain.includes('&quot;task&quot;'));

  const screen = readFileSync(new URL('./agent.tsx', import.meta.url), 'utf8');
  check('the Agent screen calls an agent with helpers an orchestrator, and passes what starts folded', /const orchestrator = \(agent\?\.helperCap \?\? 0\) > 0;/.test(screen) && /startFoldedKeys\(turns, orchestrator\)/.test(screen) && /startFolded=\{startFolded\}/.test(screen));
  check('and its fold all uses both sets', /foldEvery\(s, agent\.id, replies, startFolded\)/.test(screen) && /unfoldEvery\(s, agent\.id, startFolded\)/.test(screen));
}
console.log('\n· a working agent says what its run took (Amendment 178)');
{
  const comp = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8');
  check('a tool changed on a working agent is its next run\'s', appliesSays('tools', true, 'now') === 'From the next run — this one keeps the tools it started with.');
  check('a mode or effort its run took says now; one it could not, the next run', appliesSays('mode', true, 'now').startsWith('Now') && appliesSays('effort', true, 'next run').startsWith('From the next run'));
  check('an agent not working is told nothing: every run is built from what is set', appliesSays('tools', false, 'now') === '' && appliesSays('mode', false, 'next run') === '');
  check('the pills, the modes and effort say it, and merging when done is not a tool', /appliesSays\('tools', working, r\.appliesTo\)/.test(comp) && /appliesSays\('mode', working, r\.appliesTo\)/.test(comp) && /appliesSays\('effort', working, r\.appliesTo\)/.test(comp) && /pill\.id !== 'merge_when_done'/.test(comp));
  check('and under the mode row, while it works, which of them its run takes now', WORKING_SAYS === 'mode and effort now · tools and budget from the next run' && /ag-modesays-when"> · \{WORKING_SAYS\}/.test(comp) && !comp.includes('· takes effect on the next run</span>'));
}

console.log("\n· an orchestrator's transcript says its finished helpers were removed (Amendment 177)");
{
  const at = (seq: number, payload: unknown): Event =>
    ({ seq, ts: '2026-10-16T00:00:00Z', projectId: 'p', jobId: 'j', agentId: 'o', payload }) as Event;
  const run = buildTranscript([
    at(1, { kind: 'text', text: 'Both lanes are merged.' }),
    at(2, { kind: 'status', status: 'done' }),
    at(3, { kind: 'helpers_removed', count: 2, names: ['developer-api', 'reviewer-api'] }),
    at(4, { kind: 'user_text', text: 'now the next track' }),
  ]);
  const notes = run.flatMap((t) => t.blocks).filter((b) => b.kind === 'note').map((b) => (b.kind === 'note' ? `${b.tone}:${b.text}` : ''));
  check('a helpers_removed event is one line: the count, then their names', notes.join(' | ') === 'done:finished | idle:2 finished helpers removed: developer-api, reviewer-api', notes.join(' | '));
  check('at the end of the turn before your new task, which follows it', run.length === 2 && run[1]?.who === 'you' && run[1].text === 'now the next track');
  check('one helper reads as one', helpersRemovedNote(1, ['builder-api']) === '1 finished helper removed: builder-api');
  const drawn = renderToStaticMarkup(createElement(Transcript, { turns: run, agentId: 'agt_o', role: 'orchestrator', streaming: false, links: null, startFolded: [] }));
  check('and the transcript renders it', drawn.includes('2 finished helpers removed: developer-api, reviewer-api'), drawn.slice(0, 400));
}

console.log(
  failures === 0
    ? '\nTrack B agent: PASS — the terminal’s keys, path links, settings and dock hold (Amendment 141); agent markdown renders as a document and cannot become markup; the budget field sends what it shows; file links stay inside the worktree; an agent opens at its latest reply; pause and resume say what sleeping keeps; a non-Claude agent shows only the controls its engine has, with its budget in tokens; its settings fold to one line; an orchestrator’s auto turns start folded, one you open stays open, and fold all reaches them; and it says when its finished helpers were removed; a working agent is told which of its changes its run took (Amendment 178).\n'
    : `\nTrack B agent: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
