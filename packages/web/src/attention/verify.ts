/**
 * Track E verification — the attention queue's pure parts.
 *
 *   pnpm --filter @conductor/web exec tsx src/attention/verify.ts
 *
 * No daemon, no browser. `aging.ts`, `describe.ts`, `interaction.ts` and the verb in
 * `decisions.ts` are pure; the cards only render what these return. That makes them
 * where a wrong answer would be quiet: a mis-tiered wait still draws a bar, and an
 * "Other" answer with nothing typed would still send.
 *
 * Not covered here: `sanitizePreview`'s DOM path. It needs a DOMParser, and Node has
 * none without a dependency CONTRACT §3 does not allow. What is covered is that it
 * fails closed without one — nothing unsanitised can reach innerHTML by that route.
 */

import { readFileSync } from 'node:fs';
import { HANDOFF_BY_USER_NOTE, HANDOFF_HELD_NOTE, HANDOFF_SUMMARY_MAX } from '@conductor/shared';
import type { Agent, Alert, Event, PendingRequest, PermissionSuggestion, Project, Question } from '@conductor/shared';
import {
  AGE_FULL_MS,
  ageGradientSize,
  ageLabel,
  ageRatio,
  ageTier,
  ageToken,
  formatWait,
  waitingMs,
} from './aging.js';
import { decisionVerb } from './decisions.js';
import {
  destinationLabel,
  inputJson,
  orderedSuggestions,
  preferredSuggestion,
  primaryField,
  requestTitle,
  sanitizePreview,
  secondaryFields,
  suggestionRule,
} from './describe.js';
import {
  OTHER,
  buildAnswers,
  emptyDraft,
  isDraftComplete,
  isQuestionAnswered,
  optionLabels,
  setOtherText,
  toggleChoice,
} from './interaction.js';
import { alertActions, alertNotice, alertProject, handOffDraft, handOffProblem, resumable, waitingRoles, type AlertAction } from './alerts.js';
import { badgeState, dueForChime } from './notify.js';
import { alertTitle, alertWord } from '../shell/describe.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const MIN = 60_000;

const pick: Question = {
  question: 'Which database?',
  header: 'DB',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: '' },
    { label: 'SQLite', description: '' },
    { label: 'MySQL', description: '' },
  ],
};
const many: Question = {
  question: 'Which checks?',
  header: 'Checks',
  multiSelect: true,
  options: [
    { label: 'lint', description: '' },
    { label: 'test', description: '' },
  ],
};

console.log('\n1 · a wait reads the same everywhere it appears');
{
  const now = Date.parse('2026-09-26T12:00:00Z');
  check('90 s ago', waitingMs('2026-09-26T11:58:30Z', now) === 90_000);
  check('a clock skewed into the future is not a negative wait', waitingMs('2026-09-26T12:00:05Z', now) === 0);
  check('an unparseable time is no wait, not NaN', waitingMs('soon', now) === 0);

  check('59.999 s is still fresh', ageTier(MIN - 1) === 'fresh');
  check('a minute is waiting', ageTier(MIN) === 'waiting');
  check('5 min is aging', ageTier(5 * MIN) === 'aging');
  check('12 min is critical', ageTier(12 * MIN) === 'critical');
  check('each tier starts exactly at its floor', ageTier(5 * MIN - 1) === 'waiting' && ageTier(12 * MIN - 1) === 'aging');

  check('a new request still shows a sliver', ageRatio(0) === 0.02);
  const mockup = ageRatio(12 * MIN + 40_000);
  check("12m 40s fills 84% of the bar, as the mockup draws it", Math.round(mockup * 100) === 84, String(mockup));
  check('past full scale the bar stops at full', ageRatio(AGE_FULL_MS * 4) === 1);
  check('half full → a gradient twice the track', ageGradientSize(0.5) === '200.00% 100%');
  check('a zero ratio does not divide by zero', !/Infinity|NaN/.test(ageGradientSize(0)), ageGradientSize(0));

  check('critical text is --fail', ageToken('critical') === 'var(--fail)');
  check('aging and waiting text is --need', ageToken('aging') === 'var(--need)' && ageToken('waiting') === 'var(--need)');
  check('fresh text is quiet', ageToken('fresh') === 'var(--ink3)');

  check('0 s', formatWait(0) === '0s');
  check('41 s', formatWait(41_000) === '41s');
  check('12m 40s pads the seconds', formatWait(12 * MIN + 40_000) === '12m 40s');
  check('an hour drops the seconds and pads the minutes', formatWait(64 * MIN + 59_000) === '1h 04m');
  check('the label says aging only once it is', ageLabel(4 * MIN) === '4m 00s' && ageLabel(5 * MIN) === '5m 00s — aging');
}

console.log('\n2 · a tool call shows the thing that will run');
{
  check('command beats file_path', primaryField({ file_path: 'a.ts', command: 'rm -rf x' })?.key === 'command');
  check('an empty command is skipped, not shown blank', primaryField({ command: '', path: 'src' })?.value === 'src');
  check('a non-object input has no primary field', primaryField('rm -rf /') === null && primaryField(['x']) === null);

  const rest = secondaryFields({ command: 'ls', description: 'list', timeout: 5, gone: null, empty: '' }, 'command');
  check(
    'secondary fields: all but the primary, none blank, objects as JSON',
    JSON.stringify(rest) === JSON.stringify([['description', 'list'], ['timeout', '5']]),
    JSON.stringify(rest),
  );

  const loop: Record<string, unknown> = {};
  loop['self'] = loop;
  check('a circular input does not throw', inputJson(loop) === '{}');
  check('no input is an empty object', inputJson(undefined) === '{}');

  const session: PermissionSuggestion = { destination: 'session', rules: [{ toolName: 'Bash' }] };
  const local: PermissionSuggestion = {
    destination: 'localSettings',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test' }, { ruleContent: 'Read(**)' }],
  };
  const both = [session, local];
  check('the persisting rule is preferred', preferredSuggestion(both) === local);
  check('otherwise the first', preferredSuggestion([session]) === session);
  check('no suggestions → none', preferredSuggestion([]) === null && preferredSuggestion(undefined) === null);
  check('the persisting rule sorts first', orderedSuggestions(both)[0] === local);
  check('sorting leaves the request untouched', both[0] === session);
  check('rule text names the tool and the content', suggestionRule(local) === 'Bash(npm test), Read(**)');
  check('a tool-only rule is the tool', suggestionRule(session) === 'Bash');
  check('no rules → no label', suggestionRule({ destination: 'session' }) === null);
  check('where it lands, in words', destinationLabel('localSettings').startsWith('.claude/settings.local.json'));
  check('an unknown destination passes through', destinationLabel('policySettings') === 'policySettings');

  const base: PendingRequest = {
    requestId: 'r1',
    projectId: 'p1',
    jobId: 'j1',
    agentId: 'a1',
    agentRole: 'builder',
    projectName: 'demo',
    kind: 'permission',
    blockMode: 'held',
    createdAt: '2026-09-26T12:00:00Z',
    toolName: 'Bash',
    input: { command: 'npm test' },
  };
  check('a permission title shows the command', requestTitle(base) === 'Bash · npm test');
  check('a tool with no primary field is its name', requestTitle({ ...base, input: {} }) === 'Bash');
  const ask = (questions: Question[]): PendingRequest => ({ ...base, kind: 'question', toolName: 'AskUserQuestion', questions });
  check('one question counts its options', requestTitle(ask([pick])) === 'question · 3 options');
  check('several questions count themselves', requestTitle(ask([pick, many])) === 'question · 2 questions');

  check('a preview with no DOM to clean it is dropped, not passed through', sanitizePreview('<b onclick="x()">hi</b>') === null);
  check('a blank preview is none', sanitizePreview('   ') === null && sanitizePreview(undefined) === null);
}

console.log('\n3 · an answer is only an answer when it says something');
{
  const d0 = emptyDraft();
  const d1 = toggleChoice(d0, pick.question, 'Postgres', false);
  check('single-select picks one', JSON.stringify(d1.selected[pick.question]) === '["Postgres"]');
  check('the previous draft is not mutated', d0.selected[pick.question] === undefined);
  const d2 = toggleChoice(d1, pick.question, 'SQLite', false);
  check('single-select replaces', JSON.stringify(d2.selected[pick.question]) === '["SQLite"]');
  check('clicking the choice again clears it', (toggleChoice(d2, pick.question, 'SQLite', false).selected[pick.question] ?? []).length === 0);

  const m1 = toggleChoice(toggleChoice(d0, many.question, 'lint', true), many.question, 'test', true);
  check('multi-select adds', JSON.stringify(m1.selected[many.question]) === '["lint","test"]');
  check('multi-select removes', JSON.stringify(toggleChoice(m1, many.question, 'lint', true).selected[many.question]) === '["test"]');

  const other = toggleChoice(d0, pick.question, OTHER, false);
  check('"Other" with nothing typed is unanswered', !isQuestionAnswered(other, pick));
  check('…and whitespace is nothing', !isQuestionAnswered(setOtherText(other, pick.question, '   '), pick));
  const typed = setOtherText(other, pick.question, ' DuckDB ');
  check('"Other" with text is answered', isQuestionAnswered(typed, pick));

  const full = toggleChoice(typed, many.question, 'lint', true);
  check('complete only when every question is', !isDraftComplete([pick, many], typed) && isDraftComplete([pick, many], full));
  check('no questions is never complete', !isDraftComplete([], full));
  const answers = buildAnswers([pick, many], full);
  check(
    'the wire shape: typed text replaces "Other", single → string, multi → array',
    JSON.stringify(answers) === JSON.stringify({ [pick.question]: 'DuckDB', [many.question]: ['lint'] }),
    JSON.stringify(answers),
  );
  check('an unanswered question is left out, not sent empty', !(many.question in buildAnswers([pick, many], typed)));
  check('"Other" is the last option', optionLabels(pick).at(-1) === OTHER && optionLabels(pick).length === 4);
}

console.log('\n4 · a sent decision says what was sent');
{
  check('deny', decisionVerb({ type: 'deny', message: 'no' }) === 'denied');
  check('allow once', decisionVerb({ type: 'allow_once' }) === 'allowed once');
  check('allow always', decisionVerb({ type: 'allow_always', suggestions: [] }) === 'allowed for the session');
  check('edited', decisionVerb({ type: 'allow_edited', updatedInput: {} }) === 'allowed with an edited command');
  check('answer', decisionVerb({ type: 'answer', answers: {} }) === 'answered');
  check('nothing recorded yet', decisionVerb(undefined) === 'answered');
}

// Amendment 28. A button that cannot work is worse than no button: it fails only when
// pressed, which is the moment someone was counting on it.
console.log('\n5 · a stopped agent is offered only what can work, and is counted');
{
  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'a1',
    jobId: 'j1',
    projectId: 'p1',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'failed',
    blockMode: null,
    costUsd: 5,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: 'al_1',
    kind: 'failed',
    cause: 'max_turns',
    projectId: 'p1',
    jobId: 'j1',
    agentIds: ['a1'],
    since: '2026-09-26T12:00:00Z',
    ...over,
  });
  const ids = (xs: AlertAction[]) =>
    xs.map((a) => (a.id === 'raise' ? `raise:${a.by}->${a.to}` : a.id === 'continue' ? `${a.label}:${a.agentIds.join('+')}` : a.id)).join(' ');

  check('a paused agent resumes, session or not', resumable(agent({ status: 'paused', sdkSessionId: null })));
  check('a failed one with its session can go on', resumable(agent()));
  check('a failed one without cannot', !resumable(agent({ sdkSessionId: null })));
  check('nor can one that is running or done', !resumable(agent({ status: 'working' })) && !resumable(agent({ status: 'done' })));

  const failed = ids(alertActions(alert(), [agent()]));
  check('a failure offers continue first', failed === 'continue:a1 open dismiss', failed);
  const lost = ids(alertActions(alert(), [agent({ sdkSessionId: null })]));
  check('and no continue when there is no session to continue', lost === 'open dismiss', lost);

  const budget = alert({ kind: 'budget', cause: 'budget_exhausted' });
  const atCap = ids(alertActions(budget, [agent()]));
  check(
    'at its cap, every way on raises it — continue alone would be refused',
    atCap === 'raise:10->15 raise:25->30 open dismiss',
    atCap,
  );
  const cents = alertActions(budget, [agent({ costUsd: 0.012, autonomy: { ...agent().autonomy, budgetUsd: 0.01 } })]);
  check('the raise starts from the cap, not from what was spent', cents[0]?.id === 'raise' && cents[0].to === 10.01);
  const raised = ids(alertActions(budget, [agent({ autonomy: { ...agent().autonomy, budgetUsd: 15 } })]));
  check('raised already, it just continues', raised === 'continue:a1 open dismiss', raised);
  check('an agent this tab has not heard of can only be put away', ids(alertActions(budget, [])) === 'dismiss');

  const outage = alert({ kind: 'connection', cause: 'unreachable', projectId: null, agentIds: ['a1', 'a2'], attempt: 4 });
  const both = [agent({ status: 'working' }), agent({ id: 'a2', role: 'reviewer', status: 'working' })];
  const retrying = ids(alertActions(outage, both));
  check('while the SDK is still retrying there is nothing to press', retrying === 'open dismiss', retrying);
  const early = ids(alertActions(outage, [agent(), both[1]!]));
  check('not even for one that has already stopped: the network is still down', early === 'open dismiss', early);
  const gone = [agent(), agent({ id: 'a2', role: 'reviewer', sdkSessionId: null })];
  const gaveUp = ids(alertActions({ ...outage, gaveUp: true }, gone));
  check('once it gives up, retry is offered to the ones that can', gaveUp === 'retry:a1 open dismiss', gaveUp);

  const server = alert({ kind: 'server_down', cause: 'unexpected', agentIds: [], port: 5173 });
  check('a dead server opens its preview', ids(alertActions(server, [])) === 'preview dismiss');
  check('with no job, there is no preview to open', ids(alertActions({ ...server, jobId: null }, [])) === 'dismiss');

  // Waiting on an agent that failed (Amendment 85): the fix is that agent, so the buttons are its.
  const waiting = agent({ id: 'a3', role: 'reviewer', status: 'queued', sdkSessionId: null });
  const dev = agent({ id: 'a1', role: 'developer' });
  const blockedDep = alert({ kind: 'blocked_dep', cause: 'failed', agentIds: ['a3'], blockedBy: 'a1' });
  const unblock = alertActions(blockedDep, [waiting, dev]);
  check('waiting on a failed one offers to continue that one', ids(unblock) === 'continue:a1 open dismiss', ids(unblock));
  check(
    'and names it, since the card is about the other',
    unblock[0]?.id === 'continue' && unblock[0].role === 'developer' && unblock[1]?.id === 'open' && unblock[1].agentId === 'a1',
    JSON.stringify(unblock),
  );
  const stopped = agent({ id: 'a1', role: 'architect', status: 'stopped' });
  const stoppedDep = alertActions({ ...blockedDep, cause: 'stopped' }, [{ ...waiting, status: 'paused' }, stopped]);
  check(
    'a stopped one is not coming back: the one waiting, paused, is resumed to run without it (Amendment 88)',
    ids(stoppedDep) === 'resume:a3 open dismiss' && stoppedDep[0]?.id === 'continue' && stoppedDep[0].role === undefined,
    ids(stoppedDep),
  );
  const oldQueued = ids(alertActions({ ...blockedDep, cause: 'stopped' }, [waiting, stopped]));
  check('one still queued from before that has no resume, only looking', oldQueued === 'open dismiss', oldQueued);
  const told = alertTitle(blockedDep, [waiting, dev]);
  check(
    'the card says who waits on whom',
    `${told.head} ${told.subject}` === 'reviewer is waiting on developer, which failed',
    `${told.head} ${told.subject}`,
  );
  check(
    'the notification says it needs you',
    alertNotice(blockedDep, [waiting, dev], [{ id: 'p1', name: 'demo' } as Project]).title === 'demo · reviewer needs you',
  );
  check('the top bar has a word for it', alertWord({ kind: 'blocked_dep', cause: 'stopped' }) === 'waiting on a stopped agent');

  const request: PendingRequest = {
    requestId: 'r1',
    projectId: 'p1',
    jobId: 'j1',
    agentId: 'a1',
    agentRole: 'builder',
    projectName: 'demo',
    kind: 'permission',
    blockMode: 'held',
    createdAt: '2026-09-26T12:00:00Z',
    toolName: 'Bash',
    input: { command: 'npm test' },
  };
  const t0 = Date.parse(request.createdAt);
  const counted = badgeState([], 2, t0);
  check('alerts count on the tab', counted.count === 2, JSON.stringify(counted));
  check('but never turn it red: a stopped agent does not get worse by waiting', !counted.urgent);
  check('a twelve-minute request still does', badgeState([request], 2, t0 + 13 * MIN).urgent);
  const done = badgeState([], 2, t0, 3);
  check('a finished job you have not seen counts on the tab too, and never turns it red (Amendment 87)', done.count === 5 && !done.urgent);
  check('a request chimes after a minute, not before', dueForChime([request], [], t0 + 30_000, new Set()).length === 0);
  check('and then it does', dueForChime([request], [], t0 + 61_000, new Set()).join() === 'r1');
  const now = dueForChime([], [alert()], t0, new Set());
  check('an alert chimes at once: nothing will answer it', now.join() === 'alert:al_1', now.join());
  check(
    'nothing chimes twice',
    dueForChime([request], [alert()], t0 + 61_000, new Set(['r1', 'alert:al_1'])).length === 0,
  );

  const projects: Project[] = [{ id: 'p1', name: 'demo' } as Project];
  const note = alertNotice(budget, [agent()], projects);
  check(
    'a budget notification reads like a request one',
    note.title === 'demo · builder needs you' && note.body === 'builder spent its $5 budget',
    JSON.stringify(note),
  );
  const net = alertNotice(outage, both, projects);
  check("an outage has no project, so the title is what's wrong", net.title === "can't reach the model API", net.title);
  check('an unknown project is none, not a guess', alertProject({ projectId: 'p_gone' }, projects) === null);
}

// Amendment 104. An agent that others wait for ended its turn without calling hand_off: it is
// `done`, and the card offers to hand off for it, with the summary edited first, or to reply.
console.log('\n6 · an agent that stopped without handing off (Amendment 104)');
{
  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'a1',
    jobId: 'j1',
    projectId: 'p1',
    role: 'architect',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'done',
    blockMode: null,
    costUsd: 1,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const held: Alert = {
    id: 'handoff_held:a1:12',
    kind: 'handoff_held',
    cause: HANDOFF_HELD_NOTE,
    projectId: 'p1',
    jobId: 'j1',
    agentIds: ['a1'],
    since: '2026-10-08T12:00:00Z',
  };
  const architect = agent();
  const developer = agent({ id: 'a2', role: 'developer', status: 'queued', sdkSessionId: null, dependsOn: ['a1'] });
  const scribe = agent({ id: 'a3', role: 'scribe', status: 'queued', sdkSessionId: null, dependsOn: ['a1', 'a2'] });
  const ids = (xs: AlertAction[]) => xs.map((a) => a.id).join(' ');

  const acts = alertActions(held, [architect, developer]);
  check('the card offers hand off first, then looking, then putting it away', ids(acts) === 'hand_off open dismiss', ids(acts));
  check('hand off is about the stopped agent, not the ones waiting', acts[0]?.id === 'hand_off' && acts[0].agentId === 'a1', JSON.stringify(acts[0]));
  check('a card for an agent this tab has not heard of can only be put away', ids(alertActions(held, [])) === 'dismiss');
  const told = alertTitle(held, [architect, developer]);
  check('it says who stopped, and that the others have not started', told.head === 'architect' && /stopped without handing off/.test(told.subject) && /have not started/.test(told.subject), `${told.head} ${told.subject}`);
  check('the top bar has a word for it', alertWord(held) === 'stopped without handing off');
  check(
    'the notification says it needs you',
    alertNotice(held, [architect], [{ id: 'p1', name: 'demo' } as Project]).title === 'demo · architect needs you',
  );
  check('it chimes at once: nothing else will answer it', dueForChime([], [held], Date.parse(held.since), new Set()).join() === 'alert:handoff_held:a1:12');

  // Who is waiting, as the card lists them: the daemon's rule, shared.
  check('the card lists who waits for it, by role', waitingRoles('a1', [architect, developer, scribe]).join() === 'developer,scribe');
  check('not one that has started', waitingRoles('a1', [architect, { ...developer, status: 'working' }, scribe]).join() === 'scribe');
  check('and not its own orchestrator, which waits for it as a helper (Amendment 51)', waitingRoles('a1', [{ ...architect, parentId: 'a2' }, developer]).length === 0);

  // The box starts as the agent's last reply, so nobody types out what it already said.
  const at = (seq: number, payload: Event['payload']): Event => ({ seq, ts: '2026-10-08T12:00:00Z', projectId: 'p1', jobId: 'j1', agentId: 'a1', payload }) as Event;
  const log: Event[] = [
    at(1, { kind: 'text', text: 'Plan v1.' }),
    at(2, { kind: 'tool_start', toolUseId: 't', tool: 'Read', input: {}, label: 'Read x' }),
    at(3, { kind: 'text', text: '  Plan v2: JWT, with refresh tokens.\n' }),
    at(4, { kind: 'text', text: '   ' }),
    at(5, { kind: 'status', status: 'done', error: HANDOFF_HELD_NOTE }),
  ];
  check('the last reply, trimmed — not an earlier one, a tool call, a blank, or a status', handOffDraft(log) === 'Plan v2: JWT, with refresh tokens.', handOffDraft(log));
  check('an agent that wrote nothing starts an empty box', handOffDraft([at(1, { kind: 'status', status: 'done' })]) === '' && handOffDraft([]) === '');

  // What can be sent. The daemon says the same in its 409.
  check('an empty summary cannot be sent, and says what to do', /Say what/.test(handOffProblem('') ?? '') && handOffProblem('  \n ') !== null);
  check('nor one over the limit, which is named', /20,000/.test(handOffProblem('x'.repeat(HANDOFF_SUMMARY_MAX + 1)) ?? '') && handOffProblem('x'.repeat(HANDOFF_SUMMARY_MAX)) === null);
  check('anything else can', handOffProblem('Use JWT.') === null && handOffProblem(' Use JWT. ') === null);

  // The wiring: the button opens the edit box, the box sends exactly what is in it, and the
  // reply box is beside it. These are source checks: the card is not rendered in Node.
  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  const box = readFileSync(new URL('./HandOff.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('./alerts.ts', import.meta.url), 'utf8');
  const ep = readFileSync(new URL('../agent/endpoints.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./attention.css', import.meta.url), 'utf8');
  check('the card has a label and a tone for the kind', /handoff_held: \{ label: 'Not handed off', tone: 'var\(--need\)' \}/.test(card));
  check('the hand off button toggles the edit box; the box is the card’s HandOffPanel', /case 'hand_off':\s*setHandingOff\(\(open\) => !open\)/.test(card) && /<HandOffPanel agent=\{first\} editing=\{handingOff\}/.test(card));
  check('hand off is the fix, so it is the primary button', /a\.id === 'hand_off'/.test(card.slice(card.indexOf('function isFix'))));
  check('the box starts as the last reply and shows what was typed over it', /const summary = edited \?\? suggested;/.test(box) && /handOffDraft\(events\)/.test(box) && /onChange=\{\(e\) => setEdited\(e\.target\.value\)\}/.test(box));
  check('it cannot send what the daemon would refuse', /disabled=\{busy \|\| problem !== null\}/.test(box) && /if \(problem !== null\) return;/.test(box));
  check('it sends the text in the box, trimmed, to the hand-off call', /handOff\(agent, summary\)/.test(box) && /summary: summary\.trim\(\)/.test(api) && /agentPath\(agentId, 'hand-off'\)/.test(ep));
  check('the reply box sends an ordinary message to the agent', /sendMessage\(agent\.id, \{ text \}\)/.test(box) && /placeholder="It works again/.test(box));
  check('a refusal stays on the card, with its reason: the box goes through useCommand and nothing removes the card', /cmd\.run\('Handing off'/.test(box) && !/dismissAlert/.test(box));
  check('both themes read: the boxes use the card’s own textarea and tokens, and no colour of their own', !/#[0-9a-fA-F]{3,8}\b|style=|rgb\(/.test(box) && /className="atn-ta"/.test(box));
  const rules = css.slice(css.indexOf('.atn-handoff {'), css.indexOf('.atn-ta {'));
  check('and its CSS is tokens only', rules.length > 100 && !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(rules) && /var\(--ink3\)/.test(rules) && /var\(--fail\)/.test(rules));
  check('the transcript names both ends of it', HANDOFF_BY_USER_NOTE === 'handed off by you' && /HANDOFF_HELD_NOTE/.test(readFileSync(new URL('../agent/transcript.tsx', import.meta.url), 'utf8')));
}

console.log(
  failures === 0
    ? '\nTrack E verify: PASS — waits, tool calls and answers read as they should.\n'
    : `\nTrack E verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
