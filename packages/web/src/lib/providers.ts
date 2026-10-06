/**
 * The engines an agent can run on — GET /api/providers, and the words for them.
 * (Amendment 80)
 *
 * Claude is the default and can do everything it always could. Copilot and OpenRouter
 * can't do all of it (docs/plans/multi-provider-findings.md): no dollar cost, so their
 * budget is in tokens, and no plan mode yet. A screen asks `capabilitiesOf` before it
 * shows a control, so nothing is offered that would do nothing.
 *
 * The OpenRouter key is never held here. The daemon says whether one is set and where
 * from; what is typed to set it goes straight to the daemon and is forgotten.
 *
 * The words are pure and import no CSS, so lib/verify.ts checks them under Node.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Agent, ProviderInfo, ProviderModelList } from '@conductor/shared';
import { api } from './feed.js';
import { ApiError } from './errors.js';

export type Capabilities = ProviderInfo['capabilities'];

export const CLAUDE = 'claude';

/** Everything Claude has always done. */
export const ALL_ON: Capabilities = { defer: true, resume: true, costUsd: true, effort: true, planMode: true, helperTools: true };

/** What an engine the daemon hasn't described is trusted with: nothing. */
export const NONE: Capabilities = { defer: false, resume: false, costUsd: false, effort: false, planMode: false, helperTools: false };

const LABELS: Record<string, string> = { claude: 'Claude', copilot: 'Copilot', openrouter: 'OpenRouter' };

/** `openrouter` → `OpenRouter`. One the UI doesn't know keeps its id. */
export function providerLabel(id: string | undefined): string {
  const p = id ?? CLAUDE;
  return LABELS[p] ?? p;
}

/** An agent's engine. Absent is Claude: every agent from before Amendment 74. */
export const providerOf = (a: Pick<Agent, 'provider'>): string => a.provider ?? CLAUDE;

/**
 * What an agent's engine — or the engine named — can do. Claude can do everything. Any
 * other engine gets what the daemon says, and nothing when the daemon hasn't said: a
 * control hidden that would have worked is a nuisance, one shown that does nothing is
 * a lie.
 */
export function capabilitiesOf(
  of: Pick<Agent, 'provider'> | string,
  providers: readonly ProviderInfo[] | null,
): Capabilities {
  const id = typeof of === 'string' ? of : providerOf(of);
  if (id === CLAUDE) return ALL_ON;
  return providers?.find((p) => p.id === id)?.capabilities ?? NONE;
}

/** The unit a budget is kept in: dollars where the engine reports them, else tokens (Amendment 77). */
export const budgetUnit = (caps: Capabilities): 'usd' | 'tokens' => (caps.costUsd ? 'usd' : 'tokens');

/**
 * Whether a permission mode is offered. Plan mode only where the engine has it; the
 * mode an agent is already in is always shown, so its state is never hidden.
 */
export const offersMode = (mode: string, caps: Capabilities, current?: string): boolean =>
  mode !== 'plan' || caps.planMode || mode === current;

/** The controls that do something on this engine — Spawn's and the composer's. */
export function controlsFor(caps: Capabilities): { effort: boolean; helpers: boolean; budget: 'usd' | 'tokens' } {
  return { effort: caps.effort, helpers: caps.helperTools, budget: budgetUnit(caps) };
}

/**
 * `950`, `12.5k`, `500k`, `1.2M` — the daemon's `tokens()`, so the screen and its
 * budget note say the same figure. Rounded down: a figure never reads as more than was spent.
 */
export function tokenWords(n: number): string {
  const short = (unit: number, suffix: string): string =>
    `${n >= unit * 100 ? Math.floor(n / unit) : Math.floor(n / (unit / 10)) / 10}${suffix}`;
  if (n < 1_000) return String(Math.floor(n));
  return n < 1_000_000 ? short(1_000, 'k') : short(1_000_000, 'M');
}

/**
 * A token cap as typed: `500000`, `500k`, `1.5M`, `2,000,000`. Empty is no cap. It has to
 * be a whole number above zero — the daemon refuses anything else rather than reading
 * it as no cap, so it is refused here first, in words.
 */
export function parseTokens(text: string): { cap: number | null } | { why: string } {
  const t = text.trim().replace(/[,_\s]/g, '').toLowerCase();
  if (t === '') return { cap: null };
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return { why: `"${text.trim()}" is not a number of tokens — type one, like 500k or 2M.` };
  const n = Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1));
  if (!(n > 0)) return { why: 'A token budget has to be more than 0. Clear the field for no cap.' };
  return { cap: n };
}

/** Why `model` is a problem on its provider, or null. An empty list proves nothing. */
export function providerModelProblem(list: ProviderModelList | null, model: string): string | null {
  if (!list || list.models.length === 0 || list.models.some((m) => m.id === model)) return null;
  return `${providerLabel(list.provider)} doesn't list ${model} — its next run may fail until you pick another.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The OpenRouter key and the Copilot login (Settings)
// ─────────────────────────────────────────────────────────────────────────────

/** GET and PUT /api/providers/openrouter/key: whether a key is set, and where from. Never the key. */
export interface OpenRouterKeyState {
  set: boolean;
  source: 'env' | 'settings' | null;
}

/** GET /api/providers/copilot/login. */
export interface CopilotLogin {
  authenticated: boolean;
  login: string | null;
  note?: string;
}

const KEY_PATH = '/api/providers/openrouter/key';
const LOGIN_PATH = '/api/providers/copilot/login';

/**
 * Only the two fields, whatever came back. Nothing else the daemon sent reaches the
 * screen's state, so a daemon that wrongly echoed a key still couldn't get it rendered.
 */
export function keyStateFrom(raw: unknown): OpenRouterKeyState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const source = r['source'] === 'env' || r['source'] === 'settings' ? r['source'] : null;
  return { set: r['set'] === true, source };
}

/** A daemon from before these routes answers 404: say "not available", don't break. */
const missing = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** The key's state, or null when this daemon can't keep one. */
export async function readKeyState(): Promise<OpenRouterKeyState | null> {
  try {
    return keyStateFrom(await api<unknown>(KEY_PATH));
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** Set the key, or clear it with null. The answer is the state, never the key. */
export async function saveKey(key: string | null): Promise<OpenRouterKeyState> {
  return keyStateFrom(await api<unknown>(KEY_PATH, { method: 'PUT', body: { key } }));
}

/** The login, or null when this daemon can't say. */
export async function readCopilotLogin(): Promise<CopilotLogin | null> {
  try {
    const r = await api<Partial<CopilotLogin>>(LOGIN_PATH);
    return {
      authenticated: r.authenticated === true,
      login: typeof r.login === 'string' && r.login ? r.login : null,
      ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
    };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** One line for the key. It says whether and where — it has nothing else to say. */
export function keyLine(s: OpenRouterKeyState | null): string {
  if (s === null) return 'Not available — this daemon can’t keep an OpenRouter key yet.';
  if (s.set && s.source === 'env') return 'Set, from OPENROUTER_API_KEY in the daemon’s environment. That wins over one saved here.';
  if (s.set) return 'Set, and kept by the daemon. It is never shown again.';
  return 'Not set. OpenRouter agents can’t launch until it is.';
}

/** One line for the login, and how to sign in when there is none. */
export function loginLine(l: CopilotLogin | null): string {
  if (l === null) return 'Not available — this daemon can’t check a Copilot login yet.';
  if (l.authenticated) return l.login ? `Signed in as ${l.login}.` : 'Signed in.';
  return 'Not signed in. Run copilot and sign in with /login, or start the daemon with GH_TOKEN set.';
}

// ─────────────────────────────────────────────────────────────────────────────
// The hooks
// ─────────────────────────────────────────────────────────────────────────────

let known: ProviderInfo[] | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<(p: ProviderInfo[] | null) => void>();

/**
 * Every engine and what it can do, shared by every screen. Null until the daemon says,
 * and null for good from a daemon that can't — every agent there is Claude.
 */
export function useProviders(): ProviderInfo[] | null {
  const [list, setList] = useState(known);
  useEffect(() => {
    listeners.add(setList);
    asked ??= api<{ providers: ProviderInfo[] }>('/api/providers').then(
      (r) => {
        known = Array.isArray(r.providers) ? r.providers : null;
        for (const l of listeners) l(known);
      },
      () => {
        // Asked again on the next mount: the daemon may just have been restarting.
        asked = null;
      },
    );
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

const lists = new Map<string, ProviderModelList>();

/** What a non-Claude provider lists (GET /api/models?provider=). Null for Claude, which has useModels. */
export function useProviderModels(provider: string | null): {
  list: ProviderModelList | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const id = provider === CLAUDE ? null : provider;
  const [list, setList] = useState<ProviderModelList | null>(id ? (lists.get(id) ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const ask = useCallback(
    (fresh: boolean) => {
      if (!id) return;
      setLoading(true);
      setError(null);
      api<ProviderModelList>(`/api/models?provider=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`).then(
        (l) => {
          lists.set(id, l);
          setList(l);
          setLoading(false);
        },
        (err: unknown) => {
          setLoading(false);
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [id],
  );

  useEffect(() => {
    setList(id ? (lists.get(id) ?? null) : null);
    if (id && !lists.has(id)) ask(false);
  }, [id, ask]);

  return { list, error, loading, refresh: useCallback(() => ask(true), [ask]) };
}
