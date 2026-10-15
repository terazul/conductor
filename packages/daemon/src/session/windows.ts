/**
 * The context windows the engines have reported.  TRACK A.  (Amendments 120, 163)
 *
 * `handoffCap` (handoff.ts) is a quarter of the next model's window. It used to know only a
 * small table of floors, because nothing read a window from anywhere. The model lists do
 * carry one, and so does each Claude result, and this is where it is kept:
 *
 *   OpenRouter   `context_length` on each model of its public list
 *   Copilot      `capabilities.limits.max_context_window_tokens` on each model of its list
 *   Claude       `max_input_tokens` on each model of the gateway's `GET /v1/models`, when the
 *                gateway says (Claude Code's own list has no window); and
 *                `modelUsage[model].contextWindow` on every `result` (Amendment 163), which is
 *                the window that run had
 *
 * It is written by whoever lists the models (`copilotModels`, `openRouterModels`, `catalog`)
 * and by the Claude backend when a result arrives (`recordRunWindows`), by provider and
 * exact id, and read by the supervisor when it builds a prompt.
 *
 * A RUN'S WINDOW BEATS A LIST'S. A list says what a model can take; a result says what the run
 * was given, which for Claude can be less (the gateway lists the largest window, Claude Code
 * runs the base one unless asked for `[1m]`). So a list never overwrites a window a run
 * reported, and a run always overwrites a list's.
 *
 * KEPT ACROSS A RESTART (Amendment 163, migration 270). `initWindows(db)` at startup loads
 * `model_windows` and keeps the handle; from then on each window that changes is written there
 * too, and one that is the same as before is not written again. Without it (a test that never
 * calls it) the windows are kept in memory only, as before. A write that fails is logged and
 * the window is still kept in memory: a window is never worth failing a run or a model list.
 *
 * A Claude Code `[1m]` model is not looked up: the list gives the base model's window, and
 * `[1m]` is the 1,000,000 one, which the floors already say. For the same reason a result's
 * window is not recorded for a `[1m]` model, under its own name or the base id.
 */

import { rows, type Db } from '../db/index.js';
import { matchModel } from './metrics.js';

type Source = 'list' | 'run';
interface Kept {
  tokens: number;
  source: Source;
}

const reported = new Map<string, Kept>();
let store: Db | null = null;

const keyOf = (provider: string, id: string): string => `${provider}\u0000${id}`;

/** A window is a whole number of tokens above zero. Anything else a list says is ignored. */
export function validWindow(tokens: unknown): tokens is number {
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 1;
}

const ONE_M = /\[1m\]$/i;

/** Keep one window, in memory and, when a database is attached and it changed, in `model_windows`. */
function keep(provider: string, id: string, tokens: number, source: Source): void {
  const key = keyOf(provider, id);
  const was = reported.get(key);
  if (was?.source === 'run' && source === 'list') return;
  if (was?.tokens === tokens && was.source === source) return;
  reported.set(key, { tokens, source });
  if (!store) return;
  try {
    store
      .prepare(
        `INSERT INTO model_windows (provider, model, tokens, source, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET tokens = excluded.tokens, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(provider, id, tokens, source, new Date().toISOString());
  } catch (err) {
    console.error(`[windows] could not save ${provider} ${id}`, err);
  }
}

/**
 * Keep what `provider`'s list said. Models with no usable window are skipped, and a window a run
 * reported stands (see the header). Returns how many had a usable window.
 */
export function recordWindows(provider: string, models: Iterable<{ id: string; tokens?: unknown }>): number {
  let kept = 0;
  for (const m of models) {
    if (typeof m.id !== 'string' || !m.id || !validWindow(m.tokens)) continue;
    keep(provider, m.id, Math.floor(m.tokens), 'list');
    kept += 1;
  }
  return kept;
}

/**
 * The windows one Claude result reports, as `{ id, tokens }` (Amendment 163). Pure.
 *
 *  - Each `modelUsage` entry's `contextWindow`, under its canonical id (`canonicalModel`, else its
 *    key) and under the key when that differs.
 *  - Under `agentModel` too, when it is an alias (`opus`) that names one of them as `matchModel`
 *    does, so the supervisor's lookup by the agent's own model finds it.
 *  - Nothing for a `[1m]` key, nor for the entry a `[1m]` agent model names: that window is the
 *    1,000,000 one, and the base id would be given it.
 * Anything that is not an object with a usable window in it is skipped.
 */
export function windowsFromResult(modelUsage: unknown, agentModel: string): { id: string; tokens: number }[] {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return [];
  const entries: { key: string; canonical: string; tokens: number }[] = [];
  for (const [key, value] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const u = value as Record<string, unknown>;
    if (!validWindow(u['contextWindow'])) continue;
    const canonical = typeof u['canonicalModel'] === 'string' && u['canonicalModel'] ? u['canonicalModel'] : key;
    entries.push({ key, canonical, tokens: Math.floor(u['contextWindow']) });
  }
  const model = agentModel.trim();
  const oneM = ONE_M.test(model);
  const named = model ? matchModel(model, [...entries.map((e) => e.key), ...entries.map((e) => e.canonical)]) : '';
  const out = new Map<string, number>();
  for (const e of entries) {
    if (ONE_M.test(e.key) || ONE_M.test(e.canonical)) continue;
    const isAgents = named === e.key || named === e.canonical;
    if (isAgents && oneM) continue;
    out.set(e.canonical, e.tokens);
    out.set(e.key, e.tokens);
    if (isAgents && model !== named) out.set(model, e.tokens);
  }
  return [...out].map(([id, tokens]) => ({ id, tokens }));
}

/** Keep what a Claude result said (`windowsFromResult`). Returns how many ids were kept. */
export function recordRunWindows(provider: string, modelUsage: unknown, agentModel: string): number {
  const found = windowsFromResult(modelUsage, agentModel);
  for (const w of found) keep(provider, w.id, w.tokens, 'run');
  return found.length;
}

/**
 * At startup: what was kept before the restart, from `model_windows`, and the handle to keep
 * what comes next in. Replaces whatever is in memory.
 */
export function initWindows(db: Db): number {
  store = db;
  reported.clear();
  for (const r of rows<{ provider: string; model: string; tokens: number; source: string }>(
    db.prepare('SELECT provider, model, tokens, source FROM model_windows').all(),
  )) {
    if (!validWindow(r.tokens)) continue;
    reported.set(keyOf(r.provider, r.model), { tokens: Math.floor(r.tokens), source: r.source === 'run' ? 'run' : 'list' });
  }
  return reported.size;
}

/** The window `provider` reported for exactly `model`, in tokens, or undefined when it has not said. */
export function reportedWindow(provider: string, model: string): number | undefined {
  if (ONE_M.test(model.trim())) return undefined;
  return reported.get(keyOf(provider, model.trim()))?.tokens;
}

/** Forget what was reported, kept ones too — verify.ts, between its fakes. */
export function forgetWindows(): void {
  reported.clear();
  try {
    store?.exec('DELETE FROM model_windows');
  } catch (err) {
    console.error('[windows] could not forget the kept windows', err);
  }
}
