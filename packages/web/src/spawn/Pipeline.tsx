/**
 * The roles an orchestrated stack may start, listed under the orchestrator's row in Spawn's
 * plan (Amendment 128), editable like the other plan rows: each with the model tier it runs on,
 * a role removed, another added. It is what the daemon will let the orchestrator start, and
 * nothing else.
 *
 * With no role left the stack is one agent and says so: no orchestrator, no helpers. The rules
 * are `orchestrated.ts`'s, pure, and checked by spawn/verify.ts.
 */

import type { Autonomy, ModelCatalog, ModelTier } from '@conductor/shared';
import { PIPELINE_ROLES_MAX } from '@conductor/shared';
import { Fragment } from 'react';
import type { PillState } from './autonomy.js';
import { personaFor, type Persona } from './personas.js';
import { isReadOnlyRole, rowOverrides } from './presets.js';
import {
  helperCapFor,
  offeredRoles,
  orchestrates,
  sendBackWords,
  withRole,
  withTier,
  withoutRole,
  type ListedRole,
} from './orchestrated.js';

const TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku'];

export function Pipeline({
  listed,
  personas,
  pills,
  mode,
  tiers,
  claude,
  model,
  onChange,
  alone,
}: {
  listed: readonly ListedRole[];
  personas: readonly Persona[];
  /** The launch's pills and mode, so a role pinned read-only says what that changes (Amendment 147). */
  pills: PillState;
  mode: Autonomy['mode'];
  /** What each tier means now (GET /api/models); only Claude has tiers. */
  tiers: ModelCatalog['tiers'];
  claude: boolean;
  /** The one model every role runs on, off Claude. */
  model: string;
  onChange: (next: ListedRole[]) => void;
  /**
   * What it says with no role listed. Absent, the preset's words; a Custom row that orchestrates
   * (Amendment 142) says its own agent launches plainly, since it does not become an architect.
   */
  alone?: string;
}) {
  const offered = offeredRoles(listed, personas);
  return (
    <div className="sp-pipe" aria-label="Roles the orchestrator may start">
      {orchestrates(listed) ? (
        <>
          <div className="sp-pipe-head">
            may start up to {helperCapFor(listed)} helpers, as these roles and no others
          </div>
          {listed.map((l) => {
            const persona = personaFor(personas, l.id);
            const reads = isReadOnlyRole(l.id) || persona?.tools.write === false;
            // As `helperRolesFor` builds the role: its persona is the one of its id.
            const note = rowOverrides({ role: l.id, model: l.tier, does: '', brief: '' }, pills, mode, personas);
            return (
              <Fragment key={l.id}>
                <div className="sp-pipe-row">
                  <i className="sp-pipe-dot" />
                  <span className="sp-pipe-role" title={persona?.description || undefined}>
                    {l.id}
                  </span>
                  {reads && <span className="sp-ro">read-only</span>}
                  <span className="sp-pipe-does">{persona?.description ?? ''}</span>
                  {claude ? (
                    <select
                      className="ui-select sp-pipe-tier"
                      value={l.tier}
                      aria-label={`Model tier for ${l.id}`}
                      title={tiers[l.tier] ? `${l.tier}: ${tiers[l.tier]}` : `${l.tier}: no such model is served right now`}
                      onChange={(e) => onChange(withTier(listed, l.id, e.target.value as ModelTier))}
                    >
                      {TIERS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                          {tiers[t] ? '' : ' · not served'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="sp-pipe-model">{model || 'pick a model above'}</span>
                  )}
                  <button
                    type="button"
                    className="sp-ghost sp-pipe-x"
                    aria-label={`Remove ${l.id} from the roles it may start`}
                    title={`It will not be able to start ${l.id}`}
                    onClick={() => onChange(withoutRole(listed, l.id))}
                  >
                    ×
                  </button>
                </div>
                {note && <div className="sp-rownote sp-pipe-rownote">{note}</div>}
              </Fragment>
            );
          })}
          <div className="sp-pipe-note">{sendBackWords()}</div>
        </>
      ) : (
        <div className="sp-pipe-note">
          {alone ?? (
            <>
              No role listed, so this launches one architect agent and nothing orchestrates. Add a role to have an
              orchestrator run a pipeline.
            </>
          )}
        </div>
      )}
      {offered.length > 0 && listed.length < PIPELINE_ROLES_MAX && (
        <select
          className="ui-select sp-pipe-add"
          value=""
          aria-label="Add a role it may start"
          onChange={(e) => e.target.value && onChange(withRole(listed, e.target.value, personas))}
        >
          <option value="">+ add a role…</option>
          {offered.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
