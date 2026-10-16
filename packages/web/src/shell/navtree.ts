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
 * `p:<id>:needs`, `p:<id>:files` for its submenus, `p:<id>:fold:<agentId>` for a fold. Each opens and closes on its own:
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
 * ONCE AN ORCHESTRATOR HAS ENDED, ITS ENDED HELPERS FOLD (Amendment 169) into one row right
 * after it, "↳ 12 helpers · all done" (`foldHelpers`, on the Project screen's `nestHelpers`).
 * A helper still going, or one that waits on you, stays out, so nothing you're needed for is
 * hidden. A fold is `p:<id>:fold:<orchestratorId>` (`navFoldId`) and starts closed. Display
 * only: every helper is still in `agents` and in its job's `agents`.
 *
 * PROJECTS COME IN THE FLEET'S ORDER (Amendment 69). `navProjects` reads the Fleet's two
 * settings, `conductor.fleetSort` and `conductor.fleetOrder`, through the very functions
 * the Fleet uses (`fleetSort`, `sortFacts`, `sortProjects`), and `navTree` keeps the
 * order it is given. So the panel follows the Fleet's Sort by, and changes when it does.
 * Dragging a project in the panel is a Fleet drag: `navDrop` is your order with it moved
 * (`moveBefore`), and the sort switches to `mine`.
 *
 * EACH AGENT ROW HAS ITS BUDGET METER (Amendment 140): the thin bar the Fleet lane draws
 * (`budgetOf`, autonomy.ts:97; tones from spend.ts:30), and a job's heading the sum of its
 * agents' (`sumBudgets`). An agent with no budget, or a job none of whose agents has one,
 * has no bar at all.
 *
 * Pure: no DOM, no React, no storage. shell/verify.ts runs these under Node.
 */

import type { Agent, AgentStatus, Alert, Job, PendingRequest, Project } from '@conductor/shared';
import { agentTabs } from '../agent/tabs.js';
import { nestHelpers } from '../fleet/nest.js';
import { requestTitle } from '../attention/describe.js';
import { dirRoot } from '../files/tabs.js';
import { alertTitle, projectNeeds } from './describe.js';
import { budgetOf, budgetWords, sumBudgets, type Budget } from './autonomy.js';
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
  /** Done, and you haven't opened it since (Amendment 105). */
  finished: boolean;
  /**
   * The orchestrator of an orchestrated stack (Amendment 142): the Agent tab's own answer,
   * `marksOrchestrator` (agent/tabs.ts:76), so the two can't disagree.
   */
  orchestrator: boolean;
  /** Today's spend against its own daily budget, as the Fleet lane's meter; null for none (Amendment 140). */
  budget: Budget | null;
}

/**
 * An ended orchestrator's ended helpers, as one row under it (Amendment 169). Its node is
 * `navFoldId(projectId, orchestratorId)`.
 */
export interface NavFold {
  orchestratorId: string;
  /** In the order the job's rows have them. */
  helpers: NavAgent[];
  /** "↳ 12 helpers · all done", or "↳ 5 helpers · 4 done, 1 failed" (`foldLabel`). */
  label: string;
  /** The worst inside, by the Fleet's SORT_RANK, as a job's is. */
  status: AgentStatus;
  /** One of them finished and you haven't opened it (Amendment 105). */
  finished: boolean;
}

/** What a job's group draws, in order: an agent's row, or a fold of helpers. */
export type NavRow = { kind: 'agent'; agent: NavAgent } | { kind: 'fold'; fold: NavFold };

/** One job's agents in a project (Amendment 86). */
export interface NavJob {
  id: string;
  /** The job's prompt on one line; the job id when the job isn't known. */
  label: string;
  /** Every one of them, folded or not. */
  agents: NavAgent[];
  /** What the group draws: `agents`, with each ended orchestrator's ended helpers folded (Amendment 169). */
  rows: NavRow[];
  /** Its unhappiest agent's, by the Fleet's SORT_RANK, so a closed group still shows a failure. */
  status: AgentStatus;
  /** What waits on you across its agents. */
  needs: number;
  /** It finished and you haven't seen it (Amendment 87). */
  finished: boolean;
  /** Its agents' budgets summed (`sumBudgets`); null when none of them has one (Amendment 140). */
  budget: Budget | null;
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
 * haven't seen (lib/seen.ts); their groups say so. `finishedAgents` is the done agents you
 * haven't opened since they ended (Amendment 105); their rows say so.
 */
export function navTree(
  projects: Pick<Project, 'id' | 'name' | 'path' | 'extraDirs'>[],
  agents: Agent[],
  pending: PendingRequest[],
  alerts: Alert[],
  jobs: Pick<Job, 'id' | 'createdAt' | 'prompt'>[] = [],
  finished: ReadonlySet<string> = new Set(),
  finishedAgents: ReadonlySet<string> = new Set(),
  /** The day the meters read; this browser's unless a check says. */
  today?: string,
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

    const rows: NavAgent[] = tabs.map((t) => {
      const agent = agents.find((a) => a.id === t.id);
      return {
        id: t.id,
        jobId: agent?.jobId ?? '',
        label: t.label,
        status: t.status,
        needs: t.needs,
        finished: t.status === 'done' && finishedAgents.has(t.id),
        orchestrator: t.orchestrator,
        budget: agent ? budgetOf(agent, today) : null,
      };
    });

    return {
      id: p.id,
      name: p.name,
      needs: projectNeeds(p.id, pending, alerts),
      agents: rows,
      jobs: groupByJob(rows, jobs, finished).map((j) => ({ ...j, rows: foldHelpers(j.agents, agents) })),
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
        rows: [],
        status: a.status,
        needs: 0,
        finished: finished.has(a.jobId),
        budget: null,
      };
      out.set(a.jobId, g);
    }
    g.agents.push(a);
    g.needs += a.needs;
    if (SORT_RANK[a.status] < SORT_RANK[g.status]) g.status = a.status;
  }
  for (const g of out.values()) {
    g.budget = sumBudgets(g.agents.map((a) => a.budget ?? null));
    g.rows = g.agents.map((agent) => ({ kind: 'agent', agent }));
  }
  return [...out.values()];
}

/** An agent that has ended, as `rerun.ts` and the Project screen count it. */
const ENDED: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);

/**
 * One job's rows, with each ended orchestrator's ended helpers folded into one row right
 * after it (Amendment 169). Whose helper is whose is `nestHelpers`, the Project screen's
 * nesting: an orchestrator's helpers, theirs included, follow it. Its own status decides
 * whether it has ended, so an orchestrator whose failure waits on you still folds. A helper
 * folds only when it has ended and nothing waits on it; the others keep their rows and
 * their places. A fold holds two or more: one helper would be a row for a row.
 */
export function foldHelpers(rows: readonly NavAgent[], agents: readonly Agent[]): NavRow[] {
  const mine = rows.map((r) => agents.find((a) => a.id === r.id)).filter((a): a is Agent => a !== undefined);
  const row = new Map(rows.map((r) => [r.id, r]));
  const folds = new Map<string, NavAgent[]>();
  const into = new Map<string, string>();
  let head: Agent | null = null;
  let kept: NavAgent[] = [];
  const close = (): void => {
    if (head && kept.length >= 2) {
      folds.set(head.id, kept);
      for (const h of kept) into.set(h.id, head.id);
    }
  };
  for (const { agent, helperOf } of nestHelpers(mine)) {
    if (helperOf === null) {
      close();
      head = ENDED.has(agent.status) ? agent : null;
      kept = [];
      continue;
    }
    const r = row.get(agent.id);
    if (head && r && ENDED.has(agent.status) && r.needs === 0) kept.push(r);
  }
  close();

  const out: NavRow[] = [];
  for (const r of rows) {
    if (into.has(r.id)) continue;
    out.push({ kind: 'agent', agent: r });
    const helpers = folds.get(r.id);
    if (!helpers) continue;
    let status = helpers[0]!.status;
    for (const h of helpers) if (SORT_RANK[h.status] < SORT_RANK[status]) status = h.status;
    out.push({
      kind: 'fold',
      fold: { orchestratorId: r.id, helpers, label: foldLabel(helpers.map((h) => h.status)), status, finished: helpers.some((h) => h.finished) },
    });
  }
  return out;
}

/**
 * A fold's words: how many, then "all done" when they are, else each ended status with its
 * count, done first, as "↳ 5 helpers · 4 done, 1 failed".
 */
export function foldLabel(statuses: readonly AgentStatus[]): string {
  const n = statuses.length;
  const head = `↳ ${n} ${n === 1 ? 'helper' : 'helpers'}`;
  const counts = (['done', 'failed', 'stopped'] as const)
    .map((s) => [s, statuses.filter((x) => x === s).length] as const)
    .filter(([, c]) => c > 0);
  if (counts.length === 1) return `${head} · all ${counts[0]![0]}`;
  return `${head} · ${counts.map(([s, c]) => `${c} ${s}`).join(', ')}`;
}

/**
 * What a row's meter says on hover (Amendment 140): today's figure against the budget, in its
 * own unit, and what over means, as the Fleet lane's title says it.
 */
export function meterTitle(b: Budget, whose: string): string {
  const said = (n: number): string => budgetWords(b.unit, n);
  const tail = b.state === 'ok' ? '' : ' — over it; a warning only, nothing stops';
  return `${whose}: ${said(b.spent)} of ${said(b.cap)} today, ${b.pct}%${tail}`;
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
  spent?: Parameters<typeof sortFacts>[3],
): P[] {
  const order = parseOrder(rawOrder);
  return sortProjects(projects, fleetSort(rawSort, order), order, sortFacts(projects, agents, pending, spent));
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

/** An ended orchestrator's fold of helpers (Amendment 169). Starts closed: its id in the set means open. */
export function navFoldId(projectId: string, orchestratorId: string): string {
  return `p:${projectId}:fold:${orchestratorId}`;
}

/**
 * The fold that holds `agentId`, or null when it is in none (Amendment 169). The panel opens
 * it as you arrive on that agent, so the agent you are on isn't hidden behind a closed fold;
 * close it after, and it stays closed.
 */
export function foldOf(tree: readonly NavProject[], agentId: string | undefined): string | null {
  if (!agentId) return null;
  for (const p of tree)
    for (const j of p.jobs)
      for (const r of j.rows)
        if (r.kind === 'fold' && r.fold.helpers.some((h) => h.id === agentId)) return navFoldId(p.id, r.fold.orchestratorId);
  return null;
}

/**
 * One directory's node, inside a Files folder's tree (Amendment 92): the folder itself
 * is `path: ''`, and each directory under it is named by its root-relative path, so a
 * folder opened under two different projects — or two different folders of the same
 * project — never share a node, even when their trees hold a directory of the same name.
 */
export function navDirId(projectId: string, root: string, path: string): string {
  return `p:${projectId}:files:${root}:${path}`;
}

/**
 * What a file row in the navigator's Files tree gives `navigate('files', …)` (Amendment
 * 92): the same shape `applyLink` reads off a `#files` link (`files/tabs.ts:319-336`).
 */
export function navFileLink(root: string, path: string): { jobId: string; path: string } {
  return { jobId: root, path };
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
