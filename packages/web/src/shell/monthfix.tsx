/**
 * The fleet's month set to the AI gateway's figure (Amendment 206): "sometimes there is a gap on
 * spend to month and the actual calculated by the AI gateway, allow me to update the spend to month
 * to align with the AI gateway."
 *
 * The daemon keeps the difference as a correction for this local month and counts on top of it;
 * these show it. The status bar's month wears a mark that says, on hover, by how much and when;
 * Settings, under the monthly budget, sets, changes and clears it; and the tables by provider say
 * that their rows are as counted. No stylesheet here, so lib/verify.ts renders them.
 */

import { useState } from 'react';
import type { MonthCorrection, MonthCorrectionResponse } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { errorText } from '../lib/errors.js';
import {
  MONTH_CORRECTED_MARK,
  MONTH_TITLE,
  gatewayDraft,
  monthCorrectionWords,
  monthMeter,
  monthTitle,
  monthWords,
  providerCorrectionNote,
} from './spend.js';

/** Sets the month to the gateway's figure, or with null clears the correction. */
export function sendMonthCorrection(gatewayUsd: number | null): Promise<MonthCorrectionResponse> {
  return api<MonthCorrectionResponse>('/api/spend/month-correction', { method: 'POST', body: { gatewayUsd } });
}

/**
 * The status bar's month (Amendment 182): against the monthly budget when there is one, in the
 * meter's colours. Corrected, it ends in the mark, and its hover says by how much and when.
 */
export function MonthFigure({
  costMonth,
  budget,
  correction,
  now,
}: {
  costMonth: number;
  budget: number | null;
  correction: MonthCorrection | null;
  now?: Date;
}) {
  const mark = correction === null ? null : <span className="sh-spend-mark">{MONTH_CORRECTED_MARK}</span>;
  if (budget === null) {
    return (
      <span className="sh-spend-total" title={monthTitle(MONTH_TITLE, correction, now)}>
        {monthWords(costMonth)}
        {mark}
      </span>
    );
  }
  const m = monthMeter(costMonth, budget);
  return (
    <span className="sh-spend-month" data-tone={m.tone} title={monthTitle(m.title, correction, now)}>
      · {m.label}
      {mark}
    </span>
  );
}

/**
 * Settings' line under the monthly budget: `this month $X · match the AI gateway`, which opens
 * `the gateway says $ [ ] · set · cancel`; with a correction, what it is, `· change · clear`.
 * `send` is `sendMonthCorrection` on the page; the new month comes back on the feed.
 */
export function MonthCorrectionLine({
  costMonth,
  correction,
  now,
  send = sendMonthCorrection,
  startOpen = false,
}: {
  costMonth: number;
  correction: MonthCorrection | null;
  now?: Date;
  send?: (gatewayUsd: number | null) => Promise<unknown>;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = draft.trim() === '' ? null : gatewayDraft(draft);
  const problem = read !== null && 'problem' in read ? read.problem : null;

  const go = async (gatewayUsd: number | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await send(gatewayUsd);
      setOpen(false);
      setDraft('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (): void => {
    if (read !== null && 'gatewayUsd' in read) void go(read.gatewayUsd);
  };
  const cancel = (): void => {
    setOpen(false);
    setDraft('');
    setError(null);
  };

  return (
    <>
      {open ? (
        <p className="st-dim st-monthfix" role="group" aria-label="match the AI gateway">
          the gateway says ${' '}
          <input
            inputMode="decimal"
            className="st-monthfix-input"
            aria-label="the AI gateway's spend this month, in dollars"
            value={draft}
            placeholder={costMonth.toFixed(2)}
            disabled={busy}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') set();
              else if (e.key === 'Escape') cancel();
            }}
          />{' '}
          ·{' '}
          <button type="button" className="st-link" disabled={busy || read === null || problem !== null} onClick={set}>
            {busy ? 'setting…' : 'set'}
          </button>{' '}
          ·{' '}
          <button type="button" className="st-link" disabled={busy} onClick={cancel}>
            cancel
          </button>
        </p>
      ) : (
        <p className="st-dim st-monthfix">
          {monthCorrectionWords(costMonth, correction, now)} ·{' '}
          {correction === null ? (
            <button type="button" className="st-link" onClick={() => setOpen(true)}>
              match the AI gateway
            </button>
          ) : (
            <>
              <button type="button" className="st-link" disabled={busy} onClick={() => setOpen(true)}>
                change
              </button>{' '}
              ·{' '}
              <button type="button" className="st-link" disabled={busy} onClick={() => void go(null)}>
                clear
              </button>
            </>
          )}
        </p>
      )}
      {(problem ?? error) && <p className="st-err">{problem ?? error}</p>}
    </>
  );
}

/** Under a table by provider, while the fleet's month is corrected; nothing otherwise. */
export function ProviderCorrectionNote({ correction, className }: { correction: MonthCorrection | null; className: string }) {
  if (correction === null) return null;
  return <p className={className}>{providerCorrectionNote(correction)}</p>;
}
