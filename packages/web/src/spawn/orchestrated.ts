/**
 * The roles an orchestrated stack may start (Amendment 128). Pure, so spawn/verify.ts checks
 * the rules under Node.
 *
 * The preset "orchestrated pipeline" is one row, the orchestrator. Which agents it may start is
 * listed before launch, like the other plan rows are editable: each role with the model tier it
 * runs on, a role removed, another added. The list goes to the daemon in the orchestrator's
 * spec (`AgentSpec.helperRoles`), where `start_helper` can start those roles and no others.
 * It is state of this launch only, like a preset's moved rows (Amendment 99): choosing a preset
 * again puts the default list back.
 *
 * One agent needs no orchestrator. With no role listed the stack is one agent, and nothing
 * marks an orchestrator, offers helpers or sends a list: it launches that agent plainly.
 */

import type { ModelCatalog, ModelTier } from '@conductor/shared';
import { DEFAULT_PIPELINE_ROLES, PIPELINE_ROLES_MAX, SEND_BACKS_MAX, pipelineHelperCap, showsOrchestrator } from '@conductor/shared';
import { BUILT_IN_PERSONAS, personaFor, type Persona } from './personas.js';

/** The preset's id. */
export const ORCHESTRATED_ID = 'orchestrated';

/** One role as the plan lists it: its persona's id, and the tier its helpers run on. */
export interface ListedRole {
  id: string;
  tier: ModelTier;
}

const TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku'];

/** A persona's tier: its model when that is a tier, else `sonnet`, which the presets give to every role but the architect and developer (Amendment 148). */
export function tierOf(persona: Persona | undefined): ModelTier {
  const m = persona?.model;
  return TIERS.find((t) => t === m) ?? 'sonnet';
}

/**
 * The roles listed unless you change them: developer, validator, reviewer and scribe, each on
 * the tier its persona asks for (opus, sonnet, sonnet, sonnet, as the full pipeline has them since
 * Amendment 148).
 */
export function defaultListed(personas?: readonly Persona[]): ListedRole[] {
  const all = personas ?? BUILT_IN_PERSONAS;
  return DEFAULT_PIPELINE_ROLES.map((id) => ({ id, tier: tierOf(personaFor(all, id)) }));
}

/** The list with `id` moved to `tier`; the same list when it isn't there. */
export function withTier(list: readonly ListedRole[], id: string, tier: ModelTier): ListedRole[] {
  return list.map((r) => (r.id === id ? { ...r, tier } : r));
}

/** The list without `id`. */
export function withoutRole(list: readonly ListedRole[], id: string): ListedRole[] {
  return list.filter((r) => r.id !== id);
}

/** The list with `id` added at the end, on its persona's tier. Unchanged when it is there already or the list is full. */
export function withRole(list: readonly ListedRole[], id: string, personas?: readonly Persona[]): ListedRole[] {
  if (list.some((r) => r.id === id) || list.length >= PIPELINE_ROLES_MAX) return [...list];
  return [...list, { id, tier: tierOf(personaFor(personas ?? BUILT_IN_PERSONAS, id)) }];
}

/** The personas not yet listed, in the order Settings shows them: what the add control offers. */
export function offeredRoles(list: readonly ListedRole[], personas?: readonly Persona[]): Persona[] {
  return (personas ?? BUILT_IN_PERSONAS).filter((p) => !list.some((r) => r.id === p.id));
}

/** How many agents the stack launches and may start: the orchestrator and its roles. */
export function stackAgents(list: readonly ListedRole[]): number {
  return 1 + list.length;
}

/** Whether the stack is an orchestrated one: two or more agents. One has no orchestrator (shared `showsOrchestrator`). */
export function orchestrates(list: readonly ListedRole[]): boolean {
  return showsOrchestrator(stackAgents(list));
}

/** How many helpers the orchestrator may start in all: each role once, and sent back as often as allowed. */
export function helperCapFor(list: readonly ListedRole[]): number {
  return pipelineHelperCap(list.length);
}

/** The listed roles whose tier the model API serves no model for: they have no id to send, so the launch waits. */
export function unresolvedListed(list: readonly ListedRole[], tiers: ModelCatalog['tiers']): ListedRole[] {
  return list.filter((r) => !tiers[r.tier]);
}

/** What the plan says about sending work back, in the words the daemon enforces. */
export function sendBackWords(): string {
  return (
    `It starts one role at a time and reads what it did before the next. It may send a role's work back ` +
    `(start it again, as the developer after a failed review) at most ${SEND_BACKS_MAX} times, then it asks you.`
  );
}
