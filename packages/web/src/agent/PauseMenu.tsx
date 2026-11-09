/**
 * ⏸ pause's menu (Amendment 205): how long to put the agent to sleep for. Until you resume it,
 * as it always was, or 15 min, 1 hour, 4 hours, tomorrow 09:00 or a time you choose, at which
 * the daemon's clock resumes it by itself. Each line says the time it wakes at.
 *
 * The same menu changes the time of an agent already paused (`set`), without until I resume
 * it: clear, beside it, is that. The picker is the send-later row's (LaterRow, scheduled.tsx).
 */

import { useEffect, useState } from 'react';
import { useNow } from '../shell/clock.js';
import { fmtIn, fmtWhen, fromLocalInput, nextHour, toLocalInput, whenProblem } from '../lib/when.js';
import { pauseOptions } from './sleep.js';

export function PauseMenu({
  mode,
  busy,
  onPick,
  onClose,
}: {
  /** pause: put it to sleep; set: change the time of one asleep. */
  mode: 'pause' | 'set';
  busy: boolean;
  /** The ISO time it wakes at, or null for until you resume it. */
  onPick: (until: string | null) => void;
  onClose: () => void;
}) {
  const now = new Date(useNow(30_000));
  const [at, setAt] = useState<string | null>(null);
  const iso = at === null ? null : fromLocalInput(at);
  const problem = at === null ? null : whenProblem(at, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const options = pauseOptions(now).filter((o) => mode === 'pause' || o.key !== 'none');
  return (
    <div className="ag-pause-menu" role="menu" aria-label={mode === 'pause' ? 'pause it until' : 'resume it at'}>
      <span className="ui-lab">{mode === 'pause' ? 'pause' : 'resume it'}</span>
      {options.map((o) =>
        o.key === 'at' ? (
          <button
            key={o.key}
            type="button"
            role="menuitem"
            className={`ag-pause-opt${at !== null ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => setAt(at ?? toLocalInput(nextHour(now)))}
          >
            {o.label}
          </button>
        ) : (
          <button
            key={o.key}
            type="button"
            role="menuitem"
            className="ag-pause-opt"
            disabled={busy}
            title={o.until ? `It resumes by itself ${fmtWhen(o.until, now)}` : 'It sleeps until you press ▶ resume'}
            onClick={() => onPick(o.until)}
          >
            {o.label}
            {o.when && <span className="ag-pause-when">{o.when}</span>}
          </button>
        ),
      )}
      {at !== null && (
        <div className="ag-later ag-pause-at">
          <input
            type="datetime-local"
            className="ag-later-at"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            aria-label="when it resumes, your local time"
          />
          <button
            type="button"
            className="fl-btn is-primary"
            disabled={busy || problem !== null || !iso}
            onClick={() => iso && onPick(iso)}
          >
            {mode === 'pause' ? '⏸ pause' : 'set'}
          </button>
          <span className="ui-lab">{problem ?? (iso ? `${fmtWhen(iso, now)} · ${fmtIn(iso, now)}` : '')}</span>
        </div>
      )}
    </div>
  );
}
