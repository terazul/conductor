/**
 * What an agent can be given to run on — GET /api/models.  TRACK A. (Amendment 40)
 *
 * Two lists, and neither is enough alone:
 *
 *   the model API's  `GET /v1/models` on ANTHROPIC_BASE_URL: what is served right now.
 *                    The only list that knows a model has been retired — the one that
 *                    would have said `claude-opus-5` was gone before an agent failed
 *                    on it. It knows nothing about Claude Code.
 *   Claude Code's    `Query.supportedModels()`: what your settings name, with a display
 *                    name and effort levels for each. It lists models the gateway does
 *                    not serve, because it only reports what the settings say.
 *
 * So the gateway decides what is offered and Claude Code decides what it is called. When
 * the gateway can't be asked, Claude Code's list is offered instead and says so.
 *
 * The credential is read to make the one call, from the environment and then from
 * Claude Code's settings file — where Claude Code itself reads it. It is never logged,
 * never stored, and never leaves this file.
 *
 * Asked lazily and cached: `supportedModels()` starts a Claude Code process, which takes
 * seconds. Routes that check a model use `known()`, which never asks — the picker that
 * offers the models has always asked first, so in practice it is warm.
 *
 * Every other provider lists its own models through its backend's `listModels()`, cached
 * the same ten minutes (Amendment 78, at the end of this file).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type ModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, ModelCatalog, ModelOption, ModelTier, ProviderModelList } from '@conductor/shared';
import { MODEL_NICKNAMES } from '@conductor/shared';
import type { BackendFactory } from './backend.js';

const TTL_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 20_000;
const TIERS: ModelTier[] = ['opus', 'sonnet', 'haiku'];
/** Claude Code rows that say what a choice is for rather than which model it is. */
const UNNAMED = ['default', 'best', 'opusplan'];

/** One model as the API lists it. */
export interface ServedModel {
  id: string;
  displayName?: string;
}

/**
 * The two askers, behind one indirection so session/verify.ts can answer for them.
 * Nothing else assigns these.
 */
export const modelSources: {
  gateway: () => Promise<{ host: string; models: ServedModel[] }>;
  claudeCode: () => Promise<ModelInfo[]>;
} = { gateway: askGateway, claudeCode: askClaudeCode };

// ─────────────────────────────────────────────────────────────────────────────
// Asking
// ─────────────────────────────────────────────────────────────────────────────

/** The model API and a way in, as Claude Code would find them. */
function endpoint(): { base: string; headers: Record<string, string> } {
  let env: Record<string, unknown> = {};
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { env?: unknown };
    if (settings.env && typeof settings.env === 'object') env = settings.env as Record<string, unknown>;
  } catch {
    // No settings file is an ordinary setup; the environment may still say.
  }
  const read = (k: string): string | undefined => {
    const v = process.env[k] ?? env[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };

  const base = (read('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const bearer = read('ANTHROPIC_AUTH_TOKEN');
  const key = read('ANTHROPIC_API_KEY');
  if (!bearer && !key) {
    throw new Error('no API credential Conductor can read — a Claude login is not one');
  }
  return {
    base,
    headers: {
      'anthropic-version': '2023-06-01',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { 'x-api-key': key! }),
    },
  };
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

async function askGateway(): Promise<{ host: string; models: ServedModel[] }> {
  const { base, headers } = endpoint();
  const host = hostOf(base);
  const models: ServedModel[] = [];
  let after: string | null = null;
  // Pages, in case a gateway serves more than one page's worth. Five is far past any seen.
  for (let page = 0; page < 5; page++) {
    const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    // The status only: a body can echo what was sent.
    if (!res.ok) throw new Error(`${host} answered ${res.status} to a request for its models`);
    const body = (await res.json()) as {
      data?: { id?: unknown; display_name?: unknown }[];
      has_more?: unknown;
      last_id?: unknown;
    };
    for (const m of body.data ?? []) {
      if (typeof m.id !== 'string' || !m.id) continue;
      models.push({
        id: m.id,
        ...(typeof m.display_name === 'string' && m.display_name !== m.id ? { displayName: m.display_name } : {}),
      });
    }
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  return { host, models };
}

/** A prompt that never sends: the query is opened only to be asked a question. */
async function* silence(): AsyncGenerator<SDKUserMessage> {
  await new Promise(() => {});
}

async function askClaudeCode(): Promise<ModelInfo[]> {
  const q = query({ prompt: silence(), options: { cwd: homedir() } });
  try {
    return await withTimeout(q.supportedModels(), 'Claude Code did not list its models');
  } finally {
    q.close();
  }
}

function withTimeout<T>(p: Promise<T>, why: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${why} within ${ASK_TIMEOUT_MS / 1000}s`)), ASK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(t));
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ─────────────────────────────────────────────────────────────────────────────
// Combining — pure, so verify.ts checks it without either source
// ─────────────────────────────────────────────────────────────────────────────

/** Claude Code's `[1m]` suffix asks for the 1M context window of the model before it. */
const baseId = (id: string): string => id.replace(/\[1m\]$/i, '');

export const isClaude = (id: string): boolean => /anthropic|claude/i.test(id);

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const efforts = (m: ModelInfo | undefined): EffortLevel[] | undefined => {
  const levels = m?.supportedEffortLevels?.filter((e): e is EffortLevel => EFFORTS.includes(e as EffortLevel));
  return levels && levels.length > 0 ? levels : undefined;
};

/** What Claude Code resolves a row to — an alias row names the id it stands for. */
const resolvedOf = (m: ModelInfo): string => m.resolvedModel ?? m.value;

export function combine(
  served: { host: string; models: ServedModel[] } | null,
  claudeCode: ModelInfo[] | null,
  notes: string[] = [],
  now = new Date(),
): ModelCatalog {
  const cc = claudeCode ?? [];
  const fetchedAt = now.toISOString();
  const note = notes.length ? notes.join(' · ') : undefined;

  /**
   * Claude Code's row for an exact id: the row named for it, else a tier row that resolves
   * to it. Never `default` or `best` — "Default (recommended)" is what a row is for, not
   * what the model is called.
   */
  const rowFor = (id: string): ModelInfo | undefined =>
    cc.find((m) => m.value === id) ??
    cc.find((m) => resolvedOf(m) === id && !UNNAMED.includes(m.value));
  const order = (id: string): number => {
    const i = cc.findIndex((m) => resolvedOf(m) === id || m.value === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sort = (xs: ModelOption[]): ModelOption[] =>
    xs.sort(
      (a, b) =>
        Number(b.claude) - Number(a.claude) || order(a.id) - order(b.id) || a.id.localeCompare(b.id),
    );

  if (served) {
    const ids = new Set(served.models.map((m) => m.id));
    const options: ModelOption[] = served.models.map((m) => {
      const r = rowFor(m.id);
      const levels = efforts(r);
      return {
        id: m.id,
        label: r?.displayName ?? m.displayName ?? m.id,
        claude: isClaude(m.id),
        ...(levels ? { effortLevels: levels } : {}),
      };
    });
    // Claude Code can ask for a served model's 1M context window; offer that as its own
    // choice, since it is billed and behaves differently.
    for (const m of cc) {
      const id = resolvedOf(m);
      if (id === baseId(id) || !ids.has(baseId(id)) || options.some((o) => o.id === id)) continue;
      const of = options.find((o) => o.id === baseId(id))!;
      const levels = efforts(m);
      options.push({ id, label: `${of.label} · 1M context`, claude: of.claude, ...(levels ? { effortLevels: levels } : {}) });
    }
    return {
      models: sort(options),
      tiers: tiersFrom(cc, (id) => ids.has(baseId(id))),
      source: 'gateway',
      host: served.host,
      ...(note ? { note } : {}),
      fetchedAt,
    };
  }

  if (cc.length > 0) {
    const options = new Map<string, ModelOption>();
    for (const m of cc) {
      const id = resolvedOf(m);
      if (options.has(id)) continue;
      const levels = efforts(m);
      options.set(id, { id, label: m.displayName, claude: isClaude(id), ...(levels ? { effortLevels: levels } : {}) });
    }
    return {
      models: sort([...options.values()]),
      tiers: tiersFrom(cc, () => true),
      source: 'claude-code',
      ...(note ? { note } : {}),
      fetchedAt,
    };
  }

  return { models: [], tiers: {}, source: 'none', ...(note ? { note } : {}), fetchedAt };
}

function tiersFrom(cc: ModelInfo[], served: (id: string) => boolean): ModelCatalog['tiers'] {
  const tiers: ModelCatalog['tiers'] = {};
  for (const t of TIERS) {
    const row = cc.find((m) => m.value === t);
    if (row && served(resolvedOf(row))) tiers[t] = resolvedOf(row);
  }
  return tiers;
}

// ─────────────────────────────────────────────────────────────────────────────
// The cache
// ─────────────────────────────────────────────────────────────────────────────

let last: ModelCatalog | null = null;
let lastAt = 0;
let asking: Promise<ModelCatalog> | null = null;

/** The catalog, asked for when it is older than ten minutes or `fresh` is set. */
export function catalog(fresh = false): Promise<ModelCatalog> {
  if (!fresh && last && Date.now() - lastAt < TTL_MS) return Promise.resolve(last);
  // One question at a time: two tabs opening Spawn start one Claude Code process, not two.
  asking ??= (async () => {
    const [g, c] = await Promise.allSettled([
      withTimeout(modelSources.gateway(), 'the model API did not list its models'),
      modelSources.claudeCode(),
    ]);
    const notes: string[] = [];
    if (g.status === 'rejected') notes.push(`${reason(g.reason)} — showing Claude Code's list, which is what your settings name rather than what is served`);
    if (c.status === 'rejected') notes.push(`Claude Code: ${reason(c.reason)} — names and effort levels are missing`);
    last = combine(g.status === 'fulfilled' ? g.value : null, c.status === 'fulfilled' ? c.value : null, notes);
    lastAt = Date.now();
    return last;
  })().finally(() => {
    asking = null;
  });
  return asking;
}

/** The last catalog, without asking. Null until something has asked. */
export function known(): ModelCatalog | null {
  return last;
}

/** Forget the cache — verify.ts, between its fakes. */
export function forgetCatalog(): void {
  last = null;
  lastAt = 0;
}

/**
 * Why `model` can't be given to an agent, or null when it can.
 *
 * Nicknames are refused outright: an agent keeps the exact id it runs on. An id is
 * refused for not being served only when the gateway itself said what it serves —
 * Claude Code's list is what the settings name, and nothing at all proves nothing.
 */
export function refusal(model: string): string | null {
  const cat = known();
  if ((MODEL_NICKNAMES as readonly string[]).includes(model)) {
    const means = TIERS.includes(model as ModelTier) ? cat?.tiers[model as ModelTier] : undefined;
    return `"${model}" is a nickname, and Conductor gives agents exact ids${means ? ` — it currently means ${means}` : ''}.`;
  }
  if (cat?.source === 'gateway' && !cat.models.some((m) => m.id === model)) {
    return `${cat.host ?? 'the model API'} does not serve "${model}" — pick one of ${cat.models.map((m) => m.id).join(', ')}.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Every other provider (Amendment 78)
// ─────────────────────────────────────────────────────────────────────────────

/** What this needs of a provider's factory. Passed in, so models.ts never imports the registry. */
type Lister = Pick<BackendFactory, 'listModels'>;

const lists = new Map<string, ProviderModelList>();
const listedAt = new Map<string, number>();
const listing = new Map<string, Promise<ProviderModelList>>();

/** Where a credential could be read from, so a failure's words can't carry one out. */
const SECRET_ENV = ['OPENROUTER_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * A failure in words fit for a note: its first line, cut short, with anything shaped like
 * a credential — or equal to one in the environment — taken out.
 */
function plain(err: unknown): string {
  let text = (reason(err).split('\n')[0] ?? '').trim();
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 8) text = text.split(v).join('[redacted]');
  }
  text = text
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || 'no reason given';
}

/**
 * What `provider` offers, from `factory.listModels()`. Never throws: a provider that isn't
 * registered, or whose listing fails or hangs, answers an empty list with a note saying
 * why. Only a list that came back is cached, so a failure is asked again next time.
 */
export function providerModels(provider: string, factory: Lister | undefined, fresh = false): Promise<ProviderModelList> {
  if (!factory) {
    return Promise.resolve({
      provider,
      models: [],
      note: `${provider} isn't available in this build yet, so it can't say what it offers`,
      fetchedAt: new Date().toISOString(),
    });
  }
  const cached = lists.get(provider);
  if (!fresh && cached && Date.now() - (listedAt.get(provider) ?? 0) < TTL_MS) return Promise.resolve(cached);
  const pending = listing.get(provider);
  if (pending) return pending;
  const asked = (async (): Promise<ProviderModelList> => {
    try {
      const raw = await withTimeout(Promise.resolve().then(() => factory.listModels()), `${provider} did not list its models`);
      const models: ProviderModelList['models'] = [];
      for (const m of Array.isArray(raw) ? raw : []) {
        const id = typeof m?.id === 'string' ? m.id.trim() : '';
        if (!id || models.some((x) => x.id === id)) continue;
        const name = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : id;
        const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string') : [];
        models.push({ id, displayName: name, ...(efforts.length > 0 ? { efforts } : {}) });
      }
      const list: ProviderModelList = {
        provider,
        models,
        ...(models.length === 0 ? { note: `${provider} listed no models` } : {}),
        fetchedAt: new Date().toISOString(),
      };
      lists.set(provider, list);
      listedAt.set(provider, Date.now());
      return list;
    } catch (err) {
      return { provider, models: [], note: `${provider} couldn't be asked for its models: ${plain(err)}`, fetchedAt: new Date().toISOString() };
    }
  })().finally(() => listing.delete(provider));
  listing.set(provider, asked);
  return asked;
}

/** Forget every provider's list — verify.ts, between its fakes. */
export function forgetProviderModels(): void {
  lists.clear();
  listedAt.clear();
}

/**
 * Why `model` can't be given to an agent on the provider `list` is from, or null when it
 * can. An empty list refuses nothing: the provider couldn't be asked, and nothing at all
 * proves nothing — the same rule as Claude's.
 */
export function providerModelRefusal(list: ProviderModelList, model: string): string | null {
  if (list.models.length === 0 || list.models.some((m) => m.id === model)) return null;
  const some = list.models.length <= 12
    ? `pick one of ${list.models.map((m) => m.id).join(', ')}`
    : `pick one of the ${list.models.length} it lists at GET /api/models?provider=${list.provider}`;
  return `${list.provider} does not offer "${model}" — ${some}.`;
}
