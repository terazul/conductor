/**
 * The Agent screen's terminal runs, per agent (Amendment 58): what the daemon sent, kept
 * for every tab. History comes over HTTP when a panel first opens; everything after is
 * `terminal_run` / `terminal_out` frames, which the store hands here.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { TerminalChunk, TerminalRun } from '@conductor/shared';
import { api } from './feed.js';

export type RunView = TerminalRun & { output: TerminalChunk[] };

const runs = new Map<string, RunView[]>();
const cwds = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Put a run in its agent's list, keeping output already received. */
export function mergeRun(list: readonly RunView[], run: TerminalRun): RunView[] {
  const i = list.findIndex((r) => r.id === run.id);
  if (i < 0) return [...list, { ...run, output: [] }];
  const next = [...list];
  next[i] = { ...run, output: list[i]!.output };
  return next;
}

/** Add output to a run, joining a chunk to the last one from the same stream. */
export function appendOutput(list: readonly RunView[], runId: string, chunk: TerminalChunk): RunView[] {
  return list.map((r) => {
    if (r.id !== runId) return r;
    const last = r.output.at(-1);
    const output = last && last.stream === chunk.stream
      ? [...r.output.slice(0, -1), { stream: chunk.stream, text: last.text + chunk.text }]
      : [...r.output, chunk];
    return { ...r, output };
  });
}

export function receiveTerminalRun(run: TerminalRun): void {
  runs.set(run.agentId, mergeRun(runs.get(run.agentId) ?? [], run));
  changed();
}

export function receiveTerminalOut(f: { agentId: string; runId: string } & TerminalChunk): void {
  runs.set(f.agentId, appendOutput(runs.get(f.agentId) ?? [], f.runId, { stream: f.stream, text: f.text }));
  changed();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** An agent's runs and folder; asks the daemon for what ran before, once. */
export function useTerminal(agentId: string): { runs: RunView[]; cwd: string | null } {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (asked.has(agentId)) return;
    asked.add(agentId);
    api<{ cwd: string; runs: RunView[] }>(`/api/agents/${encodeURIComponent(agentId)}/terminal`).then(
      (r) => {
        cwds.set(agentId, r.cwd);
        // Frames that arrived while this was in flight are newer than it.
        let list: RunView[] = r.runs;
        for (const live of runs.get(agentId) ?? []) if (!list.some((x) => x.id === live.id)) list = [...list, live];
        runs.set(agentId, list);
        changed();
      },
      () => asked.delete(agentId),
    );
  }, [agentId]);
  return { runs: runs.get(agentId) ?? [], cwd: cwds.get(agentId) ?? null };
}

export function runCommand(agentId: string, command: string): Promise<{ run: TerminalRun }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}/terminal`, { method: 'POST', body: { command } });
}

export function stopCommand(runId: string): Promise<{ run: TerminalRun }> {
  return api(`/api/terminal/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
}

export async function clearTerminal(agentId: string): Promise<void> {
  await api(`/api/agents/${encodeURIComponent(agentId)}/terminal`, { method: 'DELETE' });
  runs.set(agentId, []);
  changed();
}

// ── words ───────────────────────────────────────────────────────────────────

/** ANSI escapes, which a command runner can't draw. TERM=dumb stops most; this, the rest. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

/** What a run's last line says: still running, its exit, or how it was stopped. */
export function endLine(r: Pick<TerminalRun, 'endedAt' | 'exitCode' | 'signal' | 'cut'>): string {
  const cut = r.cut ? ' · output cut at 256 KB' : '';
  if (r.endedAt === null) return `running…${cut}`;
  if (r.signal) return `stopped (${r.signal})${cut}`;
  return `exit ${r.exitCode ?? '?'}${cut}`;
}
