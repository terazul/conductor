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
import { HANDOFF_BY_USER_NOTE, HANDOFF_HELD_NOTE, HANDOFF_SUMMARY_MAX, localDayOf } from '@conductor/shared';
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
import { alertActions, alertNotice, alertProject, finishedConfirm, handOffChip, handOffDraft, handOffMissing, handOffProblem, jobRaiseTarget, mergeAndClean, mergeFinished, resumable, waitingRoles, type AlertAction } from './alerts.js';
import { badgeState, dueForChime, soundHint } from './notify.js';
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

/**
 * Amendment 129. A budget reads what an agent spent TODAY, which the fixtures below don't say; an
 * agent made with `costUsd` and tokens is one whose whole life was today, so those figures are its day.
 */
const spendingToday = (a: Agent): Agent => ({
  ...a,
  spentToday: a.spentToday ?? { day: localDayOf(), usd: a.costUsd, tokens: a.inputTokens + a.outputTokens },
});

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
  const agent = (over: Partial<Agent> = {}): Agent => spendingToday({
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
  // Amendment 180: nothing refuses a continue for a budget, so an agent the old ceiling paused just continues.
  const atCap = ids(alertActions(budget, [agent({ costUsd: 10, spentToday: { day: localDayOf(), usd: 10, tokens: 0 } })]));
  check('paused by the old ceiling, at twice its budget, it continues with no raise first', atCap === 'continue:a1 open dismiss', atCap);
  const far = ids(alertActions(budget, [agent({ costUsd: 50, spentToday: { day: localDayOf(), usd: 50, tokens: 0 } })]));
  check('and so it does at ten times it', far === 'continue:a1 open dismiss', far);
  const raised = ids(alertActions(budget, [agent({ autonomy: { ...agent().autonomy, budgetUsd: 15 } })]));
  check('raised already, it just continues too', raised === 'continue:a1 open dismiss', raised);
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
  const note = alertNotice(budget, [agent({ costUsd: 10 })], projects);
  check(
    'a budget notification reads like a request one',
    note.title === 'demo · builder needs you' && note.body === 'builder was paused by its $5 daily budget, which only warns now — continue carries on',
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

  // A summary short of the agent’s closing headings can still be sent; the card says which.
  const arch = { closingHeadings: ['Context', 'Plan'] };
  check('a draft with no heading for one says which', handOffMissing('**Context**\nThe tokens expire.', arch) === 'missing: Plan', String(handOffMissing('**Context**\nThe tokens expire.', arch)));
  check('and names every one, in order', handOffMissing('Use JWT.', arch) === 'missing: Context, Plan');
  check('one with them all, an empty one, or an agent with no headings says nothing', handOffMissing('## Context\nx\n## Plan\ny', arch) === null && handOffMissing('  ', arch) === null && handOffMissing('Use JWT.', {}) === null);

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
  check('the box shows what is missing, only when it can be sent, and missing it does not stop the send', /const missing = handOffMissing\(summary, agent\);/.test(box) && /problem === null && missing !== null && <span className="atn-handoff-missing">\{missing\}<\/span>/.test(box) && !/disabled=\{[^}]*missing/.test(box) && /\.atn-handoff-missing \{[^}]*var\(--need\)/.test(css));
  check('it cannot send what the daemon would refuse', /disabled=\{busy \|\| problem !== null\}/.test(box) && /if \(problem !== null\) return;/.test(box));
  check('it sends the text in the box, trimmed, to the hand-off call', /handOff\(agent, summary\)/.test(box) && /summary: summary\.trim\(\)/.test(api) && /agentPath\(agentId, 'hand-off'\)/.test(ep));
  check('the reply box sends an ordinary message to the agent', /sendMessage\(agent\.id, \{ text \}\)/.test(box) && /placeholder="It works again/.test(box));
  check('a refusal stays on the card, with its reason: the box goes through useCommand and nothing removes the card', /cmd\.run\('Handing off'/.test(box) && !/dismissAlert/.test(box));
  check('both themes read: the boxes use the card’s own textarea and tokens, and no colour of their own', !/#[0-9a-fA-F]{3,8}\b|style=|rgb\(/.test(box) && /className="atn-ta"/.test(box));
  const rules = css.slice(css.indexOf('.atn-handoff {'), css.indexOf('.atn-ta {'));
  check('and its CSS is tokens only', rules.length > 100 && !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(rules) && /var\(--ink3\)/.test(rules) && /var\(--fail\)/.test(rules));
  check('the transcript names both ends of it', HANDOFF_BY_USER_NOTE === 'handed off by you' && /HANDOFF_HELD_NOTE/.test(readFileSync(new URL('../agent/transcript.tsx', import.meta.url), 'utf8')));
}

console.log('\n7 · "not handed off", on Fleet’s card and the Project lane (Amendment 120)');
{
  const ag = (id: string, role: string, over: Partial<Agent> = {}): Agent => ({
    id,
    jobId: 'j1',
    projectId: 'p1',
    role,
    model: 'opus',
    sdkSessionId: `s_${id}`,
    status: 'done',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const held: Alert = { id: 'handoff_held:a1:12', kind: 'handoff_held', cause: HANDOFF_HELD_NOTE, projectId: 'p1', jobId: 'j1', agentIds: ['a1'], since: '2026-10-08T12:00:00Z' };
  const arch = ag('a1', 'architect', { handoffHeld: true });
  const dev = ag('a2', 'developer', { status: 'queued', sdkSessionId: null, dependsOn: ['a1'] });
  const scr = ag('a3', 'scribe', { status: 'queued', sdkSessionId: null, dependsOn: ['a1', 'a2'] });

  const chip = handOffChip(arch, [arch, dev, scr], [held]);
  check('a held agent with agents waiting has a chip that says it is not handed off', chip?.label === 'not handed off', JSON.stringify(chip));
  check('it names who has not started, and says where pressing it goes', /architect stopped without handing off, so developer and scribe haven't started\. Open its card in Needs You/.test(chip?.title ?? ''), chip?.title);
  check('pressing it lands on that agent’s card in Needs You, by its alert', chip?.alertId === 'handoff_held:a1:12' && chip.action === 'hand off in Needs You');
  check('one waiting is named alone, and is "hasn’t"', /so developer hasn't started/.test(handOffChip(arch, [arch, dev], [held])?.title ?? ''));
  const putAway = handOffChip(arch, [arch, dev], []);
  check('when its card was put away it goes to the agent instead, where a reply works it again', putAway?.alertId === null && putAway.action === 'open the agent' && /put away/.test(putAway.title) && /reply/.test(putAway.title), JSON.stringify(putAway));
  check('another agent’s card is not its card', handOffChip(arch, [arch, dev], [{ ...held, id: 'handoff_held:a9:3', agentIds: ['a9'] }])?.alertId === null);
  check('an agent that is not held has no chip', handOffChip({ ...arch, handoffHeld: undefined }, [arch, dev], [held]) === null && handOffChip(dev, [arch, dev], []) === null);
  check('nor one that is held but not done: a hold is only a hold while it is done', handOffChip({ ...arch, status: 'working' }, [arch, dev], [held]) === null);
  check('nor one with nobody left waiting for it, as Needs You clears its card then too', handOffChip(arch, [arch, { ...dev, status: 'working' }], [held]) === null && handOffChip(arch, [arch], [held]) === null);

  // The wiring, as source checks: the card and the lane are not rendered in Node.
  const src = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');
  const chipSrc = src('../fleet/HandOffChip.tsx');
  const chipCss = src('../fleet/handoffchip.css');
  const cardSrc = src('../fleet/card.tsx');
  const laneSrc = src('../fleet/lane.tsx');
  const navSrc = src('../shell/nav.ts');
  check('Fleet’s agent row and the Project lane both show it', /<HandOffChip agent=\{agent\} siblings=\{siblings\} \/>/.test(cardSrc) && /<HandOffChip agent=\{agent\} siblings=\{siblings\} \/>/.test(laneSrc));
  check('it sits beside the row, not inside it: a button does not nest in a button', cardSrc.indexOf('</button>') < cardSrc.indexOf('<HandOffChip') && /<>\s*<button/.test(cardSrc));
  check('pressing it does not also open the card or the lane it is on: clicks and keys stop here', /e\.stopPropagation\(\);/.test(chipSrc) && /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(chipSrc));
  check('it goes to the alert’s card, else to the agent, through the named destinations', /openAlert\(chip\.alertId\)/.test(chipSrc) && /openAgent\(agent\)/.test(chipSrc) && /export function openAlert\(alertId: string\): void \{\s*navigate\(SCREEN\.attention, \{ alertId \}\);/.test(navSrc));
  check('openAttention is as it was: the top bar passes it as a click handler', /export function openAttention\(\): void \{\s*navigate\(SCREEN\.attention\);/.test(navSrc));
  check('what it says and when it is there is the pure function, asked of the store’s alerts', /handOffChip\(agent, siblings, useAlerts\(\)\)/.test(chipSrc));
  check('both themes read: tokens only, amber like every waiting-for-you state', !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(chipCss) && /var\(--need\)/.test(chipCss) && /color-mix\(in srgb, var\(--need\)/.test(chipCss) && !/style=/.test(chipSrc));
}

// Amendment 123. An agent whose run ended because the model couldn't be reached waits to be tried
// again; the card says when, and offers to try now or to give up.
console.log('\n8 · an agent waiting to be tried again (Amendment 123)');
{
  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'a1',
    jobId: 'j1',
    projectId: 'p1',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'queued',
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
  const waiting: Alert = {
    id: 'reconnecting:a1:1',
    kind: 'reconnecting',
    cause: 'unreachable',
    projectId: 'p1',
    jobId: 'j1',
    agentIds: ['a1'],
    since: '2026-10-10T12:00:00Z',
    attempt: 3,
    maxRetries: 5,
    retryAt: '2026-10-10T12:00:30Z',
  };
  const ids = (xs: AlertAction[]) => xs.map((a) => a.id).join(' ');
  const acts = alertActions(waiting, [agent()]);
  check('the card offers retry now first, then stop retrying, then the agent', ids(acts) === 'retry_now stop_retrying open', ids(acts));
  check('both are for the agent the card is about', acts.slice(0, 2).every((a) => 'agentId' in a && a.agentId === 'a1'));
  check('it is not put away: it describes the present and clears when the try starts', !ids(acts).includes('dismiss'));
  check('a card for an agent this tab has not heard of can only be put away', ids(alertActions(waiting, [])) === 'dismiss');
  const n = alertNotice(waiting, [agent()], [{ id: 'p1', name: 'demo' } as Project]);
  check('a notification says what is wrong and which retry', n.title === "demo · can't reach the model API" && n.body === 'retry 3 of 5 · builder', `${n.title} / ${n.body}`);

  // From the first retry (Amendment 140, Q3): the card is there, and chimes at once as any alert does.
  const firstTry: Alert = { ...waiting, id: 'reconnecting:a1:7', attempt: 1, retryAt: '2026-10-10T12:00:05Z' };
  check('the first retry\'s card chimes at once, as every alert does', dueForChime([], [firstTry], Date.parse('2026-10-10T12:00:00Z'), new Set()).join() === 'alert:reconnecting:a1:7');
  check('and only once for the bout: the second retry updates the same card, so it does not chime again', dueForChime([], [{ id: firstTry.id }], Date.parse('2026-10-10T12:00:06Z'), new Set(['alert:reconnecting:a1:7'])).length === 0);
  check('its notice says the first of five', alertNotice(firstTry, [agent()], [{ id: 'p1', name: 'demo' } as Project]).body === 'retry 1 of 5 · builder');

  // The wiring: source checks, since the card is not rendered in Node.
  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  const ep = readFileSync(new URL('../agent/endpoints.ts', import.meta.url), 'utf8');
  check('the card has a label and a tone for the kind', /reconnecting: \{ label: 'Reconnecting', tone: 'var\(--need\)' \}/.test(card));
  check('it counts down from the time the daemon will try, once a second and only then', /useNow\(alert\.kind === 'reconnecting'\)/.test(card) && /reconnectLine\(reconnect, now\)/.test(card) && /Date\.parse\(alert\.retryAt\)/.test(card));
  check('retry now is the fix, so it is the primary button', /a\.id === 'retry_now'/.test(card.slice(card.indexOf('function isFix'))));
  check('the buttons call the two routes, and a refusal stays on the card with its reason', /cmd\.run\('Retrying now', \(\) => retryNowAgent\(a\.agentId\)/.test(card) && /cmd\.run\('Stopping the retries', \(\) => stopRetryingAgent\(a\.agentId\)/.test(card) && !/case 'retry_now':[^}]*dismissAlert/.test(card));
  check('the calls are POST /api/agents/:id/retry-now and /stop-retrying', /agentPath\(agentId, 'retry-now'\), \{ method: 'POST'/.test(ep) && /agentPath\(agentId, 'stop-retrying'\), \{ method: 'POST'/.test(ep));
  check('both themes read: the card adds no colour of its own', !/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(card));
}

console.log("\n9 · an agent's budget warns: the card for it, and the one that stops (Amendment 124)");
{
  const agent = (over: Partial<Agent> = {}): Agent => spendingToday({
    id: 'a1',
    jobId: 'j1',
    projectId: 'p1',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'working',
    blockMode: null,
    costUsd: 6,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: 'al_over',
    kind: 'budget_over',
    cause: 'budget_over',
    projectId: 'p1',
    jobId: 'j1',
    agentIds: ['a1'],
    since: '2026-09-26T12:00:00Z',
    spent: 6,
    budget: 5,
    unit: 'usd',
    ...over,
  });
  const ids = (xs: AlertAction[]) =>
    xs.map((a) => (a.id === 'raise' ? `raise:${a.by}->${a.to}${a.unit ? a.unit : ''}${a.onlyRaise ? ' only' : ''}` : a.id)).join(' ');

  const over = alertActions(alert(), [agent()]);
  check('over its budget, the card raises it by $10 or $25 and does nothing else to the agent', ids(over) === 'raise:10->15 only raise:25->30 only open dismiss', ids(over));
  check('a raise from the warning only raises: there is nothing paused to continue', over.every((a) => a.id !== 'continue' && (a.id !== 'raise' || a.onlyRaise === true)));
  check('the raise starts from the budget, not the spend', over[0]?.id === 'raise' && over[0].to === 15);
  const tokenAgent = agent({ costUsd: 0, inputTokens: 400_000, outputTokens: 150_000, autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, budgetTokens: 500_000 } });
  const tokens = ids(alertActions(alert({ unit: 'tokens', spent: 550_000, budget: 500_000 }), [tokenAgent]));
  check('a token budget raises in tokens: +100k and +500k', tokens === 'raise:100000->600000tokens only raise:500000->1000000tokens only open dismiss', tokens);
  const twice = ids(alertActions(alert({ spent: 10 }), [agent({ costUsd: 10, spentToday: { day: localDayOf(), usd: 10, tokens: 0 } })]));
  check('at twice its budget the warning still only raises: there is no ceiling past which it stops (Amendment 180)', twice === 'raise:10->15 only raise:25->30 only open dismiss', twice);
  check('an agent this tab has not heard of can only be put away', ids(alertActions(alert(), [])) === 'dismiss');

  // A job's warning has no agent of its own: it raises the one still spending that has spent the most.
  const jobAlert = alert({ cause: 'job_budget_over', agentIds: [], spent: 52, budget: 50 });
  const team = [
    agent({ id: 'a1', role: 'architect', status: 'done', costUsd: 40 }),
    agent({ id: 'a2', role: 'developer', status: 'working', costUsd: 9 }),
    agent({ id: 'a3', role: 'reviewer', status: 'working', costUsd: 3 }),
    agent({ id: 'a4', role: 'tester', jobId: 'other', status: 'working', costUsd: 99 }),
  ];
  check("a job's warning raises the working agent that has spent the most, in that job", jobRaiseTarget('j1', team)?.id === 'a2');
  check('with none working, the one that spent the most', jobRaiseTarget('j1', team.filter((a) => a.status === 'done'))?.id === 'a1');
  check('with none that has a dollar budget, none', jobRaiseTarget('j1', [tokenAgent]) === null);
  const jobActions = alertActions(jobAlert, team);
  check('and names it, since the card is about the job', jobActions.at(-2)?.id === 'open' && (jobActions.at(-2) as { role?: string }).role === 'developer' && jobActions[0]?.id === 'raise' && jobActions[0].agentId === 'a2', ids(jobActions));

  // An agent the old ceiling paused (kind 'budget') only continues, in either unit (Amendment 180).
  const stopped = alert({ kind: 'budget', cause: 'budget_exhausted' });
  check('paused at twice a token budget, it continues with no raise', ids(alertActions(stopped, [{ ...tokenAgent, status: 'paused', inputTokens: 600_000, outputTokens: 400_000, spentToday: { day: localDayOf(), usd: 0, tokens: 1_000_000 } }])) === 'continue open dismiss');
  check('and so does one paused between the budget and twice it', ids(alertActions(stopped, [agent({ status: 'paused', costUsd: 7 })])) === 'continue open dismiss');

  const projects: Project[] = [{ id: 'p1', name: 'demo' } as Project];
  const note = alertNotice(alert(), [agent()], projects);
  check('the notification says over budget, not that it needs you', note.title === 'demo · builder is over its daily budget' && note.body === 'builder is over its $5 daily budget — a warning only', JSON.stringify(note));

  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('./alerts.ts', import.meta.url), 'utf8');
  check('the card has a label for the kind, in amber like a stop', /budget_over: \{ label: 'Over its daily budget', tone: 'var\(--need\)' \}/.test(card));
  check('a raise that only raises does not continue; one that continues still does', /if \(a\.onlyRaise\) void cmd\.run\('Raising the budget', \(\) => raiseBudget\(agent, a\.to, a\.unit\)/.test(card) && /raiseAndContinue\(agent, a\.to, a\.unit\)/.test(card));
  check('a token raise sends budgetTokens, a dollar one budgetUsd', /unit === 'tokens' \? \{ budgetTokens: to \} : \{ budgetUsd: to \}/.test(api));
  check('the card says it is only a warning, however far past it goes, and names no ceiling (Amendment 180)', /A warning only:/.test(card) && /however far past/.test(card) && !/ceilingWords|ceilingOf|k="stops at"/.test(card));
}

console.log("\n10 · a budget is per day: the cards, and what a new day changes (Amendment 129)");
{
  const day = localDayOf();
  const before = localDayOf(new Date(Date.now() - 86_400_000));
  const mk = (id: string, over: Partial<Agent> = {}): Agent => ({
    id,
    jobId: 'j1',
    projectId: 'p1',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'paused',
    blockMode: null,
    costUsd: 55,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 25 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const stop = (): Alert => ({
    id: 'al_stop',
    kind: 'budget',
    cause: 'budget_exhausted',
    projectId: 'p1',
    jobId: 'j1',
    agentIds: ['a1'],
    since: new Date().toISOString(),
  });
  const ids = (as: readonly AlertAction[]): string => as.map((a) => (a.id === 'raise' ? `raise:${a.by}->${a.to}` : a.id === 'continue' ? `continue` : a.id)).join(' ');

  // Paused by the old ceiling: today, the next morning, with nothing spent: each only continues (Amendment 180).
  const atCeiling = mk('a1', { spentToday: { day, usd: 55, tokens: 0 } });
  check('at more than twice its budget today, the card still only continues', ids(alertActions(stop(), [atCeiling])) === 'continue open dismiss', ids(alertActions(stop(), [atCeiling])));
  const nextDay = mk('a1', { spentToday: { day: before, usd: 55, tokens: 0 } });
  check('and so does one that still has yesterday\'s stamp', ids(alertActions(stop(), [nextDay])) === 'continue open dismiss');
  check('and one with nothing spent on the new day', ids(alertActions(stop(), [mk('a1', { spentToday: { day, usd: 0, tokens: 0 } })])) === 'continue open dismiss');
  const paused = alertNotice(stop(), [atCeiling], [{ id: 'p1', name: 'demo' } as Project]);
  check('the notification says continue carries on, not that it needs a raise or a renewal', paused.title === 'demo · builder needs you' && paused.body === 'builder was paused by its $25 daily budget, which only warns now — continue carries on', JSON.stringify(paused));

  // The job's warning raises the agent that spent the most TODAY, not the one with the largest lifetime figure.
  const team = [
    mk('t1', { status: 'working', costUsd: 400, spentToday: { day, usd: 2, tokens: 0 } }),
    mk('t2', { status: 'working', costUsd: 9, spentToday: { day, usd: 9, tokens: 0 } }),
    mk('t3', { status: 'working', costUsd: 900, spentToday: { day: before, usd: 900, tokens: 0 } }),
  ];
  check("a job's warning raises the agent that spent the most today: a bigger lifetime figure, or yesterday's, does not count", jobRaiseTarget('j1', team)?.id === 't2', jobRaiseTarget('j1', team)?.id);

  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  const alerts = readFileSync(new URL('./alerts.ts', import.meta.url), 'utf8');
  check('the card of an old pause says continue carries it on, with nothing renewed and nothing continuing by itself', /alert\.kind === 'budget' && \(/.test(card) && /continue carries it on/.test(card) && /Nothing continues it by itself/.test(card) && !/renewed|continue at midnight/.test(card + alerts));
  check('the warning\'s notification says daily', /is over its daily budget/.test(alerts));
  check('nothing here compares the lifetime figure with a budget', !/costUsd\s*>=?\s*\w*(cap|budget)/i.test(alerts + card));
}

console.log('\n11 · a job finished: merge it, merge and clean up, or open Branches (Amendment 144)');
{
  const finished: Alert = {
    id: 'finished:7',
    kind: 'finished',
    cause: 'finished',
    projectId: 'p1',
    jobId: 'job_x',
    agentIds: ['a1'],
    since: '2026-10-13T12:00:00Z',
    branch: 'conductor/job_x',
    into: 'main',
    ahead: 2,
  };
  const acts = alertActions(finished, []);
  check(
    'the card offers merge and clean up first, then merge, open Branches and dismiss',
    acts.map((a) => a.id).join(' ') === 'merge_clean merge branches dismiss',
    acts.map((a) => a.id).join(' '),
  );
  const clean = acts[0] as Extract<AlertAction, { id: 'merge_clean' }>;
  check('they carry the project, the branch, where it goes and the job', clean.projectId === 'p1' && clean.branch === 'conductor/job_x' && clean.into === 'main' && clean.jobId === 'job_x');
  check(
    "the confirm says what goes, and that its agents can't be messaged afterwards, transcripts kept",
    finishedConfirm(clean) === "Merge conductor/job_x into main, then remove job job_x, its folder and its branch? Its agents can't be messaged afterwards; their transcripts stay.",
    finishedConfirm(clean),
  );
  check('a card with no branch on it offers only Branches and dismiss', alertActions({ ...finished, branch: undefined }, []).map((a) => a.id).join(' ') === 'branches dismiss');
  const merged: Alert = { ...finished, id: 'merged:8', kind: 'merged', cause: 'merged and cleaned up', agentIds: [], sha: 'abcdef1234', cleaned: true };
  check('the information card offers Branches and dismiss', alertActions(merged, []).map((a) => a.id).join(' ') === 'branches dismiss');
  check('the titles read as the card does', alertTitle(finished, []).head === 'Finished: merge into' && alertTitle(finished, []).subject === 'main?' && alertTitle(merged, []).subject === 'was merged into main and cleaned up');
  check('and the top bar has a word for each', alertWord(finished) === 'finished: merge?' && alertWord(merged) === 'merged');

  // The calls behind the buttons, against a stand-in daemon that records them.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let preview: Record<string, unknown> = { branch: 'conductor/job_x', into: 'main', ahead: 2, behind: 0, commits: [], conflicts: [], reason: null };
  let deleteRefuses = false;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push(`${init?.method ?? 'GET'} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (url.includes('/branches/preview')) return new Response(JSON.stringify(preview), { status: 200 });
    if (body?.['action'] === 'merge') return new Response(JSON.stringify({ ok: true, merged: ['conductor/job_x'], into: 'main', sha: 'feedface00', branches: {} }), { status: 200 });
    if (body?.['action'] === 'delete') {
      return deleteRefuses
        ? new Response(JSON.stringify({ error: "job job_x's agents can still be messaged" }), { status: 409 })
        : new Response(JSON.stringify({ ok: true, merged: [], removed: ['conductor/job_x'], forgotJobs: ['job_x'], branches: {} }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const sha = await mergeFinished(clean);
  check('merge: the preview first, then the Branches merge into main, nothing else', sha === 'feedface00' && calls.length === 2 && /^GET \/api\/projects\/p1\/branches\/preview\?branch=conductor%2Fjob_x&into=main$/.test(calls[0]!) && calls[1] === 'POST /api/projects/p1/branches {"action":"merge","branch":"conductor/job_x","into":"main"}', calls.join(' | '));
  calls.length = 0;
  await mergeAndClean(clean);
  check('merge and clean up: the preview, the merge, then delete with forgetJob', calls.length === 3 && calls[2] === 'POST /api/projects/p1/branches {"action":"delete","branch":"conductor/job_x","forgetJob":true}', calls.join(' | '));
  calls.length = 0;
  preview = { ...preview, conflicts: ['c.txt'] };
  const refused = await mergeAndClean(clean).then(() => null, (e: Error) => e.message);
  check('a conflict in the preview merges and removes nothing, naming the file', refused === 'it would conflict with main in c.txt — merge it by hand' && calls.length === 1, `${refused} ${calls.join(' | ')}`);
  calls.length = 0;
  preview = { ...preview, conflicts: [], reason: "main's checkout has changes — commit or discard the tracked changes in /r first" };
  const said = await mergeFinished(clean).then(() => null, (e: Error) => e.message);
  check("the preview's reason is the refusal, word for word", said === "main's checkout has changes — commit or discard the tracked changes in /r first" && calls.length === 1, said ?? '');
  calls.length = 0;
  preview = { ...preview, reason: null };
  deleteRefuses = true;
  const half = await mergeAndClean(clean).then(() => null, (e: Error) => e.message);
  check('a refused clean-up says the merge went in, and why not the rest', half !== null && half === "merged as feedfac, but not cleaned up: job job_x's agents can still be messaged", half ?? '');
  globalThis.fetch = realFetch;

  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  check('merge and clean up asks first, with the confirm', /case 'merge_clean':\s*setConfirmClean\(a\)/.test(card) && /finishedConfirm\(confirmClean\)/.test(card));
  check('the card dismisses itself after a merge', /await mergeFinished\(a\);\s*await dismissAlert\(alert\.id\)/.test(card));
  check('open Branches goes to the project’s Branches screen', /case 'branches':\s*openBranches\(a\.projectId\)/.test(card));
  check('the labels', /return 'merge and clean up'/.test(card) && /return 'open Branches'/.test(card) && /finished: \{ label: 'Finished'/.test(card));
}

console.log('\n12 · the sound plays after a reload too, once you click or type (Amendment 172)');
{
  const notify = readFileSync(new URL('./notify.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('./QueuePanel.tsx', import.meta.url), 'utf8');
  check('on, but this page load has had no click yet: the pill says so instead of when it fires', soundHint(true, false, 'at 1m 0s') === 'click anywhere to allow sound');
  check('once allowed, or switched off, the pill says when it fires, as before', soundHint(true, true, 'at 1m 0s') === 'at 1m 0s' && soundHint(false, false, 'at 1m 0s') === 'at 1m 0s');
  check('the always-on mount arms it on the first click or key when the sound is already on', /if \(soundEnabled\) armOnFirstGesture\(\);/.test(notify) && /addEventListener\('pointerdown', arm, true\)/.test(notify) && /addEventListener\('keydown', arm, true\)/.test(notify));
  check('that gesture makes and resumes the audio, once, and lets go of the listeners', /removeEventListener\('pointerdown', arm, true\)/.test(notify) && /armAudio\(\);\s*void audioCtx\?\.resume\(\)/.test(notify));
  check('switching it on resumes the audio there and then too', /armAudio\(\);\s*void audioCtx\?\.resume\(\)\.catch\(\(\) => undefined\);\s*patch\(\{ soundArmed/.test(notify));
  check('the Needs You panel shows the sound pill through soundHint', /soundHint\(ladderPrefs\.soundEnabled, ladderPrefs\.soundArmed, channelHint\(c, oldestMs\)\)/.test(panel));
}

console.log(
  failures === 0
    ? '\nTrack E verify: PASS — waits, tool calls and answers read as they should.\n'
    : `\nTrack E verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
