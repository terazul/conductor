/**
 * What the Metrics tab adds up.  TRACK A. (Amendment 122, migration 170)
 *
 * Recorded as results arrive, into `metrics_daily` (a row per local day, engine and model),
 * and never read back from the agent rows: removing a job or an agent deletes those rows
 * and `agents.model` is overwritten when the model is switched, so neither can say which
 * model did what. This table references nothing, so a removal leaves it alone.
 *
 * WHAT A CLAUDE RESULT CARRIES, AND WHAT IS TAKEN FROM IT (sdk.d.ts, SDKResultMessage):
 *  - `modelUsage` — tokens and dollars PER MODEL, cumulative for the session. A resumed
 *    session "continues from the totals its transcript saved, when it has them", so the
 *    first result of a resume already includes the earlier runs. What a result adds is the
 *    difference from the last one, kept per agent and model in `metrics_baseline`. Taking
 *    the figure as it stands would count every earlier run again on every resume, which is
 *    the trap `addCostToday` was already caught in (claude.ts).
 *  - `usage` — the MAIN LOOP only, and the latest turn's, not the session's. This is what
 *    `setAgentUsage` writes to the agent row, so a Claude agent's row holds its last run's
 *    tokens while its dollars are lifetime. The tab does not read them, except as the
 *    tokens of a result that has no `modelUsage` at all.
 *  - `num_turns` — model round-trips in this turn: the calls.
 *  - `duration_api_ms` — time in model calls. The engine keeps one running total for the
 *    session, like the dollars, so it is differenced the same way. (If a build reports it
 *    per turn instead, a smaller figure than the last is taken as fresh, and the running
 *    total follows.)
 *  - `duration_ms` — the turn's wall time. Not recorded here: the supervisor times every
 *    run itself, so both engines are measured the same way (`recordRunEnd`).
 *
 * "CONTINUED OR FRESH" is the test `lifetimeCost` already makes (budget.ts): a result whose
 * dollars are at least what the agent had spent continues its session's totals; a smaller
 * one started again from zero (the transcript saved none), so it is wholly new.
 *
 * Copilot and OpenRouter send one `assistant.usage` per call, with the model and, when the
 * runtime says, the call's duration: each is added as it arrives.
 *
 * The pure parts (`foldModelUsage`, `resultDelta`, `primaryModel`, `matchModel`) take and
 * return plain values, so session/verify.ts drives them without a database.
 */

import type { MetricsBefore, MetricsCounts, MetricsDay, MetricsModelRow, MetricsRange, MetricsResponse } from '@conductor/shared';
import { row, rows, tx, type Db } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { getAgent, getAgentProvider, localDay } from './store.js';

// ── pure ──────────────────────────────────────────────────────────────────────

/** One model's running figures. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, costUsd: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const sum = (t: Tokens): number => t.input + t.output;

/**
 * The result's `modelUsage`, keyed by the model's canonical name when the SDK gives one
 * (`claude-opus-4-7[1m]` and `claude-opus-4-7` are one model), else by the key it used.
 * Anything that is not an object with numbers in it is skipped: this reads a message from a
 * runtime newer than the types.
 */
export function foldModelUsage(raw: unknown): Map<string, Tokens> {
  const out = new Map<string, Tokens>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const u = value as Record<string, unknown>;
    const canonical = typeof u['canonicalModel'] === 'string' && u['canonicalModel'] ? u['canonicalModel'] : key;
    if (!canonical) continue;
    const t = out.get(canonical) ?? zero();
    t.input += num(u['inputTokens']);
    t.output += num(u['outputTokens']);
    t.cacheRead += num(u['cacheReadInputTokens']);
    t.costUsd += num(u['costUSD']);
    out.set(canonical, t);
  }
  return out;
}

export interface ResultFacts {
  /** The agent's lifetime dollars when the run began. */
  stored: number;
  /** The result's `total_cost_usd`, as it reported it. */
  reportedCost: number;
  /** The result's `modelUsage`, folded. Cumulative. */
  reported: Map<string, Tokens>;
  /** What the last result left, per model. */
  baseline: Map<string, Tokens>;
  /** False: the running totals include runs this table never saw, so this result only sets them. */
  baselined: boolean;
  /** The result's `duration_api_ms`, or null when it gave none. */
  reportedApiMs: number | null;
  /** The running API time the last result left. */
  storedApiMs: number;
}

export interface ResultDelta {
  /** What this result adds, per model. Empty when it only set the baseline. */
  perModel: Map<string, Tokens>;
  /** The baseline to keep for each model this result named. */
  nextBaseline: Map<string, Tokens>;
  /** Model-call time this result adds, or null when it adds none. */
  apiMs: number | null;
  nextApiMs: number;
  /** Whether the session carried on from earlier totals (as opposed to starting again from zero). */
  continued: boolean;
}

const copy = (m: Map<string, Tokens>): Map<string, Tokens> => new Map([...m].map(([k, v]) => [k, { ...v }]));
const minus = (r: Tokens, b: Tokens | undefined): Tokens => ({
  input: Math.max(0, r.input - (b?.input ?? 0)),
  output: Math.max(0, r.output - (b?.output ?? 0)),
  cacheRead: Math.max(0, r.cacheRead - (b?.cacheRead ?? 0)),
  costUsd: Math.max(0, r.costUsd - (b?.costUsd ?? 0)),
});
const plus = (a: Tokens, b: Tokens | undefined): Tokens => ({
  input: a.input + (b?.input ?? 0),
  output: a.output + (b?.output ?? 0),
  cacheRead: a.cacheRead + (b?.cacheRead ?? 0),
  costUsd: a.costUsd + (b?.costUsd ?? 0),
});

/**
 * What one result adds to the totals. See the header for why it is a difference and when
 * the whole figure is new instead.
 */
export function resultDelta(f: ResultFacts): ResultDelta {
  const continued = f.reportedCost >= f.stored;
  const perModel = new Map<string, Tokens>();
  const nextBaseline = new Map<string, Tokens>();
  const api = f.reportedApiMs;

  if (!f.baselined) {
    // Its first result since metrics began: the running figures include everything before.
    if (continued) {
      return { perModel, nextBaseline: copy(f.reported), apiMs: null, nextApiMs: api ?? f.storedApiMs, continued };
    }
    return { perModel: copy(f.reported), nextBaseline: copy(f.reported), apiMs: api, nextApiMs: api ?? f.storedApiMs, continued };
  }

  for (const [model, r] of f.reported) {
    const b = f.baseline.get(model);
    if (continued) {
      perModel.set(model, minus(r, b));
      nextBaseline.set(model, { ...r });
    } else {
      perModel.set(model, { ...r });
      nextBaseline.set(model, plus(r, b));
    }
  }
  if (api === null) return { perModel, nextBaseline, apiMs: null, nextApiMs: f.storedApiMs, continued };
  return continued
    ? { perModel, nextBaseline, apiMs: Math.max(0, api - f.storedApiMs), nextApiMs: api, continued }
    : { perModel, nextBaseline, apiMs: api, nextApiMs: f.storedApiMs + api, continued };
}

/** `opus` is not `claude-opus-4-7[1m]`, but names the same model. */
export function matchModel(name: string, known: readonly string[]): string {
  if (known.includes(name)) return name;
  const bare = name.replace(/\[.*\]$/, '').trim().toLowerCase();
  if (!bare || bare === 'default') return name;
  return known.find((k) => k.toLowerCase().includes(bare)) ?? name;
}

/**
 * The model a run's calls, time and outcome are credited to: the one that did the most in
 * it. `shown` is what a result names (what it added, or all it has when it added nothing);
 * `fallback` is the agent's own model, for a result that names none, and breaks a tie.
 */
export function primaryModel(shown: ReadonlyMap<string, Tokens>, fallback: string): string {
  let best: string | null = null;
  let most = -1;
  for (const [model, t] of shown) {
    const n = sum(t);
    if (n > most || (n === most && best !== null && matchModel(fallback, [model]) === model)) {
      best = model;
      most = n;
    }
  }
  return best ?? fallback;
}

// ── writing ───────────────────────────────────────────────────────────────────

/** The columns a row can grow by. */
type Bump = Partial<{
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  calls: number;
  retries: number;
  runs: number;
  failed_runs: number;
  run_ms: number;
  api_ms: number;
  timed_calls: number;
  timed_output_tokens: number;
}>;

const COLUMNS: ReadonlyArray<keyof Bump> = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cost_usd',
  'calls',
  'retries',
  'runs',
  'failed_runs',
  'run_ms',
  'api_ms',
  'timed_calls',
  'timed_output_tokens',
];

/** Add to today's row for this engine and model, making it when it is not there. */
function bump(db: Db, provider: string, model: string, by: Bump): void {
  const present = COLUMNS.filter((c) => (by[c] ?? 0) > 0);
  if (present.length === 0) return;
  const cols = present.join(', ');
  const marks = present.map(() => '?').join(', ');
  const grow = present.map((c) => `${c} = ${c} + excluded.${c}`).join(', ');
  const values = present.map((c) => (c === 'cost_usd' ? by[c]! : Math.round(by[c]!)));
  db.prepare(
    `INSERT INTO metrics_daily (day, provider, model, ${cols}) VALUES (?, ?, ?, ${marks})
     ON CONFLICT(day, provider, model) DO UPDATE SET ${grow}`,
  ).run(localDay(), provider, model, ...values);
}

interface AgentState {
  baselined: boolean;
  apiMs: number;
}

/**
 * The agent's bookkeeping, made the first time metrics sees it: what it had spent by then
 * (the "before metrics" line, from the agent row as it stands, so call this before the row
 * is updated), and whether the SDK's running totals include runs this table never saw.
 */
function stateOf(db: Db, agentId: string): AgentState | null {
  const agent = getAgent(db, agentId);
  if (!agent) return null;
  const have = row<{ baselined: number; api_ms: number }>(
    db.prepare('SELECT baselined, api_ms FROM metrics_agent WHERE agent_id = ?').get(agentId),
  );
  if (have) return { baselined: have.baselined === 1, apiMs: have.api_ms };
  const spent = agent.costUsd > 0 || agent.inputTokens > 0 || agent.outputTokens > 0;
  db.prepare(
    `INSERT INTO metrics_agent (agent_id, pre_cost_usd, pre_input_tokens, pre_output_tokens, baselined)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(agentId, agent.costUsd, agent.inputTokens, agent.outputTokens, spent ? 0 : 1);
  return { baselined: !spent, apiMs: 0 };
}

function baselineOf(db: Db, agentId: string): Map<string, Tokens> {
  const out = new Map<string, Tokens>();
  for (const r of rows<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number }>(
    db.prepare('SELECT * FROM metrics_baseline WHERE agent_id = ? ORDER BY rowid DESC').all(agentId),
  )) {
    out.set(r.model, { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, costUsd: r.cost_usd });
  }
  return out;
}

/** In memory, per agent: what the run now under way is credited to, and what it was retried through. */
const runModel = new Map<string, { provider: string; model: string }>();
const retried = new Map<string, number>();
/** A run that has ended and not yet been settled: a `failed` status right after it is its failure. */
const unsettled = new Map<string, { provider: string; model: string }>();

export interface ClaudeResult {
  agentId: string;
  /** The agent's lifetime dollars when the run began (`RunnerScope.spentUsd`). */
  stored: number;
  /** The result's `total_cost_usd` as reported. */
  reportedCost: number;
  /** What the run cost: its lifetime spend after, less before. Used only when `modelUsage` is empty. */
  costDelta: number;
  modelUsage: unknown;
  /** The result's own `usage`, the main loop's latest turn. Used only when `modelUsage` is empty. */
  usage: { input: number; output: number; cacheRead: number };
  numTurns: number;
  apiMs: number | null;
  /** The agent's own model name, for a result that names none. */
  model: string;
}

export interface Recorded {
  model: string;
  calls: number;
  apiMs: number | null;
}

/**
 * Add one Claude result. Call it BEFORE `setAgentUsage` overwrites the row, so a first
 * sighting of the agent reads what it had spent before this run. Returns what the `usage`
 * event should say; throws nothing the run needs to hear about.
 */
export function recordClaudeResult(db: Db, r: ClaudeResult): Recorded {
  const provider = getAgentProvider(db, r.agentId);
  return tx(db, () => {
    const state = stateOf(db, r.agentId);
    const reported = foldModelUsage(r.modelUsage);
    const delta = resultDelta({
      stored: r.stored,
      reportedCost: r.reportedCost,
      reported,
      baseline: state ? baselineOf(db, r.agentId) : new Map(),
      baselined: state?.baselined ?? true,
      reportedApiMs: r.apiMs,
      storedApiMs: state?.apiMs ?? 0,
    });

    let added = delta.perModel;
    if (reported.size === 0) {
      // Nothing per model (a crash or startup error, or a build that leaves it out): the
      // main loop's own figures, on the agent's model.
      const t: Tokens = { input: r.usage.input, output: r.usage.output, cacheRead: r.usage.cacheRead, costUsd: Math.max(0, r.costDelta) };
      added = sum(t) > 0 || t.costUsd > 0 ? new Map([[matchModel(r.model, [...baselineOf(db, r.agentId).keys()]), t]]) : new Map();
    }

    // What it added names the model; when it added nothing (it only set a baseline), all it has does.
    const shown = [...added.values()].some((t) => sum(t) > 0) ? added : reported;
    const model = primaryModel(shown, matchModel(r.model, [...reported.keys(), ...baselineOf(db, r.agentId).keys()]));
    const apiMs = delta.apiMs !== null && delta.apiMs > 0 ? delta.apiMs : null;
    let output = 0;
    for (const [m, t] of added) {
      output += t.output;
      bump(db, provider, m, { input_tokens: t.input, output_tokens: t.output, cache_read_tokens: t.cacheRead, cost_usd: t.costUsd });
    }
    bump(db, provider, model, {
      calls: r.numTurns,
      api_ms: apiMs ?? 0,
      timed_calls: apiMs !== null ? r.numTurns : 0,
      timed_output_tokens: apiMs !== null ? output : 0,
    });

    if (state) {
      const keep = db.prepare(
        `INSERT INTO metrics_baseline (agent_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, model) DO UPDATE SET input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cost_usd = excluded.cost_usd`,
      );
      for (const [m, t] of delta.nextBaseline) keep.run(r.agentId, m, Math.round(t.input), Math.round(t.output), Math.round(t.cacheRead), t.costUsd);
      db.prepare('UPDATE metrics_agent SET baselined = 1, api_ms = ? WHERE agent_id = ?').run(Math.round(delta.nextApiMs), r.agentId);
    }

    runModel.set(r.agentId, { provider, model });
    return { model, calls: r.numTurns, apiMs };
  });
}

export interface CallUsage {
  agentId: string;
  /** The model the call was made on, as the runtime names it; the agent's own when it names none. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** How long the call took, when the runtime says. */
  durationMs?: number;
}

/** Add one Copilot or OpenRouter call. Before `setAgentUsage`, as `recordClaudeResult`. */
export function recordCall(db: Db, c: CallUsage): Recorded {
  const provider = getAgentProvider(db, c.agentId);
  const timed = typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) && c.durationMs > 0;
  return tx(db, () => {
    stateOf(db, c.agentId);
    bump(db, provider, c.model, {
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cache_read_tokens: c.cacheReadTokens,
      calls: 1,
      api_ms: timed ? c.durationMs! : 0,
      timed_calls: timed ? 1 : 0,
      timed_output_tokens: timed ? c.outputTokens : 0,
    });
    // The run is credited to the first model it called, which is the agent's own: a
    // sub-agent's calls, on whatever model it chose, come after.
    if (!runModel.has(c.agentId)) runModel.set(c.agentId, { provider, model: c.model });
    return { model: c.model, calls: 1, apiMs: timed ? Math.round(c.durationMs!) : null };
  });
}

/**
 * A run ended, whichever way: counted with its wall time, and credited with the retries it
 * went through. Whether it failed is not known yet; `#settle` decides that, and says so with
 * a `failed` status, which `noteStatus` sees. Never throws: a count must not end a run.
 */
export function recordRunEnd(db: Db, agentId: string, ms: number): void {
  try {
    const agent = getAgent(db, agentId);
    const provider = getAgentProvider(db, agentId);
    const credited =
      runModel.get(agentId) ??
      { provider, model: matchModel(agent?.model ?? 'unknown', [...baselineOf(db, agentId).keys()]) };
    runModel.delete(agentId);
    const retries = retried.get(agentId) ?? 0;
    retried.delete(agentId);
    bump(db, credited.provider, credited.model, { runs: 1, run_ms: Math.max(0, ms), retries });
    unsettled.set(agentId, credited);
  } catch (err) {
    console.error('[metrics] could not count a run', err);
  }
}

/** A status event. A `failed` straight after a run's end is that run failing; anything else is not. */
function noteStatus(db: Db, agentId: string, status: string): void {
  const run = unsettled.get(agentId);
  unsettled.delete(agentId);
  if (status !== 'failed' || !run) return;
  try {
    bump(db, run.provider, run.model, { failed_runs: 1 });
  } catch (err) {
    console.error('[metrics] could not count a failed run', err);
  }
}

/**
 * Follow the event log for the two things the backends do not hand over: a retried model
 * call (`api_retry`, counted into the run that went through it) and a run's failure (the
 * `failed` status, written in one place only). Returns the unsubscribe.
 */
export function startMetrics(db: Db): () => void {
  return eventLog().subscribe((e) => {
    if (!e.agentId) return;
    const p = e.payload;
    if (p.kind === 'api_retry') retried.set(e.agentId, (retried.get(e.agentId) ?? 0) + 1);
    else if (p.kind === 'status') noteStatus(db, e.agentId, p.status);
  });
}

// ── reading ───────────────────────────────────────────────────────────────────

interface DailyRow {
  day: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  calls: number;
  retries: number;
  runs: number;
  failed_runs: number;
  run_ms: number;
  api_ms: number;
  timed_calls: number;
  timed_output_tokens: number;
}

const empty = (): MetricsCounts => ({
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
});

/** Fold one stored row in. Dollars only from an engine that reports them. */
function add(into: MetricsCounts, r: DailyRow, dollars: boolean): void {
  into.inputTokens += r.input_tokens;
  into.outputTokens += r.output_tokens;
  into.cacheReadTokens += r.cache_read_tokens;
  if (dollars) into.costUsd = (into.costUsd ?? 0) + r.cost_usd;
  into.calls += r.calls;
  into.retries += r.retries;
  into.runs += r.runs;
  into.failedRuns += r.failed_runs;
  into.runMs += r.run_ms;
  into.apiMs += r.api_ms;
  into.timedCalls += r.timed_calls;
  into.timedOutputTokens += r.timed_output_tokens;
}

/** `day` moved by `n` days, in the daemon's local time. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + n));
}

/** The day recording began, in the daemon's local time. */
export function sinceDay(db: Db): string {
  const r = row<{ v: string }>(db.prepare("SELECT v FROM metrics_meta WHERE k = 'since'").get());
  const at = r ? new Date(r.v) : null;
  return at && !Number.isNaN(at.getTime()) ? localDay(at) : localDay();
}

/** The first day a range covers. */
export function rangeStart(range: MetricsRange, today: string, since: string): string {
  if (range === 'today') return today;
  if (range === '7d') return addDays(today, -6);
  return since < today ? since : today;
}

/** Agents that spent before metrics saw them, from their rows. */
function beforeMetrics(db: Db, dollars: (provider: string) => boolean): MetricsBefore | null {
  const found = rows<{
    provider: string;
    model: string;
    seen: string | null;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    pre_cost_usd: number | null;
    pre_input_tokens: number | null;
    pre_output_tokens: number | null;
  }>(
    db
      .prepare(
        `SELECT a.provider, a.model, m.agent_id AS seen, a.cost_usd, a.input_tokens, a.output_tokens,
                m.pre_cost_usd, m.pre_input_tokens, m.pre_output_tokens
           FROM agents a LEFT JOIN metrics_agent m ON m.agent_id = a.id`,
      )
      .all(),
  );
  const byModel = new Map<string, MetricsBefore['models'][number]>();
  let agents = 0;
  let costUsd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const a of found) {
    const cost = a.seen ? (a.pre_cost_usd ?? 0) : a.cost_usd;
    const input = a.seen ? (a.pre_input_tokens ?? 0) : a.input_tokens;
    const output = a.seen ? (a.pre_output_tokens ?? 0) : a.output_tokens;
    if (cost <= 0 && input <= 0 && output <= 0) continue;
    const d = dollars(a.provider);
    agents += 1;
    inputTokens += input;
    outputTokens += output;
    if (d) costUsd = (costUsd ?? 0) + cost;
    const key = `${a.provider}\u0000${a.model}`;
    const m = byModel.get(key) ?? { provider: a.provider, model: a.model, agents: 0, costUsd: null, inputTokens: 0, outputTokens: 0 };
    m.agents += 1;
    m.inputTokens += input;
    m.outputTokens += output;
    if (d) m.costUsd = (m.costUsd ?? 0) + cost;
    byModel.set(key, m);
  }
  if (agents === 0) return null;
  return {
    agents,
    costUsd,
    inputTokens,
    outputTokens,
    models: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
  };
}

/**
 * The report for a range: totals, one row per engine and model, one row per day, and for
 * `all` the agents from before recording. `dollars` says which engines report them, so an
 * engine that does not shows tokens and no cost rather than $0.00.
 */
export function metricsReport(
  db: Db,
  range: MetricsRange,
  dollars: (provider: string) => boolean,
  today: string = localDay(),
): MetricsResponse {
  const since = sinceDay(db);
  // `all` has no lower bound of its own: it starts at the earliest day anything was recorded.
  const lower = range === 'all' ? '0000-00-00' : rangeStart(range, today, since);
  const found = rows<DailyRow>(
    db.prepare('SELECT * FROM metrics_daily WHERE day >= ? AND day <= ? ORDER BY day DESC').all(lower, today),
  );
  const from = range === 'all' ? [rangeStart('all', today, since), ...found.map((r) => r.day)].sort()[0]! : lower;
  const total = empty();
  const byModel = new Map<string, MetricsModelRow>();
  const byDay = new Map<string, MetricsDay>();
  for (const r of found) {
    const d = dollars(r.provider);
    add(total, r, d);
    const key = `${r.provider}\u0000${r.model}`;
    const m = byModel.get(key) ?? { ...empty(), provider: r.provider, model: r.model };
    add(m, r, d);
    byModel.set(key, m);
    const day = byDay.get(r.day) ?? { ...empty(), day: r.day };
    add(day, r, d);
    byDay.set(r.day, day);
  }
  const weight = (c: MetricsCounts): number => c.inputTokens + c.outputTokens;
  return {
    range,
    from,
    to: today,
    since,
    total,
    models: [...byModel.values()].sort((a, b) => weight(b) - weight(a) || b.calls - a.calls || a.model.localeCompare(b.model)),
    days: [...byDay.values()],
    before: range === 'all' ? beforeMetrics(db, dollars) : null,
  };
}
