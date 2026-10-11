/**
 * "Not handed off", on Fleet's card and the Project lane.  TRACK B.  (Amendment 120)
 *
 * An agent others wait for that ended its turn without calling `hand_off` is held (Amendment
 * 104): `done`, with the agents after it still queued. Needs You has the card with the summary
 * box and the reply box; this is the way there from where you are looking at the stack. It is
 * a chip, not a copy of the box, because a card or a lane is small and the whole of it is one
 * button. Pressing it opens that card in Needs You, or the agent when its card was put away.
 *
 * What it says, and when it is there, is `handOffChip` (attention/alerts.ts), which
 * attention/verify.ts checks without a browser.
 *
 * Nested in a control that navigates on click and on Enter and Space, so it stops both.
 */

import type { Agent } from '@conductor/shared';
import { handOffChip } from '../attention/alerts.js';
import { useAlerts } from '../lib/store.js';
import { openAgent, openAlert } from '../shell/nav.js';
import './handoffchip.css';

export function HandOffChip({ agent, siblings }: { agent: Agent; siblings: readonly Agent[] }) {
  const chip = handOffChip(agent, siblings, useAlerts());
  if (chip === null) return null;
  return (
    <button
      type="button"
      className="fl-handoff"
      data-agent={agent.id}
      title={chip.title}
      aria-label={`${agent.role}: ${chip.label}. ${chip.title}`}
      onClick={(e) => {
        e.stopPropagation();
        if (chip.alertId !== null) openAlert(chip.alertId);
        else openAgent(agent);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <i className="fl-handoff-dot" />
      <span className="fl-handoff-lab">{chip.label}</span>
      <span className="fl-handoff-go">{chip.action} →</span>
    </button>
  );
}
