/**
 * Talking back to an agent.  TRACK B.
 *
 * Commands go out through `api()` from lib/feed.ts and nowhere else, so bearer
 * auth stays in one place.
 *
 * THE ROUTES ARE TRACK A'S. `routes/session.ts` owns /api/agents/*, and
 * shared/src/wire.ts freezes the request bodies (`SendMessageRequest`,
 * `SetAutonomyRequest`) but not the paths. They are collected here so that when
 * Track A lands there is exactly one file to reconcile, and a rename never
 * reaches into a component.
 *
 * Until then every one of these 404s, which is expected rather than exceptional:
 * `useCommand` turns a failure into an inline notice next to the control that
 * caused it and keeps whatever the user typed. Nothing throws into render.
 */

import { useCallback, useState } from 'react';
import { api } from '../lib/feed.js';
import { explain, type Notice } from '../lib/errors.js';
import type {
  Agent,
  SendMessageRequest,
  SetAutonomyRequest,
  SetModelRequest,
  SetModelResponse,
} from '@conductor/shared';

const agentPath = (agentId: string, verb: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/${verb}`;

export function sendMessage(agentId: string, body: SendMessageRequest): Promise<unknown> {
  return api(agentPath(agentId, 'message'), { method: 'POST', body });
}

export function interruptAgent(agentId: string): Promise<unknown> {
  return api(agentPath(agentId, 'interrupt'), { method: 'POST', body: {} });
}

/**
 * Stop an agent temporarily. Resumable — `resumeAgent` picks it back up.
 *
 * Wired in the daemon and documented in the manual since I1, and until now unreachable
 * from the UI: an endpoint with no button is a feature nobody has.
 */
export function pauseAgent(agentId: string): Promise<unknown> {
  return api(agentPath(agentId, 'pause'), { method: 'POST', body: {} });
}

export function resumeAgent(agentId: string): Promise<unknown> {
  return api(agentPath(agentId, 'resume'), { method: 'POST', body: {} });
}

/**
 * End an agent for good. NOT a delete: the transcript, the spend and every file it
 * wrote all stay exactly where they are — it just stops, and does not come back.
 */
export function terminateAgent(agentId: string): Promise<{ agent: Agent }> {
  return api(agentPath(agentId, 'terminate'), { method: 'POST', body: {} });
}

/** The same, for every unfinished agent in a job. */
export function terminateJob(jobId: string): Promise<{ agents: Agent[] }> {
  return api(`/api/jobs/${encodeURIComponent(jobId)}/terminate`, { method: 'POST', body: {} });
}

/**
 * Remove an agent from Conductor — the row, so it leaves the screen.
 *
 * Terminate ends the work and leaves the lane reading `stopped`, which is what you want
 * while you still care what it did. This is for afterwards. It terminates first, so it is
 * safe on a live agent, and it touches nothing on disk.
 */
export function removeAgent(agentId: string): Promise<{ removed: string }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

/** The same for a job: its agents go with it. */
export function removeJob(jobId: string): Promise<{ removed: string }> {
  return api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

export function setAutonomy(agentId: string, body: SetAutonomyRequest): Promise<unknown> {
  return api(agentPath(agentId, 'autonomy'), { method: 'POST', body });
}

/** Unlike autonomy, this can reach a live run — `appliesTo` says whether it did. */
export function setModel(agentId: string, body: SetModelRequest): Promise<SetModelResponse> {
  return api(agentPath(agentId, 'model'), { method: 'POST', body });
}

/*
 * The error explainer lives in lib/errors.ts now, beside the `ApiError` it reads, so
 * every screen translates a failure the same way. Re-exported so the screens that
 * import `Notice` from here keep working.
 */
export type { Notice } from '../lib/errors.js';

export interface CommandHandle {
  busy: boolean;
  notice: Notice | null;
  /**
   * Run a command. Resolves true on success, false on failure — never throws. `okText`
   * can read the answer, for commands whose effect depends on it; an empty one says
   * nothing.
   */
  run: {
    (label: string, fn: () => Promise<unknown>, okText?: string): Promise<boolean>;
    <T>(label: string, fn: () => Promise<T>, okText: (result: T) => string): Promise<boolean>;
  };
  dismiss: () => void;
}

export function useCommand(): CommandHandle {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, okText?: string | ((result: never) => string)) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await fn();
        const text = typeof okText === 'function' ? okText(result as never) : okText;
        if (text) setNotice({ tone: 'ok', text });
        return true;
      } catch (err) {
        setNotice(explain(label, err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, notice, run, dismiss: () => setNotice(null) };
}
