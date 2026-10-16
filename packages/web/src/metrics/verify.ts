/**
 * Validator checks for Amendment 122's web half (the Metrics screen), and Amendment 136's
 * (the retry rate out of Claude's calls, time per turn, speed per model, the project picker),
 * and Amendment 170's (the cost-per-day chart, and why time per turn runs high).
 *
 * No daemon and no DOM: the rates and words are pure and are run on fixture responses;
 * the registration, the status bar, nav.ts and the stylesheet are read as source, because
 * importing route.tsx would pull in its CSS.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/metrics/verify.ts
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetricsBefore, MetricsCounts, MetricsDay, MetricsModelRow, MetricsResponse } from '@conductor/shared';
import {
  ALL_PROJECTS,
  BEFORE_NOTE,
  DAY_COLUMNS,
  RUNS_HIGH,
  DEFAULT_RANGE,
  HOW_COUNTED,
  MODEL_COLUMNS,
  PROJECT_KEY,
  RANGES,
  RANGE_KEY,
  asProject,
  asRange,
  addDays,
  averageSpeed,
  barTitle,
  beforeLine,
  beforeModelLine,
  cell,
  chartBars,
  chartSummary,
  dayLabel,
  derive,
  dollars,
  duration,
  emptyLine,
  isEmpty,
  modelCell,
  modelName,
  monthlyBudgetCell,
  otherEnginesRan,
  percent,
  projectChoices,
  projectNote,
  projectSpendRows,
  PROJECT_SPEND_NOTE,
  rangeLine,
  rate,
  ratio,
  share,
  showDays,
  tiles,
  tokensText,
} from './rules.js';
import { CostChart } from './chart.js';

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
  claudeCalls: 0,
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
    calls: 200, retries: 6, claudeCalls: 200, runs: 20, failedRuns: 2, runMs: 20 * 90_000, apiMs: 400_000, timedCalls: 200, timedOutputTokens: 80_000,
  }),
};
const gpt: MetricsModelRow = {
  provider: 'copilot',
  model: 'gpt-5-mini',
  ...counts({ inputTokens: 300_000, outputTokens: 20_000, calls: 50, runs: 5, runMs: 5 * 30_000, apiMs: 50_000, timedCalls: 25, timedOutputTokens: 5_000 }),
};
const total = counts({
  inputTokens: opus.inputTokens + gpt.inputTokens, outputTokens: opus.outputTokens + gpt.outputTokens, cacheReadTokens: opus.cacheReadTokens,
  costUsd: 14.5, calls: 250, retries: 6, claudeCalls: 200, runs: 25, failedRuns: 2, runMs: opus.runMs + gpt.runMs, apiMs: 450_000, timedCalls: 225, timedOutputTokens: 85_000,
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
  project: null,
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
  check("retry rate is retried calls over Claude's calls", Math.abs((d.retryRate ?? 0) - 0.03) < 1e-9);
  check('time per run is the runs\' wall time over runs', d.avgRunMs === 90_000);
  check('time per turn is model time over the turns that were timed, and tokens per second over their tokens', d.apiPerTurnMs === 2_000 && d.tokensPerSec === 200, JSON.stringify(d));
  const g = derive(gpt);
  check('half the calls timed: the per-turn time divides only those', g.apiPerTurnMs === 2_000 && g.tokensPerSec === 100, JSON.stringify(g));
  const none = derive(counts({ calls: 10, runs: 2, runMs: 5000, outputTokens: 400 }));
  check('an engine that reports no model time has no per-turn time and no speed', none.apiPerTurnMs === null && none.tokensPerSec === null && none.avgRunMs === 2500);
  check('nothing at all is all dashes', ((e) => e.errorRate === null && e.retryRate === null && e.avgRunMs === null && e.apiPerTurnMs === null && e.tokensPerSec === null)(derive(counts())));
  check('speed needs both numbers: time without tokens is none', derive(counts({ apiMs: 5000, timedCalls: 2 })).tokensPerSec === null && derive(counts({ timedOutputTokens: 500 })).tokensPerSec === null);
}

console.log("\n2b · mixed engines: the retry rate is out of Claude's calls, speed is per model (Amendment 136)");
{
  const mixed = derive(total);
  check(
    "with Copilot's 50 calls in the range, the retry rate is 6 of Claude's 200 (3%), not 6 of all 250 (2.4%)",
    Math.abs((mixed.retryRate ?? 0) - 0.03) < 1e-9 && percent(mixed.retryRate) === '3.0%',
    `${mixed.retryRate}`,
  );
  check('no Claude calls, no retry rate: a dash, even with other engines\' calls', derive(counts({ calls: 40, runs: 2 })).retryRate === null && cell('retries', counts({ calls: 40 })) === '—');
  check('Copilot alone ran: nobody could have retried, so its own row is a dash', modelCell('retries', gpt) === '—' && cell('retries', gpt) === '—');
  check('which engines ran is read from the models', otherEnginesRan([opus, gpt]) && !otherEnginesRan([opus]) && !otherEnginesRan([]));
  const avg = averageSpeed([opus, gpt]);
  check(
    "the range's speed is the models' own speeds averaged (200 and 100 → 150), not all tokens over all time (85k / 450 s ≈ 189)",
    avg?.tps === 150 && avg.of === 2 && averageSpeed([opus])?.tps === 200 && averageSpeed([counts({ calls: 3 })]) === null && averageSpeed([]) === null,
    JSON.stringify(avg),
  );
}

console.log('\n3 · the five figures at the top');
{
  const t = tiles(total, [opus, gpt]);
  const by = (id: string) => t.find((x) => x.id === id)!;
  check('tokens, calls, time, errors and cost, in that order', t.map((x) => x.id).join() === 'tokens,calls,time,errors,cost');
  check('tokens: the sum, and in / out / cached', by('tokens').value === '1.6M' && by('tokens').sub === '1.5M in · 100k out · 900k cached', JSON.stringify(by('tokens')));
  check('calls say how many runs made them', by('calls').value === '250' && by('calls').sub === '25 runs');
  check(
    'time: an average run, then model time per turn with subagents included, and the models\' average speed, and says how many calls were timed',
    by('time').value === '1m 18s' && by('time').sub === '2.0 s per turn, subagents included · 150 tok/s (average of 2 models)' && /225 of 250 calls/.test(by('time').title ?? '') && /not the length of one API call/.test(by('time').title ?? ''),
    JSON.stringify(by('time')),
  );
  check(
    "errors: the failed share of runs, with both counts, and, with another engine in the range, the retried share of Claude's calls, said so",
    by('errors').value === '8.0%' && /2 of 25 runs failed/.test(by('errors').sub) && /6 of Claude's 200 calls retried \(3\.0%\)/.test(by('errors').sub) && /out of Claude's calls/.test(by('errors').title ?? ''),
    JSON.stringify(by('errors')),
  );
  const claudeOnly = tiles(opus, [opus]);
  const ce = claudeOnly.find((x) => x.id === 'errors')!;
  check("with Claude alone, its calls are all the calls, and the tile does not say Claude's", /6 of 200 calls retried \(3\.0%\)/.test(ce.sub) && !/Claude/.test(ce.sub) && !/Claude's calls/.test(ce.title ?? ''), JSON.stringify(ce));
  check('one model: its own speed, with no "average"', claudeOnly.find((x) => x.id === 'time')!.sub === '2.0 s per turn, subagents included · 200 tok/s', claudeOnly.find((x) => x.id === 'time')!.sub);
  const copilotOnly = tiles(counts({ calls: 50, runs: 5 }), [gpt]).find((x) => x.id === 'errors')!;
  check('Copilot alone: the tile says only Claude reports retries, not "0 of 50 retried"', /only Claude reports them/.test(copilotOnly.sub) && !/of 50/.test(copilotOnly.sub), copilotOnly.sub);
  check('errors are bad news only when a run failed', by('errors').bad === true && tiles(counts({ runs: 4 }), []).find((x) => x.id === 'errors')!.bad === false);
  check('a stop of your own, a pause and a budget stop are not in the failed count: the tile says so', /stop, a pause and a budget stop/.test(by('errors').title ?? ''));
  check('cost is the dollars of the engines that report them', by('cost').value === '$14.50');
  const tokenOnly = tiles(counts({ inputTokens: 10, outputTokens: 5, calls: 1, runs: 1 }), [gpt]).find((x) => x.id === 'cost')!;
  check('with no engine reporting dollars, cost is a dash and says why', tokenOnly.value === '—' && /no engine here reports dollars/.test(tokenOnly.sub));
  const empty = tiles(counts(), []);
  check('an empty range reads as dashes and zeros, with no NaN anywhere', empty.every((x) => !/NaN|undefined|Infinity/.test(`${x.value}${x.sub}`)) && empty.find((x) => x.id === 'errors')!.sub === 'no runs', JSON.stringify(empty));
}

console.log('\n4 · the per-model and per-day rows');
{
  const m = (id: Parameters<typeof cell>[0], c: MetricsCounts) => cell(id, c);
  check('a model row: tokens, calls, time, speed, failures, retries, cost', m('in', opus) === '1.2M' && m('out', opus) === '80k' && m('cache', opus) === '900k' && m('calls', opus) === '200' && m('run', opus) === '1m 30s' && m('percall', opus) === '2.0 s' && m('tps', opus) === '200 tok/s' && m('errors', opus) === '10% · 2/20' && m('retries', opus) === '3.0% · 6/200' && m('cost', opus) === '$14.50', MODEL_COLUMNS.map((c) => `${c.id}=${m(c.id, opus)}`).join(' '));
  check('a Copilot row shows tokens and no dollars, and a dash for the cache and retries it never reports', m('cost', gpt) === '—' && m('cache', gpt) === '—' && modelCell('retries', gpt) === '—' && modelCell('retries', opus) === '3.0% · 6/200', MODEL_COLUMNS.map((c) => `${c.id}=${m(c.id, gpt)}`).join(' '));
  check('a row with no runs has a dash for errors, not 0%', m('errors', counts({ calls: 3 })) === '—');
  check('the columns have words on hover', [...MODEL_COLUMNS, ...DAY_COLUMNS].every((c) => c.label.length > 0 && c.title.length > 10));
  const perTurn = MODEL_COLUMNS.find((c) => c.id === 'percall')!;
  check('the time column is per turn, subagents included, and says it is not one API call', perTurn.label === 'Per turn' && /subagents included/.test(perTurn.title) && /not the length of one API call/.test(perTurn.title));
  check("the retried column is out of Claude's calls", /out of Claude's calls/.test(MODEL_COLUMNS.find((c) => c.id === 'retries')!.title));
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

console.log('\n5b · the cost-per-day chart (Amendment 170)');
{
  // Seven days, three of them with nothing in them, newest first as the daemon sends them.
  const week = resp({
    range: '7d',
    from: '2026-10-04',
    to: '2026-10-10',
    days: [
      day('2026-10-10', { runs: 2, costUsd: 1 }),
      day('2026-10-08', { runs: 4, costUsd: 4 }),
      day('2026-10-07', { runs: 1, costUsd: null }),
      day('2026-10-05', { runs: 3, costUsd: 2 }),
    ],
  });
  const bars = chartBars(week);
  check('7 days give 7 bars, the empty ones filled in from `from` to `to`, oldest first', bars.map((b) => b.day).join() === '2026-10-04,2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09,2026-10-10', bars.map((b) => b.day).join());
  check('bar heights scale to the highest day: $4 is full, $2 half, $1 a quarter, an empty day and a day with no dollars nothing', bars.map((b) => b.height).join() === '0,0.5,0,0,1,0,0.25', bars.map((b) => b.height).join());
  check('a day with no dollars ran; a day not in the list did not', bars[3]!.ran && bars[3]!.costUsd === null && !bars[2]!.ran && bars[1]!.ran);
  check('each bar says its day and its cost, or why it has none', barTitle(bars[4]!) === 'Thu 8 Oct: $4.00' && barTitle(bars[2]!) === 'Tue 6 Oct: nothing ran' && barTitle(bars[3]!) === 'Wed 7 Oct: no dollars reported', [barTitle(bars[4]!), barTitle(bars[2]!), barTitle(bars[3]!)].join(' | '));
  const words = chartSummary(bars);
  check('the text alternative gives the span, the total, the highest day and the days with no cost', words === 'Cost per day, Sun 4 Oct to Sat 10 Oct: $7.00 in all. The highest was Thu 8 Oct, $4.00. 4 days of 7 had no cost reported.', words);
  check("days step as the daemon's addDays does: across a month, a year and a clock change", addDays('2026-10-31', 1) === '2026-11-01' && addDays('2026-12-31', 1) === '2027-01-01' && addDays('2026-03-28', 2) === '2026-03-30' && addDays('2026-10-24', 2) === '2026-10-26' && addDays('2026-11-01', -1) === '2026-10-31');
  check('a single day gives no chart: today, or a range with one day in it, as the day table', chartBars(resp({ range: 'today', from: '2026-10-10', to: '2026-10-10', days: [day('2026-10-10', { runs: 1, costUsd: 3 })] })).length === 0 && chartBars({ ...week, days: [day('2026-10-08', { runs: 4, costUsd: 4 })] }).length === 0);
  check('no day reporting dollars gives no chart, not seven empty bars', chartBars({ ...week, days: week.days.map((d) => ({ ...d, costUsd: null })) }).length === 0);
  check('a bad span gives no chart, and never loops', chartBars({ ...week, from: 'nope' }).length === 0 && chartBars({ ...week, from: '2026-10-11' }).length === 0);
  const all = chartBars(resp({ days: [day('2026-10-10', { runs: 10, costUsd: 2 }), day('2026-10-09', { runs: 15, costUsd: 0.5 })] }));
  check('`all` runs from the first day recorded to today', all.map((b) => `${b.day}=${b.height}`).join() === '2026-10-08=0,2026-10-09=0.25,2026-10-10=1', JSON.stringify(all));

  const html = renderToStaticMarkup(createElement(CostChart, { resp: week }));
  const drawn = [...html.matchAll(/<rect class="mt-chart-bar"[^>]*height="([^"]*)"/g)].map((m) => Number(m[1]));
  check('rendered: 7 bars, and their heights are the shares of the 60-unit drawing', drawn.length === 7 && drawn.join() === '0,30,0,0,60,0,15', drawn.join());
  check('rendered: oldest on the left', [...html.matchAll(/<rect class="mt-chart-bar" x="([^"]*)"/g)].map((m) => Number(m[1])).every((x, i, all) => i === 0 || x > all[i - 1]!));
  check('rendered: an image labelled by its caption, which says the chart in words, and each day has a hover', /<svg[^>]*role="img"[^>]*aria-labelledby="mt-chart-caption"/.test(html) && html.includes(`<figcaption id="mt-chart-caption" class="mt-quiet">${words}</figcaption>`) && (html.match(/<title>/g) ?? []).length === 7 && html.includes('<title>Tue 6 Oct: nothing ran</title>'), html.slice(0, 300));
  check('rendered: the first and last day under the bars, and the highest cost above them', html.includes('<span>Sun 4 Oct</span><span>Sat 10 Oct</span>') && /mt-chart-top[^>]*>\$4\.00</.test(html));
  check('rendered: a single day draws nothing at all', renderToStaticMarkup(createElement(CostChart, { resp: resp({ range: 'today' }) })) === '');
  const chart = src('./chart.tsx');
  check('the chart sets no colour of its own: no hex, no rgb, no token, no fill or stroke but its classes', !/#[0-9a-fA-F]{3,8}\b/.test(chart) && !/rgba?\(/.test(chart) && !/var\(--/.test(chart) && !/\b(fill|stroke|style)=/.test(chart));
  const route = src('./route.tsx');
  const byDay = route.slice(route.indexOf('{days.length > 1 && ('));
  check('it is drawn inside the by-day section, above the day table, under the same rule', byDay.indexOf('<CostChart resp={resp} />') > 0 && byDay.indexOf('<CostChart resp={resp} />') < byDay.indexOf('<table className="mt-table mt-days">') && byDay.indexOf('aria-label="by day"') < byDay.indexOf('<CostChart'));
  const css = src('./metrics.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const chartCss = css.slice(css.indexOf('.mt-chart {'));
  check('in the stylesheet, its bars and line are currentColor and its colours are text inks', /\.mt-chart-bar \{\s*fill: currentColor;/.test(chartCss) && /\.mt-chart-base \{\s*stroke: currentColor;/.test(chartCss) && [...chartCss.matchAll(/(?:fill|stroke):\s*([^;]+);/g)].every((m) => ['currentColor', 'transparent'].includes(m[1]!.trim())) && [...chartCss.matchAll(/color:\s*var\((--[a-z0-9-]+)\)/g)].every((m) => ['--ink', '--ink2', '--ink3'].includes(m[1]!)));
}

console.log('\n5c · why time per turn runs high (Amendment 170)');
{
  check('the reason says the model time has the subagents\' time and the turns are the main agent\'s, so it runs high in parallel', /includes the subagents' time/.test(RUNS_HIGH) && /only the main agent's/.test(RUNS_HIGH) && /in parallel this figure runs high/.test(RUNS_HIGH));
  const time = tiles(total, [opus, gpt]).find((x) => x.id === 'time')!;
  check('the Time tile\'s hover says it', (time.title ?? '').includes(RUNS_HIGH), time.title);
  check('the Per turn column\'s hover says it', MODEL_COLUMNS.find((c) => c.id === 'percall')!.title.includes(RUNS_HIGH));
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

console.log('\n6b · one project, or all of them (Amendment 136)');
{
  const projects = [
    { id: 'prj_b', name: 'zeta' },
    { id: 'prj_a', name: 'alpha' },
  ];
  check('the picker is All projects, then each project by name', projectChoices(projects).map((p) => `${p.id ?? '-'}:${p.label}`).join() === `-:${ALL_PROJECTS},prj_a:alpha,prj_b:zeta` && ALL_PROJECTS === 'All projects');
  check('a remembered project that is still there is kept; one that is gone, or none, is all projects', asProject('prj_a', projects) === 'prj_a' && asProject('prj_gone', projects) === null && asProject(null, projects) === null && asProject('', projects) === null);
  check('the choice is a setting of its own', PROJECT_KEY === 'conductor.metricsProject' && (PROJECT_KEY as string) !== RANGE_KEY);
  const one = resp({ project: { id: 'prj_a', name: 'alpha' }, since: '2026-10-13', before: null });
  const note = projectNote(one);
  check('with a project, a short note says its counts start when this was added, and earlier runs are under All projects', note === 'Counts for alpha start on Tue 13 Oct, when per-project counting was added. Earlier runs are under All projects only.', note ?? 'null');
  check('with all projects there is no note', projectNote(resp()) === null);
  check('the explanations say a project\'s counts begin when they were added', HOW_COUNTED.some((l) => /per-project counting was added/.test(l)));
  const endpoints = src('./endpoints.ts');
  check('the request adds &projectId= only for a project', /projectId \? `&projectId=\$\{encodeURIComponent\(projectId\)\}` : ''/.test(endpoints));
  const daemon = src('../../../daemon/src/routes/metrics.ts');
  check("and the daemon's route answers 400 for a bad id and 404 for one that is not there", /code\(400\)[\s\S]*projectId/.test(daemon) && /code\(404\)/.test(daemon) && /getProject\(db, asked\)/.test(daemon));
}

console.log('\n7 · the screen is registered, reachable on 8, and in both themes');
{
  const route = src('./route.tsx');
  const def = route.slice(route.indexOf('export const screen'));
  check("it is a tab on 8, after Branches and before Settings", /id: 'metrics'/.test(def) && /hotkey: '8'/.test(def) && /order: 80/.test(def) && !/tab: false/.test(def), def);
  check('its range is remembered as a setting, not in the browser', route.includes('RANGE_KEY') && RANGE_KEY === 'conductor.metricsRange' && !/localStorage/.test(route));
  check('its project is a setting too, read through asProject, and the picker writes it', route.includes('PROJECT_KEY') && /asProject\(useSetting\(PROJECT_KEY\), projects\)/.test(route) && /writeSetting\(PROJECT_KEY, e\.target\.value \|\| null\)/.test(route) && /projectChoices\(projects\)/.test(route) && /aria-label="project"/.test(route));
  check('an answer for another project is never shown as this one', /\(resp\.project\?\.id \?\? null\) === projectId/.test(route) && /\[range, projectId\]/.test(route));
  check('the note shows above the tiles when a project is picked', /projectNote\(resp\)/.test(route));
  check('it draws the five tiles, a table of models, a table of days and the before section', /tiles\(resp\.total, resp\.models\)/.test(route) && /modelCell\(c\.id, m\)/.test(route) && /MODEL_COLUMNS/.test(route) && /DAY_COLUMNS/.test(route) && /resp\.before/.test(route) && /aria-label="by model"/.test(route));
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

// ── Amendment 182: each project's month beside today and total, with its monthly budget ──
{
  const projects = [
    { id: 'p2', name: 'Zeta', monthlyBudgetUsd: 50 },
    { id: 'p1', name: 'Alpha' },
    { id: 'p3', name: 'Mid', monthlyBudgetUsd: 10 },
  ];
  const spend = [
    { projectId: 'p1', today: 1.5, month: 12.25, total: 40, tokensToday: 0, tokensMonth: 0, tokensTotal: 0 },
    { projectId: 'p2', today: 2, month: 52, total: 90, tokensToday: 0, tokensMonth: 0, tokensTotal: 0 },
  ];
  const rows = projectSpendRows(projects, spend);
  check('By project: a row per project, by name', rows.map((r) => r.name).join() === 'Alpha,Mid,Zeta', rows.map((r) => r.name).join());
  const [alpha, mid, zeta] = rows;
  check('a row reads today, this month and total in dollars', alpha?.today === '$1.50' && alpha.month === '$12.25' && alpha.total === '$40.00', JSON.stringify(alpha));
  check('with no monthly budget the budget cell is a dash and nothing is over', alpha?.budget === '—' && alpha.over === false, JSON.stringify(alpha));
  check('a project at or over its monthly budget says so in words', zeta?.budget === '$50.00 · 104%, over' && zeta.over === true, JSON.stringify(zeta));
  check('a project with no spend yet reads $0.00 and 0% of its budget', mid?.today === '$0.00' && mid.month === '$0.00' && mid.budget === '$10.00 · 0%' && !mid.over, JSON.stringify(mid));
  check('the chosen project alone, when one is chosen', projectSpendRows(projects, spend, 'p2').map((r) => r.id).join() === 'p2');
  check('no rows until the daemon has sent spend', projectSpendRows(projects, null).length === 0);
  check('under a budget: its share, rounded down, and no "over"', monthlyBudgetCell(49.99, 50) === '$50.00 · 99%' && monthlyBudgetCell(50, 50) === '$50.00 · 100%, over', monthlyBudgetCell(49.99, 50));
  const old = projectSpendRows([{ id: 'p1', name: 'Alpha', monthlyBudgetUsd: 5 }], [{ projectId: 'p1', today: 1, total: 2, tokensToday: 0, tokensTotal: 0 }]);
  check("an older daemon's spend, with no month, reads a dash and just the budget, never over", old[0]?.month === '—' && old[0].budget === '$5.00' && !old[0].over, JSON.stringify(old[0]));
  check('the note says the table is not the range, and that a budget only warns', /not the range/.test(PROJECT_SPEND_NOTE) && /only warns/.test(PROJECT_SPEND_NOTE) && /from the 1st/.test(PROJECT_SPEND_NOTE));
  const route = src('./route.tsx');
  check('the screen draws the By project table from the store, for the chosen project', /projectSpendRows\(projects, useProjectSpend\(\), projectId\)/.test(route) && /<ProjectSpendTable rows=\{spendRows\} \/>/.test(route) && /<h2 className="mt-h">By project<\/h2>/.test(route));
  check('and over a budget is never a colour there: its cells carry no class', !/ProjectSpendTable[\s\S]*?className=\{[^}]*over/.test(route));
}

console.log(
  failures === 0
    ? "\nAmendment 122/136/165 web verify: PASS — a cost-per-day chart has a bar for every day of the range, scaled to the highest, in ink and in words, and none for a single day; time per turn says why it runs high; the retry rate is out of Claude's calls and says so when others ran; time is per turn, subagents included; speed is each model's own, averaged; the project picker is a setting, with a note on when its counts begin; each project's today, this month, monthly budget and total, over a budget in words (Amendment 182);" + ' every rate is two real counts divided or a dash; a token engine shows tokens and no dollars; the failed share leaves out your stop, a pause and a budget stop; time per turn and speed use only timed turns; the three ranges, the day table, the before-metrics line and its caveat read from a response alone; 8 is Metrics and nothing else; the status bar says 1–8; the stylesheet is tokens only, set for both themes.\n'
    : `\nAmendment 122/136/165 web verify: FAIL — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
