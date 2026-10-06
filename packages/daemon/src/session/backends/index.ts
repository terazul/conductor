/**
 * The engines an agent can run on (Amendment 74).  TRACK A.
 *
 * One factory per provider. Claude is always here; a provider whose backend isn't built
 * yet isn't registered, and spawning on it is refused with a sentence, not a crash.
 *
 * GitHub Copilot and OpenRouter (Amendment 76) are one engine, backends/copilot.ts, with
 * two ways in. Their factories are written here, calling into that file only when they
 * are used, because the arbiter reads capabilities from this registry and copilot.ts
 * imports the arbiter: nothing of copilot.ts is touched while the modules load.
 */

import type { Db } from '../../db/index.js';
import type { AgentBackend, BackendFactory, ProviderId, RunnerScope } from '../backend.js';
import { catalog } from '../models.js';
import { ClaudeBackend } from './claude.js';
import {
  CopilotBackend,
  copilotModels,
  copilotRefusal,
  openRouterModels,
  openRouterRefusal,
} from './copilot.js';

const claude: BackendFactory = {
  provider: 'claude',
  // Everything it has always done.
  capabilities: { defer: true, resume: true, costUsd: true, effort: true, planMode: true, helperTools: true },
  async listModels() {
    const c = await catalog();
    return c.models.map((m) => ({ id: m.id, displayName: m.label, ...(m.effortLevels ? { efforts: m.effortLevels } : {}) }));
  },
  unavailable: () => null,
  create: (db, scope) => new ClaudeBackend(db, scope),
};

/**
 * From docs/plans/multi-provider-findings.md. No `defer` (Q6), so the arbiter holds its
 * requests instead of parking them; no dollars (Q7); no plan-only mode wired yet.
 */
const COPILOT_CAPABILITIES = { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true };

const copilot: BackendFactory = {
  provider: 'copilot',
  capabilities: COPILOT_CAPABILITIES,
  listModels: () => copilotModels(),
  unavailable: () => copilotRefusal(),
  create: (db, scope) => new CopilotBackend(db, scope, 'copilot'),
};

const openrouter: BackendFactory = {
  provider: 'openrouter',
  capabilities: COPILOT_CAPABILITIES,
  listModels: () => openRouterModels(),
  unavailable: () => openRouterRefusal(),
  create: (db, scope) => new CopilotBackend(db, scope, 'openrouter'),
};

const factories = new Map<ProviderId, BackendFactory>([
  ['claude', claude],
  ['copilot', copilot],
  ['openrouter', openrouter],
]);

/** Add a provider's factory. Each non-Claude backend registers itself. */
export function registerBackend(f: BackendFactory): void {
  factories.set(f.provider, f);
}

export function backendFor(provider: ProviderId): BackendFactory | undefined {
  return factories.get(provider);
}

/** Why spawning on `provider` won't work, or null when it will. */
export function providerRefusal(provider: ProviderId): string | null {
  const f = factories.get(provider);
  if (!f) return `${provider} isn't available in this build yet`;
  return f.unavailable();
}

export function createBackend(provider: ProviderId, db: Db, scope: RunnerScope): AgentBackend {
  const f = factories.get(provider);
  if (!f) throw new Error(`no ${provider} backend`);
  return f.create(db, scope);
}

/** Every provider, available or not, for GET /api/providers. */
export function providers(): BackendFactory[] {
  return [...factories.values()];
}
