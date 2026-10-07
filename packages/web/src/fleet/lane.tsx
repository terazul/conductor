/**
 * Screen 2's agent lane.  TRACK B.
 *
 * One lane per agent. The tail streams the last four lines of its stream —
 * enough to know it is on track without reading everything — and the foot
 * carries elapsed time, spend against its cap, and tokens.
 *
 * A queued agent shows what it is waiting on, resolved from `dependsOn`, with a
 * tick against the dependencies that have already finished. That is the only
 * honest way to explain why an agent that exists is not running.
 */

import type { Agent, PendingRequest } from '@conductor/shared';
import { useAgentEvents } from '../lib/store.js';
import { useActivity, useElapsedMs } from '../shell/clock.js';
import { budgetOf } from '../shell/autonomy.js';
import { currentAction, shownStatus, startedMs, tailLines } from '../shell/describe.js';
import { openAgent } from '../shell/nav.js';
import { shortModel } from '../lib/models.js';
import { capabilitiesOf, tokenWords, useProviders } from '../lib/providers.js';
import {
  Dot,
  ProviderBadge,
  Spark,
  STATUS_KEY,
  STATUS_WORD,
  Tag,
  fmtElapsed,
  fmtMoney,
  fmtTokens,
} from '../shell/ui.js';

export function Lane({
  agent,
  siblings,
  pending,
}: {
  agent: Agent;
  siblings: readonly Agent[];
  pending: readonly PendingRequest[];
}) {
  const events = useAgentEvents(agent.id);
  const activity = useActivity(agent.id);
  const budget = budgetOf(agent);
  // An engine that reports no dollars shows none, rather than a $0.00 it never spent (Amendment 80).
  const dollars = capabilitiesOf(agent, useProviders()).costUsd;
  const shown = shownStatus(agent, pending);
  const key = STATUS_KEY[shown];
  const elapsedMs = useElapsedMs(startedMs(agent, events), agent.endedAt, events);
  const elapsed =
    agent.status === 'queued' || elapsedMs === null ? '—' : fmtElapsed(elapsedMs);

  const blockedHere = pending.find((p) => p.agentId === agent.id);
  const tail = tailLines(events, 4);
  const action = currentAction(
    agent,
    events,
    pending,
    agent.dependsOn.map((id) => siblings.find((s) => s.id === id)?.role ?? id),
  );

  // The left edge: --live while working, --done once finished (Amendment 93). A
  // blocked lane keeps its amber treatment instead — `shown` already reads
  // `blocked` there, so `key` can't also be `live` or `done` at the same time.
  const edge = key === 'live' ? ' s-live' : key === 'done' ? ' s-done' : '';

  return (
    <div
      className={`pj-lane${blockedHere ? ' is-need' : edge}`}
      role="button"
      tabIndex={0}
      onClick={() => openAgent(agent)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAgent(agent);
        }
      }}
    >
      <div className="pj-lanehead">
        <Dot status={shown} />
        <span className="pj-lane-nm">{agent.role}</span>
        <Tag tone={key}>{STATUS_WORD[shown]}</Tag>
        <span className="pj-lane-mdl" title={agent.model}>{shortModel(agent.model)}</span>
        <ProviderBadge provider={agent.provider} />
      </div>

      <div className="pj-tail">
        {agent.status === 'queued' ? (
          <>
            <div className="pj-tail-wait">
              waiting on:{' '}
              {agent.dependsOn.length === 0
                ? 'a free slot'
                : agent.dependsOn.map((id) => {
                    const dep = siblings.find((s) => s.id === id);
                    const ok = dep?.status === 'done';
                    return (
                      <span key={id} className={ok ? 'is-ok' : ''}>
                        {ok ? '✓ ' : ''}
                        {dep?.role ?? id}{' '}
                      </span>
                    );
                  })}
            </div>
            <div className="pj-tail-auto">
              {agent.dependsOn.length === 0
                ? 'starts when a slot frees'
                : 'auto-starts when they finish'}
            </div>
          </>
        ) : blockedHere ? (
          <div className="pj-tail-need">
            <div>
              {action.head} <b>{action.subject}</b>
            </div>
            <div className="pj-tail-auto">waiting for your decision · {blockedHere.blockMode}</div>
          </div>
        ) : tail.length === 0 ? (
          <div className="pj-tail-auto">no activity yet</div>
        ) : (
          tail.map((l, i) => (
            <div
              key={l.key}
              className={
                l.kind === 'tool'
                  ? 'is-tool'
                  : l.kind === 'result'
                    ? l.ok === false
                      ? 'is-bad'
                      : 'is-ok'
                    : i === tail.length - 1 && agent.status === 'working'
                      ? 'is-cur'
                      : ''
              }
            >
              {l.kind === 'text' ? l.text : `› ${l.text}`}
            </div>
          ))
        )}
      </div>

      <div className="pj-lanefoot">
        <span>{elapsed}</span>
        <Spark activity={activity} tone={blockedHere ? 'need' : 'live'} />
        {budget?.unit === 'tokens' ? (
          <>
            <span className={`pj-meter${budget.over ? ' is-over' : ''}`}>
              <i style={{ width: `${Math.round(budget.fraction * 100)}%` }} />
            </span>
            <span title={`${tokenWords(budget.spent)} of a ${tokenWords(budget.cap)}-token cap`}>
              {Math.round(budget.fraction * 100)}% of {tokenWords(budget.cap)} tok
            </span>
          </>
        ) : budget ? (
          <>
            <span className={`pj-meter${budget.over ? ' is-over' : ''}`}>
              <i style={{ width: `${Math.round(budget.fraction * 100)}%` }} />
            </span>
            <span title={`${fmtMoney(budget.spent)} of a ${fmtMoney(budget.cap)} cap`}>
              {Math.round(budget.fraction * 100)}% of {fmtMoney(budget.cap)}
            </span>
          </>
        ) : (
          <span className="pj-meter-none">uncapped</span>
        )}
        <span title={`${agent.inputTokens} in / ${agent.outputTokens} out`}>
          {fmtTokens(agent.inputTokens + agent.outputTokens)} tok
        </span>
        {dollars && <span>{fmtMoney(agent.costUsd)}</span>}
      </div>
    </div>
  );
}
