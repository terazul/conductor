/**
 * Screen 1 — FLEET.  TRACK B.
 *
 * Everything, everywhere, at once: every project as a card, sorted so the ones
 * that need a human float to the top. The attention bar belongs to the shell, so
 * this screen is the grid, its header, and the one place a project is added
 * (Amendment 45).
 */

import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@conductor/shared';
import { useAgents, useFeedStatus, usePending, useProjects } from '../lib/store.js';
import { useNavParams } from '../lib/nav.js';
import { SCREEN, highlight, openSpawn } from '../shell/nav.js';
import { NewProject } from './NewProject.js';
import { useSetting, writeSetting } from '../lib/settings.js';
import { ORDER_KEY, SORTS, SORT_KEY, fleetSort, moveBefore, moveBy, parseOrder, sortFacts, sortProjects, type FleetSort } from './order.js';
import { Tag, tildePath } from '../shell/ui.js';
import { ProjectCard } from './card.js';
import type { ProjectRemoval } from './endpoints.js';
import './fleet.css';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What to say after a removal.
 *
 * Built from the daemon's own report rather than from what the button promised —
 * the point of the sentence is that the claim was kept, so the paths in it are the
 * ones the daemon says it walked away from.
 *
 * It renders HERE, not in the card, because a removed project leaves the snapshot
 * and takes its card with it. Amendment 25 moved removal onto the card; this is the
 * one piece that cannot live there.
 */
function keptLine(removal: ProjectRemoval): string {
  const extra = removal.keptOnDisk.filter((p) => p !== removal.path).length;
  const worktrees = extra > 0 ? `, including ${plural(extra, 'worktree')}` : '';
  return `Removed ${removal.name} from Conductor. Nothing was deleted — ${tildePath(
    removal.path,
  )} is exactly as it was${worktrees}.`;
}

export function Fleet() {
  const projects = useProjects();
  const agents = useAgents();
  const pending = usePending();
  const status = useFeedStatus();
  const [dense, setDense] = useState(false);
  const [removal, setRemoval] = useState<ProjectRemoval | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  /*
   * The form opens itself when a link asks — Spawn's "add a project on Fleet" sends
   * `add=1` — and otherwise waits for a click.
   */
  const asked = useNavParams(SCREEN.fleet)['add'] === '1';
  const [adding, setAdding] = useState(asked);
  useEffect(() => {
    if (asked) setAdding(true);
  }, [asked]);

  /**
   * The facts the sorts need — rank by the project's worst agent, working, last active,
   * spend — computed here rather than through useProjectStatus because a hook cannot be
   * called per row of a variable list. `sortFacts` is pure and lives in order.ts, so the
   * navigator orders its projects from the very same facts (Amendment 69).
   */
  const facts = useMemo(() => sortFacts(projects, agents, pending), [projects, agents, pending]);

  // The Sort by menu (Amendment 57); your order is one of its choices (Amendment 54).
  const order = parseOrder(useSetting(ORDER_KEY));
  const sort = fleetSort(useSetting(SORT_KEY), order);
  const shown = sortProjects(projects, sort, order, facts);
  const place = (next: string[]): void => {
    writeSetting(ORDER_KEY, JSON.stringify(next));
    writeSetting(SORT_KEY, 'mine');
  };
  const [dragging, setDragging] = useState<string | null>(null);

  const working = agents.filter((a) => a.status === 'working').length;

  return (
    <div className="fl-screen">
      <div className="fl-pane">
        <div className="fl-panehead">
          <span className="fl-crumb">
            <b>Fleet</b>
          </span>
          <Tag tone="idle">
            {projects.length === 1 ? '1 project' : `${projects.length} projects`}
          </Tag>
          {working > 0 && (
            <Tag tone="live">{working === 1 ? '1 agent live' : `${working} agents live`}</Tag>
          )}
          {/* Amber here only when it is true. Never as decoration. */}
          {pending.length > 0 && (
            <Tag tone="need">
              {pending.length === 1 ? '1 blocked on you' : `${pending.length} blocked on you`}
            </Tag>
          )}

          <div className="fl-panehead-r">
            <button
              type="button"
              className={`fl-btn is-ghost${dense ? ' is-on' : ''}`}
              onClick={() => setDense((d) => !d)}
              title="Fit more projects on screen"
            >
              ▦ density
            </button>
            <label className="fl-sortby" title={SORTS.find((s) => s.id === sort)?.hint}>
              <span className="ui-lab">sort by</span>
              <select
                className="ui-select"
                value={sort}
                onChange={(e) => writeSetting(SORT_KEY, e.target.value as FleetSort)}
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id} title={s.hint}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`fl-btn is-ghost${adding ? ' is-on' : ''}`}
              onClick={() => setAdding((a) => !a)}
            >
              + add project
            </button>
            <button
              type="button"
              className="fl-btn is-primary"
              onClick={() => openSpawn()}
            >
              + new work
            </button>
          </div>
        </div>

        <div className="fl-panebody">
          {removal && (
            <div className="fl-menu-note t-ok fl-banner" onClick={() => setRemoval(null)}>
              {keptLine(removal)}
            </div>
          )}
          {added && (
            <div className="fl-menu-note t-ok fl-banner" onClick={() => setAdded(null)}>
              {added}
            </div>
          )}
          {adding && (
            <NewProject
              onDone={() => setAdding(false)}
              onAdded={(p, line) => {
                setAdding(false);
                setAdded(line);
                // The new project is the one you're about to look at.
                highlight(p.id);
              }}
            />
          )}
          {projects.length === 0 ? (
            !adding && <Empty status={status} onAdd={() => setAdding(true)} />
          ) : (
            <div className={`fl-grid${dense ? ' is-dense' : ''}`}>
              {shown.map((p: Project) => (
                /*
                 * Drag a card onto another to put it there (Amendment 54). Dragging switches
                 * the grid to your order, since that is the only order a drag can mean.
                 */
                <div
                  key={p.id}
                  className={`fl-cardslot${dragging === p.id ? ' is-dragging' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    setDragging(p.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', p.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => {
                    if (dragging && dragging !== p.id) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging && dragging !== p.id) place(moveBefore(shown, dragging, p.id));
                    setDragging(null);
                  }}
                >
                  <ProjectCard
                    project={p}
                    onRemoved={setRemoval}
                    onMove={(step) => place(moveBy(shown, p.id, step))}
                    first={shown[0]?.id === p.id}
                    last={shown.at(-1)?.id === p.id}
                  />
                </div>
              ))}
              <button
                type="button"
                className="fl-add"
                onClick={() => setAdding(true)}
              >
                <span className="fl-add-plus">+</span>
                add a project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ status, onAdd }: { status: string; onAdd: () => void }) {
  return (
    <div className="fl-empty">
      <p className="fl-empty-h">No projects yet.</p>
      {status !== 'fixture' && status !== 'error' && (
        <p>
          <button type="button" className="fl-btn is-primary" onClick={onAdd}>
            + add a project
          </button>
        </p>
      )}
      {status === 'fixture' ? (
        <p>Replaying a recording — the snapshot should arrive in a moment.</p>
      ) : status === 'error' ? (
        <p>
          The daemon is unreachable. Start it with{' '}
          <code>pnpm --filter @conductor/daemon dev</code>.
        </p>
      ) : (
        <p>
          Add one to start work in it, or replay a session with{' '}
          <code>VITE_FIXTURE=session-basic</code>.
        </p>
      )}
    </div>
  );
}
