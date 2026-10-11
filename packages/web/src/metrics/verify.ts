/**
 * Validator checks for Amendment 122's web half (the Metrics screen).
 *
 * No daemon and no DOM: the rates and words are pure and are run on fixture responses;
 * the registration, the status bar, nav.ts and the stylesheet are read as source, because
 * importing route.tsx would pull in its CSS.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/metrics/verify.ts
 */

import { readFileSync } from 'node:fs';
import type { MetricsBefore, MetricsCounts, MetricsDay, MetricsModelRow, MetricsResponse } from '@conductor/shared';
import {
  BEFORE_NOTE,
  DAY_COLUMNS,
  DEFAULT_RANGE,
  HOW_COUNTED,
  MODEL_COLUMNS,
  RANGES,
  RANGE_KEY,
  asRange,
  beforeLine,
  beforeModelLine,
  cell,
  dayLabel,
  derive,
  dollars,
  duration,
  emptyLine,
  isEmpty,
  modelCell,
  modelName,
  percent,
  rangeLine,
  rate,
  ratio,
  share,
  showDays,
  tiles,
  tokensText,
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

const counts = (over: Partial<MetricsCounts> = {}): MetricsCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: null,
  calls: 0,
  retries: 0,
  runs: 0,
  failedRuns: 0,
  runMs: 0,
  apiMs: 0,
  timedCalls: 0,
  timedOutputTokens: 0,
  ...over,
});

const opus: MetricsModelRow = {
  provider: 'claude',
  model: 'claude-opus-4-7',
  ...counts({
    inputTokens: 1_200_000, outputTokens: 80_000, cacheReadTokens: 900_000, costUsd: 14.5,
    calls: 200, retries: 6, runs: 20, failedRuns: 2, runMs: 20 * 90_000, apiMs: 400_000, timedCalls: 200, timedOutputTokens: 80_000,
  }),
};
const gpt: MetricsModelRow = {
  provider: 'copilot',
  model: 'gpt-5-mini',
  ...counts({ inputTokens: 300_000, outputTokens: 20_000, calls: 50, runs: 5, runMs: 5 * 30_000, apiMs: 50_000, timedCalls: 25, timedOutputTokens: 5_000 }),
};
const total = counts({
  inputTokens: opus.inputTokens + gpt.inputTokens, outputTokens: opus.outputTokens + gpt.outputTokens, cacheReadTokens: opus.cacheReadTokens,
  costUsd: 14.5, calls: 250, retries: 6, runs: 25, failedRuns: 2, runMs: opus.runMs + gpt.runMs, apiMs: 450_000, timedCalls: 225, timedOutputTokens: 85_000,
});
const day = (d: string, over: Partial<MetricsCounts>): MetricsDay => ({ day: d, ...counts(over) });
const before: MetricsBefore = {
  agents: 3,
  costUsd: 7.25,
  inputTokens: 5_000,
  outputTokens: 900,
  models: [
    { provider: 'claude', model: 'opus', agents: 2, costUsd: 7.25, inputTokens: 4_000, outputTokens: 800 },
    { provider: 'copilot', model: 'gpt-5-mini', agents: 1, costUsd: null, inputTokens: 1_000, outputTokens: 100 },
  ],
};
const resp = (over: Partial<MetricsResponse> = {}): MetricsResponse => ({
  range: 'all',
  from: '2026-10-08',
  to: '2026-10-10',
  since: '2026-10-08',
  total,
  models: [opus, gpt],
  days: [day('2026-10-10', { runs: 10, calls: 100 }), day('2026-10-09', { runs: 15, calls: 150, failedRuns: 2 })],
  before,
  ...over,
});

console.log('\n1 · a rate is two real counts divided, or a dash');
{
  check('no whole is no rate, not 0% and not NaN', ratio(3, 0) === null && ratio(0, 0) === null && percent(null) === '—');
  check('percentages: none, under 1, one decimal under 10, whole above', percent(0) === '0%' && percent(0.004) === '<1%' && percent(0.034) === '3.4%' && percent(0.12) === '12%' && percent(1.5) === '150%');
  check('durations', duration(null) === '—' && duration(420) === '420 ms' && duration(4200) === '4.2 s' && duration(42_000) === '42 s' && duration(192_000) === '3m 12s' && duration(3_900_000) === '1h 05m', [duration(420), duration(4200), duration(42_000), duration(192_000), duration(3_900_000)].join(' | '));
  check('dollars: a dash for an engine that reports none, never $0.00', dollars(null) === '—' && dollars(0) === '$0.00' && dollars(14.5) === '$14.50' && dollars(0.004) === '<$0.01' && dollars(1234.5) === '$1,234.50');
  check('tokens are said as the budget notes say them, rounded down', tokensText(950) === '950' && tokensText(12_500) === '12.5k' && tokensText(1_280_000) === '1.2M');
  check('speed', rate(null) === '—' && rate(42.04) === '42 tok/s' && rate(42.5) === '42.5 tok/s' && rate(1250) === '1.2k tok/s', [rate(42.04), rate(42.5), rate(1250)].join(' | '));
}

console.log('\n2 · derived figures use only what was measured');
{
  const d = derive(opus);
  check('error rate is failed runs over runs', Math.abs((d.errorRate ?? 0) - 0.1) < 1e-9);
  check('retry rate is retried calls over calls', Math.abs((d.retryRate ?? 0) - 0.03) < 1e-9);
  check('time per run is the runs\' wall time over runs', d.avgRunMs === 90_000);
  check('time per call is model-call time over the calls that were timed, and tokens per second over their tokens', d.apiPerCallMs === 2_000 && d.tokensPerSec === 200, JSON.stringify(d));
  const g = derive(gpt);
  check('half the calls timed: the per-call time divides only those', g.apiPerCallMs === 2_000 && g.tokensPerSec === 100, JSON.stringify(g));
  const none = derive(counts({ calls: 10, runs: 2, runMs: 5000, outputTokens: 400 }));
  check('an engine that reports no model-call time has no per-call time and no speed', none.apiPerCallMs === null && none.tokensPerSec === null && none.avgRunMs === 2500);
  check('nothing at all is all dashes', ((e) => e.errorRate === null && e.retryRate === null && e.avgRunMs === null && e.apiPerCallMs === null && e.tokensPerSec === null)(derive(counts())));
  check('speed needs both numbers: time without tokens is none', derive(counts({ apiMs: 5000, timedCalls: 2 })).tokensPerSec === null && derive(counts({ timedOutputTokens: 500 })).tokensPerSec === null);
}

console.log('\n3 · the five figures at the top');
{
  const t = tiles(total);
  const by = (id: string) => t.find((x) => x.id === id)!;
  check('tokens, calls, time, errors and cost, in that order', t.map((x) => x.id).join() === 'tokens,calls,time,errors,cost');
  check('tokens: the sum, and in / out / cached', by('tokens').value === '1.6M' && by('tokens').sub === '1.5M in · 100k out · 900k cached', JSON.stringify(by('tokens')));
  check('calls say how many runs made them', by('calls').value === '250' && by('calls').sub === '25 runs');
  check(
    'time: an average run, then time per call and speed over the calls that were timed, and says how many were',
    by('time').value === '1m 18s' && by('time').sub === '2.0 s per call · 189 tok/s' && /225 of 250 calls/.test(by('time').title ?? ''),
    JSON.stringify(by('time')),
  );
  check('errors: the failed share of runs, with both counts, and the retried share of calls', by('errors').value === '8.0%' && /2 of 25 runs failed/.test(by('errors').sub) && /6 of 250 calls retried \(2\.4%\)/.test(by('errors').sub), JSON.stringify(by('errors')));
  check('errors are bad news only when a run failed', by('errors').bad === true && tiles(counts({ runs: 4 })).find((x) => x.id === 'errors')!.bad === false);
  check('a stop of your own, a pause and a budget stop are not in the failed count: the tile says so', /stop, a pause and a budget stop/.test(by('errors').title ?? ''));
  check('cost is the dollars of the engines that report them', by('cost').value === '$14.50');
  const tokenOnly = tiles(counts({ inputTokens: 10, outputTokens: 5, calls: 1, runs: 1 })).find((x) => x.id === 'cost')!;
  check('with no engine reporting dollars, cost is a dash and says why', tokenOnly.value === '—' && /no engine here reports dollars/.test(tokenOnly.sub));
  const empty = tiles(counts());
  check('an empty range reads as dashes and zeros, with no NaN anywhere', empty.every((x) => !/NaN|undefined|Infinity/.test(`${x.value}${x.sub}`)) && empty.find((x) => x.id === 'errors')!.sub === 'no runs', JSON.stringify(empty));
}

console.log('\n4 · the per-model and per-day rows');
{
  const m = (id: Parameters<typeof cell>[0], c: MetricsCounts) => cell(id, c);
  check('a model row: tokens, calls, time, speed, failures, retries, cost', m('in', opus) === '1.2M' && m('out', opus) === '80k' && m('cache', opus) === '900k' && m('calls', opus) === '200' && m('run', opus) === '1m 30s' && m('percall', opus) === '2.0 s' && m('tps', opus) === '200 tok/s' && m('errors', opus) === '10% · 2/20' && m('retries', opus) === '3.0% · 6/200' && m('cost', opus) === '$14.50', MODEL_COLUMNS.map((c) => `${c.id}=${m(c.id, opus)}`).join(' '));
  check('a Copilot row shows tokens and no dollars, and a dash for the cache and retries it never reports', m('cost', gpt) === '—' && m('cache', gpt) === '—' && modelCell('retries', gpt) === '—' && modelCell('retries', opus) === '3.0% · 6/200', MODEL_COLUMNS.map((c) => `${c.id}=${m(c.id, gpt)}`).join(' '));
  check('a row with no runs has a dash for errors, not 0%', m('errors', counts({ calls: 3 })) === '—');
  check('the columns have words on hover', [...MODEL_COLUMNS, ...DAY_COLUMNS].every((c) => c.label.length > 0 && c.title.length > 10));
  check('the day table has runs, calls, tokens, time, failures and cost', DAY_COLUMNS.map((c) => c.id).join() === 'runs,calls,in,out,run,errors,cost');
  check("a model's name carries its engine unless it is Claude's", modelName(opus).engine === null && modelName(gpt).engine === 'Copilot' && modelName({ provider: 'openrouter', model: 'x' }).engine === 'OpenRouter', JSON.stringify(modelName(gpt)));
  check('a bar is the share of the range\'s tokens, 0 to 1', Math.abs(share(opus, total) - 1_280_000 / 1_600_000) < 1e-9 && share(opus, counts()) === 0 && share(total, total) === 1);
}

console.log('\n5 · days, ranges and what an empty one says');
{
  check('three ranges, in order, and the default is today', RANGES.map((r) => r.id).join() === 'today,7d,all' && DEFAULT_RANGE === 'today');
  check('a remembered range that is not one of them is today', asRange('7d') === '7d' && asRange('all') === 'all' && asRange('fortnight') === 'today' && asRange(null) === 'today');
  check('a day reads as the local day it is, whatever the zone', dayLabel('2026-10-10') === 'Sat 10 Oct' && dayLabel('2026-01-01') === 'Thu 1 Jan' && dayLabel('nope') === 'nope', `${dayLabel('2026-10-10')} ${dayLabel('2026-01-01')}`);
  check('the span in words', rangeLine(resp({ range: 'today', from: '2026-10-10' })) === 'today, Sat 10 Oct' && rangeLine(resp({ range: '7d', from: '2026-10-04' })) === 'Sun 4 Oct to Sat 10 Oct' && rangeLine(resp()) === 'since Thu 8 Oct', [rangeLine(resp({ range: '7d', from: '2026-10-04' })), rangeLine(resp())].join(' | '));
  check('empty: nothing recorded, in words for each range, and it is not an error', isEmpty({ models: [], total: counts() }) && !isEmpty({ models: [opus], total }) && [emptyLine('today'), emptyLine('7d'), emptyLine('all')].every((s) => /^Nothing recorded/.test(s)));
  check('the day table is only for a range of days', showDays(resp({ range: 'today' })).length === 0 && showDays(resp({ range: '7d' })).length === 2 && showDays(resp()).length === 2);
}

console.log('\n6 · before metrics were recorded');
{
  const line = beforeLine(before);
  check('the line is labelled, says there is no per-call data, and gives agents, dollars and tokens', /^Before metrics were recorded \(no per-call data\): 3 agents · \$7\.25 · 5k in · 900 out$/.test(line), line);
  check('it leaves dollars out when no engine in it reports them', !/\$/.test(beforeLine({ ...before, costUsd: null })));
  check("it says per-model attribution is the agent's last model, and what the tokens are", /credited to the model it has now/.test(BEFORE_NOTE) && /last run only/.test(BEFORE_NOTE));
  check('and by model', beforeModelLine(before.models[0]!) === 'opus — 2 agents · $7.25 · 4k in · 800 out' && beforeModelLine(before.models[1]!).startsWith('gpt-5-mini ('), beforeModelLine(before.models[1]!));
  check('the explanations say how each figure is counted, including what is not an error', HOW_COUNTED.some((l) => /budget stop/.test(l)) && HOW_COUNTED.some((l) => /round-trips/.test(l)) && HOW_COUNTED.some((l) => /dollars/.test(l)));
}

console.log('\n7 · the screen is registered, reachable on 8, and in both themes');
{
  const route = src('./route.tsx');
  const def = route.slice(route.indexOf('export const screen'));
  check("it is a tab on 8, after Branches and before Settings", /id: 'metrics'/.test(def) && /hotkey: '8'/.test(def) && /order: 80/.test(def) && !/tab: false/.test(def), def);
  check('its range is remembered as a setting, not in the browser', route.includes('RANGE_KEY') && RANGE_KEY === 'conductor.metricsRange' && !/localStorage/.test(route));
  check('it draws the five tiles, a table of models, a table of days and the before section', /tiles\(resp\.total\)/.test(route) && /modelCell\(c\.id, m\)/.test(route) && /MODEL_COLUMNS/.test(route) && /DAY_COLUMNS/.test(route) && /resp\.before/.test(route) && /aria-label="by model"/.test(route));
  check('the range buttons are the three ranges and say which is open', /RANGES\.map/.test(route) && /aria-pressed=\{r\.id === range\}/.test(route));
  check('it re-reads on arrival, on focus, on a change of range, and when spend or a status changes', /addEventListener\('focus'/.test(route) && /\[load\]/.test(route) && /costToday/.test(route) && /a\.status/.test(route));
  const endpoints = src('./endpoints.ts');
  check('the request is GET /api/metrics?range=', /\/api\/metrics\?range=/.test(endpoints));
  const daemon = src('../../../daemon/src/routes/metrics.ts');
  check("and the daemon's route takes exactly these ranges", /RANGES: readonly MetricsRange\[\] = \['today', '7d', 'all'\]/.test(daemon) && RANGES.length === 3);
  const nav = src('../shell/nav.ts');
  check("nav.ts has SCREEN.metrics = 'metrics' and openMetrics", /metrics:\s*'metrics'/.test(nav) && /export function openMetrics/.test(nav));
  check('the status bar says 1–8, and 9 and 0 are still Settings and Diagnostics', /<kbd>1<\/kbd>–<kbd>8<\/kbd> screens/.test(src('../shell/shell.tsx')) && /hotkey: '9'/.test(src('../settings/route.tsx')) && /hotkey: '0'/.test(src('../diagnostics/route.tsx')));
  check('the reserved-slot table names 8', /'8'\s+Metrics/.test(src('../lib/screens.ts')));

  // No other screen has 8, and none of the tabs shares a key.
  const keys: string[] = [];
  for (const dir of ['fleet', 'agent', 'attention', 'files', 'preview', 'branches', 'metrics', 'settings', 'diagnostics']) {
    for (const f of ['route.tsx']) {
      try {
        const code = src(`../${dir}/${f}`);
        for (const m of code.matchAll(/hotkey:\s*'(.)'/g)) keys.push(m[1]!);
      } catch {
        /* a directory with its screens in another file */
      }
    }
  }
  check('no two screens share a key', new Set(keys).size === keys.length && keys.filter((k) => k === '8').length === 1, keys.join());

  // Both themes: every colour is a token, and every token it uses exists.
  const css = src('./metrics.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = src('../../../shared/src/tokens.css');
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]!));
  const used = [...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
  check('no hex or rgb colour in the stylesheet: every colour is a token', !/#[0-9a-fA-F]{3,8}\b/.test(css) && !/rgba?\(/.test(css));
  check('every token it uses is defined', used.every((u) => defined.has(u)), used.filter((u) => !defined.has(u)).join(', '));
  const light = tokens.slice(tokens.indexOf("[data-theme='light'] {"));
  const colourTokens = [...new Set(used)].filter((u) => /^--(bg|bg2|surf|surf2|surf3|well|line|line2|ink|ink2|ink3|fail)$/.test(u));
  check('and each colour it uses is set again for the light theme', colourTokens.every((u) => light.includes(`${u}:`)), colourTokens.filter((u) => !light.includes(`${u}:`)).join(', '));
  const textColours = [...css.matchAll(/(?:^|[;{\s])color:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
  check('text is only ink, ink2, ink3 or fail, which lib/verify.ts holds to 4.5:1 on every surface in both themes', textColours.length > 5 && textColours.every((c) => ['--ink', '--ink2', '--ink3', '--fail'].includes(c)), [...new Set(textColours)].join());
  check('--fail is used for failures only: the Errors tile, a failed count, and the error notice', (css.match(/var\(--fail\)/g) ?? []).length === 3 && /\.mt-tile\.bad \.mt-tile-value/.test(css) && /td\.bad/.test(css) && /\.mt-note\.fail/.test(css));
  check('and no status colour is used decoratively', !/var\(--(live|need|done|queue|idle)\)/.test(css));
}

console.log(
  failures === 0
    ? '\nAmendment 122 web verify: PASS — every rate is two real counts divided or a dash; a token engine shows tokens and no dollars; the failed share leaves out your stop, a pause and a budget stop; time per call and speed use only timed calls; the three ranges, the day table, the before-metrics line and its caveat read from a response alone; 8 is Metrics and nothing else; the status bar says 1–8; the stylesheet is tokens only, set for both themes.\n'
    : `\nAmendment 122 web verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
