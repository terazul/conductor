/**
 * What the Metrics screen says, as pure functions (Amendment 122).
 *
 * The daemon sends sums. Every rate here is a division of two of them, made in one place so
 * the tiles, the tables and the tests agree, and so that a rate whose denominator is zero or
 * was never measured reads as a dash rather than as 0% or NaN. No React and no CSS, so
 * metrics/verify.ts checks them under Node.
 *
 * Three rules the numbers keep:
 *  - A rate is `part / whole` of two counts the engine really reported. Time per call divides
 *    only the calls that were timed; tokens per second only the tokens of those calls.
 *  - An engine that reports no dollars has no cost, which is a dash and not $0.00.
 *  - Errors are failed runs. Your own stop, a pause and a budget stop are runs, not errors.
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
  /** Retried model calls over calls. */
  retryRate: number | null;
  /** Wall time of an average run. */
  avgRunMs: number | null;
  /** Model-call time per call, over the calls that were timed. */
  apiPerCallMs: number | null;
  /** Output tokens per second of model-call time. Only when both numbers exist. */
  tokensPerSec: number | null;
}

export function derive(c: MetricsCounts): Derived {
  return {
    tokens: c.inputTokens + c.outputTokens,
    errorRate: ratio(c.failedRuns, c.runs),
    retryRate: ratio(c.retries, c.calls),
    avgRunMs: c.runs > 0 && c.runMs > 0 ? c.runMs / c.runs : null,
    apiPerCallMs: c.timedCalls > 0 && c.apiMs > 0 ? c.apiMs / c.timedCalls : null,
    tokensPerSec: c.apiMs > 0 && c.timedOutputTokens > 0 ? c.timedOutputTokens / (c.apiMs / 1000) : null,
  };
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

/** The five figures at the top: the range's totals. */
export function tiles(total: MetricsCounts): Tile[] {
  const d = derive(total);
  const cached = total.cacheReadTokens > 0 ? ` · ${tokensText(total.cacheReadTokens)} cached` : '';
  const timed =
    d.apiPerCallMs === null
      ? 'model-call time not reported'
      : `${duration(d.apiPerCallMs)} per call${d.tokensPerSec === null ? '' : ` · ${rate(d.tokensPerSec)}`}`;
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
      title:
        total.timedCalls < total.calls
          ? `Model-call time is known for ${total.timedCalls.toLocaleString('en')} of ${total.calls.toLocaleString('en')} calls; per-call figures use only those.`
          : undefined,
    },
    {
      id: 'errors',
      label: 'Errors',
      value: percent(d.errorRate),
      sub:
        total.runs === 0
          ? 'no runs'
          : `${total.failedRuns.toLocaleString('en')} of ${plural(total.runs, 'run')} failed · ${total.retries.toLocaleString('en')} of ${plural(total.calls, 'call')} retried (${percent(d.retryRate)})`,
      bad: total.failedRuns > 0,
      title: "A failed run ended in failure. Your own stop, a pause and a budget stop aren't errors.",
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
  percall: { id: 'percall', label: 'Per call', title: 'Time the engine spent in a model call, over the calls it timed' },
  tps: { id: 'tps', label: 'Speed', title: 'Output tokens per second of model-call time, over the calls that were timed' },
  errors: { id: 'errors', label: 'Failed', title: 'Runs that failed, out of runs. A stop of yours, a pause and a budget stop are not failures' },
  retries: { id: 'retries', label: 'Retried', title: 'Model calls the SDK had to retry, out of calls (Claude only)' },
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
      return duration(d.apiPerCallMs);
    case 'tps':
      return rate(d.tokensPerSec);
    case 'errors':
      return c.runs === 0 ? '—' : `${percent(d.errorRate)} · ${c.failedRuns}/${c.runs}`;
    case 'retries':
      if (c.calls === 0) return c.retries > 0 ? `${c.retries} retried` : '—';
      return `${percent(d.retryRate)} · ${c.retries}/${c.calls}`;
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

/** The days to show: only when the range has more than one. */
export function showDays(r: Pick<MetricsResponse, 'range' | 'days'>): MetricsDay[] {
  return r.range === 'today' ? [] : r.days;
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
  'Time per run is how long a run took from start to end, waiting for you included. Time per call and speed use only the model-call time an engine reports, over the calls it timed, so they are a dash where none was.',
  'Failed counts runs that ended failed. A stop of your own, a pause and a budget stop are runs but not failures. Retried counts the model calls the SDK had to try again; only Claude reports them.',
  'A run is credited to the model that did most in it. Tokens and dollars are exact per model.',
  'Copilot and OpenRouter report tokens, not dollars, so their cost is a dash. Days are the daemon’s own, midnight to midnight.',
  'What is shown is kept after a job or agent is removed. Runs from before recording began are not in the tables, only in the line under them.',
];
