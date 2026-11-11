/**
 * Who made an agent's model, as a small lettered square beside its dot (Amendment 208).  TRACK B.
 *
 * One component for every place an agent is named: the navigator's rows, the Agent screen's
 * tabs and header, a Fleet card's agent rows and a Project lane. The fill is the maker's
 * `--src-<key>` token and the letters are `--bg`, so it reads in both themes. Here, not in
 * ui.tsx, so lib/verify.ts can render it under Node (no stylesheet); `.ui-src` is in ui.css.
 */

import type { Agent } from '@conductor/shared';
import { sourceOf, sourceTitle } from '../lib/source.js';

/** Nothing for no agent: a tab or row whose agent the list doesn't have yet. */
export function SourceMark({ agent }: { agent: Pick<Agent, 'provider' | 'model'> | undefined }) {
  if (!agent) return null;
  const s = sourceOf(agent);
  const title = sourceTitle(agent);
  return (
    <span className={`ui-src s-${s.key}`} title={title} aria-label={title}>
      {s.mark}
    </span>
  );
}
