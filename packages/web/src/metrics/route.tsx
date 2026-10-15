/**
 * Screen 8 — Metrics (Amendment 122). What the models were used for: tokens, calls, time
 * and errors, in total and per model, over today, 7 days or all of it, for every project or
 * one (Amendment 136), with each day's cost drawn above the day table (Amendment 165).
 *
 *   order 80 · hotkey 8. Registered by main.tsx's `./＊/route.tsx` glob, like every screen.
 *
 * WHERE THE NUMBERS COME FROM. The daemon keeps a history of its own, one row per day,
 * engine and model, added to as results arrive (session/metrics.ts). It is not built from
 * the agents, so removing a job or an agent does not take its history with it, and
 * switching an agent's model does not credit everything it did to the new one. The screen
 * only divides: every rate is made in rules.ts from two sums the daemon sent.
 *
 * WHEN IT RE-READS. On arriving, on the window getting focus back, when the range or the
 * project changes, and a moment after today's spend or any agent's status changes, because
 * those are when a result has landed or a run has ended.
 *
 * THE PROJECT PICKER. "All projects" reads every count, as before; a project reads that
 * project's own (migration 220), which begin when they were added, and says so. The choice
 * is a setting, like the range; a remembered project that has since been removed is
 * All projects again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MetricsRange, MetricsResponse } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { errorText } from '../lib/errors.js';
import { useSetting, writeSetting } from '../lib/settings.js';
import { useAgents, useProjects, useStatusBar } from '../lib/store.js';
import { CostChart } from './chart.js';
import { getMetrics } from './endpoints.js';
import {
  BEFORE_NOTE,
  DAY_COLUMNS,
  HOW_COUNTED,
  MODEL_COLUMNS,
  PROJECT_KEY,
  RANGES,
  RANGE_KEY,
  asProject,
  asRange,
  beforeLine,
  beforeModelLine,
  cell,
  dayLabel,
  emptyLine,
  isEmpty,
  modelCell,
  modelName,
  projectChoices,
  projectNote,
  rangeLine,
  share,
  showDays,
  tiles,
  type Column,
} from './rules.js';
import './metrics.css';

/** The range's report, re-read whenever something says a result may have landed. */
function useMetrics(range: MetricsRange, projectId: string | null) {
  const [resp, setResp] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Answers can come back out of order; only the newest request's counts.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await getMetrics(range, projectId);
      if (mine !== seq.current) return;
      setResp(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [range, projectId]);

  useEffect(() => {
    setResp(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [load]);

  // Today's spend moves when a result lands, and an agent's status when a run ends.
  const { costToday } = useStatusBar();
  const agents = useAgents();
  const activity = useMemo(() => `${costToday.toFixed(4)}|${agents.map((a) => `${a.id}:${a.status}`).join(',')}`, [costToday, agents]);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const first = seen.current === null;
    seen.current = activity;
    if (first) return;
    const t = setTimeout(() => void load(), 700);
    return () => clearTimeout(t);
  }, [activity, load]);

  return { resp, error, loading, load };
}

function Metrics() {
  const range = asRange(useSetting(RANGE_KEY));
  const projects = useProjects();
  const projectId = asProject(useSetting(PROJECT_KEY), projects);
  const { resp, error, loading, load } = useMetrics(range, projectId);
  // What the screen shows is the answer for the range and project it was asked for, never an older one.
  const shown = resp && resp.range === range && (resp.project?.id ?? null) === projectId ? resp : null;

  return (
    <div className="mt">
      <div className="mt-head">
        <span className="ui-crumb">
          <b>metrics</b>
        </span>
        <div className="mt-range" role="group" aria-label="range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === range ? 'on' : ''}
              aria-pressed={r.id === range}
              title={r.title}
              onClick={() => writeSetting(RANGE_KEY, r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <select
          className="mt-project"
          aria-label="project"
          title="Whose runs to count"
          value={projectId ?? ''}
          onChange={(e) => writeSetting(PROJECT_KEY, e.target.value || null)}
        >
          {projectChoices(projects).map((p) => (
            <option key={p.id ?? ''} value={p.id ?? ''}>
              {p.label}
            </option>
          ))}
        </select>
        {shown && <span className="mt-quiet">{rangeLine(shown)}</span>}
        {loading && <span className="mt-quiet">reading…</span>}
        <div className="mt-actions">
          <button type="button" className="mt-btn" disabled={loading} onClick={() => void load()} title="Read the numbers again">
            ⟳ Refresh
          </button>
        </div>
      </div>

      <div className="mt-body">
        <div className="mt-scroll">
          {error && (
            <div className="mt-note fail" role="alert">
              Couldn't read the metrics — {error}
            </div>
          )}
          {!shown && !error && <div className="mt-note">Reading…</div>}
          {shown && <Report resp={shown} />}
        </div>
      </div>
    </div>
  );
}

/** Exported so a check can render it from a response alone. */
export function Report({ resp }: { resp: MetricsResponse }) {
  const empty = isEmpty(resp);
  const days = showDays(resp);
  const note = projectNote(resp);
  return (
    <>
      {note && <div className="mt-note">{note}</div>}
      <section className="mt-tiles" aria-label="totals">
        {tiles(resp.total, resp.models).map((t) => (
          <div key={t.id} className={`mt-tile${t.bad ? ' bad' : ''}`} title={t.title}>
            <div className="mt-tile-label">{t.label}</div>
            <div className="mt-tile-value">{t.value}</div>
            <div className="mt-tile-sub">{t.sub}</div>
          </div>
        ))}
      </section>

      {empty ? (
        <div className="mt-note">{emptyLine(resp.range)}</div>
      ) : (
        <>
          <section aria-label="by model">
            <h2 className="mt-h">By model</h2>
            <table className="mt-table">
              <thead>
                <tr>
                  <th scope="col" className="mt-name">
                    Model
                  </th>
                  {MODEL_COLUMNS.map((c) => (
                    <Th key={c.id} c={c} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {resp.models.map((m) => {
                  const { name, engine } = modelName(m);
                  const pct = Math.round(share(m, resp.total) * 100);
                  return (
                    <tr key={`${m.provider}/${m.model}`}>
                      <th scope="row" className="mt-name">
                        <span className="mt-model">{name}</span>
                        {engine && <span className="mt-engine">{engine}</span>}
                        <span className="mt-bar" title={`${pct}% of the tokens`} aria-hidden="true">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                      </th>
                      {MODEL_COLUMNS.map((c) => (
                        <td key={c.id} className={c.id === 'errors' && m.failedRuns > 0 ? 'bad' : undefined}>
                          {modelCell(c.id, m)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {days.length > 1 && (
            <section aria-label="by day">
              <h2 className="mt-h">By day</h2>
              <CostChart resp={resp} />
              <table className="mt-table mt-days">
                <thead>
                  <tr>
                    <th scope="col" className="mt-name">
                      Day
                    </th>
                    {DAY_COLUMNS.map((c) => (
                      <Th key={c.id} c={c} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <th scope="row" className="mt-name">
                        {dayLabel(d.day)}
                      </th>
                      {DAY_COLUMNS.map((c) => (
                        <td key={c.id} className={c.id === 'errors' && d.failedRuns > 0 ? 'bad' : undefined}>
                          {cell(c.id, d)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {resp.before && (
        <section className="mt-before" aria-label="before metrics were recorded">
          <p className="mt-before-line">{beforeLine(resp.before)}</p>
          <ul>
            {resp.before.models.map((m) => (
              <li key={`${m.provider}/${m.model}`}>{beforeModelLine(m)}</li>
            ))}
          </ul>
          <p className="mt-quiet">{BEFORE_NOTE}</p>
        </section>
      )}

      <details className="mt-how">
        <summary>How these are counted</summary>
        <ul>
          {HOW_COUNTED.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

function Th({ c }: { c: Column }) {
  return (
    <th scope="col" title={c.title}>
      {c.label}
    </th>
  );
}

export const screen: ScreenDef = {
  id: 'metrics',
  label: 'Metrics',
  hotkey: '8',
  order: 80,
  Component: Metrics,
};
