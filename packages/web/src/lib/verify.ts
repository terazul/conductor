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

import type { Agent, AgentStatus, Alert, Event, EventPayload, Job, MonthCorrection, Project, ProviderSpend, ServerFrame, Snapshot } from '@conductor/shared';
import { MODEL_WAIT_SUFFIX, PROVIDER_BUDGETS_KEY, budgetState, diffstat, localDayOf, providerBudgetLabel, resolveFileEdits, rollupStatus, sparkline } from '@conductor/shared';
import { PROVIDER_SPEND_NOTE, providerBudgetCell, providerSpendRows } from '../metrics/rules.js';
import { alertActions, alertNotice, monthlyNote } from '../attention/alerts.js';
import { reconnectBar } from '../agent/reconnecting.js';
import { rollupStatuses, store } from './store.js';
import { ApiError, errorText, explain } from './errors.js';
import { api } from './feed.js';
import { readFileSync } from 'node:fs';
import { nextChoice, parseChoice, resolveTheme } from '../shell/theme.js';
import { headlineTags, restOf, restWord } from '../fleet/rest.js';
import { TREE_DEFAULT, TREE_MIN, storedTreeWidth, treeWidth } from '../files/width.js';
import {
  AGENT_INSPECTOR,
  AGENT_NEEDS,
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
  isOutage,
  leftIn,
  outageLine,
  projectNeeds,
  reconnectLine,
  reconnectTail,
  reconnectingNow,
  retryHead,
  retryTail,
  retryingNow,
  waitingForModel,
} from '../shell/describe.js';
import { confirmLine, doneLine, fmtBytes, storageLine } from '../diagnostics/storage.js';
import { behindLine, buildTag, buildTitle, fmtWhen, type Build } from '../diagnostics/build.js';
import { catalogLine, modelGroups, modelProblem, resolveTier, shortModel } from './models.js';
import type { ModelCatalog } from '@conductor/shared';
import { screenForKey, tabbed } from './screens.js';
import { addReferenced, addedLine, nameFrom, tidyPath } from '../fleet/addproject.js';
import { DECLINE_NOTE, bannerLine, bringLine, homeish, questionLines } from '../settings/storage.js';
import { importable, mergeIncoming, onSettings, readSetting, writeSetting } from './settings.js';
import { SLOTS_DEFAULT, SLOTS_KEY, SLOTS_MAX, STACKS_DEFAULT, STACKS_KEY, STACKS_MAX, slotsProblem, stacksProblem } from '../settings/slots.js';
import { readDraft, writeDraft } from './drafts.js';
import { cleanHtml, copyRich, copyText } from './clipboard.js';
import { replyClipboard } from '../agent/replycopy.js';
import { SEEN_KEY, isFinished, markSeen, parseSeen, seenOnAgent, serializeSeen, startSeen, unseenFinished } from './seen.js';
import { SEEN_AGENTS_KEY, markAgentsSeen, parseSeenAgents, serializeSeenAgents, unseenDoneAgents } from './seen.js';
import { REVOKE_NOTE, copyLine, ruleOrigin, ruleTitle } from '../settings/rules.js';
import { nestHelpers } from '../fleet/nest.js';
import { FLEET_AGENTS_KEY, agentsOpen, agentsToggleWords, needsYou, shownAgents, toggleAgents } from '../fleet/agentlist.js';
import { NAV_TREE_KEY } from '../shell/navtree.js';
import { SORTS, applyOrder, fleetSort, moveBefore, moveBy, parseOrder, sortFacts, sortProjects, type SortFacts } from '../fleet/order.js';
import { cardNote, dueLabel, dueState, localDate, noteAge, noteCount, wasEdited } from '../fleet/notewords.js';
import {
  MONTHLY_KEY,
  MONTH_CORRECTED_MARK,
  MONTH_TITLE,
  OVER_AT,
  WARN_AT,
  agentPairWords,
  budgetProblem,
  dailyMeter,
  monthMeter,
  monthWords,
  monthlyDraft,
  parseBudget,
  providerBudgetDraft,
  providerMonthWords,
  withProviderBudget,
  projectPairWords,
  projectSpendOf,
  toneOf,
  gatewayDraft,
  monthCorrectionTitle,
  monthCorrectionWords,
  providerCorrectionNote,
  signedMoney,
} from '../shell/spend.js';
import { budgetOf } from '../shell/autonomy.js';
import {
  RETRY_DELAYS_KEY,
  retryDelaysFieldProblem,
  retryDelaysShown,
  retryDelaysValue,
  retryDelaysWords,
} from '../settings/budgets.js';
import { readdirSync, statSync } from 'node:fs';
import type { StorageState } from '@conductor/shared';
import { keyLine, keyStateFrom, loginLine, providerLabel, readCopilotLogin, readKeyState, saveKey } from './providers.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Transcript, YOU_FOLD_LINES, buildTranscript, replyKeys, replyStates, splitTurn, startFoldedKeys, type Turn } from '../agent/transcript.js';
import { closeRead, foldEvery, foldLine, lastLine, parseFolds, shownFolded, toggleFold, unfoldEvery, updateFoldState, type FoldState } from '../agent/folds.js';
import { ReadAllButton, readAll, toTick } from '../agent/readall.js';
import { fmtStamp, fullStamp } from './when.js';
import { MAX_ACKS, REPLY_ACKS_KEY, canUntick, isRead, parseAcks, serializeAcks, setAck, setAcksAll, startAcks, toRead, type ReplyAcks } from './replies.js';

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
  // OKLCH chroma and hue (Björn Ottosson's OKLab, from linear sRGB), for the label backdrops' hue check.
  const oklch = (hex: string): { c: number; h: number } => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  };

  const TEXT = ['ink', 'ink2', 'ink3', 'live', 'need', 'fail', 'done', 'queue', 'idle', 'you'];
  const SURFACES = ['bg', 'bg2', 'surf', 'surf2', 'surf3', 'well'];
  // Buttons and badges that put --bg text on a status fill (.sp-go, .sh-alert-n, …), and
  // a paused agent's chip on --idle (.ui-tag.t-pause, .sh-nav-tag.is-pause; Amendment 205).
  const FILLS = ['live', 'need', 'fail', 'done', 'idle'];

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
    // What needs you sits on --need-wash (14 Oct): its text reads on it, and it stands off the page.
    const onWash = ['need', 'ink', 'ink2'].filter((t) => ratio(theme.get(t)!, theme.get('need-wash')!) < 4.5);
    check(`${name}: --need, --ink and --ink2 are ≥ 4.5:1 on --need-wash, the rail's backdrop`, theme.has('need-wash') && onWash.length === 0, onWash.map((t) => `--${t} ${ratio(theme.get(t)!, theme.get('need-wash')!).toFixed(2)}`).join(', '));
    const off = Math.min(...['bg', 'bg2'].map((b) => ratio(theme.get('need-wash')!, theme.get(b)!)));
    check(`${name}: --need-wash stands off the page by 1.15:1 or more, so the rail is seen`, off >= 1.15, off.toFixed(3));
    // The project / agent label's backdrop (Amendment 97): its text, and the "/" between.
    const onHere = ['ink', 'ink2', 'ink3'].filter((t) => ratio(theme.get(t)!, theme.get('here')!) < 4.5);
    check(`${name}: the project / agent label is ≥ 4.5:1 on its backdrop`, theme.has('here') && onHere.length === 0, onHere.join(', '));
    // The Project and Agent screens' own backdrops (Amendment 127): the same three inks on each.
    for (const bd of ['here-project', 'here-agent']) {
      const onIt = ['ink', 'ink2', 'ink3'].filter((t) => ratio(theme.get(t)!, theme.get(bd)!) < 4.5);
      check(
        `${name}: the label is ≥ 4.5:1 on --${bd}, its screen's backdrop`,
        theme.has(bd) && onIt.length === 0,
        onIt.map((t) => `--${t} ${ratio(theme.get(t)!, theme.get(bd)!).toFixed(2)}`).join(', '),
      );
    }
    // Three screens, three backdrops: --here (Fleet and the rest), --here-project, --here-agent.
    // Different colours, none a status colour (§5.1: those mean one thing and are never
    // decoration), and apart in lightness as well as hue so they tell apart without colour vision.
    const BACKDROPS = ['here', 'here-project', 'here-agent'];
    const hexes = BACKDROPS.map((b) => (theme.get(b) ?? '').toLowerCase());
    check(`${name}: the three label backdrops are three different colours`, new Set(hexes).size === 3, hexes.join(' '));
    const clash = BACKDROPS.flatMap((b) =>
      ['live', 'need', 'fail', 'done', 'queue', 'idle', 'you']
        .filter((st) => (theme.get(st) ?? '').toLowerCase() === (theme.get(b) ?? '').toLowerCase())
        .map((st) => `--${b} is --${st}`),
    );
    check(`${name}: no label backdrop is a status colour (or --you)`, clash.length === 0, clash.join(', '));
    // Amendment 159 (14 Oct): the floor is 1.06, not 1.04, and the hues are at least 60° apart, so
    // slate, petrol and wine tell apart at a glance and not only side by side.
    const PAIRS = [[0, 1], [0, 2], [1, 2]] as const;
    const close = PAIRS.filter(([i, j]) => ratio(hexes[i]!, hexes[j]!) < 1.06).map(
      ([i, j]) => `--${BACKDROPS[i]} and --${BACKDROPS[j]} ${ratio(hexes[i]!, hexes[j]!).toFixed(3)}`,
    );
    check(`${name}: any two label backdrops differ in lightness by at least 1.06:1`, close.length === 0, close.join('; '));
    const hues = hexes.map(oklch);
    // A hue only means something with colour behind it: a near-grey's angle is noise.
    const grey = BACKDROPS.flatMap((b, i) => (hues[i]!.c < 0.03 ? [`--${b} C ${hues[i]!.c.toFixed(3)}`] : []));
    check(`${name}: each label backdrop has an OKLCH chroma of at least 0.03, so its hue counts`, grey.length === 0, grey.join('; '));
    const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    const near = PAIRS.filter(([i, j]) => apart(hues[i]!.h, hues[j]!.h) < 60).map(
      ([i, j]) => `--${BACKDROPS[i]} ${hues[i]!.h.toFixed(0)}° and --${BACKDROPS[j]} ${hues[j]!.h.toFixed(0)}°`,
    );
    check(
      `${name}: any two label backdrops are at least 60° apart in OKLCH hue`,
      near.length === 0,
      near.length ? near.join('; ') : hues.map((h) => `${h.h.toFixed(0)}°`).join(' '),
    );
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
    // The label's border, `color-mix(in srgb, var(--crumb) 60%, var(--ink3))` (shell/ui.css), revisited with
    // the more saturated backdrops (Amendment 159): it still draws a line round each of the three.
    const edges = ['here', 'here-project', 'here-agent'].map((b) => ({ b, r: ratio(mix95(theme.get(b)!, theme.get('ink3')!, 60), theme.get(b)!) }));
    const faint = edges.filter((e) => e.r < 1.6);
    check(
      `${name}: the label's border stands off each backdrop by 1.6:1 or more`,
      faint.length === 0,
      (faint.length ? faint : edges).map((e) => `--${e.b} ${e.r.toFixed(2)}`).join(', '),
    );
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
    ['the Agent screen\'s needs you panel', AGENT_NEEDS, 'AGENT_NEEDS', '../attention/NeedsPanel.tsx', '../attention/attention.css', '.atn-side', -1],
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
    spentToday: { day: localDayOf(), usd: 5, tokens: 0 },
    ...over,
  });
  // What a budget reads is what the agent spent today (Amendment 129), so these agents spent `cost` today.
  const capped = (cap: number | null, cost: number) =>
    who({ costUsd: cost, spentToday: { day: localDayOf(), usd: cost, tokens: 0 }, autonomy: { ...who().autonomy, budgetUsd: cap } });

  check('a known reason has its sentence', failureSentence('max_turns') === 'ran out of turns');
  check(
    'an unknown reason is shown as itself, never guessed at',
    failureSentence('sdk_new_thing') === 'sdk_new_thing — see the transcript',
    failureSentence('sdk_new_thing'),
  );
  check('no reason at all points at the transcript', failureSentence(undefined) === 'ended with an error — see the transcript');
  // Amendment 180: a budget only warns. An agent the old ceiling paused says so, and that continue carries on.
  check('paused by the old ceiling, it says its budget and that continue carries on', failureSentence('budget_exhausted', capped(5, 10)) === 'was paused by its $5 daily budget, which only warns now — continue carries on', failureSentence('budget_exhausted', capped(5, 10)));
  check('raised since, it names the figure as it is now, and asks for no raise', failureSentence('budget_exhausted', capped(15, 5)) === 'was paused by its $15 daily budget, which only warns now — continue carries on');
  check('cents are kept', failureSentence('budget_exhausted', capped(0.01, 0.02)) === 'was paused by its $0.01 daily budget, which only warns now — continue carries on');
  check('no cap known, no figure', failureSentence('budget_exhausted') === 'was paused by its budget, which only warns now — continue carries on');
  check('never a stop at twice it, nor a raise to make first', !/twice|stopped at|raise/.test(failureSentence('budget_exhausted', capped(5, 10))));

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
  const t2 = alertTitle(alert({ kind: 'budget', cause: 'budget_exhausted' }), [{ ...working, costUsd: 10, spentToday: { day: localDayOf(), usd: 10, tokens: 0 } }]);
  check('a budget alert, for an agent the old ceiling paused, says continue carries on', t2.subject === 'was paused by its $5 daily budget, which only warns now — continue carries on', t2.subject);
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
  check('top bar: budget', alertWord({ kind: 'budget', cause: 'budget_exhausted' }) === 'paused by its budget');
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
    // A made-up screen naming a hotkey no real screen has, to show tab: false wins over it.
    // Every digit is a real screen's now (Metrics took '8', Amendment 122), so it is a letter
    // no screen and no shortcut uses (Amendment 136).
    { id: 'old', hotkey: 'x', tab: false, order: 80 },
  ];
  check('a screen with tab: false gets no nav chip', tabbed(defs).map((d) => d.id).join() === 'fleet,files', tabbed(defs).map((d) => d.id).join());
  check('the tabs come in nav order, whatever order they were found in', tabbed(defs)[0]?.id === 'fleet');
  check('a hotkey still opens its screen', screenForKey(defs, '5')?.id === 'files');
  check('and a screen without a tab has none, even if it names one', screenForKey(defs, 'x') === undefined);
  check('a key no screen has opens nothing', screenForKey(defs, '9') === undefined);
  {
    // The made-up key really is one nothing has: no screen registers it.
    const real: string[] = [];
    for (const dir of ['fleet', 'agent', 'attention', 'files', 'preview', 'branches', 'metrics', 'settings', 'diagnostics', 'spawn']) {
      const code = readFileSync(new URL(`../${dir}/route.tsx`, import.meta.url), 'utf8');
      for (const m of code.matchAll(/hotkey:\s*'(.)'/g)) real.push(m[1]!);
    }
    check("the made-up screen's key is one no real screen uses", real.length >= 10 && !real.includes('x') && real.includes('8'), real.join());
  }
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
  // The stacks one launch may start (Amendment 181), beside the slots, by the same rule as the daemon's.
  check('a whole number from 1 to 6 is a stacks limit, and anything else says why', ['1', ' 6 ', '3'].every((v) => stacksProblem(v) === null) && ['0', '7', '2.5', '', 'x'].every((v) => stacksProblem(v) !== null));
  check(
    "the stacks field's rule is the daemon's: same key, same bounds, from shared",
    STACKS_KEY === 'conductor.launch.stacks' && daemon.includes("STACKS_KEY = 'conductor.launch.stacks'") && /n >= 1 && n <= STACKS_MAX/.test(daemon) && STACKS_MAX === 6 && STACKS_DEFAULT === 3,
  );
  check('Settings shows it beside the slots, and writes nothing at the default', /<SlotsSection \/>\s*<StacksRow \/>/.test(route) && /writeSetting\(STACKS_KEY, draft\.trim\(\) === String\(STACKS_DEFAULT\) \? null : draft\.trim\(\)\)/.test(route));
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
    'one tool rule, write, on, off or the launch’s; the rest are the pills (Amendment 147)',
    /TOOL_RULES\.map/.test(editor) && /RULE_CHOICES\.map/.test(editor) && /id: 'write'/.test(route) && ['bash', 'push', 'network', 'mcp'].every((k) => !new RegExp(`id: '${k}'`).test(route)) && /value: undefined, label: "the launch's"/.test(route),
  );
  check('the system prompt says it is appended, and keeps to the daemon’s limit', /Appended to Claude Code's own system prompt/.test(editor) && /maxLength=\{20_000\}/.test(editor));
  const daemon = readFileSync(new URL('../../../daemon/src/session/persona.ts', import.meta.url), 'utf8');
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
  // Since Amendment 194 the card draws `headlineTags`, the rule its tags come from, so the word is checked there.
  check('the Fleet card says finished', /useUnseenJobs\(\)/.test(card) && /headlineTags\(statuses, blocked, unseen\)/.test(card) && headlineTags(['done'], false, [{ status: 'done' }]).map((t) => t.word).join() === 'finished');
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

  // STATUS_WORD moved to shell/status.ts (Amendment 194), so a pure rule can read it under Node; ui.tsx re-exports it.
  const statusTs = readFileSync(new URL('../shell/status.ts', import.meta.url), 'utf8');
  check('every done agent plainly says finished', /done:\s*'finished'/.test(statusTs) && /export \{ STATUS_KEY, STATUS_WORD, type Tone \} from '\.\/status\.js';/.test(ui));
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

console.log('\n35 · an agent waiting to be tried again reads "Reconnecting in 30 s (3 of 5)" (Amendment 123)');
{
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ag = (over: Partial<Agent> = {}): Agent => ({
    id: A,
    jobId: J,
    projectId: P,
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
  const wait = (attempt: number, delayMs: number, cause: 'unreachable' | 'auth' | 'throttled' | 'server' = 'unreachable', ms = T0): Event =>
    ev({ kind: 'status', status: 'queued', error: 'x', retry: { cause, attempt, of: 5, delayMs } }, ms);

  check('time left counts down in seconds, then minutes', leftIn(30_000) === '30 s' && leftIn(29_001) === '30 s' && leftIn(60_000) === '60 s' && leftIn(61_000) === '1 min 1 s' && leftIn(300_000) === '5 min');
  check('and is empty once its time has come', leftIn(0) === '' && leftIn(-5_000) === '' && leftIn(NaN) === '');

  const w3 = reconnectingNow([wait(3, 30_000)]);
  check('a queued agent whose last status carries a retry is waiting for it', w3?.attempt === 3 && w3.of === 5 && w3.cause === 'unreachable' && w3.at === T0 + 30_000, JSON.stringify(w3));
  check('"Reconnecting in 30 s (3 of 5)"', w3 !== null && reconnectLine(w3, T0) === 'Reconnecting in 30 s (3 of 5)', w3 ? reconnectLine(w3, T0) : '');
  check('which counts down', w3 !== null && reconnectLine(w3, T0 + 12_000) === 'Reconnecting in 18 s (3 of 5)');
  check('and at its time says now, while it waits for a slot', w3 !== null && reconnectTail(w3, T0 + 31_000) === 'now (3 of 5)');
  check('a later status ends the wait: working, failed, paused', [
    ev({ kind: 'status', status: 'working' }, T0 + 1),
    ev({ kind: 'status', status: 'failed', error: 'api_error' }, T0 + 1),
    ev({ kind: 'status', status: 'paused' }, T0 + 1),
  ].every((e) => reconnectingNow([wait(3, 30_000), e]) === null));
  check('a queued agent with no retry on it is not waiting', reconnectingNow([ev({ kind: 'status', status: 'queued', error: 'the daemon restarted mid-run — resuming it' })]) === null && reconnectingNow([]) === null);
  check('other events after the status do not end it', reconnectingNow([wait(2, 15_000), ev({ kind: 'text', text: 'hi' }, T0 + 1)])?.attempt === 2);

  const line = (events: Event[], agent = ag(), now = T0 + 10_000) => currentAction(agent, events, [], [], now);
  const first = line([wait(1, 5_000)], ag(), T0 + 1_000);
  check('the agent line says it is reconnecting, with the time and the count', first.head === 'reconnecting' && first.subject === 'in 4 s (1 of 5)', `${first.head} / ${first.subject}`);
  check('from the first retry it is amber, as Needs You has the card (Amendment 140; it was from the second)', first.tone === 'need', first.tone);
  const third = line([wait(3, 30_000)]);
  check('and so at the third', third.head === 'reconnecting' && third.subject === 'in 20 s (3 of 5)' && third.tone === 'need', `${third.subject} (${third.tone})`);
  check('a queued agent that waits on a dependency says so, as before', currentAction(ag(), [], [], ['architect']).head === 'waiting on');
  check('and one that waits for a slot, as before', currentAction(ag(), [], [], []).subject === 'for a slot');
  check('a working agent does not read as reconnecting off an old wait', line([wait(3, 30_000)], ag({ status: 'working' })).head !== 'reconnecting');

  const rc = (over: Partial<Alert> = {}): Alert => ({
    id: 'reconnecting:agt_v:1',
    kind: 'reconnecting',
    cause: 'throttled',
    projectId: P,
    jobId: J,
    agentIds: [A],
    since: new Date(T0).toISOString(),
    attempt: 3,
    maxRetries: 5,
    retryAt: new Date(T0 + 30_000).toISOString(),
    ...over,
  });
  const t = alertTitle(rc(), [ag()]);
  check('its alert reads as what is wrong and which retry, with the role', t.head === 'the model API is busy' && t.subject === 'retry 3 of 5 · builder', `${t.head} / ${t.subject}`);
  check('and in the top bar, a word', alertWord(rc()) === 'reconnecting');
}

console.log("\n36 · an agent's budget warns, in words (Amendment 124)");
{
  const A = (over: Partial<Agent> = {}): Agent => ({
    id: 'agt_o',
    jobId: 'job_o',
    projectId: 'p',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 's',
    status: 'working',
    blockMode: null,
    costUsd: 6,
    inputTokens: 0,
    outputTokens: 0,
    spentToday: { day: localDayOf(), usd: 6, tokens: 0 },
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const warn = (over: Partial<Alert> = {}): Alert => ({
    id: 'al_o',
    kind: 'budget_over',
    cause: 'budget_over',
    projectId: 'p',
    jobId: 'job_o',
    agentIds: ['agt_o'],
    since: '2026-10-10T12:00:00Z',
    spent: 6,
    budget: 5,
    unit: 'usd',
    ...over,
  });
  const t = alertTitle(warn(), [A()]);
  check('an over-budget alert names the agent, the budget, and that it only warns', t.head === 'builder' && t.subject === 'is over its $5 daily budget — a warning only', `${t.head} ${t.subject}`);
  check('in tokens it says tokens', alertTitle(warn({ unit: 'tokens', budget: 500_000 }), [A()]).subject === 'is over its 500k-token daily budget — a warning only');
  const j = alertTitle(warn({ cause: 'job_budget_over', agentIds: [], budget: 50 }), [A({ role: 'architect' }), A({ id: 'agt_p', role: 'developer' }), A({ id: 'agt_q', role: 'tester', jobId: 'other' })]);
  check("a job's names the agents in it, since the job has no name on the wire", j.head === 'the architect · developer job' && j.subject === 'is over its $50 daily budget — a warning only', `${j.head} ${j.subject}`);
  check('the top bar has a word or two for each', alertWord(warn()) === 'over its daily budget' && alertWord(warn({ cause: 'job_budget_over' })) === 'job over its daily budget');
  check('an old pause on a token budget says so in tokens', failureSentence('budget_exhausted', A({ costUsd: 0, inputTokens: 600_000, outputTokens: 400_000, spentToday: { day: localDayOf(), usd: 0, tokens: 1_000_000 }, autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, budgetTokens: 500_000 } })) === 'was paused by its 500k-token daily budget, which only warns now — continue carries on');
}

console.log("\n· an agent's budget is coloured as it fills, like the daily budget (Amendment 125)");
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const A = (costUsd: number, budgetUsd: number | null, over: Partial<Agent> = {}): Agent => ({
    id: 'agt_c',
    jobId: 'job_c',
    projectId: 'p',
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 's',
    status: 'working',
    blockMode: null,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    // The colour is read from what it spent today (Amendment 129).
    spentToday: { day: localDayOf(), usd: costUsd, tokens: 0 },
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const tone = (spent: number, budget = 100) => budgetOf(A(spent, budget))!.tone;

  check('green with room, as the daily meter', tone(0) === 'ok' && tone(74.99) === 'ok');
  check('yellow from 75%', tone(75) === 'warn' && tone(94.99) === 'warn');
  check('red from 95%, and from the budget on', tone(95) === 'over' && tone(100) === 'over' && tone(180) === 'over');
  check('the same thresholds and the same function as the status bar, at every step', Array.from({ length: 241 }, (_, i) => i / 100).every((f) => toneOf(f) === dailyMeter(f * 10, 10).tone && budgetOf(A(f * 10, 10))!.tone === toneOf(f)));
  check('the thresholds are the status bar\'s own: 75% and 95%', WARN_AT === 0.75 && OVER_AT === 0.95);
  check('it says over from 100%, not from 95%', budgetOf(A(96, 100))!.over === false && budgetOf(A(96, 100))!.tone === 'over' && budgetOf(A(100, 100))!.over === true);
  const tok = (spent: number) => budgetOf(A(0, null, { inputTokens: spent - 1_000, outputTokens: 1_000, spentToday: { day: localDayOf(), usd: 0, tokens: spent }, autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, budgetTokens: 500_000 } }))!;
  check('a token budget colours the same way', tok(300_000).tone === 'ok' && tok(375_000).tone === 'warn' && tok(475_000).tone === 'over' && tok(612_000).tone === 'over' && tok(612_000).over === true);
  check('an agent with no budget has no colour to show', budgetOf(A(40, null)) === null);
  check('the bar stays full past the budget; the percentage does not', budgetOf(A(120, 100))!.fraction === 1 && budgetOf(A(120, 100))!.pct === 120);

  // The same three tokens as the status bar's bar, in every place it is drawn. Tokens only, so both themes
  // read: --done, --need and --fail already clear 4.5:1 on every surface in the contrast checks above.
  const shell = src('../shell/shell.css');
  const bar = (css: string, sel: string, tone: string): string | null =>
    new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')}\\[data-tone='${tone}'\\] i \\{[^}]*background:\\s*([^;]+);`).exec(css)?.[1] ?? null;
  check('the status bar fills green, then var(--need), then var(--fail)', /\.sh-spend-bar i \{[^}]*background: var\(--done\)/.test(shell) && /\.sh-spend\[data-tone='warn'\] \.sh-spend-bar i \{\s*background: var\(--need\)/.test(shell) && /\.sh-spend\[data-tone='over'\] \.sh-spend-bar i \{\s*background: var\(--fail\)/.test(shell));
  const agentCss = src('../agent/agent.css');
  const fleetCss = src('../fleet/fleet.css');
  const fills: [string, string, string][] = [
    [agentCss, '.ag-meter', 'the composer and its folded line'],
    [agentCss, '.ag-tab-bar', "the agent's tab"],
    [fleetCss, '.pj-meter', "the Project screen's lane"],
    [fleetCss, '.fl-arow-bud', "the Fleet card's agent row"],
  ];
  for (const [css, sel, where] of fills) {
    check(`${where} fills with the status bar's tokens`, /var\(--done\)/.test(new RegExp(`${sel.replace('.', '\\.')} i \\{[^}]*`).exec(css)?.[0] ?? '') && bar(css, sel, 'warn') === 'var(--need)' && bar(css, sel, 'over') === 'var(--fail)', `${bar(css, sel, 'warn')} ${bar(css, sel, 'over')}`);
  }
  check("the details panel's bar fills in them too, and its figure goes red when over", /\.ag-bar\[data-tone='warn'\] i \{[^}]*var\(--need\)/.test(agentCss) && /\.ag-bar\[data-tone='over'\] i \{[^}]*var\(--fail\)/.test(agentCss) && /\.ag-bar-pct\[data-tone='over'\] \{\s*color: var\(--fail\)/.test(agentCss));
  const rules = [agentCss, fleetCss].flatMap((css) => css.match(/[^{}]*\[data-tone='(?:ok|warn|over)'\][^{}]*\{[^}]*\}/g) ?? []).filter((r) => /ag-(?:meter|tab-bar|bar|budget|summary)|pj-(?:meter|budget)|fl-arow-bud/.test(r));
  check('and none of those rules has a colour of its own', rules.length >= 14 && rules.every((r) => !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(r)), `${rules.length} rules`);

  const insp = src('../agent/inspector.tsx');
  const comp = src('../agent/composer.tsx');
  const lane = src('../fleet/lane.tsx');
  const card = src('../fleet/card.tsx');
  const screen = src('../agent/agent.tsx');
  check("the details panel's bar and figure carry the tone", /<div className="ag-bar" data-tone=\{budget\.tone\}>/.test(insp) && /className="ag-bar-pct" data-tone=\{budget\.tone\}/.test(insp));
  check("the composer's box, figure and meter carry it, and so does the folded line", /<label className="ag-budget-box" data-tone=\{spend\?\.tone\}>/.test(comp) && /className="ag-budget-spent" data-tone=\{spend\?\.tone\}/.test(comp) && /className="ag-meter"/.test(comp) && /className=\{`ag-summary\$\{summaryAlarm \? ' is-alarm' : ''\}`\} data-tone=\{spend\?\.tone\}/.test(comp));
  check('an unsafe mode is still the alarm, and the budget no longer is', /const summaryAlarm = current\?\.danger === true;/.test(comp));
  check("the agent's tab draws its bar", /className="ag-tab-bar" data-tone=\{t\.budget\.tone\}/.test(screen));
  check("the Project lane's meter and figure carry the tone, and say over", (lane.match(/data-tone=\{budget\.tone\}/g) ?? []).length === 4 && /budget\.over \? ' · over' : ''/.test(lane));
  check("the Fleet card's agent row draws its meter", /className="fl-arow-bud" data-tone=\{budget\.tone\}/.test(card));
  check('nothing is still marked by the old amber/red is-over class', !/is-over/.test(insp + comp + lane) && !/\.ag-budget-box\.is-over|\.ag-bar\.is-over|\.pj-meter\.is-over/.test(agentCss + fleetCss));
}

console.log('\n· the orchestrator of an orchestrated stack looks different, in neutral ink, wherever agents are shown (Amendment 128)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tokens = src('../../../shared/src/tokens.css');
  const themeOf = (selector: string): Map<string, string> => {
    const at = tokens.indexOf(`${selector} {`);
    const body = at === -1 ? '' : tokens.slice(at, tokens.indexOf('}', at));
    return new Map([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
  };
  const dark = themeOf(':root');
  const light = new Map([...dark, ...themeOf(":root[data-theme='light'], [data-theme='light']")]);
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

  // The rules that style the orchestrator, from every stylesheet that has one.
  const sheets = ['../shell/ui.css', '../fleet/fleet.css', '../agent/agent.css', '../spawn/spawn.css'].map(src);
  const rules = sheets.flatMap((css) => css.match(/[^{}]*(?:is-orch|ui-orch)[^{}]*\{[^}]*\}/g) ?? []);
  check('the orchestrator is styled in all four places: the plan row, the lane, the Fleet row and the tab (and the mark itself)', rules.length >= 5 && ['.sp-areorder.is-orch', '.pj-lane.is-orch', '.fl-arow.is-orch', '.ag-tab.is-orch', '.ui-orch {'].every((sel) => rules.some((r) => r.includes(sel))), rules.map((r) => r.trim().split('{')[0]!.trim()).join(' | '));
  const used = [...new Set(rules.flatMap((r) => [...r.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!)))];
  check('none of them uses a status colour: --live, --done, --need, --fail, --you, --queue and --idle each mean something already', used.length > 0 && used.every((v) => !['live', 'done', 'need', 'fail', 'you', 'queue', 'idle'].includes(v)), used.join());
  check('nor a colour of its own', rules.every((r) => !/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(r)));
  check('only tokens the contrast checks measure, and the type scale', used.every((v) => ['ink', 'ink2', 'surf3', 'disp'].includes(v) || /^fs-/.test(v)), used.join());

  // Both themes: the mark's text and its edge can be seen.
  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    const text = ratio(theme.get('ink')!, theme.get('surf3')!);
    check(`${name}: the mark's --ink text on its --surf3 is readable (${text.toFixed(2)}:1)`, text >= 4.5);
    const edge = ['bg', 'surf', 'surf2'].map((b) => ratio(theme.get('ink2')!, theme.get(b)!));
    check(`${name}: its --ink2 edge stands out from the surfaces it sits on (${Math.min(...edge).toFixed(2)}:1 or more)`, edge.every((r) => r >= 3));
  }

  const lane = src('../fleet/lane.tsx');
  const card = src('../fleet/card.tsx');
  const ui = src('../shell/ui.tsx');
  check('the Project lane and the Fleet card\'s row ask the one rule, marksOrchestrator, and wear the mark', /marksOrchestrator\(agent, siblings\)/.test(lane) && /marksOrchestrator\(agent, siblings\)/.test(card) && /\{orchestrator && <OrchestratorMark short \/>\}/.test(lane) && /\{orchestrator && <OrchestratorMark short \/>\}/.test(card));
  check('the lane and the row carry the edge only with it', /\$\{orchestrator \? ' is-orch' : ''\}/.test(lane) && /\$\{orchestrator \? ' is-orch' : ''\}/.test(card));
  check('the mark says orchestrator in the plan, and is the diamond alone in a lane, a row and a tab, where the name is beside it; it explains itself', /◆\{short \? '' : ' orchestrator'\}/.test(ui) && /Runs the others/.test(ui));
}

console.log("\n· a budget counts what was spent today, and goes back to zero at midnight (Amendment 129)");
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const today = localDayOf();
  const yesterday = localDayOf(new Date(Date.now() - 86_400_000));
  const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;
  const mk = (id: string, over: Partial<Agent> = {}): Agent => ({
    id,
    jobId: J,
    projectId: P,
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 's',
    status: 'working',
    blockMode: null,
    costUsd: 31.4,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 25 },
    startedAt: null,
    endedAt: null,
    ...over,
  });

  // The rule itself, pure.
  const four = mk('d1', { spentToday: { day: today, usd: 4.1, tokens: 0 } });
  check('the bar is today\'s $4.10 of $25, not the $31.40 of its life', budgetOf(four)?.spent === 4.1 && budgetOf(four)?.cap === 25 && budgetOf(four)?.state === 'ok' && budgetOf(four)?.pct === 16);
  const stale = mk('d2', { spentToday: { day: yesterday, usd: 99, tokens: 0 } });
  check('a stamp from an earlier day reads 0: an open page is renewed at midnight before the daemon says anything', budgetOf(stale)?.spent === 0 && budgetOf(stale)?.state === 'ok' && budgetOf(stale)?.tone === 'ok' && budgetOf(stale)?.over === false);
  check('the day it is asked about can be given: the same stamp is spent on that day, and nothing the day after', budgetOf(stale, yesterday)?.spent === 99 && budgetOf(stale, yesterday)?.state === 'over' && budgetOf(stale, today)?.spent === 0);
  check('an agent with no stamp has spent nothing today (a recording, or one from before)', budgetOf(mk('d3'))?.spent === 0 && budgetState(mk('d3')) === 'ok');
  const tokensToday = mk('d4', { autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null, budgetTokens: 500_000 }, spentToday: { day: today, usd: 0, tokens: 612_000 }, inputTokens: 9_000_000 });
  check('a token budget reads today\'s tokens, not the lifetime ones', budgetOf(tokensToday)?.spent === 612_000 && budgetOf(tokensToday)?.state === 'over' && budgetOf(tokensToday)?.unit === 'tokens');
  check('an uncapped agent still has no bar, whatever it spent', budgetOf(mk('d5', { autonomy: { mode: 'default', allowedTools: [], disallowedTools: [], budgetUsd: null }, spentToday: { day: today, usd: 400, tokens: 0 } })) === null);
  check('localDayOf is the local YYYY-MM-DD', localDayOf(new Date(2031, 2, 5, 23, 59)) === '2031-03-05' && localDayOf(new Date(2031, 11, 31, 0, 0)) === '2031-12-31');

  // Folding a usage event into the agent.
  const A9 = 'agt_d129';
  send({ type: 'entities', agents: [mk(A9, { costUsd: 10, spentToday: { day: today, usd: 4, tokens: 0 } })] });
  const evFor = (payload: EventPayload): Event => ({ ...ev(payload), agentId: A9 });
  send({ type: 'events', events: [evFor({ kind: 'usage', costUsd: 13, inputTokens: 5, outputTokens: 5 })] });
  let a9 = store.select('d129a', (st) => st.agents.find((a) => a.id === A9));
  check("an event without the daemon's figure adds the growth of the lifetime one to what the tab had today", a9?.costUsd === 13 && near(a9?.spentToday?.usd, 7) && a9?.spentToday?.day === today, JSON.stringify(a9?.spentToday));
  send({ type: 'events', events: [evFor({ kind: 'usage', costUsd: 15, inputTokens: 5, outputTokens: 5, today: { day: today, usd: 9, tokens: 0 } })] });
  a9 = store.select('d129b', (st) => st.agents.find((a) => a.id === A9));
  check("one with the daemon's figure takes it as it is", near(a9?.spentToday?.usd, 9) && a9?.costUsd === 15, JSON.stringify(a9?.spentToday));
  send({ type: 'entities', agents: [mk(A9, { costUsd: 15, spentToday: { day: yesterday, usd: 20, tokens: 0 } })] });
  send({ type: 'events', events: [evFor({ kind: 'usage', costUsd: 16, inputTokens: 5, outputTokens: 5 })] });
  a9 = store.select('d129c', (st) => st.agents.find((a) => a.id === A9));
  check("a tab left open past midnight: yesterday's $20 is not carried into today, only the $1 that arrived", a9?.spentToday?.day === today && near(a9?.spentToday?.usd, 1), JSON.stringify(a9?.spentToday));
  send({ type: 'events', events: [evFor({ kind: 'usage', costUsd: 15, inputTokens: 5, outputTokens: 5 })] });
  a9 = store.select('d129d', (st) => st.agents.find((a) => a.id === A9));
  check('a figure that shrinks adds nothing', near(a9?.spentToday?.usd, 1));
  check('the fold is the shared one', /spentToday: spentAfterUsage\(a, p\)/.test(src('./store.ts')));

  // Words.
  check('the job\'s old hold reads daily, and says continue carries on', failureSentence('job_budget_reached') === "was held for its job's daily budget, which only warns now — continue carries on");
  const oldCard = alertTitle({ id: 'b', kind: 'budget', cause: 'budget_exhausted', projectId: P, jobId: J, agentIds: ['d6'], since: new Date().toISOString() }, [mk('d6')]);
  check('the card of an agent the old ceiling paused says nothing about renewing', /continue carries on/.test(oldCard.subject) && !/renewed/.test(oldCard.subject), oldCard.subject);

  // The screens say daily, and read today's figures.
  const comp = src('../agent/composer.tsx');
  const insp = src('../agent/inspector.tsx');
  const card = src('../attention/AlertCard.tsx');
  const spawn = src('../spawn/route.tsx');
  // Amendment 146: today's figure and the lifetime one side by side, from `agentPairWords`.
  check('the composer counts today: its spent figure and its folded line are today\'s, and the lifetime one is beside it', /spentOn\(agent\)/.test(comp) && /agentPairWords\(agent, caps\.costUsd\)/.test(comp) && /\{pair\.today\}/.test(comp) && /· \{pair\.total\}/.test(comp) && !/agent\.costUsd >= /.test(comp));
  check('the composer\'s budget fields say per day', /Budget in dollars per day/.test(comp) && /Budget in tokens per day/.test(comp));
  check('the details panel shows today against the budget, and today and the lifetime spend as a plain line', /`today \$\{fmtMoney\(budget\.spent\)\} of \$\{fmtMoney\(budget\.cap\)\}`/.test(insp) && />spent</.test(insp) && /\{pair\.today\} · \{pair\.total\}/.test(insp));
  check('Needs You says daily on the warning, and an old pause says continue carries on with no raise and nothing continues by itself', /label: 'Paused by its budget'/.test(card) && /label: 'Over its daily budget'/.test(card) && /continue carries it on as it is, with\s+no raise first/.test(card) && /Nothing continues it by itself/.test(card) && !/renewed/.test(card));
  check('Spawn\'s pill says per agent per day, with a tooltip that says it starts again at midnight', /⏱ budget per agent per day \$/.test(spawn) && /starts again at midnight/.test(spawn));
  check('nothing on a screen decides from the lifetime figure: the budget is read through budgetOf', !/costUsd\s*>=\s*\w*(cap|budget)/i.test(comp + insp + src('./../fleet/lane.tsx') + src('./../fleet/card.tsx')));
}

console.log('\n37 · only a project you have not looked at since it finished says FINISHED (Amendment 130)');
{
  const src = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');

  // The rule: the loud mark is the unseen one; at rest a project is quiet.
  check('a project with no agents never ran anything: "no agents", whatever its roll-up says', restOf('done', 0, false) === 'empty' && restWord('empty') === 'no agents');
  check('and not even a stray unseen job makes an empty project finished', restOf('done', 0, true) === 'empty');
  check('a done project you have looked at is quiet: "done"', restOf('done', 3, false) === 'done' && restWord('done') === 'done');
  check('a done project with a job you have not seen keeps its status word, so the loud FINISHED goes beside it', restOf('done', 3, true) === 'status' && restWord('status') === null);
  const live: AgentStatus[] = ['working', 'blocked', 'failed', 'queued', 'paused', 'stopped'];
  check('every other status is as it was, seen or not', live.every((st) => restOf(st, 2, false) === 'status' && restOf(st, 2, true) === 'status'));

  // The screens draw it, and nothing at project level still says finished for every done project.
  const card = src('../fleet/card.tsx');
  const project = src('../fleet/project.tsx');
  check('the Fleet card reads the rest and draws its stripe from it', /restOf\(status, agents\.length, unseen\.length > 0\)/.test(card) && /rest === 'status' \? key : 'idle'/.test(card));
  // Amendment 194: the card's inline headline is `headlineTags` now; the same cases, through the rule.
  const headOf = (...a: Parameters<typeof headlineTags>): string => headlineTags(...a).map((t) => `${t.word}/${t.tone}`).join();
  check(
    'and its headline is the loud tag when unseen, else the quiet word',
    /headlineTags\(statuses, blocked, unseen\)\.map\(\(t\) => \(\s*<Tag key=\{t\.word\} tone=\{t\.tone\}>/.test(card) &&
      headOf(['done', 'done'], false, [{ status: 'done' }]) === 'finished/done' &&
      headOf(['done', 'done'], false, []) === 'done/idle' &&
      headOf(['failed', 'done'], false, []) === 'failed/fail',
  );
  check('the Project screen does the same in its header and on each job group, and the group never says finished twice', /restOf\(status, agents\.length, jobs\.some\(finishedHere\)\)/.test(project) && /restOf\(worstOf\(agents, alerts\), agents\.length, finished\)/.test(project) && /\) : finished \? null : \(/.test(project));
  check('no project-level tag draws STATUS_WORD for a done project without going through the rest', !/<Tag tone=\{STATUS_KEY\[(status|worstOf\(agents, alerts\))\]\}>\{STATUS_WORD/.test(card + project));
  check('the unseen mark itself is untouched: still the filled finished tag (Amendment 87)', headOf(['done'], false, [{ status: 'done' }]) === 'finished/done' && headOf(['failed'], false, [{ status: 'failed' }]) === 'finished/fail' && /<Tag tone=\{job\.status === 'failed' \? 'fail' : 'done'\}>finished<\/Tag>/.test(project));
}

console.log('\n38 · the retry delays are a setting (Amendment 140); the budget ceiling and midnight are not (Amendment 180)');
{
  // The delays: the daemon's rule, said as a sentence in the field.
  check('the default reads as the setting writes it', retryDelaysShown(null) === '5, 15, 30, 60, 300' && retryDelaysShown('garbage') === '5, 15, 30, 60, 300');
  check('one to five whole seconds, each 1 to 1800, are taken, spaces or none', ['5', '1,1800', '2, 7', '5,15,30,60,300', ' 10 , 20 '].every((v) => retryDelaysFieldProblem(v) === null));
  const bad = ['', '0', '1801', '2.5', 'soon', '5,,15', '-5', '1,2,3,4,5,6'];
  check('anything else says why, before it is sent', bad.every((v) => retryDelaysFieldProblem(v) === 'One to 5 whole numbers of seconds, separated by commas, each from 1 to 1800.'), bad.map((v) => retryDelaysFieldProblem(v)).join(' | '));
  check('what is written is tidied, and the default is written as nothing', retryDelaysValue('2,7') === '2, 7' && retryDelaysValue(' 5,15, 30,60,300 ') === null);
  check('the hint says the waits and the tries', retryDelaysWords(null) === '5 s, 15 s, 30 s, 1 min, 5 min: five tries, then the agent has failed' && retryDelaysWords('90') === '90 s: one try, then the agent has failed', retryDelaysWords(null));

  // The rows, on Settings (9), in the slot row's pattern.
  const route = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const rowOf = (name: string): string => {
    const i = route.indexOf(`function ${name}()`);
    return i === -1 ? '' : route.slice(i, route.indexOf('\nfunction ', i + 10));
  };
  for (const [name, key, prob] of [['RetryDelaysRow', 'RETRY_DELAYS_KEY', 'retryDelaysFieldProblem']] as const) {
    const r = rowOf(name);
    check(
      `${name}: a draft, checked as it is typed, written on Enter or blur, put back by Esc, with a hint or the problem`,
      r.includes(`useSetting(${key})`) && r.includes(`${prob}(draft)`) && /onBlur=\{commit\}/.test(r) && /e\.key === 'Enter'\) commit\(\)/.test(r) && /e\.key === 'Escape'\) setDraft\(null\)/.test(r) && /className="st-err"/.test(r) && /className="st-dim"/.test(r),
    );
  }
  check('the delays sit under Agents; Spend has no ceiling or midnight row', /<SlotsSection \/>\s*<StacksRow \/>\s*<RetryDelaysRow \/>/.test(route) && /<SpendSection \/>\s*<\/Section>/.test(route) && !/CeilingRow|MidnightRow|budgetCeiling|budgetResumeAtMidnight/.test(route));

  // The keys are the daemon's: the same names its rules are registered under.
  const daemonRetry = readFileSync(new URL('../../../daemon/src/session/retry.ts', import.meta.url), 'utf8');
  const daemonBudget = readFileSync(new URL('../../../daemon/src/session/budget.ts', import.meta.url), 'utf8');
  check(
    'the daemon has a rule for the delays, from the same shared function, and none for a ceiling',
    RETRY_DELAYS_KEY === 'conductor.retryDelays' &&
      daemonRetry.includes('settingRule(RETRY_DELAYS_KEY, retryDelaysProblem)') &&
      !/settingRule\(|BUDGET_CEILING_KEY|BUDGET_RESUME_KEY/.test(daemonBudget),
  );
}

console.log('\n· today and all-time totals for each agent, project and the fleet (Amendment 146)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const today = localDayOf();
  const yesterday = localDayOf(new Date(Date.now() - 86_400_000));
  const mk = (id: string, over: Partial<Agent> = {}): Agent => ({
    id,
    jobId: J,
    projectId: P,
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 's',
    status: 'done',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 25 },
    startedAt: null,
    endedAt: null,
    ...over,
  });
  const totals = () => store.select(`tot${seq++}`, (s) => ({ today: s.costToday, total: s.costTotal, projects: s.projectSpend }));

  // ── the store: an old snapshot, a new one, the frame ──
  send({ type: 'hello', seq: 0, snapshot: { ...snapshot, costToday: 1.5 } });
  check('a snapshot from before 146 still applies: today as it was, no total and no projects', totals().today === 1.5 && totals().total === null && totals().projects === null, JSON.stringify(totals()));
  const ps = [{ projectId: P, today: 1.5, total: 9.25, tokensToday: 0, tokensTotal: 0 }];
  send({ type: 'hello', seq: 0, snapshot: { ...snapshot, costToday: 1.5, costTotal: 40, projectSpend: ps } });
  check("a snapshot with them carries the fleet's total and each project's pair", totals().total === 40 && totals().projects?.[0]?.total === 9.25);
  send({ type: 'cost', costToday: 2, costTotal: 40.5, projectSpend: [{ ...ps[0]!, today: 2, total: 9.75 }] });
  check('a cost frame moves today, the total and the projects together', totals().today === 2 && totals().total === 40.5 && totals().projects?.[0]?.total === 9.75);
  send({ type: 'cost', costToday: 0 });
  check('a cost frame from before 146 moves today alone and leaves the totals the tab had', totals().today === 0 && totals().total === 40.5 && totals().projects?.[0]?.total === 9.75, JSON.stringify(totals()));
  send({ type: 'hello', seq: 0, snapshot });

  // ── the status bar ──
  const shell = src('../shell/shell.tsx');
  check(
    "the bar draws today's spend (with its meter) and then the month, and no all-time total (Amendment 187)",
    /const \{ slots, costToday, costMonth, seq \} = useStatusBar\(\)/.test(shell) && /<DailySpend costToday=\{costToday\} costMonth=\{costMonth\} \/>/.test(shell) &&
      /\{m\.label\}\s*<\/span>\s*\{month\}\s*<\/span>/.test(shell) && /today<\/span>\s*\{month\}\s*<\/span>/.test(shell) &&
      !/costTotal|TOTAL_TITLE|totalWords/.test(shell) && !/costTotal/.test(src('./store.ts').split('export function useStatusBar')[1]!.split('\n}')[0]!),
  );

  // ── a project's pair ──
  check('a project reads "today $a · total $b"', JSON.stringify(projectPairWords({ today: 1.2, total: 8.4, tokensToday: 0, tokensTotal: 0 })) === JSON.stringify({ today: 'today $1.20', total: 'total $8.40' }));
  check('in tokens where nothing reported dollars', JSON.stringify(projectPairWords({ today: 0, total: 0, tokensToday: 3_400, tokensTotal: 41_000 })) === JSON.stringify({ today: 'today 3.4k tok', total: 'total 41k tok' }));
  check('and both, where it ran on both kinds of engine', projectPairWords({ today: 1, total: 2, tokensToday: 950, tokensTotal: 12_500 }).total === 'total $2.00 + 12.5k tok');
  check('a project that spent nothing reads $0.00, not tokens', projectPairWords({ today: 0, total: 0, tokensToday: 0, tokensTotal: 0 }).total === 'total $0.00');
  const here = [mk('a1', { costUsd: 3, spentToday: { day: today, usd: 1, tokens: 0 } }), mk('a2', { costUsd: 2, spentToday: { day: yesterday, usd: 2, tokens: 0 } })];
  check("what the daemon keeps wins over the current agents' sum: a removed agent's spend stays", projectSpendOf(ps, P, here).total === 9.25);
  const fallback = projectSpendOf(null, P, [...here, mk('cp', { provider: 'copilot', inputTokens: 600, outputTokens: 400, spentToday: { day: today, usd: 0, tokens: 300 } }), mk('other', { projectId: 'prj_other', costUsd: 99 })]);
  check(
    "from a daemon before it, the project's current agents: lifetime dollars, today's, and a token engine's tokens",
    fallback.total === 5 && fallback.today === 1 && fallback.tokensToday === 300 && fallback.tokensTotal === 1000,
    JSON.stringify(fallback),
  );
  const proj = src('../fleet/project.tsx');
  check(
    "the Project screen's header and its column read the project's pair, not the current agents' costUsd",
    /projectPairWords\(projectSpendOf\(spendList, active \?\? '', agents\)\)/.test(proj) && /<span\s+className="pj-headspend"[\s\S]*?<b>\{spend\.today\}<\/b>\s*\{spend\.month && ` · \$\{spend\.month\}`\} · \{spend\.total\}/.test(proj) &&
      /<span>spend<\/span>\s*<span[^>]*>\s*\{spend\.today\}\s*\{spend\.month && ` · \$\{spend\.month\}`\} · \{spend\.total\}/.test(proj) && !/a\.costUsd, 0\)/.test(proj),
  );
  check("and so does each Fleet card's footer", /projectPairWords\(projectSpendOf\(spendList, project\.id, agents\)\)/.test(src('../fleet/card.tsx')) && /className="fl-card-spend"/.test(src('../fleet/card.tsx')));
  const facts = sortFacts([{ id: P }], here, [], ps);
  check("most spent sorts by the project's kept total, and by its agents' sum without one", facts.get(P)?.spend === 9.25 && sortFacts([{ id: P }], here, []).get(P)?.spend === 5);

  // ── an agent's pair ──
  const claude = mk('c1', { costUsd: 31.4, spentToday: { day: today, usd: 4.1, tokens: 0 } });
  check("an agent reads today's spend and its whole life's side by side", JSON.stringify(agentPairWords(claude, true)) === JSON.stringify({ today: 'today $4.10', total: 'total $31.40' }));
  check('yesterday\'s stamp is nothing today, and the total stands', JSON.stringify(agentPairWords(mk('c2', { costUsd: 31.4, spentToday: { day: yesterday, usd: 4.1, tokens: 0 } }), true)) === JSON.stringify({ today: 'today $0.00', total: 'total $31.40' }));
  check('an engine that reports no dollars says tokens: today\'s, and its input plus output in all', JSON.stringify(agentPairWords(mk('t1', { provider: 'copilot', inputTokens: 160_000, outputTokens: 70_000, spentToday: { day: today, usd: 0, tokens: 110 } }), false)) === JSON.stringify({ today: 'today 110 tok', total: 'total 230k tok' }));
  check('an agent from before 129, with no stamp, has spent nothing today', agentPairWords(mk('old', { costUsd: 7 }), true).today === 'today $0.00');
  const lane = src('../fleet/lane.tsx');
  check(
    'the lane, the details panel and the composer show the pair where each showed one figure, in the unit capabilitiesOf says',
    /agentPairWords\(agent, dollars\)/.test(lane) && /\{pair\.today\} · \{pair\.total\}/.test(lane) && !/Spent over its whole life">/.test(lane) &&
      /agentPairWords\(agent, dollars\)/.test(src('../agent/inspector.tsx')) && /agentPairWords\(agent, caps\.costUsd\)/.test(src('../agent/composer.tsx')),
  );
  check('the budget meter still reads today', /budgetOf\(agent\)/.test(lane) && /budgetOf\(\{ \.\.\.agent, autonomy \}\)/.test(src('../agent/composer.tsx')));
  check(
    'the new classes are drawn with tokens only',
    ['../fleet/fleet.css', '../shell/shell.css', '../agent/agent.css'].every((f) => {
      const css = src(f);
      return ['.fl-card-spend', '.pj-headspend', '.pj-spendpair', '.sh-spend-pair', '.sh-spend-total', '.ag-budget-total']
        .map((c) => css.split(`${c} {`)[1]?.split('}')[0] ?? '')
        .every((body) => !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(body));
    }),
  );
}

console.log("\n· a Fleet card's agents fold, start folded, are kept per card, and what needs you stays (Amendment 173)");
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const mk = (id: string, over: Partial<Agent> = {}): Agent => ({
    id,
    jobId: J,
    projectId: P,
    role: 'builder',
    model: 'claude-opus-5',
    sdkSessionId: 's',
    status: 'working',
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 25 },
    startedAt: null,
    endedAt: null,
    ...over,
  });

  // Folded on first load: nothing stored, or anything broken, is every card folded.
  check('a card starts folded: nothing stored is folded', !agentsOpen(null, 'a') && !agentsOpen(null, 'b'));
  check('a broken setting is folded too, not an error', !agentsOpen('{x', 'a') && !agentsOpen('"a"', 'a') && !agentsOpen('[1,2]', 'a'));

  // Kept per card: two cards, one toggled.
  const one = toggleAgents(null, 'a');
  check('opening one card opens it and no other', agentsOpen(one, 'a') && !agentsOpen(one, 'b'), String(one));
  const both = toggleAgents(one, 'b');
  check('opening the second leaves the first open', agentsOpen(both, 'a') && agentsOpen(both, 'b'), String(both));
  const back = toggleAgents(both, 'a');
  check('folding the first leaves the second open', !agentsOpen(back, 'a') && agentsOpen(back, 'b'), String(back));
  check('folding the only open card removes the setting', toggleAgents(one, 'a') === null);

  // The stored text read back fresh, as a reload reads it, through the settings map.
  const was = readSetting(FLEET_AGENTS_KEY);
  writeSetting(FLEET_AGENTS_KEY, null);
  writeSetting(FLEET_AGENTS_KEY, toggleAgents(readSetting(FLEET_AGENTS_KEY), 'a'));
  const stored = readSetting(FLEET_AGENTS_KEY);
  check('the choice is a setting, and survives being read back', stored === '["a"]' && agentsOpen(stored, 'a') && !agentsOpen(stored, 'b'), String(stored));
  check('it is its own key, not the navigator\'s, so a card and a navigator node never share an id', (FLEET_AGENTS_KEY as string) !== NAV_TREE_KEY && FLEET_AGENTS_KEY.startsWith('conductor.'));
  writeSetting(FLEET_AGENTS_KEY, was);

  // What needs you is still there while folded, and counted on the toggle.
  const agents = [mk('w1'), mk('asks'), mk('blk', { status: 'blocked' }), mk('held', { status: 'done' }), mk('w2')];
  const pending = [{ agentId: 'asks' }];
  const alerts = [{ agentIds: ['held'] }];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();
  check('folded, only the agents that need you keep their rows, in their order', ids(shownAgents(agents, false, pending, alerts)) === 'asks,blk,held', ids(shownAgents(agents, false, pending, alerts)));
  check('open, every agent is listed, in its order', ids(shownAgents(agents, true, pending, alerts)) === 'w1,asks,blk,held,w2');
  check('folded with nothing waiting, no rows', shownAgents([mk('x'), mk('y')], false, [], []).length === 0);
  check('a request, a blocked status and an alert each need you; working does not', needsYou(agents[1]!, pending, []) && needsYou(agents[2]!, [], []) && needsYou(agents[3]!, [], alerts) && !needsYou(agents[0]!, pending, alerts));
  check('the toggle counts them', agentsToggleWords(5, 3) === '5 agents · 3 need you' && agentsToggleWords(4, 1) === '4 agents · 1 needs you');
  check('and says only the count when nothing waits', agentsToggleWords(1, 0) === '1 agent' && agentsToggleWords(12, 0) === '12 agents');

  // The card draws it.
  const card = src('../fleet/card.tsx');
  check('the card reads the setting and its project id', /agentsOpen\(useSetting\(FLEET_AGENTS_KEY\), project\.id\)/.test(card));
  check('and draws the rows shownAgents gives, not every agent', /shownAgents\(agents, listOpen, pending, allAlerts\)/.test(card) && /rows\.map\(\(a\) => \(\s*<AgentRow/.test(card) && !/agents\.map\(\(a\) => <AgentRow/.test(card));
  check('the toggle is a real button with aria-expanded, writing the setting', /<button\s+type="button"\s+className=\{`fl-card-fold[\s\S]*?aria-expanded=\{listOpen\}/.test(card) && /writeSetting\(FLEET_AGENTS_KEY, toggleAgents\(readSetting\(FLEET_AGENTS_KEY\), project\.id\)\)/.test(card));
  check('its Enter and Space stay its own, not the card\'s', /className=\{`fl-card-fold[\s\S]*?onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(card));
  check('it says the count and the needs-you count', /agentsToggleWords\(agents\.length, needing\)/.test(card) && /needsYou\(a, pending, allAlerts\)/.test(card));
  const css = src('../fleet/fleet.css');
  const rules = ['.fl-card-fold {', '.fl-card-fold:hover {', '.fl-card-fold.is-need {'].map((c) => css.split(c)[1]?.split('}')[0] ?? '');
  check('the toggle is drawn with tokens only, amber when one needs you', rules.every((b) => b !== '' && !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(b)) && /color: var\(--need\)/.test(rules[2]!));
}

console.log('\n39 · this month beside today, and a monthly budget beside the daily one (Amendment 182)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  check('the month meter keeps the daily colours: green, yellow from 75%, red from 95%', monthMeter(5, 10).tone === 'ok' && monthMeter(7.5, 10).tone === 'warn' && monthMeter(9.5, 10).tone === 'over' && monthMeter(30, 10).fraction === 1);
  check('it says spend of budget, this month', monthMeter(42.1, 100).label === '$42.10 of $100.00 this month', monthMeter(42.1, 100).label);
  check('under, what is left and that it resets on the 1st', monthMeter(40, 100).title === "40% of this month's budget, $60.00 left. Resets on the 1st.", monthMeter(40, 100).title);
  check('over, by how much, and that agents keep going', monthMeter(130, 100).title === "130% of this month's budget — $30.00 over. Agents keep going; it only warns.", monthMeter(130, 100).title);
  check('with no monthly budget the bar says "· $X this month"', monthWords(40.1) === '· $40.10 this month' && monthWords(0) === '· $0.00 this month');
  check('and its hover says from when', MONTH_TITLE === 'spent by every agent this month, from the 1st, in local time');
  const daemon = readFileSync(new URL('../../../daemon/src/daily.ts', import.meta.url), 'utf8');
  check("the monthly setting is the daemon's", MONTHLY_KEY === 'conductor.monthlyBudget' && daemon.includes("MONTHLY_KEY = 'conductor.monthlyBudget'"));
  const same = monthlyDraft('50', 50);
  const cleared = monthlyDraft('  ', 50);
  const set = monthlyDraft('75.5', null);
  const bad = monthlyDraft('-3', 50);
  check("a project's draft: unchanged sends nothing", 'send' in same && same.send === undefined && 'send' in monthlyDraft('', undefined) && (monthlyDraft('', undefined) as { send: unknown }).send === undefined);
  check('emptied sends null, a figure sends dollars', 'send' in cleared && cleared.send === null && 'send' in set && set.send === 75.5);
  check('anything else says why, before it is sent', 'problem' in bad && 'problem' in monthlyDraft('lots', null) && 'problem' in monthlyDraft('2000000', null));
  check("a project's pair carries its month when the daemon sends one", projectPairWords({ today: 1, month: 12.5, total: 40, tokensToday: 0, tokensMonth: 0, tokensTotal: 0 }).month === 'month $12.50');
  check('in tokens where nothing reported dollars', projectPairWords({ today: 0, month: 0, total: 0, tokensToday: 0, tokensMonth: 3_400, tokensTotal: 9_000 }).month === 'month 3.4k tok');
  check('and none from a daemon before it', projectPairWords({ today: 1, total: 2, tokensToday: 0, tokensTotal: 0 }).month === undefined);
  const shell = src('../shell/shell.tsx');
  // The figure itself is drawn by MonthFigure, beside its correction's mark (Amendment 206).
  const figure = src('../shell/monthfix.tsx');
  check(
    'the status bar ends with the month, after today: the meter with a budget, the figure without, nothing from an older daemon; no total follows it (Amendment 187)',
    /function MonthSpend\(\{ costMonth \}/.test(shell) && /parseBudget\(useSetting\(MONTHLY_KEY\)\)/.test(shell) && /if \(costMonth === null\) return null/.test(shell) &&
      /<MonthFigure costMonth=\{costMonth\} budget=\{budget\}/.test(shell) &&
      /title=\{monthTitle\(MONTH_TITLE, correction, now\)\}>\s*\{monthWords\(costMonth\)\}/.test(figure) && /className="sh-spend-month" data-tone=\{m\.tone\} title=\{monthTitle\(m\.title, correction, now\)\}/.test(figure) &&
      /\{month\}\s*<\/span>/.test(shell) && !/\{month\}\s*\{total\}/.test(shell) && !/ total`/.test(src('../shell/spend.ts')),
  );
  const css = src('../shell/shell.css');
  const month = ['.sh-spend-month {', ".sh-spend-month[data-tone='warn'] {", ".sh-spend-month[data-tone='over'] {"].map((c) => css.split(c)[1]?.split('}')[0] ?? '');
  check("its colours are the daily meter's, tokens only", month.every((b) => b !== '' && !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(b)) && /var\(--need\)/.test(month[1]!) && /var\(--fail\)/.test(month[2]!), month.join(' | '));
  const store = src('./store.ts');
  check('a cost frame moves the month, and an older one leaves it', /if \(frame\.costMonth !== undefined\) s\.costMonth = frame\.costMonth/.test(store) && /s\.costMonth = snap\.costMonth \?\? null/.test(store));
  const card = src('../fleet/card.tsx');
  check("a Fleet card's Edit sets the project's monthly budget, and its footer reads the month", /monthlyDraft\(monthly, project\.monthlyBudgetUsd\)/.test(card) && /monthlyBudgetUsd/.test(card) && /\{spend\.month && ` · \$\{spend\.month\}`\}/.test(card));
  const settings = src('../settings/route.tsx');
  check('Settings has the monthly budget beside the daily one', /function MonthlyField\(/.test(settings) && /writeSetting\(MONTHLY_KEY/.test(settings) && /<MonthlyField \/>/.test(settings));
}

console.log('\n40 · a monthly budget for each engine and each Claude route, in its own unit (Amendment 188)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  check('the labels name the engine and the route, never the cloud it is on', providerBudgetLabel('claude') === 'Claude' && providerBudgetLabel('claude/us') === 'Claude · us' && providerBudgetLabel('claude/direct') === 'Claude · no prefix' && providerBudgetLabel('copilot') === 'Copilot' && providerBudgetLabel('openrouter') === 'OpenRouter');
  const spend: ProviderSpend[] = [
    { key: 'claude', provider: 'claude', unit: 'usd', today: 1.5, month: 42.1 },
    { key: 'claude/us', provider: 'claude', route: 'us', unit: 'usd', today: 0, month: 12 },
    { key: 'copilot', provider: 'copilot', unit: 'tokens', today: 120_000, month: 5_200_000 },
    { key: 'openrouter', provider: 'openrouter', unit: 'tokens', today: 0, month: 0 },
  ];
  const rows = providerSpendRows(spend, { claude: 100, copilot: 5_000_000 });
  check('By provider has a row for each, in the order the daemon sent', rows.map((r) => r.name).join() === 'Claude,Claude · us,Copilot,OpenRouter', rows.map((r) => r.name).join());
  check('Claude in dollars, Copilot in tokens', rows[0]!.today === '$1.50' && rows[0]!.month === '$42.10' && rows[2]!.today === '120k tok' && rows[2]!.month === '5.2M tok', JSON.stringify(rows));
  check('a budget reads with its share, and over when reached; none is a dash', rows[0]!.budget === '$100.00 · 42%' && !rows[0]!.over && rows[2]!.budget === '5M tok · 104%, over' && rows[2]!.over && rows[3]!.budget === '—', JSON.stringify(rows.map((r) => r.budget)));
  check('a route is marked as one, and nothing shows before the daemon sends figures', rows[1]!.route && !rows[0]!.route && providerSpendRows(null, {}).length === 0);
  check("the cell's share is the month's against the budget", providerBudgetCell(50, 50, 'usd') === '$50.00 · 100%, over' && providerBudgetCell(1, null, 'tokens') === '—');
  check('the note says it is every project, and how a route is read', /Every project’s/.test(PROVIDER_SPEND_NOTE) && /\.anthropic\./.test(PROVIDER_SPEND_NOTE) && !/bedrock/i.test(PROVIDER_SPEND_NOTE));
  const metrics = src('../metrics/route.tsx');
  check(
    'Metrics draws By provider with Provider, Today, This month and Monthly budget, from the daemon and the setting',
    /providerSpendRows\(useProviderSpend\(\), parseProviderBudgets\(useSetting\(PROVIDER_BUDGETS_KEY\)\)\)/.test(metrics) && /<ProviderSpendTable rows=\{providerRows\} \/>/.test(metrics) &&
      /aria-label="by provider"/.test(metrics) && /<h2 className="mt-h">By provider<\/h2>/.test(metrics) &&
      ['Provider', 'Today', 'This month', 'Monthly budget'].every((h) => new RegExp(`>\\s*${h}\\s*</th>`).test(metrics)),
  );

  // ── Settings: one row each, written as one setting ──
  check('dollars as the daily field takes them; empty is none', JSON.stringify(providerBudgetDraft('25', 'usd')) === '{"value":25}' && JSON.stringify(providerBudgetDraft(' ', 'usd')) === '{"value":null}' && 'problem' in providerBudgetDraft('-1', 'usd') && 'problem' in providerBudgetDraft('lots', 'usd'));
  check('tokens as people type them', JSON.stringify(providerBudgetDraft('500k', 'tokens')) === '{"value":500000}' && JSON.stringify(providerBudgetDraft('2M', 'tokens')) === '{"value":2000000}' && 'problem' in providerBudgetDraft('0', 'tokens') && 'problem' in providerBudgetDraft('lots', 'tokens') && 'problem' in providerBudgetDraft('2000000000000', 'tokens'));
  check('one row sets its key and keeps the others', withProviderBudget('{"claude":50}', 'copilot', 1000) === '{"claude":50,"copilot":1000}' && withProviderBudget(null, 'claude/us', 10) === '{"claude/us":10}');
  check('emptied takes it out, and the last one out clears the setting', withProviderBudget('{"claude":50,"copilot":1000}', 'claude', null) === '{"copilot":1000}' && withProviderBudget('{"claude":50}', 'claude', null) === null);
  check("a row's month is in its unit, against its budget when there is one", providerMonthWords(4.27, null, 'usd') === '$4.27 this month' && providerMonthWords(1_200_000, 5_000_000, 'tokens') === '1.2M tokens of 5M tokens this month · 24%' && providerMonthWords(10, 10, 'usd') === '$10.00 of $10.00 this month · 100%, over');
  const settings = src('../settings/route.tsx');
  check(
    'Settings has "monthly budget by provider" under the monthly budget, a row and a field each, named in its unit',
    /<MonthlyField \/>\s*<ProviderBudgets \/>/.test(settings) && /aria-label="monthly budget by provider"/.test(settings) &&
      /aria-label=\{`\$\{name\} monthly budget, in \$\{unit === 'usd' \? 'dollars' : 'tokens'\}`\}/.test(settings) &&
      /writeSetting\(PROVIDER_BUDGETS_KEY, withProviderBudget\(stored, row\.key, read\.value\)\)/.test(settings) && /providerMonthWords\(row\.month, budget, unit\)/.test(settings),
  );
  const daemon = src('../../../daemon/src/daily.ts');
  check("the setting is the daemon's, and it refuses what Settings would", PROVIDER_BUDGETS_KEY === 'conductor.monthlyBudget.providers' && /settingRule\(PROVIDER_BUDGETS_KEY, providerBudgetsProblem\)/.test(daemon));
  check('the status bar shows no engine figures', !/providerSpend|ProviderSpend/.test(src('../shell/shell.tsx')));
  const store = src('./store.ts');
  check('a cost frame moves the figures, and an older daemon leaves none', /if \(frame\.providerSpend !== undefined\) s\.providerSpend = frame\.providerSpend/.test(store) && /s\.providerSpend = snap\.providerSpend \?\? null/.test(store), store.match(/.*providerSpend.*/g)?.join(' | '));

  // ── the alert: named, and in its unit ──
  const reached = (provider: string, unit: 'usd' | 'tokens', spent: number, budget: number): Alert => ({
    id: `monthly:2036-05:provider:${provider}`, kind: 'monthly_budget', cause: 'provider monthly budget reached', projectId: null, jobId: null, agentIds: [], since: '2036-05-20T12:00:00Z', spent, budget, provider, unit,
  });
  const uk = reached('claude/uk', 'usd', 10, 10);
  const cp = reached('copilot', 'tokens', 5_100_000, 5_000_000);
  check('its title names the route or the engine', alertTitle(uk, []).head === 'Claude · uk' && alertTitle(cp, []).subject === 'reached its monthly budget');
  check("its notice says whose month, not a project's", alertNotice(cp, [], []).title === `Copilot · ${alertNotice(reached('claude', 'usd', 1, 1), [], []).title.split(' · ').slice(1).join(' · ')}` && alertNotice(uk, [], []).title.startsWith('Claude · uk · '), alertNotice(cp, [], []).title);
  check('its note says it only warns, and where to raise it', /A warning only: agents on Copilot keep going/.test(monthlyNote(null, 'copilot')) && /monthly budget by provider/.test(monthlyNote(null, 'copilot')) && monthlyNote(null) !== monthlyNote(null, 'copilot'));
  const card = src('../attention/AlertCard.tsx');
  check(
    'the card names the provider and gives tokens in tokens',
    /<Kv k="provider" v=\{providerBudgetLabel\(alert\.provider\)\} \/>/.test(card) && /monthWord\(alert\.spent, alert\.unit\)\} of \$\{monthWord\(alert\.budget, alert\.unit\)/.test(card) &&
      /unit === 'tokens' \? `\$\{tokenWords\(n\)\} tokens` : fmtMoney\(n\)/.test(card) && /monthlyNote\(project, alert\.provider\)/.test(card),
  );
}

console.log('\n41 · an agent whose tries are spent waits for the model to come back, and says so (Amendment 192)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const T0 = Date.UTC(2026, 10, 2, 14, 2, 0);
  const at = (ms: number): string => new Date(ms).toISOString();
  const hm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ag = (id: string, status: AgentStatus): Agent => ({
    id,
    jobId: J,
    projectId: P,
    role: `role ${id}`,
    model: 'claude-opus-5',
    sdkSessionId: 'sess',
    status,
    blockMode: null,
    costUsd: 1,
    inputTokens: 10,
    outputTokens: 10,
    dependsOn: [],
    autonomy: { mode: 'acceptEdits', allowedTools: [], disallowedTools: [], budgetUsd: 5 },
    startedAt: null,
    endedAt: null,
  });
  const waitNote = `can't reach the model${MODEL_WAIT_SUFFIX}`;
  const waitEv = (provider = 'claude', cause: 'unreachable' | 'throttled' | 'server' = 'unreachable'): Event =>
    ev({ kind: 'status', status: 'paused', error: waitNote, outage: { provider, cause, reason: 'api_error' } }, T0);
  const outage = (over: Partial<Alert> = {}): Alert => ({
    id: `connection:outage:claude:${at(T0)}`,
    kind: 'connection',
    cause: 'unreachable',
    projectId: P,
    jobId: J,
    agentIds: ['o_1', 'o_2'],
    since: at(T0),
    provider: 'claude',
    waiting: 2,
    nextCheckAt: at(T0 + 45 * 60_000),
    ...over,
  });

  check(
    "the card's line: why, since when, who waits and the next check",
    outageLine(outage()) === `can't reach the model since ${hm(T0)} — 2 agents waiting, next check ${hm(T0 + 45 * 60_000)}`,
    outageLine(outage()),
  );
  check(
    '"checking now" while a check runs, one agent in the singular, and a usage limit\'s reset',
    outageLine(outage({ nextCheckAt: undefined, waiting: 1, cause: 'throttled', limitResetsAt: at(T0 + 3_600_000) })) ===
      `the model is busy since ${hm(T0)} — 1 agent waiting, checking now, the limit resets at ${hm(T0 + 3_600_000)}`,
    outageLine(outage({ nextCheckAt: undefined, waiting: 1, cause: 'throttled', limitResetsAt: at(T0 + 3_600_000) })),
  );
  check('a time it cannot read is a dash, not a throw', /since — /.test(outageLine(outage({ since: 'not a time' }))));
  const agents = [ag('o_1', 'paused'), ag('o_2', 'paused')];
  const title = alertTitle(outage(), agents);
  check('its title is that line, then who waits', title.head === outageLine(outage()) && title.subject === 'role o_1 · role o_2', JSON.stringify(title));
  check(
    'the top bar says the provider is down; the SDK\'s own retries still read as before',
    alertWord(outage()) === 'Claude down' && alertWord(outage({ provider: 'copilot' })) === 'Copilot down' &&
      alertWord({ kind: 'connection', cause: 'unreachable' }) === 'no model API' && alertWord({ kind: 'connection', cause: 'unreachable', gaveUp: true }) === 'model API gave up',
  );
  check('an outage card is one that counts who waits', isOutage(outage()) && !isOutage({ kind: 'connection' }) && !isOutage({ kind: 'reconnecting', waiting: 1 }));
  const acts = alertActions(outage(), agents);
  check(
    'its buttons: retry now and stop waiting, for the provider, then open; no dismiss, as it clears itself',
    JSON.stringify(acts) === JSON.stringify([{ id: 'check_now', provider: 'claude' }, { id: 'stop_waiting', provider: 'claude', agents: 2 }, { id: 'open', agentId: 'o_1' }]),
    JSON.stringify(acts),
  );
  const card = src('../attention/AlertCard.tsx');
  check(
    'the card runs them on the outage routes, says what each does, and has its own note',
    /checkOutageNow\(a\.provider\)/.test(card) && /stopWaitingOutage\(a\.provider\)/.test(card) && /case 'check_now':\s*return 'retry now'/.test(card) && /case 'stop_waiting':\s*return 'stop waiting'/.test(card) &&
      /a\.id === 'check_now' \|\|/.test(card) && /isOutage\(alert\) && \(/.test(card) && /alert\.kind === 'connection' && !isOutage\(alert\)/.test(card),
  );
  const ends = src('../agent/endpoints.ts');
  check('…which are the daemon\'s', /`\/api\/outages\/\$\{encodeURIComponent\(provider\)\}\/retry-now`/.test(ends) && /`\/api\/outages\/\$\{encodeURIComponent\(provider\)\}\/stop-waiting`/.test(ends));

  check('a paused agent whose last status is the wait is waiting for its provider', JSON.stringify(waitingForModel([waitEv()])) === '{"provider":"claude","cause":"unreachable"}');
  check(
    'a later status ends it, and a pause of yours is not it',
    waitingForModel([waitEv(), ev({ kind: 'status', status: 'queued', error: 'the model answered a check — trying again' }, T0 + 1)]) === null &&
      waitingForModel([ev({ kind: 'status', status: 'paused' }, T0)]) === null && waitingForModel([]) === null &&
      waitingForModel([waitEv(), ev({ kind: 'text', text: 'hi' }, T0 + 1)])?.provider === 'claude',
  );
  const line = currentAction(ag(A, 'paused'), [waitEv()], [], [], T0 + 1_000);
  check('the agent line says it waits for the model, and that it carries on by itself; amber', line.head === 'waiting for the model' && line.subject === 'Claude — it carries on by itself' && line.tone === 'need', JSON.stringify(line));
  check('a paused agent that is not waiting still reads paused', currentAction(ag(A, 'paused'), [], [], [], T0).head === 'paused');
  const bar = reconnectBar(ag(A, 'paused'), [waitEv('copilot', 'server')], T0);
  check(
    "the agent screen's bar: waiting for the provider to come back, and why",
    bar !== null && bar.waiting && bar.needs && bar.text === 'Waiting for Copilot to come back' && bar.why.startsWith('the model API is failing — ') && /it carries on by itself when it answers$/.test(bar.why),
    JSON.stringify(bar),
  );
  check('…none for a paused agent that is not waiting, and the retry bar is as it was', reconnectBar(ag(A, 'paused'), [], T0) === null && reconnectBar(ag(A, 'queued'), [ev({ kind: 'status', status: 'queued', error: 'x', retry: { cause: 'unreachable', attempt: 1, of: 5, delayMs: 5_000 } }, T0)], T0)?.waiting === false);
  const rc = src('../agent/Reconnect.tsx');
  check('its buttons say retry now and stop waiting, on the agent\'s own routes', /bar\.waiting \?/.test(rc) && />\s*stop waiting\s*</.test(rc) && /retryNowAgent\(agent\.id\)/.test(rc) && /stopRetryingAgent\(agent\.id\), 'stopped waiting — it is failed'/.test(rc));

  const mixed = [ag('o_1', 'paused'), ag('o_2', 'paused'), ag('p_mine', 'paused'), ag('d_1', 'done')];
  const rolled = rollupStatuses(mixed, [outage()]);
  check('an agent waiting in an outage counts as at work for its job and project; a pause of yours does not', rolled.join() === 'working,working,paused,done' && rollupStatus(rollupStatuses([ag('o_1', 'paused'), ag('d_1', 'done')], [outage()])) === 'working', rolled.join());
  check('…and once the card is gone it reads paused again', rollupStatuses(mixed, []).join() === 'paused,paused,paused,done' && rollupStatuses(mixed, [outage({ waiting: undefined })]).join() === 'paused,paused,paused,done');
  const store = src('./store.ts');
  const project = src('../fleet/project.tsx');
  check(
    'the Fleet card, the job and the project read through it',
    /rollupStatus\(rollupStatuses\(s\.agents\.filter\(\(a\) => a\.projectId === projectId\), s\.alerts\)\)/.test(store) && /rollupStatus\(rollupStatuses\(s\.agents\.filter\(\(a\) => a\.jobId === jobId\), s\.alerts\)\)/.test(store) &&
      /rollupStatus\(rollupStatuses\(agents, alerts\)\)/.test(project),
  );
  const shell = src('../shell/shell.tsx');
  check('the status bar says a provider is down on every screen, and opens Needs You', /useAlerts\(\)\.filter\(isOutage\)/.test(shell) && /className="sh-down"/.test(shell) && /⚠ \{providerLabel\(a\.provider\)\} down/.test(shell) && /onClick=\{\(\) => openAttention\(\)\}/.test(shell));
  check('…in the warning colour', /\.sh-down\s*\{[^}]*color: var\(--need\)/.test(src('../shell/shell.css')));
}

console.log('\n42 · an agent\'s activity folds to its latest step, and a reply stays open until you tick it read (Amendment 193)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const AG = 'agt_reply';
  const e = (n: number, payload: EventPayload): Event => ({ seq: n, ts: new Date(Date.UTC(2026, 10, 3, 9, 0, n)).toISOString(), projectId: P, jobId: J, agentId: AG, payload });
  const say = (n: number, text: string): Event => e(n, { kind: 'text', text });
  const tool = (n: number, label = 'Read a.ts'): Event => e(n, { kind: 'tool_start', toolUseId: `tu${n}`, tool: 'Read', input: { file_path: 'a.ts' }, label });
  const ask = (n: number): Event => e(n, { kind: 'request', requestId: `rq${n}`, requestKind: 'question', blockMode: 'parked', label: 'Which branch?' });
  const done = (n: number): Event => e(n, { kind: 'status', status: 'done' });
  const fail = (n: number): Event => e(n, { kind: 'status', status: 'failed', error: 'boom' });
  const only = (events: Event[]): Turn => buildTranscript(events).filter((t) => t.who === 'agent').at(-1)!;
  const keys = (bs: readonly { key: string }[]): string => bs.map((b) => b.key).join(' ');

  // splitTurn: where the activity ends and the reply begins.
  const ran = only([e(1, { kind: 'user_text', text: 'go' }), say(2, 'Looking.'), tool(3), say(4, 'Found it.'), say(5, 'REPLY: it is fixed.'), done(6)]);
  const sp = splitTurn(ran, false);
  check('a reply is what follows the last tool call, its finished note included', keys(sp.activity) === 'p2 t3' && keys(sp.reply) === 'p4 p5 s6' && sp.replySeq === 5, JSON.stringify([keys(sp.activity), keys(sp.reply), sp.replySeq]));
  check('…named by its last prose, the p-key the daemon\'s replySeq names', sp.replySeq === 5);
  check('a turn still going has no reply: all of it is activity', splitTurn(ran, true).replySeq === null && keys(splitTurn(ran, true).activity) === keys(ran.blocks) && splitTurn(ran, true).reply.length === 0);
  const onTool = only([say(1, 'Reading.'), tool(2), done(3)]);
  check('a turn that ended on a tool call, with only its finished note after, has no reply', splitTurn(onTool, false).replySeq === null && splitTurn(onTool, false).reply.length === 0);
  const onAsk = only([say(1, 'I need to know.'), ask(2)]);
  check('nor one that ended on an ask', splitTurn(onAsk, false).replySeq === null);
  const talk = only([say(1, 'Hello.'), say(2, 'All of this is the reply.'), done(3)]);
  check('a turn of prose only is all reply, with no activity', splitTurn(talk, false).activity.length === 0 && keys(splitTurn(talk, false).reply) === 'p1 p2 s3' && splitTurn(talk, false).replySeq === 2);
  const afterAsk = only([ask(1), say(2, 'Thanks, done.'), done(3)]);
  check('an answered ask ends the activity as a tool call does', keys(splitTurn(afterAsk, false).activity) === 'r1' && splitTurn(afterAsk, false).replySeq === 2);

  // The one line folded activity shows of its latest prose: the last line, without markdown.
  check('folded activity shows the last line of what it said last, without its markdown', lastLine('First I read it.\n\n- **then** I [ran](x) `tests`\n\n---\n') === 'then I ran tests' && foldLine('First I read it.\n\nthen') === 'First I read it.' && lastLine('') === '' && lastLine('```\n') === '');

  // The acks: parsed robustly, read from before they were kept, ticked and unticked, bounded.
  check('acks not kept, or kept broken, are "not kept": nothing is unread', ['', 'null', '[]', '{"sinceSeq":"7"}', '{"agents":{}}', '{', '{"sinceSeq":null}'].every((r) => parseAcks(r).sinceSeq === null) && parseAcks(null).sinceSeq === null && isRead(parseAcks(null), AG, 999));
  const kept = parseAcks('{"sinceSeq":10,"agents":{"a":[11,"x",12,null],"b":"no","c":[]}}');
  check('a kept value keeps only its seqs, and drops what is not one', kept.sinceSeq === 10 && JSON.stringify(kept.agents) === '{"a":[11,12]}', JSON.stringify(kept));
  check('it round-trips', serializeAcks(parseAcks(serializeAcks(kept))) === serializeAcks(kept));
  const s0: ReplyAcks = startAcks(10);
  check('kept from the hub\'s seq: every reply at or below it is read, and one after is not', isRead(s0, AG, 10) && isRead(s0, AG, 3) && !isRead(s0, AG, 11));
  const t1 = setAck(s0, AG, 11, true)!;
  check('ticking a reply reads it, for that agent only', t1 !== null && isRead(t1, AG, 11) && !isRead(t1, 'agt_other', 11) && !isRead(t1, AG, 12));
  check('ticking it again changes nothing, so nothing is written', setAck(t1, AG, 11, true) === null);
  const u1 = setAck(t1, AG, 11, false)!;
  check('unticking makes it unread again, and leaves no empty agent behind', u1 !== null && !isRead(u1, AG, 11) && !(AG in u1.agents));
  check('a reply from before can\'t be ticked or unticked: it is read whatever you do', setAck(s0, AG, 9, false) === null && setAck(s0, AG, 10, true) === null && !canUntick(s0, 10) && canUntick(s0, 11) && !canUntick(parseAcks(null), 11));
  check('nothing is ticked before they are kept', setAck(parseAcks(null), AG, 11, true) === null);
  const two = setAck(setAck(s0, 'agt_gone', 12, true)!, AG, 13, true)!;
  const pruned = setAck(two, AG, 14, true, new Set([AG]))!;
  check('agents the hub no longer has drop out as it is written, the one ticked kept', 'agt_gone' in two.agents && !('agt_gone' in pruned.agents) && JSON.stringify(pruned.agents[AG]) === '[13,14]');
  let many: ReplyAcks = s0;
  for (let n = 11; n <= 11 + MAX_ACKS + 5; n++) many = setAck(many, AG, n, true)!;
  check(`each agent keeps its newest ${MAX_ACKS} ticks`, many.agents[AG]!.length === MAX_ACKS && many.agents[AG]![0] === 17 && isRead(many, AG, 11 + MAX_ACKS + 5), String(many.agents[AG]?.length));
  check(
    'to read: the agents whose latest reply (replySeq) is not ticked, whatever their status',
    [...toRead([{ id: 'x', replySeq: 11 }, { id: 'y', replySeq: 13 }, { id: 'z' }, { id: 'o', replySeq: 4 }], { sinceSeq: 10, agents: { y: [13] } })].join() === 'x' &&
      toRead([{ id: 'x', replySeq: 11 }], parseAcks(null)).size === 0,
  );

  // replyStates and fold all: read replies start folded, unread ones are left out.
  const run = buildTranscript([
    e(20, { kind: 'user_text', text: 'one' }), tool(21), say(22, 'FIRST_REPLY'), done(23),
    e(24, { kind: 'user_text', text: 'two' }), tool(25), say(26, 'SECOND_REPLY'), done(27),
    e(28, { kind: 'user_text', text: 'three' }), say(29, 'Working on it.'), tool(30),
  ]);
  const acks: ReplyAcks = { sinceSeq: 20, agents: { [AG]: [22] } };
  const st = replyStates(run, true, AG, acks);
  check('the ticked reply is read, the other unread, and the turn still going is neither', st.read.join() === 'a21' && st.unread.join() === 'a25', JSON.stringify(st));
  check('before acks are kept there are neither, and every reply is as it was', replyStates(run, true, AG, parseAcks(null)).read.length === 0 && replyStates(run, true, AG, parseAcks(null)).unread.length === 0);
  check('an older reply, from before they were kept, is read', replyStates(run, false, AG, { sinceSeq: 26, agents: {} }).read.join() === 'a21,a25');
  const none: FoldState = { folds: {}, unfolds: {} };
  const foldable = ['a21', 'a25', 'a29'].filter((k) => !st.unread.includes(k));
  const all = foldEvery(none, AG, foldable, st.read);
  check('fold all folds the read reply and the turn going on, and leaves the unread one open', shownFolded(all, AG, 'a21', true) && shownFolded(all, AG, 'a29', false) && !shownFolded(all, AG, 'a25', false));

  // Rendered: the box, the disabled label, the folded read reply, the folded activity.
  writeSetting(REPLY_ACKS_KEY, serializeAcks(acks));
  const html = renderToStaticMarkup(createElement(Transcript, { turns: run, agentId: AG, role: 'developer', streaming: true, links: null }));
  const turnOf = (k: string, next: string): string => html.slice(html.indexOf(`id="t-${k}"`), next ? html.indexOf(`id="t-${next}"`) : undefined);
  const unreadT = turnOf('a25', 'u28');
  const readT = turnOf('a21', 'u24');
  const live = turnOf('a29', '');
  check('an unread reply is open, with its Read it box, and its label can\'t fold it', /is-unread/.test(html.slice(html.indexOf('id="t-a25"') - 60, html.indexOf('id="t-a25"'))) && unreadT.includes('SECOND_REPLY') && unreadT.includes('class="ag-ack"') && unreadT.includes('Read it') && unreadT.includes('aria-disabled="true"') && unreadT.includes('class="ag-reply"'), unreadT);
  check('a reply you ticked is folded to one line, marked read', readT.includes('aria-expanded="false"') && readT.includes('class="ag-folded-read"') && readT.includes('✓ read') && readT.includes('FIRST_REPLY') && !readT.includes('class="ag-ack'), readT);
  check('a turn still going has no box, and its activity folds to its latest step', !live.includes('ag-ack') && live.includes('class="ag-act-tog"') && live.includes('<i class="sh-nav-chev" aria-hidden="true"></i>1 earlier step') && live.includes('aria-expanded="false"') && !live.includes('Working on it.'), live);
  const pin = buildTranscript([e(40, { kind: 'user_text', text: 'x' }), ask(41), say(42, 'Meanwhile, more.'), tool(43), say(44, 'Still going.\nLAST_LINE')]);
  const pinned = renderToStaticMarkup(createElement(Transcript, { turns: pin, agentId: AG, role: 'developer', streaming: true, links: null }));
  check('folded activity keeps an ask you haven\'t answered, and shows what it said last as its last line', pinned.includes('Which branch?') && pinned.includes('class="ag-act-last">LAST_LINE<') && !pinned.includes('Meanwhile, more.') && pinned.includes('<i class="sh-nav-chev" aria-hidden="true"></i>3 earlier steps'), pinned);
  const failed = buildTranscript([e(50, { kind: 'user_text', text: 'x' }), tool(51, 'Bash ls'), fail(52), tool(53, 'Read later.ts'), say(54, 'Next.')]);
  const failHtml = renderToStaticMarkup(createElement(Transcript, { turns: failed, agentId: AG, role: 'developer', streaming: true, links: null }));
  check('…and a failure, while the steps before it fold', failHtml.includes('failed — boom') && !failHtml.includes('Bash ls'), failHtml);
  writeSetting(REPLY_ACKS_KEY, null);
  const before = renderToStaticMarkup(createElement(Transcript, { turns: run, agentId: AG, role: 'developer', streaming: true, links: null }));
  check('before acks are kept a reply is open and foldable, with no box', !before.includes('ag-ack') && before.includes('FIRST_REPLY') && before.includes('SECOND_REPLY') && !before.includes('aria-disabled="true"'));

  // Where it is wired.
  const always = src('../attention/always.tsx');
  const folds = src('../agent/folds.ts');
  const css = src('../agent/agent.css');
  check('the acks are kept from the hub\'s seq, once, from the always-on layer', /useEffect\(\(\) => startAcksOnce\(seq\), \[seq\]\)/.test(always) && /if \(!settingsLoaded\(\) \|\| readSetting\(REPLY_ACKS_KEY\) !== null\) return;/.test(src('./replies.ts')));
  check('the activity\'s opened set is kept beside the folds', /kept\('conductor\.agentActivityOpen'\)/.test(folds) && REPLY_ACKS_KEY === 'conductor.replyAcks');
  const rule = (sel: string): string => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
  check(
    'its styles exist and use the theme\'s tokens only, so both themes have them',
    ['.ag-folded-read', '.ag-act-tog', '.ag-act-last', '.ag-act + .ag-reply', '.ag-msg.is-unread .ag-reply', '.ag-ack', '.ag-ack.is-read'].every((sel) => css.includes(`${sel} {`) && !/#[0-9a-f]{3,8}\b|rgb/i.test(rule(sel))),
  );
}

console.log('\n43 · the project\'s and the stack\'s status, one rule for the Fleet card and the navigator (Amendment 194)');
{
  const src = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');
  const head = (...a: Parameters<typeof headlineTags>): string => headlineTags(...a).map((t) => `${t.word}/${t.tone}`).join();

  // The rule, case by case.
  check('no agents: the quiet "no agents"', head([], false, []) === 'no agents/idle', head([], false, []));
  check('working: how many, filled live', head(['working', 'working', 'done'], false, []) === '2 working/live' && head(['working'], false, []) === '1 working/live');
  check('needs you: amber, and it outranks working', head(['working', 'blocked'], true, []) === 'needs you/need');
  check('done, and seen: the quiet "done"', head(['done', 'done'], false, []) === 'done/idle');
  check('failed: the status in its own colour', head(['failed', 'done'], false, []) === 'failed/fail');
  // Amendment 205: paused is "N paused", filled, where it read the plain "paused" in --idle.
  check('paused, queued and stopped: their own words and tones', head(['paused'], false, []) === '1 paused/pause' && head(['queued', 'done'], false, []) === 'queued/queue' && head(['stopped'], false, []) === 'stopped/idle');
  check('finished unseen: the loud finished alone, red when its job failed', head(['done'], false, [{ status: 'done' }]) === 'finished/done' && head(['failed'], false, [{ status: 'failed' }]) === 'finished/fail');
  check('working and finished: both, working first', head(['working', 'done'], false, [{ status: 'done' }]) === '1 working/live,finished/done');
  check('needs you and finished: both, needs you first', head(['blocked'], true, [{ status: 'failed' }, { status: 'done' }]) === 'needs you/need,finished/fail');
  check('a blocked agent with no request still reads needs you, by its status', head(['blocked', 'done'], false, []) === 'needs you/need');
  const waiting = [{ id: 'w1', status: 'paused' as const }];
  const outageAlert = { kind: 'connection' as const, waiting: 1, agentIds: ['w1'] };
  check('an agent waiting for the model counts as working (Amendment 192), through rollupStatuses', head(rollupStatuses(waiting, [outageAlert]), false, []) === '1 working/live' && head(rollupStatuses(waiting, []), false, []) === '1 paused/pause');

  // Who calls it: the card, and the navigator's tree for its project and stack rows.
  const card = src('../fleet/card.tsx');
  const tree = src('../shell/navtree.ts');
  check('the Fleet card draws headlineTags on the rollup, the request and its unseen jobs, and nothing inline', /const statuses = useMemo\(\(\) => rollupStatuses\(agents, allAlerts\), \[agents, allAlerts\]\);/.test(card) && /headlineTags\(statuses, blocked, unseen\)/.test(card) && !/\$\{working\} working/.test(card) && !/>finished<\/Tag>/.test(card));
  check('the navigator\'s tree heads each project and each stack with it, on the same rollup', /headlineTags\(rollupStatuses\(agents\.filter\(mine\), alerts\), pending\.some\(waits\), unseen\)/.test(tree) && /tags: tagsOf\(\(a\) => a\.projectId === p\.id, \(r\) => r\.projectId === p\.id,/.test(tree) && /tags: tagsOf\(\(a\) => a\.projectId === p\.id && a\.jobId === j\.id,/.test(tree));
  check('the rollup is the store\'s own, moved where Node loads it without React', /export \{ rollupStatuses \};/.test(src('./store.ts')) && /import \{ rollupStatuses \} from '\.\/rollup\.js';/.test(src('./store.ts')) && !/from 'react'/.test(src('./rollup.ts')));
}

console.log('\n44 · your message folds, and every turn says when (Amendment 195)');
{
  const src = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');
  // Local time, as a reader sees it: built from local parts, so the zone the checks run in doesn't matter.
  const local = (y: number, mo: number, d: number, h: number, mi: number, sec = 0): Date => new Date(y, mo, d, h, mi, sec);
  const now = local(2026, 10, 3, 14, 30);
  check('today: the time alone, 24-hour', fmtStamp(local(2026, 10, 3, 14, 5).toISOString(), now) === '14:05' && fmtStamp(local(2026, 10, 3, 9, 7).toISOString(), now) === '09:07', fmtStamp(local(2026, 10, 3, 9, 7).toISOString(), now));
  check('this year: the day and month first', fmtStamp(local(2026, 1, 28, 18, 0).toISOString(), now) === '28 Feb 18:00', fmtStamp(local(2026, 1, 28, 18, 0).toISOString(), now));
  check('another year: and the year', fmtStamp(local(2025, 10, 3, 14, 5).toISOString(), now) === '3 Nov 2025 14:05' && fmtStamp(local(2027, 0, 1, 0, 0).toISOString(), now) === '1 Jan 2027 00:00');
  const justAfter = local(2026, 10, 4, 0, 10);
  check('across midnight: last night is yesterday\'s date, a minute past midnight is today', fmtStamp(local(2026, 10, 3, 23, 55).toISOString(), justAfter) === '3 Nov 23:55' && fmtStamp(local(2026, 10, 4, 0, 1).toISOString(), justAfter) === '00:01');
  check('and New Year\'s Eve, seen on New Year\'s Day, carries its year', fmtStamp(local(2026, 11, 31, 23, 59).toISOString(), local(2027, 0, 1, 0, 1)) === '31 Dec 2026 23:59');
  check('a time that isn\'t one is nothing, not "Invalid Date"', fmtStamp('', now) === '' && fmtStamp('soon', now) === '');
  const full = fullStamp(local(2026, 10, 3, 14, 5, 9).toISOString());
  check('the full time has the weekday, the date, the seconds and the zone', /^Tue 3 Nov 2026 14:05:09( \S+)?$/.test(full), full);

  // A transcript with a short message of yours, a long one, an auto turn and replies.
  const AGY = 'agt_you';
  const T = (n: number): string => local(2026, 10, 3, 9, n, 30).toISOString();
  const at = (n: number, payload: EventPayload): Event => ({ seq: n, ts: T(n), projectId: P, jobId: J, agentId: AGY, payload });
  const LONG = 'Build the lane\nwith the folding\nand the times\nand nothing else';
  const run = buildTranscript([
    at(1, { kind: 'user_text', text: 'Short ask\nin two lines' }),
    at(2, { kind: 'tool_start', toolUseId: 'tq2', tool: 'Read', input: { file_path: 'a.ts' }, label: 'Read a.ts' }),
    at(3, { kind: 'text', text: 'FIRST_REPLY: done the first part.' }),
    at(4, { kind: 'text', text: 'FIRST_REPLY_END: and checked it.' }),
    at(5, { kind: 'user_text', text: LONG }),
    at(6, { kind: 'text', text: 'SECOND_REPLY: on it.' }),
    at(7, { kind: 'user_text', text: 'One\nTwo\nThree\nFour', synthetic: true }),
  ]);
  check('turns keep their keys, and carry their first event\'s time', run.map((t) => t.key).join() === 'u1,a2,u5,a6,u7' && run.map((t) => t.ts).join() === [1, 2, 5, 6, 7].map(T).join());
  check('a reply\'s time is its last prose\'s, the one ticking it read marks', splitTurn(run[1]!, false).replySeq === 4 && (splitTurn(run[1]!, false).reply.at(-1) as { ts?: string }).ts === T(4));

  // Folding: more than YOU_FOLD_LINES starts folded, in any transcript; an auto turn only in an orchestrator's.
  check(`a message of yours over ${YOU_FOLD_LINES} lines starts folded; a shorter one starts open`, startFoldedKeys(run, false).join() === 'u5' && startFoldedKeys(run, true).join() === 'u5,u7', startFoldedKeys(run, true).join());
  check('exactly three lines still starts open', startFoldedKeys(buildTranscript([at(1, { kind: 'user_text', text: 'a\nb\nc' })]), false).length === 0);
  check('fold all covers your messages: every turn', replyKeys(run).join() === 'u1,a2,u5,a6,u7');
  const draw = (): string => renderToStaticMarkup(createElement(Transcript, { turns: run, agentId: AGY, role: 'developer', streaming: false, links: null, startFolded: startFoldedKeys(run, false) }));
  const turnOf = (html: string, key: string): string => {
    const i = html.lastIndexOf('<div class="ag-msg', html.indexOf(`id="t-${key}"`));
    const j = html.indexOf('<div class="ag-msg', i + 1);
    return html.slice(i, j === -1 ? undefined : j);
  };
  const html = draw();
  const short = turnOf(html, 'u1');
  const long = turnOf(html, 'u5');
  check('your short message is open, and folds from its you label', /^<div class="ag-msg is-you" id="t-u1">/.test(short) && short.includes('class="ag-who ag-who-fold" aria-expanded="true" title="Fold your message to one line"><i class="sh-nav-chev is-open" aria-hidden="true"></i>you</button>') && short.includes('Short ask\nin two lines'), short);
  check('your long one starts folded: its first line and how many lines', /^<div class="ag-msg is-you is-folded" id="t-u5">/.test(long) && long.includes('aria-expanded="false" title="Unfold your message"') && long.includes('<span class="ag-folded-line">Build the lane</span><span class="ag-folded-n">4 lines</span>') && !long.includes('nothing else'), long);
  const stamp = (n: number): string => `<time class="ag-when" dateTime="${T(n)}" title="${fullStamp(T(n))}">${fmtStamp(T(n))}</time>`;
  check('each message of yours says when you sent it, open and folded, after its body', short.includes(`</div>${stamp(1)}</div>`) && long.includes(`</div>${stamp(5)}</div>`), short);
  check('a reply says when it was said: its last prose\'s time, not its first step\'s', turnOf(html, 'a2').includes(stamp(4)) && !turnOf(html, 'a2').includes(`dateTime="${T(2)}"`) && !turnOf(html, 'a2').includes(`dateTime="${T(3)}"`));
  check('the activity has no time of its own: one time on the turn, the reply\'s', (turnOf(html, 'a2').match(/<time /g) ?? []).length === 1);
  const steps = buildTranscript([
    at(1, { kind: 'tool_start', toolUseId: 'ts1', tool: 'Read', input: { file_path: 'a.ts' }, label: 'Read a.ts' }),
    at(2, { kind: 'tool_start', toolUseId: 'ts2', tool: 'Read', input: { file_path: 'b.ts' }, label: 'Read b.ts' }),
  ]);
  const stepsHtml = renderToStaticMarkup(createElement(Transcript, { turns: steps, agentId: AGY, role: 'developer', streaming: true, links: null }));
  check('its toggle\'s title says when the turn started', stepsHtml.includes(`title="Show every step, from ${fmtStamp(T(1))}"`) && !stepsHtml.includes('<time '), stepsHtml.match(/class="ag-act-tog"[^>]*>/)?.[0]);
  check('the auto turn says when it was sent too', turnOf(html, 'u7').includes(stamp(7)));

  // Kept: opening the long one is kept as opened; folding the short one as folded; both rendered.
  updateFoldState((st) => toggleFold(toggleFold(st, AGY, 'u5', true), AGY, 'u1', false));
  updateFoldState((st) => toggleFold(st, AGY, 'a2', false));
  const kept = draw();
  check('the long one you opened stays open, rendered whole', /^<div class="ag-msg is-you" id="t-u5">/.test(turnOf(kept, 'u5')) && turnOf(kept, 'u5').includes('nothing else'));
  check('the short one you folded stays folded, its time still showing', /^<div class="ag-msg is-you is-folded" id="t-u1">/.test(turnOf(kept, 'u1')) && turnOf(kept, 'u1').includes('<span class="ag-folded-n">2 lines</span>') && turnOf(kept, 'u1').includes(stamp(1)));
  check('a folded reply keeps its time', /is-folded/.test(turnOf(kept, 'a2').slice(0, 60)) && turnOf(kept, 'a2').includes(stamp(4)));
  const none: FoldState = { folds: {}, unfolds: {} };
  const keys = replyKeys(run);
  const byDefault = startFoldedKeys(run, false);
  const all = foldEvery(toggleFold(none, AGY, 'u5', true), AGY, keys, byDefault);
  check('fold all folds your messages, the long one you opened back to its fold', keys.every((k) => shownFolded(all, AGY, k, byDefault.includes(k))));
  const loose = unfoldEvery(all, AGY, byDefault);
  check('unfold all opens them all, the long one included', keys.every((k) => !shownFolded(loose, AGY, k, byDefault.includes(k))));
  updateFoldState((st) => foldEvery(st, AGY, keys, byDefault));
  const folded = draw();
  check('rendered after fold all, every turn is one line and still says when', (folded.match(/aria-expanded="false"/g) ?? []).length === 5 && !folded.includes('nothing else') && (folded.match(/<time class="ag-when"/g) ?? []).length === 5, folded);
  updateFoldState((st) => unfoldEvery(st, AGY, byDefault));
  check('and after unfold all, none is', !draw().includes('ag-who-fold" aria-expanded="false"') && draw().includes('nothing else'));

  const css = src('../agent/agent.css');
  const rule = (sel: string): string => css.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
  check('the time is quiet: --ink3, mono, small, never wrapping, in no fixed colour', /color: var\(--ink3\)/.test(rule('.ag-when')) && /font-family: var\(--mono\)/.test(rule('.ag-when')) && /white-space: nowrap/.test(rule('.ag-when')) && !/#[0-9a-f]{3,6}\b/i.test(rule('.ag-when')), rule('.ag-when'));
  const tsx = src('../agent/transcript.tsx');
  check('one component draws your turn and the auto turn, with the time after the body', /function SentTurn\(/.test(tsx) && !/className="ag-msg is-you" id=/.test(tsx) && /<SentTurn key=\{t\.key\} turn=\{t\} agentId=\{agentId\} startFolded=\{startFolded\.includes\(t\.key\)\} \/>/.test(tsx) && /<Stamp ts=\{turn\.ts\} \/>/.test(tsx) && /<Stamp ts=\{replyTs\(split\)\} \/>/.test(tsx));
}

console.log('\n45 · one chevron for every fold, on its left, and bigger; Read it bigger too (Amendment 196)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  // No fold draws its own glyph any more. The docks' "▸ terminal" and "▸ console" are tabs, not folds.
  const root = new URL('../', import.meta.url);
  const walk = (dir: URL): string[] => readdirSync(dir).flatMap((name) => {
    const at = new URL(name, dir);
    if (statSync(at).isDirectory()) return walk(new URL(`${name}/`, dir));
    return /\.(tsx?|css)$/.test(name) && name !== 'verify.ts' ? [at.pathname.slice(root.pathname.length)] : [];
  });
  const files = walk(root);
  const glyphs = files.flatMap((f) => src(`../${f}`).split('\n').map((line, i) => ({ f, i, line })))
    .filter(({ f, line }) => /[⌃⌄▸▾]/.test(line) && !/▸ (terminal|console)/.test(line) && !f.endsWith('.css'))
    .map(({ f, i, line }) => `${f}:${i + 1} ${line.trim()}`);
  check('no fold draws ⌃, ⌄, ▸ or ▾ as text: only the docks\' ▸ terminal and ▸ console are left', glyphs.length === 0, glyphs.join('\n'));
  const oldClasses = files.flatMap((f) => (src(`../${f}`).match(/\b(c5-caret|ag-sched-chev|pj-group-ch|ag-fold-ch|ag-tool-ch|fl-card-fold-chev)\b/g) ?? []).map((c) => `${f}: ${c}`));
  check('the folds\' own glyph classes are gone: .c5-caret, .ag-sched-chev, .pj-group-ch, .ag-fold-ch, .ag-tool-ch, .fl-card-fold-chev', oldClasses.length === 0, oldClasses.join('\n'));
  // The two CSS list markers are a list's "now" bullet, not a fold.
  check('the only ▸ in a stylesheet is a list\'s "now" marker, which folds nothing', files.filter((f) => f.endsWith('.css') && src(`../${f}`).includes('▸')).sort().join() === 'agent/agent.css,files/files.css' && /\.ag-todo li\.is-active::before \{\s*content: "▸";/.test(src('../agent/agent.css')) && /\.c5-md li\.task\.now::before \{\s*content: "▸";/.test(src('../files/files.css')));
  const folds: Array<[string, RegExp]> = [
    ['agent/transcript.tsx', /\{canOpen \? <Chevron open=\{open\} \/> : <ChevronSpace \/>\}\s*<b>\{block\.tool\.toLowerCase\(\)\}<\/b>[\s\S]*<Chevron open=\{open\} \/>[\s\S]*<Chevron open=\{!folded\} \/>[\s\S]*<Chevron open=\{!folded\} \/>/],
    ['agent/scheduled.tsx', /<Chevron open=\{open\.has\(m\.id\)\} \/>/],
    ['agent/agent.tsx', /<Chevron open=\{anyOpen\} \/>/],
    ['files/FileTree.tsx', /<Chevron open=\{open\} \/>/],
    ['fleet/card.tsx', /<Chevron open=\{listOpen\} \/>/],
    ['fleet/project.tsx', /<Chevron open=\{open\} \/>/],
    ['metrics/route.tsx', /<summary[^>]*>\s*\{\/\*[^]*?\*\/\}\s*<Chevron open=\{false\} \/>/],
    ['spawn/route.tsx', /<summary[^>]*>\s*\{\/\*[^]*?\*\/\}\s*<Chevron open=\{false\} \/>/],
    ['shell/Navigator.tsx', /<Chevron open=/],
  ];
  for (const [f, re] of folds) check(`${f} draws its fold with the Chevron`, re.test(src(`../${f}`)));

  // Rendered: the chevron comes first, before the role label and before the tool's name.
  const at = (n: number, payload: EventPayload): Event => ({ seq: n, ts: new Date(Date.UTC(2026, 10, 3, 9, 0, n)).toISOString(), projectId: 'prj_c', jobId: 'job_c', agentId: 'agt_c', payload });
  const html = renderToStaticMarkup(createElement(Transcript, {
    turns: buildTranscript([
      at(1, { kind: 'user_text', text: 'Make it bigger' }),
      at(2, { kind: 'tool_start', toolUseId: 'c1', tool: 'Read', input: { file_path: 'a.ts' }, label: 'Read a.ts' }),
      at(3, { kind: 'tool_start', toolUseId: 'c2', tool: 'Read', input: { file_path: 'b.ts' }, label: 'Read b.ts' }),
      at(4, { kind: 'text', text: 'Done.' }),
    ]),
    agentId: 'agt_c', role: 'developer', streaming: false, links: null,
  }));
  check('your turn: the chevron, then you, in the label\'s one button', /class="ag-who ag-who-fold" aria-expanded="true" title="Fold your message to one line"><i class="sh-nav-chev is-open" aria-hidden="true"><\/i>you<\/button>/.test(html), html.match(/<button[^>]*ag-who-fold[^]*?<\/button>/)?.[0]);
  check('a reply: the chevron, then its role', /class="ag-who ag-who-fold" aria-expanded="true" aria-disabled="false" title="Fold this reply to one line"><i class="sh-nav-chev is-open" aria-hidden="true"><\/i>developer<\/button>/.test(html), html);
  check('folded activity: the chevron, then how many steps', html.includes('<i class="sh-nav-chev" aria-hidden="true"></i>1 earlier step'), html);
  check('a tool row: the chevron, then the tool\'s name', /class="ag-tool-tog"[^>]*><i class="sh-nav-chev" aria-hidden="true"><\/i><b>read<\/b>/.test(html), html.match(/class="ag-tool-tog"[^>]*>.{0,80}/)?.[0]);
  check('the transcript\'s labels stand left, so every turn\'s chevron is in one place', /justify-content: flex-start/.test(src('../agent/agent.css').match(/\n\.ag-who-fold \{([^}]*)\}/)?.[1] ?? '') && /text-align: left/.test(src('../agent/agent.css').match(/\n\.ag-who \{([^}]*)\}/)?.[1] ?? ''));
  const { FileTree } = await import('../files/FileTree.js');
  const tree = renderToStaticMarkup(createElement(FileTree, {
    root: { path: '', name: '', type: 'dir', children: [{ path: 'src', name: 'src', type: 'dir', children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }] }] },
    selected: null, onSelect: () => {}, folders: undefined, onToggle: () => {}, touches: new Map(), roles: new Map(), now: 0,
  }));
  check('the Files tree: a folder\'s chevron before its name, and a file keeps the room empty', /<i class="sh-nav-chev is-open" aria-hidden="true"><\/i>[^<]*<span[^>]*>src/.test(tree) || /<i class="sh-nav-chev is-open" aria-hidden="true"><\/i>.{0,120}src\//.test(tree), tree);
  check('…and a file keeps the chevron\'s room, empty', tree.includes('<i class="sh-nav-chev-sp" aria-hidden="true"></i>'), tree);

  // The chevron itself: 16px box, a 7px triangle, in --ink2 at full strength, turning without motion if asked.
  const shell = src('../shell/shell.css');
  const rule = (css: string, sel: string): string => css.match(new RegExp(`\\n${sel.replace(/[.()>[\]]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  const box = rule(shell, '.sh-nav-chev,\n.sh-nav-chev-sp');
  check('the chevron is a fixed 16px box', /width: 16px;/.test(box) && /height: 16px;/.test(box) && /flex: none;/.test(box), box);
  check('its triangle is 7px wide and 10px tall', /border-width: 5px 0 5px 7px;/.test(rule(shell, '.sh-nav-chev::before')), rule(shell, '.sh-nav-chev::before'));
  check('it is --ink2, at full strength: no opacity', /color: var\(--ink2\);/.test(rule(shell, '.sh-nav-chev')) && !/opacity/.test(rule(shell, '.sh-nav-chev')) && !/opacity/.test(box), rule(shell, '.sh-nav-chev'));
  check('it turns, and not at all with reduced motion', /transition: transform/.test(rule(shell, '.sh-nav-chev')) && /@media \(prefers-reduced-motion: reduce\) \{\s*\.sh-nav-chev \{\s*transition: none;/.test(shell));
  check('a <details> with it draws no marker of its own, and turns it open', /summary:has\(> \.sh-nav-chev\) \{[^}]*list-style: none;[^}]*\}/.test(shell) && /summary:has\(> \.sh-nav-chev\)::-webkit-details-marker \{\s*display: none;/.test(shell) && /details\[open\] > summary > \.sh-nav-chev/.test(shell));
  const agentCss = src('../agent/agent.css');
  const fleetCss = src('../fleet/fleet.css');
  check('each fold\'s button is at least 24px tall', [rule(agentCss, '.ag-who-fold'), rule(agentCss, '.ag-act-tog'), rule(fleetCss, '.fl-card-fold'), rule(fleetCss, '.pj-grouptoggle')].every((r) => /min-height: 24px;/.test(r)));

  // Read it: an 18px box, its words at --fs-sm.
  check('the Read it box is 18px', /width: 18px;/.test(rule(agentCss, '.ag-ack input')) && /height: 18px;/.test(rule(agentCss, '.ag-ack input')), rule(agentCss, '.ag-ack input'));
  check('and its words are --fs-sm', /font-size: var\(--fs-sm\);/.test(rule(agentCss, '.ag-ack')), rule(agentCss, '.ag-ack'));
}

console.log('\n46 · one button ticks every reply on an agent read, in one write, and folds them (Amendment 200)');
{
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const AG = 'agt_all';
  const e = (n: number, payload: EventPayload): Event => ({ seq: n, ts: new Date(Date.UTC(2026, 10, 4, 9, 0, n)).toISOString(), projectId: P, jobId: J, agentId: AG, payload });
  const say = (n: number, text: string): Event => e(n, { kind: 'text', text });
  const tool = (n: number): Event => e(n, { kind: 'tool_start', toolUseId: `tu${n}`, tool: 'Read', input: { file_path: 'a.ts' }, label: 'Read a.ts' });
  const done = (n: number): Event => e(n, { kind: 'status', status: 'done' });

  // setAcksAll: setAck's rules, for many seqs at once.
  const s0: ReplyAcks = { sinceSeq: 10, agents: { [AG]: [12], agt_other: [15] } };
  const all = setAcksAll(s0, AG, [14, 12, 8, 10, 13, 14])!;
  check('several seqs ticked at once, in order, the one already read left as it was', JSON.stringify(all.agents[AG]) === '[12,13,14]', JSON.stringify(all.agents));
  check('one at or below sinceSeq is ignored: it is read already', !all.agents[AG]!.includes(8) && !all.agents[AG]!.includes(10) && all.sinceSeq === 10);
  check('other agents are untouched', JSON.stringify(all.agents['agt_other']) === '[15]');
  check('nothing to tick is no change, so nothing is written', setAcksAll(s0, AG, [12, 9]) === null && setAcksAll(s0, AG, []) === null && setAcksAll(parseAcks(null), AG, [11]) === null);
  check('agents the hub no longer has drop out as it is written, as one tick\'s do', !('agt_other' in setAcksAll(s0, AG, [13], new Set([AG]))!.agents));
  const lots = Array.from({ length: MAX_ACKS + 7 }, (_, i) => 11 + i);
  const big = setAcksAll(startAcks(10), AG, lots)!;
  check(`each agent still keeps its newest ${MAX_ACKS}`, big.agents[AG]!.length === MAX_ACKS && big.agents[AG]![0] === 18 && isRead(big, AG, 11 + MAX_ACKS + 6), String(big.agents[AG]?.length));
  let one: ReplyAcks = s0;
  for (const n of [14, 13]) one = setAck(one, AG, n, true)!;
  check('the same answer as ticking each in turn', serializeAcks(one) === serializeAcks(all));

  // toTick: the unread replies the transcript holds, by Read it's seq, and the agent's latest.
  const run = buildTranscript([
    e(20, { kind: 'user_text', text: 'one' }), tool(21), say(22, 'FIRST'), done(23),
    e(24, { kind: 'user_text', text: 'two' }), tool(25), say(26, 'SECOND'), done(27),
    e(28, { kind: 'user_text', text: 'three' }), say(29, 'THIRD'), done(30),
    e(31, { kind: 'user_text', text: 'four' }), say(32, 'Working on it.'), tool(33),
  ]);
  const acks: ReplyAcks = { sinceSeq: 20, agents: { [AG]: [22] } };
  const tk = toTick(run, true, AG, acks, 29);
  check('the unread replies, named by their last prose as Read it names them; the read one and the turn going on left out', tk.seqs.join() === '26,29' && tk.keys.join() === 'a25,a29', JSON.stringify(tk));
  const lost = toTick(run, true, AG, acks, 40);
  check('the agent\'s latest reply (replySeq) is ticked too, though this tab no longer holds its events', lost.seqs.join() === '26,29,40' && lost.keys.join() === 'a25,a29', JSON.stringify(lost));
  check('…not when it is read already, or from before sinceSeq', toTick(run, true, AG, { sinceSeq: 20, agents: { [AG]: [22, 26, 29] } }, 29).seqs.length === 0 && toTick(run, true, AG, { sinceSeq: 40, agents: {} }, 40).seqs.length === 0);
  check('nothing before the acks are kept', toTick(run, true, AG, parseAcks(null), 29).seqs.length === 0);
  check('ticked, that agent is no longer to read', toRead([{ id: AG, replySeq: 40 }], acks).has(AG) && !toRead([{ id: AG, replySeq: 40 }], setAcksAll(acks, AG, lost.seqs)!).has(AG));

  // closeRead: each one ticked ends folded, whatever you had opened; nothing else moves.
  const opened: FoldState = { folds: { [AG]: ['u24'] }, unfolds: { [AG]: ['a21', 'a25', 'u31'], agt_other: ['a25'] } };
  const closed = closeRead(opened, AG, tk.keys);
  const after = { sinceSeq: 20, agents: { [AG]: [22, 26, 29] } };
  const stAfter = replyStates(run, true, AG, after);
  const shows = (s: FoldState, k: string): boolean => shownFolded(s, AG, k, stAfter.read.includes(k) || k === 'u31');
  check('an unread reply you had opened ends folded once ticked, as one that you hadn\'t', shows(closed, 'a25') && shows(closed, 'a29') && !shows(opened, 'a25'));
  check('a read reply you had opened stays open, and your messages are as they were', !shows(closed, 'a21') && !shows(closed, 'u31') && closed.folds === opened.folds);
  check('other agents\' folds are untouched, and nothing to close is no change', JSON.stringify(closed.unfolds['agt_other']) === '["a25"]' && closeRead(closed, AG, tk.keys) === closed);

  // One click: one write of the acks, and the folds closed, through the live settings.
  const UNF = 'conductor.agentUnfolds';
  const wasUnf = readSetting(UNF);
  writeSetting(REPLY_ACKS_KEY, serializeAcks(acks));
  updateFoldState(() => opened);
  let ackWrites = 0;
  let last = readSetting(REPLY_ACKS_KEY);
  const off = onSettings(() => {
    const now = readSetting(REPLY_ACKS_KEY);
    if (now !== last) ackWrites++;
    last = now;
  });
  readAll(AG, lost);
  off();
  const wrote = parseAcks(readSetting(REPLY_ACKS_KEY));
  check('one click is one write of the acks, not one per reply', ackWrites === 1, String(ackWrites));
  check('…and every reply it named is read after it', [26, 29, 40].every((n) => isRead(wrote, AG, n)) && JSON.stringify(wrote.agents[AG]) === '[22,26,29,40]', JSON.stringify(wrote));
  check('…and the replies it ticked are no longer kept open', JSON.stringify(parseFolds(readSetting(UNF))[AG]) === '["a21","u31"]', readSetting(UNF) ?? 'null');

  // The button, rendered: its count, its title, keyboard reachable; and nothing with none to tick.
  const btn = renderToStaticMarkup(createElement(ReadAllButton, { agentId: AG, tick: tk }));
  check('with unread replies it is a button, in fold all\'s style, with its count', /^<button type="button" class="fl-btn is-ghost"/.test(btn) && btn.includes('✓ mark all read (2)'), btn);
  check('its aria-label gives the count, and its title says what it does', btn.includes('aria-label="Mark all 2 unread replies read"') && btn.includes('title="Tick every reply on this agent read, and fold them"') && !/tabindex="-1"|disabled/.test(btn), btn);
  check('one reply reads in the singular', renderToStaticMarkup(createElement(ReadAllButton, { agentId: AG, tick: { seqs: [40], keys: [] } })).includes('aria-label="Mark all 1 unread reply read"'));
  check('with none to tick there is no button', renderToStaticMarkup(createElement(ReadAllButton, { agentId: AG, tick: toTick(run, true, AG, wrote, 40) })) === '');

  // Where it is wired: beside fold all, from the agent's own replySeq.
  const screen = src('../agent/agent.tsx');
  check('the Agent screen draws it just before fold all, while nothing is armed', /\{ask === null && rerunAsk === null && <ReadAllButton agentId=\{agent\.id\} tick=\{unticked\} \/>\}\s*\{ask === null && rerunAsk === null && replies\.length > 0 && \(/.test(screen));
  check('…from the transcript and the agent\'s replySeq', /toTick\(turns, streaming, active, acks, replySeq\)/.test(screen) && /const replySeq = agent\?\.replySeq;/.test(screen));
  check('it writes through markReplies, once, as markReply does', /markReplies\(agentId, tick\.seqs\);/.test(src('../agent/readall.tsx')) && /const next = setAcksAll\(parseAcks\(readSetting\(REPLY_ACKS_KEY\)\)/.test(src('./replies.ts')));

  writeSetting(REPLY_ACKS_KEY, null);
  writeSetting(UNF, wasUnf);
}

console.log('\n47 · a reply copies without the app\'s colours, from its ⧉ copy and from Cmd-C (Amendment 201)');
await (async () => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const AG = 'agt_copy';
  const e = (n: number, payload: EventPayload): Event => ({ seq: n, ts: new Date(Date.UTC(2026, 10, 4, 9, 0, n)).toISOString(), projectId: P, jobId: J, agentId: AG, payload });
  const say = (n: number, text: string): Event => e(n, { kind: 'text', text });
  const tool = (n: number): Event => e(n, { kind: 'tool_start', toolUseId: `tu${n}`, tool: 'Read', input: { file_path: 'a.ts' }, label: 'Read a.ts' });
  const done = (n: number): Event => e(n, { kind: 'status', status: 'done' });
  const colourless = (h: string): boolean => !/color|background|style=|class=|data-theme|var\(--/i.test(h.replace(/ style="font-family: monospace"/g, ''));

  // The builder: the reply's markdown, and that rendered with no colour.
  const MD = [
    '# Findings',
    '',
    'Run `make test` first, and see [the docs](https://example.com/docs?a=1&b=2).',
    '',
    '- one **bold**',
    '- two',
    '  1. nested',
    '- [x] done task',
    '',
    '| name | n |',
    '|:-----|--:|',
    '| a    | 1 |',
    '',
    '```ts',
    'const x = 1 < 2;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    '> quoted',
  ].join('\n');
  const turn = buildTranscript([e(1, { kind: 'user_text', text: 'go' }), tool(2), say(3, 'NOT_THE_REPLY'), tool(4), say(5, MD), say(6, 'And a second paragraph.'), done(7)]).find((t) => t.who === 'agent')!;
  const split = splitTurn(turn, false);
  const clip = replyClipboard(split.reply);
  check('text/plain is the reply\'s markdown as the agent wrote it, its prose blocks in turn', clip.text === `${MD}\n\nAnd a second paragraph.`, JSON.stringify(clip.text));
  check('…the reply only: nothing it said between its tools', !clip.text.includes('NOT_THE_REPLY') && !clip.html.includes('NOT_THE_REPLY') && !clip.text.includes('finished'));
  check('text/html has no colour, background, style or class anywhere, but monospace on code', colourless(clip.html) && clip.html.includes('<code style="font-family: monospace">make test</code>'), clip.html);
  check('headings, lists (nested, numbered), bold and a quote survive as plain HTML', clip.html.includes('<h1>Findings</h1>') && /<ul><li>one <strong>bold<\/strong><\/li><li>two<ol><li>nested<\/li><\/ol><\/li>/.test(clip.html) && clip.html.includes('<blockquote><p>quoted</p></blockquote>'), clip.html);
  check('a table survives, with its alignment as an attribute and not a style', clip.html.includes('<table><thead><tr><th align="left">name</th><th align="right">n</th></tr></thead><tbody><tr><td align="left">a</td><td align="right">1</td></tr></tbody></table>'), clip.html);
  check('a web link survives with its href', clip.html.includes('<a href="https://example.com/docs?a=1&amp;b=2">the docs</a>'), clip.html);
  check('a code block is <pre><code>, no background, no copy button, the code escaped', clip.html.includes('<pre style="font-family: monospace"><code style="font-family: monospace">const x = 1 &lt; 2;</code></pre>') && !clip.html.includes('copy'), clip.html);
  check('a mermaid diagram goes in as its source, in a code block', clip.html.includes('<pre style="font-family: monospace"><code style="font-family: monospace">graph TD; A--&gt;B</code></pre>') && !/<svg|<button|source<|hidden/.test(clip.html), clip.html);
  check('a task keeps whether it is done, as text', clip.html.includes('<li>☑ done task</li>'), clip.html);
  check('the second prose block follows, as a paragraph', clip.html.endsWith('<p>And a second paragraph.</p>'));

  // The cleaner, on what a selection's innerHTML looks like.
  const sel = '<div class="ag-msg is-unread" id="t-a2" style="display:flex"><button class="ag-who ag-who-fold" aria-expanded="true"><i class="sh-nav-chev" aria-hidden="true"></i>developer</button>' +
    '<div class="ag-body"><div class="ag-md"><p style="color: rgb(230, 230, 230); background-color: rgb(20, 20, 20);">Hi <code class="x" style="background:#222">x</code> <a href="#files?path=a.ts" class="ag-file">a.ts</a></p>' +
    '<div class="ag-code" data-theme="light"><button type="button" class="ag-code-copy">⧉ copy</button><pre class="lang-sh" style="background: var(--paper)"><code>ls &gt; out</code></pre></div>' +
    '<div class="md-table"><table><tbody><tr><td style="text-align:center;color:red" colspan="2">c</td></tr></tbody></table></div></div>' +
    '<label class="ag-ack"><input type="checkbox">Read it</label></div><button class="ag-reply-copy">⧉ copy</button><time class="ag-when" dateTime="x">09:00</time>' +
    '<svg viewBox="0 0 1 1"><g><text fill="#fff">B</text></g></svg><!-- c --><span title="a > b">tail</span></div>';
  const clean = cleanHtml(sel);
  check('the cleaner strips every style and class, colours included, and keeps structure', clean === '<p>Hi <code style="font-family: monospace">x</code> a.ts</p><pre style="font-family: monospace"><code style="font-family: monospace">ls &gt; out</code></pre><table><tbody><tr><td colspan="2" align="center">c</td></tr></tbody></table>09:00tail' .replace(/^/, 'developer'), clean);
  check('…drops the app\'s controls, the chevron and a drawing, and keeps an in-app link\'s text', !/copy|Read it|<svg|B<|sh-nav/.test(clean) && clean.includes(' a.ts</p>'));
  check('…closes what it opened, even from a cut-off selection', cleanHtml('<ul><li>one<li>two') === '<ul><li>one<li>two</li></li></ul>' && cleanHtml('</p>loose</div>') === 'loose');
  check('…and leaves plain text as it is', cleanHtml('a &amp; b') === 'a &amp; b' && cleanHtml('') === '');

  // The clipboard: both flavours where it can, the text alone where it can't.
  const nav = globalThis as unknown as { navigator?: unknown; ClipboardItem?: unknown };
  const wasNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const wasItem = nav.ClipboardItem;
  const wrote: Record<string, string>[] = [];
  const plain: string[] = [];
  class Item {
    constructor(readonly parts: Record<string, Blob | Promise<Blob>>) {}
  }
  const setNav = (clipboard: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });
  };
  setNav({
    write: async (items: Item[]) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(items[0]!.parts)) out[k] = await (await v).text();
      wrote.push(out);
    },
    writeText: async (t: string) => void plain.push(t),
  });
  nav.ClipboardItem = Item;
  await copyRich(clip.text, Promise.resolve(clip.html));
  check('with ClipboardItem it writes text/plain and text/html, once', wrote.length === 1 && wrote[0]!['text/plain'] === clip.text && wrote[0]!['text/html'] === clip.html && plain.length === 0, JSON.stringify(Object.keys(wrote[0] ?? {})));
  nav.ClipboardItem = undefined;
  await copyRich('just text', Promise.resolve('<p>x</p>'));
  check('without it, the text alone, through copyText', plain.join() === 'just text' && wrote.length === 1);
  nav.ClipboardItem = Item;
  await copyRich('after a failed render', Promise.reject(new Error('no renderer')));
  check('if the HTML fails, the text is still copied', plain.at(-1) === 'after a failed render');
  if (wasNav) Object.defineProperty(globalThis, 'navigator', wasNav);
  else delete nav.navigator;
  nav.ClipboardItem = wasItem;

  // The button, rendered: on an unread reply, on a folded read one, on neither yours nor a turn with no reply.
  const run = buildTranscript([
    e(20, { kind: 'user_text', text: 'one' }), tool(21), say(22, 'FIRST_REPLY'), done(23),
    e(24, { kind: 'user_text', text: 'two' }), tool(25), say(26, 'SECOND_REPLY'), done(27),
    e(28, { kind: 'user_text', text: 'three' }), say(29, 'Working on it.'), tool(30),
  ]);
  writeSetting(REPLY_ACKS_KEY, serializeAcks({ sinceSeq: 20, agents: { [AG]: [22] } }));
  const html = renderToStaticMarkup(createElement(Transcript, { turns: run, agentId: AG, role: 'developer', streaming: true, links: null }));
  writeSetting(REPLY_ACKS_KEY, null);
  const turnOf = (k: string, next: string): string => html.slice(html.indexOf(`id="t-${k}"`), next ? html.indexOf(`id="t-${next}"`) : undefined);
  const BTN = '<button type="button" class="ag-reply-copy" aria-label="Copy this reply" title="Copy the reply, without its colours, to paste anywhere">⧉ copy</button>';
  const readT = turnOf('a21', 'u24');
  const unreadT = turnOf('a25', 'u28');
  check('an unread reply has its ⧉ copy, after its body and just before its time', unreadT.includes('class="ag-ack"') && unreadT.includes(`</div>${BTN}<time class="ag-when"`), unreadT);
  check('a folded read reply has it too, to copy without unfolding it', readT.includes('class="ag-folded-read"') && readT.includes(`</div>${BTN}<time class="ag-when"`), readT);
  check('your turns and a turn with no reply yet have none', !turnOf('u20', 'a21').includes('ag-reply-copy') && !turnOf('a29', '').includes('ag-reply-copy') && (html.match(/ag-reply-copy/g) ?? []).length === 2);
  check('the transcript cleans what Cmd-C copies', /<div className="ag-trans" onCopy=\{copySelection\}>/.test(src('../agent/transcript.tsx')) && /e\.clipboardData\.setData\('text\/html', html\);\s*e\.clipboardData\.setData\('text\/plain', text\);\s*e\.preventDefault\(\);\s*\} catch/.test(src('../agent/transcript.tsx')));
  const css = src('../agent/agent.css');
  const rule = /\.ag-reply-copy \{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('it is a sibling of the body and the time in the turn\'s row, its own width, top-aligned', /flex: none;/.test(rule) && /align-self: flex-start;/.test(rule) && /white-space: nowrap;/.test(rule) && !/position: absolute/.test(rule), rule);
  check('and stands out: a bordered chip in the live colour, not muted text (Amendment 202)', /border: 1px solid var\(--live\);/.test(rule) && /color: var\(--live\);/.test(rule) && /font-weight: 600;/.test(rule) && !/var\(--ink3\)/.test(rule), rule);
  check('…not inside the body, where the Read it box is, nor on the time', !/\.ag-body .ag-reply-copy|\.ag-when .ag-reply-copy|\.ag-ack .ag-reply-copy/.test(css));
})();

console.log('\n48 · while an agent works, next wake and later are the lit buttons and send is plain; once it is done, send is lit again (Amendment 202)');
(() => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const comp = src('../agent/composer.tsx');
  const css = src('../agent/agent.css');
  check('working is the agent working, or an orchestrator queued on its helpers', /const busyNow = agent\.status === 'working' \|\| \(orchestrator && agent\.status === 'queued'\);/.test(comp) && comp.indexOf('const orchestrator =') < comp.indexOf('const busyNow ='));
  check('⏲ later and next wake / when done are lit while it works', (comp.match(/\$\{busyNow \? ' is-hot' : ''\}/g) ?? []).length === 2);
  check('send is the primary button only when it is not working', /className=\{busyNow \? 'fl-btn' : 'fl-btn is-primary'\}/.test(comp));
  const hot = /\.ag-later-btn\.is-hot \{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('lit in the primary button\'s live colour, tokens only', /color: var\(--live\);/.test(hot) && /font-weight: 600;/.test(hot) && !/#[0-9a-fA-F]{3,8}\b/.test(hot), hot);
  const off = /\.ag-later-btn:disabled \{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('…and a disabled one (nothing typed) is plain, not lit', /background: none;/.test(off) && css.indexOf('.ag-later-btn:disabled {') > css.indexOf('.ag-later-btn.is-hot {'), off);
})();

console.log('\n49 · ⏎ new line: ticked, ⏎ makes a new line in the message box and only send sends; unticked, ⏎ sends as before (Amendment 203)');
await (async () => {
  const { ENTER_KEY, enterAction, enterSends } = await import('../agent/settingsfold.js');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const key = (k: string, shift = false, alt = false) => ({ key: k, shiftKey: shift, altKey: alt });
  check('the setting is one for every agent, kept in Settings', ENTER_KEY === 'conductor.enterNewline');
  check('absent, or anything but newline, is ⏎ sends: the default', enterSends(null) && enterSends('send') && enterSends('') && !enterSends('newline'));
  check('⏎ sends while it sends', enterAction(key('Enter'), true) === 'send');
  check('…and is a new line when ticked', enterAction(key('Enter'), false) === 'type');
  check('⇧⏎ and ⌥⏎ are a new line either way', ['type', 'type', 'type', 'type'].join() === [enterAction(key('Enter', true), true), enterAction(key('Enter', false, true), true), enterAction(key('Enter', true), false), enterAction(key('Enter', false, true), false)].join());
  check('other keys are typed', enterAction(key('a'), true) === 'type' && enterAction(key('a'), false) === 'type');
  const comp = src('../agent/composer.tsx');
  check('a ⏎ that picks a word in an input method never sends', enterAction({ ...key('Enter'), composing: true }, true) === 'type');
  check('the box asks enterAction, with the setting and the input method', /if \(enterAction\(\{ key: e\.key, shiftKey: e\.shiftKey, altKey: e\.altKey, composing: e\.nativeEvent\.isComposing \}, enterSendsNow\) === 'send'\)/.test(comp) && /const enterSendsNow = enterSends\(useSetting\(ENTER_KEY\)\);/.test(comp));
  check('a real checkbox, ticked when ⏎ is a new line, writing the setting', /<input\s+type="checkbox"\s+checked=\{!enterSendsNow\}\s+onChange=\{\(e\) => writeSetting\(ENTER_KEY, e\.target\.checked \? 'newline' : 'send'\)\}/.test(comp) && /⏎ new line\s*<\/label>/.test(comp));
  check('send still sends, whatever the box', /onClick=\{\(\) => void submit\(\)\}/.test(comp));
  const css = src('../agent/agent.css');
  check('styled with tokens only, live when ticked', /\.ag-enter\.is-on \{[^}]*color: var\(--live\);/.test(css) && !/\.ag-enter[^{]*\{[^}]*#[0-9a-fA-F]{3,8}\b/.test(css));
})();

console.log('\n50 · a quote in a reply has its own ⧉ copy, of the message inside it without the quote bar or the > marks; the reply\'s copy is unchanged (Amendment 204)');
await (async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement, Fragment } = await import('react');
  const { renderMarkdown } = await import('../agent/markdown.js');
  const { replyClipboard } = await import('../agent/replycopy.js');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const reply = 'Added the channel name:\n\n> Hi all,\n>\n> We are moving to **a new channel**.\n>\n> Thanks,\n> Durval';
  const shown = renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(reply)));
  check('the quote is drawn as before, with a ⧉ copy beside it', /<div class="ag-quote"><button type="button" class="ag-quote-copy"[^>]*>⧉ copy<\/button><blockquote><p>Hi all,<\/p>/.test(shown), shown);
  const qb = src('../agent/QuoteBlock.tsx');
  check('it copies the quote\'s own source, unquoted, and that drawn as a reply is', /const text = unquoted\(source\);/.test(qb) && /copyRich\(text, html\)/.test(qb) && /replyClipboard\(\[\{ kind: 'prose', text \}\]\)\.html/.test(qb) && /const source = quoted\.join\('\\n'\);/.test(src('../agent/markdown.tsx')));
  const { unquoted } = await import('../agent/QuoteBlock.js');
  check('a quote inside the quote is unquoted too, every level', unquoted('outer line\n> inner line\n>> deeper\n  > spaced') === 'outer line\ninner line\ndeeper\nspaced' && unquoted('plain\nnot > a mark') === 'plain\nnot > a mark');
  check('inside a code fence, a > that is the code\'s stays', unquoted('Here is a diff:\n```diff\n> old line\n+ new line\n```\nafter') === 'Here is a diff:\n```diff\n> old line\n+ new line\n```\nafter');
  check('…and in a quote within the quote, only the quote\'s own marks come off the fence', unquoted('> ```sh\n> > echo hi\n> ```\n> done') === '```sh\n> echo hi\n```\ndone');
  const nested = replyClipboard([{ kind: 'prose', text: unquoted('outer line\n> inner line') }]);
  check('…so the outer copy of a nested quote has no blockquote and no > mark', !nested.html.includes('<blockquote') && !/^>/m.test(nested.text) && nested.html.includes('inner line'), nested.html);
  const inside = replyClipboard([{ kind: 'prose', text: 'Hi all,\n\nWe are moving to **a new channel**.\n\nThanks,\nDurval' }]);
  check('what it copies has no quote and no colour: plain paragraphs', !inside.html.includes('<blockquote') && inside.html.includes('<p>Hi all,</p>') && inside.html.includes('<strong>a new channel</strong>') && !/style="(?!font-family: monospace)|class=/.test(inside.html), inside.html);
  check('…and its text has no > marks', !/^>/m.test(inside.text));
  const whole = replyClipboard([{ kind: 'prose', text: reply }]);
  check('the reply\'s own copy keeps the quote, and leaves the quote\'s button out', whole.html.includes('<blockquote><p>Hi all,</p>') && !whole.html.includes('⧉ copy') && !whole.html.includes('ag-quote'), whole.html);
  check('the button is one of the app\'s controls a copy leaves out', /ag-quote-copy/.test(src('./clipboard.ts')));
  const css = src('../agent/agent.css');
  const rule = /\.ag-quote-copy \{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('the button is the reply copy\'s chip, in tokens, and the quote keeps clear of it', /border: 1px solid var\(--live\);/.test(rule) && /color: var\(--live\);/.test(rule) && /position: absolute;/.test(rule) && /\.ag-quote > blockquote \{\s*padding-right: 96px;/.test(css) && !/#[0-9a-fA-F]{3,8}\b/.test(rule), rule);
})();

console.log('\n51 · ⏸ pause until a time: the headline says N paused, the chip is filled in --idle, the transcript says until when (Amendment 205)');
await (async () => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const head = (...a: Parameters<typeof headlineTags>): string => headlineTags(...a).map((t) => `${t.word}/${t.tone}`).join();

  // N paused: after the lead, before finished, beside a loud rest, or the rest itself.
  check('paused is the worst there is: N paused, filled, in place of the plain word', head(['paused', 'paused', 'done'], false, []) === '2 paused/pause' && head(['paused', 'stopped'], false, []) === '1 paused/pause');
  check('beside N working, after it', head(['working', 'paused', 'paused'], false, []) === '1 working/live,2 paused/pause');
  check('beside needs you, after it', head(['blocked', 'paused'], true, []) === 'needs you/need,1 paused/pause');
  check('between the lead and finished, and before finished alone', head(['working', 'paused', 'done'], false, [{ status: 'done' }]) === '1 working/live,1 paused/pause,finished/done' && head(['paused', 'done'], false, [{ status: 'failed' }]) === '1 paused/pause,finished/fail');
  check('beside a loud rest, which keeps its word: failed, queued', head(['failed', 'paused'], false, []) === 'failed/fail,1 paused/pause' && head(['queued', 'paused'], false, []) === 'queued/queue,1 paused/pause');
  check('none paused: no tag for it, the rule as it was', head(['done'], false, []) === 'done/idle' && head(['stopped'], false, []) === 'stopped/idle' && head([], false, []) === 'no agents/idle');
  const two = [{ id: 'w1', status: 'paused' as const }, { id: 'u1', status: 'paused' as const }];
  check(
    'one waiting for the model is not counted: the rollup has it working (Amendment 192)',
    head(rollupStatuses(two, [{ kind: 'connection', waiting: 1, agentIds: ['w1'] }]), false, []) === '1 working/live,1 paused/pause',
    head(rollupStatuses(two, [{ kind: 'connection', waiting: 1, agentIds: ['w1'] }]), false, []),
  );

  // Filled in --idle, with --bg as the ink: section 9 checks --bg on --idle ≥ 4.5:1 in both themes.
  const ui = src('../shell/ui.css');
  const rule = (css: string, sel: string): string => css.match(new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
  for (const [file, sel] of [['../shell/ui.css', '.ui-tag.t-pause'], ['../shell/shell.css', '.sh-nav-tag.is-pause']] as const) {
    const r = rule(src(file), sel);
    check(`${sel} is filled: --bg on --idle, weight 700, no fixed colour`, /color: var\(--bg\);/.test(r) && /background: var\(--idle\);/.test(r) && /border-color: var\(--idle\);/.test(r) && /font-weight: 700;/.test(r) && !/#[0-9a-f]{3,6}\b/i.test(r), r);
  }
  const tab = src('../agent/agent.css');
  check('.ag-tab-tag.is-pause is the tab\'s filled tag on --idle', /\.ag-tab-tag \{[^}]*color: var\(--bg\);/.test(tab) && /background: var\(--idle\);/.test(rule(tab, '.ag-tab-tag.is-pause')));
  check('--bg on --idle is one of the fills section 9 measures', /const FILLS = \['live', 'need', 'fail', 'done', 'idle'\];/.test(src('./verify.ts')));
  check('t-idle stays the plain outline, for a model\'s wait and a stopped agent', !/background/.test(rule(ui, '.ui-tag.t-idle')));

  // The transcript says until when, and the wake.
  const { buildTranscript: build } = await import('../agent/transcript.js');
  const { fmtStamp } = await import('./when.js');
  const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const ev = (n: number, payload: EventPayload): Event => ({ seq: n, ts: new Date(Date.UTC(2026, 10, 9, 14, 0, n)).toISOString(), projectId: 'p', jobId: 'j', agentId: 'a', payload });
  const notes = build([
    ev(1, { kind: 'status', status: 'working' }),
    ev(2, { kind: 'status', status: 'paused', error: `paused by the user until ${at}` }),
    ev(3, { kind: 'status', status: 'queued', error: 'resumed at the time you chose' }),
    ev(4, { kind: 'status', status: 'working' }),
    ev(5, { kind: 'status', status: 'paused', error: 'paused by the user' }),
    ev(6, { kind: 'status', status: 'paused' }),
  ])
    .flatMap((t) => t.blocks)
    .filter((b) => b.kind === 'note')
    .map((b) => (b as { text: string }).text);
  check(
    'the transcript: paused by you until its time, resumed at the time you chose, and a pause with none as before',
    notes.includes(`paused by you until ${fmtStamp(at)}`) && notes.includes('resumed at the time you chose') && notes.filter((n) => n === 'paused by you').length >= 1 && !notes.some((n) => n.includes('paused — paused by the user')),
    notes.join(' | '),
  );

  // The calls the menu makes: the daemon's bodies (wire.ts PauseAgentRequest, ResumeAtRequest).
  const calls: { path: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, resumeAt: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { pauseAgent, setResumeAt } = await import('../agent/endpoints.js');
    await pauseAgent('a1');
    await pauseAgent('a1', at);
    await setResumeAt('a1', at);
    await setResumeAt('a1', null);
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    '⏸ sends no time for until I resume it, and the time for the rest; change and clear post resume-at',
    calls.length === 4 &&
      /\/api\/agents\/a1\/pause$/.test(calls[0]!.path) && JSON.stringify(calls[0]!.body) === '{}' &&
      JSON.stringify(calls[1]!.body) === JSON.stringify({ until: at }) &&
      /\/api\/agents\/a1\/resume-at$/.test(calls[2]!.path) && JSON.stringify(calls[2]!.body) === JSON.stringify({ until: at }) &&
      JSON.stringify(calls[3]!.body) === '{"until":null}',
    JSON.stringify(calls),
  );

  // The menu, rendered: six lines to pause, five to change a time (clear is beside it).
  const { PauseMenu } = await import('../agent/PauseMenu.js');
  const menu = (mode: 'pause' | 'set'): string => renderToStaticMarkup(createElement(PauseMenu, { mode, busy: false, onPick: () => {}, onClose: () => {} }));
  const items = (html: string): number => (html.match(/role="menuitem"/g) ?? []).length;
  check('the menu to pause has its six lines, until I resume it first', items(menu('pause')) === 6 && menu('pause').indexOf('until I resume it') < menu('pause').indexOf('15 min'), menu('pause'));
  check('the menu to change a time has no until I resume it: clear says that', items(menu('set')) === 5 && !menu('set').includes('until I resume it'));
  check('each timed line shows when it wakes, in the menu\'s mono', (menu('pause').match(/class="ag-pause-when"/g) ?? []).length === 4);
  {
    const ag = readFileSync(new URL('../agent/agent.tsx', import.meta.url), 'utf8');
    check('the ⏸ menu closes on a click outside it, as a Fleet card\'s menu does', /<span className="ag-pause" ref=\{pauseWrap\}>/.test(ag) && /if \(!pauseWrap\.current\?\.contains\(e\.target as Node\)\) setMenu\(null\);/.test(ag) && /document\.addEventListener\('mousedown', onDown\);\s*return \(\) => document\.removeEventListener\('mousedown', onDown\);\s*\}, \[menu\]\);/.test(ag));
  }
})();

console.log('\n52 · the fleet\'s month set to the AI gateway\'s: the status bar marks it and says by how much, Settings sets, changes and clears it, and the tables by provider say they are as counted (Amendment 206)');
await (async () => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&#10;/g, '\n');
  const { MonthFigure, MonthCorrectionLine, ProviderCorrectionNote } = await import('../shell/monthfix.js');
  const now = new Date(2026, 10, 9, 18, 0);
  const today: MonthCorrection = { month: '2026-11', usd: 12.4, gatewayUsd: 52.4, at: new Date(2026, 10, 9, 14, 5).toISOString() };
  const earlier: MonthCorrection = { ...today, at: new Date(2026, 10, 8, 14, 5).toISOString() };
  const down: MonthCorrection = { ...today, usd: -3, gatewayUsd: 37 };

  check('a correction reads with its sign', signedMoney(12.4) === '+$12.40' && signedMoney(-3) === '−$3.00' && signedMoney(0) === '+$0.00');
  check('its hover says by how much, to match what, and when', monthCorrectionTitle(today, now) === 'corrected +$12.40 to match the AI gateway, set 14:05' && monthCorrectionTitle(earlier, now) === 'corrected +$12.40 to match the AI gateway, set 8 Nov 14:05');

  // ── the status bar ──
  const bar = (costMonth: number, budget: number | null, correction: MonthCorrection | null): string =>
    text(renderToStaticMarkup(createElement(MonthFigure, { costMonth, budget, correction, now })));
  const plain = bar(40, null, null);
  check('uncorrected, the month is as it was: no mark, the same hover', plain === `<span class="sh-spend-total" title="${MONTH_TITLE}">· $40.00 this month</span>`, plain);
  const fixed = bar(52.4, null, today);
  check(
    'corrected, the month is the corrected figure, ending in the mark',
    fixed.includes('>· $52.40 this month<span class="sh-spend-mark">' + MONTH_CORRECTED_MARK + '</span></span>') && MONTH_CORRECTED_MARK === '*',
    fixed,
  );
  check('and its hover says what the month is, then by how much and when', fixed.includes(`title="${MONTH_TITLE}\ncorrected +$12.40 to match the AI gateway, set 14:05"`), fixed);
  const metered = bar(52.4, 50, today);
  check(
    'against a monthly budget too: the meter\'s colour and words, the mark, and the correction under its hover',
    /^<span class="sh-spend-month" data-tone="over" title="105% of this month's budget — \$2\.40 over\. Agents keep going; it only warns\.\ncorrected \+\$12\.40 to match the AI gateway, set 14:05">· \$52\.40 of \$50\.00 this month<span class="sh-spend-mark">\*<\/span><\/span>$/.test(metered),
    metered,
  );
  const shell = src('../shell/shell.tsx');
  check('the status bar draws it from the store\'s correction', /const correction = useMonthCorrection\(\);/.test(shell) && /<MonthFigure costMonth=\{costMonth\} budget=\{budget\} correction=\{correction\} \/>/.test(shell));
  check('the mark has its colour', /\.sh-spend-mark \{[^}]*color: var\(--live\);/.test(src('../shell/shell.css')));

  // ── Settings, under the monthly budget ──
  const line = (correction: MonthCorrection | null, startOpen = false): string =>
    text(renderToStaticMarkup(createElement(MonthCorrectionLine, { costMonth: correction === null ? 40 : 52.4, correction, now, startOpen, send: async () => {} })));
  const offer = line(null);
  check(
    'with none: this month $X · match the AI gateway, and no change or clear',
    offer.includes('this month $40.00 · <button type="button" class="st-link">match the AI gateway</button>') && !offer.includes('>change<') && !offer.includes('>clear<'),
    offer,
  );
  const field = line(null, true);
  check(
    'it opens to the gateway says $ [ ] · set · cancel, and set waits for a figure',
    field.includes('the gateway says $') && /<input inputMode="decimal" class="st-monthfix-input" aria-label="the AI gateway's spend this month, in dollars" placeholder="40\.00"[^>]* value=""\/>/.test(field) &&
      /<button type="button" class="st-link" disabled="">set<\/button> · <button type="button" class="st-link">cancel<\/button>/.test(field) && !field.includes('match the AI gateway<'),
    field,
  );
  const shown = line(earlier);
  check(
    'with one: what it is, from what was counted, and when, · change · clear',
    shown.includes('this month $52.40 (corrected +$12.40 from $40.00 counted, set 8 Nov 14:05) · <button type="button" class="st-link">change</button> · <button type="button" class="st-link">clear</button>') && !shown.includes('match the AI gateway'),
    shown,
  );
  check('the words, by themselves', monthCorrectionWords(40, null, now) === 'this month $40.00' && monthCorrectionWords(37, down, now) === 'this month $37.00 (corrected −$3.00 from $40.00 counted, set 14:05)');
  check(
    'the gateway\'s figure is dollars as typed, from 0',
    JSON.stringify(gatewayDraft('52.40')) === '{"gatewayUsd":52.4}' && JSON.stringify(gatewayDraft(' $1,052.40 ')) === '{"gatewayUsd":1052.4}' && JSON.stringify(gatewayDraft('0')) === '{"gatewayUsd":0}' &&
      'problem' in gatewayDraft('') && 'problem' in gatewayDraft('-1') && 'problem' in gatewayDraft('lots') && 'problem' in gatewayDraft('2000000'),
  );
  {
    const { sendMonthCorrection } = await import('../shell/monthfix.js');
    const realFetch = globalThis.fetch;
    const calls: { path: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (path: string, init: RequestInit) => {
      calls.push({ path, method: init.method ?? 'GET', body: String(init.body) });
      return new Response(JSON.stringify({ costMonth: 52.4, counted: 40, monthCorrection: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await sendMonthCorrection(52.4);
      await sendMonthCorrection(null);
    } finally {
      globalThis.fetch = realFetch;
    }
    check(
      'set posts the gateway\'s figure to the daemon, and clear posts null',
      calls.length === 2 && calls.every((c) => c.path === '/api/spend/month-correction' && c.method === 'POST') && calls[0]!.body === '{"gatewayUsd":52.4}' && calls[1]!.body === '{"gatewayUsd":null}',
      JSON.stringify(calls),
    );
  }
  const settings = src('../settings/route.tsx');
  check('Settings draws the line under the monthly budget, once the daemon says a month', /\{costMonth !== null && <MonthCorrectionLine costMonth=\{costMonth\} correction=\{correction\} \/>\}/.test(settings));
  check('its links and field have their look', /\.st-link \{/.test(src('../settings/settings.css')) && /\.st-monthfix-input \{/.test(src('../settings/settings.css')));

  // ── the store ──
  let k = 0;
  const held = (): MonthCorrection | null => store.select(`mc${k++}`, (s) => s.monthCorrection);
  send({ type: 'hello', seq: 0, snapshot: { ...snapshot, costMonth: 52.4, monthCorrection: today } });
  check('a snapshot carries the correction', held()?.usd === 12.4);
  send({ type: 'cost', costToday: 1, costMonth: 57.4, monthCorrection: earlier });
  check('a cost frame with the month carries it', held()?.at === earlier.at);
  send({ type: 'cost', costToday: 1 });
  check('a frame without the month leaves it', held()?.at === earlier.at);
  send({ type: 'cost', costToday: 1, costMonth: 45, monthCorrection: null });
  check('a frame with the month and none clears it', held() === null);
  send({ type: 'cost', costToday: 1, costMonth: 45, monthCorrection: today });
  send({ type: 'cost', costToday: 1, costMonth: 45 });
  check('a month from a daemon before it is uncorrected', held() === null);
  send({ type: 'hello', seq: 0, snapshot: { ...snapshot, costMonth: 45 } });
  check('and so is its snapshot', held() === null);
  send({ type: 'hello', seq: 0, snapshot });

  // ── by provider ──
  check('the note says the fleet\'s month is corrected and the rows are as counted', providerCorrectionNote(today) === "The fleet's month is corrected +$12.40 to match the gateway; the rows below are as counted.");
  const note = (correction: MonthCorrection | null): string => text(renderToStaticMarkup(createElement(ProviderCorrectionNote, { correction, className: 'mt-quiet' })));
  check('it shows while there is a correction, and not otherwise', note(down) === '<p class="mt-quiet">The fleet\'s month is corrected −$3.00 to match the gateway; the rows below are as counted.</p>' && note(null) === '', note(down));
  const metrics = src('../metrics/route.tsx');
  check(
    'Metrics\' By provider says it, under its heading, from the store',
    /export function ProviderSpendTable\(\{ rows \}[^)]*\) \{\s*const correction = useMonthCorrection\(\);/.test(metrics) && /<h2 className="mt-h">By provider<\/h2>\s*<ProviderCorrectionNote correction=\{correction\} className="mt-quiet" \/>/.test(metrics),
  );
  check(
    'and Settings\' monthly budget by provider, above its rows',
    /const correction = useMonthCorrection\(\);/.test(settings) && /<ProviderCorrectionNote correction=\{correction\} className="st-dim" \/>\s*\{rows\.map\(\(r\) => \(\s*<ProviderBudgetRow/.test(settings),
  );
})();

console.log('\n53 · a ```message block is the message an agent drafted, drawn as it reads, with a ⧉ copy of just it (Amendment 207)');
await (async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement, Fragment } = await import('react');
  const { renderMarkdown } = await import('../agent/markdown.js');
  const { replyClipboard } = await import('../agent/replycopy.js');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const body = '**Subject: VLT-329**\n\nHi Olena,\n\n- one\n- two\n\nThanks,\nDurval';
  const reply = `I couldn't open the ticket.\n\n\`\`\`message\n${body}\n\`\`\`\n\nTell me if you want it shorter.`;
  const shown = renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(reply)));
  check('the block is drawn as the message, its markdown rendered, not as code', /<div class="ag-message"><button type="button" class="ag-quote-copy ag-message-copy"[^>]*>⧉ copy<\/button><div class="ag-message-body"><p><strong>Subject: VLT-329<\/strong><\/p><p>Hi Olena,<\/p><ul><li>one<\/li>/.test(shown) && !shown.includes('ag-code'), shown);
  check('…and the notes around it stay outside it', shown.indexOf('open the ticket') < shown.indexOf('ag-message') && shown.lastIndexOf('Tell me if') > shown.lastIndexOf('Durval'));
  const qb = src('../agent/QuoteBlock.tsx');
  check('its copy is the block\'s own source, as the agent wrote it, drawn as a reply is', /export function MessageBlock[\s\S]*replyClipboard\(\[\{ kind: 'prose', text: source \}\]\)\.html[\s\S]*copyRich\(source, html\)/.test(qb));
  const clip = replyClipboard([{ kind: 'prose', text: body }]);
  check('what it copies is just the message, with no colour and no notes', clip.text === body && !clip.html.includes('open the ticket') && clip.html.includes('<strong>Subject: VLT-329</strong>') && !/style="(?!font-family: monospace)|class=/.test(clip.html), clip.html);
  const whole = replyClipboard([{ kind: 'prose', text: reply }]);
  check('the reply\'s own copy still takes all of it, and leaves the block\'s button out', whole.html.includes('open the ticket.') && whole.html.includes('Hi Olena,') && !whole.html.includes('⧉ copy'), whole.html);
  const code = renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown('```ts\nconst a = 1;\n```')));
  check('any other fenced block is still code on white', code.includes('class="ag-code"') && !code.includes('ag-message'));
  const four = renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown('````message\nRun:\n\n```sh\nmake test\n```\n````')));
  check('a message with code in it, fenced with four backticks, keeps its code inside', four.includes('class="ag-message"') && four.includes('make test') && (four.match(/ag-message"/g) ?? []).length === 1, four);
  const css = src('../agent/agent.css');
  check('framed in tokens, the button clear of the text', /\.ag-message > \.ag-message-copy \{/.test(css) && /\.ag-message \{[^}]*border: 1px solid var\(--line2\);[^}]*padding: 10px 104px 10px 14px;/.test(css) && !/\.ag-message[^{]*\{[^}]*#[0-9a-fA-F]{3,8}\b/.test(css));
})();

// Both themes' colours from tokens.css, and WCAG's contrast, for the sections after 53 (§9 keeps its own).
const themeTokens = (): { dark: Map<string, string>; light: Map<string, string> } => {
  const css = readFileSync(new URL('../../../shared/src/tokens.css', import.meta.url), 'utf8');
  const block = (selector: string): Map<string, string> => {
    const at = css.indexOf(`${selector} {`);
    const body = at === -1 ? '' : css.slice(at, css.indexOf('}', at));
    return new Map([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
  };
  const dark = block(':root');
  return { dark, light: new Map([...dark, ...block(":root[data-theme='light'], [data-theme='light']")]) };
};
const contrast = (a: string, b: string): number => {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

console.log("\n54 · each agent wears its model's maker, a lettered square in the maker's colour, wherever it is named (Amendment 208)");
await (async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { SOURCE_KEYS, sourceOf, sourceTitle } = await import('./source.js');
  const { SourceMark } = await import('../shell/SourceMark.js');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const key = (model: string, provider?: string): string => sourceOf({ model, ...(provider ? { provider } : {}) }).key;

  // ── the maker, by id ──
  const makers: [string, string, string?][] = [
    ['claude-opus-5-5', 'claude'],
    ['us.anthropic.claude-opus-5-5', 'claude'],
    ['eu.anthropic.claude-sonnet-4-5-v1:0', 'claude'],
    ['claude-sonnet-4-5', 'claude', 'copilot'],
    ['gpt-5', 'openai', 'copilot'],
    ['o3', 'openai', 'copilot'],
    ['o4-mini', 'openai', 'copilot'],
    ['gemini-2.5-pro', 'google', 'copilot'],
    ['llama-3.3-70b', 'meta', 'openrouter'],
    ['mistral-large', 'mistral', 'openrouter'],
    ['grok-4', 'xai', 'openrouter'],
    ['deepseek-r1', 'deepseek', 'openrouter'],
    ['qwen3-coder', 'qwen', 'openrouter'],
  ];
  const wrong = makers.filter(([m, k, p]) => key(m, p) !== k).map(([m, k, p]) => `${m} (${p ?? 'claude'}) is ${key(m, p)}, not ${k}`);
  check('each maker is read from its model id', wrong.length === 0, wrong.join('; '));
  const routed: [string, string][] = [
    ['anthropic/claude-sonnet-4.5', 'claude'],
    ['openai/gpt-5', 'openai'],
    ['google/gemini-2.5-pro', 'google'],
    ['meta-llama/llama-3.3-70b-instruct', 'meta'],
    ['mistralai/mistral-large', 'mistral'],
    ['x-ai/grok-4', 'xai'],
    ['deepseek/deepseek-r1', 'deepseek'],
    ['qwen/qwen3-coder', 'qwen'],
  ];
  const badRoute = routed.filter(([m, k]) => key(m, 'openrouter') !== k).map(([m]) => `${m} is ${key(m, 'openrouter')}`);
  check("an OpenRouter id's maker/ prefix decides", badRoute.length === 0, badRoute.join('; '));
  check('…the prefix and not the name after it', key('openai/llama-ish', 'openrouter') === 'openai' && key('nousresearch/llama-3-hermes', 'openrouter') === 'openrouter');
  check('a word that only starts like one is not one', key('opus-ish', 'copilot') === 'copilot' && key('o10', 'copilot') === 'copilot' && key('gptx', 'openrouter') === 'openrouter');
  check(
    "an id no rule knows gets its engine's mark, and a Claude agent Claude's",
    key('some-model', 'copilot') === 'copilot' && key('some-model', 'openrouter') === 'openrouter' && key('sonnet') === 'claude' && key('opus', 'claude') === 'claude',
  );
  const acme = sourceOf({ model: 'x1', provider: 'acme' });
  check('an engine the web does not know is "other", named as the daemon names it', acme.key === 'other' && acme.label === 'acme' && acme.mark === '?', JSON.stringify(acme));
  const gpt = sourceOf({ model: 'gpt-5', provider: 'copilot' });
  check('a source is its key, letters, maker and engine', gpt.key === 'openai' && gpt.mark === 'O' && gpt.label === 'OpenAI' && gpt.engine === 'Copilot', JSON.stringify(gpt));
  const marks = SOURCE_KEYS.map((k) => sourceOf({ model: routed.find(([, r]) => r === k)?.[0] ?? '', provider: k === 'other' ? 'acme' : k === 'copilot' || k === 'openrouter' ? k : 'openrouter' }).mark);
  check('every mark is one or two letters, and no two the same', marks.every((m) => m.length >= 1 && m.length <= 2) && new Set(marks).size === SOURCE_KEYS.length, marks.join(' '));

  // ── its title ──
  check('its title names the maker, the model and the engine: "OpenAI gpt-5 · via Copilot"', sourceTitle({ model: 'gpt-5', provider: 'copilot' }) === 'OpenAI gpt-5 · via Copilot', sourceTitle({ model: 'gpt-5', provider: 'copilot' }));
  check('…"Claude opus-5-5" on the Claude engine, the id shortened as everywhere', sourceTitle({ model: 'us.anthropic.claude-opus-5-5' }) === 'Claude opus-5-5', sourceTitle({ model: 'us.anthropic.claude-opus-5-5' }));
  check('…and Claude through another engine says which', sourceTitle({ model: 'claude-sonnet-4-5', provider: 'copilot' }) === 'Claude sonnet-4-5 · via Copilot');
  check("…an OpenRouter id without its prefix, and an engine's own mark without a second via", sourceTitle({ model: 'x-ai/grok-4', provider: 'openrouter' }) === 'xAI grok-4 · via OpenRouter' && sourceTitle({ model: 'some-model', provider: 'copilot' }) === 'Copilot some-model', sourceTitle({ model: 'some-model', provider: 'copilot' }));

  // ── the mark ──
  const html = renderToStaticMarkup(createElement(SourceMark, { agent: { model: 'gpt-5', provider: 'copilot' } }));
  check('the mark is a square of letters, its words in its title', html === '<span class="ui-src s-openai" title="OpenAI gpt-5 · via Copilot" aria-label="OpenAI gpt-5 · via Copilot">O</span>', html);
  check('…and nothing for an agent the list does not have', renderToStaticMarkup(createElement(SourceMark, { agent: undefined })) === '');

  // ── in each place ──
  const nav = src('../shell/Navigator.tsx');
  const tree = src('../shell/navtree.ts');
  check(
    "the navigator's agent row, beside the dot, from the agent the row is",
    /<Dot status=\{a\.status\} \/>\s*\{\/\*[^*]*\*\/\}\s*<SourceMark agent=\{a\.source\} \/>\s*<span className="sh-nav-label">/.test(nav) && /source: \{ \.\.\.\(agent\.provider \? \{ provider: agent\.provider \} : \{\}\), model: agent\.model \}/.test(tree),
  );
  const agentScreen = src('../agent/agent.tsx');
  check(
    "the Agent screen's tabs, beside each dot",
    /<Dot status=\{t\.status\} \/>\s*\{\/\*[^*]*\*\/\}\s*<SourceMark agent=\{agents\.find\(\(a\) => a\.id === t\.id\)\} \/>\s*\{t\.label\}/.test(agentScreen),
  );
  check("…and its header, beside the model", /<SourceMark agent=\{agent\} \/>\s*<span className="ag-model" title=\{agent\.model\}>/.test(agentScreen));
  check(
    "a Fleet card's agent rows",
    /<Dot status=\{shown\} \/>\s*\{\/\*[^*]*\*\/\}\s*<SourceMark agent=\{agent\} \/>\s*<span className="fl-arow-nm">/.test(src('../fleet/card.tsx')),
  );
  check(
    "a Project screen's lanes",
    /<Dot status=\{shown\} \/>\s*\{\/\*[^*]*\*\/\}\s*<SourceMark agent=\{agent\} \/>\s*<span className="pj-lane-nm">/.test(src('../fleet/lane.tsx')),
  );

  // ── its colours ──
  const ui = src('../shell/ui.css');
  const noRule = SOURCE_KEYS.filter((k) => k !== 'other' && !new RegExp(`\\.ui-src\\.s-${k} \\{ --src: var\\(--src-${k}\\); \\}`).test(ui));
  check("each maker's square is filled from its own token", noRule.length === 0 && /\.ui-src \{\s*--src: var\(--src-other\);[^}]*background: var\(--src\);\s*color: var\(--bg\);/.test(ui), noRule.join(', '));
  check('…in tokens only, 14px square', !/\.ui-src[^{]*\{[^}]*#[0-9a-fA-F]{3,8}\b/.test(ui) && /\.ui-src \{[^}]*width: 14px;\s*height: 14px;/.test(ui));
  const { dark, light } = themeTokens();
  const low: string[] = [];
  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    for (const k of SOURCE_KEYS) {
      const fill = theme.get(`src-${k}`);
      const r = fill ? contrast(theme.get('bg')!, fill) : 0;
      if (r < 4.5) low.push(`${name} --bg on --src-${k} ${fill ? r.toFixed(2) : 'missing'}`);
    }
  }
  check("each maker has a colour in both themes, and its --bg letters clear 4.5:1 on it", low.length === 0, low.join('; '));
})();

console.log("\n55 · a helper's message box is shut, pointing at its orchestrator, until you unlock it (Amendment 209)");
await (async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { HelperLock, directedBy, lockedBy } = await import('../agent/HelperLock.js');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const ag = (id: string, role: string, extra: Partial<Agent> = {}) => ({ id, role, ...extra }) as unknown as Agent;
  const orch = ag('o1', 'orchestrator', { name: 'lead' });
  const helper = ag('h1', 'developer', { parentId: 'o1' });
  const other = ag('h2', 'tester', { parentId: 'o1' });
  const solo = ag('s1', 'developer');
  const agents = [orch, helper, other, solo];

  check('a helper is directed by its orchestrator', directedBy(helper, agents)?.id === 'o1');
  check('…and an agent that is not a helper by no one', directedBy(solo, agents) === null && directedBy(orch, agents) === null && directedBy(ag('x', 'developer', { parentId: null }), agents) === null);
  check("…nor a helper whose orchestrator is gone, which has no one to message instead", directedBy(ag('h9', 'developer', { parentId: 'gone' }), agents) === null);
  check("a helper's box is shut, and an orchestrator's and a lone agent's open", lockedBy(helper, agents, null)?.id === 'o1' && lockedBy(orch, agents, null) === null && lockedBy(solo, agents, null) === null);
  check('unlock opens it, for that helper only', lockedBy(helper, agents, 'h1') === null && lockedBy(other, agents, 'h1')?.id === 'o1');

  const html = renderToStaticMarkup(createElement(HelperLock, { orchestrator: orch, onOpen: () => {}, onUnlock: () => {} }));
  const words = html.replace(/<[^>]+>/g, '');
  check('its line says who directs it, and offers open and unlock', words === 'lead directs this helper — message the orchestrator instead·open lead·unlock', words);
  check('…the orchestrator named as its tab is, name else role', /<b>lead<\/b>/.test(html) && renderToStaticMarkup(createElement(HelperLock, { orchestrator: ag('o2', 'orchestrator'), onOpen: () => {}, onUnlock: () => {} })).includes('open orchestrator</button>'));
  check('…in the composer\'s place, with no box to type in', html.startsWith('<div class="ag-composer ag-lock" role="note">') && !/<textarea|<input/.test(html));

  const screen = src('../agent/agent.tsx');
  check(
    "the Agent screen shuts the box for a helper, and keeps the composer for anyone else",
    /const lockOf = lockedBy\(agent, agents, unlocked\);/.test(screen) &&
      /<TermPanel agent=\{agent\} \/> : lockOf \? \(\s*<HelperLock orchestrator=\{lockOf\} onOpen=\{\(\) => openAgent\(lockOf\)\} onUnlock=\{\(\) => setUnlocked\(agent\.id\)\} \/>\s*\) : \(\s*<Composer agent=\{agent\} \/>/.test(screen),
  );
  check('…open goes to the orchestrator, unlock to this helper', /onOpen=\{\(\) => openAgent\(lockOf\)\}/.test(screen) && /onUnlock=\{\(\) => setUnlocked\(agent\.id\)\}/.test(screen));
  check(
    'unlocked lasts until you leave: state, reset on another agent, never a setting',
    /const \[unlocked, setUnlocked\] = useState<string \| null>\(null\);\s*useEffect\(\(\) => setUnlocked\(null\), \[active\]\);/.test(screen) && !/writeSetting\([^)]*unlock/i.test(screen),
  );
  check(
    'the transcript, ⏸ and the stop controls are outside it, so they stay',
    screen.indexOf('<StopControls agent={agent}') !== -1 && screen.indexOf('<StopControls agent={agent}') < screen.indexOf('className="ag-composer-wrap"'),
  );
  const css = src('../agent/agent.css');
  check('…drawn in tokens only', /\.ag-lock-act \{[^}]*color: var\(--live\);/.test(css) && !/\.ag-lock[^{]*\{[^}]*#[0-9a-fA-F]{3,8}\b/.test(css));
})();

console.log("\n56 · each project has a colour bar, in the navigator and on its pages, kept or auto (Amendment 210)");
await (async () => {
  const { projectColors, projClass } = await import('./projectColor.js');
  const { PROJECT_COLORS } = await import('@conductor/shared');
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const proj = (n: number, color?: string | null) => ({ id: `p${n}`, createdAt: `2026-11-${String(n).padStart(2, '0')}T00:00:00Z`, ...(color !== undefined ? { color } : {}) }) as Pick<Project, 'id' | 'createdAt' | 'color'>;
  const keysOf = (list: Pick<Project, 'id' | 'createdAt' | 'color'>[]): string[] => list.map((p) => projectColors(list).get(p.id)!);

  const eight = Array.from({ length: 8 }, (_, i) => proj(i + 1));
  check('auto gives the first eight projects eight colours, in the palette\'s order', keysOf(eight).join(' ') === PROJECT_COLORS.join(' '), keysOf(eight).join(' '));
  const shuffled = [eight[5]!, eight[2]!, eight[7]!, eight[0]!, eight[4]!, eight[1]!, eight[6]!, eight[3]!];
  check('…by the order they were created, not the order they are listed', eight.every((p) => projectColors(shuffled).get(p.id) === projectColors(eight).get(p.id)));
  const more = [...eight, proj(9), proj(10)];
  check('…so adding a project never changes one before it', eight.every((p) => projectColors(more).get(p.id) === projectColors(eight).get(p.id)));
  const sixteen = Array.from({ length: 16 }, (_, i) => proj(i + 1));
  const counts = PROJECT_COLORS.map((k) => keysOf(sixteen).filter((c) => c === k).length);
  check('…and spread: sixteen projects have each colour twice', counts.every((n) => n === 2), counts.join(' '));
  const kept = [proj(1, 'mint'), proj(2), proj(3, 'plum'), proj(4)];
  check('a colour you picked wins', projectColors(kept).get('p1') === 'mint' && projectColors(kept).get('p3') === 'plum');
  check('…and counts for the ones after it, so auto goes round it', projectColors(kept).get('p2') === 'sky' && projectColors(kept).get('p4') === 'yellow', keysOf(kept).join(' '));
  check('a key the palette doesn\'t have is auto, never a missing token', projectColors([proj(1, 'teal')]).get('p1') === 'sky' && projectColors([proj(1, null)]).get('p1') === 'sky');
  check('the class is pc-<key>, and nothing without one', projClass('mint') === 'pc-mint' && projClass(undefined) === '');

  // ── the tokens: both themes, a bar's contrast, and never a status colour ──
  const { dark, light } = themeTokens();
  const ui = src('../shell/ui.css');
  const missing = PROJECT_COLORS.filter((k) => !dark.has(`proj-${k}`) || !light.has(`proj-${k}`) || light.get(`proj-${k}`) === dark.get(`proj-${k}`) || !ui.includes(`.pc-${k} { --proj: var(--proj-${k}); }`));
  check('each key is a --proj-<key> token with its own value in each theme, and a pc-<key> class', missing.length === 0, missing.join(' '));
  const lab = (hex: string): number[] => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
  };
  const apart = (a: string, b: string): number => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));
  const STATUS = ['live', 'need', 'fail', 'done', 'queue', 'idle', 'you'];
  for (const [theme, t] of [['dark', dark], ['light', light]] as const) {
    const dim = PROJECT_COLORS.flatMap((k) => ['bg', 'surf'].map((on) => [k, on, contrast(t.get(`proj-${k}`)!, t.get(on)!)] as const)).filter(([, , r]) => r < 3);
    check(`${theme}: each bar clears 3:1 on --bg and --surf, a graphic's floor`, dim.length === 0, dim.map(([k, on, r]) => `${k} on ${on} ${r.toFixed(2)}`).join('; '));
    const like = PROJECT_COLORS.flatMap((k) => STATUS.map((st) => [k, st, apart(t.get(`proj-${k}`)!, t.get(st)!)] as const)).filter(([, , d]) => d < 0.08);
    check(`${theme}: no bar is near a status colour (OKLab 0.08 or more)`, like.length === 0, like.map(([k, st, d]) => `${k}~${st} ${d.toFixed(3)}`).join('; '));
    const twins = PROJECT_COLORS.flatMap((k, i) => PROJECT_COLORS.slice(i + 1).map((o) => [k, o, apart(t.get(`proj-${k}`)!, t.get(`proj-${o}`)!)] as const)).filter(([, , d]) => d < 0.08);
    check(`${theme}: …nor near another bar`, twins.length === 0, twins.map(([k, o, d]) => `${k}~${o} ${d.toFixed(3)}`).join('; '));
  }

  // ── the token in each place ──
  const nav = src('../shell/Navigator.tsx');
  const shell = src('../shell/shell.css');
  check(
    'the navigator: a 4px bar down the whole project group, colours decided over every project',
    /'sh-nav-proj',\s*projClass\(color\),/.test(nav) && /const colors = useMemo\(\(\) => projectColors\(projects\), \[projects\]\);/.test(nav) && /color=\{colors\.get\(p\.id\)\}/.test(nav) &&
      /\.sh-nav-proj \{[^}]*border-left: 4px solid var\(--proj, transparent\);/.test(shell) && /\.sh-nav-proj\.is-drop \{[^}]*box-shadow/.test(shell),
  );
  const card = src('../fleet/card.tsx');
  const fleet = src('../fleet/fleet.css');
  check(
    'the Fleet card: the bar at its left edge, and the status stripe kept beside it',
    /className=\{`fl-card s-\$\{stripe\} \$\{projClass\(color\)\}/.test(card) && /const color = useProjectColor\(project\.id\);/.test(card) &&
      /\.fl-card::after \{[^}]*left: 0;[^}]*width: 4px;[^}]*background: var\(--proj, transparent\);/.test(fleet) && /\.fl-card::before \{[^}]*left: 5px;[^}]*width: 3px;/.test(fleet) && /\.fl-card\.s-live::before \{\s*background: var\(--live\);/.test(fleet),
  );
  check(
    'the Project screen\'s header and the Agent screen\'s crumb, on their own backdrops still',
    /className=\{`fl-panehead has-proj \$\{projClass\(projectColors\(projects\)\.get\(project\.id\)\)\}`\}>\s*<span className="ui-crumb is-project">/.test(src('../fleet/project.tsx')) &&
      /className=\{`fl-panehead has-proj \$\{projClass\(projectColors\(projects\)\.get\(agent\.projectId\)\)\}`\}>\s*<button\s+type="button"\s+className="ui-crumb ag-crumb is-agent"/.test(src('../agent/agent.tsx')) &&
      /\.fl-panehead\.has-proj > \.ui-crumb \{[^}]*box-shadow: inset 4px 0 0 var\(--proj\);/.test(ui) && /\.ui-crumb\.is-agent \{\s*--crumb: var\(--here-agent\);/.test(ui) && /\.ui-crumb\.is-project \{\s*--crumb: var\(--here-project\);/.test(ui),
  );
  check(
    'the Files column head, when a project is open',
    /className=\{`c5-colhead \$\{projClass\(project \? projectColors\(projects\)\.get\(project\.id\) : undefined\)\}`\}/.test(src('../files/route.tsx')) &&
      /\.c5-colhead\[class\*='pc-'\] \{[^}]*box-shadow: inset 4px 0 0 var\(--proj\);/.test(src('../files/files.css')),
  );
  check(
    'the edit form: auto and a swatch for each key, saved only when it changed',
    /setColour\(null\)/.test(card) && /PROJECT_COLORS\.map\(\(k\) => \(/.test(card) && /onClick=\{\(\) => setColour\(k\)\}/.test(card) && /if \(colour !== \(project\.color \?\? null\)\) patch\.color = colour;/.test(card) &&
      /color\?: ProjectColor \| null/.test(src('../fleet/endpoints.ts')),
  );
  const drawn = [ui.slice(ui.indexOf('a project\'s colour bar'), ui.indexOf('the orchestrator of an orchestrated stack')), fleet.slice(fleet.indexOf('.fl-card::after'), fleet.indexOf('.fl-card.s-live')), fleet.slice(fleet.indexOf('.fl-swatches'), fleet.indexOf('.fl-f-warn {')), shell.slice(shell.indexOf('.sh-nav-proj {'), shell.indexOf('.sh-nav-proj.is-dragging'))];
  check('…drawn in tokens only', drawn.every((c) => c.length > 0 && !/#[0-9a-fA-F]{3,8}\b/.test(c)));
})();

console.log(
  failures === 0
    ? '\nW0 web verify: PASS — store reducer is idempotent and referentially honest; the cleanup button says what it deletes; build info says what is running; model pickers say when a model is wrong; a screen can exist without a tab; one projects list says what needs you; a project is added with its folders; the storage question says what it does; settings are kept by the daemon; a Settings tab sets them; allow-always rules are listed and revoked; helpers nest under their orchestrator; the Fleet cards keep your order; projects carry notes; a daily budget goes yellow then red; notes can be due; drafts survive; every card opens its project; personas can be edited; the OpenRouter key is never shown; a finished job says so until seen; the live and done tags are filled, the lane carries their edge, and a done agent reads finished; an agent\'s own finished clears once you open it; both themes clear 4.5:1 everywhere that matters, the open top-bar tab included; the retry delays are set on Settings, and no budget stops anything; spend reads today and in total for each agent, project and the fleet; a Fleet card\'s agents fold, per card, and what needs you stays; the month reads beside today, against a monthly budget for the fleet and for each project, which only warns; and each engine and Claude route has its month, in its own unit, by provider on Metrics and against a budget on Settings; and an agent waiting for the model to come back says so, its card and the status bar say the provider is down, and its job reads running; and an agent\'s activity folds to its latest step, and a reply stays open until you tick it read, which its row and tab say until you do; and a project\'s and a stack\'s status read in the navigator as on their Fleet card, by one rule; and your messages fold, the long ones to start with, and every message and reply says when; and every fold has one chevron, on its left, 16px and --ink2, and Read it is an 18px box; and one button ticks every reply on an agent read, in one write, and folds them; and a reply copies without the app\'s colours, from its ⧉ copy and from Cmd-C; and an agent you paused counts as N paused in its card\'s headline, on a chip filled in --idle that clears 4.5:1 in both themes, its transcript says until when, and ⏸\'s menu says when each choice wakes it (Amendment 205); and the fleet\'s month can be set to the AI gateway\'s figure from Settings, which the status bar marks with what it is corrected by and when, and the tables by provider say are as counted (Amendment 206); and each agent wears its model\'s maker, a lettered square in that maker\'s colour, in the navigator, its tabs and header, a Fleet card and a Project lane (Amendment 208); and a helper\'s message box is shut, pointing at its orchestrator, until you unlock it (Amendment 209); and each project has a colour bar, kept or auto, in the navigator, on its Fleet card and at the top of its screens, in both themes and never a status colour (Amendment 210).\n'
    : `\nW0 web verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
