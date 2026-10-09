/**
 * The Agent screen's Needs you panel (Amendment 108, ADR 0007).
 *
 * Answer what one agent is waiting on without leaving it: its permission requests and
 * questions, then the alerts that name it, oldest first. The cards are the Needs you
 * screen's own, unchanged; what differs is the state around them.
 *
 *  - Every card is shown at once, so each request keeps its own composer, draft and
 *    cursor, in a map keyed by requestId. A request that leaves takes its state with it.
 *  - NO KEYS. The Needs you screen captures Enter, Tab, Escape and letters on `window`;
 *    here they would fight the composer and the Agent screen's `i`. The cards' buttons,
 *    textareas and Tab order are all there is.
 *  - Decisions go through useDecisions, like the full screen: a card leaves when the
 *    daemon's `resolved` event drops it, never because it was sent.
 *  - When the last one is answered the panel stays open and says so, so you see it took.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Agent, Decision } from '@conductor/shared';
import { useAgents, useAlerts, usePending, useProjects } from '../lib/store.js';
import { AGENT_NEEDS, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';
import { waitingMs } from './aging.js';
import { useDecisions } from './decisions.js';
import { useNow } from './useNow.js';
import { freshCard, needsFor, pruneCards, type CardState } from './needs.js';
import { AlertCard } from './AlertCard.jsx';
import { PermissionCard } from './PermissionCard.jsx';
import { QuestionCard } from './QuestionCard.jsx';
import './attention.css';

export { needsFor } from './needs.js';

export function NeedsPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const allPending = usePending();
  const allAlerts = useAlerts();
  const agents = useAgents();
  const projects = useProjects();
  const { requests, alerts } = useMemo(
    () => needsFor(agent.id, allPending, allAlerts),
    [agent.id, allPending, allAlerts],
  );
  const decisions = useDecisions(requests);
  const now = useNow(requests.length > 0);

  // Each card's own state. Keyed on the joined ids so the ticking clock never prunes.
  const [cards, setCards] = useState<ReadonlyMap<string, CardState>>(new Map());
  const liveIds = requests.map((r) => r.requestId).join('\u0000');
  useEffect(() => {
    setCards((prev) => pruneCards(prev, liveIds.split('\u0000').filter((s) => s.length > 0)));
  }, [liveIds]);
  const cardOf = (id: string): CardState => cards.get(id) ?? freshCard();
  const patch = (id: string, p: Partial<CardState>): void =>
    setCards((prev) => new Map(prev).set(id, { ...(prev.get(id) ?? freshCard()), ...p }));

  // Drag its left edge, like the details it stands in for. Leftwards grows it.
  const { size, handle } = usePanel(AGENT_NEEDS);
  const count = requests.length + alerts.length;

  return (
    <>
      <Splitter orientation="vertical" grow={-1} label="Resize the needs you panel" {...handle} />
      <aside className="atn-side" style={{ width: `${size}px` }} aria-label={`Waiting on you for ${agent.role}`}>
        <div className="atn-side-head">
          <span className="ui-lab">Needs you</span>
          {count > 0 && <span className="atn-side-count">{count}</span>}
          <button type="button" className="atn-btn ghost atn-side-close" title="Close, and show the details" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="atn-side-body">
          {count === 0 ? (
            <div className="atn-side-empty">
              <p>Nothing is waiting on {agent.role}.</p>
              <button type="button" className="atn-btn" onClick={onClose}>
                close
              </button>
            </div>
          ) : (
            <div className="atn-stack">
              {requests.map((r) => {
                const card = cardOf(r.requestId);
                const common = {
                  request: r,
                  waitMs: waitingMs(r.createdAt, now),
                  state: decisions.stateOf(r.requestId),
                  onDecide: (d: Decision) => void decisions.submit(r.requestId, d),
                  onRetry: () => decisions.reset(r.requestId),
                };
                return r.kind === 'permission' ? (
                  <PermissionCard
                    key={r.requestId}
                    {...common}
                    composer={card.composer}
                    onComposerChange={(composer) => patch(r.requestId, { composer })}
                  />
                ) : (
                  <QuestionCard
                    key={r.requestId}
                    {...common}
                    draft={card.draft}
                    cursor={card.cursor}
                    onDraftChange={(draft) => patch(r.requestId, { draft })}
                    onCursorChange={(cursor) => patch(r.requestId, { cursor })}
                  />
                );
              })}
              {alerts.map((a) => (
                <AlertCard key={a.id} alert={a} agents={agents} projects={projects} focused={false} onAgentScreen />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
