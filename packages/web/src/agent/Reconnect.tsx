/**
 * "Reconnecting in 30 s (3 of 5)", with retry now and stop retrying.  Amendment 123.
 *
 * Above the transcript, where the Waiting-on-you banner is. It is there only while the daemon
 * is waiting to try the model again; the same card is in Needs You from the second retry.
 * Nothing here removes it: the daemon starts the try, and the status event that follows takes
 * the banner away, so a press that was refused stays on screen with the sentence it was
 * refused with.
 *
 * Paused, waiting for the model to come back (Amendment 192), it stays, as "Waiting for Claude to
 * come back": retry now checks its provider now, and stop waiting ends it failed. The same two
 * routes: the daemon answers them for a waiting agent too.
 */

import type { Agent, Event } from '@conductor/shared';
import { retryNowAgent, stopRetryingAgent, type CommandHandle } from './endpoints.js';
import { reconnectBar } from './reconnecting.js';
import { useNow } from '../shell/clock.js';

export function Reconnect({ agent, events, cmd }: { agent: Agent; events: readonly Event[]; cmd: CommandHandle }) {
  // Cheap when it is not waiting, and the ticking clock is only mounted when it is.
  if (reconnectBar(agent, events, Date.now()) === null) return null;
  return <Ticking agent={agent} events={events} cmd={cmd} />;
}

function Ticking({ agent, events, cmd }: { agent: Agent; events: readonly Event[]; cmd: CommandHandle }) {
  const now = useNow(1000);
  const bar = reconnectBar(agent, events, now);
  if (bar === null) return null;
  return (
    <div className="ag-reconnect" data-need={bar.needs} role="status">
      <span className="ui-lab">Model API</span>
      <span className="ag-reconnect-act">
        <b>{bar.text}</b> · {bar.why}
      </span>
      <span className="ag-reconnect-btns">
        <button
          type="button"
          className="fl-btn is-primary"
          disabled={cmd.busy}
          title={bar.waiting ? 'Check the model now instead of waiting for the next check' : 'Try the model again now instead of waiting'}
          onClick={() =>
            void cmd.run('Retrying now', () => retryNowAgent(agent.id), bar.waiting ? 'checking now — it goes if the model answers' : 'trying again now')
          }
        >
          retry now
        </button>
        {bar.waiting ? (
          <button
            type="button"
            className="fl-btn is-ghost"
            disabled={cmd.busy}
            title="Give up: the agent ends failed, as it would have before it waited"
            onClick={() => void cmd.run('Stopping the wait', () => stopRetryingAgent(agent.id), 'stopped waiting — it is failed')}
          >
            stop waiting
          </button>
        ) : (
          <button
            type="button"
            className="fl-btn is-ghost"
            disabled={cmd.busy}
            title="Give up: the agent ends failed, as it would have before retries"
            onClick={() => void cmd.run('Stopping the retries', () => stopRetryingAgent(agent.id), 'stopped retrying — it is failed')}
          >
            stop retrying
          </button>
        )}
      </span>
    </div>
  );
}
