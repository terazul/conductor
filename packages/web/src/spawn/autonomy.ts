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

import { WHEN_DONE_LABELS, WHEN_DONE_STEPS, type Autonomy, type EffortLevel, type WhenDone, type WhenDoneStep } from '@conductor/shared';
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

/**
 * What a job does by itself when it's done (Amendment 219, which replaced Amendment 144's one
 * "merge into main and clean up" with five), worded the same in Spawn, Settings and the composer.
 * Each says what the step does and what it never does.
 */
export const WHEN_DONE_HINTS: Record<WhenDoneStep, string> = {
  commit:
    "When its job is done, commits what's left uncommitted in the job's folder, named after the job and its last reply. Nothing uncommitted is skipped. It never amends or rewrites a commit. Worktree jobs only.",
  test:
    "Then runs the project's test command in the job's folder, for up to 30 minutes. Anything but a pass stops the steps after it, and Needs You shows the end of its output. It never changes the command. Worktree jobs only.",
  merge:
    "Then merges the job's branch into the project's main branch, only when the merge is clean. A conflict asks you in Needs You instead; it never resolves one for you. Worktree jobs only.",
  push:
    "Then pushes to origin: the branch it merged into, or with merge off the job's own branch. It never force-pushes, so a rejected push stops and says why, and it never pushes commits of yours: a target with commits not on origin beyond the merge stops, to be pushed from Branches. Worktree jobs only.",
  cleanup:
    "Then, once its branch is merged, removes the job's folder and its branch (git branch -d). It never removes an unmerged branch, and never removes the agent: the job and its transcript stay, a message puts the folder back, and Remove still deletes. Worktree jobs only.",
};

/** The Test pill's title when the project has no command to run (Amendment 219). */
export const NO_TEST_COMMAND_TITLE = "set a test command on the project's Edit first";

/** The when-done pills' title when the job runs in the project's own folder (Amendment 219). */
export const WHEN_DONE_NEEDS_WORKTREE = 'Only a job on a branch of its own, in a folder of its own, does steps when it is done. Pick a new branch to use them.';

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

/** A when-done step's pill id: `done.commit` and the rest. */
export const whenDonePillId = (s: WhenDoneStep): string => `done.${s}`;

/**
 * What happens when the job is done (Amendment 219), not tool rules, so `toAutonomy` sets
 * `whenDone` from them and no tool list changes. A row of their own, after **when done:**.
 */
export const WHEN_DONE_PILLS: (PillDef & { step: WhenDoneStep })[] = WHEN_DONE_STEPS.map((s) => ({
  id: whenDonePillId(s),
  step: s,
  label: WHEN_DONE_LABELS[s],
  hint: WHEN_DONE_HINTS[s],
}));

/** The steps the pills turn on, or null for none. */
export function whenDoneOfPills(pills: PillState): WhenDone | null {
  const out: WhenDone = {};
  for (const p of WHEN_DONE_PILLS) if (pills[p.id]) out[p.step] = true;
  return Object.keys(out).length > 0 ? out : null;
}

/** The pills with every when-done step off: what a job in the project's own folder launches with. */
export function withoutWhenDone(pills: PillState): PillState {
  const out = { ...pills };
  for (const p of WHEN_DONE_PILLS) out[p.id] = false;
  return out;
}

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
 * The mockup's defaults: edits auto-accepted, push denied, no network. Shell runs unattended
 * since Amendment 175: with it off every command waited for you, and a stack stopped on its
 * first one. A reading role still gets only the read-only commands (`rowAutonomy`).
 */
export function defaultPills(): PillState {
  return {
    acceptEdits: true,
    allowBash: true,
    allowPush: false,
    network: false,
    mcp: false,
    plan: false,
    ...Object.fromEntries(WHEN_DONE_PILLS.map((p) => [p.id, false])),
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
 * The efforts a model takes (Amendment 190): those its list names, in `EFFORTS`' order, or all
 * five where the list names none — Claude, OpenRouter, a model id typed rather than picked.
 */
export function effortsFor(listed: readonly string[] | undefined): typeof EFFORTS {
  const named = EFFORTS.filter((e) => listed?.includes(e.id));
  return named.length > 0 ? named : EFFORTS;
}

/**
 * The effort a model takes that is nearest `effort`: itself when it takes it, else the closest
 * on the scale, the lower of two as close — a model that doesn't take yours shouldn't quietly
 * cost more.
 */
export function nearestEffort(effort: EffortLevel, offered: typeof EFFORTS): EffortLevel {
  if (offered.some((e) => e.id === effort)) return effort;
  const at = (id: EffortLevel) => EFFORTS.findIndex((e) => e.id === id);
  let best = offered[0]?.id ?? effort;
  for (const e of offered) if (Math.abs(at(e.id) - at(effort)) < Math.abs(at(best) - at(effort))) best = e.id;
  return best;
}

/** What is said when a model is picked that doesn't take the effort chosen, and it moves. */
export function effortMovedLine(model: string, from: EffortLevel, to: EffortLevel): string {
  return `${model} doesn't take effort ${from}, so it is ${to}.`;
}

/**
 * What each agent may spend PER DAY, unless you say otherwise (Amendment 129). $5 was the
 * default while the cap was per message, when it bought a fresh $5 every reply, and $5 stopped
 * a real job part-way through once the cap was a lifetime one. It is a daily figure now, back
 * to zero at midnight, and $25 stays.
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

  // Bash is allowed outright only when the pill grants it (on by default, Amendment 175).
  // Otherwise it is absent, which is what routes it to canUseTool.
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

  const whenDone = whenDoneOfPills(pills);
  return { mode, allowedTools, disallowedTools, budgetUsd, effort, ...(whenDone ? { whenDone } : {}) };
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
  bits.push(
    a.allowedTools.includes('Bash') || a.mode === 'bypassPermissions'
      ? 'runs shell unattended'
      : // A reading role's read-only commands (Amendment 148).
        a.allowedTools.some((t) => t.startsWith('Bash('))
        ? 'runs some shell commands unattended, asks before the rest'
        : 'asks before shell',
  );
  if (a.disallowedTools.length > 0) bits.push(`${a.disallowedTools.length} deny rule(s)`);
  if (a.effort) bits.push(`${a.effort} effort`);
  if (a.budgetUsd !== null) bits.push(`budget $${a.budgetUsd} a day`);
  // An engine without dollars is capped in tokens (Amendment 80). Claude's autonomy has none.
  if (a.budgetTokens) bits.push(`budget ${tokenWords(a.budgetTokens)} tokens a day`);
  return bits.join(' · ');
}
