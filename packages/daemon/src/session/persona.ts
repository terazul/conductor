/**
 * Limits on a persona's prompt and skills (Amendment 68), wherever the daemon takes one: a
 * launch spec, the personas in Settings each run reads (Amendment 178), and a save of them.
 */

import { PERSONAS_KEY } from '@conductor/shared';
import { settingRule } from '../settings.js';

export const PERSONA_ID = /^[a-z0-9-]{1,60}$/;
export const SYSTEM_PROMPT_MAX = 20_000;
export const SKILL_MAX = 100;
export const SKILLS_MAX = 50;

/** Why a system prompt won't do, or null. */
export function systemPromptProblem(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return 'systemPrompt must be a string';
  if (prompt.length > SYSTEM_PROMPT_MAX) return `systemPrompt is at most ${SYSTEM_PROMPT_MAX} characters`;
  return null;
}

/** Why a skill list won't do, or null. */
export function skillsProblem(skills: unknown): string | null {
  if (!Array.isArray(skills)) return 'skills must be an array of skill names';
  if (skills.length > SKILLS_MAX) return `at most ${SKILLS_MAX} skills`;
  if (skills.some((s) => typeof s !== 'string' || !s.trim() || s.length > SKILL_MAX)) return `every skill is a name of 1 to ${SKILL_MAX} characters`;
  return null;
}

/**
 * A save of the personas refused for a system prompt over the limit, the one cap the editor in
 * Settings → Personas keeps to too (its `maxLength`). Not the skills: the editor takes any
 * number of any length, so a cap here would refuse a save it allows; a run whose persona has
 * too many falls back to its launch copy instead. A value that isn't JSON is left alone, as the
 * built-ins are what it reads as.
 */
settingRule(PERSONAS_KEY, (v) => {
  let stored: { edits?: unknown; own?: unknown };
  try {
    stored = JSON.parse(v) as typeof stored;
  } catch {
    return null;
  }
  if (!stored || typeof stored !== 'object') return null;
  const edits = stored.edits && typeof stored.edits === 'object' ? Object.entries(stored.edits as Record<string, unknown>) : [];
  const own = Array.isArray(stored.own) ? stored.own.map((p) => [(p as { id?: unknown })?.id, p] as const) : [];
  for (const [id, p] of [...edits, ...own]) {
    const prompt = (p as { systemPrompt?: unknown } | null)?.systemPrompt;
    if (typeof prompt === 'string' && prompt.length > SYSTEM_PROMPT_MAX) return `the ${String(id)} persona's system prompt is at most ${SYSTEM_PROMPT_MAX} characters`;
  }
  return null;
});
