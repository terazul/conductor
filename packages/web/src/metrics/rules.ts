/**
 * What the Metrics screen says, as pure functions (Amendment 122).
 *
 * The daemon sends sums. Every rate here is a division of two of them, made in one place so
 * the tiles, the tables and the tests agree, and so that a rate whose denominator is zero or
 * was never measured reads as a dash rather than as 0% or NaN. No React and no CSS, so
 * metrics/verify.ts checks them under Node.
 *
 * Three rules the numbers keep:
 *  - A rate is `part / whole` of two counts the engine really reported. Time per turn divides
 *    only the turns that were timed; tokens per second only the tokens of those turns. The
 *    retry rate's whole is Claude's calls, the only engine that reports a retry (Amendment 136).
 *  - An engine that reports no dollars has no cost, which is a dash and not $0.00.
 *  - Errors are failed runs. Your own stop, a pause and a budget stop are runs, not errors.
 *
 * WHAT "PER TURN" AND "SPEED" CAN HONESTLY SAY (Amendment 136). A Claude result gives
 * `num_turns` and `duration_api_ms` for the whole turn, and that time includes the turn's
 * subagents, whose calls can run side by side. So the figure is model time per turn,
 * subagents included, not the length of one API call, and it is labelled so. Speed is a
 * row's own (its timed output tokens over its model time); the total tile's speed is the
 * average of the models' own speeds, not every token over every engine's time added up,
 * which would mix a fast small model's seconds with a slow large one's. The rows are daily
 * sums, so there is no per-run figure to average; per model is the finest there is.
 */

import type {
  MetricsBefore,
  MetricsCounts,
  MetricsDay,
  MetricsModelRow,
  MetricsRange,
  MetricsResponse,
} from '@conductor/shared';
import { providerLabel, tokenWords } from '../lib/providers.js';

export const RANGES: ReadonlyArray<{ id: MetricsRange; label: string; title: string }> = [
  { id: 'today', label: 'Today', title: "Midnight to now, in the daemon's time zone" },
  { id: '7d', label: '7 days', title: 'Today and the six days before it' },
  { id: 'all', label: 'All', title: 'Everything since metrics began to be recorded' },
];

export const DEFAULT_RANGE: MetricsRange = 'today';

/** The setting that remembers the range across screens and tabs. */
export const RANGE_KEY = 'conductor.metricsRange';

export function asRange(v: string | null | undefined): MetricsRange {
  return RANGES.some((r) => r.id === v) ? (v as MetricsRange) : DEFAULT_RANGE;
}

/** The setting that remembers the project picked (Amendment 136); none is all projects. */
export const PROJECT_KEY = 'conductor.metricsProject';

/** The picker's first choice. */
export const ALL_PROJECTS = 'All projects';

/** The remembered project, if it is still one of `projects`; else null, all of them. */
export function asProject(v: string | null | undefined, projects: ReadonlyArray<{ id: string }>): string | null {
  return v && projects.some((p) => p.id === v) ? v : null;
}

/** The picker's choices: all projects, then each by name. */
export function projectChoices(projects: ReadonlyArray<{ id: string; name: string }>): Array<{ id: string | null; label: string }> {
  return [{ id: null, label: ALL_PROJECTS }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name }))];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** `part / whole`, or null when there is no whole to divide by. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 && Number.isFinite(part) ? part / whole : null;
}

/** `—`, `0%`, `<1%`, `3.4%`, `12%`: one decimal under 10%, none above, never `0%` for something that happened. */
export function percent(r: number | null): string {
  if (r === null) return '—';
  if (r <= 0) return '0%';
  const p = r * 100;
  if (p < 1) return '<1%';
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** `—`, `420 ms`, `4.2 s`, `3m 12s`, `1h 05m`. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Dollars, or a dash for an engine that reports none. */
export function dollars(usd: number | null): string {
  if (usd === null) return '—';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Tokens as people say them (rounded down, as the budget notes are), `—` when there are none to say. */
export function tokensText(n: number): string {
  return tokenWords(n);
}

export interface Derived {
  tokens: number;
  /** Failed runs over runs. */
  errorRate: number | null;
  /** Retried model calls over Claude's calls: only Claude reports a retry. */
  retryRate: number | null;
  /** Wall time of an average run. */
  avgRunMs: number | null;
  /** Model time per turn, subagents included, over the turns that were timed. */
  apiPerTurnMs: number | null;
  /** Output tokens per second of model time, this row's own. Only when both numbers exist. */
  tokensPerSec: number | null;
}

export function derive(c: MetricsCounts): Derived {
  return {
    tokens: c.inputTokens + c.outputTokens,
    errorRate: ratio(c.failedRuns, c.runs),
    retryRate: ratio(c.retries, c.claudeCalls),
    avgRunMs: c.runs > 0 && c.runMs > 0 ? c.runMs / c.runs : null,
    apiPerTurnMs: c.timedCalls > 0 && c.apiMs > 0 ? c.apiMs / c.timedCalls : null,
    tokensPerSec: c.apiMs > 0 && c.timedOutputTokens > 0 ? c.timedOutputTokens / (c.apiMs / 1000) : null,
  };
}

/**
 * The range's speed: each model's own, averaged. Null when no model has one. One model is
 * just its own speed; with several, the tile says it is their average.
 */
export function averageSpeed(models: ReadonlyArray<MetricsCounts>): { tps: number; of: number } | null {
  const speeds = models.map((m) => derive(m).tokensPerSec).filter((v): v is number => v !== null);
  if (speeds.length === 0) return null;
  return { tps: speeds.reduce((a, b) => a + b, 0) / speeds.length, of: speeds.length };
}

/** Whether an engine other than Claude ran in these rows: then "calls" and "Claude's calls" differ. */
export function otherEnginesRan(models: ReadonlyArray<Pick<MetricsModelRow, 'provider'>>): boolean {
  return models.some((m) => m.provider !== 'claude');
}

/** `42 tok/s`, `1.2k tok/s`, or a dash. */
export function rate(tps: number | null): string {
  if (tps === null) return '—';
  return `${tps < 100 ? tps.toFixed(1).replace(/\.0$/, '') : tokenWords(Math.round(tps))} tok/s`;
}

// ── the tiles ────────────────────────────────────────────────────────────────

export interface Tile {
  id: 'tokens' | 'calls' | 'time' | 'errors' | 'cost';
  label: string;
  value: string;
  sub: string;
  /** Set when the number is bad news. The only colour on the screen besides ink. */
  bad?: boolean;
  title?: string;
}

/**
 * Why time per turn runs high (Amendment 169, a known limit): the model time a Claude result
 * reports includes its subagents', but its turns are the main agent's alone.
 */
export const RUNS_HIGH =
  "The model time includes the subagents' time, but the turns counted are only the main agent's, so when subagents run in parallel this figure runs high.";

/** The Errors tile's retry half: Claude's calls are the whole, and it says so when others ran. */
function retryLine(total: MetricsCounts, others: boolean, retryRate: number | null): string {
  if (!others) return `${total.retries.toLocaleString('en')} of ${plural(total.calls, 'call')} retried (${percent(retryRate)})`;
  if (total.claudeCalls === 0) return 'retries: only Claude reports them, and it made no calls';
  return `${total.retries.toLocaleString('en')} of Claude's ${plural(total.claudeCalls, 'call')} retried (${percent(retryRate)})`;
}

/** The five figures at the top: the range's totals, and its models for what only they can say. */
export function tiles(total: MetricsCounts, models: ReadonlyArray<MetricsModelRow>): Tile[] {
  const d = derive(total);
  const others = otherEnginesRan(models);
  const speed = averageSpeed(models);
  const cached = total.cacheReadTokens > 0 ? ` · ${tokensText(total.cacheReadTokens)} cached` : '';
  const speedText = speed === null ? '' : ` · ${rate(speed.tps)}${speed.of > 1 ? ` (average of ${speed.of} models)` : ''}`;
  const timed = d.apiPerTurnMs === null ? 'model time not reported' : `${duration(d.apiPerTurnMs)} per turn, subagents included${speedText}`;
  const partly =
    total.timedCalls < total.calls
      ? `Model time is known for ${total.timedCalls.toLocaleString('en')} of ${total.calls.toLocaleString('en')} calls; per-turn figures use only those. `
      : '';
  return [
    {
      id: 'tokens',
      label: 'Tokens',
      value: tokensText(d.tokens),
      sub: `${tokensText(total.inputTokens)} in · ${tokensText(total.outputTokens)} out${cached}`,
      title: `${total.inputTokens.toLocaleString('en')} in, ${total.outputTokens.toLocaleString('en')} out, ${total.cacheReadTokens.toLocaleString('en')} read from cache`,
    },
    { id: 'calls', label: 'Calls to the model', value: total.calls.toLocaleString('en'), sub: plural(total.runs, 'run') },
    {
      id: 'time',
      label: 'Time per run',
      value: duration(d.avgRunMs),
      sub: timed,
      title: `${partly}A Claude turn's model time includes its subagents', which can run side by side, so this is not the length of one API call. ${RUNS_HIGH} Speed is each model's own output tokens per second of model time${speed !== null && speed.of > 1 ? ', averaged over the models' : ''}.`,
    },
    {
      id: 'errors',
      label: 'Errors',
      value: percent(d.errorRate),
      sub:
        total.runs === 0
          ? 'no runs'
          : `${total.failedRuns.toLocaleString('en')} of ${plural(total.runs, 'run')} failed · ${retryLine(total, others, d.retryRate)}`,
      bad: total.failedRuns > 0,
      title: `A failed run ended in failure. Your own stop, a pause and a budget stop aren't errors.${others ? " Only Claude reports a retried call, so the retry rate is out of Claude's calls, not every engine's." : ''}`,
    },
    {
      id: 'cost',
      label: 'Cost',
      value: dollars(total.costUsd),
      sub: total.costUsd === null ? 'no engine here reports dollars' : 'where the engine reports dollars',
      title: 'Copilot and OpenRouter report tokens, not dollars, so their cost is a dash and not $0.00.',
    },
  ];
}

// ── the tables ───────────────────────────────────────────────────────────────

export type ColumnId = 'in' | 'out' | 'cache' | 'calls' | 'runs' | 'run' | 'percall' | 'tps' | 'errors' | 'retries' | 'cost';

export interface Column {
  id: ColumnId;
  label: string;
  title: string;
}

const COLUMN: Record<ColumnId, Column> = {
  in: { id: 'in', label: 'In', title: 'Input tokens' },
  out: { id: 'out', label: 'Out', title: 'Output tokens' },
  cache: { id: 'cache', label: 'Cached', title: 'Input tokens read from the prompt cache, where the engine says' },
  calls: { id: 'calls', label: 'Calls', title: 'Calls to the model: a Claude run’s turns, or one per call for Copilot and OpenRouter' },
  runs: { id: 'runs', label: 'Runs', title: 'Runs that ended, however they ended' },
  run: { id: 'run', label: 'Per run', title: 'Time an average run took' },
  percall: {
    id: 'percall',
    label: 'Per turn',
    title: `Model time per turn, subagents included, over the turns that were timed. A Claude turn's subagents can run side by side, so this is not the length of one API call. ${RUNS_HIGH}`,
  },
  tps: { id: 'tps', label: 'Speed', title: "Output tokens per second of model time, this row's own, over the turns that were timed" },
  errors: { id: 'errors', label: 'Failed', title: 'Runs that failed, out of runs. A stop of yours, a pause and a budget stop are not failures' },
  retries: { id: 'retries', label: 'Retried', title: "Model calls the SDK had to retry, out of Claude's calls: only Claude reports them" },
  cost: { id: 'cost', label: 'Cost', title: 'Dollars, where the engine reports them' },
};

export const MODEL_COLUMNS: Column[] = (['in', 'out', 'cache', 'calls', 'run', 'percall', 'tps', 'errors', 'retries', 'cost'] as ColumnId[]).map((c) => COLUMN[c]);
export const DAY_COLUMNS: Column[] = (['runs', 'calls', 'in', 'out', 'run', 'errors', 'cost'] as ColumnId[]).map((c) => COLUMN[c]);

/** One cell, as text. */
export function cell(id: ColumnId, c: MetricsCounts): string {
  const d = derive(c);
  switch (id) {
    case 'in':
      return tokensText(c.inputTokens);
    case 'out':
      return tokensText(c.outputTokens);
    case 'cache':
      return c.cacheReadTokens > 0 ? tokensText(c.cacheReadTokens) : '—';
    case 'calls':
      return c.calls.toLocaleString('en');
    case 'runs':
      return c.runs.toLocaleString('en');
    case 'run':
      return duration(d.avgRunMs);
    case 'percall':
      return duration(d.apiPerTurnMs);
    case 'tps':
      return rate(d.tokensPerSec);
    case 'errors':
      return c.runs === 0 ? '—' : `${percent(d.errorRate)} · ${c.failedRuns}/${c.runs}`;
    case 'retries':
      if (c.claudeCalls === 0) return c.retries > 0 ? `${c.retries} retried` : '—';
      return `${percent(d.retryRate)} · ${c.retries}/${c.claudeCalls}`;
    case 'cost':
      return dollars(c.costUsd);
  }
}

/**
 * A cell of a model's row. Only Claude reports a retried model call, so another engine's
 * retries are a dash, not a 0% it never measured.
 */
export function modelCell(id: ColumnId, row: MetricsModelRow): string {
  return id === 'retries' && row.provider !== 'claude' && row.retries === 0 ? '—' : cell(id, row);
}

/** A model's name, and the engine when it is not Claude's. */
export function modelName(row: Pick<MetricsModelRow, 'provider' | 'model'>): { name: string; engine: string | null } {
  return { name: row.model, engine: row.provider === 'claude' ? null : providerLabel(row.provider) };
}

/** A row's share of the range's tokens, 0 to 1, for the bar under its name. */
export function share(row: MetricsCounts, total: MetricsCounts): number {
  const all = total.inputTokens + total.outputTokens;
  return all > 0 ? Math.min(1, (row.inputTokens + row.outputTokens) / all) : 0;
}

// ── days and words ───────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-10` → `Sat 10 Oct`, read as the daemon's local day (no time zone shift). */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The span the range covers, in a few words. */
export function rangeLine(r: Pick<MetricsResponse, 'range' | 'from' | 'to' | 'since'>): string {
  if (r.range === 'today') return `today, ${dayLabel(r.to)}`;
  if (r.range === '7d') return `${dayLabel(r.from)} to ${dayLabel(r.to)}`;
  return `since ${dayLabel(r.from)}`;
}

/** Nothing in the range: why that is not a failure. */
export function emptyLine(range: MetricsRange): string {
  if (range === 'today') return 'Nothing recorded today yet. A run shows up here when it ends.';
  if (range === '7d') return 'Nothing recorded in the last 7 days.';
  return 'Nothing recorded yet. Runs show up here as they end, and are kept after their agent or job is removed.';
}

export function isEmpty(r: Pick<MetricsResponse, 'models' | 'total'>): boolean {
  return r.models.length === 0 && r.total.runs === 0 && r.total.calls === 0;
}

/**
 * With a project picked: its counts begin when per-project counting was added, so an
 * earlier run is in All projects only. Null for all projects.
 */
export function projectNote(r: Pick<MetricsResponse, 'project' | 'since'>): string | null {
  if (!r.project) return null;
  return `Counts for ${r.project.name} start on ${dayLabel(r.since)}, when per-project counting was added. Earlier runs are under ${ALL_PROJECTS} only.`;
}

/** The days to show: only when the range has more than one. */
export function showDays(r: Pick<MetricsResponse, 'range' | 'days'>): MetricsDay[] {
  return r.range === 'today' ? [] : r.days;
}

// ── the cost-per-day chart (Amendment 169) ──────────────────────────────────

/** One bar: a day of the range, its dollars, and its height as a share of the highest day's. */
export interface ChartBar {
  day: string;
  /** Null when nothing that ran that day reports dollars, or nothing ran. */
  costUsd: number | null;
  /** Whether anything was recorded that day: `days` lists only those. */
  ran: boolean;
  /** 0 to 1: this day's cost over the highest day's. */
  height: number;
}

/** `day` moved by `n` days, as the daemon steps them (`addDays`, session/metrics.ts): local calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d + n);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One bar per day from `from` to `to`, oldest on the left, the days nothing ran included at
 * no height. Shown under the same rule as the day table (`showDays`, more than one day with
 * something in it), and only when some day reports dollars: a chart of dashes says nothing.
 */
export function chartBars(r: Pick<MetricsResponse, 'range' | 'from' | 'to' | 'days'>): ChartBar[] {
  const days = showDays(r);
  if (days.length <= 1 || !days.some((d) => d.costUsd !== null)) return [];
  if (!DAY.test(r.from) || !DAY.test(r.to) || r.from > r.to) return [];
  const byDay = new Map(days.map((d) => [d.day, d]));
  const bars: ChartBar[] = [];
  // Ten years of days is far past any range; the cap only keeps a bad `from` from looping.
  for (let day = r.from; day <= r.to && bars.length < 3660; day = addDays(day, 1)) {
    const d = byDay.get(day);
    bars.push({ day, costUsd: d?.costUsd ?? null, ran: d !== undefined, height: 0 });
  }
  const max = Math.max(0, ...bars.map((b) => b.costUsd ?? 0));
  for (const b of bars) b.height = max > 0 ? (b.costUsd ?? 0) / max : 0;
  return bars;
}

/** A bar's hover: the day and what it cost, or why it has no height. */
export function barTitle(b: ChartBar): string {
  if (!b.ran) return `${dayLabel(b.day)}: nothing ran`;
  return `${dayLabel(b.day)}: ${b.costUsd === null ? 'no dollars reported' : dollars(b.costUsd)}`;
}

/** The chart in words, for a screen reader and under the bars: the span, the total, the highest day. */
export function chartSummary(bars: ReadonlyArray<ChartBar>): string {
  if (bars.length === 0) return '';
  const total = bars.reduce((a, b) => a + (b.costUsd ?? 0), 0);
  const top = bars.reduce((a, b) => ((b.costUsd ?? 0) > (a.costUsd ?? 0) ? b : a));
  const none = bars.filter((b) => !b.costUsd).length;
  const span = `${dayLabel(bars[0]!.day)} to ${dayLabel(bars[bars.length - 1]!.day)}`;
  const highest = (top.costUsd ?? 0) > 0 ? ` The highest was ${dayLabel(top.day)}, ${dollars(top.costUsd)}.` : '';
  const quiet = none > 0 ? ` ${plural(none, 'day')} of ${bars.length} had no cost reported.` : '';
  return `Cost per day, ${span}: ${dollars(total)} in all.${highest}${quiet}`;
}

// ── before metrics were recorded ─────────────────────────────────────────────

/** The labelled line for agents that spent before recording began. */
export function beforeLine(b: MetricsBefore): string {
  const cost = b.costUsd === null ? '' : ` · ${dollars(b.costUsd)}`;
  return `Before metrics were recorded (no per-call data): ${plural(b.agents, 'agent')}${cost} · ${tokensText(b.inputTokens)} in · ${tokensText(b.outputTokens)} out`;
}

/** What the line is made of, and what it cannot say. */
export const BEFORE_NOTE =
  "These are the totals on the agents' own rows, for agents that are still here. A Claude agent's row holds the tokens of its last run only, and each agent is credited to the model it has now, not to the ones it used.";

/** One model's share of that line. */
export function beforeModelLine(m: MetricsBefore['models'][number]): string {
  const { name, engine } = modelName(m);
  const cost = m.costUsd === null ? '' : ` · ${dollars(m.costUsd)}`;
  return `${name}${engine ? ` (${engine})` : ''} — ${plural(m.agents, 'agent')}${cost} · ${tokensText(m.inputTokens)} in · ${tokensText(m.outputTokens)} out`;
}

/** The definitions under the tables. */
export const HOW_COUNTED: ReadonlyArray<string> = [
  'Calls are the model’s round-trips: a Claude run’s turns, or each reply a Copilot or OpenRouter agent asked for.',
  'Time per run is how long a run took from start to end, waiting for you included. Time per turn and speed use only the model time an engine reports, over the turns it timed, so they are a dash where none was.',
  'A Claude turn’s model time includes its subagents’, which can run side by side, so time per turn is not the length of one API call. Speed is each model’s own output tokens per second of that time; the total is the average of the models’ speeds.',
  'Failed counts runs that ended failed. A stop of your own, a pause and a budget stop are runs but not failures. Retried counts the model calls the SDK had to try again; only Claude reports them, so the rate is out of Claude’s calls.',
  'A run is credited to the model that did most in it. Tokens and dollars are exact per model.',
  'Copilot and OpenRouter report tokens, not dollars, so their cost is a dash. Days are the daemon’s own, midnight to midnight.',
  'What is shown is kept after a job or agent is removed. Runs from before recording began are not in the tables, only in the line under them.',
  'A project’s counts begin when per-project counting was added; runs before that are under All projects only.',
];
