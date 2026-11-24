import { useEffect, useState } from 'react';
import type { CodexUsageResponse, CodexUsageWindow } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { fmtWhen } from '../lib/when.js';

function windowLabel(minutes: number | null): string {
  if (minutes === null) return 'Usage';
  if (minutes === 7 * 24 * 60) return 'Weekly';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function usageLine(window: CodexUsageWindow): string {
  const percent = window.remainingPercent.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const reset = window.resetsAt ? `, resets ${fmtWhen(window.resetsAt)}` : '';
  return `${windowLabel(window.durationMinutes)} ${percent}% left${reset}`;
}

export function CodexUsage() {
  const [request, setRequest] = useState(0);
  const [usage, setUsage] = useState<CodexUsageResponse | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void api<CodexUsageResponse>('/api/providers/codex/usage').then(
      (result) => { if (live) setUsage(result); },
      () => { if (live) setUsage(null); },
    );
    return () => { live = false; };
  }, [request]);

  const loading = usage === undefined;
  const line = loading ? 'Checking ChatGPT subscription usage…' : usage?.windows.length
    ? usage.windows.map(usageLine).join(' · ')
    : 'ChatGPT subscription usage is unavailable.';
  return (
    <span className="ui-model">
      <span role="status">{line}</span>
      <button
        type="button"
        className="ui-refresh"
        aria-label="Refresh ChatGPT subscription usage"
        title="Refresh ChatGPT subscription usage"
        disabled={loading}
        onClick={() => {
          setUsage(undefined);
          setRequest((value) => value + 1);
        }}
      >{loading ? '…' : '↻'}</button>
    </span>
  );
}
