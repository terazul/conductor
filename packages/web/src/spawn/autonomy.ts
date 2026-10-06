/**
 * Autonomy pills → the frozen `Autonomy` shape. Screen 7, section 5.
 *
 * THE ONE THING TO GET RIGHT HERE. A bare tool name in `allowedTools`
 * auto-approves that tool *before* `canUseTool` is consulted — the SDK says so
 * itself when you try:
 *
 *   [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked
 *   for: … Bare allowedTools entries auto-approve the whole tool before the
 *   callback is consulted.
 *
 * So "ask me before X" is expressed by LEAVING X OUT of allowedTools, never by
 * adding it. Adding `Bash` to allowedTools while telling the user we will ask
 * before bash would silently empty the attention queue — the one signal the
 * product is built on. `disallowedTools` is the only setting that survives every
 * permission mode, so anything genuinely forbidden goes there.
 */

import type { Autonomy, EffortLevel } from '@conductor/shared';
import { tokenWords } from '../lib/providers.js';

export interface PillDef {
  id: string;
  label: string;
  /**
   * When this pill is OFF the agent stops and asks, so a human gets interrupted.
   *
   * State-dependent on purpose. It used to be a static `interrupts` flag on a pill
   * labelled "ask before bash", which drew the ⚠ whether the pill was on or off — so the
   * one glyph reserved for "a human is required" appeared on a setting that, when off,
   * required nobody. Now the polarity is uniform and the warning follows the state.
   */
  interruptsWhenOff?: boolean;
  hint: string;
}

/** Read-only tools an agent needs to do anything useful. Always auto-approved. */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * "How much rope" — every pill in the SAME direction: **on means the agent may do it
 * unattended.**
 *
 * They used to be mixed. "auto-accept edits" and "allow network" granted permission
 * while "ask before bash" and "never push" withheld it, so two adjacent switches in one
 * row meant opposite things by their labels, and working out what the combination
 * allowed took reading each one twice. A row of permissions is scannable; a row of
 * alternating polarity is a puzzle.
 *
 * Plan mode is deliberately NOT here. It is a permission *mode*, not a permission, and it
 * already has its own control next to the launch button — being in both places made it
 * the only pill that both granted nothing and could not be phrased as granting anything.
 */
export const PILLS: PillDef[] = [
  // "auto-accept edits" was a pill here; it is a mode, and moved to MODES (Amendment 65).
  {
    id: 'allowBash',
    label: 'run shell unattended',
    interruptsWhenOff: true,
    hint: 'Off means every shell command waits for you — which is what puts it in your queue. On, even the commands Claude Code itself would question (cd + git, $VARIABLES) run without asking.',
  },
  {
    id: 'allowPush',
    label: 'allow git push',
    hint: 'Off adds a deny rule on `git push` that survives every permission mode.',
  },
  {
    id: 'network',
    label: 'allow network',
    hint: 'Lets the agent fetch and search the web. Off blocks WebFetch and WebSearch.',
  },
  {
    id: 'mcp',
    label: 'allow MCP tools',
    hint: 'Tools from your MCP servers (Jira, Lucid, Obsidian…) run without asking. Off sends each to your queue. Some of them change things outside this folder.',
  },
];

export type PillState = Record<string, boolean>;

/**
 * How the agent interacts with you — one choice per launch (Amendment 65). It sets only
 * the SDK's permission mode; the pills keep the tool rules, and `disallowedTools` holds in
 * every mode. It replaced the "auto-accept edits" pill and the "plan first" button, which
 * between them could reach three of the five.
 */
export const MODES: { id: Autonomy['mode']; label: string; hint: string; warn?: string }[] = [
  { id: 'default', label: 'ask me', hint: 'Every file edit, and every command the pills don’t allow, waits for you.' },
  { id: 'acceptEdits', label: 'auto-accept edits', hint: 'File edits in its folder go ahead. Commands the pills don’t allow still wait for you. Reversible from git.' },
  { id: 'plan', label: 'plan first', hint: 'It reads and writes a plan, and changes nothing until you approve the plan.' },
  { id: 'auto', label: 'auto', hint: 'Claude Code’s own judgement decides what is worth asking you; most things go ahead.' },
  {
    id: 'bypassPermissions',
    label: 'bypass permissions',
    hint: 'Nothing asks you.',
    warn: 'Nothing will ask you. Every edit and every command runs unattended, and nothing reaches Needs You. Only the deny rules still hold: no push and no network unless allowed, and a reading role still can’t write.',
  },
];

/** What Spawn did before there was a choice: edits accepted, the rest asks. */
export const DEFAULT_MODE: Autonomy['mode'] = 'acceptEdits';

/**
 * The mockup's defaults, unchanged in effect by the relabelling: edits auto-accepted,
 * shell asks, push denied, no network. Only the names moved.
 */
export function defaultPills(): PillState {
  return {
    acceptEdits: true,
    allowBash: false,
    allowPush: false,
    network: false,
    mcp: false,
    plan: false,
  };
}

/**
 * How hard the model thinks. The SDK's own scale, passed straight through — `'high'` is
 * its default, so that is ours, and naming it here rather than leaving it undefined means
 * the resolved-options panel can show what will actually be sent.
 */
export const EFFORTS: { id: EffortLevel; label: string; hint: string }[] = [
  { id: 'low', label: 'low', hint: 'Minimal thinking, fastest and cheapest responses.' },
  { id: 'medium', label: 'medium', hint: 'Moderate thinking.' },
  { id: 'high', label: 'high', hint: 'Deep reasoning. The SDK default.' },
  {
    id: 'xhigh',
    label: 'xhigh',
    hint: 'Deeper than high, on models that support it — it falls back to high elsewhere.',
  },
  { id: 'max', label: 'max', hint: 'Maximum effort. Select models only, and the slowest.' },
];

export const DEFAULT_EFFORT: EffortLevel = 'high';

/**
 * What each agent may spend in its whole life, unless you say otherwise. $5 was the
 * default while the cap was per message, when it bought a fresh $5 every reply; now
 * that it is a lifetime cap, $5 stops a real job part-way through.
 */
export const DEFAULT_BUDGET_USD = 25;

/**
 * Compose the pills into one Autonomy. Pure, so the screen can show the exact
 * resulting mode and tool lists before launching — no hidden translation.
 */
export function toAutonomy(
  pills: PillState,
  budgetUsd: number | null,
  effort: EffortLevel = DEFAULT_EFFORT,
  /** The launch's mode (Amendment 65). Absent: worked out from the pills, as before. */
  chosen?: Autonomy['mode'],
): Autonomy {
  const allowedTools = [...READ_TOOLS];
  const disallowedTools: string[] = [];

  // Bash is allowed outright only when the human has granted it. Otherwise it is
  // absent, which is what routes it to canUseTool.
  if (pills['allowBash']) allowedTools.push('Bash');

  if (pills['network']) {
    allowedTools.push('WebFetch', 'WebSearch');
  } else {
    disallowedTools.push('WebFetch', 'WebSearch');
  }

  // Every MCP server's tools (Amendment 67). Conductor answers their asks too.
  if (pills['mcp']) allowedTools.push('mcp__*');

  // Rule syntax, not a bare name: forbid pushing without forbidding git.
  if (!pills['allowPush']) disallowedTools.push('Bash(git push:*)');

  const mode: Autonomy['mode'] =
    chosen ??
    (pills['plan']
      ? 'plan'
      : pills['acceptEdits']
        ? 'acceptEdits'
        : 'default');

  return { mode, allowedTools, disallowedTools, budgetUsd, effort };
}

/** One-line plain-English summary of what the agent may do unattended. */
export function describeAutonomy(a: Autonomy): string {
  const bits: string[] = [];
  bits.push(
    a.mode === 'plan'
      ? 'plans only, executes nothing'
      : a.mode === 'acceptEdits'
        ? 'edits files unattended'
        : a.mode === 'auto'
          ? 'decides for itself what to ask'
          : a.mode === 'bypassPermissions'
            ? '⚠ asks you nothing'
            : 'asks before changing anything',
  );
  // Under bypass nothing asks, whatever the tool lists say (Amendment 65).
  bits.push(a.allowedTools.includes('Bash') || a.mode === 'bypassPermissions' ? 'runs shell unattended' : 'asks before shell');
  if (a.disallowedTools.length > 0) bits.push(`${a.disallowedTools.length} deny rule(s)`);
  if (a.effort) bits.push(`${a.effort} effort`);
  if (a.budgetUsd !== null) bits.push(`stops at $${a.budgetUsd}`);
  // An engine without dollars is capped in tokens (Amendment 80). Claude's autonomy has none.
  if (a.budgetTokens) bits.push(`stops at ${tokenWords(a.budgetTokens)} tokens`);
  return bits.join(' · ');
}
