/**
 * Small shared pieces of the attention screen.
 *
 * Track E owns this file.
 */

import type { SubmitState } from './decisions.js';
import { decisionVerb } from './decisions.js';
import { ageGradientSize, ageRatio, ageTier, ageToken } from './aging.js';

/**
 * The aging bar. Amber at forty seconds, red at twelve minutes, and the
 * difference is visible without reading the number next to it.
 */
export function AgeBar({ ms }: { ms: number }) {
  const ratio = ageRatio(ms);
  return (
    <div
      className="atn-bar"
      role="progressbar"
      aria-label="time waiting for a human"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <i
        style={{
          width: `${(ratio * 100).toFixed(1)}%`,
          backgroundSize: ageGradientSize(ratio),
        }}
      />
    </div>
  );
}

export function Kv({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="atn-kv">
      <span>{k}</span>
      <span style={tone ? { color: tone } : undefined}>{v}</span>
    </div>
  );
}

export function WaitLabel({ ms, text }: { ms: number; text: string }) {
  return <span style={{ color: ageToken(ageTier(ms)) }}>{text}</span>;
}

/**
 * What happened to a decision we sent.
 *
 * The honest bit: `sent` does not say "unblocked". It says we handed the
 * decision over and are waiting for the daemon to confirm. The request stays in
 * the queue until a `resolved` event removes it, so a silently-dropped POST can
 * never look like success.
 */
export function SubmitStrip({ state, onRetry }: { state: SubmitState; onRetry: () => void }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'submitting') {
    return (
      <div className="atn-status" data-phase="submitting">
        <i className="atn-spin" />
        sending {decisionVerb(state.decision)}…
      </div>
    );
  }

  if (state.phase === 'sent') {
    return (
      <div className="atn-status" data-phase="sent">
        ✓ {decisionVerb(state.decision)} — waiting for the daemon to confirm
        <span className="detail">
          This stays here until a `resolved` event arrives. The agent is not unblocked yet.
        </span>
      </div>
    );
  }

  return (
    <div className="atn-status" data-phase="error">
      ✕ could not send — the agent is still blocked
      <button type="button" className="atn-btn ghost" onClick={onRetry}>
        try again
      </button>
      <span className="detail">{state.message}</span>
    </div>
  );
}
