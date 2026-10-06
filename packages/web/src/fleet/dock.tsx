/**
 * Screen 2's bottom dock.  TRACK B.
 *
 * The dock puts the docs, the running app, the diff and a terminal directly
 * under the agents that are changing them, so you never leave the project to
 * check on the work.
 *
 * TRACK B OWNS THE TAB STRIP ONLY. The Files and Preview panes are Tracks C and
 * D's screens; this file does not reimplement, stub or fake them. Two seams are
 * offered instead:
 *
 *  1. Those tabs jump to the owning screen (hotkeys 5 and 6). If the screen is
 *     not registered yet the jump is a no-op, so the dock is never broken by a
 *     track that has not landed.
 *  2. `registerDockPane(id, Component)` — call it once at module scope from your
 *     own directory and the dock renders your component in place of the seam
 *     note, with the job id as its only prop. No edit to this file required.
 *
 * The `diff` pane is rendered here because it is derived from the event log
 * (file_edit payloads) rather than from Track C's endpoint — it is Track B's to
 * compute, and it means the dock is useful before anything else lands.
 */

import { useMemo, useState, type ComponentType } from 'react';
import type { DevServer, Job } from '@conductor/shared';
import { useJobEvents } from '../lib/store.js';
import { openFiles, openPreview } from '../shell/nav.js';
import { filesTouched } from '../shell/describe.js';
import { DiffNums } from '../shell/ui.js';
import { PROJECT_DOCK, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';

export interface DockPaneProps {
  jobId: string | null;
}

/** Hand a tab off to the track that owns its content. */
function handOff(jump: 'files' | 'preview', job: Job | null, server?: DevServer): void {
  if (jump === 'preview') {
    if (server) openPreview(server);
    return;
  }
  openFiles(job);
}

const panes = new Map<string, ComponentType<DockPaneProps>>();

/** Fill a dock pane from another track without editing the dock. */
export function registerDockPane(id: string, Component: ComponentType<DockPaneProps>): void {
  panes.set(id, Component);
}

interface TabDef {
  id: string;
  label: string;
  /** Hand off to the screen that owns this content instead of rendering a pane. */
  jump?: 'files' | 'preview';
  owner?: string;
}

const TABS: TabDef[] = [
  { id: 'plan', label: '▤ PLAN.md', owner: 'Track C — workspace' },
  { id: 'files', label: '▤ files', jump: 'files' },
  { id: 'preview', label: '◈ preview', jump: 'preview' },
  { id: 'terminal', label: '▸ terminal', owner: 'not yet assigned' },
  { id: 'diff', label: '⑂ diff' },
];

function DiffPane({ jobId, job }: DockPaneProps & { job: Job | null }) {
  const events = useJobEvents(jobId);
  const files = useMemo(() => filesTouched(events), [events]);

  if (files.length === 0) {
    return <p className="pj-dock-note">Nothing written yet in this job.</p>;
  }

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <div className="pj-difflist">
      <div className="pj-difflist-h">
        <DiffNums added={added} removed={removed} /> across{' '}
        {files.length === 1 ? '1 file' : `${files.length} files`}
        <button
          type="button"
          className="fl-btn is-ghost"
          onClick={() => openFiles(job)}
          title="Open the full unified diff"
        >
          ↗ open in Files
        </button>
      </div>
      {files.map((f) => (
        <div key={f.path} className="pj-diffrow">
          <span className="pj-diffrow-p">{f.path}</span>
          {f.created && <span className="pj-diffrow-new">new</span>}
          <span className="pj-diffrow-n">
            <DiffNums added={f.added} removed={f.removed} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Seam({ tab }: { tab: TabDef }) {
  return (
    <p className="pj-dock-note">
      This pane is owned by <b>{tab.owner}</b>. The dock renders it as soon as that
      track registers it — no change needed here.
    </p>
  );
}

export function Dock({ job, server }: { job: Job | null; server?: DevServer }) {
  const jobId = job?.id ?? null;
  const [active, setActive] = useState('diff');
  const events = useJobEvents(jobId);
  const files = useMemo(() => filesTouched(events), [events]);
  const added = files.reduce((n, f) => n + f.added, 0);

  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
  const Registered = tab ? panes.get(tab.id) : undefined;

  // Drag its top edge (Amendment 34). Upwards grows it, hence `grow={-1}`.
  const { size, handle } = usePanel(PROJECT_DOCK);

  return (
    <>
      <Splitter orientation="horizontal" grow={-1} label="Resize the dock" {...handle} />
      <div className="pj-dock" style={{ height: `${size}px` }}>
        <div className="pj-docktabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === active && !t.jump ? 'is-on' : ''}
              onClick={() => (t.jump ? handOff(t.jump, job, server) : setActive(t.id))}
            >
              {t.label}
              {t.id === 'diff' && added > 0 && <b className="ui-pos">+{added}</b>}
            </button>
          ))}
          <span className="pj-docktabs-r">
            <span className="pj-dock-hint">
              {files.length > 0
                ? `${files.length === 1 ? '1 file' : `${files.length} files`} touched this job`
                : 'no writes yet'}
            </span>
          </span>
        </div>

        <div className="pj-dockbody">
          {Registered ? (
            <Registered jobId={jobId} />
          ) : tab?.id === 'diff' ? (
            <DiffPane jobId={jobId} job={job} />
          ) : tab ? (
            <Seam tab={tab} />
          ) : null}
        </div>
      </div>
    </>
  );
}
