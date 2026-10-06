/**
 * The always-on notifier.
 *
 * Track E owns this file. Mounted by `main.tsx` from the `./＊/always.tsx` glob
 * (Amendment 1), once for the life of the tab, outside the shell.
 *
 * It exists because the notification ladder used to live inside screen 4, which
 * meant the tab badge stopped counting the moment the user pressed `1` for
 * Fleet — precisely when a badge is the only thing that can reach them.
 *
 * Renders `null`. Nothing here is visual: the badge is the tab title and the
 * favicon, the notification is the OS's, the chime is audio. Per the contract
 * this component sits outside the shell's layout flow, so returning markup would
 * put it in the wrong place; when this grows a toast it must be a fixed-position
 * portal, not flow content.
 *
 * Cheap on purpose — it re-renders on every store change. The body does no work
 * beyond reading `pending`; all three rungs are effects keyed on what actually
 * changes, and the clock only ticks while something is waiting.
 *
 * It also says when a job has finished (Amendment 87): the badge counts it until
 * you've seen it, and a desktop notification takes you to its project. Opening one
 * of its agents marks it seen here, since this is the one place that is always
 * mounted; the Project screen marks its own project's jobs (fleet/project.tsx).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlwaysOnDef } from '../lib/screens.js';
import { currentRoute, navigate, onNavigate } from '../lib/nav.js';
import { markJobsSeen, seenOnAgent, startSeenOnce, useTabVisible, useUnseenJobs } from '../lib/seen.js';
import { useAgents, useAlerts, useJobs, usePending, useProjects } from '../lib/store.js';
import { openProject, recall, SCREEN as SHELL } from '../shell/nav.js';
import { jobLine } from '../shell/navtree.js';
import { alertNotice } from './alerts.js';
import { useLadderEffects, type LadderAlert, type LadderFinished, type LadderTarget } from './notify.js';
import { useNow } from './useNow.js';

/** Must match the `screen.id` exported from ./route.tsx. */
const SCREEN = 'attention';

function Notifier() {
  const pending = usePending();
  const rawAlerts = useAlerts();
  const agents = useAgents();
  const projects = useProjects();
  const jobs = useJobs();
  const unseen = useUnseenJobs();
  const visible = useTabVisible();
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => onNavigate((id, params) => setRoute({ id, params })), []);
  // Ticks only while a request is waiting; the ladder needs it to notice one
  // crossing 60s (chime) and 12m (the badge turns red). Alerts don't age.
  const now = useNow(pending.length > 0);

  // Worded here, where the names are, so the ladder only has to show them.
  const alerts: LadderAlert[] = useMemo(
    () => rawAlerts.map((a) => ({ id: a.id, ...alertNotice(a, agents, projects) })),
    [rawAlerts, agents, projects],
  );

  // First load after Amendment 87: what has already finished counts as seen.
  useEffect(() => startSeenOnce(), []);

  const finished: LadderFinished[] = useMemo(
    () =>
      unseen.map((j) => {
        const name = projects.find((p) => p.id === j.projectId)?.name ?? 'A project';
        return {
          key: `job:${j.id}:${j.endedAt ?? ''}`,
          title: `${name} · ${j.status === 'failed' ? 'job ended with a failure' : 'job finished'}`,
          body: jobLine(j.prompt),
          projectId: j.projectId,
        };
      }),
    [unseen, projects],
  );

  // Looking at one of a finished job's agents is seeing it — while the tab is in front.
  const onAgent = route.id === SHELL.agent ? (route.params['agentId'] ?? recall().agentId) : undefined;
  useEffect(() => {
    if (!visible) return;
    markJobsSeen(seenOnAgent(onAgent, agents, unseen), jobs);
  }, [visible, onAgent, agents, unseen, jobs]);

  /**
   * A clicked notification takes you to the request it was about (Amendment 3).
   * Focusing the tab but leaving the user on Fleet is the kind of half-working
   * that teaches people to ignore notifications — which would undo the point of
   * having them. `navigate` works from here despite this being a separate React
   * tree, because `main.tsx` drives the active screen off `hashchange`.
   */
  const activate = useCallback((target: LadderTarget) => {
    if ('projectId' in target) openProject(target.projectId);
    else navigate(SCREEN, target);
  }, []);

  // The single owner of the tab title, the favicon and the chime. Screen 4
  // deliberately does not run these — see notify.ts.
  useLadderEffects(pending, alerts, now, activate, finished);

  return null;
}

export const alwaysOn: AlwaysOnDef = {
  id: 'attention-notify',
  Component: Notifier,
};
