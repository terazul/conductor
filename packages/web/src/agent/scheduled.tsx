/**
 * Messages to this agent that wait for a time (Amendment 111): the list above the message
 * box, and the row that picks the time.
 *
 * Each waiting one says when, in your local time and how long from now, and can be
 * cancelled. One that couldn't be sent when it came due (the agent had reached its budget)
 * stays, in the failure colour, with the reason, until you clear it: it is never tried
 * again by itself.
 *
 * One queued for when the agent is done (Amendment 155) says **⏲ when done** instead of a
 * time, and what it is waiting for: this turn to end, or, while the agent is stopped on a
 * question, a failure or a pause, that it is waiting through it. Several go one per turn.
 */

import { useMemo, useState } from 'react';
import type { AgentStatus, ScheduledMessage } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { useAgent, useScheduled } from '../lib/store.js';
import { useNow } from '../shell/clock.js';
import { fmtIn, fmtWhen, fromLocalInput, nextHour, toLocalInput, tomorrowMorning, whenProblem } from '../lib/when.js';
import { cancelScheduled } from './endpoints.js';

/** This agent's scheduled messages, soonest first. */
export function useAgentScheduled(agentId: string): ScheduledMessage[] {
  const all = useScheduled();
  return useMemo(() => all.filter((m) => m.agentId === agentId), [all, agentId]);
}

/**
 * Why "⏲ when done" is not offered for an agent at this status, or null when it is (Amendment
 * 155): one that is done or stopped has no turn left to end. The daemon refuses the same.
 */
export function whenDoneRefusal(status: AgentStatus): string | null {
  if (status === 'done') return 'It has finished its turn: send the message now';
  if (status === 'stopped') return 'It was stopped, so no turn of its will end: send the message now';
  return null;
}

/**
 * What a message queued for when the agent is done is waiting for, at the agent's status.
 * `first` is the next to go; the ones behind it wait for its turn. A question, a failure or a
 * pause aren't done, so it says it is waiting through them.
 */
export function whenDoneWaits(status: AgentStatus | undefined, first: boolean): string {
  if (!first) return 'after the one before it';
  switch (status) {
    case 'working':
      return 'when this turn ends';
    case 'queued':
      return 'after its next turn';
    case 'blocked':
      return 'waiting: it asked you something';
    case 'failed':
      return 'waiting: it failed, and goes after a turn that ends done';
    case 'paused':
      return 'waiting: it is paused';
    default:
      return 'at its next turn that ends done';
  }
}

const firstLine = (text: string): string => {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};

export function ScheduledList({ agentId }: { agentId: string }) {
  const items = useAgentScheduled(agentId);
  const status = useAgent(agentId)?.status;
  const firstDone = items.find((m) => m.trigger === 'done' && !m.error)?.id;
  const now = new Date(useNow(30_000));
  const [why, setWhy] = useState<string | null>(null);
  // Which rows are open to their full text (Amendment 118). A row shows one line until clicked.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  if (items.length === 0) return null;
  return (
    <div className="ag-sched" aria-label="scheduled messages">
      {items.map((m) => (
        <div key={m.id} className="ag-sched-item">
        <div className={`ag-sched-row${m.error ? ' is-failed' : ''}${open.has(m.id) ? ' is-open' : ''}`}>
          <button
            type="button"
            className="ag-sched-open"
            aria-expanded={open.has(m.id)}
            title={open.has(m.id) ? 'Hide the message' : 'Show the whole message'}
            onClick={() => toggle(m.id)}
          >
            <span className="ag-sched-chev" aria-hidden="true">{open.has(m.id) ? '▾' : '▸'}</span>
            <span className="ag-sched-when">
              {m.trigger === 'done' ? '⏲ when done' : `⏲ ${fmtWhen(m.at, now)}`}
              {!m.error && (
                <span className="ag-sched-in">
                  {' · '}
                  {m.trigger === 'done' ? whenDoneWaits(status, m.id === firstDone) : fmtIn(m.at, now)}
                </span>
              )}
            </span>
            <span className="ag-sched-text">{m.error ? `couldn't send: ${m.error}` : firstLine(m.text)}</span>
          </button>
          <button
            type="button"
            className="ag-sched-x"
            aria-label={m.error ? 'clear it' : 'cancel it'}
            title={m.error ? 'Clear it' : 'Cancel: it will not be sent'}
            onClick={() => {
              setWhy(null);
              cancelScheduled(m.id).catch((err: unknown) => setWhy(errorText(err)));
            }}
          >
            ✕
          </button>
        </div>
        {open.has(m.id) && (
          <div className="ag-sched-full" role="region" aria-label="the scheduled message">
            <div className="ag-sched-meta">
              {m.trigger === 'done' ? 'to be sent when it is done · queued' : `to be sent ${fmtWhen(m.at, now)} · scheduled`}{' '}
              {fmtWhen(m.createdAt, now)}
            </div>
            <div className="ag-sched-body">{m.text}</div>
          </div>
        )}
        </div>
      ))}
      {why && <div className="ag-sched-row is-failed">{why}</div>}
    </div>
  );
}

/**
 * The time picker under the message box: a local date and time, two quick picks, and
 * "schedule". `onSchedule` gets the ISO instant; the composer sends it with what's typed.
 */
export function LaterRow({
  busy,
  hasText,
  onSchedule,
  onClose,
}: {
  busy: boolean;
  hasText: boolean;
  onSchedule: (iso: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => toLocalInput(nextHour(new Date())));
  const now = new Date(useNow(30_000));
  const problem = whenProblem(value, now) ?? (hasText ? null : 'write the message first');
  const iso = fromLocalInput(value);
  return (
    <div className="ag-later" role="group" aria-label="send later">
      <span className="ui-lab">send at</span>
      <input
        type="datetime-local"
        className="ag-later-at"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="when to send it, your local time"
      />
      <button type="button" className="ag-pill" onClick={() => setValue(toLocalInput(new Date(Date.now() + 60 * 60_000)))}>
        in 1 h
      </button>
      <button type="button" className="ag-pill" onClick={() => setValue(toLocalInput(tomorrowMorning(new Date())))}>
        tomorrow 09:00
      </button>
      <button
        type="button"
        className="fl-btn is-primary"
        disabled={busy || problem !== null || !iso}
        title={problem ?? (iso ? `sends ${fmtWhen(iso, now)}` : undefined)}
        onClick={() => iso && onSchedule(iso)}
      >
        {busy ? 'scheduling…' : 'schedule'}
      </button>
      <span className="ui-lab">{problem ?? (iso ? `${fmtWhen(iso, now)} · ${fmtIn(iso, now)}` : '')}</span>
      <button type="button" className="ag-sched-x" aria-label="close" title="Close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
