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

import type { AgentSpec, BranchesResponse, CreateJobRequest, Isolation } from '@conductor/shared';

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
