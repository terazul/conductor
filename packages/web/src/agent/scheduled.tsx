/**
 * Messages to this agent that wait for a time (Amendment 111): the list above the message
 * box, and the row that picks the time.
 *
 * Each waiting one says when, in your local time and how long from now, and can be
 * cancelled. One that couldn't be sent when it came due (the agent had reached its budget)
 * stays, in the failure colour, with the reason, until you clear it: it is never tried
 * again by itself.
 */

import { useMemo, useState } from 'react';
import type { ScheduledMessage } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { useScheduled } from '../lib/store.js';
import { useNow } from '../shell/clock.js';
import { fmtIn, fmtWhen, fromLocalInput, nextHour, toLocalInput, tomorrowMorning, whenProblem } from '../lib/when.js';
import { cancelScheduled } from './endpoints.js';

/** This agent's scheduled messages, soonest first. */
export function useAgentScheduled(agentId: string): ScheduledMessage[] {
  const all = useScheduled();
  return useMemo(() => all.filter((m) => m.agentId === agentId), [all, agentId]);
}

const firstLine = (text: string): string => {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};

export function ScheduledList({ agentId }: { agentId: string }) {
  const items = useAgentScheduled(agentId);
  const now = new Date(useNow(30_000));
  const [why, setWhy] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="ag-sched" aria-label="scheduled messages">
      {items.map((m) => (
        <div key={m.id} className={`ag-sched-row${m.error ? ' is-failed' : ''}`} title={m.text}>
          <span className="ag-sched-when">
            ⏲ {fmtWhen(m.at, now)}
            {!m.error && <span className="ag-sched-in"> · {fmtIn(m.at, now)}</span>}
          </span>
          <span className="ag-sched-text">{m.error ? `couldn't send: ${m.error}` : firstLine(m.text)}</span>
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
