/**
 * Pause everything until a time (Amendment 111), in the status bar so it is on every screen.
 *
 * Off: **⏸ pause all…** opens a small panel with a local date and time, two quick picks and
 * **pause until**. On: the bar says **⏸ all paused until <time>** with how long is left, and
 * **▶ resume now** ends it early. Either way it is the `conductor.pauseUntil` setting, so
 * every open tab shows the same, and the daemon does the pausing and the waking.
 */

import { useState } from 'react';
import { PAUSE_UNTIL_KEY } from '@conductor/shared';
import { useSetting, writeSetting } from '../lib/settings.js';
import { useAgents } from '../lib/store.js';
import { fmtIn, fmtWhen, fromLocalInput, nextHour, toLocalInput, tomorrowMorning, whenProblem } from '../lib/when.js';
import { useNow } from './clock.js';

/** The time everything is paused until, or null when it isn't (absent, unreadable or past). */
export function activePause(raw: string | null, now: number): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now ? raw : null;
}

export function PauseAll() {
  const raw = useSetting(PAUSE_UNTIL_KEY);
  const nowMs = useNow(15_000);
  const now = new Date(nowMs);
  const until = activePause(raw, nowMs);
  const working = useAgents().filter((a) => a.status === 'working').length;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(nextHour(new Date())));

  if (until) {
    return (
      <span className="sh-pause is-on" role="status">
        <span title={`Nothing starts by itself until ${fmtWhen(until, now)}. A message you send still goes through.`}>
          ⏸ all paused until {fmtWhen(until, now)} · {fmtIn(until, now)}
        </span>
        <button type="button" className="sh-pause-btn" onClick={() => writeSetting(PAUSE_UNTIL_KEY, null)}>
          ▶ resume now
        </button>
      </span>
    );
  }

  const problem = whenProblem(value, now);
  const iso = fromLocalInput(value);
  return (
    <>
      <button
        type="button"
        className="sh-pause-btn"
        aria-expanded={open}
        onClick={() => {
          if (!open) setValue(toLocalInput(nextHour(new Date())));
          setOpen((v) => !v);
        }}
        title="Pause every agent until a time you choose"
      >
        ⏸ pause all…
      </button>
      {open && (
        <div className="sh-pause-pop" role="dialog" aria-label="pause everything until">
          <div className="sh-pause-head">Pause everything until</div>
          <input
            type="datetime-local"
            className="sh-pause-at"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="pause until, your local time"
          />
          <div className="sh-pause-quick">
            <button type="button" className="sh-pause-btn" onClick={() => setValue(toLocalInput(new Date(Date.now() + 60 * 60_000)))}>
              1 h
            </button>
            <button type="button" className="sh-pause-btn" onClick={() => setValue(toLocalInput(tomorrowMorning(new Date())))}>
              tomorrow 09:00
            </button>
          </div>
          <p className="sh-pause-note">
            {problem ??
              `${working === 0 ? 'Nothing is working now. ' : `${working} working agent${working === 1 ? '' : 's'} pause, keeping ${working === 1 ? 'its' : 'their'} conversation. `}Nothing starts by itself until ${iso ? fmtWhen(iso, now) : 'then'}; then they all carry on. Messages scheduled for that time wait for it.`}
          </p>
          <div className="sh-pause-acts">
            <button
              type="button"
              className="sh-pause-btn is-go"
              disabled={problem !== null || !iso}
              onClick={() => {
                if (!iso) return;
                writeSetting(PAUSE_UNTIL_KEY, iso);
                setOpen(false);
              }}
            >
              pause until {iso ? fmtWhen(iso, now) : '…'}
            </button>
            <button type="button" className="sh-pause-btn" onClick={() => setOpen(false)}>
              cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
