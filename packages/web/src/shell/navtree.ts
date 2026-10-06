/**
 * The project navigator's tree, and which of its nodes are open.  TRACK B.  (Amendment 66)
 *
 * The navigator is the shell's left panel, on every screen (Navigator.tsx). Each project
 * has three submenus: its agents, what in it waits on you, and its folders. This file
 * decides what those hold and in what order, and which nodes are open; the panel only
 * draws it.
 *
 * Nothing here is new judgement. The agents come from `agentTabs`, so the panel and the
 * Agent screen's tabs agree on order, labels and what needs you (Amendment 49). A
 * project's count is `projectNeeds`, the rule the projects list marked rows by
 * (Amendment 43). A folder opens Files by `dirRoot` (Amendment 39), and a waiting item
 * opens Needs you by the `requestId` / `alertId` deep link it already reads.
 *
 * OPEN STATE IS A SET OF NODE IDS, `p:<id>` for a project and `p:<id>:agents`,
 * `p:<id>:needs`, `p:<id>:files` for its submenus. Each opens and closes on its own:
 * toggling one never touches another, in that project or any other. The set is kept in
 * the settings file as a JSON array (`conductor.navTree`), so it is the same after a
 * reload and in every browser; whether the panel is up at all is `conductor.navOpen`.
 *
 * AGENTS ARE GROUPED BY JOB (Amendment 86), newest job first, each group headed by the
 * job's prompt on one line, its agent count, its unhappiest agent's dot and what in it
 * waits on you. A group is `p:<id>:job:<jobId>` (`navJobId`), and it is the one node that
 * starts OPEN: its id in the set means you closed it (`jobShown`). A new job's agents
 * show without a click, and a project with one job still gets its heading, so the rows
 * never change shape as a second job starts. Helpers sit in their job like any agent;
 * they aren't nested under the agent that made them.
 *
 * PROJECTS COME IN THE FLEET'S ORDER (Amendment 69). `navProjects` reads the Fleet's two
 * settings, `conductor.fleetSort` and `conductor.fleetOrder`, through the very functions
 * the Fleet uses (`fleetSort`, `sortFacts`, `sortProjects`), and `navTree` keeps the
 * order it is given. So the panel follows the Fleet's Sort by, and changes when it does.
 * Dragging a project in the panel is a Fleet drag: `navDrop` is your order with it moved
 * (`moveBefore`), and the sort switches to `mine`.
 *
 * Pure: no DOM, no React, no storage. shell/verify.ts runs these under Node.
 */

import type { Agent, AgentStatus, Alert, Job, PendingRequest, Project } from '@conductor/shared';
import { agentTabs } from '../agent/tabs.js';
import { requestTitle } from '../attention/describe.js';
import { dirRoot } from '../files/tabs.js';
import { alertTitle, projectNeeds } from './describe.js';
import { SORT_RANK, fleetSort, moveBefore, parseOrder, sortFacts, sortProjects, type FleetSort } from '../fleet/order.js';

/** Which nodes are open: a JSON array of node ids. */
export const NAV_TREE_KEY = 'conductor.navTree';
/** `'hidden'` when the panel is put away; absent when it's up. */
export const NAV_OPEN_KEY = 'conductor.navOpen';
/** The Agent screen's inspector, the one right panel (F18). The same key its own button writes. */
export const DETAILS_KEY = 'conductor.agentDetails';

// ── the tree ────────────────────────────────────────────────────────────────

export interface NavAgent {
  id: string;
  jobId: string;
  label: string;
  /** Blocked when something waits on you, whatever the agent's own status says. */
  status: AgentStatus;
  needs: number;
}

/** One job's agents in a project (Amendment 86). */
export interface NavJob {
  id: string;
  /** The job's prompt on one line; the job id when the job isn't known. */
  label: string;
  agents: NavAgent[];
  /** Its unhappiest agent's, by the Fleet's SORT_RANK, so a closed group still shows a failure. */
  status: AgentStatus;
  /** What waits on you across its agents. */
  needs: number;
  /** It finished and you haven't seen it (Amendment 87). */
  finished: boolean;
}

export interface NavNeed {
  key: string;
  label: string;
  /** What `navigate('attention', …)` is given, so Needs you opens on this one. */
  params: { requestId: string } | { alertId: string };
}

export interface NavFolder {
  /** As it is on disk. */
  dir: string;
  /** Its last segment, which is what fits. */
  name: string;
  /** The project's own folder, where its agents start. */
  main: boolean;
  /** What `navigate('files', { jobId })` is given (Amendment 39). */
  root: string;
}

export interface NavProject {
  id: string;
  name: string;
  /** Requests and alerts waiting on you here. Above zero, the Needs you heading is amber. */
  needs: number;
  agents: NavAgent[];
  /** The same agents, grouped by job, in the same order (Amendment 86). */
  jobs: NavJob[];
  needsRows: NavNeed[];
  folders: NavFolder[];
}

/** A folder's last segment, so `~/src/app/` reads `app`. */
export function folderName(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/** Main first, then the referenced ones in the order they were added; each once. */
export function projectFolders(project: Pick<Project, 'id' | 'path' | 'extraDirs'>): NavFolder[] {
  const seen = new Set<string>();
  const out: NavFolder[] = [];
  for (const dir of [project.path, ...(project.extraDirs ?? [])]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, name: folderName(dir), main: dir === project.path, root: dirRoot(project.id, dir) });
  }
  return out;
}

/**
 * Every project's node, in the order the projects come. Requests come before alerts, as
 * on the rail: a request is what ⏎ answers, and each kind is already in its own order
 * (`usePending` oldest first, alerts as the daemon sends them).
 *
 * `jobs` orders the agents, newest job first as on the Agent screen's tabs, and heads
 * their groups with its prompt. Without it the agents keep the order they were given in,
 * and each group is headed by its job id. `finished` is the jobs that finished and you
 * haven't seen (lib/seen.ts); their groups say so.
 */
export function navTree(
  projects: Pick<Project, 'id' | 'name' | 'path' | 'extraDirs'>[],
  agents: Agent[],
  pending: PendingRequest[],
  alerts: Alert[],
  jobs: Pick<Job, 'id' | 'createdAt' | 'prompt'>[] = [],
  finished: ReadonlySet<string> = new Set(),
): NavProject[] {
  const jobOrder = [...jobs].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)).map((j) => j.id);

  return projects.map((p) => {
    const tabs = agentTabs(agents, p.id, jobOrder, pending, alerts);
    const label = (agentId: string, role: string): string => tabs.find((t) => t.id === agentId)?.label ?? role;

    const requests: NavNeed[] = pending
      .filter((r) => r.projectId === p.id)
      .map((r) => ({
        key: `r:${r.requestId}`,
        label: `${label(r.agentId, r.agentRole)} · ${requestTitle(r)}`,
        params: { requestId: r.requestId },
      }));
    const stopped: NavNeed[] = alerts
      .filter((a) => a.projectId === p.id)
      .map((a) => {
        const t = alertTitle(a, agents);
        return { key: `a:${a.id}`, label: t.subject ? `${t.head} ${t.subject}` : t.head, params: { alertId: a.id } };
      });

    const rows: NavAgent[] = tabs.map((t) => ({
      id: t.id,
      jobId: agents.find((a) => a.id === t.id)?.jobId ?? '',
      label: t.label,
      status: t.status,
      needs: t.needs,
    }));

    return {
      id: p.id,
      name: p.name,
      needs: projectNeeds(p.id, pending, alerts),
      agents: rows,
      jobs: groupByJob(rows, jobs, finished),
      needsRows: [...requests, ...stopped],
      folders: projectFolders(p),
    };
  });
}

/**
 * The rows grouped by job, each group where its first agent is, so the groups come in the
 * order the agents do (`agentTabs` already puts a job's agents together).
 */
export function groupByJob(
  rows: readonly NavAgent[],
  jobs: readonly Pick<Job, 'id' | 'prompt'>[],
  finished: ReadonlySet<string> = new Set(),
): NavJob[] {
  const out = new Map<string, NavJob>();
  for (const a of rows) {
    let g = out.get(a.jobId);
    if (!g) {
      const prompt = jobLine(jobs.find((j) => j.id === a.jobId)?.prompt ?? '');
      g = {
        id: a.jobId,
        label: prompt || a.jobId,
        agents: [],
        status: a.status,
        needs: 0,
        finished: finished.has(a.jobId),
      };
      out.set(a.jobId, g);
    }
    g.agents.push(a);
    g.needs += a.needs;
    if (SORT_RANK[a.status] < SORT_RANK[g.status]) g.status = a.status;
  }
  return [...out.values()];
}

/** A prompt as one line: its whitespace, newlines included, folded to single spaces. */
export function jobLine(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}

// ── the Fleet's order (Amendment 69) ────────────────────────────────────────

/**
 * The projects as the Fleet shows them, from the raw `conductor.fleetSort` and
 * `conductor.fleetOrder` values: the sort in use (`fleetSort`), then `sortProjects` over
 * the facts `sortFacts` builds from the same agents and requests. Nothing here is the
 * panel's own; the Fleet's grid is this same call.
 */
export function navProjects<P extends { id: string; name: string; createdAt: string }>(
  projects: readonly P[],
  rawSort: string | null,
  rawOrder: string | null,
  agents: Parameters<typeof sortFacts>[1],
  pending: Parameters<typeof sortFacts>[2],
): P[] {
  const order = parseOrder(rawOrder);
  return sortProjects(projects, fleetSort(rawSort, order), order, sortFacts(projects, agents, pending));
}

/**
 * What dropping `dragged` on `target` writes, as a Fleet drag does: your order with it
 * just before the target (null target: at the end), and the sort switched to yours,
 * since that is the only order a drag can mean. Null when there is nothing to move.
 */
export function navDrop(
  shown: readonly { id: string }[],
  dragged: string,
  target: string | null,
): { order: string[]; sort: FleetSort } | null {
  if (dragged === target || !shown.some((p) => p.id === dragged)) return null;
  return { order: moveBefore(shown, dragged, target), sort: 'mine' };
}

// ── which nodes are open ────────────────────────────────────────────────────

export type NavPart = 'agents' | 'needs' | 'files';

/** A project's node id, or one of its submenus'. */
export function navId(projectId: string, part?: NavPart): string {
  return part ? `p:${projectId}:${part}` : `p:${projectId}`;
}

/** A job's group under a project's Agents (Amendment 86). */
export function navJobId(projectId: string, jobId: string): string {
  return `p:${projectId}:job:${jobId}`;
}

/** A job's group starts open: its id in the set means it was closed. */
export function jobShown(open: ReadonlySet<string>, id: string): boolean {
  return !open.has(id);
}

/** The stored set. Nothing stored, or anything that isn't an array of strings, is nothing open. */
export function parseOpen(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** A new set with `id` flipped and everything else as it was. */
export function toggleOpen(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function isOpen(open: ReadonlySet<string>, id: string): boolean {
  return open.has(id);
}

/** What to store: null, which removes the key, when nothing is open. */
export function serializeOpen(open: ReadonlySet<string>): string | null {
  return open.size === 0 ? null : JSON.stringify([...open]);
}

// ── the panels, and the top bar's icons ─────────────────────────────────────

/** The navigator is up unless it was put away. */
export function navShown(raw: string | null): boolean {
  return raw !== 'hidden';
}

/** The setting the right-panel icon toggles on this screen; null where there is no right panel. */
export function rightPanelFor(screenId: string): string | null {
  return screenId === 'agent' ? DETAILS_KEY : null;
}

/** As the Agent screen reads it: shown unless hidden. */
export function detailsShown(raw: string | null): boolean {
  return raw !== 'hidden';
}

/**
 * The project the navigator highlights: the one the hash names, or the open agent's,
 * else the last one explicitly opened (`recall`, Amendment 44).
 */
export function currentProject(
  route: { id: string; params: Record<string, string> },
  agents: Pick<Agent, 'id' | 'projectId'>[],
  remembered: string | undefined,
): string | undefined {
  const named = route.params['projectId'];
  if (named) return named;
  const agentId = route.id === 'agent' ? route.params['agentId'] : undefined;
  const owner = agentId ? agents.find((a) => a.id === agentId)?.projectId : undefined;
  return owner ?? remembered;
}
