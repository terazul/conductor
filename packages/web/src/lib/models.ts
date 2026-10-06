/**
 * The models an agent can be given — GET /api/models, and the words for them.
 * (Amendment 40)
 *
 * An agent keeps the exact id it was launched with (`us.anthropic.claude-opus-5-5`),
 * never a nickname, so what it runs on cannot change under it. Presets still name a
 * tier ('opus'), because ids differ per deployment; `resolveTier` turns one into the id
 * the catalog says it means now, and that id is what gets sent.
 *
 * The words are pure and import no CSS, so lib/verify.ts checks them under Node.
 */

import { useCallback, useEffect, useState } from 'react';
import { MODEL_NICKNAMES } from '@conductor/shared';
import type { ModelCatalog, ModelOption, ModelTier } from '@conductor/shared';
import { api } from './feed.js';

// ─────────────────────────────────────────────────────────────────────────────
// Words
// ─────────────────────────────────────────────────────────────────────────────

export const isNickname = (model: string): boolean =>
  (MODEL_NICKNAMES as readonly string[]).includes(model);

/** The exact id a tier means now, or null when the catalog has nothing for it. */
export function resolveTier(cat: ModelCatalog | null, tier: ModelTier): string | null {
  return cat?.tiers[tier] ?? null;
}

/**
 * `us.anthropic.claude-opus-5-5` → `opus-5-5`; `…[1m]` → `opus-5-5 · 1M`. Anything
 * that isn't Claude is left alone — its id is the only name it has.
 */
export function shortModel(model: string): string {
  const wide = /\[1m\]$/i.test(model);
  const bare = model
    .replace(/\[1m\]$/i, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/^claude-/, '')
    .replace(/-v\d+:\d+$/, '');
  return wide ? `${bare} · 1M` : bare;
}

/** What to call `model` in a picker: the catalog's name when it has one. */
export function modelLabel(cat: ModelCatalog | null, model: string): string {
  return cat?.models.find((m) => m.id === model)?.label ?? model;
}

/**
 * Why `model` is a problem for the agent that has it, or null. A nickname is one: it
 * means whatever the settings say today. An id missing from the gateway's own list is
 * another — the agent's next run would fail on it. Claude Code's list, or no list,
 * proves nothing either way.
 */
export function modelProblem(cat: ModelCatalog | null, model: string): string | null {
  if (isNickname(model)) {
    const means = resolveTier(cat, model as ModelTier);
    return `"${model}" is a nickname${means ? ` for ${means}` : ''} — pick the exact model so it can't change under this agent.`;
  }
  if (cat?.source === 'gateway' && !cat.models.some((m) => m.id === model)) {
    return `${cat.host ?? 'the model API'} no longer serves ${model} — its next run will fail until you pick another.`;
  }
  return null;
}

/** The picker's groups: Claude first, then what may not handle Claude Code's tools. */
export function modelGroups(cat: ModelCatalog | null): { label: string; models: ModelOption[] }[] {
  const models = cat?.models ?? [];
  return [
    { label: 'Claude', models: models.filter((m) => m.claude) },
    { label: 'Other models · may not handle Claude Code’s tools', models: models.filter((m) => !m.claude) },
  ].filter((g) => g.models.length > 0);
}

/** One line under a picker saying where its list came from, when that is worth saying. */
export function catalogLine(cat: ModelCatalog | null): string | null {
  if (!cat) return null;
  if (cat.source === 'gateway') return cat.note ?? null;
  if (cat.source === 'claude-code')
    return `Not checked against the model API — ${cat.note ?? 'this is what your settings name, not what is served.'}`;
  return cat.note ?? 'No model list could be read.';
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────────────

let cached: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;
const listeners = new Set<(c: ModelCatalog) => void>();

function load(fresh: boolean): Promise<ModelCatalog> {
  if (!fresh && inflight) return inflight;
  const p = api<ModelCatalog>(`/api/models${fresh ? '?fresh=1' : ''}`).then((c) => {
    cached = c;
    for (const l of listeners) l(c);
    return c;
  });
  inflight = p.finally(() => {
    if (inflight === p) inflight = null;
  });
  return p;
}

/**
 * The catalog, shared by every picker on the page. The daemon caches it for ten
 * minutes; `refresh` asks it to look again.
 */
export function useModels(): {
  catalog: ModelCatalog | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cached === null);

  const ask = useCallback((fresh: boolean) => {
    setLoading(true);
    setError(null);
    load(fresh).then(
      () => setLoading(false),
      (err: unknown) => {
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  useEffect(() => {
    listeners.add(setCatalog);
    if (!cached) ask(false);
    return () => {
      listeners.delete(setCatalog);
    };
  }, [ask]);

  return { catalog, error, loading, refresh: useCallback(() => ask(true), [ask]) };
}
