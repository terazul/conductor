/**
 * The Files screen's tabs.  TRACK C.  (Amendment 29)
 *
 * One tab per file you opened, from any job, each keeping its own view, scroll and
 * unsaved edit. The rules for which opens, which closes and which comes forward are
 * in tabs.ts; this only draws them and answers the keyboard.
 *
 * Closing a tab with unsaved work is the one close that asks first — the same
 * two-step as removing a project elsewhere: × arms, the second press discards, and
 * "keep editing" is the wider target. No modal, as there are none in this app.
 */

import { useEffect, useRef, useState } from 'react';
import { keyOf, tabLabels, type Tab } from './tabs.js';

interface Props {
  tabs: readonly Tab[];
  active: string | null;
  jobLabel: (jobId: string) => string;
  /** A job no longer offered — removed from Conductor. Its tab can still be read from cache, or closed. */
  isGone: (jobId: string) => boolean;
  dirty: ReadonlySet<string>;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}

export function TabStrip({ tabs, active, jobLabel, isGone, dirty, onActivate, onClose }: Props) {
  const [armed, setArmed] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const labels = tabLabels(tabs, jobLabel);

  // The tab in front is always in sight, however many are open.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  // A tab closed some other way can't stay armed.
  const armedTab = armed === null ? undefined : tabs.find((t) => keyOf(t) === armed);
  useEffect(() => {
    if (armed !== null && (!armedTab || !dirty.has(armed))) setArmed(null);
  }, [armed, armedTab, dirty]);

  if (tabs.length === 0) return null;

  const close = (key: string): void => {
    if (dirty.has(key)) setArmed(key);
    else onClose(key);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const key = keyOf(tabs[at]!);
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      close(key);
      return;
    }
    const to =
      e.key === 'ArrowRight'
        ? (at + 1) % buttons.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + buttons.length) % buttons.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    buttons[to]!.focus();
    onActivate(keyOf(tabs[to]!));
  };

  const armedAt = armedTab ? tabs.indexOf(armedTab) : -1;

  return (
    <div className="c5-tabbar">
      <div ref={strip} className="c5-tabs" role="tablist" aria-label="open files" onKeyDown={onKeyDown}>
        {tabs.map((t, i) => {
          const key = keyOf(t);
          const on = key === active;
          const label = labels[i]!;
          const gone = isGone(t.jobId);
          const where = t.path ?? 'every change in the worktree';
          return (
            <div
              key={key}
              role="presentation"
              className={`c5-tab${on ? ' on' : ''}${gone ? ' gone' : ''}`}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                close(key);
              }}
              onMouseDown={(e) => {
                // Middle-click closes, rather than starting the browser's autoscroll.
                if (e.button === 1) e.preventDefault();
              }}
            >
              <button
                type="button"
                role="tab"
                className="c5-tabbtn"
                aria-selected={on}
                tabIndex={on || (active === null && i === 0) ? 0 : -1}
                title={`${where} — ${jobLabel(t.jobId)}${gone ? ' (no longer in Conductor)' : ''}`}
                onClick={() => onActivate(key)}
              >
                {dirty.has(key) && (
                  <span className="c5-dot" aria-label="unsaved">
                    ●
                  </span>
                )}
                <span className="c5-tabname">{label.name}</span>
                {label.dir && <span className="c5-tabdir">{label.dir}</span>}
                {label.job && <span className="c5-tabjob">{label.job}</span>}
              </button>
              <button
                type="button"
                className="c5-tabx"
                tabIndex={-1}
                aria-label={`close ${label.name}`}
                title="close (middle-click works too)"
                onClick={() => close(key)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {armedTab && armedAt >= 0 && (
        <div className="c5-tabconfirm" role="alert">
          <span>
            Close <b>{labels[armedAt]!.name}</b>? Your unsaved edit goes with it — the file
            on disk is not touched.
          </span>
          <button type="button" className="c5-btn danger" onClick={() => onClose(keyOf(armedTab))}>
            discard &amp; close
          </button>
          <button type="button" className="c5-btn wide" autoFocus onClick={() => setArmed(null)}>
            keep editing
          </button>
        </div>
      )}
    </div>
  );
}
