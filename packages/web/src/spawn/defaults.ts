/**
 * What Spawn starts from — set on the Settings tab (Amendment 47).
 *
 * Each is one setting, parsed with a fallback, so a value from an older build, or one
 * edited by hand, never leaves Spawn unable to open: a bad value reads as the built-in
 * default. Pure, so spawn/verify.ts checks the parsing under Node.
 */

import type { Autonomy, EffortLevel, Isolation } from '@conductor/shared';
import { DEFAULT_BUDGET_USD, DEFAULT_EFFORT, DEFAULT_MODE, EFFORTS, MODES, PILLS, defaultPills, type PillState } from './autonomy.js';
import { DEFAULT_PRESET, PRESETS } from './presets.js';

export const LAUNCH_KEYS = {
  preset: 'conductor.launch.preset',
  isolation: 'conductor.launch.isolation',
  pills: 'conductor.launch.pills',
  budget: 'conductor.launch.budget',
  effort: 'conductor.launch.effort',
  model: 'conductor.launch.model',
  mode: 'conductor.launch.mode',
} as const;

const ISOLATIONS: Isolation[] = ['worktree', 'branch', 'in_place'];

export interface LaunchDefaults {
  preset: string;
  isolation: Isolation;
  pills: PillState;
  /** Dollars per agent, as the budget field holds it; '' for no cap. */
  budget: string;
  effort: EffortLevel;
  /** One exact model id for every role, or null to keep each role's preset tier. */
  model: string | null;
  /** How the agents interact with you (Amendment 65). */
  mode: Autonomy['mode'];
}

export const BUILT_IN: LaunchDefaults = {
  preset: DEFAULT_PRESET,
  isolation: 'worktree',
  pills: defaultPills(),
  budget: String(DEFAULT_BUDGET_USD),
  effort: DEFAULT_EFFORT,
  model: null,
  mode: DEFAULT_MODE,
};

/** The defaults, from whatever the settings hold. `read` returns a setting or null. */
export function launchDefaults(read: (key: string) => string | null): LaunchDefaults {
  const preset = read(LAUNCH_KEYS.preset);
  const isolation = read(LAUNCH_KEYS.isolation);
  const effort = read(LAUNCH_KEYS.effort);
  const budget = read(LAUNCH_KEYS.budget);
  const model = read(LAUNCH_KEYS.model);
  const mode = read(LAUNCH_KEYS.mode);
  return {
    preset: PRESETS.some((p) => p.id === preset) ? preset! : BUILT_IN.preset,
    isolation: ISOLATIONS.includes(isolation as Isolation) ? (isolation as Isolation) : BUILT_IN.isolation,
    pills: parsePills(read(LAUNCH_KEYS.pills)),
    budget: budget !== null && (budget === '' || (Number.isFinite(Number(budget)) && Number(budget) > 0)) ? budget : BUILT_IN.budget,
    effort: EFFORTS.some((e) => e.id === effort) ? (effort as EffortLevel) : BUILT_IN.effort,
    model: model && model.trim() ? model.trim() : null,
    mode: MODES.some((m) => m.id === mode) ? (mode as Autonomy['mode']) : BUILT_IN.mode,
  };
}

/** Only the pills that exist, only as booleans; anything missing keeps its default. */
function parsePills(raw: string | null): PillState {
  const out = defaultPills();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      for (const p of PILLS) {
        const v = (parsed as Record<string, unknown>)[p.id];
        if (typeof v === 'boolean') out[p.id] = v;
      }
    }
  } catch {
    // A broken value is the default, not an error.
  }
  return out;
}

/** The settings that say `d`: a key set to what differs from built in, null to clear the rest. */
export function launchPatch(d: LaunchDefaults): Record<string, string | null> {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  return {
    [LAUNCH_KEYS.preset]: d.preset === BUILT_IN.preset ? null : d.preset,
    [LAUNCH_KEYS.isolation]: d.isolation === BUILT_IN.isolation ? null : d.isolation,
    [LAUNCH_KEYS.pills]: same(d.pills, BUILT_IN.pills) ? null : JSON.stringify(d.pills),
    [LAUNCH_KEYS.budget]: d.budget === BUILT_IN.budget ? null : d.budget,
    [LAUNCH_KEYS.effort]: d.effort === BUILT_IN.effort ? null : d.effort,
    [LAUNCH_KEYS.model]: d.model,
    [LAUNCH_KEYS.mode]: d.mode === BUILT_IN.mode ? null : d.mode,
  };
}
