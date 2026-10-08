/**
 * The hand-off boxes on the card of an agent that stopped without handing off.
 * Amendment 104.  Track E owns this file.
 *
 * Two ways out of the hold, side by side:
 *
 *  - **hand off**, which opens the summary for editing. It starts with the agent's last
 *    reply, which is what the agents after it would have been told, and what is sent is
 *    exactly what is in the box. It goes above their whole-conversation text, not instead.
 *  - **reply**, a box of its own: say something to the agent and it works again, and hands
 *    off when it is done.
 *
 * What the choices are, and what a summary may be, is in ./alerts.ts, where it is checked.
 * The card is not removed when a send is accepted: the daemon clears the alert once the
 * agent has handed off or is working, so a refusal stays on screen, with its reason.
 */

import { useState } from 'react';
import type { Agent } from '@conductor/shared';
import { sendMessage, type CommandHandle } from '../agent/endpoints.js';
import { useAgentEvents } from '../lib/store.js';
import { handOff, handOffDraft, handOffProblem } from './alerts.js';

export interface HandOffPanelProps {
  agent: Agent;
  /** The summary box is open (the **hand off** button toggles it). */
  editing: boolean;
  onClose: () => void;
  cmd: CommandHandle;
}

export function HandOffPanel({ agent, editing, onClose, cmd }: HandOffPanelProps) {
  const events = useAgentEvents(agent.id);
  const suggested = handOffDraft(events);
  // What was typed over the suggestion, or null while it is still the agent's own words. Kept
  // apart so that the suggestion fills in when the agent's history arrives after the box opens.
  const [edited, setEdited] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const summary = edited ?? suggested;
  const problem = handOffProblem(summary);
  const busy = cmd.busy;

  const sendSummary = () => {
    if (problem !== null) return;
    void cmd.run('Handing off', () => handOff(agent, summary), 'handed off — the agents after it are starting');
  };

  const sendReply = () => {
    const text = reply.trim();
    if (text === '') return;
    void cmd
      .run('Replying', () => sendMessage(agent.id, { text }), 'sent — it works again, and hands off when it is done')
      .then((ok) => {
        if (ok) setReply('');
      });
  };

  return (
    <div className="atn-handoff">
      {editing && (
        <div className="atn-handoff-box" data-box="summary">
          <label className="atn-handoff-lab" htmlFor={`handoff-${agent.id}`}>
            What the agents after {agent.role} are told first
          </label>
          <textarea
            id={`handoff-${agent.id}`}
            className="atn-ta"
            rows={8}
            value={summary}
            disabled={busy}
            placeholder="What you did, what you decided and why, what is left, and the files to look at."
            onChange={(e) => setEdited(e.target.value)}
          />
          <div className="atn-handoff-foot">
            <button type="button" className="atn-btn primary" disabled={busy || problem !== null} onClick={sendSummary}>
              hand off with this
            </button>
            <button type="button" className="atn-btn ghost" disabled={busy} onClick={onClose}>
              cancel
            </button>
            {problem !== null && summary !== '' && <span className="atn-handoff-problem">{problem}</span>}
          </div>
          <div className="atn-handoff-hint">
            It starts as {agent.role}’s last reply. It goes above the whole conversation, which they are given as well.
          </div>
        </div>
      )}

      <div className="atn-handoff-box" data-box="reply">
        <label className="atn-handoff-lab" htmlFor={`handoff-reply-${agent.id}`}>
          Reply to {agent.role} instead
        </label>
        <textarea
          id={`handoff-reply-${agent.id}`}
          className="atn-ta"
          rows={2}
          value={reply}
          disabled={busy}
          placeholder="It works again, and hands off when it is done."
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="atn-handoff-foot">
          <button type="button" className="atn-btn" disabled={busy || reply.trim() === ''} onClick={sendReply}>
            send reply
          </button>
        </div>
      </div>
    </div>
  );
}
