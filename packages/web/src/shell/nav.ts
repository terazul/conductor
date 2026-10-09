/**
 * Navigation and selection.  TRACK B.
 *
 * Screen switching goes through `lib/nav.ts` (Amendment 3) — `navigate()`,
 * `currentRoute()`, `onNavigate()`. Nothing here touches `location.hash`, and
 * nothing hand-rolls a route.
 *
 * Two things this module adds on top:
 *
 *  1. NAMED DESTINATIONS.  `openFiles(job)` rather than a bare string, so a
 *     screen id typed wrong is a compile error at one site instead of a dead
 *     button. Ids for other tracks' screens match their directory names per
 *     CONTRACT's reserved table; main.tsx ignores a hash whose id has no
 *     registered screen, so jumping to Files before Track C lands is a quiet
 *     no-op rather than a blank page.
 *
 *  2. A FALLBACK MEMORY.  Params ride the hash, which is the source of truth and
 *     survives a reload. But pressing `2` for Project sends you there with no
 *     params, and landing on "whatever is first" after you had been looking at
 *     something specific is worse than landing back where you were. So the last
 *     explicit choice is remembered and used ONLY when the hash says nothing —
 *     the "leave my selection alone" policy `useNavParams` leaves to the screen.
 *
 * Reading params is NOT reimplemented here: use `useNavParams` from lib/nav.ts
 * (Amendment 5). It already covers both halves — the mount-time read for arriving
 * from another screen, and the listener for new params while already open.
 */

import type { Agent, DevServer, Job, Project } from '@conductor/shared';
import { navigate, type NavParams } from '../lib/nav.js';

/**
 * Screen ids. Track B's own are definitive; the rest are other tracks' and are
 * their directory names (CONTRACT §3, reserved screen slots).
 */
export const SCREEN = {
  fleet: 'fleet',
  project: 'project',
  agent: 'agent',
  attention: 'attention',
  files: 'files',
  preview: 'preview',
  branches: 'branches',
  spawn: 'spawn',
  diagnostics: 'diagnostics',
} as const;

// ── fallback memory ─────────────────────────────────────────────────────────

interface Remembered {
  projectId?: string;
  jobId?: string;
  agentId?: string;
}

let remembered: Remembered = {};

function remember(patch: Remembered): void {
  remembered = { ...remembered, ...patch };
}

/** The last thing explicitly opened. Consulted only when the hash is silent. */
export function recall(): Remembered {
  return remembered;
}

/**
 * Say which project is highlighted — the one the Project screen's list shows selected,
 * or the one an Agent screen is showing. Files opens on it (Amendment 44) when the route
 * names no project of its own (Amendment 91), so what you were looking at is what you
 * get, not the first project in the list. Choosing a project inside Files says so too,
 * so the two never disagree about which project is "this one".
 */
export function highlight(projectId: string): void {
  if (remembered.projectId !== projectId) remember({ projectId });
}

// ── destinations ────────────────────────────────────────────────────────────

export function openProject(projectId: string): void {
  remember({ projectId });
  navigate(SCREEN.project, { projectId });
}

export function openAgent(agent: Pick<Agent, 'id' | 'jobId' | 'projectId'>): void {
  remember({ agentId: agent.id, jobId: agent.jobId, projectId: agent.projectId });
  navigate(SCREEN.agent, { agentId: agent.id });
}

/**
 * Track C's screen. Told which job's worktree to show and, optionally, which file in
 * it — worktree-relative, as Files takes it. A transcript's file names are `<a>`s built
 * with `hrefFor` instead (agent/links.ts); this is for callers that aren't links.
 */
export function openFiles(job: Job | null, projectId?: string, path?: string): void {
  const params: NavParams = {};
  if (job) {
    params['jobId'] = job.id;
    params['projectId'] = job.projectId;
    if (path) params['path'] = path;
    remember({ jobId: job.id, projectId: job.projectId });
  } else if (projectId) {
    params['projectId'] = projectId;
  }
  navigate(SCREEN.files, params);
}

/** Track D's screen. Told which dev server to frame. */
export function openPreview(server: DevServer): void {
  remember({ jobId: server.jobId });
  navigate(SCREEN.preview, { jobId: server.jobId });
}

/**
 * The Branches screen (Amendment 109), on one project's branches. Remembered, so pressing
 * `7` again later comes back to the same project.
 */
export function openBranches(projectId: string): void {
  remember({ projectId });
  navigate(SCREEN.branches, { projectId });
}

/** Track E's queue. */
export function openAttention(): void {
  navigate(SCREEN.attention);
}

/** Track A's spawn screen, optionally pre-aimed at a project. */
export function openSpawn(project?: Project | null): void {
  navigate(SCREEN.spawn, project ? { projectId: project.id } : {});
}
