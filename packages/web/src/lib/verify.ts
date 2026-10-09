/**
 * W0 web-side verify — the store reducer.
 *
 * W0 OWNS THIS FILE.
 *   pnpm --filter @conductor/web verify
 *
 * This exists because Amendment 7 fixed two bugs that had no test to catch them,
 * and both were the silent kind:
 *
 *   • duplicate delivery doubled useSparkline() and useJobDiffstat()
 *   • arrays were mutated in place, so useMemo(..., [events]) froze forever
 *
 * Neither breaks a build. Neither throws. Both just quietly produce wrong
 * numbers or a list that stops updating, in a layer four tracks depend on. The
 * daemon smoke test could never have seen them.
 *
 * The reducer is exercised directly — no DOM, no React render. `store.apply()`
 * is pure, so this is fast and has no jsdom dependency.
 */

import type { Agent, Alert, Event, EventPayload, Job, ServerFrame, Snapshot } from '@conductor/shared';
import { diffstat, resolveFileEdits, sparkline } from '@conductor/shared';
import { store } from './store.js';
import { ApiError, errorText, explain } from './errors.js';
import { api } from './feed.js';
import { readFileSync } from 'node:fs';
import { nextChoice, parseChoice, resolveTheme } from '../shell/theme.js';
import { TREE_DEFAULT, TREE_MIN, storedTreeWidth, treeWidth } from '../files/width.js';
import {
  AGENT_INSPECTOR,
  PREVIEW_DOCK,
  PROJECT_COLUMN,
  PROJECT_DOCK,
  QUEUE_PANEL,
  panelMax,
  panelSize,
  storedPanel,
  type Panel,
} from '../shell/panels.js';
import {
  alertTitle,
  alertWord,
  currentAction,
  failureSentence,
  projectNeeds,
  retryHead,
  retryTail,
  retryingNow,
} from '../shell/describe.js';
import { confirmLine, doneLine, fmtBytes, storageLine } from '../diagnostics/storage.js';
import { behindLine, buildTag, buildTitle, fmtWhen, type Build } from '../diagnostics/build.js';
import { catalogLine, modelGroups, modelProblem, resolveTier, shortModel } from './models.js';
import type { ModelCatalog } from '@conductor/shared';
import { screenForKey, tabbed } from './screens.js';
import { addReferenced, addedLine, nameFrom, tidyPath } from '../fleet/addproject.js';
import { DECLINE_NOTE, bannerLine, bringLine, homeish, questionLines } from '../settings/storage.js';
import { importable, mergeIncoming } from './settings.js';
import { SLOTS_DEFAULT, SLOTS_KEY, SLOTS_MAX, slotsProblem } from '../settings/slots.js';
import { readDraft, writeDraft } from './drafts.js';
import { copyText } from './clipboard.js';
import { SEEN_KEY, isFinished, markSeen, parseSeen, seenOnAgent, serializeSeen, startSeen, unseenFinished } from './seen.js';
import { SEEN_AGENTS_KEY, markAgentsSeen, parseSeenAgents, serializeSeenAgents, unseenDoneAgents } from './seen.js';
import { REVOKE_NOTE, copyLine, ruleOrigin, ruleTitle } from '../settings/rules.js';
import { nestHelpers } from '../fleet/nest.js';
import { SORTS, applyOrder, fleetSort, moveBefore, moveBy, parseOrder, sortProjects, type SortFacts } from '../fleet/order.js';
import { cardNote, dueLabel, dueState, localDate, noteAge, noteCount, wasEdited } from '../fleet/notewords.js';
import { budgetProblem, dailyMeter, parseBudget } from '../shell/spend.js';
import { readdirSync, statSync } from 'node:fs';
import type { StorageState } from '@conductor/shared';
import { keyLine, keyStateFrom, loginLine, providerLabel, readCopilotLogin, readKeyState, saveKey } from './providers.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const P = 'prj_v';
const J = 'job_v';
const A = 'agt_v';

let seq = 0;
function ev(payload: EventPayload, tsMs = Date.now()): Event {
  seq += 1;
  return {
    seq,
    ts: new Date(tsMs).toISOString(),
    projectId: P,
    jobId: J,
    agentId: A,
    payload,
  };
}

function toolStart(i: number, tsMs = Date.now()): Event {
  return ev(
    {
      kind: 'tool_start',
      toolUseId: `tu_${i}`,
      tool: 'Read',
      input: { file_path: `f${i}.ts` },
      label: `Read f${i}.ts`,
    },
    tsMs,
  );
}

function send(frame: ServerFrame): void {
  store.apply(frame);
}

const job: Job = {
  id: J,
  projectId: P,
  prompt: 'verify',
  isolation: 'worktree',
  worktreePath: '/tmp/job_v',
  branch: 'main',
  status: 'working',
  createdAt: new Date().toISOString(),
  endedAt: null,
  budgetUsd: null,
};

const snapshot: Snapshot = {
  projects: [{ id: P, name: 'verify', path: '/tmp/v', defaultBranch: 'main', createdAt: '' }],
  jobs: [job],
  agents: [],
  pending: [],
  servers: [],
  alerts: [],
  seq: 0,
  slots: { used: 0, total: 7 },
  costToday: 0,
};

console.log('\n1 · baseline');
send({ type: 'hello', seq: 0, snapshot });
check('snapshot applied', store.select('t', (s) => s.jobs.length) === 1);

console.log('\n2 · idempotence on seq (Amendment 7)');
const batch = [toolStart(1), toolStart(2), toolStart(3)];
send({ type: 'events', events: batch });
const afterFirst = store.select('e1', (s) => s.eventsByAgent.get(A)?.length ?? 0);
check('3 events applied', afterFirst === 3, `got ${afterFirst}`);

// The exact failure mode: StrictMode ran the effect twice, so the same frame
// arrived twice and every count doubled.
send({ type: 'events', events: batch });
const afterReplay = store.select('e2', (s) => s.eventsByAgent.get(A)?.length ?? 0);
check(
  'replayed frame does NOT double the count',
  afterReplay === 3,
  `got ${afterReplay} — duplicate delivery is being applied`,
);

const spark = store.select('sp', (s) => sparkline(s.eventsByAgent.get(A) ?? []));
check(
  'sparkline not doubled',
  spark.reduce((a, b) => a + b, 0) === 3,
  `buckets sum to ${spark.reduce((a, b) => a + b, 0)}, expected 3`,
);

console.log('\n3 · array identity changes (Amendment 7)');
const before = store.select('id1', (s) => s.eventsByAgent.get(A));
send({ type: 'events', events: [toolStart(4)] });
const after = store.select('id2', (s) => s.eventsByAgent.get(A));
check(
  'array reference changes when an event is appended',
  before !== after,
  'same reference — useMemo(..., [events]) would never re-run',
);
check('and the new event is present', (after?.length ?? 0) === 4, `len ${after?.length}`);
check('previous array is left untouched', before?.length === 3, `len ${before?.length}`);

console.log('\n4 · diffstat is not doubled');
const fe: EventPayload = { kind: 'file_edit', path: 'src/a.ts', added: 10, removed: 2 };
const feEvent = ev(fe);
send({ type: 'events', events: [feEvent] });
send({ type: 'events', events: [feEvent] }); // duplicate
const ds = store.select('ds', (s) => diffstat(s.eventsByJob.get(J) ?? []));
check('added counted once', ds.added === 10, `got ${ds.added}`);
check('files counted once', ds.files === 1, `got ${ds.files}`);

console.log('\n4b · file_edit double-source resolution (Amendment 8)');
// Track A's PostToolUse knows the author but estimates counts; Track C's watcher
// knows the real counts but not the author. Summing both double-counted every
// write — a wrong number nobody questions because it looks plausible.
const DA = 'agt_dual';
send({
  type: 'events',
  events: [
    { ...ev({ kind: 'file_edit', path: 'src/dual.ts', added: 9, removed: 1, source: 'tool' }), agentId: DA },
    { ...ev({ kind: 'file_edit', path: 'src/dual.ts', added: 12, removed: 3, source: 'watcher' }), agentId: DA },
    // in_place / past-the-watcher-cap: only the estimate will ever arrive
    { ...ev({ kind: 'file_edit', path: 'src/estimate-only.ts', added: 5, removed: 0, source: 'tool' }), agentId: DA },
  ],
});
const dual = store.select('dual', (s) => diffstat(s.eventsByAgent.get(DA) ?? []));
check(
  'authoritative wins over the estimate for the same path',
  dual.added === 12 + 5 && dual.removed === 3,
  `+${dual.added} -${dual.removed}, expected +17 -3 (not +26 -4)`,
);
check('both paths still counted once each', dual.files === 2, `files ${dual.files}`);

console.log('\n4c · resolveFileEdits is the single implementation (Amendment 9)');
// Amendment 8 fixed diffstat() and stopped there. Anything walking file_edit
// payloads directly still double-counted — Track B had two such places, which
// would have shown roughly double the total sitting right beside it.
const resolved = store.select('rfe', (s) => resolveFileEdits(s.eventsByAgent.get(DA) ?? []));
const dualRow = resolved.get('src/dual.ts');
const estRow = resolved.get('src/estimate-only.ts');
check(
  'per-file row agrees with diffstat, not the naive sum',
  dualRow?.added === 12 && dualRow?.removed === 3,
  `+${dualRow?.added} -${dualRow?.removed}, expected +12 -3`,
);
check('and reports which source it counted', dualRow?.countedFrom === 'watcher', dualRow?.countedFrom);
check(
  'estimate is the fallback where no watcher will ever report',
  estRow?.added === 5 && estRow?.countedFrom === 'tool',
  `+${estRow?.added} from ${estRow?.countedFrom}`,
);
check(
  'attribution survives even when the watcher supplied the counts',
  dualRow?.agentId === DA,
  String(dualRow?.agentId),
);
const rowSum = [...resolved.values()].reduce((a, r) => a + r.added, 0);
check(
  'per-file rows sum to exactly the header total',
  rowSum === dual.added,
  `rows ${rowSum} vs diffstat ${dual.added}`,
);

console.log('\n5 · sparkline `now` seam (Amendment 7)');
// A recording made in the past falls outside the trailing wall-clock window and
// renders a busy agent as flat — the exact opposite of the truth.
//
// This uses its OWN agent id: the events from sections 2-4 were stamped at
// Date.now() and would otherwise fill the trailing window themselves, which is
// what made the first version of this check fail against correct code.
const OLD_A = 'agt_recorded';
const longAgo = Date.now() - 6 * 60 * 60 * 1000;
send({
  type: 'events',
  events: [
    { ...toolStart(90, longAgo), agentId: OLD_A },
    { ...toolStart(91, longAgo + 1000), agentId: OLD_A },
  ],
});
const wallClock = store.select('sp2', (s) => sparkline(s.eventsByAgent.get(OLD_A) ?? []));
const anchored = store.select('sp3', (s) =>
  sparkline(s.eventsByAgent.get(OLD_A) ?? [], longAgo + 2000),
);
check(
  'a recording is invisible in the wall-clock window (the trap)',
  wallClock.reduce((a, b) => a + b, 0) === 0,
  `sum ${wallClock.reduce((a, b) => a + b, 0)} — expected the old events to fall outside`,
);
check(
  'anchoring `now` to the recording surfaces them',
  anchored.reduce((a, b) => a + b, 0) === 2,
  `sum ${anchored.reduce((a, b) => a + b, 0)}`,
);

console.log('\n6 · status and usage folding');
send({
  type: 'entities',
  agents: [
    {
      id: A,
      jobId: J,
      projectId: P,
      role: 'builder',
      model: 'claude-opus-5',
      sdkSessionId: null,
      status: 'queued',
      blockMode: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dependsOn: [],
      autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: null },
      startedAt: null,
      endedAt: null,
    },
  ],
});
send({ type: 'events', events: [ev({ kind: 'status', status: 'blocked', blockMode: 'parked' })] });
const agent = store.select('ag', (s) => s.agents.find((a) => a.id === A));
check('status folded onto the agent', agent?.status === 'blocked', agent?.status);
check('blockMode folded', agent?.blockMode === 'parked', String(agent?.blockMode));

send({
  type: 'events',
  events: [ev({ kind: 'usage', costUsd: 0.42, inputTokens: 100, outputTokens: 20 })],
});
const agent2 = store.select('ag2', (s) => s.agents.find((a) => a.id === A));
check('usage folded', agent2?.costUsd === 0.42, String(agent2?.costUsd));

console.log('\n7 · a failed command reads as a sentence, not as a parsed string');
{
  const ours = (status: number, body: unknown) => new ApiError('DELETE', '/api/projects/p1', status, body);
  const e409 = ours(409, { error: 'builder is still running' });
  check('status is a field', e409.status === 409);
  check('the daemon sentence is a field', e409.daemonSays === 'builder is still running');
  check('the message still names the request', e409.message.startsWith('DELETE /api/projects/p1 → 409'));
  check('409 → warn with the daemon sentence', explain('Removing', e409).text === 'builder is still running');

  const gone = explain('Removing the project', ours(404, { error: 'no such project p1' }));
  check('404 with a reason → that reason', gone.text === 'Removing the project failed — no such project p1.', gone.text);

  const fastify404 = ours(404, {
    statusCode: 404,
    error: 'Not Found',
    message: 'Route DELETE:/api/projects/p1 not found',
  });
  check(
    "Fastify's route-not-found → not wired up, never 'failed — Not Found'",
    /isn't wired up yet/.test(explain('Removing', fastify404).text),
    explain('Removing', fastify404).text,
  );
  const invalid = ours(400, { statusCode: 400, error: 'Bad Request', message: 'body/path must be string' });
  check("Fastify's schema error → its message, not the reason phrase", invalid.daemonSays === 'body/path must be string');

  const guard = explain('Removing', ours(403, { error: 'refused: origin is not local' }));
  check('403 from the local-pages guard names the header', /origin is not local/.test(guard.text), guard.text);
  check('403 without a body → the token hint', /CONDUCTOR_TOKEN/.test(explain('Removing', ours(403, undefined)).text));
  check('5xx → fail tone', explain('Removing', ours(500, undefined)).tone === 'fail');
  check('no body → daemonSays is null, not "undefined"', ours(502, undefined).daemonSays === null);
  check('not JSON → message has no stray body', ours(502, undefined).message === 'DELETE /api/projects/p1 → 502');

  check('errorText prefers the daemon', errorText(ours(400, { error: 'path is not a git repository' })) === 'path is not a git repository');
  check('errorText on a network failure', /can't reach the daemon/.test(errorText(new TypeError('Failed to fetch'))));
  check('errorText on anything else', errorText(new Error('boom')) === 'boom');
}

console.log('\n8 · a fresh tab gets its history over HTTP (Amendment 27)');
{
  // The snapshot has entities and no events, so a reloaded tab showed an agent's
  // cost and an empty transcript. History now arrives separately, and it can
  // land before or after the live events it overlaps.
  const H = 'agt_hist';
  const HJ = 'job_hist';
  const mine = (e: Event): Event => ({ ...e, agentId: H, jobId: HJ });
  const agentA = store.select('hA', (s) => s.agents.find((a) => a.id === A))!;
  send({ type: 'entities', agents: [{ ...agentA, id: H, jobId: HJ, status: 'working' }] });

  const disk = [1, 2, 3, 4, 5].map((i) => mine(toolStart(200 + i)));
  const live1 = mine(toolStart(206));
  const live2 = mine(ev({ kind: 'status', status: 'blocked', blockMode: 'parked' }));
  const seqAt = (k: string) => store.select(k, (s) => s.seq);
  const hist = (k: string) => store.select(k, (s) => s.eventsByAgent.get(H) ?? []);

  send({ type: 'events', events: [live1] });
  const seqBefore = seqAt('hs1');
  store.applyHistory([...disk, live1, live2]); // fetched after both were written
  const merged = hist('hh1');
  check('history lands under live events', merged.length === 7, `len ${merged.length}`);
  check(
    'in seq order, not arrival order',
    merged.every((e, i) => i === 0 || merged[i - 1]!.seq < e.seq),
    merged.map((e) => e.seq).join(','),
  );
  check('history does not move the live seq gate', seqAt('hs2') === seqBefore, `${seqAt('hs2')} vs ${seqBefore}`);

  send({ type: 'events', events: [live2] }); // the feed now delivers what history already brought
  check('a live event history already brought is not doubled', hist('hh2').length === 7, `len ${hist('hh2').length}`);
  const hAgent = store.select('hA2', (s) => s.agents.find((a) => a.id === H));
  check('but it still folds onto the agent', hAgent?.status === 'blocked', hAgent?.status);

  const beforeAgain = hist('hh3');
  store.applyHistory([...disk, live1, live2]);
  check('the same history twice keeps the array reference', hist('hh4') === beforeAgain);
  const jobLen = store.select('hj', (s) => s.eventsByJob.get(HJ)?.length ?? 0);
  check('the job transcript gets the same events', jobLen === 7, `len ${jobLen}`);

  const gen = store.select('hg1', (s) => s.generation);
  send({ type: 'hello', seq: seqAt('hs3'), snapshot: { ...snapshot, seq: seqAt('hs3') } });
  check('each snapshot asks for history again', store.select('hg2', (s) => s.generation) === gen + 1);
  check('and keeps the transcript it has', hist('hh5').length === 7, `len ${hist('hh5').length}`);
}

console.log('\n9 · both themes are readable, measured from tokens.css');
{
  const css = readFileSync(new URL('../../../shared/src/tokens.css', import.meta.url), 'utf8');
  const block = (selector: string): Map<string, string> => {
    const at = css.indexOf(`${selector} {`);
    const body = at === -1 ? '' : css.slice(at, css.indexOf('}', at));
    return new Map([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
  };
  const dark = block(':root');
  const light = new Map([...dark, ...block(":root[data-theme='light'], [data-theme='light']")]);

  // WCAG 2.x relative luminance and contrast ratio.
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

  const TEXT = ['ink', 'ink2', 'ink3', 'live', 'need', 'fail', 'done', 'queue', 'idle', 'you'];
  const SURFACES = ['bg', 'bg2', 'surf', 'surf2', 'surf3', 'well'];
  // Buttons and badges that put --bg text on a status fill (.sp-go, .sh-alert-n, …).
  const FILLS = ['live', 'need', 'fail', 'done'];

  check('dark: every colour token parsed', TEXT.concat(SURFACES).every((t) => dark.has(t)), [...dark.keys()].join(' '));
  const lightOwn = block(":root[data-theme='light'], [data-theme='light']");
  const leaks = [...dark.keys()].filter((t) => !lightOwn.has(t));
  check('light overrides every dark colour — none leaks through', leaks.length === 0, leaks.join(', '));

  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    const low: string[] = [];
    for (const t of TEXT) {
      for (const b of SURFACES) {
        const r = ratio(theme.get(t)!, theme.get(b)!);
        if (r < 4.5) low.push(`--${t} on --${b} ${r.toFixed(2)}`);
      }
    }
    for (const f of FILLS) {
      const r = ratio(theme.get('bg')!, theme.get(f)!);
      if (r < 4.5) low.push(`--bg on --${f} ${r.toFixed(2)}`);
    }
    check(`${name}: every text token ≥ 4.5:1 on every surface, and --bg on every fill`, low.length === 0, low.join('; '));
    // The project / agent label's backdrop (Amendment 97): its text, and the "/" between.
    const onHere = ['ink', 'ink2', 'ink3'].filter((t) => ratio(theme.get(t)!, theme.get('here')!) < 4.5);
    check(`${name}: the project / agent label is ≥ 4.5:1 on its backdrop`, theme.has('here') && onHere.length === 0, onHere.join(', '));
  }

  // The filled `live`/`done` tags (Amendment 93): named on their own so a
  // regression in either reads as its own failure, not a line buried in the
  // generic fill loop above.
  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    for (const f of ['live', 'done'] as const) {
      const r = ratio(theme.get('bg')!, theme.get(f)!);
      check(`${name}: --bg on the filled --${f} tag ≥ 4.5:1`, r >= 4.5, r.toFixed(2));
    }
  }

  // The top bar's tabs (Amendment 95): every tab reads `--ink2` now, and the open
  // one `--ink`, over a tint of `--ink` mixed into `--bg2` — `shell.css`'s
  // `color-mix(in srgb, var(--ink) 7%, var(--bg2))` on `.sh-screens button.on`,
  // reproduced here the same way `color-mix(in srgb, A p%, B)` blends in sRGB.
  const mix95 = (a: string, b: string, pct: number): string => {
    const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return (
      '#' +
      ca.map((v, i) => Math.round(v * (pct / 100) + cb[i]! * (1 - pct / 100)).toString(16).padStart(2, '0')).join('')
    );
  };
  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    const tabBg = mix95(theme.get('ink')!, theme.get('bg2')!, 7);
    for (const t of ['ink', 'ink2'] as const) {
      const r = ratio(theme.get(t)!, tabBg);
      check(`${name}: --${t} on the open top-bar tab's tinted background ≥ 4.5:1`, r >= 4.5, r.toFixed(2));
    }
  }

  check('no stored choice follows the system', parseChoice(null) === 'system');
  check('a junk stored value follows the system', parseChoice('solarized') === 'system');
  check('system follows the OS either way', resolveTheme('system', true) === 'dark' && resolveTheme('system', false) === 'light');
  check('a pick beats the OS', resolveTheme('light', true) === 'light' && resolveTheme('dark', false) === 'dark');
  check(
    'the toggle reaches all three and comes back',
    nextChoice('system') === 'light' && nextChoice('light') === 'dark' && nextChoice('dark') === 'system',
  );
}

// The drawn width is re-fitted to the window every time, and the width you asked for
// is kept. Storing the fitted one instead would lose your width the first time you
// used a smaller window.
console.log('\n10 · the Files tree fits the window it is in (F17)');
{
  check('in range, a width is left alone', treeWidth(300, 1440) === 300);
  check('below the minimum it stops at the minimum', treeWidth(40, 1440) === TREE_MIN);
  check('above 60% of the window it stops there', treeWidth(2000, 1440) === 864, String(treeWidth(2000, 1440)));
  check(
    'a width kept from a big monitor shrinks on a laptop, and comes back',
    treeWidth(800, 1000) === 600 && treeWidth(800, 2000) === 800,
    `${treeWidth(800, 1000)}, ${treeWidth(800, 2000)}`,
  );
  check('in a tiny window the minimum still wins', treeWidth(300, 200) === TREE_MIN, String(treeWidth(300, 200)));
  check(
    'nothing stored, or junk, is the default width',
    [null, '', 'wide', '0', '-5', 'NaN'].every((raw) => storedTreeWidth(raw) === TREE_DEFAULT),
  );
  check('a stored width is read back as it was', storedTreeWidth('412') === 412);
}

// The same rule for the other panels that were a fixed size (Amendment 34): the size
// you asked for is kept, and what's drawn is that fitted to the window. Each starts at
// the size it had when it was fixed, so nobody's screen changes until they drag.
console.log('\n10b · the side panels and docks fit the window too (Amendment 34)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const panels: [string, Panel, string, string, string, string, 1 | -1][] = [
    ['the Agent inspector', AGENT_INSPECTOR, 'AGENT_INSPECTOR', '../agent/inspector.tsx', '../agent/agent.css', '.ag-insp', -1],
    ['the attention queue', QUEUE_PANEL, 'QUEUE_PANEL', '../attention/QueuePanel.tsx', '../attention/attention.css', '.atn-insp', -1],
    ['the projects column', PROJECT_COLUMN, 'PROJECT_COLUMN', '../fleet/project.tsx', '../fleet/fleet.css', '.pj-col', 1],
    ['the project dock', PROJECT_DOCK, 'PROJECT_DOCK', '../fleet/dock.tsx', '../fleet/fleet.css', '.pj-dock', -1],
    ['the preview dock', PREVIEW_DOCK, 'PREVIEW_DOCK', '../preview/Dock.tsx', '../preview/preview.css', '.pv-dock', -1],
  ];
  const tokens = src('../../../shared/src/tokens.css');

  for (const [name, p, id, tsx, css, selector, grow] of panels) {
    // A laptop window: 1280 wide, 800 tall.
    const room = p.axis === 'width' ? 1280 : 800;
    check(`${name} starts at the size it had`, panelSize(p, p.fallback, room) === p.fallback);
    check(`${name} stops at its minimum`, panelSize(p, 10, room) === p.min);
    check(
      `${name} leaves the main pane the larger share`,
      panelSize(p, 5000, room) === panelMax(p, room) && panelMax(p, room) <= room * 0.7,
      String(panelSize(p, 5000, room)),
    );
    check(
      `${name}: junk stored is the fallback, a size stored is read back`,
      [null, '', 'wide', '0', '-5', 'NaN'].every((raw) => storedPanel(p, raw) === p.fallback) &&
        storedPanel(p, '321') === 321,
    );

    const rule = ((): string => {
      const text = src(css);
      const i = text.indexOf(`${selector} {`);
      return i < 0 ? '' : text.slice(i, text.indexOf('}', i));
    })();
    const fixed = rule.match(new RegExp(`\\n\\s*${p.axis}:\\s*([^;]+);`))?.[1] ?? '';
    const drawn =
      fixed === 'var(--projcol)' ? tokens.match(/--projcol:\s*(\d+)px/)?.[1] : fixed.match(/^(\d+)px$/)?.[1];
    check(`${name}: the CSS size before a drag is the fallback`, Number(drawn) === p.fallback, fixed);
    check(`${name}: the Splitter draws its edge, so the panel doesn't draw another`, !/border-(left|right|top)/.test(rule));

    const code = src(tsx);
    const at = code.indexOf('<Splitter');
    check(
      `${name} is sized by its own panel, and drags the right way`,
      code.includes(`usePanel(${id})`) &&
        at >= 0 &&
        code.slice(at, code.indexOf('/>', at)).includes(`grow={${grow}}`),
    );
  }

  const keys = [...panels.map(([, p]) => p.key), 'conductor.filesTreeW', 'conductor.composerH'];
  check('each panel is kept under its own key', new Set(keys).size === keys.length);
}

// A stopped agent says why in words, and an outage says what to check, on every
// screen that shows it. A reason nobody wrote a sentence for is shown as itself.
console.log('\n11 · a stopped agent and an outage read as sentences (F10, F13, F19)');
{
  const who = (over: Partial<Agent> = {}): Agent => ({
    id: 'agt_s',
    jobId: J,
    projectId: P,
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status: 'working',
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
  const capped = (cap: number | null, cost: number) =>
    who({ costUsd: cost, autonomy: { ...who().autonomy, budgetUsd: cap } });

  check('a known reason has its sentence', failureSentence('max_turns') === 'ran out of turns');
  check(
    'an unknown reason is shown as itself, never guessed at',
    failureSentence('sdk_new_thing') === 'sdk_new_thing — see the transcript',
    failureSentence('sdk_new_thing'),
  );
  check('no reason at all points at the transcript', failureSentence(undefined) === 'ended with an error — see the transcript');
  check('at its cap, the budget names the cap', failureSentence('budget_exhausted', capped(5, 5)) === 'spent its $5 budget');
  check(
    'raised since it stopped, it says so instead of the old figure',
    failureSentence('budget_exhausted', capped(15, 5)) === 'stopped on its budget, now raised to $15',
    failureSentence('budget_exhausted', capped(15, 5)),
  );
  check('cents are kept', failureSentence('budget_exhausted', capped(0.01, 0.02)) === 'spent its $0.01 budget');
  check('no cap known, no figure', failureSentence('budget_exhausted') === 'reached its budget');

  const T = Date.parse('2026-09-26T12:00:00Z');
  const at = (payload: EventPayload, ms: number): Event => ({ ...ev(payload, ms), agentId: 'agt_s' });
  const retry = (attempt: number, cause: 'unreachable' | 'auth' | 'throttled' | 'server' = 'unreachable', ms = T) =>
    at({ kind: 'api_retry', attempt, maxRetries: 10, delayMs: 12_000, cause, httpStatus: null, error: 'x' }, ms);
  const said = at({ kind: 'text', text: 'hello' }, T + 1);
  check('a retry with nothing after it is current', retryingNow([said, retry(1, 'unreachable', T + 2)]) !== null);
  check('a reply after it ends it', retryingNow([retry(1), said]) === null);
  check(
    'so does a tool call',
    retryingNow([retry(1), at({ kind: 'tool_start', toolUseId: 't', tool: 'Read', input: {}, label: 'Read a' }, T + 1)]) === null,
  );
  check(
    'a usage report does not: it is not the model answering',
    retryingNow([retry(1), at({ kind: 'usage', costUsd: 0, inputTokens: 0, outputTokens: 0 }, T + 1)]) !== null,
  );
  check('unreachable, in words', retryHead({ cause: 'unreachable', httpStatus: null }) === "can't reach the model API");
  check('a server error names its status', retryHead({ cause: 'server', httpStatus: 529 }) === 'the model API answered 529');
  const tail = { payload: { attempt: 3, maxRetries: 10, delayMs: 12_000 }, ts: new Date(T).toISOString() };
  check('the countdown runs from the announcement', retryTail(tail, T + 2_000) === 'retry 3/10 in 10s', retryTail(tail, T + 2_000));
  check('and stops at now, not below zero', retryTail(tail, T + 60_000) === 'retry 3/10 now');
  check(
    'no cap known, no "/0"',
    retryTail({ ...tail, payload: { ...tail.payload, maxRetries: 0 } }, T) === 'retry 3 in 12s',
  );

  const working = who();
  const line = (events: Event[], agent = working) => currentAction(agent, events, [], [], T + 2_000);
  const first = line([retry(1)]);
  check("a working agent that can't reach the API says so", first.head === "can't reach the model API", first.head);
  check('with the countdown', first.subject === 'retry 1/10 in 10s', first.subject);
  check('one blip is not amber', first.tone === 'live', first.tone);
  check('the second attempt is: a person has to look', line([retry(2)]).tone === 'need', line([retry(2)]).tone);
  check('a busy API is waited out, never amber', line([retry(6, 'throttled')]).tone === 'live');
  check('a done agent keeps its last line, not an old retry', line([retry(2)], who({ status: 'done' })).head !== "can't reach the model API");
  const failed = line([at({ kind: 'status', status: 'failed', error: 'max_turns' }, T)], who({ status: 'failed' }));
  check(
    'a failed agent says why, and leaves the role to the row',
    failed.head === '' && failed.subject === 'ran out of turns' && failed.tone === 'fail',
    `${failed.head} ${failed.subject} (${failed.tone})`,
  );
  // Amendment 104: done, but it never said it was ready, so the agents after it wait.
  const heldLine = line([at({ kind: 'status', status: 'done', error: 'stopped without handing off' }, T)], who({ status: 'done' }));
  check(
    'a finished agent that stopped without handing off says so, in amber (Amendment 104)',
    heldLine.head === 'stopped' && heldLine.subject === 'without handing off' && heldLine.tone === 'need',
    `${heldLine.head} ${heldLine.subject} (${heldLine.tone})`,
  );
  const handed = line(
    [at({ kind: 'status', status: 'done', error: 'stopped without handing off' }, T), at({ kind: 'status', status: 'done', error: 'handed off by you' }, T + 1)],
    who({ status: 'done' }),
  );
  check('and once a person has handed off for it, it is only finished (Amendment 104)', handed.tone === 'done' && handed.head !== 'stopped', `${handed.head} (${handed.tone})`);
  check('a working agent is not marked by an old hold (Amendment 104)', line([at({ kind: 'status', status: 'done', error: 'stopped without handing off' }, T)], who({ status: 'working' })).head !== 'stopped');

  const alert = (over: Partial<Alert>): Alert => ({
    id: 'al_1',
    kind: 'failed',
    cause: 'max_turns',
    projectId: P,
    jobId: J,
    agentIds: ['agt_s'],
    since: new Date(T).toISOString(),
    ...over,
  });
  const reviewer = who({ id: 'agt_r', role: 'reviewer' });
  const t1 = alertTitle(alert({}), [working]);
  check('a failure alert reads like the agent line', `${t1.head} ${t1.subject}` === 'builder ran out of turns');
  const t2 = alertTitle(alert({ kind: 'budget', cause: 'budget_exhausted' }), [working]);
  check('a budget alert names the cap', t2.subject === 'spent its $5 budget', t2.subject);
  const t3 = alertTitle(
    alert({ kind: 'connection', cause: 'unreachable', agentIds: ['agt_s', 'agt_r'], attempt: 3, maxRetries: 10 }),
    [working, reviewer],
  );
  check('an outage counts its retries and names everyone', t3.subject === 'retry 3/10 · builder · reviewer', t3.subject);
  const t4 = alertTitle(alert({ kind: 'connection', cause: 'auth', gaveUp: true, attempt: 10 }), [working]);
  check(
    'one that gave up says so',
    t4.head === 'the model API refused the login' && t4.subject === 'gave up after 10 attempts · builder',
    `${t4.head} / ${t4.subject}`,
  );
  check('a dead server names its port', alertTitle(alert({ kind: 'server_down', port: 5173 }), []).head === 'dev server :5173');
  check('an agent this tab has not heard of is shown by id', alertTitle(alert({ agentIds: ['agt_gone'] }), []).head === 'agt_gone');

  check('top bar: failed', alertWord({ kind: 'failed', cause: 'x' }) === 'failed');
  check('top bar: budget', alertWord({ kind: 'budget', cause: 'budget_exhausted' }) === 'at its budget');
  check('top bar: server', alertWord({ kind: 'server_down', cause: 'x' }) === 'server down');
  check('top bar: login', alertWord({ kind: 'connection', cause: 'auth' }) === 'model API login');
  check('top bar: no answer', alertWord({ kind: 'connection', cause: 'unreachable' }) === 'no model API');
  check('top bar: gave up wins over the cause', alertWord({ kind: 'connection', cause: 'auth', gaveUp: true }) === 'model API gave up');

  const alertIds = () => store.select(`al${seq++}`, (s) => s.alerts.map((a) => a.id).join());
  send({ type: 'alerts', alerts: [alert({ id: 'al_a' }), alert({ id: 'al_b' })] });
  check('an alerts frame is applied', alertIds() === 'al_a,al_b', alertIds());
  send({ type: 'alerts', alerts: [alert({ id: 'al_b' })] });
  check('the next one replaces it — each frame is the whole list', alertIds() === 'al_b', alertIds());
  send({ type: 'alerts', alerts: [] });
  check('an empty one clears it', alertIds() === '');
  send({ type: 'hello', seq: 0, snapshot: { ...snapshot, alerts: [alert({ id: 'al_snap' })] } });
  check('a snapshot brings its alerts', alertIds() === 'al_snap', alertIds());
  const { alerts: _dropped, ...older } = snapshot;
  send({ type: 'hello', seq: 0, snapshot: older as Snapshot });
  check('a daemon from before Amendment 28 sends none, and that is an empty list', alertIds() === '', alertIds());

  // The dismiss route answers 204. Reading a body from it threw, so every dismiss said it failed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const empty = await api('/api/alerts/al_1/dismiss', { method: 'POST', body: {} }).then(
    () => 'ok',
    (e: unknown) => String(e),
  );
  globalThis.fetch = realFetch;
  check('a 204 is a success with nothing to read', empty === 'ok', empty);

  // F19. The top bar shrinks with the window; below ~1250px its text ran over the tabs.
  const shell = readFileSync(new URL('../shell/shell.css', import.meta.url), 'utf8');
  const rule = (selector: string): string => {
    const i = shell.indexOf(`${selector} {`);
    return i === -1 ? '' : shell.slice(i, shell.indexOf('}', i));
  };
  check('the top bar cuts what does not fit', /overflow:\s*hidden/.test(rule('.sh-alert')), rule('.sh-alert'));
  check('its label ends in an ellipsis rather than wrapping', /text-overflow:\s*ellipsis/.test(rule('.sh-alert > span')));
  check('the count never shrinks', /flex:\s*none/.test(rule('.sh-alert-n')));
  check(
    'the note goes by the room the bar has, not by the window',
    /container:\s*sh-alert\s*\/\s*inline-size/.test(rule('.sh-alert')) &&
      /@container sh-alert \([^)]*\)\s*\{\s*\.sh-alert > em\s*\{\s*display:\s*none/.test(shell),
  );
}

console.log('\n12 · the cleanup button says what it will do (Amendment 36)');
{
  const s = (orphaned: number) => ({ events: 1010, orphaned, bytes: 884_736, path: '/x/conductor.db' });
  check('the log reads as a count and a size', storageLine(s(0)).text.startsWith('1,010 events · 864 KB'), storageLine(s(0)).text);
  check('with nothing left over, there is nothing to clean', storageLine(s(0)).canClean === false);
  check('with some, the button is offered', storageLine(s(979)).canClean && storageLine(s(979)).text.includes('979 events'));
  check('one event is one event', storageLine(s(1)).text.includes(' 1 event from'), storageLine(s(1)).text);
  check(
    'the confirm says what stays',
    /Nothing you can still open/.test(confirmLine(s(979))) && /no file on disk/.test(confirmLine(s(979))),
  );
  check('and afterwards, what it did', doneLine(979) === 'Cleared 979 events.' && doneLine(0) === 'Nothing needed clearing.');
  check('sizes read in the unit that fits', fmtBytes(512) === '512 B' && fmtBytes(4_136_512) === '3.9 MB');
}

console.log('\n13 · build info reads as a tag, a date, and a warning when stale (Amendment 38)');
{
  const b = (over: Partial<Build> = {}): Build => ({
    version: '0.0.0',
    commit: '34e4579',
    branch: 'cleanup',
    committedAt: '2026-09-29T11:30:36-04:00',
    dirty: false,
    startedAt: '2026-09-29T15:31:00.000Z',
    node: 'v22.12.0',
    head: '34e4579',
    behind: false,
    ...over,
  });
  check('the tag is branch@commit', buildTag(b()) === 'cleanup@34e4579', buildTag(b()));
  check('uncommitted changes get a star', buildTag(b({ dirty: true })) === 'cleanup@34e4579*');
  check('a detached head is just the commit', buildTag(b({ branch: null })) === '34e4579');
  check('outside a checkout, the version', buildTag(b({ commit: null })) === 'v0.0.0');
  const when = fmtWhen('2026-09-29T11:30:36-04:00');
  check('the date has the year and a time', /^\d{1,2} Sep 2026 \d\d:\d\d$/.test(when), when);
  check('no date reads as a dash', fmtWhen(null) === '—' && fmtWhen('nope') === '—');
  check('the hover carries both dates', /made \d/.test(buildTitle(b())) && /daemon started \d/.test(buildTitle(b())), buildTitle(b()));
  check('up to date, no warning', !buildTitle(b()).includes('make restart'));
  const stale = b({ head: '9f00aa1', behind: true });
  check(
    'behind, it names both commits and the fix',
    behindLine(stale).includes('9f00aa1') && behindLine(stale).includes('34e4579') && buildTitle(stale).includes('make restart'),
    behindLine(stale),
  );
}

console.log('\n14 · models are exact ids, and a picker says when one is wrong (Amendment 40)');
{
  const cat: ModelCatalog = {
    models: [
      { id: 'us.anthropic.claude-opus-5-5[1m]', label: 'Opus 5.5 · 1M context', claude: true },
      { id: 'us.anthropic.claude-opus-5-5', label: 'Opus 5.5', claude: true },
      { id: 'us.anthropic.claude-sonnet-5', label: 'Sonnet 5', claude: true },
      { id: 'openai.gpt-5.5', label: 'openai.gpt-5.5', claude: false },
    ],
    tiers: { opus: 'us.anthropic.claude-opus-5-5', sonnet: 'us.anthropic.claude-sonnet-5' },
    source: 'gateway',
    host: 'api-ai-us.ssnc-corp.cloud',
    fetchedAt: '2026-09-29T12:00:00Z',
  };
  check('a Bedrock id loses its region and vendor', shortModel('us.anthropic.claude-opus-5-5') === 'opus-5-5', shortModel('us.anthropic.claude-opus-5-5'));
  check('a plain API id loses claude-', shortModel('claude-sonnet-5') === 'sonnet-5');
  check('the 1M window is said, not dropped', shortModel('us.anthropic.claude-opus-5-5[1m]') === 'opus-5-5 · 1M', shortModel('us.anthropic.claude-opus-5-5[1m]'));
  check('anything not Claude keeps its id', shortModel('openai.gpt-5.5') === 'openai.gpt-5.5' && shortModel('zai-org/GLM-OCR') === 'zai-org/GLM-OCR');

  check('a tier resolves through the catalog', resolveTier(cat, 'opus') === 'us.anthropic.claude-opus-5-5');
  check('an unserved tier resolves to nothing, not to its own name', resolveTier(cat, 'haiku') === null && resolveTier(null, 'opus') === null);

  check('a served exact id is not a problem', modelProblem(cat, 'us.anthropic.claude-sonnet-5') === null);
  const nick = modelProblem(cat, 'sonnet');
  check('a nickname is, and says what it means today', nick !== null && nick.includes('us.anthropic.claude-sonnet-5'), String(nick));
  const gone = modelProblem(cat, 'us.anthropic.claude-opus-5');
  check('a retired id is, naming the host', gone !== null && gone.includes('api-ai-us.ssnc-corp.cloud') && gone.includes('claude-opus-5'), String(gone));
  check(
    "Claude Code's list proves nothing is retired — no warning from it",
    modelProblem({ ...cat, source: 'claude-code' }, 'us.anthropic.claude-opus-5') === null,
  );
  check('no list, no warning either', modelProblem(null, 'us.anthropic.claude-opus-5') === null);

  const groups = modelGroups(cat);
  check('Claude is the first group', groups[0]?.label === 'Claude' && groups[0].models.length === 3, groups.map((g) => g.label).join(' | '));
  check('other models are grouped apart, with the warning', groups[1]?.models[0]?.id === 'openai.gpt-5.5' && /may not handle/.test(groups[1].label));
  check('an empty group is not shown', modelGroups({ ...cat, models: cat.models.filter((m) => m.claude) }).length === 1);
  check('the gateway list needs no caveat', catalogLine(cat) === null);
  check("Claude Code's list says it was not checked", /Not checked/.test(catalogLine({ ...cat, source: 'claude-code' }) ?? ''));
}

console.log('\n15 · a screen can be reached without having a tab (Amendment 42)');
{
  const defs = [
    { id: 'files', hotkey: '5', order: 50 },
    { id: 'fleet', hotkey: '1', order: 10 },
    { id: 'spawn', tab: false, order: 70 },
    // A made-up screen naming a hotkey no real screen has ('8'), to show tab: false wins over it.
    { id: 'old', hotkey: '8', tab: false, order: 80 },
  ];
  check('a screen with tab: false gets no nav chip', tabbed(defs).map((d) => d.id).join() === 'fleet,files', tabbed(defs).map((d) => d.id).join());
  check('the tabs come in nav order, whatever order they were found in', tabbed(defs)[0]?.id === 'fleet');
  check('a hotkey still opens its screen', screenForKey(defs, '5')?.id === 'files');
  check('and a screen without a tab has none, even if it names one', screenForKey(defs, '8') === undefined);
  check('a key no screen has opens nothing', screenForKey(defs, '9') === undefined);
  const spawnSrc = readFileSync(new URL('../spawn/route.tsx', import.meta.url), 'utf8');
  const def = spawnSrc.slice(spawnSrc.indexOf('export const screen'));
  check('Spawn is registered without a tab or a hotkey', /tab:\s*false/.test(def) && !/hotkey:/.test(def), def.slice(0, 200));
}

console.log('\n16 · the projects list marks what needs you, now the rail is gone (Amendment 43)');
{
  const pending = [{ projectId: 'a' }, { projectId: 'a' }, { projectId: 'b' }];
  const alerts = [{ projectId: 'a' }, { projectId: null }, { projectId: 'c' }];
  check('requests and alerts both count, for their own project only', projectNeeds('a', pending, alerts) === 3, String(projectNeeds('a', pending, alerts)));
  check('an alert alone marks a project with nothing pending', projectNeeds('c', pending, alerts) === 1);
  check('an alert with no project marks none of them', projectNeeds('d', pending, alerts) === 0);
  const shellSrc = readFileSync(new URL('../shell/shell.tsx', import.meta.url), 'utf8');
  check('the shell no longer draws a project rail', !/<ProjectRail|function ProjectRail|sh-rail/.test(shellSrc));
  // The Project screen's own list is gone (section 28); the navigator lists the projects
  // now and carries this rule (Amendment 66). The rule itself stays where both can use it.
  const describeSrc = readFileSync(new URL('../shell/describe.ts', import.meta.url), 'utf8');
  check('the rule is still one shared function, for whichever list draws the projects', /export function projectNeeds\(/.test(describeSrc));
}

console.log('\n17 · adding a project asks for its folders, on Fleet (Amendment 45)');
{
  check('a completed folder loses its trailing separator', tidyPath('~/src/app/ ') === '~/src/app' && tidyPath('/') === '/');
  check('an unnamed project is named after its main folder', nameFrom('/Users/me/src/web-app/') === 'web-app' && nameFrom('') === '');
  const one = addReferenced([], '~/src/lib/', '~/src/app');
  check('a referenced folder is added, tidied', JSON.stringify(one) === JSON.stringify({ list: ['~/src/lib'], why: null }), JSON.stringify(one));
  const same = addReferenced(one.list, '~/src/lib', '~/src/app');
  check('the same folder twice is refused, and says why', same.list === one.list && same.why === 'Already in the list.');
  const main = addReferenced(one.list, '~/src/app', '~/src/app/');
  check('so is the main folder, which is not also a referenced one', main.list === one.list && /main folder/.test(main.why ?? ''));
  check('a blank adds nothing and says nothing', addReferenced(one.list, '  ', 'x').list === one.list && addReferenced(one.list, '  ', 'x').why === null);
  check('the answer says what was added', addedLine('web', 2, false) === 'Added web, with 2 referenced folders.' && addedLine('web', 0, false) === 'Added web.');
  check('and, for a main folder already taken, that nothing was', /nothing was added/.test(addedLine('web', 0, true)));
  const spawnSrc = readFileSync(new URL('../spawn/route.tsx', import.meta.url), 'utf8');
  check("Spawn's where step no longer adds projects — it sends you to Fleet", !/'\/api\/projects',\s*\{\s*method: 'POST'/.test(spawnSrc) && /navigate\('fleet', \{ add: '1' \}\)/.test(spawnSrc));
  const fieldSrc = readFileSync(new URL('../spawn/PathField.tsx', import.meta.url), 'utf8');
  check(
    'a folder field shows its list only while focused, so two fields never open two lists (Amendment 52)',
    /useState\(autoFocus\)/.test(fieldSrc) && /onBlur=\{\(\) => setOpen\(false\)\}/.test(fieldSrc) && /onFocus=\{\(\) => setOpen\(true\)\}/.test(fieldSrc),
  );
  const formSrc = readFileSync(new URL('../fleet/NewProject.tsx', import.meta.url), 'utf8');
  check('the form sends the referenced folders with the project, including one still in the field', /addReferenced\(refs, draft, main\)\.list/.test(formSrc) && /createProject\(\{ path, .*dirs \}\)/.test(formSrc));
}

console.log('\n18 · the storage question says what it will do, and what no costs (Amendment 46)');
{
  const base: StorageState = { mode: 'undecided', dir: '/Users/me/.conductor', saved: false, db: ':memory:', settings: null };
  const q = questionLines(base);
  check('home reads as ~', homeish('/Users/me/.conductor') === '~/.conductor' && homeish('/opt/x') === '/opt/x' && homeish('/Users/me') === '~');
  check('the question names the folder it would create', q.yes === 'Allow — create ~/.conductor' && q.body[0]!.includes('~/.conductor'));
  check('and says what goes there, and what does not', /database/.test(q.body[0]!) && /settings\.json/.test(q.body[0]!) && /worktrees/i.test(q.body[1]!));
  check('and that nothing is written until you allow it', q.body.some((l) => /Nothing is written there until you allow it/.test(l)));
  check('an old database is named, and left alone', /~\/src\/conductor\/packages\/daemon\/conductor\.db, is left exactly where it is/.test(questionLines({ ...base, legacy: '/Users/me/src/conductor/packages/daemon/conductor.db' }).body.at(-1)!));
  check('without one, it says nothing about one', !q.body.some((l) => /earlier database/.test(l)));
  check('with an old database, it offers to bring it, saying what is in it (Amendment 53)', bringLine({ ...base, legacy: '/Users/me/c.db', legacyHolds: { projects: 3, agents: 1 } }) === 'Bring my history: copy 3 projects and 1 agent, with their chats into ~/.conductor.');
  check('and without one, offers nothing', bringLine(base) === null);
  check('saying no is explained before it is clicked', /lost when it stops/.test(DECLINE_NOTE) && /asks again/.test(DECLINE_NOTE));
  check('in memory, every screen says nothing is saved', /Nothing is being saved/.test(bannerLine({ ...base, mode: 'memory' }) ?? ''));
  check('once copied home, it says to restart', /Restart Conductor/.test(bannerLine({ ...base, mode: 'memory', savedAt: 'x' }) ?? ''));
  check('saved to home, or asked nothing yet, no banner', bannerLine({ ...base, mode: 'home', saved: true }) === null && bannerLine(base) === null && bannerLine(null) === null);
}

console.log('\n19 · settings live in the daemon, not in each browser (Amendment 46)');
{
  const merged = mergeIncoming({ a: '1', b: '2', c: '3' }, { b: 'mine', c: null, d: 'new' });
  check("an unsent write survives the daemon's older copy", merged['b'] === 'mine' && merged['d'] === 'new', JSON.stringify(merged));
  check('and so does an unsent removal', !('c' in merged) && merged['a'] === '1');
  const up = importable([['conductor.theme', 'light'], ['conductor.composerH', '300'], ['other.app', 'x']], { 'conductor.composerH': '200' });
  check("what this browser kept moves up once, only Conductor's, never over the daemon's", JSON.stringify(up) === JSON.stringify([['conductor.theme', 'light']]), JSON.stringify(up));
  // Every screen reads and writes settings through lib/settings.ts, and nothing else
  // keeps its own copy in the browser.
  const root = new URL('../', import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL): void => {
    for (const name of readdirSync(dir)) {
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.tsx?$/.test(name) && !/verify\.ts$/.test(name) && !url.pathname.endsWith('/lib/settings.ts')) {
        const code = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        if (/localStorage\./.test(code)) offenders.push(url.pathname.split('/src/')[1] ?? name);
      }
    }
  };
  walk(root);
  check('no screen keeps its own settings in localStorage any more', offenders.length === 0, offenders.join(', '));
}

console.log('\n20 · a Settings tab, and the slot limit on it (Amendment 47)');
{
  check('a whole number from 1 to 32 is a limit', slotsProblem('1') === null && slotsProblem(' 32 ') === null);
  check('anything else says why', ['0', '33', '2.5', '', 'x', '-1'].every((v) => slotsProblem(v) !== null));
  const daemon = readFileSync(new URL('../../../daemon/src/slots.ts', import.meta.url), 'utf8');
  check(
    "the field's rule is the daemon's: same name, same limits",
    daemon.includes(`SLOTS_KEY = '${SLOTS_KEY}'`) && daemon.includes(`SLOTS_MAX = ${SLOTS_MAX}`) && daemon.includes(`DEFAULT_SLOTS = ${SLOTS_DEFAULT}`),
  );
  const route = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const def = route.slice(route.indexOf('export const screen'));
  check('Settings is a tab, on 9', /id: 'settings'/.test(def) && /hotkey: '9'/.test(def) && !/tab: false/.test(def));
  check('its launch defaults are the ones Spawn reads', /launchDefaults\(readSetting\)/.test(route) && /launchPatch\(/.test(route));
}

console.log('\n21 · "allow always" rules say what they allow, who asked, and where else they live (Amendment 48)');
{
  check('a rule reads as tool and pattern', ruleTitle({ toolName: 'Bash', ruleContent: 'npm test:*' }) === 'Bash · npm test:*' && ruleTitle({ toolName: 'Read', ruleContent: null }) === 'Read · any call');
  const now = Date.parse('2026-09-30T12:00:00Z');
  check('it says who asked, and when', ruleOrigin({ agent: { id: 'a', role: 'builder' }, grantedAt: '2026-09-28T09:00:00Z' }, now) === 'builder asked · 2 days ago');
  check('and, from before, that nobody recorded who', /before Conductor recorded/.test(ruleOrigin({ agent: null, grantedAt: '2026-09-30T08:00:00Z' }, now)));
  const copy = (present: boolean | null, file: string | null = '/Users/me/src/app/.claude/settings.local.json') => ({ copy: { destination: 'localSettings', file, entry: 'Bash(npm test:*)', present } });
  check("a copy that is there is named, with its line, for the user to remove", /~\/src\/app\/\.claude\/settings\.local\.json, as "Bash\(npm test:\*\)"\. Remove that line/.test(copyLine(copy(true)) ?? ''));
  check('one that is gone says so', /isn't there now/.test(copyLine(copy(false)) ?? ''));
  check("one that can't be read says it couldn't check", /couldn't be read/.test(copyLine(copy(null)) ?? ''));
  check('a session-only copy needs nothing removed', /for that run only/.test(copyLine(copy(true, null)) ?? ''));
  check('no copy, no line', copyLine({ copy: null }) === null);
  check('revoking says what it does not reach', /running keeps what its session was given until its next run/.test(REVOKE_NOTE));
  const route = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  check('the Settings tab lists and revokes them', /listRules\(projectId\)/.test(route) && /revokeRule\(r\.id\)/.test(route) && /Allowed always/.test(route));
}

console.log('\n22 · helpers sit under the orchestrator that started them (Amendment 51)');
{
  const ag = (id: string, role: string, parentId?: string) => ({ id, role, ...(parentId ? { parentId } : {}) }) as unknown as Agent;
  const lanes = nestHelpers([ag('o', 'builder'), ag('v', 'validator'), ag('h1', 'builder-api', 'o'), ag('h2', 'builder-ui', 'o'), ag('x', 'lost', 'gone')]);
  check('each orchestrator is followed by its helpers', lanes.map((l) => l.agent.id).join() === 'o,h1,h2,v,x', lanes.map((l) => l.agent.id).join());
  check('which say whose they are', lanes[1]?.helperOf === 'builder' && lanes[2]?.helperOf === 'builder' && lanes[0]?.helperOf === null);
  check('a helper whose orchestrator is gone stands on its own', lanes.find((l) => l.agent.id === 'x')?.helperOf === null);
  check('nothing is dropped or doubled', lanes.length === 5);
}

console.log('\n23 · the Fleet cards in your order (Amendment 54)');
{
  const P = (...ids: string[]) => ids.map((id) => ({ id }));
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();
  check('the saved order is used', ids(applyOrder(P('a', 'b', 'c'), ['c', 'a', 'b'])) === 'c,a,b');
  check('a project added since goes at the end, and a removed one drops out', ids(applyOrder(P('a', 'b', 'new'), ['gone', 'b', 'a'])) === 'b,a,new');
  check('dropping a card on another puts it just before it', moveBefore(P('a', 'b', 'c', 'd'), 'd', 'b').join() === 'a,d,b,c');
  check('and moving down works the same way', moveBefore(P('a', 'b', 'c', 'd'), 'a', 'd').join() === 'b,c,a,d');
  check('one step earlier and later', moveBy(P('a', 'b', 'c'), 'b', -1).join() === 'b,a,c' && moveBy(P('a', 'b', 'c'), 'b', 1).join() === 'a,c,b');
  check('never past either end', moveBy(P('a', 'b'), 'a', -1).join() === 'a,b' && moveBy(P('a', 'b'), 'b', 1).join() === 'a,b');
  check('until you arrange them, needs-you first; after, yours', fleetSort(null, []) === 'attention' && fleetSort(null, ['a']) === 'mine' && fleetSort('attention', ['a']) === 'attention');
  check('a broken saved order is no order', parseOrder('{x').length === 0 && parseOrder('[1,"a"]').join() === 'a');

  // Sort by (Amendment 57).
  const proj = (id: string, name: string, createdAt: string) => ({ id, name, createdAt });
  const all = [proj('a', 'Zeta', '2026-09-01T00:00:00Z'), proj('b', 'alpha', '2026-09-03T00:00:00Z'), proj('c', 'Mid', '2026-09-02T00:00:00Z')];
  const facts = new Map<string, SortFacts>([
    ['a', { rank: 2, working: 3, lastActive: 100, spend: 1 }],
    ['b', { rank: -1, working: 0, lastActive: 300, spend: 9 }],
    ['c', { rank: 2, working: 1, lastActive: 200, spend: 4 }],
  ]);
  const by = (sort: Parameters<typeof sortProjects>[1]) => sortProjects(all, sort, ['c', 'a', 'b'], facts).map((p) => p.id).join();
  check('sort by name is A to Z, whatever the case', by('name') === 'b,c,a', by('name'));
  check('needs you first, then by name on a tie', by('attention') === 'b,c,a', by('attention'));
  check('working: most agents working first', by('working') === 'a,c,b', by('working'));
  check('recently active first', by('recent') === 'b,c,a', by('recent'));
  check('most spent first', by('spend') === 'b,c,a', by('spend'));
  check('newest added first', by('added') === 'b,c,a', by('added'));
  check('my order is yours', by('mine') === 'c,a,b', by('mine'));
  check('every sort in the menu is one the grid knows, and a saved one is kept', SORTS.every((s) => fleetSort(s.id, []) === s.id) && fleetSort('nonsense', []) === 'attention');
}

console.log('\n24 · notes on a project, on its card (Amendment 55)');
{
  check('the card counts them, or offers the first', noteCount(0) === '+ note' && noteCount(1) === '✎ 1 note' && noteCount(3) === '✎ 3 notes');
  const now = Date.parse('2026-09-30T12:00:00Z');
  check('and says how long ago, the way people say it', noteAge('2026-09-30T11:59:40Z', now) === 'just now' && noteAge('2026-09-30T11:20:00Z', now) === '40 min ago' && noteAge('2026-09-30T07:00:00Z', now) === '5 h ago' && noteAge('2026-09-29T10:00:00Z', now) === 'yesterday' && noteAge('2026-09-25T10:00:00Z', now) === '5 days ago');
  check('a changed note says so; a new one does not', wasEdited({ createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T11:00:00Z' }) && !wasEdited({ createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z' }));
  const card = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');
  const notes = readFileSync(new URL('../fleet/Notes.tsx', import.meta.url), 'utf8');
  check('the card shows the newest note and the count', /<LatestNote project=\{project\} \/>/.test(card) && /<NotesButton project=\{project\}/.test(card) && /cardNote\(project\.notes \?\? \[\], today\)/.test(notes));
  check('and the panel creates, changes and deletes them', /addNote\(project\.id/.test(notes) && /editNote\(project\.id, note\.id/.test(notes) && /removeNote\(project\.id, note\.id\)/.test(notes));
  const projectScreen = readFileSync(new URL('../fleet/project.tsx', import.meta.url), 'utf8');
  const inspector = readFileSync(new URL('../agent/inspector.tsx', import.meta.url), 'utf8');
  check('the Project screen edits the same notes (Amendment 56)', /<NotesPanel project=\{project\} \/>/.test(projectScreen));
  check("and the Agent screen, its agent's project's", /<NotesPanel project=\{project\} \/>/.test(inspector) && /p\.id === agent\.projectId/.test(inspector));
  check('typing in it never opens the project', /onKeyDown: \(e: React\.KeyboardEvent\) => e\.stopPropagation\(\)/.test(notes));

  // Copy, and a delete that says so (Amendment 83).
  check('a note can be copied from its row, wherever the panel shows', /<CopyButton text=\{note\.text\} \/>/.test(notes));
  check('and from the note on the card', /<CopyButton text=\{shown\.text\} compact \/>/.test(notes));
  check("copying on a card doesn't open the project", /e\.stopPropagation\(\);\s*copy\(\);/.test(notes) && /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}\s*>\s*\{said/.test(notes));
  check('delete says so in words, not a bare ✕', />\s*✕ delete\s*</.test(notes));
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let put: string | null = null;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t: string) => { put = t; } } } });
  await copyText('where I am\nwhat next');
  check('it copies the text exactly as written', put === 'where I am\nwhat next', String(put));
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const refused = await copyText('x').then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  check("where the page can't use the clipboard, it says so", /can't use the clipboard/.test(refused ?? ''), String(refused));
  if (real) Object.defineProperty(globalThis, 'navigator', real);
}

console.log('\n25 · a daily budget, as a bar that goes yellow then red (Amendment 59)');
{
  check('green with room', dailyMeter(5, 10).tone === 'ok' && dailyMeter(7.49, 10).tone === 'ok');
  check('yellow from 75%', dailyMeter(7.5, 10).tone === 'warn' && dailyMeter(9.49, 10).tone === 'warn');
  check('red from 95%', dailyMeter(9.5, 10).tone === 'over' && dailyMeter(30, 10).tone === 'over');
  check('the bar is full past the budget, not wider', dailyMeter(30, 10).fraction === 1 && dailyMeter(2.5, 10).fraction === 0.25);
  check('it says spend of budget', dailyMeter(3.2, 10).label === '$3.20 of $10.00 today');
  check('and, over, by how much, and that it only warns', /\$20\.00 over\. Agents keep going/.test(dailyMeter(30, 10).title));
  check('no budget, no meter', parseBudget(null) === null && parseBudget('0') === null && parseBudget('12.5') === 12.5);
  check('the field takes dollars, or nothing', budgetProblem('') === null && budgetProblem('25') === null && budgetProblem('-1') !== null && budgetProblem('lots') !== null);
  const daemon = readFileSync(new URL('../../../daemon/src/daily.ts', import.meta.url), 'utf8');
  check("the field's setting is the daemon's", daemon.includes("DAILY_KEY = 'conductor.dailyBudget'"));
}

console.log('\n26 · notes can be due, and done (Amendment 63)');
{
  const today = '2026-10-01';
  check('late, today, later, or nothing', dueState({ due: '2026-09-29' }, today) === 'late' && dueState({ due: today }, today) === 'today' && dueState({ due: '2026-10-09' }, today) === 'later' && dueState({}, today) === null);
  check('a done note is nothing, whatever its date', dueState({ due: '2026-09-29', doneAt: 'x' }, today) === null);
  check('said the way people say it', dueLabel(today, today) === 'due today' && dueLabel('2026-09-30', today) === '1 day late' && dueLabel('2026-09-26', today) === '5 days late' && dueLabel('2026-10-02', today) === 'due tomorrow' && /^due \w{3}/.test(dueLabel('2026-10-09', today)));
  const notes = [
    { id: 'newest', createdAt: '3' },
    { id: 'today', createdAt: '2', due: today },
    { id: 'late-done', createdAt: '1', due: '2026-09-01', doneAt: 'x' },
    { id: 'late', createdAt: '0', due: '2026-09-20' },
  ];
  check('the card shows the most urgent open note: late before today', cardNote(notes, today)?.id === 'late');
  check('then today', cardNote(notes.filter((n) => n.id !== 'late'), today)?.id === 'today');
  check('and with nothing due, the newest', cardNote([{ id: 'a', createdAt: '2' }, { id: 'b', createdAt: '1', due: '2026-12-01' }], today)?.id === 'a');
  check("today is the local date, so it turns over at local midnight", localDate(new Date(2026, 9, 1, 23, 59).getTime()) === '2026-10-01' && localDate(new Date(2026, 9, 2, 0, 1).getTime()) === '2026-10-02');
  const panel = readFileSync(new URL('../fleet/Notes.tsx', import.meta.url), 'utf8');
  check('the panel sets a date, ticks done, and re-reads today every minute', /<DuePicker/.test(panel) && /editNote\(project\.id, note\.id, \{ done: e\.target\.checked \}\)/.test(panel) && /useNow\(60_000\)/.test(panel));
}

console.log('\n27 · what you type outlives the box it is in (Amendment 64)');
{
  writeDraft('reply:a', 'half a sentence');
  check('a draft is kept by key, apart from others', readDraft('reply:a') === 'half a sentence' && readDraft('reply:b') === '');
  writeDraft('reply:a', '');
  check('an empty one is forgotten', readDraft('reply:a') === '');
  const composer = readFileSync(new URL('../agent/composer.tsx', import.meta.url), 'utf8');
  const spawn = readFileSync(new URL('../spawn/route.tsx', import.meta.url), 'utf8');
  check('the reply box keeps a draft per agent, not in its own state', /useDraft\(`reply:\$\{agent\.id\}`\)/.test(composer) && !/const \[text, setText\] = useState/.test(composer));
  check("and Spawn's prompt too", /useDraft\('spawn:prompt'\)/.test(spawn) && !/const \[prompt, setPrompt\] = useState/.test(spawn));
  const drafts = readFileSync(new URL('./drafts.ts', import.meta.url), 'utf8');
  check('kept in this tab, so a reload keeps them', /sessionStorage\.setItem/.test(drafts));
}

console.log('\n28 · every Fleet card opens its project, and the Project screen has no list of its own (Amendment 66)');
{
  const card = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');
  const open = card.slice(card.indexOf('const open = '), card.indexOf(';', card.indexOf('const open = ')) + 1);
  check('a card opens its Project screen, blocked or not', /^const open = \(\) => openProject\(project\.id\);$/.test(open), open);
  check('and never sends you to Needs you instead', !/openAttention/.test(card));
  const projectScreen = readFileSync(new URL('../fleet/project.tsx', import.meta.url), 'utf8');
  check('the Project screen draws no projects list', !/ProjectListRow/.test(projectScreen) && !/projects\.map\(/.test(projectScreen));
  check('and no "+" in its column head', !/pj-coladd/.test(projectScreen));
  check("its column heads with the project's name", /<span className="pj-colname"[^>]*>\s*\{project\.name\}/.test(projectScreen));
  check(
    'and keeps the facts, actions and notes',
    /<span className="ui-lab">This project<\/span>/.test(projectScreen) &&
      ['branch', 'isolation', 'worktree', 'diff', 'dev server', 'spend'].every((k) => projectScreen.includes(`<span>${k}</span>`)) &&
      /openFiles\(job\)/.test(projectScreen) &&
      /openPreview\(server\)/.test(projectScreen) &&
      /<NotesPanel project=\{project\} \/>/.test(projectScreen),
  );
}

console.log('\n29 · personas are listed, edited, reset and deleted on Settings (Amendment 68)');
{
  const route = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const order = ['<Section title="Launch defaults">', '<Section title="Personas">', '<Section title="Allowed always">'].map((t) => route.indexOf(t));
  check('Settings has a Personas section, after the launch defaults', order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]! && /<PersonasSection \/>/.test(route));
  check('it lists every persona from the one setting', /personasFrom\(raw\)/.test(route) && /useSetting\(PERSONAS_KEY\)/.test(route));
  check('saving writes through withPersona', /writeSetting\(PERSONAS_KEY, withPersona\(raw, p\)\)/.test(route));
  check('reset through resetPersona, delete through withoutPersona', /writeSetting\(PERSONAS_KEY, resetPersona\(raw, p\.id\)\)/.test(route) && /writeSetting\(PERSONAS_KEY, withoutPersona\(raw, p\.id\)\)/.test(route));
  check('a new one gets a fresh id', /newPersonaId\(list\)/.test(route));
  const row = route.slice(route.indexOf('{list.map((p) => ('), route.indexOf('</ul>', route.indexOf('{list.map((p) => (')));
  const deleteAt = row.indexOf('delete…');
  const resetAt = row.indexOf('onClick={() => reset(p)}');
  check(
    'delete is offered only for yours, behind a confirm',
    deleteAt > 0 && /\{!p\.builtIn &&\s*\(confirm === p\.id \?/.test(row) && row.lastIndexOf('{!p.builtIn &&', deleteAt) > row.lastIndexOf('{p.builtIn', deleteAt) && /onClick=\{\(\) => remove\(p\)\}/.test(row),
  );
  check('reset only for a built-in you changed', resetAt > 0 && row.lastIndexOf('{p.builtIn && isEdited(p) && (', resetAt) > row.lastIndexOf('{!p.builtIn', resetAt));
  check('and a changed built-in is marked', /\{p\.builtIn && isEdited\(p\) && \(\s*<span className="st-changed"/.test(row));
  const editor = route.slice(route.indexOf('function PersonaEditor'), route.indexOf('function PersonasSection'));
  check(
    'the editor edits every field',
    ['p.name', 'p.description', 'p.brief', 'p.systemPrompt'].every((f) => editor.includes(`value={${f}}`)) && /<ModelSelect/.test(editor) && /skillsFrom\(skills\)/.test(editor),
  );
  check("the model is the launch's, a tier, or an exact id", /the launch's choice/.test(editor) && /TIERS\.map/.test(editor) && /an exact model…/.test(editor));
  check(
    'five tool rules, each on, off or the launch’s',
    /TOOL_RULES\.map/.test(editor) && /RULE_CHOICES\.map/.test(editor) && ['bash', 'push', 'network', 'mcp', 'write'].every((k) => new RegExp(`id: '${k}'`).test(route)) && /value: undefined, label: "the launch's"/.test(route),
  );
  check('the system prompt says it is appended, and keeps to the daemon’s limit', /Appended to Claude Code's own system prompt/.test(editor) && /maxLength=\{20_000\}/.test(editor));
  const daemon = readFileSync(new URL('../../../daemon/src/routes/session.ts', import.meta.url), 'utf8');
  check('which is the limit the daemon refuses past', /SYSTEM_PROMPT_MAX = 20_000/.test(daemon));
}

console.log('\n30 · the OpenRouter key is never shown, and a daemon without the routes is not an error (Amendment 80)');
{
  const SECRET = 'sk-or-v1-0123456789abcdef-SECRET';
  const realFetch = globalThis.fetch;
  const seen: { url: string; method: string; body: string }[] = [];
  const reply = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  // A daemon that wrongly echoed the key back still can't get it into the screen's state.
  check('only set and source are kept from what the daemon says', JSON.stringify(keyStateFrom({ set: true, source: 'settings', key: SECRET })) === '{"set":true,"source":"settings"}');
  globalThis.fetch = reply(200, { set: true, source: 'settings', key: SECRET });
  const saved = await saveKey(SECRET);
  const put = seen.at(-1)!;
  check('saving PUTs the key to the daemon, once, in the body', put.method === 'PUT' && put.url === '/api/providers/openrouter/key' && JSON.parse(put.body).key === SECRET);
  check('and what comes back is the state, without the key', !JSON.stringify(saved).includes(SECRET) && saved.set && saved.source === 'settings');
  const read = await readKeyState();
  check('reading it is the same: the state, never the key', read !== null && !JSON.stringify(read).includes(SECRET));
  globalThis.fetch = reply(200, { set: false, source: null });
  await saveKey(null);
  check('clearing it sends null', JSON.parse(seen.at(-1)!.body).key === null);

  globalThis.fetch = reply(404, { statusCode: 404, error: 'Not Found', message: 'Route GET:/api/providers/openrouter/key not found' });
  check('a daemon without the key route is "not available", not an error', (await readKeyState()) === null && /not available/i.test(keyLine(null)));
  check('nor without the login route', (await readCopilotLogin()) === null && /not available/i.test(loginLine(null)));
  globalThis.fetch = reply(200, { authenticated: false, login: null, note: 'no GitHub credential found' });
  const none = await readCopilotLogin();
  check('no GitHub credential is not signed in, with how to sign in and the note kept', none?.authenticated === false && none.note === 'no GitHub credential found' && /Not signed in/.test(loginLine(none)) && /\/login/.test(loginLine(none)) && /GH_TOKEN/.test(loginLine(none)));
  globalThis.fetch = reply(200, { authenticated: true, login: 'octocat' });
  check('signed in says who', loginLine(await readCopilotLogin()) === 'Signed in as octocat.');
  globalThis.fetch = realFetch;

  check('the key line says whether and where, and no more', /OPENROUTER_API_KEY/.test(keyLine({ set: true, source: 'env' })) && /^Set/.test(keyLine({ set: true, source: 'settings' })) && /^Not set/.test(keyLine({ set: false, source: null })));
  check('engines are named for people', providerLabel('openrouter') === 'OpenRouter' && providerLabel('copilot') === 'Copilot' && providerLabel(undefined) === 'Claude' && providerLabel('other') === 'other');

  const route = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('./providers.ts', import.meta.url), 'utf8');
  const section = route.slice(route.indexOf('function ProvidersSection'), route.indexOf('function LaunchSection'));
  check('Settings has a Providers section', section.length > 0 && /<Section title="Providers">\s*<ProvidersSection \/>/.test(route));
  check('the key field is a password field bound to the draft, which empties once sent', /type="password"/.test(section) && /value=\{draft\}/.test(section) && /finally \{\s*setDraft\(''\);/.test(section));
  check('the draft is never written out as text, nor into a setting', !/>\s*\{draft/.test(section) && !/writeSetting/.test(section) && !/localStorage|sessionStorage/.test(section + lib));
  check('and nothing logs it', !/console\./.test(section) && !/console\./.test(lib));
  check('what the section says about the key is keyLine, from the state alone', /keyLine\(key\)/.test(section) && /keyLine\(s: OpenRouterKeyState \| null\)/.test(lib));
}

console.log('\n31 · a job says it has finished until you have seen it (Amendment 87)');
{
  const T = (m: number): string => new Date(Date.UTC(2026, 9, 6, 12, m)).toISOString();
  const job = (id: string, status: Job['status'], endedAt: string | null, projectId = 'p1') => ({ id, projectId, status, endedAt });
  const ag = (id: string, jobId: string) => ({ id, jobId });
  const kept = startSeen(T(10));

  check('before it is kept, nothing is unseen: the first load does not light every old job', unseenFinished([job('a', 'done', T(20))], [ag('x', 'a')], parseSeen(null)).length === 0);
  check('a broken value is the same as none', parseSeen('{').since === null && parseSeen('[]').since === null && parseSeen('{"since":"nope"}').since === null);
  check('it reads back what it wrote', serializeSeen(parseSeen(serializeSeen({ since: T(1), jobs: { a: T(2) } }))) === serializeSeen({ since: T(1), jobs: { a: T(2) } }));
  check('and drops what is not an end time', Object.keys(parseSeen(JSON.stringify({ since: T(1), jobs: { a: T(2), b: 3 } })).jobs).join() === 'a');
  check('a job is finished when it is done or failed and has ended', isFinished(job('a', 'done', T(1))) && isFinished(job('a', 'failed', T(1))) && !isFinished(job('a', 'stopped', T(1))) && !isFinished(job('a', 'working', null)) && !isFinished(job('a', 'done', null)));

  const jobs = [job('old', 'done', T(5)), job('new', 'done', T(20)), job('bad', 'failed', T(21)), job('run', 'working', null), job('empty', 'done', T(22))];
  const agents = [ag('1', 'old'), ag('2', 'new'), ag('3', 'bad'), ag('4', 'run')];
  const unseen = unseenFinished(jobs, agents, kept).map((j) => j.id);
  check('what finished since it was kept is unseen, failed or not', unseen.join() === 'new,bad', unseen.join());
  check('not one that ended before, one still running, or one with no agents left', !unseen.includes('old') && !unseen.includes('run') && !unseen.includes('empty'));

  const marked = markSeen(kept, ['new'], jobs)!;
  check('marking a job seen keeps the end time it had', marked.jobs['new'] === T(20) && marked.since === kept.since);
  check('and it is no longer unseen', unseenFinished(jobs, agents, marked).map((j) => j.id).join() === 'bad');
  check('marking it again changes nothing, so nothing is written', markSeen(marked, ['new'], jobs) === null);
  check('nor before it is kept', markSeen(parseSeen(null), ['new'], jobs) === null);
  const again = jobs.map((j) => (j.id === 'new' ? job('new', 'done', T(40)) : j));
  check('a job continued and finished again is unseen again', unseenFinished(again, agents, marked).some((j) => j.id === 'new'));
  const gone = markSeen(marked, ['bad'], jobs.filter((j) => j.id !== 'new'))!;
  check('a job that no longer exists drops out when it is written', !('new' in gone.jobs) && gone.jobs['bad'] === T(21));

  check('the Agent screen sees its agent\'s own job, if that job is unseen', seenOnAgent('3', agents, [{ id: 'bad' }]).join() === 'bad' && seenOnAgent('2', agents, [{ id: 'bad' }]).length === 0 && seenOnAgent(undefined, agents, [{ id: 'bad' }]).length === 0);
  check('it is kept in Settings, under conductor.', SEEN_KEY === 'conductor.seenJobs');

  const card = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');
  const project = readFileSync(new URL('../fleet/project.tsx', import.meta.url), 'utf8');
  const always = readFileSync(new URL('../attention/always.tsx', import.meta.url), 'utf8');
  check('the Fleet card says finished', /useUnseenJobs\(\)/.test(card) && />finished<\/Tag>/.test(card));
  check('the Project screen says it on the job\'s group, and marks its own project\'s jobs seen while in front', /finished=\{finishedHere\(g\.job\)\}/.test(project) && /markJobsSeen\(ids, allJobs\)/.test(project) && /if \(!visible/.test(project));
  check('the notifier counts them, announces them, and opens the project when one is clicked', /useLadderEffects\(pending, alerts, now, activate, finished\)/.test(always) && /openProject\(target\.projectId\)/.test(always) && /startSeenOnce\(\)/.test(always));
}

console.log('\n32 · status marks are filled, edged and plainly finished (Amendment 93)');
{
  const ui = readFileSync(new URL('../shell/ui.tsx', import.meta.url), 'utf8');
  const uiCss = readFileSync(new URL('../shell/ui.css', import.meta.url), 'utf8');
  const lane = readFileSync(new URL('../fleet/lane.tsx', import.meta.url), 'utf8');
  const fleetCss = readFileSync(new URL('../fleet/fleet.css', import.meta.url), 'utf8');
  const card32 = readFileSync(new URL('../fleet/card.tsx', import.meta.url), 'utf8');

  const rule32 = (css: string, selector: string): string => {
    const i = css.indexOf(`${selector} {`);
    return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  };

  check('every done agent plainly says finished', /done:\s*'finished'/.test(ui));
  check(
    'the live tag is filled, not tinted, and heavier',
    /background:\s*var\(--live\)/.test(rule32(uiCss, '.ui-tag.t-live')) &&
      /font-weight:\s*700/.test(rule32(uiCss, '.ui-tag.t-live')),
  );
  check(
    'the done tag is filled the same way',
    /background:\s*var\(--done\)/.test(rule32(uiCss, '.ui-tag.t-done')) &&
      /font-weight:\s*700/.test(rule32(uiCss, '.ui-tag.t-done')),
  );
  check(
    'the working dot still pulses, with no reduced-motion rule of its own — tokens.css already turns it off',
    /animation:\s*conductor-pulse var\(--pulse-slow\)/.test(rule32(uiCss, '.ui-dot.d-live')) &&
      !/@media\s*\(prefers-reduced-motion/.test(uiCss),
  );
  check('the agent lane gets the Fleet card\'s left-edge treatment', /s-live/.test(lane) && /s-done/.test(lane));
  check(
    'fleet.css gives the lane an inset 3px edge in both colours',
    /inset 3px 0 0 var\(--live\)/.test(rule32(fleetCss, '.pj-lane.s-live')) &&
      /inset 3px 0 0 var\(--done\)/.test(rule32(fleetCss, '.pj-lane.s-done')),
  );
  check('the agent row\'s own elapsed column says finished too, not the old word', /'done'\s*\?\s*'finished'/.test(card32));
}

console.log('\n33 · the top bar\'s tabs read louder, and the open one stands out (Amendment 95)');
{
  const shell95 = readFileSync(new URL('../shell/shell.css', import.meta.url), 'utf8');

  const rule95 = (css: string, selector: string): string => {
    const i = css.indexOf(`${selector} {`);
    return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  };

  check(
    'every tab reads --ink2 now, heavier than before',
    /color:\s*var\(--ink2\)/.test(rule95(shell95, '.sh-screens button')) &&
      /font-weight:\s*600/.test(rule95(shell95, '.sh-screens button')),
  );
  check(
    'the open tab gets --ink, a tint of it over the bar, not a flat surface',
    /color:\s*var\(--ink\);/.test(rule95(shell95, '.sh-screens button.on')) &&
      /color-mix\(in srgb, var\(--ink\) 7%, var\(--bg2\)\)/.test(rule95(shell95, '.sh-screens button.on')),
  );
  check(
    'its underline is 3px now, not 2',
    /box-shadow:\s*inset 0 -3px 0 var\(--ink\)/.test(rule95(shell95, '.sh-screens button.on')),
  );
}

console.log('\n34 · an agent says finished until you have opened it (Amendment 105)');
{
  const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
  const ag = (id: string, status: Agent['status'], endedAt: string | null) => ({ id, status, endedAt });
  const kept = { since: T(10), agents: {} };

  check('it is kept in Settings under its own key, not inside seenJobs', SEEN_AGENTS_KEY === 'conductor.seenAgents' && SEEN_KEY === 'conductor.seenJobs');
  check('before it is kept, nothing is unseen: the upgrade does not light every old agent', unseenDoneAgents([ag('a', 'done', T(20))], parseSeenAgents(null)).length === 0);
  check('a broken value is the same as none', parseSeenAgents('{').since === null && parseSeenAgents('[]').since === null && parseSeenAgents('{"since":"nope"}').since === null);
  check('it reads back what it wrote', serializeSeenAgents(parseSeenAgents(serializeSeenAgents({ since: T(1), agents: { a: T(2) } }))) === serializeSeenAgents({ since: T(1), agents: { a: T(2) } }));
  check('and drops what is not an end time', Object.keys(parseSeenAgents(JSON.stringify({ since: T(1), agents: { a: T(2), b: 3 } })).agents).join() === 'a');

  const agents = [ag('old', 'done', T(5)), ag('new', 'done', T(20)), ag('bad', 'failed', T(21)), ag('stop', 'stopped', T(22)), ag('run', 'working', null), ag('wait', 'queued', null), ag('odd', 'done', null)];
  const unseen = unseenDoneAgents(agents, kept).map((a) => a.id);
  check('a done agent that ended since it was kept is unseen', unseen.join() === 'new', unseen.join());
  check('failed, stopped, working and queued agents are not; nor one that ended before, nor one with no end time', !['bad', 'stop', 'run', 'wait', 'old', 'odd'].some((id) => unseen.includes(id)));

  const marked = markAgentsSeen(kept, ['new'], agents)!;
  check('marking an agent seen keeps the end time it had', marked.agents['new'] === T(20) && marked.since === kept.since);
  check('and it is no longer unseen', unseenDoneAgents(agents, marked).length === 0);
  check('marking it again changes nothing, so nothing is written', markAgentsSeen(marked, ['new'], agents) === null);
  check('nor before it is kept', markAgentsSeen(parseSeenAgents(null), ['new'], agents) === null);
  const again = agents.map((a) => (a.id === 'new' ? ag('new', 'done', T(40)) : a));
  check('an agent re-run or continued that finishes again is unseen again', unseenDoneAgents(again, marked).map((a) => a.id).join() === 'new');
  const gone = markAgentsSeen(marked, ['old'], agents.filter((a) => a.id !== 'new'))!;
  check('an agent that no longer exists drops out when it is written', !('new' in gone.agents) && gone.agents['old'] === T(5));
  check('an unknown id marks nothing', markAgentsSeen(kept, ['nobody'], agents) === null);

  const seenSrc = readFileSync(new URL('./seen.ts', import.meta.url), 'utf8');
  const always = readFileSync(new URL('../attention/always.tsx', import.meta.url), 'utf8');
  const effect = always.slice(always.indexOf('if (!visible) return;'), always.indexOf('}, [visible, onAgent'));
  check('the first load writes its since too, once', /readSetting\(SEEN_AGENTS_KEY\) === null/.test(seenSrc));
  check('the live mark reads the setting when it writes, so two quick marks both land', /parseSeenAgents\(readSetting\(SEEN_AGENTS_KEY\)\)/.test(seenSrc));
  check('the notifier marks the open agent seen, only while the tab is in front', effect.length > 0 && /markAgentSeen\(onAgent, agents\)/.test(effect));
}

console.log(
  failures === 0
    ? '\nW0 web verify: PASS — store reducer is idempotent and referentially honest; the cleanup button says what it deletes; build info says what is running; model pickers say when a model is wrong; a screen can exist without a tab; one projects list says what needs you; a project is added with its folders; the storage question says what it does; settings are kept by the daemon; a Settings tab sets them; allow-always rules are listed and revoked; helpers nest under their orchestrator; the Fleet cards keep your order; projects carry notes; a daily budget goes yellow then red; notes can be due; drafts survive; every card opens its project; personas can be edited; the OpenRouter key is never shown; a finished job says so until seen; the live and done tags are filled, the lane carries their edge, and a done agent reads finished; an agent\'s own finished clears once you open it; both themes clear 4.5:1 everywhere that matters, the open top-bar tab included.\n'
    : `\nW0 web verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
