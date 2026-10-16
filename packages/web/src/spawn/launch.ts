/**
 * Which git methodology a launch uses (Amendment 115, ADR 0009 §4), and the request it makes.
 * Pure, so spawn/verify.ts checks it under Node.
 *
 * Spawn's isolation pills used to be the three `Isolation` values. They are now three
 * choices of what the agents do with git, and one of them is not an `Isolation` of its own:
 *
 *   in_place   (1) the default branch, in the folder   → isolation 'in_place'
 *   named      (2) a new branch, with a name you give  → isolation 'worktree' + branch: <name>
 *   worktree   (3) a new branch per launch             → isolation 'worktree' (conductor/<jobId>)
 *
 * The values are the ones the setting `conductor.launch.isolation` has always held for (1)
 * and (3), so a setting saved before this still reads. 'branch' ("branch in place") is not
 * offered any more, and a setting that holds it reads as the built-in default; the API still
 * accepts that isolation, so jobs that have it are unchanged.
 */

import type { AgentSpec, BranchesResponse, CreateJobRequest, CreateJobsRequest, Isolation } from '@conductor/shared';
import { DEFAULT_STACKS, STACKS_MAX } from '@conductor/shared';

export type Method = 'in_place' | 'named' | 'worktree';

export interface MethodDef {
  id: Method;
  label: string;
  /** What sits after the label on the pill. */
  note?: string;
  /** The words for Settings, which has no room for the note. */
  words: string;
  hint: string;
  /** Edits your files where they are, with nothing to revert to: drawn in --fail, not amber. */
  danger?: boolean;
  /** Creates a branch, so it cannot run in a folder with no git (Amendment 10). */
  requiresGit?: boolean;
}

/** In the order the pills are numbered. */
export const METHODS: MethodDef[] = [
  {
    id: 'in_place',
    label: 'default branch',
    note: 'in the folder · no undo',
    words: 'default branch, in the folder',
    hint:
      "Agents edit your files where they are, on whatever is checked out in the folder: normally the default branch, or no branch at all when the folder isn't a repo. The only choice that needs no git, and the only one with nothing to revert to.",
    danger: true,
  },
  {
    id: 'named',
    label: 'new branch:',
    note: 'a name you give',
    words: 'new branch, named at launch',
    hint:
      "A separate checkout on the branch you name, so your folder and your other jobs are untouched. A branch that exists is used as it is, with its commits; one only on origin gets a local branch that tracks it; one that is nowhere is made from what the folder has checked out. The default branch, and one that is checked out somewhere already, are refused.",
    requiresGit: true,
  },
  {
    id: 'worktree',
    label: 'new branch per launch',
    note: '.conductor/wt/<job>',
    words: 'new branch per launch',
    hint: 'A separate checkout on its own new branch, conductor/<job>, for every launch. Your working tree is untouched. A follow-up message to an agent stays on that job branch.',
    requiresGit: true,
  },
];

export const DEFAULT_METHOD: Method = 'worktree';

/** A setting's value as a method; anything else, 'branch' included, is the built-in default. */
export function methodFrom(raw: string | null): Method {
  return METHODS.some((m) => m.id === raw) ? (raw as Method) : DEFAULT_METHOD;
}

/** The isolation the daemon is sent. (2) is a worktree too: the name is what differs. */
export function isolationOf(method: Method): Isolation {
  return method === 'in_place' ? 'in_place' : 'worktree';
}

/**
 * Why `name` can't be a branch's, or null. The same rules as `git check-ref-format
 * --branch`, which the daemon asks (the last word), so a name that fails here is spared the
 * round trip; spawn/verify.ts compares the two on a list of names. `refused` are the
 * branches the daemon would refuse by name: the project's default.
 */
export function branchProblem(raw: string, refused: readonly string[] = []): string | null {
  const name = raw.trim();
  if (name.length === 0) return 'Name the branch.';
  if (refused.includes(name)) {
    return `${name} is this project's default branch. Choose "default branch" to work on it, or name another.`;
  }
  if (/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name)) {
    return 'A branch name has no spaces, and none of ~ ^ : ? * [ \\.';
  }
  if (name === '@' || name === 'HEAD') return `"${name}" can't be a branch name.`;
  if (name.startsWith('-')) return "A branch name can't start with a dash.";
  if (name.startsWith('refs/')) return "A branch name can't start with refs/.";
  if (name.includes('..') || name.includes('@{')) return 'A branch name has no ".." or "@{".';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'A branch name has no leading, trailing or doubled slash.';
  }
  if (name.endsWith('.')) return "A branch name can't end with a dot.";
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return 'No part of a branch name starts with a dot or ends with .lock.';
  }
  return null;
}

/** Whether the method has what it needs to launch: (2) needs a name git would take. */
export function methodReady(method: Method, branch: string, refused: readonly string[] = []): boolean {
  return method !== 'named' || branchProblem(branch, refused) === null;
}

/**
 * The label a job carries for the preset it came from. A preset whose rows were moved or
 * whose ticks were changed for this launch is no longer that preset, so the label says so.
 * Nothing reads it: the daemon takes the agents, not the label (`CreateJobRequest.preset`).
 */
export function presetLabel(label: string, changed: boolean): string {
  return changed ? `${label} (changed)` : label;
}

export interface LaunchInput {
  projectId: string;
  prompt: string;
  method: Method;
  /** (2)'s name; ignored for the others. */
  branch: string;
  preset: string;
  agents: AgentSpec[];
  budgetUsd: number | null;
}

/** The request a launch makes: `branch` only for (2), so (1) and (3) send what they always did. */
export function launchBody(i: LaunchInput): CreateJobRequest {
  return {
    projectId: i.projectId,
    prompt: i.prompt.trim(),
    isolation: isolationOf(i.method),
    ...(i.method === 'named' ? { branch: i.branch.trim() } : {}),
    preset: i.preset,
    agents: i.agents,
    budgetUsd: i.budgetUsd,
  };
}

/**
 * Several stacks from one launch (Amendment 178). An orchestrated launch may start up to the
 * setting's count of stacks from one plan, each its own job, worktree and branch, and each
 * told its own work by `{track}`: the stack's number, 1 to N, put in the prompt and in a
 * branch you name. Spawn doesn't read the plan file; the number is all a stack is told.
 */
export const TRACK = '{track}';

/** The setting that caps the stacks control, as the daemon's `stacksLimit()` reads it. */
export const STACKS_KEY = 'conductor.launch.stacks';

/** The setting's value as a count: a whole number from 1 to `STACKS_MAX`, or the default. */
export function stacksFrom(raw: string | null): number {
  const n = Number(raw);
  return raw !== null && raw.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= STACKS_MAX ? n : DEFAULT_STACKS;
}

/** `text` with every `{track}` made `n`. */
export function withTrack(text: string, n: number): string {
  return text.split(TRACK).join(String(n));
}

/**
 * Why `n` stacks can't launch as asked, or null. One stack is today's launch and is never
 * refused here. More need `{track}` in the prompt, so each has its own work, and in a branch
 * you name, so each has its own branch; and each needs a checkout of its own, which (1) is not.
 */
export function stacksRefusal(
  prompt: string,
  method: Method,
  branch: string,
  n: number,
  limit: number = STACKS_MAX,
): string | null {
  if (n <= 1) return null;
  if (n > limit) return `At most ${limit} stacks from one launch (Settings → Agents).`;
  if (!prompt.includes(TRACK)) return `Each stack needs its own work: put ${TRACK} where its number goes.`;
  if (method === 'in_place') {
    return 'Each stack needs a checkout of its own: choose a new branch, not the default branch in the folder.';
  }
  if (method === 'named' && !branch.includes(TRACK)) {
    return `Each stack needs a branch of its own: put ${TRACK} in the branch's name.`;
  }
  return null;
}

/**
 * The requests `n` stacks make, in order. One is `launchBody` exactly; more fill `{track}` with
 * 1 to N in the prompt and in a named branch, and are otherwise the same launch.
 */
export function stacksBodies(input: LaunchInput, n: number): CreateJobRequest[] {
  if (n <= 1) return [launchBody(input)];
  return Array.from({ length: n }, (_, i) =>
    launchBody({ ...input, prompt: withTrack(input.prompt, i + 1), branch: withTrack(input.branch, i + 1) }),
  );
}

/** Where a launch posts and what: one stack to `/api/jobs` as always, more to the batch. */
export function launchRequest(
  input: LaunchInput,
  n: number,
): { path: '/api/jobs'; body: CreateJobRequest } | { path: '/api/jobs/batch'; body: CreateJobsRequest } {
  const bodies = stacksBodies(input, n);
  return n <= 1 ? { path: '/api/jobs', body: bodies[0]! } : { path: '/api/jobs/batch', body: { jobs: bodies } };
}

/** Each stack's first line, `{track}` filled, as shown under the prompt; none for one stack. */
export function stacksPreview(prompt: string, n: number): string[] {
  if (n <= 1) return [];
  const first = prompt.trim().split('\n')[0] ?? '';
  return Array.from({ length: n }, (_, i) => withTrack(first, i + 1));
}

const usd = (v: number): string =>
  `$${v.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 })}`;

/** "3 stacks × $500 = $1,500", or null for one stack or no budget. */
export function stacksBudgetLine(n: number, perStack: number | null): string | null {
  if (n <= 1 || perStack === null) return null;
  return `${n} stacks × ${usd(perStack)} = ${usd(n * perStack)}`;
}

/** What the control says under it: the slots they want at once, and how they merge. */
export function stacksNotes(n: number, free: number): string[] {
  if (n <= 1) return [];
  const notes: string[] = [];
  if (n > free) {
    notes.push(
      `${n} stacks want up to ${n} slots at once, one orchestrator each, and ${free} ${free === 1 ? 'is' : 'are'} free: the rest wait for one.`,
    );
  }
  notes.push('Stacks that merge into one branch need the plan to say how (a merge lock, as wave-11-tracks.md §0).');
  return notes;
}

/**
 * One entry of (2)'s branch picker (Amendment 139). `refused` is set for a branch the daemon
 * would refuse by what the listing says: the default, or one checked out somewhere (the
 * project's own folder included). It is still offered, so you see it is there, but marked.
 */
export interface BranchOption {
  value: string;
  /** What the picker shows beside the name. */
  label: string;
  from: 'local' | 'origin';
  refused: boolean;
}

/**
 * The picker's list, from `GET …/branches`: local branches first, in the order the daemon
 * gives them (the compared-with branch, then newest tip), then the branches only origin has,
 * as last fetched, marked "on origin". `defaults` are the names refused as the project's
 * default (`Project.defaultBranch`), as `branchProblem` refuses them. The field stays free
 * text: a name not in the list is a new branch. A daemon from before Amendment 139 sends no
 * `remoteOnly`, and the list is the local branches only.
 */
export function branchOptions(
  res: Pick<BranchesResponse, 'branches' | 'remoteOnly'> | null,
  defaults: readonly string[] = [],
): BranchOption[] {
  if (!res) return [];
  const local = res.branches.map((b): BranchOption => {
    if (defaults.includes(b.name)) {
      return { value: b.name, label: 'default branch (refused: choose 1)', from: 'local', refused: true };
    }
    if (b.live) return { value: b.name, label: 'an agent is on it (checked out)', from: 'local', refused: true };
    if (b.worktree) return { value: b.name, label: '(checked out)', from: 'local', refused: true };
    return { value: b.name, label: 'local', from: 'local', refused: false };
  });
  const have = new Set(local.map((o) => o.value));
  const origin = (res.remoteOnly ?? [])
    .filter((n) => !have.has(n))
    .map((n): BranchOption => ({ value: n, label: 'on origin', from: 'origin', refused: false }));
  return [...local, ...origin];
}

/**
 * What (2)'s note says about the name typed, from the picker's list, or null to say the usual
 * thing. The daemon has the last word; this is what the listing knew when it was fetched, so
 * it does not hold the launch back.
 */
export function pickedNote(raw: string, options: readonly BranchOption[]): string | null {
  const o = options.find((x) => x.value === raw.trim());
  if (!o) return null;
  if (o.from === 'origin') {
    return `Only on origin, as last fetched: a local ${o.value} is made that tracks origin/${o.value}, with its commits.`;
  }
  if (o.refused && o.label !== 'default branch (refused: choose 1)') {
    return `${o.value} is checked out somewhere already, so the launch will be refused: finish the work there, or name another.`;
  }
  return null;
}
