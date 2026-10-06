/**
 * Project-level commands.  TRACK B.
 *
 * Same arrangement as `agent/endpoints.ts`: the paths are Track A's
 * (`routes/session.ts`), so they are collected in one file per screen family and
 * never spelled out inside a component. Commands go through `api()` from
 * lib/feed.ts so bearer auth stays in one place.
 */

import type { Project, ProjectNote } from '@conductor/shared';
import { api } from '../lib/feed.js';

/*
 * `DELETE /api/projects/:projectId` is Track A's route, and its wrapper is Track A's
 * (spawn/endpoints.ts). This file used to hold a second, identical copy of both the
 * function and `ProjectRemoval`; two copies of a response type drift the first time
 * one of them gains a field. Re-exported, read-only, the way `useCommand` is shared.
 */
export { removeProject, type ProjectRemoval } from '../spawn/endpoints.js';

/**
 * Edit a project's name and/or path.
 *
 * Send only what changed — the daemon treats the body as a partial, so omitting
 * `path` leaves it alone rather than clearing it. Also not in `wire.ts`, for
 * Amendment 2's reason: a body for one form is not a cross-track contract.
 */
export function editProject(
  projectId: string,
  patch: { name?: string; path?: string },
): Promise<{ project: Project }> {
  return api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: patch });
}

/**
 * Give a project another directory (Amendment 39). The daemon expands `~` and resolves
 * the path; `existing` is true when the project already had it — not an error.
 */
export function addProjectDir(
  projectId: string,
  path: string,
): Promise<{ project: Project; existing: boolean }> {
  return api(`/api/projects/${encodeURIComponent(projectId)}/dirs`, {
    method: 'POST',
    body: { path },
  });
}

/** Forget one of a project's directories. Conductor only — the folder is not touched. */
export function removeProjectDir(projectId: string, path: string): Promise<{ project: Project }> {
  return api(
    `/api/projects/${encodeURIComponent(projectId)}/dirs?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
}

/**
 * Add a project: its main folder, a name, and its referenced folders, in one request
 * (Amendment 45). `existing` is true when a project already has that main folder — then
 * nothing was added or changed.
 */
export function createProject(body: {
  path: string;
  name?: string;
  dirs?: string[];
}): Promise<{ project: Project; existing: boolean }> {
  return api('/api/projects', { method: 'POST', body });
}

// ── notes (Amendment 55) ────────────────────────────────────────────────────

const notesOf = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/notes`;

export function addNote(projectId: string, text: string, due: string | null = null): Promise<{ note: ProjectNote; project: Project }> {
  return api(notesOf(projectId), { method: 'POST', body: { text, ...(due ? { due } : {}) } });
}

/** Change what's given: text, due (null clears it), done (Amendment 63). */
export function editNote(
  projectId: string,
  noteId: string,
  patch: { text?: string; due?: string | null; done?: boolean },
): Promise<{ note: ProjectNote; project: Project }> {
  return api(`${notesOf(projectId)}/${encodeURIComponent(noteId)}`, { method: 'PATCH', body: patch });
}

export function removeNote(projectId: string, noteId: string): Promise<{ project: Project }> {
  return api(`${notesOf(projectId)}/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}
